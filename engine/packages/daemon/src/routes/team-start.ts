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
import type { RigRepository } from "../domain/rig-repository.js";
import type { Rig } from "../domain/types.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

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

export interface TeamStartOptions {
  credentials: TeamControlCredentials;
  /** The plan capability a new binding is approved against; absent leaves starting unavailable. */
  readPolicyCapability?: () => ProviderPolicyCapability | null;
}

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
    limits: { maxSessions: 1, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 1 },
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

function writePaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new TeamContractError("writePaths");
  return value.map(entry => relativePath(entry, "writePaths"));
}

/** The rig's first agent node, which is where a run with no named seat routes its task. */
function firstAgentNode(rigRepo: RigRepository, rigId: string) {
  return rigRepo.getRig(rigId)?.nodes.find(entry => entry.runtime && entry.runtime !== "terminal") ?? null;
}

function summarise(rigRepo: RigRepository, run: TeamRun): TeamRunSummary {
  return { id: run.id, rigId: run.rigId, rigName: rigRepo.getRig(run.rigId)?.rig.name ?? run.rigId,
    state: run.state, planRef: run.binding.planRef, createdAt: run.createdAt };
}

export function teamStartRoutes(
  governance: PlanGovernance,
  rigRepo: RigRepository,
  options: TeamStartOptions,
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
    const seat = v.seat === undefined ? node && `${node.logicalId}@${rig.name}` : text(v.seat, "seat", 256);
    if (!seat) return c.json({ code: "seat_required", error: "The rig has no agent seat; name the seat to route the task to." }, 400);
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
    const run = governance.createRun({ id: randomUUID(), rigId: rig.id, binding });
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
    const created = governance.createTask(request(taskId, {
      assignment: { taskId, role: "implementer", paths: scope, dependencies: [] },
      outputs: [], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: actor.sessionId, destinationSession: seat, body: goal,
    }), binding);
    if (created.status !== "accepted") {
      return c.json({ code: "start_refused", runId: run.id, error: created.reason ?? "The task was refused." }, 409);
    }
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, runId: run.id, rigId: rig.id, approvalId: approval.id,
      taskId, qitemId: (created.value as { qitemId: string }).qitemId, seat, state: governance.getRun(run.id).state }, 201);
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
