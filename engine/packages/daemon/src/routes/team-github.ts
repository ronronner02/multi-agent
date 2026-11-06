import { Hono } from "hono";
import { GithubCli, GithubCliError } from "../domain/github-cli.js";
import {
  teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv,
} from "../middleware/auth-bearer-token.js";

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
  app.get("/github/status", async c => c.json(await github.status()));
  app.post("/github/login", async c => c.json(await github.startLogin()));
  app.get("/github/login", c => c.json(github.loginState()));
  app.post("/github/logout", async c => c.json(await github.logout()));
  app.onError((error, c) => {
    const failure = error instanceof GithubCliError ? error : new GithubCliError("github_login_failed");
    return c.json({ code: failure.code, error: failure.message },
      failure.code === "github_cli_missing" ? 503 : 502);
  });
  return app;
}
