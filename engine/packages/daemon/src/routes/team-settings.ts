import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, TeamContractError, object, parseProtocolVersion, text } from "../contracts/team-control.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

const KEYS = ["team.leadClient", "team.maxSeats", "team.maxConcurrentAgents", "github.proxy"] as const;
const snapshot = (store: SettingsStore) => ({ protocolVersion: TEAM_CONTROL_VERSION,
  settings: Object.fromEntries(KEYS.map(key => [key, store.resolveOne(key)])) });

export function teamSettingsRoutes(store: SettingsStore | undefined, credentials: TeamControlCredentials,
  legacyTokens: readonly (string | null | undefined)[]): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("/settings", teamControlAuthentication(() => credentials, legacyTokens));
  app.use("/settings", async (c, next) => {
    if (c.get("controlActor").kind !== "owner") {
      return c.json({ code: "owner_control_required", error: "An authenticated owner is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    if (!store) return c.json({ code: "team_settings_unavailable", error: "Team settings are unavailable." }, 503);
    await next();
  });
  app.use("/settings", bodyLimit({ maxSize: 4096,
    onError: c => c.json({ code: "invalid_team_contract", error: "The settings request exceeds its size limit." }, 413) }));
  app.get("/settings", c => c.json(snapshot(store!)));
  app.put("/settings", async c => {
    const body = object(await c.req.json(), "settings");
    if (Object.keys(body).some(key => key !== "key" && key !== "value")) throw new TeamContractError("settings");
    const key = text(body.key, "key", 128), value = text(body.value, "value", 128);
    if (!(KEYS as readonly string[]).includes(key)) throw new TeamContractError("key");
    try { store!.set(key, value); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid value for team.")) {
        return c.json({ code: "invalid_team_setting", error: "The value is outside this setting's constraint." }, 400);
      }
      throw error;
    }
    return c.json(snapshot(store!));
  });
  app.onError((error, c) => error instanceof TeamContractError || error instanceof SyntaxError
    ? c.json({ code: "invalid_team_contract", error: "The settings request is malformed or incompatible." }, 400)
    : c.json({ code: "team_settings_unavailable", error: "Team settings could not be read or saved." }, 500));
  return app;
}
