import net from "node:net";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { browserBoundary } from "../src/middleware/browser-boundary.js";
import { resolvePairedOwnerCookie, teamControlAuthentication } from "../src/middleware/auth-bearer-token.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { OwnerSessions, OWNER_COOKIE, OWNER_CSRF_HEADER, OWNER_IDLE_MS, OWNER_ABSOLUTE_MS, PAIRING_TTL_MS } from "../src/domain/owner-session.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { createTestApp } from "./helpers/test-app.js";

describe("KTD14 paired owner authentication", () => {
  let db: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createTestApp>["app"];
  let at: number;
  let sessions: OwnerSessions;
  let options: { credentials: { ownerToken: string | null; workers: { token: string; sessionId: string; runId: string }[] } };
  beforeEach(() => {
    db = createDb(); initializeDatabase(db); fixDaemonMode(db, true);
    at = 1_700_000_000_000;
    sessions = new OwnerSessions(db, () => at);
    options = { credentials: { ownerToken: "owner-pairing-fixture",
      workers: [{ token: "worker-pairing-fixture", sessionId: "worker", runId: "run" }] } };
    app = createTestApp(db, { appDeps: { teamControl: options, ownerSessions: sessions } }).app;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });
  const request = (path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) =>
    app.request(`http://localhost${path}`, { method, headers: { Host: "localhost", "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  it("pairs once and permits owner controls only with the paired anti-forgery token", async () => {
    const minted = await request("/api/team-control/owner-session/pairing", "POST", { Authorization: "Bearer owner-pairing-fixture" });
    expect(minted.status).toBe(200);
    const { code } = await minted.json();
    const exchanged = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code });
    expect(exchanged.status).toBe(200);
    const cookie = exchanged.headers.get("Set-Cookie")!.split(";")[0]!;
    const { antiForgeryToken } = await exchanged.json();
    expect((await request("/api/team-control/health", "GET", { Origin: "http://localhost", Cookie: cookie })).status).toBe(403);
    expect((await request("/api/team-control/health", "GET", { Origin: "http://localhost", Cookie: cookie, "X-Multi-Agent-CSRF": antiForgeryToken })).status).toBe(200);
    expect((await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code })).status).toBe(401);
  });

  async function pair() {
    const minted = await request("/api/team-control/owner-session/pairing", "POST", { Authorization: "Bearer owner-pairing-fixture" });
    expect(minted.status).toBe(200);
    const { code } = await minted.json();
    const response = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code });
    expect(response.status).toBe(200);
    const result = await response.json();
    return { ...result, code, setCookie: response.headers.get("Set-Cookie")!,
      cookie: response.headers.get("Set-Cookie")!.split(";")[0]! };
  }
  const browserHeaders = (paired: { cookie: string; antiForgeryToken: string }) => ({
    Origin: "http://localhost", Cookie: paired.cookie, [OWNER_CSRF_HEADER]: paired.antiForgeryToken,
  });

  it("uses a host-only strict HttpOnly cookie and stores only purpose-separated hashes", async () => {
    const paired = await pair();
    expect(paired.setCookie).toContain("HttpOnly");
    expect(paired.setCookie).toContain("SameSite=Strict");
    expect(paired.setCookie).toContain("Path=/api");
    expect(paired.setCookie).not.toMatch(/Domain=/i);
    expect(paired.setCookie).toContain("Max-Age=43200");
    const stored = JSON.stringify({ pairings: db.prepare("SELECT * FROM owner_pairing_codes").all(),
      sessions: db.prepare("SELECT * FROM owner_sessions").all() });
    for (const secret of [paired.code, paired.cookie.split("=")[1], paired.antiForgeryToken, "owner-pairing-fixture"])
      expect(stored).not.toContain(secret);
    const list = await request("/api/team-control/owner-session/sessions", "GET", { Authorization: "Bearer owner-pairing-fixture" });
    const output = await list.text();
    for (const secret of [paired.code, paired.cookie.split("=")[1], paired.antiForgeryToken]) expect(output).not.toContain(secret);
    expect(output).not.toContain("hash");
  });

  it("expires a pairing code exactly at sixty seconds without creating a session", async () => {
    const { code } = sessions.mint("owner-pairing-fixture");
    at += PAIRING_TTL_MS;
    expect((await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code })).status).toBe(401);
    expect(sessions.list()).toEqual([]);
  });

  it.each(["forged", "duplicate", "malformed"])("rejects %s cookies before the control reader runs", async kind => {
    const paired = await pair();
    const cookie = kind === "forged" ? `${OWNER_COOKIE}=${"A".repeat(43)}`
      : kind === "duplicate" ? `${paired.cookie}; ${paired.cookie}` : `${OWNER_COOKIE}=not-a-session`;
    const before = sessions.list();
    expect((await request("/api/team-control/health", "GET", { ...browserHeaders(paired), Cookie: cookie })).status).toBe(401);
    expect(sessions.list()).toEqual(before);
  });

  it("rejects idle expiry at thirty minutes and does not refresh on an invalid anti-forgery token", async () => {
    const paired = await pair();
    at += OWNER_IDLE_MS - 1;
    expect((await request("/api/team-control/health", "GET", { ...browserHeaders(paired), [OWNER_CSRF_HEADER]: "B".repeat(43) })).status).toBe(403);
    expect(sessions.list()[0]!.last_seen_at).toBe(paired.session.last_seen_at);
    at++;
    expect((await request("/api/team-control/health", "GET", browserHeaders(paired))).status).toBe(401);
  });

  it("refreshes valid activity but enforces the twelve-hour absolute limit", async () => {
    const paired = await pair();
    for (let elapsed = OWNER_IDLE_MS - 1; elapsed < OWNER_ABSOLUTE_MS; elapsed += OWNER_IDLE_MS - 1) {
      at = paired.session.created_at + elapsed;
      expect((await request("/api/team-control/health", "GET", browserHeaders(paired))).status).toBe(200);
    }
    at = paired.session.created_at + OWNER_ABSOLUTE_MS;
    expect((await request("/api/team-control/health", "GET", browserHeaders(paired))).status).toBe(401);
  });

  it("revokes via the owner bearer and denies the very next cookie request", async () => {
    const paired = await pair();
    const revoked = await request(`/api/team-control/owner-session/sessions/${paired.session.id}`, "DELETE",
      { Authorization: "Bearer owner-pairing-fixture" });
    expect(await revoked.json()).toEqual({ revoked: true });
    expect((await request("/api/team-control/health", "GET", browserHeaders(paired))).status).toBe(401);
  });

  it("allows an anti-forgery authenticated browser to revoke only its own session", async () => {
    const paired = await pair();
    expect((await request(`/api/team-control/owner-session/sessions/${paired.session.id}`, "DELETE", browserHeaders(paired))).status).toBe(403);
    const revoked = await request("/api/team-control/owner-session", "DELETE", browserHeaders(paired));
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await request("/api/team-control/health", "GET", browserHeaders(paired))).status).toBe(401);
  });

  it("rejects cookie-only privileged mutations without changing control state", async () => {
    const paired = await pair();
    const before = db.prepare("SELECT count(*) AS count FROM team_control_requests").get();
    const response = await request("/api/team-control/runs/absent/cancel", "POST",
      { Origin: "http://localhost", Cookie: paired.cookie }, {});
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "owner_anti_forgery_required" });
    expect(db.prepare("SELECT count(*) AS count FROM team_control_requests").get()).toEqual(before);
    // With both credentials the request reaches the unchanged contract parser, not a duplicate control handler.
    expect((await request("/api/team-control/runs/absent/cancel", "POST", browserHeaders(paired), {})).status).toBe(400);
  });

  it("keeps bearer calls independent of cookie authentication and rejects invalid explicit bearer tokens", async () => {
    const paired = await pair();
    const cookieLookup = vi.spyOn(sessions, "authenticate");
    expect((await request("/api/team-control/health", "GET", { Authorization: "Bearer owner-pairing-fixture" })).status).toBe(200);
    expect(cookieLookup).not.toHaveBeenCalled();
    expect((await request("/api/team-control/health", "GET",
      { ...browserHeaders(paired), Authorization: "Bearer invalid-token" })).status).toBe(403);
    expect((await request("/api/team-control/health", "GET", { Authorization: "Bearer worker-pairing-fixture" })).status).toBe(403);
    expect((await request("/api/team-control/health", "GET", { Authorization: "Bearer invalid-token" })).status).toBe(401);
  });

  it("preserves native bearer admission without Host and retains token and loopback verification", async () => {
    const lookup = vi.spyOn(sessions, "authenticate");
    const native = (authorization?: string, peer = "127.0.0.1") => app.request("/api/team-control/health",
      { headers: authorization === undefined ? {} : { Authorization: authorization } },
      { incoming: { socket: { remoteAddress: peer } } });
    expect((await native("Bearer owner-pairing-fixture")).status).toBe(200);
    expect((await native("Bearer worker-pairing-fixture")).status).toBe(403);
    expect((await native("Bearer invalid-token")).status).toBe(401);
    expect((await native()).status).toBe(401);
    expect((await native("Bearer owner-pairing-fixture", "192.0.2.1")).status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("retains native Host rules, configured bearer waiver and browser isolation", async () => {
    const native = new Hono();
    native.use("*", browserBoundary({ webUiEnabled: false, pairedOwnerBoundary: true,
      bearerTokens: ["existing-bearer-fixture"], allowedHosts: "configured.example.test",
      hostName: () => "daemon-fixture", discoverSelfNames: async () => ["daemon-fixture.ts.net"] }));
    native.get("/", c => c.json({ admitted: true }));
    const send = (headers: Record<string, string>) => native.request("http://localhost/", { headers });
    for (const host of ["127.0.0.1:80", "daemon-fixture", "configured.example.test", "daemon-fixture.ts.net"])
      expect((await send({ Host: host })).status).toBe(200);
    expect((await send({ Host: "unknown.example.test", Authorization: "Bearer existing-bearer-fixture" })).status).toBe(200);
    expect((await send({ Host: "unknown.example.test", Authorization: "Bearer invalid-token" })).status).toBe(403);
    expect((await send({ Host: "", Authorization: "Bearer existing-bearer-fixture" })).status).toBe(403);
    expect((await send({ Host: "localhost", Authorization: "Bearer existing-bearer-fixture",
      Connection: "Upgrade", Upgrade: "websocket" })).status).toBe(200);
    expect((await send({ Host: "configured.example.test", Origin: "http://configured.example.test",
      Authorization: "Bearer existing-bearer-fixture" })).status).toBe(403);
  });

  it("invalidates cookie sessions on owner revocation, rotation or credential role collision", async () => {
    const paired = await pair();
    options.credentials.ownerToken = null;
    expect((await request("/api/team-control/health", "GET", browserHeaders(paired))).status).toBe(401);
    options.credentials.ownerToken = "rotated-owner-fixture";
    expect((await request("/api/team-control/health", "GET", browserHeaders(paired))).status).toBe(401);
    options.credentials.ownerToken = "worker-pairing-fixture";
    expect((await request("/api/team-control/health", "GET", browserHeaders(paired))).status).toBe(503);
    expect((await request("/api/team-control/health", "GET", { Authorization: "Bearer worker-pairing-fixture" })).status).toBe(503);
  });

  it("denies workers minting, listing and revoking browser credentials", async () => {
    const paired = await pair();
    for (const [path, method] of [["pairing", "POST"], ["sessions", "GET"], [`sessions/${paired.session.id}`, "DELETE"]])
      expect((await request(`/api/team-control/owner-session/${path}`, method, { Authorization: "Bearer worker-pairing-fixture" })).status).toBe(403);
    expect(sessions.list()[0]!.revoked_at).toBeNull();
  });

  it("rejects remote Host and Origin exceptions even with a valid cookie", async () => {
    const paired = await pair();
    vi.stubEnv("OPENRIG_ALLOWED_HOSTS", "remote.example");
    vi.stubEnv("OPENRIG_ALLOWED_ORIGINS", "http://remote.example");
    for (const headers of [{ Host: "remote.example" }, { Origin: "http://remote.example" }, { Origin: "null" },
      { Origin: "http://localhost:9999" }, { "Sec-Fetch-Site": "cross-site" }])
      expect((await request("/api/team-control/health", "GET", { ...browserHeaders(paired), ...headers })).status).toBe(403);
    const remote = await app.request("http://localhost/api/team-control/health", { headers: { Host: "localhost", ...browserHeaders(paired) } },
      { incoming: { socket: { remoteAddress: "192.0.2.1" } } });
    expect(remote.status).toBe(403);
  });

  it("rejects query credentials without leaking them to logs, responses or events", async () => {
    const warn = vi.spyOn(console, "warn"), log = vi.spyOn(console, "log"), error = vi.spyOn(console, "error");
    const eventsBefore = db.prepare("SELECT * FROM events ORDER BY rowid").all();
    const paired = await pair();
    const credentials = [paired.cookie.split("=")[1], paired.code, paired.antiForgeryToken, "owner-pairing-fixture"];
    for (const [key, value] of [["token", credentials[0]], ["code", paired.code], ["csrf", paired.antiForgeryToken]]) {
      const response = await request(`/api/team-control/health?${key}=${value}`, "GET", browserHeaders(paired));
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(value);
    }
    const valid = await request("/api/team-control/health", "GET", browserHeaders(paired));
    expect(valid.status).toBe(200);
    const output = await valid.text();
    for (const credential of credentials) {
      expect(output).not.toContain(credential);
      for (const channel of [warn, log, error]) expect(JSON.stringify(channel.mock.calls)).not.toContain(credential);
    }
    expect(db.prepare("SELECT * FROM events ORDER BY rowid").all()).toEqual(eventsBefore);
  });

  it("keeps the UI off and rejects a non-loopback production bind plan", () => {
    expect(() => createTestApp(db, { appDeps: { teamControl: options, bindPlan: {
      mode: "explicit", hosts: ["0.0.0.0"], tailscaleDetected: false,
    } } })).toThrow(/loopback-only/);
  });


  it("accepts same-origin browser GET metadata without an Origin header but rejects missing-Origin mutations", async () => {
    const paired = await pair();
    const headers = { Cookie: paired.cookie, [OWNER_CSRF_HEADER]: paired.antiForgeryToken, "Sec-Fetch-Site": "same-origin" };
    expect((await request("/api/team-control/health", "GET", headers)).status).toBe(200);
    expect((await request("/api/team-control/runs/absent/cancel", "POST", headers, {})).status).toBe(403);
    expect((await request("/api/team-control/health", "GET", { ...headers, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await request("/api/team-control/health", "GET", { Cookie: paired.cookie, [OWNER_CSRF_HEADER]: paired.antiForgeryToken })).status).toBe(403);
  });


  it("checks anti-forgery and duplicate headers through a genuine Node WebSocket handshake", async () => {
    const upgradeApp = new Hono();
    upgradeApp.use("/api/*", async (c, next) => { c.set("ownerSessions" as never, sessions); await next(); });
    upgradeApp.use("/api/*", browserBoundary({ webUiEnabled: false, pairedOwnerBoundary: true, bearerTokens: [],
      authenticateOwnerCookie: c => {
        const resolved = resolvePairedOwnerCookie(c, options.credentials);
        return resolved.ok ? null : c.json({ code: resolved.code }, resolved.status);
      } }));
    upgradeApp.use("/api/*", teamControlAuthentication(() => options.credentials));
    const upgrade = createNodeWebSocket({ app: upgradeApp });
    let accepted = 0;
    upgradeApp.get("/api/team-control/ws-check", upgrade.upgradeWebSocket(() => ({ onOpen: () => { accepted++; } })));
    const listener = serve({ fetch: upgradeApp.fetch, port: 0, hostname: "127.0.0.1" });
    upgrade.injectWebSocket(listener);
    await new Promise<void>(resolve => listener.on("listening", resolve));
    const port = (listener.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const paired = sessions.exchange(sessions.mint("owner-pairing-fixture").code, origin, "owner-pairing-fixture")!;
    const cookie = `${OWNER_COOKIE}=${paired.token}`;
    const raw = (headers: string[]) => new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write([
        "GET /api/team-control/ws-check HTTP/1.1", `Host: 127.0.0.1:${port}`, `Origin: ${origin}`,
        "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${Buffer.from("t013-ws-key-1234").toString("base64")}`, ...headers, "", ""].join("\r\n")));
      let text = "";
      socket.on("data", bytes => { text += bytes; if (text.includes("\r\n")) socket.destroy(); });
      socket.on("close", () => resolve(text.split("\r\n")[0]!));
      socket.on("error", reject); socket.setTimeout(2000, () => socket.destroy());
    });
    try {
      expect(await raw([`Cookie: ${cookie}`])).toContain("403");
      expect(await raw([`Cookie: ${cookie}`, "Sec-WebSocket-Protocol: multi-agent-csrf.invalid"])).toContain("403");
      expect(accepted).toBe(0);
      expect(await raw([`Cookie: ${cookie}`, `Sec-WebSocket-Protocol: multi-agent-csrf.${paired.antiForgeryToken}`])).toContain("101");
      expect(accepted).toBe(1);
      expect(await raw([`Cookie: ${cookie}`, `Sec-WebSocket-Protocol: multi-agent-csrf.${paired.antiForgeryToken}, multi-agent-csrf.${paired.antiForgeryToken}`])).toContain("403");
      expect(await raw([`Cookie: ${cookie}`, `Cookie: ${cookie}`, `${OWNER_CSRF_HEADER}: ${paired.antiForgeryToken}`])).toContain("401");
      expect(await raw([`Cookie: ${cookie}`, `${OWNER_CSRF_HEADER}: ${paired.antiForgeryToken}`, `${OWNER_CSRF_HEADER}: ${paired.antiForgeryToken}`])).toContain("403");
      expect(accepted).toBe(1);
      // This uses the production Node upgrade adapter and T013 boundary. Terminal takeover remains T014.
    } finally {
      for (const client of upgrade.wss.clients) client.terminate();
      await new Promise<void>(resolve => upgrade.wss.close(() => resolve()));
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  });

  it("keeps an explicit invalid bearer from falling back to a cookie at the shared middleware", async () => {
    const paired = await pair(), lookup = vi.spyOn(sessions, "authenticate");
    const control = new Hono();
    control.use("*", async (c, next) => {
      c.set("ownerSessions" as never, sessions); c.set("ownerBrowserOrigin" as never, "http://localhost");
      c.set("ownerCookieHeader" as never, paired.cookie); c.set("ownerAntiForgery" as never, paired.antiForgeryToken);
      await next();
    });
    control.use("*", teamControlAuthentication(() => options.credentials));
    control.get("/", c => c.json({ actor: c.get("controlActor" as never) }));
    const send = (authorization?: string) => control.request("http://localhost/", { headers: { Cookie: paired.cookie,
      ...(authorization === undefined ? {} : { Authorization: authorization }) } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect((await send("Bearer invalid")).status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    const bearer = await send("Bearer owner-pairing-fixture");
    expect(await bearer.json()).toMatchObject({ actor: { kind: "owner", sessionId: "owner-control" } });
    expect(lookup).not.toHaveBeenCalled();
    const cookie = await send();
    expect(await cookie.json()).toMatchObject({ actor: { kind: "owner", sessionId: paired.session.id } });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

});
