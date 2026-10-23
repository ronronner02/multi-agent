import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { OwnerSessions } from "../domain/owner-session.js";
import { OWNER_COOKIE, OWNER_ABSOLUTE_MS } from "../domain/owner-session.js";
import { resolveTeamControlCredential, teamControlAuthentication,
  type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

export function ownerSessionRoutes(sessions: OwnerSessions, readCredentials: () => TeamControlCredentials,
  legacyTokens: readonly (string | null | undefined)[]): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("*", (c, next) => { c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer"); return next(); });
  app.use("*", bodyLimit({ maxSize: 4096, onError: c => c.json({ code: "invalid_owner_session_request" }, 413) }));
  const ownerOnly = teamControlAuthentication(readCredentials, legacyTokens);
  app.use("*", async (c, next) => {
    if (c.req.path === "/api/team-control/owner-session/exchange") return next();
    // Minting and administration stay owner-CLI operations; a paired browser can revoke only itself.
    if (["/api/team-control/owner-session", "/api/team-control/owner-session/"].includes(c.req.path) && c.req.method === "DELETE") return next();
    if (c.req.header("Origin") !== undefined || c.req.header("Cookie") !== undefined
      || c.req.header("Sec-Fetch-Site") !== undefined) return c.json({ code: "owner_bearer_required" }, 403);
    return ownerOnly(c, async () => {
      if (c.get("controlActor").kind !== "owner") { c.res = c.json({ code: "owner_control_required" }, 403); return; }
      await next();
    });
  });
  app.post("/pairing", c => c.json(sessions.mint(readCredentials().ownerToken!)));
  app.post("/exchange", async c => {
    const origin = c.get("ownerBrowserOrigin" as never) as string | undefined;
    const credentials = readCredentials();
    const config = resolveTeamControlCredential(undefined, credentials, legacyTokens);
    if (!config.ok && config.code === "control_credentials_conflict") return c.json({ code: config.code }, 503);
    if (!origin || !credentials.ownerToken || c.req.header("Authorization") !== undefined
      || !/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) {
      return c.json({ code: "invalid_owner_session_request" }, 403);
    }
    const body: unknown = await c.req.json();
    const result = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1
      ? sessions.exchange((body as Record<string, unknown>).code, origin, credentials.ownerToken) : null;
    if (!result) return c.json({ code: "owner_pairing_required" }, 401);
    c.header("Set-Cookie", `${OWNER_COOKIE}=${result.token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${OWNER_ABSOLUTE_MS / 1000}`);
    return c.json({ antiForgeryToken: result.antiForgeryToken, session: result.session });
  });
  app.get("/sessions", c => c.json({ sessions: sessions.list() }));
  app.delete("/sessions/:id", c => c.json({ revoked: sessions.revoke(c.req.param("id")) }));
  app.delete("", c => {
    const actor = c.get("ownerCookieActor" as never) as { sessionId: string } | undefined;
    if (!actor) return c.json({ code: "owner_session_required" }, 401);
    sessions.revoke(actor.sessionId);
    c.header("Set-Cookie", `${OWNER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0`);
    return c.json({ revoked: true });
  });
  app.onError((_error, c) => c.json({ code: "invalid_owner_session_request" }, 400));
  return app;
}
