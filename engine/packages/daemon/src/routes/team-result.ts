import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, TEAM_RESULT_SCHEMA, parseProtocolVersion } from "../contracts/team-control.js";
import type { PlanGovernance } from "../domain/plan-governance.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

/**
 * MVP slice 3 — the owner's read of a finished task's result.
 *
 * The patch and the file manifest are already computed by `team-workspace.ts`, the one reader
 * of worker-written files; this route only serves them, through the same candidate lookup the
 * runtime uses for every other read of that tree. It writes nothing.
 *
 * Owner-only: the patch is worker-written content published to the owner, and a worker
 * credential is scoped to its own run's mailbox and control actions, never to a read that
 * would hand it another task's work.
 *
 * "Finished" is the task's own recorded outcome, which is what the owner observes when they
 * accept the work. Serving a task still in flight would present a half-written candidate as a
 * result, so that case is a named refusal rather than a partial answer.
 */
export function teamResultRoutes(governance: PlanGovernance, options: {
  credentials: TeamControlCredentials;
  legacyTokens: readonly (string | null | undefined)[];
  /** The runtime that owns the candidate trees; absent leaves every result unavailable. */
  runtime?: Pick<import("../domain/workflow-runtime.js").WorkflowRuntime, "candidateManifestFor">;
}): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  const route = "/runs/:runId/tasks/:taskId/result";
  app.use(route, teamControlAuthentication(() => options.credentials, options.legacyTokens));
  app.use(route, bodyLimit({ maxSize: 1_048_576,
    onError: c => c.json({ code: "invalid_team_contract", error: "The control request exceeds its size limit." }, 413) }));
  app.get(route, (c) => {
    const runId = c.req.param("runId"), taskId = c.req.param("taskId");
    if (c.get("controlActor").kind !== "owner" || (c.get("controlRunId") !== null && c.get("controlRunId") !== runId)) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const task = governance.findTask(runId, taskId);
    if (!task) return c.json({ code: "control_not_found", error: "The requested task was not found." }, 404);
    // "Finished" is the task's own recorded outcome. The attempt row is not the authority here:
    // the unisolated launch records a receipt and no attempt row, so a result keyed on one would
    // be unreadable on exactly the host this MVP runs on. A task with no terminal outcome is
    // still being worked, and serving its half-written candidate would present that as a result.
    const item = governance.queueState(task.qitemId);
    if (!item || !["done", "failed", "denied", "canceled"].includes(item)) {
      return c.json({ code: "team_result_unfinished",
        error: "The task has no finished outcome; its result is not available yet." }, 409);
    }
    if (!options.runtime) {
      return c.json({ code: "team_result_unavailable", error: "Candidate trees are not composed in this daemon." }, 503);
    }
    let manifest: ReturnType<NonNullable<typeof options.runtime>["candidateManifestFor"]>;
    try {
      manifest = options.runtime.candidateManifestFor(runId, taskId);
    } catch (error) {
      // A candidate the control can no longer read is missing evidence, not a crash: the
      // reader gets a named refusal instead of a 500 carrying an internal message.
      const message = (error as Error).message;
      if (/not found/i.test(message)) return c.json({ code: "control_not_found", error: "The requested run was not found." }, 404);
      return c.json({ code: "team_result_unavailable", error: "The task's candidate could not be read." }, 503);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, result: { schema: TEAM_RESULT_SCHEMA,
      runId, taskId, attemptId: governance.getLatestTaskAttempt(task.qitemId)?.id ?? null,
      repositoryRoot: governance.getRun(runId).binding.repository.root,
      base: manifest.base, baseIdentifier: manifest.baseIdentifier, manifestDigest: manifest.manifestDigest,
      files: manifest.files, patch: manifest.patch } });
  });
  return app;
}
