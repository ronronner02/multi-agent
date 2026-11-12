import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { OwnerSessions, OWNER_COOKIE, OWNER_CSRF_HEADER, PAIRING_TTL_MS } from "../src/domain/owner-session.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { replyToMintPairing } from "../src/index.js";
import { createTestApp } from "./helpers/test-app.js";

/**
 * U6 — native pairing. The desktop mints a one-time code over the daemon's private parent
 * port (never over HTTP, never with an owner token in Electron), then exchanges it like a
 * browser would. These tests drive the same pieces the desktop uses: the parent-port mint
 * and the existing HTTP exchange route.
 */
describe("U6 native pairing over the private parent port", () => {
  const OWNER = "owner-native-fixture";
  let db: ReturnType<typeof createDb>;
  let sessions: OwnerSessions;
  let app: ReturnType<typeof createTestApp>["app"];
  let at: number;
  let sent: Array<Record<string, unknown>>;

  // The daemon's parent-port port, as Electron's utilityProcess delivers it.
  const port = { postMessage: (message: unknown) => { sent.push(message as Record<string, unknown>); } };

  const request = (path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) =>
    app.request(`http://localhost${path}`, { method, headers: { Host: "localhost", "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  const mint = (): string => {
    sent = [];
    replyToMintPairing(sessions, OWNER, port);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("pairing-code");
    return sent[0]!.code as string;
  };

  beforeEach(() => {
    db = createDb(); initializeDatabase(db); fixDaemonMode(db, true);
    at = 1_700_000_000_000;
    sessions = new OwnerSessions(db, () => at);
    app = createTestApp(db, { appDeps: { teamControl: { credentials: { ownerToken: OWNER } }, ownerSessions: sessions } }).app;
    sent = [];
  });
  afterEach(() => { db.close(); });

  it("mints a formatted one-time code that the same-origin exchange accepts exactly once", async () => {
    const code = mint();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const exchanged = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code });
    expect(exchanged.status).toBe(200);
    const { antiForgeryToken } = await exchanged.json();
    const cookie = exchanged.headers.get("Set-Cookie")!.split(";")[0]!;

    // The code is consumed: a browser that replays it is refused.
    const replay = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ code: "owner_pairing_required" });

    // The paired cookie plus anti-forgery token reach the control surface; the cookie alone does not.
    expect((await request("/api/team-control/health", "GET",
      { Origin: "http://localhost", Cookie: cookie, [OWNER_CSRF_HEADER]: antiForgeryToken })).status).toBe(200);
    expect((await request("/api/team-control/health", "GET", { Origin: "http://localhost", Cookie: cookie })).status).toBe(403);
  });

  it("sets an HttpOnly, SameSite=Strict, path-scoped cookie and stores only hashes", async () => {
    const code = mint();
    const exchanged = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code });
    const setCookie = exchanged.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/api");
    expect(setCookie).not.toMatch(/Domain=/i);
    const { antiForgeryToken } = await exchanged.json();
    const raw = JSON.stringify({ codes: db.prepare("SELECT * FROM owner_pairing_codes").all(),
      sessions: db.prepare("SELECT * FROM owner_sessions").all() });
    for (const secret of [code, setCookie.split(";")[0]!.split("=")[1], antiForgeryToken, OWNER]) expect(raw).not.toContain(secret);
  });

  it("rejects an expired code at the pairing TTL boundary without creating a session", async () => {
    const code = mint();
    at += PAIRING_TTL_MS;
    const exchanged = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code });
    expect(exchanged.status).toBe(401);
    expect(sessions.list()).toEqual([]);
  });

  it.each([
    ["wrong Origin", { Origin: "http://evil.example" }],
    ["cross-site fetch", { Origin: "http://localhost", "Sec-Fetch-Site": "cross-site" }],
    ["query credential", {}],
  ])("rejects a %s even with a freshly minted code", async (kind, headers) => {
    const code = mint();
    // A credential smuggled in the query string is refused before the code is read.
    const path = kind === "query credential" ? `/api/team-control/owner-session/exchange?code=${code}` : "/api/team-control/owner-session/exchange";
    const response = await request(path, "POST", { Origin: "http://localhost", ...headers }, { code });
    expect(response.ok).toBe(false);
    expect((await response.text())).not.toContain(code);
  });

  it("rejects a replayed cookie without the anti-forgery header on a mutation", async () => {
    const code = mint();
    const exchanged = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code });
    const cookie = exchanged.headers.get("Set-Cookie")!.split(";")[0]!;
    const before = db.prepare("SELECT count(*) AS count FROM team_control_requests").get();
    const refused = await request("/api/team-control/runs/absent/cancel", "POST", { Origin: "http://localhost", Cookie: cookie }, {});
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "owner_anti_forgery_required" });
    expect(db.prepare("SELECT count(*) AS count FROM team_control_requests").get()).toEqual(before);
  });

  it("renewal mints a second, independent session and revocation disconnects the first", async () => {
    const first = mint();
    const firstExchange = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code: first });
    const firstCookie = firstExchange.headers.get("Set-Cookie")!.split(";")[0]!;
    const firstToken = (await firstExchange.json()).antiForgeryToken as string;

    // Renewal is the same mint-and-exchange: a fresh code yields a new independent session.
    const second = mint();
    const secondExchange = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code: second });
    expect(secondExchange.status).toBe(200);
    const secondCookie = secondExchange.headers.get("Set-Cookie")!.split(";")[0]!;
    const secondToken = (await secondExchange.json()).antiForgeryToken as string;
    expect(secondCookie).not.toBe(firstCookie);
    expect((await request("/api/team-control/health", "GET",
      { Origin: "http://localhost", Cookie: firstCookie, [OWNER_CSRF_HEADER]: firstToken })).status).toBe(200);

    // Revoking the first session disconnects it while the renewed one keeps working.
    expect((await request("/api/team-control/owner-session", "DELETE",
      { Origin: "http://localhost", Cookie: firstCookie, [OWNER_CSRF_HEADER]: firstToken })).status).toBe(200);
    expect((await request("/api/team-control/health", "GET",
      { Origin: "http://localhost", Cookie: firstCookie, [OWNER_CSRF_HEADER]: firstToken })).status).toBe(401);
    expect((await request("/api/team-control/health", "GET",
      { Origin: "http://localhost", Cookie: secondCookie, [OWNER_CSRF_HEADER]: secondToken })).status).toBe(200);
  });

  it("answers a mint error instead of a code when the session store or owner identity is missing", () => {
    sent = [];
    replyToMintPairing(undefined, OWNER, port);
    expect(sent).toEqual([{ type: "pairing-error", error: "owner_session_unavailable" }]);
    sent = [];
    replyToMintPairing(sessions, null, port);
    expect(sent).toEqual([{ type: "pairing-error", error: "owner_session_unavailable" }]);
  });

  it("keeps the raw code, cookie and anti-forgery token out of every log line", async () => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const code = mint();
      const exchanged = await request("/api/team-control/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code });
      const { antiForgeryToken } = await exchanged.json();
      const cookie = exchanged.headers.get("Set-Cookie")!.split(";")[0]!.split("=")[1]!;
      const blob = lines.join("\n");
      for (const secret of [code, cookie, antiForgeryToken]) expect(blob).not.toContain(secret);
    } finally {
      console.log = original.log; console.warn = original.warn; console.error = original.error;
    }
  });
});