import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TEAM_CONTROL_VERSION, TeamContractError, parseControlRequest, parseProtocolVersion,
  type TeamRun,
} from "../contracts/team-control.js";
import type { PlanGovernance, ProviderPolicyCapability } from "../domain/plan-governance.js";
import {
  teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv,
} from "../middleware/auth-bearer-token.js";

export interface TeamControlOptions {
  credentials: TeamControlCredentials;
  resolveBinding?: (run: TeamRun) => unknown;
  readPolicyCapability?: () => ProviderPolicyCapability | null;
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
  app.get("/runs/:runId", (c) => {
    if (c.get("controlActor").kind !== "owner") return c.json({ code: "owner_control_required" }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, run: governance.getRun(c.req.param("runId")) });
  });
  app.get("/runs/:runId/approvals", (c) => {
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, approvals: governance.listApprovals(c.req.param("runId")) });
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
