import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { OwnerSessions, OWNER_CSRF_HEADER } from "../src/domain/owner-session.js";
import { createTestApp } from "./helpers/test-app.js";

describe("owner team settings", () => {
  let directory: string, db: Database.Database, store: SettingsStore;
  let app: ReturnType<typeof createTestApp>["app"];
  const ownerToken = "owner-settings-fixture";
  const request = (method = "GET", body?: unknown, token: string | null = ownerToken, peer = "127.0.0.1") =>
    app.request("/api/team-control/settings", { method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { incoming: { socket: { remoteAddress: peer } } });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "team-settings-"));
    store = new SettingsStore(join(directory, "config.json"));
    store.set("daemon.port", "7433");
    db = createDb(); migrate(db, ALL_MIGRATIONS); fixDaemonMode(db, true);
    app = createTestApp(db, { appDeps: { settingsStore: store, ownerSessions: new OwnerSessions(db),
      teamControl: { credentials: { ownerToken, workers: [
        { token: "worker-settings-fixture", sessionId: "dev@fixture", runId: "other" },
      ] } },
    } }).app;
  });
  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("reads only registered team preferences with their effective sources", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ protocolVersion: "1.0", settings: {
      "team.leadClient": { value: "claude-code", source: "default", defaultValue: "claude-code" },
      "team.maxSeats": { value: 6, source: "default", defaultValue: 6 },
      "team.maxConcurrentAgents": { value: 3, source: "default", defaultValue: 3 },
    } });
  });

  it("persists a default lead without changing other settings", async () => {
    const response = await request("PUT", { key: "team.leadClient", value: "codex" });
    expect(response.status).toBe(200);
    expect((await response.json()).settings["team.leadClient"]).toMatchObject({ value: "codex", source: "file" });
    expect(new SettingsStore(store.configPath).resolveOne("team.leadClient").value).toBe("codex");
    expect(store.resolveOne("daemon.port").value).toBe(7433);
  });

  it("persists through the paired browser boundary only with same-origin anti-forgery credentials", async () => {
    const browserRequest = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
      app.request("http://localhost/api/team-control" + path, { method,
        headers: { Host: "localhost", "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    const minted = await browserRequest("/owner-session/pairing", "POST", { Authorization: "Bearer " + ownerToken });
    expect(minted.status).toBe(200);
    const { code } = await minted.json();
    const exchanged = await browserRequest("/owner-session/exchange", "POST", { Origin: "http://localhost" }, { code });
    expect(exchanged.status).toBe(200);
    const cookie = exchanged.headers.get("Set-Cookie")!.split(";")[0]!;
    const { antiForgeryToken } = await exchanged.json();
    const headers = { Origin: "http://localhost", Cookie: cookie, [OWNER_CSRF_HEADER]: antiForgeryToken };
    const input = { key: "team.leadClient", value: "codex" };
    const before = readFileSync(store.configPath, "utf8");
    expect((await browserRequest("/settings", "PUT", { Origin: "http://localhost", Cookie: cookie }, input)).status).toBe(403);
    expect((await browserRequest("/settings", "PUT", { ...headers, Origin: "http://other.localhost" }, input)).status).toBe(403);
    expect(readFileSync(store.configPath, "utf8")).toBe(before);
    expect((await browserRequest("/settings", "PUT", headers, input)).status).toBe(200);
    const result = await browserRequest("/settings", "GET", headers);
    expect((await result.json()).settings["team.leadClient"]).toMatchObject({ value: "codex", source: "file" });
    expect(new SettingsStore(store.configPath).resolveOne("team.leadClient").value).toBe("codex");
  });

  it.each([["team.maxSeats", "8", 8], ["team.maxConcurrentAgents", "2", 2]])(
    "uses the existing constraint and persistence for %s", async (key, value, expected) => {
      expect((await request("PUT", { key, value })).status).toBe(200);
      expect((await (await request()).json()).settings[key].value).toBe(expected);
    });

  it.each([
    { key: "daemon.port", value: "8000" }, { key: "team.unknown", value: "x" },
    { key: "team.leadClient", value: "other" }, { key: "team.maxSeats", value: "0" },
    { key: "team.maxConcurrentAgents", value: "4" }, { key: "team.maxConcurrentAgents", value: "1.5" },
    { key: "team.leadClient", value: {} }, { key: "team.leadClient", value: "codex", extra: true },
  ])("rejects invalid input without modifying the file: %j", async body => {
    const before = readFileSync(store.configPath, "utf8");
    expect((await request("PUT", body)).status).toBe(400);
    expect(readFileSync(store.configPath, "utf8")).toBe(before);
  });

  it("denies worker, unpaired and non-loopback access before reading or writing settings", async () => {
    const before = readFileSync(store.configPath, "utf8");
    for (const method of ["GET", "PUT"]) {
      const body = method === "PUT" ? { key: "team.leadClient", value: "codex" } : undefined;
      expect((await request(method, body, "worker-settings-fixture")).status).toBe(403);
      expect((await request(method, body, null)).status).toBe(401);
      expect((await request(method, body, ownerToken, "203.0.113.9")).status).toBe(403);
    }
    expect(readFileSync(store.configPath, "utf8")).toBe(before);
  });
});
