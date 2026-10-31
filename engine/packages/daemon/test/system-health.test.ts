import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";
import { attemptsFromManagedWorkerEvidence, createSystemHealthReader, readSystemHealth, readSystemHealthBounded,
  SYSTEM_HEALTH_TOTAL_TIMEOUT_MS } from "../src/domain/system-health.js";

const ok = (evidenceRef: string) => ({ state: "ok" as const, evidenceRef });
const failed = (reason: string) => ({ state: "failed" as const, reason });

describe("KTD26 system health", () => {
  it("maps one fixture fault to each matching light", async () => {
    const health = await readSystemHealth({
      database: () => ok("db"), queueMailbox: () => ok("queue"),
      controlTmux: () => failed("tmux_socket_missing"), workerBoundary: () => ok("worker"),
      sandboxNetwork: () => ok("network"), clients: () => failed("client_lock_mismatch"),
      latestAttempts: () => ({ attempt: {
        attemptId: "attempt", runId: "run", worker: "ma-worker1", client: "codex", state: "unknown",
        reasonCode: "agent_error.unknown", resumeSafe: false, checkedAt: "2026-10-23T00:00:00.000Z", evidenceRef: "attempt-evidence",
      }}), now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    expect(health.lights.controlTmux).toMatchObject({ state: "failed", reason: "tmux_socket_missing" });
    expect(health.lights.clients).toMatchObject({ state: "failed", reason: "client_lock_mismatch" });
    expect(health.lights.database.state).toBe("ok");
    expect(health.overall).toBe("failed");
    expect(health.latestAttempts.attempt.reasonCode).toBe("agent_error.unknown");
  });
  it("returns unknown on a hung probe within the configured timeout", async () => {
    const health = await readSystemHealth({ database: () => new Promise(() => undefined), timeoutMs: 15,
      now: () => new Date("2026-10-23T00:00:00.000Z") });
    expect(health.lights.database).toMatchObject({ state: "unknown", reason: "probe_timeout" });
    expect(health.overall).toBe("unknown");
  });
  it("signals cancellation when a read exceeds its bound", async () => {
    let signal: AbortSignal | undefined;
    const health = await readSystemHealth({
      database: observed => { signal = observed; return new Promise(() => undefined); },
      timeoutMs: 15,
    });
    expect(signal?.aborted).toBe(true);
    expect(health.lights.database).toMatchObject({ state: "unknown", reason: "probe_timeout" });
  });
  it.each([null, undefined, { state: "invalid" }])("keeps malformed probe results unknown: %j", async value => {
    const health = await readSystemHealth({ database: () => value as never });
    expect(health.lights.database).toMatchObject({ state: "unknown", reason: "probe_invalid_result" });
    expect(health.overall).toBe("unknown");
  });
  it("contains a thrown probe error in its matching light", async () => {
    const health = await readSystemHealth({
      database: () => { throw new Error("fixture fault"); },
      queueMailbox: () => ok("queue"),
    });
    expect(health.lights.database).toMatchObject({ state: "failed", reason: "probe_failed" });
    expect(health.lights.queueMailbox.state).toBe("ok");
  });
  it("keeps the aggregate unknown when attempt evidence times out", async () => {
    const health = await readSystemHealth({
      database: () => ok("db"), queueMailbox: () => ok("queue"), controlTmux: () => ok("tmux"),
      workerBoundary: () => ok("worker"), sandboxNetwork: () => ok("network"), clients: () => ok("clients"),
      latestAttempts: () => new Promise(() => undefined), timeoutMs: 15,
    });
    expect(Object.values(health.lights).every(light => light.state === "ok")).toBe(true);
    expect(health.overall).toBe("unknown");
    expect(health.latestAttempts).toEqual({});
  });
  it("preserves a stopped state in the managed evidence projection", () => {
    const health = attemptsFromManagedWorkerEvidence(() => new Date("2026-10-23T00:00:00.000Z"), {
      observedAt: "2026-10-23T00:00:00.000Z",
      attempts: [{ attemptId: "stopped", runId: "run", worker: "ma-worker1", client: "codex",
        state: "stopped", provider: "signed_in", policyRevision: 1, policyFingerprint: "policy",
        clientVersion: "locked", clientLockDigest: "lock", networkMode: "filtered-proxy",
        networkProfileFingerprint: "network", evidenceRef: "preflight" }],
    });
    expect(health.stopped.state).toBe("stopped");
  });
  it("returns unknown when an aggregate reader supplies a malformed result", async () => {
    const health = await readSystemHealthBounded(() => null as never);
    expect(health.overall).toBe("unknown");
    expect(health.lights.database.reason).toBe("health_invalid_result");
  });
  it("bounds a hanging owner route reader at the whole-check limit", async () => {
    const db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const { app } = createTestApp(db, { appDeps: {
      teamControl: { credentials: { ownerToken: "owner-health" },
        readSystemHealth: () => new Promise(() => undefined) },
    }});
    vi.useFakeTimers();
    try {
      const pending = app.request("http://localhost/api/team-control/health",
        { headers: { Authorization: "Bearer owner-health", Host: "localhost" } },
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
      await vi.advanceTimersByTimeAsync(SYSTEM_HEALTH_TOTAL_TIMEOUT_MS);
      const response = await pending;
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.health.overall).toBe("unknown");
      expect(Object.values(body.health.lights).every((light: any) =>
        light.state === "unknown" && light.reason === "health_timeout")).toBe(true);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });
  it("does not mutate the database while reading a health result", async () => {
    const db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const before = db.prepare("SELECT name, applied_at FROM schema_migrations ORDER BY name").all();
    const health = await readSystemHealth({
      database: () => ok("database-read-only"), queueMailbox: () => ok("queue-read-only"),
      controlTmux: () => ok("tmux-read-only"), workerBoundary: () => ok("worker-read-only"),
      sandboxNetwork: () => ok("network-read-only"), clients: () => ok("clients-read-only"),
    });
    const after = db.prepare("SELECT name, applied_at FROM schema_migrations ORDER BY name").all();
    expect(after).toEqual(before);
    expect(health.lights.database.evidenceRef).toBe("database-read-only");
    db.close();
  });
  it("publishes the isolation level the daemon resolved, and nothing when it composed none", async () => {
    const sources = {
      database: () => ok("db"), queueMailbox: () => ok("queue"), controlTmux: () => ok("tmux"),
      workerBoundary: () => ok("worker"), sandboxNetwork: () => ok("network"), clients: () => ok("clients"),
    };
    // The level is a fact the process decided, so a client reads it from the daemon rather than
    // from a config file the daemon may have overridden at startup.
    expect((await readSystemHealth({ ...sources, isolation: "none" })).runtime).toEqual({ isolation: "none" });
    expect((await readSystemHealth({ ...sources, isolation: "hardened" })).runtime).toEqual({ isolation: "hardened" });
    // A host that composes no runtime block says nothing rather than naming a default.
    expect((await readSystemHealth(sources)).runtime).toBeUndefined();
    expect((await readSystemHealthBounded(undefined)).runtime).toBeUndefined();
  });
  it("rejects a runtime block naming a level the launch chain cannot have", async () => {
    const sources = { database: () => ok("db"), queueMailbox: () => ok("queue"), controlTmux: () => ok("tmux"),
      workerBoundary: () => ok("worker"), sandboxNetwork: () => ok("network"), clients: () => ok("clients") };
    const invalid = { ...(await readSystemHealth(sources)), runtime: { isolation: "chroot" } };
    expect((await readSystemHealthBounded(() => invalid as never)).lights.database.reason).toBe("health_invalid_result");
  });
  it("exposes only the owner-authenticated query", async () => {
    const db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const readHealth = vi.fn(createSystemHealthReader({
      database: () => ok("db"), queueMailbox: () => ok("queue"), controlTmux: () => ok("tmux"),
      workerBoundary: () => ok("worker"), sandboxNetwork: () => ok("network"), clients: () => ok("clients"),
    }));
    const { app } = createTestApp(db, { appDeps: {
      teamControl: { credentials: { ownerToken: "owner-health", workers: [{ token: "agent-health", sessionId: "worker@rig", runId: "run" }] },
        readSystemHealth: readHealth },
    }});
    const owner = await app.request("http://localhost/api/team-control/health",
      { headers: { Authorization: "Bearer owner-health", Host: "localhost" } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(owner.status).toBe(200);
    expect((await owner.json()).health.lights.database.state).toBe("ok");
    const agent = await app.request("http://localhost/api/team-control/health",
      { headers: { Authorization: "Bearer agent-health", Host: "localhost" } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(agent.status).toBe(403);
    expect(readHealth).toHaveBeenCalledTimes(1);
    db.close();
  });
});
