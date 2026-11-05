import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, parseControlRequest, parseProtocolVersion } from "../contracts/team-control.js";
import type { Integration } from "../domain/integration-branch.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

/**
 * U7 / KTD7 — the run's delivery branch, and the owner's one merge.
 *
 * Both verbs are owner-only. The read publishes what landed and whether a merge would go
 * through now; the write is the merge itself, into the repository the team was created for.
 * Neither is a worker action: an agent never merges into the owner's branch.
 *
 * The merge is not a governance command — it writes git, not run state — so the request body
 * carries the run's identity and nothing is read from `expectedEntityVersion`. The shape is the
 * control request every other owner verb sends, so a client has one way to address a run.
 */
export function teamMergeRoutes(options: {
  credentials: TeamControlCredentials;
  legacyTokens: readonly (string | null | undefined)[];
  /** The integration owner. Absent leaves delivery unreadable rather than answering partially. */
  integration?: Integration;
}): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  const readRoute = "/runs/:runId/integration";
  const mergeRoute = "/runs/:runId/merge";
  app.use(readRoute, teamControlAuthentication(() => options.credentials, options.legacyTokens));
  app.use(mergeRoute, teamControlAuthentication(() => options.credentials, options.legacyTokens));
  app.use(mergeRoute, bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ code: "invalid_team_contract", error: "The control request exceeds its size limit." }, 413) }));

  const ownerFor = (c: Context<TeamControlEnv>, runId: string) => c.get("controlActor").kind === "owner"
    && (c.get("controlRunId") === null || c.get("controlRunId") === runId);

  app.get(readRoute, (c) => {
    const runId = c.req.param("runId");
    if (!ownerFor(c, runId)) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    if (!options.integration) {
      return c.json({ code: "integration_unavailable", error: "This daemon does not compose an integration branch." }, 503);
    }
    try {
      c.header("Cache-Control", "no-store");
      return c.json({ protocolVersion: TEAM_CONTROL_VERSION, integration: options.integration.status(runId) });
    } catch (error) {
      if (/not found/i.test((error as Error).message)) {
        return c.json({ code: "control_not_found", error: "The requested run was not found." }, 404);
      }
      throw error;
    }
  });

  app.post(mergeRoute, async (c) => {
    const runId = c.req.param("runId");
    if (!ownerFor(c, runId)) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner action is required." }, 403);
    }
    const request = parseControlRequest(await c.req.json());
    if (request.runId !== runId) return c.json({ code: "control_scope_denied", error: "The request and route must identify the same run." }, 403);
    if (!options.integration) {
      return c.json({ code: "integration_unavailable", error: "This daemon does not compose an integration branch." }, 503);
    }
    let outcome;
    try { outcome = options.integration.merge(runId); }
    catch (error) {
      if (/not found/i.test((error as Error).message)) {
        return c.json({ code: "control_not_found", error: "The requested run was not found." }, 404);
      }
      throw error;
    }
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...outcome }, outcome.status === "merged" ? 200 : 409);
  });

  return app;
}