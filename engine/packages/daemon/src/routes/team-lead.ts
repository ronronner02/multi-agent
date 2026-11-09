import type { AttemptTelemetry } from "../domain/attempt-telemetry.js";
import { approvalDocumentPins, documentSourceRefusal, latestDocument, type DocumentEvidence } from "../domain/project-documents.js";
import { canonicalJson, type DocumentPins } from "../contracts/team-control.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, TeamContractError, parseControlRequest, parseProtocolVersion } from "../contracts/team-control.js";
import { hashBinding, type PlanGovernance, type ProviderPolicyCapability } from "../domain/plan-governance.js";
import type { LeadTask } from "../domain/lead-proposal.js";
import { planningRosterRequired, type LeadRosterEvidence } from "../domain/lead-roster.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import { chatBody, parseResponseLanguage, runLeadTask } from "../domain/lead-chat.js";
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
  settingsStore?: SettingsStore;
  telemetry?: AttemptTelemetry;
  /** The runtime that owns the candidate trees and reads worker-written files. */
  runtime?: {
    leadProposalFor(runId: string, taskId: string): LeadTask[];
    rosterFor?(runId: string, taskId: string, planRef: string): LeadRosterEvidence;
    /** U5 — the plan a planning lead wrote in its own tree. */
    planFor?(runId: string, taskId: string, planRef: string): { content: string; hash: string };
    documentsFor?(runId: string, taskId: string, planRef: string): DocumentEvidence;
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
    parseResponseLanguage((request.payload as Record<string, unknown> | null)?.responseLanguage);
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

  const documentRoute = "/runs/:runId/documents";
  for (const path of [documentRoute, documentRoute + "/confirm", documentRoute + "/stage"]) {
    app.use(path, teamControlAuthentication(() => options.credentials, options.legacyTokens));
    app.use(path, bodyLimit({ maxSize: 65_536, onError: c => c.json({ code: "invalid_team_contract" }, 413) }));
  }
  app.get(documentRoute, c => {
    const runId = c.req.param("runId")!;
    if (!ownerFor(c, runId)) return c.json({ code: "owner_control_required" }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, runId, workflow: governance.documents(runId) });
  });
  app.post(documentRoute + "/confirm", async c => {
    const runId = c.req.param("runId")!;
    if (!ownerFor(c, runId)) return c.json({ code: "owner_control_required" }, 403);
    const request = parseControlRequest(await c.req.json());
    parseResponseLanguage((request.payload as Record<string, unknown> | null)?.responseLanguage);
    if (request.runId !== runId) return c.json({ code: "control_scope_denied" }, 403);
    const run = governance.getRun(runId), lead = governance.leadTask(runId);
    if (!lead || !options.runtime?.documentsFor) return c.json({ code: "documents_unavailable", error: "The document reader is not available." }, 503);
    let evidence: DocumentEvidence;
    try { evidence = options.runtime.documentsFor(runId, lead.taskId, run.binding.planRef); }
    catch { return c.json({ code: "documents_unreadable", error: "The lead's document files are not readable." }, 409); }
    const receipt = governance.confirmDocument(request, c.get("controlActor"), evidence);
    return c.json(receipt, receipt.status === "denied" ? 409 : 200);
  });
  app.post(documentRoute + "/stage", async c => {
    const runId = c.req.param("runId")!;
    if (!ownerFor(c, runId)) return c.json({ code: "owner_control_required" }, 403);
    const request = parseControlRequest(await c.req.json());
    parseResponseLanguage((request.payload as Record<string, unknown> | null)?.responseLanguage);
    if (request.runId !== runId) return c.json({ code: "control_scope_denied" }, 403);
    const run = governance.getRun(runId), policy = options.readPolicyCapability?.();
    if (!policy) return c.json({ code: "current_policy_unavailable" }, 503);
    let binding;
    try { binding = refreshPlanBinding(run.binding, policy); }
    catch { return c.json({ code: "current_binding_unavailable" }, 503); }
    if ((request.payload as Record<string, unknown>)?.stage === "plan") {
      const state = governance.documents(runId), lead = governance.leadTask(runId);
      try {
        if (state && lead) {
          if (!options.runtime?.documentsFor) throw new Error("The document reader is not available.");
          const error = documentSourceRefusal(state, options.runtime.documentsFor(runId, lead.taskId, run.binding.planRef), ["requirements"]);
          if (error) throw new Error(error);
        }
      } catch (error) { return c.json({ code: "documents_changed", error: (error as Error).message }, 409); }
    }
    const receipt = governance.selectDocumentStage(request, c.get("controlActor"), binding);
    if (receipt.effectMayStart && receipt.revisionTaskId && options.dispatch) {
      void options.dispatch(runId, receipt.revisionTaskId).catch(error =>
        console.warn(`team documents: stage launch failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return c.json(receipt, receipt.status === "denied" ? 409 : receipt.status === "pending-execution" ? 202 : 200);
  });

  /**
   * U5 — the run's conversation, in order.
   *
   * The owner reads what they and the lead said, and the run's phase, so a client knows whether
   * a plan is still being agreed. U6 adds two things a client needs to render a decision: the
   * message kind with its options and its answer, and the one decision the run is waiting on.
   * Nothing here starts work or records a decision.
   */
  app.get(chatRoute, (c) => {
    const runId = c.req.param("runId")!;
    if (!ownerFor(c, runId)) return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    let run;
    try { run = governance.getRun(runId); } catch (error) {
      if (/not found/i.test((error as Error).message)) return c.json({ code: "control_not_found", error: "The requested entity was not found." }, 404);
      throw error;
    }
    const decision = governance.chatDecision(runId);
    const messages = governance.chatMessages(runId), leadTask = governance.leadTask(runId);
    const attempt = leadTask ? governance.getLatestTaskAttempt(leadTask.qitemId) : null;
    const liveTurn = attempt?.role === "lead" && attempt.runId === runId && !messages.some(message => message.attemptId === attempt.id)
      ? { attemptId: attempt.id, state: attempt.state, progress: options.telemetry?.readProgress(attempt) ?? null,
        activity: options.telemetry?.read(attempt) ?? null } : null;
    const documentWorkflow = governance.documents(runId);
    let planApproval: { plan: { content: string; hash: string } | null; roster: LeadRosterEvidence | null; error: string | null; documentVersions?: DocumentPins } | null = null;
    if (run.phase === "planning" && planningRosterRequired(run.binding) && (!documentWorkflow || documentWorkflow.stage === "plan")) {
      planApproval = { plan: null, roster: null, error: null };
      const lead = governance.leadTask(runId);
      try {
        if (!lead || !options.runtime?.planFor || !options.runtime.rosterFor) throw new Error("The planning files are not available yet.");
        planApproval.plan = documentWorkflow ? latestDocument(documentWorkflow, "plan") ?? null
          : options.runtime.planFor(runId, lead.taskId, run.binding.planRef);
        if (documentWorkflow) planApproval.documentVersions = approvalDocumentPins(documentWorkflow);
        planApproval.roster = options.runtime.rosterFor(runId, lead.taskId, run.binding.planRef);
        planApproval.error = governance.planRosterRefusal(runId, planApproval.roster.seats,
          Number(options.settingsStore?.resolveOne("team.maxSeats").value ?? 6));
      } catch (error) { planApproval.error = (error as Error).message; }
    }
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, runId, phase: run.phase, planApproval, documentWorkflow, liveTurn,
      messages: messages.map(message => ({ id: message.id, sender: message.sender,
        kind: message.kind, body: message.body, options: message.options,
        answeredBy: message.answeredBy, createdAt: message.createdAt })),
      // The run waits on this until the owner answers it through this same endpoint, naming it
      // in `answerTo`. Null means nothing is waiting.
      pendingDecision: decision === null ? null : { id: decision.id, body: decision.body,
        options: decision.options, createdAt: decision.createdAt } });
  });

  /**
   * U5 — the owner's message, and the lead's turn to answer it.
   *
   * U6 adds one optional field to the payload: `answerTo` names the decision this message
   * answers, and a message that names a decision also answers it (the decision stops being the
   * pending one, and the answer is the lead's next prompt like any other owner message). The
   * body is the answer's text whether the owner typed it or chose an option.
   *
   * The row and the turn are decided together inside one governance command; this route only
   * starts the turn the command says may start. `queued` in the answer is the honest report that
   * a lead turn was already running: the message is stored and the turn-end owner starts the
   * next one, so the answer to the owner is "kept", not "answered".
   */
  app.post(chatRoute, async (c) => {
    const runId = c.req.param("runId")!;
    if (!ownerFor(c, runId)) return c.json({ code: "owner_control_required", error: "An authenticated owner message is required." }, 403);
    const request = parseControlRequest(await c.req.json());
    parseResponseLanguage((request.payload as Record<string, unknown> | null)?.responseLanguage);
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
    const runId = c.req.param("runId")!;
    if (!ownerFor(c, runId)) return c.json({ code: "owner_control_required", error: "An authenticated owner approval is required." }, 403);
    const request = parseControlRequest(await c.req.json());
    parseResponseLanguage((request.payload as Record<string, unknown> | null)?.responseLanguage);
    if (request.runId !== runId) return c.json({ code: "control_scope_denied", error: "The request and route must identify the same run." }, 403);
    const run = governance.getRun(runId);
    if (request.expectedEntityVersion !== run.entityVersion) throw new Error("Run entity version conflict");
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
    const approvalPayload = request.payload as Record<string, unknown>;
    if (approvalPayload?.ownerMessage !== undefined) chatBody(approvalPayload.ownerMessage, "ownerMessage");
    const requiresDisplayedPlan = planningRosterRequired(run.binding) || !!governance.documents(runId);
    if ((approvalPayload?.planHash !== undefined || approvalPayload?.ownerMessage !== undefined && requiresDisplayedPlan)
      && approvalPayload.planHash !== plan.hash) {
      return c.json({ code: "plan_changed", error: "The displayed plan changed. Read its current version before approving." }, 409);
    }
    if (governance.planningApprovalPending(runId)) {
      return c.json({ code: "plan_not_awaiting_approval", error: "Wait for the lead to finish the planning discussion before approving." }, 409);
    }
    const documentWorkflow = governance.documents(runId);
    let documentVersions: DocumentPins | undefined;
    if (documentWorkflow) {
      try {
        documentVersions = approvalDocumentPins(documentWorkflow);
        if (canonicalJson((request.payload as Record<string, unknown>)?.documentVersions ?? null) !== canonicalJson(documentVersions)) {
          throw new Error("Read and approve the exact current document versions.");
        }
        if (!options.runtime.documentsFor) throw new Error("The document reader is not available.");
        const sourceError = documentSourceRefusal(documentWorkflow, options.runtime.documentsFor(runId, lead.taskId, run.binding.planRef));
        if (sourceError) throw new Error(sourceError);
        if (plan.hash !== documentVersions.plan.hash) throw new Error("The plan changed after the displayed version.");
      } catch (error) { return c.json({ code: "document_approval_required", error: (error as Error).message }, 409); }
    }
    const policy = options.readPolicyCapability?.();
    if (!policy) return c.json({ code: "current_policy_unavailable", error: "The plan capability a run is bound under is unavailable." }, 503);
    let currentBinding: unknown;
    try { currentBinding = refreshPlanBinding(run.binding, policy); }
    catch { return c.json({ code: "current_binding_unavailable", error: "Current plan and policy evidence is unavailable." }, 503); }
    if (hashBinding(currentBinding) !== run.bindingDigest) {
      return c.json({ code: "plan_binding_changed", error: "Plan, repository or policy binding changed. Nothing was published." }, 409);
    }
    let roster: { seats: LeadRosterEvidence["seats"]; maxSeats: number } | undefined;
    if (planningRosterRequired(run.binding)) {
      if (request.expectedEntityVersion !== run.entityVersion) throw new Error("Run entity version conflict");
      if (run.state !== "approved") return c.json({ code: "plan_not_awaiting_approval", error: "The run is closed to plan approval." }, 409);
      let reason: string | null = null;
      try {
        if (!options.runtime.rosterFor) throw new Error("The lead wrote no readable lead-roster.json beside the plan.");
        const evidence = options.runtime.rosterFor(runId, lead.taskId, run.binding.planRef);
        if ((request.payload as Record<string, unknown>)?.rosterDigest !== evidence.digest) {
          throw new Error("The roster changed or its digest is missing. Read lead-roster.json again before approving.");
        }
        const maxSeats = Number(options.settingsStore?.resolveOne("team.maxSeats").value ?? 6);
        reason = governance.planRosterRefusal(runId, evidence.seats, maxSeats);
        roster = { seats: evidence.seats, maxSeats };
      } catch (error) { reason = (error as Error).message; }
      if (reason) {
        const receipt = governance.refuseLeadPlan(request, c.get("controlActor"), currentBinding, reason);
        if (receipt.effectMayStart && options.dispatch && receipt.revisionTaskId) {
          void options.dispatch(runId, receipt.revisionTaskId).catch(error =>
            console.warn(`team lead: planning revision launch failed: ${error instanceof Error ? error.message : String(error)}`));
        }
        return c.json({ ...receipt, code: "lead_roster_refused", error: reason }, 409);
      }
    }
    // Approval promotes the requested scope, including "." for a new project-wide run.
    // Explicit narrow and legacy scopes stay unchanged, and the admitted lead task stays covered.
    const writePaths = [...new Set([run.binding.planRef, ...run.binding.readPaths])];
    let binding;
    try {
      // Keep optional drafts across the delivery candidate refresh without treating them as approvals.
      const documents = documentWorkflow ? (["brainstorm", "requirements", "plan"] as const)
        .flatMap(kind => { const version = latestDocument(documentWorkflow, kind);
          return version ? [{ path: version.path, content: version.content }] : []; }) : [];
      commitPlan({ worktree: run.binding.repository.root, planRef: run.binding.planRef, plan: plan.content,
        documents, message: `plan: ${run.displayName}` });
      binding = { ...bindingForGoal({ root: run.binding.repository.root, planRef: run.binding.planRef, writePaths, policy }),
        limits: run.binding.limits, ...(documentVersions ? { documentVersions } : {}) };
    } catch (error) {
      return c.json({ code: "plan_record_failed", error: (error as Error).message }, 500);
    }
    const receipt = governance.approvePlan(request, c.get("controlActor"), currentBinding, binding, roster);
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
