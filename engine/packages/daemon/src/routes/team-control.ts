import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TEAM_CONTROL_VERSION, TeamContractError, object, parseControlRequest, parsePlanBinding, parseProtocolVersion,
  type ControlActor, type ControlRequest, type TeamRun, type TeamSystemHealth,
} from "../contracts/team-control.js";
import { hashBinding, type PlanGovernance, type ProviderPolicyCapability } from "../domain/plan-governance.js";
import {
  teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv,
} from "../middleware/auth-bearer-token.js";
import { readSystemHealthBounded } from "../domain/system-health.js";
import { ScopeExtensionError } from "../domain/scope-extension.js";
import type { TeamReadModel } from "../team-control-surface.js";
import type { Cancellation } from "../domain/team-cancellation.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { StartupOrchestrator } from "../domain/startup-orchestrator.js";
import { seatForTask } from "../domain/seat-pane.js";
import { seatLifecycleService } from "./seat.js";
import { refreshPlanBinding } from "./team-start.js";

export interface TeamControlOptions {
  credentials: TeamControlCredentials;
  resolveBinding?: (run: TeamRun) => unknown;
  readPolicyCapability?: () => ProviderPolicyCapability | null;
  readSystemHealth?: () => TeamSystemHealth | Promise<TeamSystemHealth>;
  /**
   * T052 — the managed owner read projections. Absent leaves the read routes
   * unavailable rather than serving a partial or invented projection.
   */
  readModel?: TeamReadModel;
  /**
   * MVP — what starts the agent that has to do a new task.
   *
   * Absent under hardened isolation, where an agent starts through the privileged launcher
   * and a start request keeps its existing behaviour. Composed only when
   * `workers.isolation: none`, where nothing else ever launches the seat.
   */
  dispatch?: (runId: string, taskId: string) => Promise<void>;
  /**
   * T017 (cancellation half) — what turns the owner's cancel into a stopped run.
   *
   * `cancelRun` records the intent; this ends the processes the run launched and records the
   * observation, so the response says whether the stop was seen rather than only that it was
   * requested. Absent (a daemon composed without it) keeps the intent-only behaviour.
   */
  cancellation?: Cancellation;
}

export function teamControlRoutes(
  governance: PlanGovernance,
  options: TeamControlOptions,
  legacyTokens: readonly (string | null | undefined)[],
): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("*", teamControlAuthentication(() => options.credentials, legacyTokens));
  app.use("*", bodyLimit({ maxSize: 1_048_576,
    onError: c => c.json({ code: "invalid_team_contract", error: "The control request exceeds its size limit." }, 413) }));
  app.use("/runs/:runId/*", async (c, next) => {
    const scope = c.get("controlRunId");
    if (scope !== null && scope !== c.req.param("runId")) {
      return c.json({ code: "control_scope_denied", error: "The credential does not belong to this run." }, 403);
    }
    if (c.get("controlActor").kind !== "owner"
      && !(c.req.method === "POST" && c.req.path.endsWith("/approvals/request"))) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner decision is required." }, 403);
    }
    await next();
  });
  app.get("/health", async (c) => {
    if (c.get("controlActor").kind !== "owner") return c.json({ code: "owner_control_required" }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const health = await readSystemHealthBounded(options.readSystemHealth);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, health });
  });
  app.get("/runs/:runId", (c) => {
    if (c.get("controlActor").kind !== "owner") return c.json({ code: "owner_control_required" }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, run: governance.getRun(c.req.param("runId")) });
  });
  app.get("/runs/:runId/approvals", (c) => {
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, approvals: governance.listApprovals(c.req.param("runId")) });
  });
  app.post("/runs/:runId/tasks/:taskId/continue", async c => {
    const body = object(await c.req.json(), "continue");
    parseProtocolVersion(body.protocolVersion);
    if (!Number.isSafeInteger(body.expectedEntityVersion) || (body.expectedEntityVersion as number) < 1) {
      throw new TeamContractError("expectedEntityVersion");
    }
    const runId = c.req.param("runId"), taskId = c.req.param("taskId");
    const run = governance.getRun(runId);
    if (!governance.findTask(runId, taskId)) throw new Error("Task not found");
    const sessions = c.get("sessionRegistry" as never) as SessionRegistry | undefined;
    const startup = c.get("startupOrchestrator" as never) as StartupOrchestrator | undefined;
    if (!sessions || !startup) return c.json({ code: "continuation_unavailable" }, 503);
    const seat = seatForTask(sessions, runId, taskId), context = sessions.findResumeContextByName(seat);
    const binding = context && startup.pendingManagedBinding(context.nodeId, context.sessionId);
    const attempt = binding?.managedAttempt;
    if (!context || context.rigId !== run.rigId || !attempt || attempt.context.runId !== runId
      || attempt.context.assignment.taskId !== taskId) return c.json({ code: "continuation_unavailable" }, 409);
    const assertContinuation = () => {
      const current = sessions.findResumeContextByName(seat), policy = options.readPolicyCapability?.();
      if (!policy || attempt.deadline <= Date.now() || current?.sessionId !== context.sessionId
        || sessions.getBindingForNode(context.nodeId)?.tmuxPane !== binding.tmuxPane) {
        throw new Error("Continuation conflict: the admitted authority or occupant changed");
      }
      governance.assertTaskContinuation(runId, taskId, body.expectedEntityVersion as number,
        refreshPlanBinding(run.binding, policy), attempt.attemptId);
      if (hashBinding(attempt.context.binding) !== run.bindingDigest) throw new Error("Continuation conflict: the attempt has an earlier plan binding");
    };
    assertContinuation();
    const result = await seatLifecycleService(c).continueFreshStartup(seat, assertContinuation);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, seat, ...result }, result.ok ? 200 : 409);
  });
  app.get("/runs/:runId/tasks/:taskId/scope", (c) => {
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const scope = governance.scopeForTask(c.req.param("runId"), c.req.param("taskId"));
    const pending = scope.extensions.some(extension => extension.state === "pending");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, status: pending ? "extension-pending" : "observed", scope }, pending ? 202 : 200);
  });
  /**
   * T052 — the composed owner read projection for one run.
   *
   * Owner-only, because it publishes committed evidence the worker boundary is
   * not allowed to read. It composes existing owners and writes nothing, so a
   * read cannot change durable state, files, sessions or provider state.
   */
  app.get("/runs/:runId/read", (c) => {
    if (c.get("controlActor").kind !== "owner") return c.json({ code: "owner_control_required" }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    if (!options.readModel) {
      return c.json({ code: "team_read_unavailable", error: "The managed read projection is not composed." }, 503);
    }
    try {
      const read = options.readModel.read(c.req.param("runId"));
      read.controlVersions = {
        latestAttempts: Object.fromEntries(read.tasks.flatMap(task => { const row = governance.getLatestTaskAttempt(task.qitemId); return row ? [[task.qitemId, row.id]] : []; })),
        tasks: Object.fromEntries(read.tasks.flatMap(task => { const row = governance.getTask(task.qitemId); return row ? [[task.qitemId, row.entityVersion]] : []; })),
        attempts: Object.fromEntries(read.attempts.flatMap(attempt => { const row = governance.getAttempt(attempt.attemptId); return row ? [[attempt.attemptId, row.entityVersion]] : []; })),
      };
      return c.json({ protocolVersion: TEAM_CONTROL_VERSION, read });
    } catch (error) {
      // A missing run is a 404, not a 500: the evidence does not exist to read.
      if (/Run not found/i.test((error as Error).message)) {
        return c.json({ code: "control_not_found", error: "The requested run was not found." }, 404);
      }
      throw error;
    }
  });
  /**
   * T052 — one bounded replay page for a run from a durable cursor.
   *
   * Reads through the event bus's own committed log; a cursor older than the
   * retained floor reports a gap instead of backfilling silently.
   */
  app.get("/runs/:runId/replay", (c) => {
    if (c.get("controlActor").kind !== "owner") return c.json({ code: "owner_control_required" }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    if (!options.readModel) {
      return c.json({ code: "team_read_unavailable", error: "The managed read projection is not composed." }, 503);
    }
    const afterSeq = Number.parseInt(c.req.query("afterSeq") ?? "0", 10);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return c.json({ code: "invalid_team_contract" }, 400);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "500", 10);
    const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 500;
    const page = options.readModel.replay(c.req.param("runId"), afterSeq, limit);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, runId: c.req.param("runId"), ...page });
  });
  app.post("/runs/:runId/growth", async c => {
    const request = parseControlRequest(await c.req.json());
    if (request.runId !== c.req.param("runId")) return c.json({ code: "control_scope_denied" }, 403);
    const run = governance.getRun(request.runId), input = object(request.payload, "growth");
    const proposed = parsePlanBinding({ ...run.binding, writePaths: input.writePaths });
    proposed.readPaths = [...new Set([...run.binding.readPaths, ...proposed.writePaths])];
    if (!options.resolveBinding) return c.json({ code: "current_binding_unavailable" }, 503);
    let binding: unknown;
    try { binding = options.resolveBinding({ ...run, binding: proposed }); }
    catch { return c.json({ code: "current_binding_unavailable" }, 503); }
    const receipt = governance.proposeRunGrowth(request, c.get("controlActor"), binding);
    return c.json(receipt, receipt.status === "denied" ? 403 : 200);
  });
  app.get("/runs/:runId/tasks/:taskId/edit", c => {
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    return c.json(governance.taskForEdit(c.req.param("runId"), c.req.param("taskId")));
  });
  app.post("/runs/:runId/tasks/:taskId/edit", async c => {
    const request = parseControlRequest(await c.req.json());
    if (request.runId !== c.req.param("runId") || request.actionId !== c.req.param("taskId")) return c.json({ code: "control_scope_denied" }, 403);
    if (!options.resolveBinding) return c.json({ code: "current_binding_unavailable" }, 503);
    let binding: unknown;
    try { binding = options.resolveBinding(governance.getRun(request.runId)); }
    catch { return c.json({ code: "current_binding_unavailable" }, 503); }
    const receipt = governance.editTask(request, c.get("controlActor"), binding);
    return c.json(receipt, receipt.status === "denied" ? 403 : 200);
  });
  for (const action of ["approvals/request", "approvals/decide", "cancel", "tasks/outcome", "pause", "resume", "tasks/retry"] as const) {
    app.post(`/runs/:runId/${action}`, async (c) => {
      const request = parseControlRequest(await c.req.json());
      if (request.runId !== c.req.param("runId")) {
        return c.json({ code: "control_scope_denied", error: "The request and route must identify the same run." }, 403);
      }
      const actor = c.get("controlActor");
      if (action === "cancel") {
        // T017 — the owner's cancel stops the work, not only records that it was asked for.
        // The intent is written first and durably; only then are this run's own client
        // processes signalled, and the receipt reports what was observed. Without a composed
        // cancellation owner the intent-only command runs, as it did before this slice.
        return cancelRun(c, governance, options.cancellation, request, actor);
      }
      let receipt;
      if (action === "approvals/request") receipt = governance.requestApproval(request, actor);
      else if (action === "tasks/outcome") receipt = governance.recordTaskOutcome(request, actor);
      else {
        if (!options.resolveBinding) {
          return c.json({ code: "current_binding_unavailable", error: "Current plan and policy evidence is unavailable." }, 503);
        }
        let binding: unknown;
        try {
          const run = governance.getRun(request.runId), approval = action === "approvals/decide" ? governance.getApproval(request.actionId) : null;
          binding = options.resolveBinding(approval?.action === "scope-change" && approval.payload.change === "run-growth"
            ? { ...run, binding: parsePlanBinding(approval.payload.binding) } : run);
        }
        catch { return c.json({ code: "current_binding_unavailable", error: "Current plan and policy evidence is unavailable." }, 503); }
        receipt = action === "approvals/decide" ? governance.decideApproval(request, actor, binding)
          : governance.ownerCommand(action === "tasks/retry" ? "retry" : action, request, actor, binding);
      }
      if (receipt.effectMayStart && options.dispatch) {
        // C1 dispatches a growth's added tasks; C2 dispatches the task a completion created
        // (a reviewer task) and the implementer a review sent back for rework. One receipt
        // never carries both, so the two paths cannot start the same task twice.
        const addedTasks = (receipt.value as { addedTasks?: string[] } | null)?.addedTasks ?? [];
        const next = [receipt.reviewTaskId, receipt.reworkTaskId, receipt.revisionTaskId]
          .filter((taskId): taskId is string => taskId !== undefined);
        for (const taskId of [...addedTasks, ...next]) void options.dispatch(request.runId, taskId).catch(error =>
          console.warn(`team control: launch for run=${request.runId} task=${taskId} failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      return c.json(receipt, receipt.status === "denied" ? 403 : receipt.status === "pending-execution" ? 202 : 200);
    });
  }
  app.onError((error, c) => {
    if (error instanceof ScopeExtensionError) {
      return c.json({ code: error.code, rule: error.rule, extension: error.extension ?? null }, error.code === "extension-pending" ? 202 : 409);
    }
    if (error instanceof TeamContractError || error instanceof SyntaxError) {
      return c.json({ code: "invalid_team_contract", error: "The control request is malformed or incompatible." }, 400);
    }
    if (/conflict|idempotency key/i.test(error.message)) {
      return c.json({ code: "control_conflict", error: "Refresh the entity version and exact request before retrying." }, 409);
    }
    if (/not found/i.test(error.message)) return c.json({ code: "control_not_found", error: "The requested control entity was not found." }, 404);
    return c.json({ code: "control_persistence_failed", error: "The control action was not acknowledged." }, 500);
  });
  return app;
}

/**
 * T017 — the owner's cancel, as the route answers it.
 *
 * Three steps in one request, in this order and no other: the intent is recorded, the
 * processes this run launched are ended, and the observation is recorded. A refusal at the
 * first step is the route's answer unchanged (403); after it, the answer is `observed` with
 * the run's own outcome, or `pending-execution` naming what is still alive. The status code
 * follows the receipt the way every other action's does.
 */
async function cancelRun(c: Context<TeamControlEnv>, governance: PlanGovernance, cancellation: Cancellation | undefined,
  request: ControlRequest<unknown>, actor: ControlActor) {
  const intent = cancellation ? cancellation.request(request.runId, request, actor) : governance.cancelRun(request, actor);
  // A denied intent is the answer: nothing was signalled, so there is nothing to observe.
  if (intent.status === "denied") return c.json(intent, 403);
  if (!cancellation) return c.json(intent, intent.status === "pending-execution" ? 202 : 200);
  const stopped = await cancellation.stop(request.runId, actor);
  // The stop's own observation replaces the intent's placeholder reason: `canceled` says the
  // work ended, and `cancel_requested` says what is still holding it open. The version is the
  // run's as it stands now, because the observation is a second write on top of the intent.
  const receipt = { ...intent, entityVersion: governance.getRun(request.runId).entityVersion,
    status: stopped.state === "canceled" ? "observed" as const : "pending-execution" as const,
    value: { state: stopped.state, attempts: stopped.attempts, unresolvedAttempts: stopped.unresolvedAttempts,
      canceledTasks: stopped.canceledTasks }, reason: stopped.reason };
  return c.json(receipt, stopped.state === "canceled" ? 200 : 202);
}
