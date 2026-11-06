import { Hono } from "hono";
import { TEAM_CONTROL_VERSION, parseProtocolVersion } from "../contracts/team-control.js";
import type { PlanGovernance } from "../domain/plan-governance.js";
import type { AttemptTelemetry } from "../domain/attempt-telemetry.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

function integerQuery(values: string[] | undefined, fallback: number, minimum: number, maximum: number): number | null {
  if (values === undefined) return fallback;
  if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0]!)) return null;
  const value = Number(values[0]);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

export function teamTelemetryRoutes(governance: PlanGovernance, telemetry: AttemptTelemetry, options: {
  credentials: TeamControlCredentials; legacyTokens: readonly (string | null | undefined)[];
}): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>(), activity = "/runs/:runId/attempts/:attemptId/activity";
  const authenticate = teamControlAuthentication(() => options.credentials, options.legacyTokens);
  app.use(activity, authenticate); app.use("/analytics", authenticate);
  app.get(activity, c => {
    const runId = c.req.param("runId"), attemptId = c.req.param("attemptId");
    if (c.get("controlActor").kind !== "owner" || (c.get("controlRunId") !== null && c.get("controlRunId") !== runId)) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const after = integerQuery(c.req.queries("after"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (after === null) return c.json({ code: "invalid_team_contract", error: "after must be a nonnegative sequence number." }, 400);
    // Resolve both identities before a path constructor or file reader sees the request.
    const attempt = governance.getAttempt(attemptId);
    if (attempt === null || attempt.runId !== runId) {
      return c.json({ code: "control_not_found", error: "The requested attempt was not found in this run." }, 404);
    }
    governance.getRun(runId);
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, activity: telemetry.read(attempt, after) });
  });
  app.get("/analytics", c => {
    if (c.get("controlActor").kind !== "owner") {
      return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const days = integerQuery(c.req.queries("days"), 30, 1, 365), teams = c.req.queries("team");
    if (days === null || (teams !== undefined && (teams.length !== 1 || !teams[0] || teams[0].length > 256))) {
      return c.json({ code: "invalid_team_contract", error: "days must be between 1 and 365 and team must name one team." }, 400);
    }
    const runId = c.get("controlRunId");
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, analytics: telemetry.analytics({ days,
      ...(teams ? { teamId: teams[0]! } : {}), ...(runId === null ? {} : { runId }) }) });
  });
  return app;
}
