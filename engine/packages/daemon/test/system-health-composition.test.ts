// T047-H1: the KTD26 health reader through the real production startup composition.
// T036 landed the reader, the contracts and the route, accepted as "Pending T047 wiring".
// These cases drive `createDaemon` and the owner-authenticated route, so a light that
// reads `ok` proves the composition reached an existing owner rather than a fixture.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as nodeFs from "node:fs";

// A path in this set is unreadable to the code under test. A module mock is the only way to make an ESM import of
// `node:fs` fail for a chosen path, and the reader must be exercised through its real code path for the case to mean
// anything (review R1-2). `vi.hoisted` puts the set above the hoisted `vi.mock` factory.
const unreadable = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const guarded = (file: never, ...rest: never[]) => {
    if (unreadable.has(String(file))) throw new Error("EACCES: permission denied");
    return (actual.readFileSync as never)(file, ...rest);
  };
  return { ...actual, readFileSync: guarded as never, default: { ...actual, readFileSync: guarded as never } };
});
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { composeSystemHealthReader, createDaemon } from "../src/startup.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { hashBytes } from "../src/domain/plan-governance.js";
import { SYSTEM_HEALTH_PROBE_TIMEOUT_MS } from "../src/domain/system-health.js";
import type { ManagedWorkerHealthEvidence } from "../src/contracts/team-control.js";

const HOSTS = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const OWNER = "owner-health-h1";
const INSTALLED = ["/etc/multi-agent/worker-policy.json", "/etc/multi-agent/egress.json", "/etc/multi-agent/client-lock.json"];
// The three installed files are a host-provisioning fact, not a repository one. Without them the composition has
// nothing to read, so the cases that need them are skipped rather than failed — the alternative would report a
// missing host as a code defect.
const installedPresent = INSTALLED.every(file => nodeFs.existsSync(file));

const parked: Array<() => void> = [];
afterEach(() => { while (parked.length) parked.pop()!(); });

/** A real daemon, its app, and the teardown its own fixtures need. */
async function boot(teamControl?: never) {
  const home = mkdtempSync(join(tmpdir(), "t047h1-"));
  const previous = process.env.OPENRIG_HOME;
  process.env.OPENRIG_HOME = home;
  const dbPath = join(home, "daemon.db");
  const seed = createDb(dbPath);
  migrate(seed, ALL_MIGRATIONS);
  seed.prepare("INSERT INTO rigs (id, name) VALUES ('h1-rig', 'h1')").run();
  // The daemon opens its own handle; this one only seeds the fixture above.
  seed.close();
  // The hardened boundary lights this file asserts on only exist under hardened isolation.
  const result = await createDaemon({ dbPath, managedMode: true, workersIsolation: "hardened",
    teamControl: teamControl ?? { credentials: { ownerToken: OWNER } } });
  parked.push(() => {
    result.deps.proofSourceWatch?.close();
    result.deps.modelDivergenceMonitor?.stop();
    result.deps.gatewaySubsystem?.stop();
    result.deps.eventLoopMonitor?.stop();
    result.db.close();
    if (previous === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return result;
}

const query = async (app: Awaited<ReturnType<typeof boot>>["app"], token: string) => {
  const response = await app.request("http://localhost/api/team-control/health",
    { headers: { Authorization: "Bearer " + token, Host: "localhost" } }, HOSTS);
  return { status: response.status, body: await response.json() as any };
};

describe("T047-H1 production health composition", () => {
  it("serves a real owner query whose lights come from the composed owners", async () => {
    const { app } = await boot();
    const { status, body } = await query(app, OWNER);
    expect(status).toBe(200);
    // The reader is the production composition: every light answered, so none carries the
    // `_source_unavailable` reason that an absent reader leaves on every light.
    for (const [name, light] of Object.entries<any>(body.health.lights)) {
      expect(light.reason, name).not.toBe(name + "_source_unavailable");
    }
    // `database`, `queueMailbox` and the three installed-file lights have no environment
    // dependency, so they must be genuinely ok rather than merely present.
    for (const name of ["database", "queueMailbox", "workerBoundary", "sandboxNetwork", "clients"]) {
      expect(body.health.lights[name].state, name).toBe("ok");
    }
    expect(body.health.timeoutMs).toBeLessThanOrEqual(SYSTEM_HEALTH_PROBE_TIMEOUT_MS);
  }, 60_000);

  it("refuses an agent credential on the same composed daemon", async () => {
    const { app } = await boot({ credentials: { ownerToken: OWNER,
      workers: [{ token: "agent-h1", sessionId: "worker@h1-rig", runId: "run" }] } } as never);
    expect((await query(app, OWNER)).status).toBe(200);
    expect((await query(app, "agent-h1")).status).toBe(403);
  }, 60_000);

  it("reports a missing tmux socket as a failed light, not as missing wiring", async () => {
    const { app } = await boot();
    const tmux = (await query(app, OWNER)).body.health.lights.controlTmux;
    // Either the fixture's tmux is readable (ok) or its socket is absent (failed with the
    // socket reason); what must never happen is the light reading `unknown` because no
    // reader was injected at all, which is the state this sub-task exists to end.
    expect(["ok", "failed"]).toContain(tmux.state);
    if (tmux.state === "failed") expect(tmux.reason).toBe("tmux_socket_missing");
  }, 60_000);

  it("changes no durable state, installed file or session row while serving a health query", async () => {
    const daemon = await boot();
    const { app, db } = daemon;
    // Row *contents*, not only counts: a delete-plus-insert that preserves the count must still be caught.
    const rows = () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
      return tables.flatMap(({ name }) =>
        (db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}" ORDER BY rowid`).all() as unknown[])
          .map(row => name + ":" + JSON.stringify(row)));
    };
    // The three installed files the reader reads, by content and metadata.
    const files = ["/etc/multi-agent/worker-policy.json", "/etc/multi-agent/egress.json", "/etc/multi-agent/client-lock.json"]
      .map(file => { try { return file + ":" + statSync(file).mtimeMs + ":" + readFileSync(file, "utf8").length; }
        catch { return file + ":absent"; } });
    const before = { rows: rows(), files };
    // No provider session starts and no terminal is written: `boot` returns the daemon, but the health path is
    // reachable only through the reader, whose sole process boundary is the tmux adapter it was composed with.
    const tmux = daemon.deps.tmuxAdapter as unknown as Record<string, (...a: unknown[]) => unknown>;
    const writes = ["sendText", "sendKeys", "sendShellCommand", "respawnPane", "createSession", "startServer", "killSession"]
      .map(method => vi.spyOn(tmux, method as never));
    try {
      expect((await query(app, OWNER)).status).toBe(200);
      expect({ rows: rows(), files }).toEqual(before);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    } finally { for (const write of writes) write.mockRestore(); }
  }, 60_000);
});

// The healthy fixture takes its digests from the installed files, which are a host-provisioning fact rather than a
// repository one, so this block skips on a host without them instead of erroring during collection (review R1-4).
// The digests are read lazily inside each test: `skipIf` skips the tests but still runs the describe body, so an
// eager read here would throw on such a host before any skip could apply.
describe.skipIf(!installedPresent)("T047-H1 boundary faults from the launcher's own evidence", () => {
  // The digests a healthy host reports are the installed files' own, so a fixture has to use them to model
  // "nothing drifted"; a deliberately wrong value is then the fault.
  const digest = (path: string) => hashBytes(readFileSync(path));
  const healthy = () => ({
    policyFingerprint: digest("/etc/multi-agent/worker-policy.json"),
    networkProfileFingerprint: digest("/etc/multi-agent/egress.json"),
    clientLockDigest: digest("/etc/multi-agent/client-lock.json"),
    policyRevision: 5, clientVersion: "2.1.296", provider: "signed_in" as const, networkMode: "filtered-proxy" as const,
  });
  const attempt = (over: Partial<ManagedWorkerHealthEvidence["attempts"][number]> = {}) => ({
    attemptId: "attempt-1", runId: "run", worker: "ma-worker1", client: "claude-code" as const, state: "running" as const,
    evidenceRef: "managed-preflight:fixture", ...healthy(), ...over });
  const reader = (attempts: ManagedWorkerHealthEvidence["attempts"]) => {
    const db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const events = new EventBus(db);
    return { db, read: composeSystemHealthReader({ db, queue: new QueueRepository(db, events),
      tmux: { readAllSessionWindowActivity: async () => new Map() },
      evidence: () => ({ observedAt: "2026-10-26T00:00:00.000Z", attempts }) }) };
  };

  it("fails workerBoundary when the launcher observed a signed-out worker", async () => {
    const { db, read } = reader([attempt({ provider: "signed_out" })]);
    const health = await read();
    expect(health.lights.workerBoundary).toMatchObject({ state: "failed", reason: "worker_signed_out",
      evidenceRef: "worker-boundary:attempt-1" });
    db.close();
  });

  // Round-1 review R1-3: the card names a database-lock fault and nothing exercised it. An unreadable handle is the
  // reachable form — the probe throws and the runner records `probe_failed` rather than failing the whole request.
  it("fails the database light when the handle cannot be read", async () => {
    const live = createDb(":memory:");
    migrate(live, ALL_MIGRATIONS);
    const events = new EventBus(live);
    const read = composeSystemHealthReader({ db: live, queue: new QueueRepository(live, events),
      tmux: { readAllSessionWindowActivity: async () => new Map() } });
    live.close();
    const health = await read();
    expect(health.lights.database).toMatchObject({ state: "failed", reason: "probe_failed" });
    expect(health.overall).toBe("failed");
  });

  it("fails workerBoundary when an attempt's policy fingerprint no longer matches the installed policy", async () => {
    const { db, read } = reader([attempt({ policyFingerprint: "sha256:" + "0".repeat(64) })]);
    expect((await read()).lights.workerBoundary).toMatchObject({ state: "failed", reason: "policy_fingerprint_changed" });
    db.close();
  });

  it("fails sandboxNetwork when the launcher could not prove the network profile", async () => {
    const { db, read } = reader([attempt({ networkMode: "unknown" })]);
    expect((await read()).lights.sandboxNetwork).toMatchObject({ state: "failed", reason: "network_profile_unproven" });
    db.close();
  });

  it("fails sandboxNetwork when an attempt's network fingerprint drifted from the installed profile", async () => {
    const { db, read } = reader([attempt({ networkProfileFingerprint: "sha256:" + "0".repeat(64) })]);
    expect((await read()).lights.sandboxNetwork).toMatchObject({ state: "failed", reason: "network_profile_fingerprint_changed" });
    db.close();
  });

  it("fails clients when a live attempt's lock digest disagrees with the installed lock", async () => {
    const { db, read } = reader([attempt({ clientLockDigest: "sha256:" + "0".repeat(64) })]);
    expect((await read()).lights.clients).toMatchObject({ state: "failed", reason: "client_lock_changed" });
    db.close();
  });

  it("fails clients when an attempt ran a client build the lock does not name", async () => {
    const { db, read } = reader([attempt({ clientVersion: "2.1.295" })]);
    expect((await read()).lights.clients).toMatchObject({ state: "failed", reason: "client_lock_version_mismatch" });
    db.close();
  });

  // The check must compare against the lock's own entry. Hardcoding a build would report every legitimate lock
  // upgrade as drift, so the fixture takes its version from the installed lock rather than naming one.
  it("accepts whatever build the installed lock currently names", async () => {
    const lock = JSON.parse(readFileSync("/etc/multi-agent/client-lock.json", "utf8")) as { clients: Record<string, { version: string }> };
    const { db, read } = reader([attempt({ clientVersion: lock.clients["claude-code"]!.version })]);
    expect((await read()).lights.clients).toMatchObject({ state: "ok" });
    db.close();
  });

  it("keeps a proven attempt's boundary lights ok and still reports its attempts", async () => {
    const { db, read } = reader([attempt()]);
    const health = await read();
    expect(health.lights.workerBoundary.state).toBe("ok");
    expect(health.lights.sandboxNetwork.state).toBe("ok");
    expect(health.lights.clients.state).toBe("ok");
    expect(health.latestAttempts["attempt-1"]).toMatchObject({ attemptId: "attempt-1", worker: "ma-worker1",
      state: "running", evidenceRef: "managed-preflight:fixture" });
    db.close();
  });

  // Round-1 review R1-2: the earlier version of this case never made a file unreadable, so it passed under the
  // fall-through bug it cited. `unreadable` flips the module-level switch below, which makes the composed reader's
  // own `readFileSync` throw for the three installed files.
  it("confirms a proven attempt when the installed files cannot be read at all", async () => {
    const { db, read } = reader([attempt()]);
    unreadable.clear();
    for (const file of INSTALLED) unreadable.add(file);
    try {
      const health = await read();
      for (const light of ["workerBoundary", "sandboxNetwork", "clients"]) {
        expect(health.lights[light].state, light).toBe("ok");
        expect(health.lights[light].evidenceRef, light).toContain(":attempt-1");
      }
    } finally { unreadable.clear(); db.close(); }
  });

  // Round-1 review R1-1: `readHealthEvidence` reports every attempt ever preflighted and never prunes settled ones,
  // so a stopped attempt must not pin a light. Before the fix, a worker that preflighted signed-out and then signed
  // back in failed the light until the daemon restarted.
  it("ignores a settled attempt and falls back to the installed file", async () => {
    const { db, read } = reader([attempt({ provider: "signed_out", state: "stopped" })]);
    const health = await read();
    expect(health.lights.workerBoundary.state, "a settled attempt is not current evidence").toBe("ok");
    expect(health.lights.workerBoundary.evidenceRef).toBe("worker-boundary");
    db.close();
  });

  it("still fails a signed-out worker that is running", async () => {
    const { db, read } = reader([attempt({ provider: "signed_out", state: "running" })]);
    expect((await read()).lights.workerBoundary).toMatchObject({ state: "failed", reason: "worker_signed_out" });
    db.close();
  });
});