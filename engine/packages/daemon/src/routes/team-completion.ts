import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, parseProtocolVersion } from "../contracts/team-control.js";
import type { PlanGovernance } from "../domain/plan-governance.js";
import { completionBlockedReason, evidenceSubject, leadCompletionEvidence, taskCompletionEvidence,
  type CandidateFacts, type TaskCompletionEvidence } from "../domain/task-completion.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

/**
 * MVP — the owner's completion read.
 *
 * The owner completion read exposes the same two facts the daemon uses for automatic outcomes:
 * which attempt was observed to stop, and what the daemon can verify about the candidate. Both
 * are reads over owners that already exist — the governance rows for the attempt and the
 * runtime's own candidate manifest — so this route writes nothing and composes no second reader.
 *
 * The evidence it returns is what the owner action forwards to `POST /runs/:runId/tasks/outcome`.
 * The owner can still forward this evidence as an override through `tasks/outcome`; the daemon's
 * automatic path uses the same governance contract and the same `validated` flag.
 *
 * Owner-only: the evidence quotes the candidate's changed paths, which is worker-written
 * content the worker boundary is not allowed to read.
 */
export function teamCompletionRoutes(governance: PlanGovernance, options: {
  credentials: TeamControlCredentials;
  legacyTokens: readonly (string | null | undefined)[];
  /** The runtime that owns the candidate trees; absent leaves the evidence unavailable. */
  runtime?: { candidateManifestFor(runId: string, taskId: string): CandidateFacts };
  /**
   * C3 — the daemon's own reading of a lead's decomposition. Separate from `runtime` so a host
   * that composes candidate reads still says truthfully that it cannot read a proposal, rather
   * than reporting every lead completion as unvalidated.
   */
  readLeadProposal?: (runId: string, taskId: string) => readonly unknown[];
  /**
   * U6 — the daemon's own reading of a delivery lead's escalation, kept separate for the same
   * reason as the proposal: a host that cannot read one says so instead of reporting every
   * escalation turn as unvalidated.
   */
  readLeadEscalation?: (runId: string, taskId: string) => { optionCount: number } | null;
}): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  const route = "/runs/:runId/tasks/:taskId/completion";
  app.use(route, teamControlAuthentication(() => options.credentials, options.legacyTokens));
  app.use(route, bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ code: "invalid_team_contract", error: "The completion read exceeds its size limit." }, 413) }));
  /** A lead's proposal as the completion read needs it: its task count, or null when unreadable. */
  const proposalFor = (runId: string, taskId: string) => {
    try {
      const tasks = options.readLeadProposal?.(runId, taskId);
      return tasks ? { taskCount: tasks.length } : null;
    } catch { return null; }
  };
  /** U6 — a lead's escalation the same way: whether the boundary accepts it, or null. */
  const escalationFor = (runId: string, taskId: string) => {
    try { return options.readLeadEscalation?.(runId, taskId) ?? null; }
    catch { return null; }
  };
  app.get(route, (c) => {
    const runId = c.req.param("runId"), taskId = c.req.param("taskId");
    if (c.get("controlActor").kind !== "owner" || (c.get("controlRunId") !== null && c.get("controlRunId") !== runId)) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const task = governance.findTask(runId, taskId);
    if (!task) return c.json({ code: "control_not_found", error: "The requested task was not found." }, 404);
    const item = governance.queueState(task.qitemId);
    const session = governance.taskSeat(task.qitemId);
    const attempt = governance.getLatestTaskAttempt(task.qitemId);
    const openAttempts = governance.openAttemptCount(task.qitemId);
    const completion = attempt ? { attemptId: attempt.id, entityVersion: attempt.entityVersion,
      state: attempt.state, observed: attempt.identity !== null } : null;
    // A reviewer's candidate is the implementer's tree, so the evidence describes that task.
    const subject = evidenceSubject(task, taskId);
    let evidence: TaskCompletionEvidence;
    try {
      const manifest = options.runtime ? options.runtime.candidateManifestFor(runId, subject) : null;
      // C3 — a lead's deliverable is its decomposition, not a code change, so its evidence is
      // its own rule: the only path the candidate moves must be the proposal, and that file
      // must be one the boundary accepts. The read is the daemon's, never the owner's claim.
      // U6 — a delivery lead's turn may deliver an escalation instead of a decomposition, and a
    // management turn that wrote neither is still the answer the daemon asked for.
    const delivery = governance.getRun(runId).phase === "delivery";
    evidence = task.assignment.role === "lead"
        ? leadCompletionEvidence({ manifest, planRef: governance.getRun(runId).binding.planRef, proposal: options.readLeadProposal ? proposalFor(runId, taskId) : null,
            ...(options.readLeadEscalation && delivery ? { escalation: escalationFor(runId, taskId), managementTurn: true } : {}),
            ...(options.runtime ? {} : { unavailableReason: "Candidate trees are not composed in this daemon" }) })
        : taskCompletionEvidence({ role: task.assignment.role, assignmentPaths: task.assignment.paths,
            manifest, ...(options.runtime ? {} : { unavailableReason: "Candidate trees are not composed in this daemon" }) });
    } catch (error) {
      // A candidate the control cannot read is missing evidence, not a crash. The reason is the
      // daemon's own, so the owner sees one sentence instead of an internal message.
      const unavailableReason = "The task's candidate is not on disk";
      evidence = task.assignment.role === "lead"
        ? leadCompletionEvidence({ manifest: null, proposal: null, unavailableReason })
        : taskCompletionEvidence({ role: task.assignment.role, assignmentPaths: task.assignment.paths, manifest: null,
            unavailableReason });
    }
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, completion: {
      taskId, role: task.assignment.role, subjectTaskId: subject, queueState: item,
      // The queue row this task's outcome is recorded against. `tasks/outcome` keys on it, so
      // the owner action needs it to address the task it just read the evidence for; the task
      // id alone is the run's name for the work, not the row's identity.
      qitemId: task.qitemId,
      taskVersion: task.entityVersion, actorSession: session, attempt: completion, openAttempts,
      blockedReason: completionBlockedReason({ queueState: item, actorSession: session, attempt: completion, openAttempts }),
      // A reviewer's completion is a review: its findings are the evidence the loop acts on, so
      // the owner must supply them. Every other role's evidence is the candidate's alone.
      findingsRequired: task.assignment.role === "reviewer",
      evidence,
    } });
  });
  return app;
}
