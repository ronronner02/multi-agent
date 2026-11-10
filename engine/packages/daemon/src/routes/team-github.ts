import { Hono } from "hono";
import { TEAM_CONTROL_VERSION } from "../contracts/team-control.js";
import { GithubCli, GithubCliError } from "../domain/github-cli.js";
import {
  teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv,
} from "../middleware/auth-bearer-token.js";

/**
 * Status map for each GithubCli error code the routes may surface.
 * The UI carries a corresponding entry in the team-control error map.
 *
 * New codes added by U9:
 *  - github_view_retry       502 — transient, retry will work
 *  - github_push_timeout     502 — push timed out
 *  - github_large_file_rejected 400 — permanent, change the files
 *  - github_network_failure  502 — check proxy/connection
 *  - github_auth_failure     401 — sign in again
 *  - github_proxy_unreachable 502 — proxy configured but unreachable
 */
function httpStatus(code: string): 400 | 401 | 409 | 502 | 503 {
  switch (code) {
    case "github_cli_missing": return 503;
    case "github_repo_exists":
    case "github_not_signed_in": return 409;
    case "github_auth_failure": return 401;
    case "github_large_file_rejected": return 400;
    default: return 502;
  }
}

export function teamGithubRoutes(
  github: GithubCli,
  credentials: TeamControlCredentials,
  legacyTokens: readonly (string | null | undefined)[],
): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("/github/*", teamControlAuthentication(() => credentials, legacyTokens));
  app.use("/github/*", async (c, next) => {
    if (c.get("controlActor").kind !== "owner") {
      return c.json({ code: "owner_control_required", error: "An authenticated owner is required." }, 403);
    }
    await next();
  });
  app.get("/github/status", async c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await github.status() }));
  app.post("/github/login", async c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await github.startLogin() }));
  app.get("/github/login", c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...github.loginState() }));
  app.post("/github/logout", async c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await github.logout() }));
  app.onError((error, c) => {
    const failure = error instanceof GithubCliError ? error : new GithubCliError("github_login_failed");
    // Pass bounded stderr alongside the code and message.
    const body: Record<string, unknown> = { code: failure.code, error: failure.message };
    if (failure.stderr) body.stderr = failure.stderr;
    return c.json(body, httpStatus(failure.code));
  });
  return app;
}
