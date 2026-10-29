import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TEAM_CONTROL_VERSION, TeamContractError, parseControlRequest, parseProtocolVersion,
  type TeamRun, type TeamSystemHealth,
} from "../contracts/team-control.js";
import type { PlanGovernance, ProviderPolicyCapability } from "../domain/plan-governance.js";
import {
  teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv,
} from "../middleware/auth-bearer-token.js";
import { readSystemHealthBounded } from "../domain/system-health.js";
import { ScopeExtensionError } from "../domain/scope-extension.js";
import type { TeamReadModel } from "../team-control-surface.js";

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
  for (const action of ["approvals/request", "approvals/decide", "cancel", "tasks/outcome"] as const) {
    app.post(`/runs/:runId/${action}`, async (c) => {
      const request = parseControlRequest(await c.req.json());
      if (request.runId !== c.req.param("runId")) {
        return c.json({ code: "control_scope_denied", error: "The request and route must identify the same run." }, 403);
      }
      const actor = c.get("controlActor");
      let receipt;
      if (action === "approvals/request") receipt = governance.requestApproval(request, actor);
      else if (action === "cancel") receipt = governance.cancelRun(request, actor);
      else if (action === "tasks/outcome") receipt = governance.recordTaskOutcome(request, actor);
      else {
        if (!options.resolveBinding) {
          return c.json({ code: "current_binding_unavailable", error: "Current plan and policy evidence is unavailable." }, 503);
        }
        let binding: unknown;
        try { binding = options.resolveBinding(governance.getRun(request.runId)); }
        catch { return c.json({ code: "current_binding_unavailable", error: "Current plan and policy evidence is unavailable." }, 503); }
        receipt = governance.decideApproval(request, actor, binding);
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
