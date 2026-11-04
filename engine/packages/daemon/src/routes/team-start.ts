import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TEAM_CONTROL_VERSION, TeamContractError, object, parseProtocolVersion, relativePath, text,
  type ControlActor, type PlanBinding, type TeamRun, type TeamRunSummary,
} from "../contracts/team-control.js";
import { hashBinding, hashBytes, type PlanGovernance, type ProviderPolicyCapability } from "../domain/plan-governance.js";
import { roleConfiguration } from "../domain/role-configuration.js";
import { leadRoster } from "../domain/lead-proposal.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { Rig } from "../domain/types.js";
import { teamControlAuthentication, type TeamControlEnv } from "../middleware/auth-bearer-token.js";
import type { TeamControlOptions } from "./team-control.js";

/**
 * MVP slice 2 — the owner starts team work.
 *
 * One collection resource: `POST /runs` creates a run and the task that puts one agent on
 * the owner's goal, and `GET /runs` lists the runs that already exist so no client has to
 * ask the owner to type an id. Both are owner-only and live on the team-control surface,
 * so the managed-mode allowlist and the owner credential apply unchanged.
 *
 * The domain requires an approved plan binding before a task may exist. The owner's
 * authenticated start request supplies that plan and its scope, so it is also the owner's
 * decision on the implementation approval the endpoint proposes: the approval row records
 * the owner's control session as `decisionActor`, and splitting the two would leave an
 * approved run with no task and no second client to create one.
 */

/** The plan artifact and write scope a start request uses when it names none. */
export const DEFAULT_PLAN_REF = "plan.md";
export const DEFAULT_WRITE_PATHS = ["src"] as const;
/** One day: long enough that a start is not lost overnight, short enough that an unused plan grant expires. */
const APPROVAL_WINDOW_MS = 86_400_000;

/**
 * The binding a new run is approved against.
 *
 * Everything here is read from the repository at the moment of the request: the canonical
 * root, the plan's exact bytes and the commit they are approved at. A repository with no
 * commit has no identity this contract can name, so it is refused rather than
 * fingerprinted by some other means.
 */
export function bindingForGoal(input: { root: string; planRef: string; writePaths: string[];
  policy: ProviderPolicyCapability }): PlanBinding {
  const root = realpathSync(input.root);
  const planDigest = hashBytes(readFileSync(join(root, input.planRef)));
  const head = execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return {
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: input.planRef, planDigest, repository: { root, identity: "git:" + head },
    readPaths: input.writePaths, writePaths: input.writePaths, roles: ["lead", "implementer", "reviewer"],
    policyRevision: input.policy.policyRevision, policyFingerprint: input.policy.policyFingerprint,
    // C2: two review rounds, which is the contract's ceiling for the unconditional ones. One
    // is not enough for the loop to ever approve a candidate: a first round that finds a P0/P1
    // spends it on the rework, so the round that would close the task could never start.
    //
    // C3: two live sessions, which is the fewest that lets a lead run hand over. The lead's own
    // attempt is live while it reads the goal and writes its decomposition, and the task that
    // then runs is the next one; with one, a second seat could never start while the first was
    // still recorded running. Three would be the review loop's ceiling as well, but a review
    // round starts only after the implementer's attempt is observed stopped, so the slice never
    // needs it and this stays at the smallest number that works.
    limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
  };
}

/**
 * The policy capability in force under `workers.isolation: none`.
 *
 * Nothing is installed on such a host, so there is no client lock to verify and no sandbox
 * to fingerprint. What the daemon can still state truthfully is the revision its unisolated
 * roots carry, a fingerprint that names the isolation mode, and the clients it may start by
 * name — which is what a dispatch decision needs to know.
 */
export function unisolatedPolicyCapability(policyRevision: number): ProviderPolicyCapability {
  return { policyRevision, policyFingerprint: hashBytes("workers.isolation:none"), verifiedProviders: ["claude", "codex"] };
}

/** Re-read source and policy without replacing the scope or limits the owner approved. */
export function refreshPlanBinding(binding: PlanBinding, policy: ProviderPolicyCapability): PlanBinding {
  const current = bindingForGoal({ root: binding.repository.root, planRef: binding.planRef, writePaths: binding.writePaths, policy });
  return { ...binding, repository: current.repository, planDigest: current.planDigest,
    policyRevision: current.policyRevision, policyFingerprint: current.policyFingerprint };
}

function writePaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new TeamContractError("writePaths");
  return value.map(entry => relativePath(entry, "writePaths"));
}

/** The rig's first agent node, which is where a run with no named seat routes its task. */
function firstAgentNode(rigRepo: RigRepository, rigId: string) {
  return rigRepo.getRig(rigId)?.nodes.find(entry => entry.runtime && entry.runtime !== "terminal") ?? null;
}

/**
 * The address a node's task routes to when the request names no seat.
 *
 * A node's registered session is the address a launch resolves, so it is preferred. Only a
 * node with no session falls back to the canonical `{member}@{rig}` derivation, which
 * replaces the dot in the logical id the way every other seat name does.
 */
function defaultSeat(rigRepo: RigRepository, node: { id: string; logicalId: string }, rigName: string): string {
  const registered = rigRepo.db.prepare(
    "SELECT session_name FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(node.id) as { session_name: string } | undefined;
  return registered?.session_name || `${node.logicalId.replace(/\./g, "-")}@${rigName}`;
}

function summarise(rigRepo: RigRepository, run: TeamRun): TeamRunSummary {
  return { id: run.id, rigId: run.rigId, rigName: rigRepo.getRig(run.rigId)?.rig.name ?? run.rigId,
    state: run.state, planRef: run.binding.planRef, createdAt: run.createdAt };
}

export function teamStartRoutes(
  governance: PlanGovernance,
  rigRepo: RigRepository,
  options: TeamControlOptions,
  legacyTokens: readonly (string | null | undefined)[],
): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("*", teamControlAuthentication(() => options.credentials, legacyTokens));
  app.use("*", bodyLimit({ maxSize: 1_048_576,
    onError: c => c.json({ code: "invalid_team_contract", error: "The start request exceeds its size limit." }, 413) }));
  const owner = (c: { get: (key: "controlActor") => ControlActor }) =>
    c.get("controlActor").kind === "owner" ? c.get("controlActor") : null;

  app.get("/runs", (c) => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, runs: governance.listRuns().map(run => summarise(rigRepo, run)) });
  });

  app.post("/runs", async (c) => {
    const actor = owner(c);
    if (!actor) return c.json({ code: "owner_control_required", error: "An authenticated owner start is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const policy = options.readPolicyCapability?.();
    if (!policy) {
      return c.json({ code: "current_policy_unavailable", error: "The plan capability a new run is approved against is unavailable." }, 503);
    }
    const v = object(await c.req.json(), "start");
    const goal = text(v.goal, "goal", 262_144);
    // Every default below is a fact about the rig the owner already runs: its agent node's
    // working directory, the canonical plan name and the source tree. A request that names
    // none of them still lands on something the daemon can verify.
    let rig: Rig;
    if (v.rig === undefined) {
      const active = rigRepo.listRigs();
      if (active.length !== 1) {
        return c.json({ code: active.length ? "rig_ambiguous" : "rig_required",
          error: active.length ? "More than one rig exists; name the rig to start work on." : "No rig exists; create one with `rig up` first." }, 400);
      }
      rig = active[0]!;
    } else {
      const name = text(v.rig, "rig", 256);
      const match = rigRepo.getRig(name)?.rig ?? rigRepo.findUnarchivedRigsByName(name)[0];
      if (!match) return c.json({ code: "rig_not_found", error: "No rig matches that id or name." }, 404);
      rig = match;
    }
    const node = firstAgentNode(rigRepo, rig.id);
    // C3 — an opt-in lead. Without a lead seat the start is exactly the pre-C3 start: one
    // implementer task on the named (or default) seat. With one, the run's first task is the
    // lead's, and the lead's context carries the protocol, roster and run instructions the
    // manifest owner builds; the implementer seats then come from the lead's own proposal, so
    // this request names none and there is no single implementer seat to compare against.
    const leadSeat = v.lead === undefined ? null : text(v.lead, "lead", 256);
    const seat = v.seat === undefined ? (node ? defaultSeat(rigRepo, node, rig.name) : null) : text(v.seat, "seat", 256);
    if (leadSeat === null && !seat) return c.json({ code: "seat_required", error: "The rig has no agent seat; name the seat to route the task to." }, 400);
    // C2 — the seat every review round of this run routes to. A start that names none keeps
    // the pre-C2 behaviour: an implementer completes and the run creates no review.
    const reviewerSeat = v.reviewerSeat === undefined ? null : text(v.reviewerSeat, "reviewerSeat", 256);
    // The lead runs first and decides nothing about its own work, so a lead that is also the
    // reviewer seat would be asked to review the tasks it proposed. This is checked before the
    // implementer comparison below, which does not apply to a run whose lead chooses the seats.
    if (leadSeat !== null && leadSeat === reviewerSeat) {
      return c.json({ code: "lead_seat_invalid",
        error: "The lead seat must differ from the reviewer's seat; a lead does not review its own decomposition." }, 400);
    }
    if (leadSeat === null && reviewerSeat !== null && reviewerSeat === seat) {
      return c.json({ code: "reviewer_seat_invalid",
        error: "The reviewer seat must differ from the implementer's seat; a seat cannot review its own candidate." }, 400);
    }
    // A lead with no member to delegate to can propose nothing, and the activation's manifest
    // refuses an empty roster. Say so here rather than letting the launch fail later.
    if (leadSeat !== null && !leadRoster(rigRepo.db, { rigId: rig.id, roles: ["implementer"], excludeSeat: leadSeat }).length) {
      return c.json({ code: "lead_roster_empty",
        error: "No implementer seat exists for the lead to propose work to; add one to the rig, or start without a lead." }, 400);
    }
    const repository = v.repository === undefined ? {} : object(v.repository, "repository");
    const root = repository.root === undefined ? node?.cwd ?? null : text(repository.root, "repository.root", 4096);
    if (!root) return c.json({ code: "repository_required", error: "The rig's agent seat has no working directory; name the repository." }, 400);
    const planRef = repository.planRef === undefined ? DEFAULT_PLAN_REF : relativePath(repository.planRef, "repository.planRef");
    const scope = v.writePaths === undefined ? [...DEFAULT_WRITE_PATHS] : writePaths(v.writePaths);
    let binding: PlanBinding;
    try {
      binding = bindingForGoal({ root, planRef, writePaths: scope, policy });
    } catch (error) {
      if (error instanceof TeamContractError) throw error;
      return c.json({ code: "repository_unreadable",
        error: "The plan artifact or the repository's commit could not be read: " + (error as Error).message }, 400);
    }
    const run = governance.createRun({ id: randomUUID(), rigId: rig.id, binding, reviewerSeat });
    const bindingDigest = hashBinding(binding);
    const request = (actionId: string, payload: unknown) => ({ protocolVersion: TEAM_CONTROL_VERSION, runId: run.id,
      actionId, expectedEntityVersion: governance.getRun(run.id).entityVersion, idempotencyKey: randomUUID(), payload });
    governance.requestApproval(request(randomUUID(), { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest }, targetDigest: bindingDigest,
      expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString() }), actor);
    const approval = governance.listApprovals(run.id)[0]!;
    const decided = governance.decideApproval(request(approval.id, { approvalVersion: approval.entityVersion,
      decision: "approved" }), actor, binding);
    if (decided.status !== "accepted") {
      return c.json({ code: "start_refused", runId: run.id, error: decided.reason ?? "The plan was not approved." }, 409);
    }
    const taskId = "task-1";
    const assignment = leadSeat === null
      ? { taskId, role: "implementer" as const, paths: scope, dependencies: [] }
      : { taskId, role: "lead" as const, paths: scope, dependencies: [] };
    const taskSeat = leadSeat ?? seat;
    const created = governance.createTask(request(taskId, {
      assignment, outputs: [], permissions: [...roleConfiguration[assignment.role].permissions],
      sourceSession: actor.sessionId, destinationSession: taskSeat, body: goal,
    }), binding);
    if (created.status !== "accepted") {
      return c.json({ code: "start_refused", runId: run.id, error: created.reason ?? "The task was refused." }, 409);
    }
    // The task exists, so the agent that has to do it starts now. This runs after the response
    // is built rather than inside the request: opening a seat's terminal and waiting for its
    // client to become ready is a launch, and a launch is not what a start request waits on.
    // A refusal inside the launch is recorded in the seat's startup state. One before it (no
    // resolvable seat, no terminal) leaves the seat pending, so it is logged rather than lost.
    if (options.dispatch) void options.dispatch(run.id, taskId).catch(error =>
      console.warn(`team start: launch for run=${run.id} task=${taskId} failed: ${error instanceof Error ? error.message : String(error)}`));
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, runId: run.id, rigId: rig.id, approvalId: approval.id,
      taskId, qitemId: (created.value as { qitemId: string }).qitemId, seat: taskSeat, reviewerSeat, leadSeat,
      state: governance.getRun(run.id).state }, 201);
  });

  app.onError((error, c) => {
    if (error instanceof TeamContractError || error instanceof SyntaxError) {
      return c.json({ code: "invalid_team_contract", error: "The start request is malformed or incompatible." }, 400);
    }
    if (/not found/i.test(error.message)) return c.json({ code: "control_not_found", error: "The requested entity was not found." }, 404);
    return c.json({ code: "control_persistence_failed", error: "The start request was not acknowledged." }, 500);
  });
  return app;
}
