import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, parseProtocolVersion } from "../contracts/team-control.js";
import type { PlanGovernance } from "../domain/plan-governance.js";
import { completionBlockedReason, evidenceSubject, taskCompletionEvidence,
  type CandidateFacts, type TaskCompletionEvidence } from "../domain/task-completion.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

/**
 * MVP — the owner's completion read.
 *
 * A task can only be completed by an owner action, and that action needs two facts the owner
 * cannot see: which attempt was observed to stop, and what the daemon can verify about the
 * candidate. Both are reads over owners that already exist — the governance rows for the
 * attempt and the runtime's own candidate manifest — so this route writes nothing and composes
 * no second reader.
 *
 * The evidence it returns is what the owner action forwards to `POST /runs/:runId/tasks/outcome`.
 * The write contract is unchanged: the owner still observes the outcome, and the loop still
 * starts on the `validated` flag the daemon computed here rather than on anything an agent said.
 *
 * Owner-only: the evidence quotes the candidate's changed paths, which is worker-written
 * content the worker boundary is not allowed to read.
 */
export function teamCompletionRoutes(governance: PlanGovernance, options: {
  credentials: TeamControlCredentials;
  legacyTokens: readonly (string | null | undefined)[];
  /** The runtime that owns the candidate trees; absent leaves the evidence unavailable. */
  runtime?: { candidateManifestFor(runId: string, taskId: string): CandidateFacts };
}): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  const route = "/runs/:runId/tasks/:taskId/completion";
  app.use(route, teamControlAuthentication(() => options.credentials, options.legacyTokens));
  app.use(route, bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ code: "invalid_team_contract", error: "The completion read exceeds its size limit." }, 413) }));
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
      evidence = taskCompletionEvidence({ role: task.assignment.role, assignmentPaths: task.assignment.paths,
        manifest, ...(options.runtime ? {} : { unavailableReason: "Candidate trees are not composed in this daemon" }) });
    } catch (error) {
      // A candidate the control cannot read is missing evidence, not a crash. The reason is the
      // daemon's own, so the owner sees one sentence instead of an internal message.
      evidence = taskCompletionEvidence({ role: task.assignment.role, assignmentPaths: task.assignment.paths, manifest: null,
        unavailableReason: "The task's candidate is not on disk" });
    }
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, completion: {
      taskId, role: task.assignment.role, subjectTaskId: subject, queueState: item,
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
