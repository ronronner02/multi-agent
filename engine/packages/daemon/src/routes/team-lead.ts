import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, TeamContractError, parseControlRequest, parseProtocolVersion } from "../contracts/team-control.js";
import type { PlanGovernance, ProviderPolicyCapability } from "../domain/plan-governance.js";
import type { LeadTask } from "../domain/lead-proposal.js";
import { runLeadTask } from "../domain/lead-chat.js";
import { commitPlan } from "../domain/plan-branch.js";
import { bindingForGoal, refreshPlanBinding } from "./team-start.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

/**
 * C3 — the owner's read of a lead's decomposition, and the decision it becomes.
 *
 * The lead writes one file into its own candidate tree; this route is where the owner turns
 * that file into an approval. It is owner-only on both verbs: the read is worker-written
 * content, and the write is the owner's decision. Nothing here admits a task — `proposeLeadTasks`
 * records a pending approval carrying the exact batch, and the owner approves it through the
 * `approvals/decide` path C1 growth already uses. So a lead's proposal reaches the run only
 * after the owner says yes, and the tasks it carries then run, complete and get reviewed through
 * C1, C2 and the completion path unchanged.
 *
 * The read is separated from the write on purpose: a client can show the batch before the owner
 * decides it, and a second read of a rejected proposal does not create a second approval.
 */

/** How long an unapproved lead proposal stays decidable. One day, as a start's approval does. */
export const PROPOSAL_WINDOW_MS = 86_400_000;

export interface LeadProposalRouteOptions {
  credentials: TeamControlCredentials;
  legacyTokens: readonly (string | null | undefined)[];
  /** The runtime that owns the candidate trees and reads worker-written files. */
  runtime?: {
    leadProposalFor(runId: string, taskId: string): LeadTask[];
    /** U5 — the plan a planning lead wrote in its own tree. */
    planFor?(runId: string, taskId: string, planRef: string): { content: string; hash: string };
    /** U5 — let the lead's tree be adopted again after the plan commit moved its source. */
    forgetCandidate?(runId: string, taskId: string): void;
  };
  /** The current policy capability a decision reconciles against, as every command reads it. */
  readPolicyCapability?: () => ProviderPolicyCapability | null;
  /** U5 — what starts the lead's next turn; the same dispatch a start and a growth use. */
  dispatch?: (runId: string, taskId: string) => Promise<void>;
}

export function teamLeadRoutes(governance: PlanGovernance, options: LeadProposalRouteOptions): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  const route = "/runs/:runId/tasks/:taskId/proposal";
  app.use(route, teamControlAuthentication(() => options.credentials, options.legacyTokens));
  app.use(route, bodyLimit({ maxSize: 1_048_576,
    onError: c => c.json({ code: "invalid_team_contract", error: "The proposal request exceeds its size limit." }, 413) }));
  /** The lead task this run's decomposition comes from: a lead task, and the run's own row. */
  const leadTaskOf = (runId: string, taskId: string) => {
    const task = governance.findTask(runId, taskId);
    return task && task.assignment.role === "lead" ? task : null;
  };

  app.get(route, (c) => {
    const runId = c.req.param("runId"), taskId = c.req.param("taskId");
    if (c.get("controlActor").kind !== "owner" || (c.get("controlRunId") !== null && c.get("controlRunId") !== runId)) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    if (!leadTaskOf(runId, taskId)) return c.json({ code: "control_not_found", error: "This run has no lead task with that id." }, 404);
    if (!options.runtime) return c.json({ code: "lead_proposal_unavailable", error: "Candidate trees are not composed in this daemon." }, 503);
    let tasks: LeadTask[];
    try {
      tasks = options.runtime.leadProposalFor(runId, taskId);
    } catch (error) {
      // A lead that wrote nothing, or wrote something the boundary refuses, is a named refusal
      // rather than a crash: the message is this module's own, never an internal one.
      return c.json({ code: "lead_proposal_unreadable", error: (error as Error).message }, 409);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, proposal: { runId, taskId, tasks } });
  });

  /**
   * Record the owner decision for the batch the daemon reads.
   *
   * The batch is re-read here rather than accepted from the request: what the owner approves has
   * to be what the daemon can verify, so the request supplies only its own identity and an
   * expiry. A lead's proposal that changed between the read and the decision is a different
   * batch, and the approval it produces names that batch's digest.
   */
  app.post(route, async (c) => {
    const runId = c.req.param("runId"), taskId = c.req.param("taskId");
    if (c.get("controlActor").kind !== "owner" || (c.get("controlRunId") !== null && c.get("controlRunId") !== runId)) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner decision is required." }, 403);
    }
    const request = parseControlRequest(await c.req.json());
    if (request.runId !== runId) return c.json({ code: "control_scope_denied", error: "The request and route must identify the same run." }, 403);
    if (!leadTaskOf(runId, taskId)) return c.json({ code: "control_not_found", error: "This run has no lead task with that id." }, 404);
    if (!options.runtime) return c.json({ code: "lead_proposal_unavailable", error: "Candidate trees are not composed in this daemon." }, 503);
    let tasks: LeadTask[];
    try {
      tasks = options.runtime.leadProposalFor(runId, taskId);
    } catch (error) {
      return c.json({ code: "lead_proposal_unreadable", error: (error as Error).message }, 409);
    }
    const policy = options.readPolicyCapability?.();
    const run = governance.getRun(runId);
    const binding = policy ? refreshPlanBinding(run.binding, policy) : run.binding;
    // The request supplies only its expiry. The batch is re-read above, so the approval names
    // the tasks the daemon just verified rather than anything the client claims, and a retried
    // request replays the approval it already recorded.
    const receipt = governance.proposeLeadTasks(request, c.get("controlActor"), binding, tasks);
    return c.json(receipt, receipt.status === "denied" ? 403 : 200);
  });

  const chatRoute = "/runs/:runId/chat";
  const planRoute = "/runs/:runId/plan/approve";
  app.use(chatRoute, teamControlAuthentication(() => options.credentials, options.legacyTokens));
  app.use(planRoute, teamControlAuthentication(() => options.credentials, options.legacyTokens));
  app.use(chatRoute, bodyLimit({ maxSize: 1_048_576,
    onError: c => c.json({ code: "invalid_team_contract", error: "The chat request exceeds its size limit." }, 413) }));
  /** The owner, scoped to the run the URL names — the same rule the proposal routes read. */
  const ownerFor = (c: Context<TeamControlEnv>, runId: string) => c.get("controlActor").kind === "owner"
    && (c.get("controlRunId") === null || c.get("controlRunId") === runId);

  /**
   * U5 — the run's conversation, in order.
   *
   * The owner reads what they and the lead said, and the run's phase, so a client knows whether
   * a plan is still being agreed. Nothing here starts work or records a decision.
   */
  app.get(chatRoute, (c) => {
    const runId = c.req.param("runId");
    if (!ownerFor(c, runId)) return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    let run;
    try { run = governance.getRun(runId); } catch (error) {
      if (/not found/i.test((error as Error).message)) return c.json({ code: "control_not_found", error: "The requested entity was not found." }, 404);
      throw error;
    }
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, runId, phase: run.phase,
      messages: governance.chatMessages(runId).map(message => ({ id: message.id, sender: message.sender,
        body: message.body, createdAt: message.createdAt })) });
  });

  /**
   * U5 — the owner's message, and the lead's turn to answer it.
   *
   * The row and the turn are decided together inside one governance command; this route only
   * starts the turn the command says may start. `queued` in the answer is the honest report that
   * a lead turn was already running: the message is stored and the turn-end owner starts the
   * next one, so the answer to the owner is "kept", not "answered".
   */
  app.post(chatRoute, async (c) => {
    const runId = c.req.param("runId");
    if (!ownerFor(c, runId)) return c.json({ code: "owner_control_required", error: "An authenticated owner message is required." }, 403);
    const request = parseControlRequest(await c.req.json());
    if (request.runId !== runId) return c.json({ code: "control_scope_denied", error: "The request and route must identify the same run." }, 403);
    const run = governance.getRun(runId), policy = options.readPolicyCapability?.();
    // A planning run's binding is refreshed from the worktree the plan is recorded in, which is
    // the same reconciliation every other command reads. A refresh that cannot read the plan is
    // the daemon saying it cannot vouch for the binding, not a reason to act on a stale one.
    let binding: unknown = run.binding;
    try { if (policy) binding = refreshPlanBinding(run.binding, policy); }
    catch { return c.json({ code: "current_binding_unavailable", error: "Current plan and policy evidence is unavailable." }, 503); }
    const receipt = governance.postChatMessage(request, c.get("controlActor"), binding);
    if (receipt.effectMayStart && options.dispatch && receipt.revisionTaskId) {
      const taskId = receipt.revisionTaskId;
      void options.dispatch(runId, taskId)
        .catch(error => console.warn(`team lead: launch for run=${runId} after a chat message failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return c.json(receipt, receipt.status === "denied" ? 403 : 200);
  });

  /**
   * U5 — the owner approves the plan, and the run becomes delivery.
   *
   * Three steps, in this order: the plan is read from the lead's own candidate tree through the
   * same pinned reader every worker-written file goes through; it is committed to the run's own
   * branch in the daemon-owned worktree the run was bound to; and the binding is rebuilt from
   * that commit, which is what the governance command records. The owner's checkout is never
   * touched, and nothing is admitted: the lead's decomposition still goes through the owner's
   * decision after this.
   */
  app.post(planRoute, async (c) => {
    const runId = c.req.param("runId");
    if (!ownerFor(c, runId)) return c.json({ code: "owner_control_required", error: "An authenticated owner approval is required." }, 403);
    const request = parseControlRequest(await c.req.json());
    if (request.runId !== runId) return c.json({ code: "control_scope_denied", error: "The request and route must identify the same run." }, 403);
    const run = governance.getRun(runId);
    if (run.phase !== "planning") {
      return c.json({ code: "plan_not_awaiting_approval", error: "This run's plan was already approved." }, 409);
    }
    const lead = governance.leadTask(runId);
    if (!lead) return c.json({ code: "control_not_found", error: "This run has no lead task to read a plan from." }, 404);
    if (!options.runtime?.planFor) return c.json({ code: "lead_plan_unavailable", error: "Candidate trees are not composed in this daemon." }, 503);
    let plan: { content: string; hash: string };
    try { plan = options.runtime.planFor(runId, lead.taskId, run.binding.planRef); }
    catch (error) { return c.json({ code: "plan_missing", error: (error as Error).message }, 409); }
    if (!plan.content.trim()) return c.json({ code: "plan_missing", error: `The lead wrote no plan at ${run.binding.planRef}.` }, 409);
    const policy = options.readPolicyCapability?.();
    if (!policy) return c.json({ code: "current_policy_unavailable", error: "The plan capability a run is bound under is unavailable." }, 503);
    let currentBinding: unknown;
    try { currentBinding = refreshPlanBinding(run.binding, policy); }
    catch { return c.json({ code: "current_binding_unavailable", error: "Current plan and policy evidence is unavailable." }, 503); }
    // The write scope is the one the owner named when they started planning; the plan path rides
    // along so the lead task the run already admitted stays covered by the binding it runs under.
    const writePaths = [...new Set([run.binding.planRef, ...run.binding.readPaths])];
    let binding;
    try {
      commitPlan({ worktree: run.binding.repository.root, planRef: run.binding.planRef, plan: plan.content,
        message: `plan: ${run.displayName}` });
      binding = bindingForGoal({ root: run.binding.repository.root, planRef: run.binding.planRef, writePaths, policy });
    } catch (error) {
      return c.json({ code: "plan_record_failed", error: (error as Error).message }, 500);
    }
    const receipt = governance.approvePlan(request, c.get("controlActor"), currentBinding, binding);
    if (receipt.status !== "accepted") return c.json(receipt, 403);
    // The plan commit moved the worktree's HEAD, so the lead's tree is re-adopted at the new
    // base rather than refused as a moved source. Its bytes stay exactly where the lead wrote them.
    options.runtime.forgetCandidate?.(runId, lead.taskId);
    if (receipt.effectMayStart && options.dispatch) {
      void options.dispatch(runId, lead.taskId).catch(error =>
        console.warn(`team lead: launch for run=${runId} after plan approval failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return c.json(receipt);
  });

  app.onError((error, c) => {
    // A message, a plan read or an approval that is malformed is the client's fault, not a
    // persistence failure: say so instead of asking the owner to retry an unchanged request.
    if (error instanceof TeamContractError || error instanceof SyntaxError) {
      return c.json({ code: "invalid_team_contract", error: "The request is malformed or incompatible." }, 400);
    }
    if (/not found/i.test(error.message)) return c.json({ code: "control_not_found", error: "The requested entity was not found." }, 404);
    if (/conflict|idempotency key/i.test(error.message)) {
      return c.json({ code: "control_conflict", error: "Refresh the entity version and exact request before retrying." }, 409);
    }
    console.warn("team lead: proposal was not acknowledged: " + error.message);
    return c.json({ code: "control_persistence_failed", error: "The lead proposal was not acknowledged." }, 500);
  });
  return app;
}
