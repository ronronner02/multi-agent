import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TEAM_CONTROL_VERSION, TeamContractError, bindingScopePath, object, parseProtocolVersion, prose, relativePath, text,
  type ControlActor, type PlanBinding, type TeamRun, type TeamRunSummary,
} from "../contracts/team-control.js";
import { hashBinding, hashBytes, type PlanGovernance, type ProviderPolicyCapability } from "../domain/plan-governance.js";
import { runName } from "../domain/display-names.js";
import { bootstrapPlan, commitPlan, ensurePlanWorktree } from "../domain/plan-branch.js";
import { roleConfiguration } from "../domain/role-configuration.js";
import { LEAD_ESCALATION_PATH, leadRoster } from "../domain/lead-proposal.js";
import { isRetiredTeamNode } from "../domain/team-setup.js";
import { leadRosterPath } from "../domain/lead-roster.js";
import { documentPaths } from "../domain/project-documents.js";
import { appendChatMessage, chatBody, parseResponseLanguage } from "../domain/lead-chat.js";
import { parseWorkflowSelection, workflowAdmissionRefusal } from "../domain/team-workflows.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
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
  policy: ProviderPolicyCapability; maxSessions?: number }): PlanBinding {
  const root = realpathSync(input.root);
  const planDigest = hashBytes(readFileSync(join(root, input.planRef)));
  const head = execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return {
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: input.planRef, planDigest, repository: { root, identity: "git:" + head },
    readPaths: input.writePaths, writePaths: input.writePaths, roles: ["lead", "implementer", "reviewer"],
    policyRevision: input.policy.policyRevision, policyFingerprint: input.policy.policyFingerprint,
    limits: { maxSessions: input.maxSessions ?? 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
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

function writePaths(value: unknown, planning: boolean): string[] {
  if (!Array.isArray(value) || !value.length) throw new TeamContractError("writePaths");
  return value.map(entry => (planning ? bindingScopePath : relativePath)(entry, "writePaths"));
}

/** The rig's first agent node, which is where a run with no named seat routes its task. */
function firstAgentNode(rigRepo: RigRepository, rigId: string) {
  return rigRepo.getRig(rigId)?.nodes.find(entry => entry.runtime && entry.runtime !== "terminal" && !isRetiredTeamNode(rigRepo.db, entry.id)) ?? null;
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
  const counts = rigRepo.db.prepare(`SELECT
    (SELECT COUNT(*) FROM team_chat_messages WHERE run_id = @runId) AS messageCount,
    (SELECT COUNT(*) FROM team_queue_authority WHERE run_id = @runId AND json_extract(assignment_json, '$.role') <> 'lead') AS executionTaskCount,
    (SELECT COUNT(*) FROM team_integration_commits WHERE run_id = @runId) AS resultCount`).get({ runId: run.id }) as
    Pick<TeamRunSummary, "messageCount" | "executionTaskCount" | "resultCount">;
  return { id: run.id, rigId: run.rigId, rigName: rigRepo.getRig(run.rigId)?.rig.name ?? run.rigId,
    state: run.state, phase: run.phase, ...counts, planRef: run.binding.planRef, displayName: run.displayName, createdAt: run.createdAt };
}

/**
 * The seat a rig records for a role, when a start names none.
 *
 * U3 — `rig team create` records one lead and one reviewer, so a start that names the team's rig
 * already names every seat a run needs. A rig with no seat for the role keeps the pre-U3
 * behaviour: no lead, or no reviewer.
 */
function seatForRole(rigRepo: RigRepository, rig: Rig, role: "lead" | "reviewer"): string | null {
  const node = rigRepo.getRig(rig.id)?.nodes
    .find(entry => entry.role === role && entry.runtime && entry.runtime !== "terminal" && !isRetiredTeamNode(rigRepo.db, entry.id)) ?? null;
  return node ? defaultSeat(rigRepo, node, rig.name) : null;
}

export function teamStartRoutes(
  governance: PlanGovernance,
  rigRepo: RigRepository,
  options: TeamControlOptions & { settingsStore?: SettingsStore },
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
    // The goal is prose: the owner types it into a textarea and it becomes the task's brief, so
    // its line breaks are its meaning.
    const goal = prose(v.goal, "goal", 262_144);
    const workflow = v.workflow === undefined ? undefined : parseWorkflowSelection(v.workflow);
    if (workflow?.ownerMessageId) throw new TeamContractError("workflow.ownerMessageId");
    const workflowError = workflow && workflowAdmissionRefusal(workflow, "user");
    if (workflowError) return c.json({ code: "workflow_invocation_denied", error: workflowError }, 403);
    // Every default below is a fact about the rig the owner already runs: its agent node's
    // working directory, the canonical plan name and the source tree. A request that names
    // none of them still lands on something the daemon can verify.
    let rig: Rig;
    if (v.rig === undefined) {
      const active = rigRepo.listRigs();
      if (active.length !== 1) {
        return c.json({ code: active.length ? "rig_ambiguous" : "rig_required",
          error: active.length ? "More than one rig exists; name the rig to start work on."
            : "No rig exists; create a team with `rig team create <repository>` first." }, 400);
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
    //
// U3 — a rig created by `rig team create` records its seats, so naming the team is enough:
    // the lead and the reviewer come from the roles it recorded unless this request names them.
    // U5 — a planning start is a lead start by definition: its first task is the conversation
    // with the owner, so it needs one of those seats to exist.
    if (v.planning !== undefined && typeof v.planning !== "boolean") throw new TeamContractError("planning");
    const planning = v.planning === true;
    if (v.documentWorkflow !== undefined && (typeof v.documentWorkflow !== "boolean" || !planning)) throw new TeamContractError("documentWorkflow");
    const documentWorkflow = v.documentWorkflow === true;
    const maxSessions = Number(options.settingsStore?.resolveOne("team.maxConcurrentAgents").value ?? 3);
    const leadSeat = v.lead === undefined ? seatForRole(rigRepo, rig, "lead") : text(v.lead, "lead", 256);
    if (planning && leadSeat === null) {
      return c.json({ code: "lead_required",
        error: "A planning run needs a lead seat: name one, or create a team with `rig team create`." }, 400);
    }
    // The generated command header is not part of the owner's input limit.
    const initialWorkflowRequest = workflow && leadSeat !== null
      ? `/${workflow.entrypoint}${workflow.readOnly ? " --read-only" : ""}\n${workflow.input ?? chatBody(goal, "workflow.input")}` : null;
    const seat = v.seat === undefined ? (node ? defaultSeat(rigRepo, node, rig.name) : null) : text(v.seat, "seat", 256);
    if (leadSeat === null && !seat) return c.json({ code: "seat_required", error: "The rig has no agent seat; name the seat to route the task to." }, 400);
    // C2 — the seat every review round of this run routes to. A start that names none keeps
    // the pre-C2 behaviour: an implementer completes and the run creates no review.
    const reviewerSeat = v.reviewerSeat === undefined
      ? seatForRole(rigRepo, rig, "reviewer") : text(v.reviewerSeat, "reviewerSeat", 256);
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
    // Planning needs only the lead; delivery still needs a member to receive its tasks.
    if (!planning && leadSeat !== null && !leadRoster(rigRepo.db, { rigId: rig.id, roles: ["implementer"], excludeSeat: leadSeat }).length) {
      return c.json({ code: "lead_roster_empty",
        error: "No implementer seat exists for the lead to propose work to; add one to the rig, or start without a lead." }, 400);
    }
    const repository = v.repository === undefined ? {} : object(v.repository, "repository");
    const root = repository.root === undefined ? node?.cwd ?? null : text(repository.root, "repository.root", 4096);
    if (!root) return c.json({ code: "repository_required", error: "The rig's agent seat has no working directory; name the repository." }, 400);
    const planRef = repository.planRef === undefined ? DEFAULT_PLAN_REF : relativePath(repository.planRef, "repository.planRef");
    const scope = v.writePaths === undefined
      ? (planning ? ["."] : [...DEFAULT_WRITE_PATHS]) : writePaths(v.writePaths, planning);
    const planningPaths = planning ? [...new Set([planRef, leadRosterPath(planRef), LEAD_ESCALATION_PATH,
      ...(documentWorkflow ? Object.values(documentPaths(planRef)) : [])])] : [planRef];
    // U5 — the run id exists before the binding does, because a planning run's binding is
    // established in the daemon's own worktree for that run, not in the owner's checkout.
    const responseLanguage = parseResponseLanguage(v.responseLanguage);
    const runId = randomUUID();
    const displayName = v.displayName === undefined ? runName(goal) : text(v.displayName, "displayName", 80);
    let binding: PlanBinding;
    if (planning) {
      const worktreeRoot = options.planWorktreeRoot?.();
      if (!worktreeRoot) {
        return c.json({ code: "planning_unavailable", error: "This daemon cannot record a plan for a planning run." }, 503);
      }
      // The plan the run is bound to before the lead has written one. It lives on the run's own
      // branch in the daemon's worktree, so the owner's checkout is untouched and the binding
      // names a real artifact at a real commit from the first moment. The lead's planning scope
      // covers the plan and, for a lead-built team, its roster. The implementation scope rides in `readPaths` until the
      // approval turns it into the delivery binding.
      let worktree: string;
      try {
        worktree = ensurePlanWorktree({ repositoryRoot: root, worktreeRoot, runId, name: displayName }).path;
        commitPlan({ worktree, planRef, plan: bootstrapPlan(goal), message: `plan: ${displayName ?? "new run"} (planning)` });
        const recorded = bindingForGoal({ root: worktree, planRef, writePaths: planningPaths, policy, maxSessions });
        binding = { ...recorded, readPaths: [...new Set([...planningPaths, ...scope])] };
      } catch (error) {
        if (error instanceof TeamContractError) throw error;
        return c.json({ code: "planning_worktree_unavailable",
          error: "The run's plan worktree could not be created: " + (error as Error).message }, 500);
      }
    } else {
      try {
        binding = bindingForGoal({ root, planRef, writePaths: scope, policy, maxSessions });
      } catch (error) {
        if (error instanceof TeamContractError) throw error;
        return c.json({ code: "repository_unreadable",
          error: "The plan artifact or the repository's commit could not be read: " + (error as Error).message }, 400);
      }
    }
    // U9 — the run is named from the goal the owner started it with, so no client ever has to
    // show the run id. The goal is already required to be non-blank above.
    const run = governance.createRun({ id: runId, rigId: rig.id, binding, reviewerSeat, displayName,
      phase: planning ? "planning" : "delivery", documentWorkflow, responseLanguage });
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
    // Planning writes only its agreement files; implementation waits for the owner's approval.
    const assignment = planning
      ? { taskId, role: "lead" as const, paths: planningPaths, dependencies: [] }
      : leadSeat === null
        ? { taskId, role: "implementer" as const, paths: scope, dependencies: [] }
        : { taskId, role: "lead" as const, paths: scope, dependencies: [] };
    const taskSeat = leadSeat ?? seat;
    const created = governance.createTask(request(taskId, {
      assignment, outputs: [], permissions: [...roleConfiguration[assignment.role].permissions],
      sourceSession: actor.sessionId, destinationSession: taskSeat, body: goal, ...(v.displayName !== undefined ? { displayName } : {}),
      ...(workflow && leadSeat === null ? { workflow } : {}),
    }), binding);
    if (created.status !== "accepted") {
      return c.json({ code: "start_refused", runId: run.id, error: created.reason ?? "The task was refused." }, 409);
    }
    if (planning || initialWorkflowRequest) appendChatMessage(rigRepo.db, { id: run.id + ":initial", runId: run.id,
      body: initialWorkflowRequest ?? goal, createdAt: run.createdAt, responseLanguage });
    // The task exists, so the agent that has to do it starts now. This runs after the response
    // is built rather than inside the request: opening a seat's terminal and waiting for its
    // client to become ready is a launch, and a launch is not what a start request waits on.
    // A refusal inside the launch is recorded in the seat's startup state. One before it (no
    // resolvable seat, no terminal) leaves the seat pending, so it is logged rather than lost.
    if (options.dispatch) void options.dispatch(run.id, taskId).catch(error =>
      console.warn(`team start: launch for run=${run.id} task=${taskId} failed: ${error instanceof Error ? error.message : String(error)}`));
    const started = governance.getRun(run.id);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, runId: run.id, rigId: rig.id, approvalId: approval.id,
      taskId, qitemId: (created.value as { qitemId: string }).qitemId, seat: taskSeat, reviewerSeat, leadSeat,
      state: started.state, phase: started.phase }, 201);
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
