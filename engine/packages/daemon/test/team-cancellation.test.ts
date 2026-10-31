import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { TeamReconciliation, RAW_LOG_LIMIT, ARTIFACT_LIMIT } from "../src/domain/team-reconciliation.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { createDaemonShutdown } from "../src/daemon-shutdown.js";
import { teamControlRoutes } from "../src/routes/team-control.js";
import type { ManagedSessionReceipt } from "../src/domain/runtime-adapter.js";

const binding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: "sha256:" + "a".repeat(64),
  repository: { root: "/workspace/project", identity: "git:" + "b".repeat(40) },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer"],
  policyRevision: 2, policyFingerprint: "sha256:" + "c".repeat(64),
  limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
};
const owner = { kind: "owner", sessionId: "owner" } as const;
const unknown = { value: null, reason: "Not reported" };
let db: ReturnType<typeof createDb>, events: EventBus, governance: PlanGovernance, reconciliation: TeamReconciliation;
let session: ManagedSessionReceipt, quiesce: ReturnType<typeof vi.fn>, requestStop: ReturnType<typeof vi.fn>;
let sequence: number;
const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId, payload,
  expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "key-" + ++sequence });
const createCoordinator = () => new TeamReconciliation({ db, events, governance, control: { requestStop, quiesce } });
const cancel = () => { governance.cancelRun(command("cancel", { reason: "Owner stop" }), owner); return reconciliation.stopRun("run"); };
const receipts = (action: string) => (db.prepare("SELECT payload FROM events WHERE json_extract(payload, '$.action') = ?")
  .all(action) as { payload: string }[]).map(row => JSON.parse(row.payload).payload);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T00:00:00.000Z"));
  db = createDb(); migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'Cancellation')").run();
  events = new EventBus(db);
  governance = new PlanGovernance(db, events, new QueueRepository(db, events), () => new Date(),
    () => ({ policyRevision: 2, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] }));
  governance.createRun({ id: "run", rigId: "rig", binding }); sequence = 0;
  governance.requestApproval(command("approval", { kind: "orchestrator", action: "implementation",
    payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding),
    expiresAt: "2026-10-30T02:00:00.000Z" }), owner);
  governance.decideApproval(command("approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
  session = {
    identity: { nativeSessionId: "native", tmuxServer: "/control/tmux.sock", paneId: "%1", processId: 123,
      processStart: "start-1", generation: 1, policyFingerprint: binding.policyFingerprint },
    attemptId: "attempt", runId: "run", client: "codex", contextHash: "sha256:" + "d".repeat(64),
    workerUid: 1001, processGroupId: 123, executableVersion: "locked", observedContextHash: "sha256:" + "d".repeat(64),
    network: { namespace: "net:[1]", mode: "isolated-allowlist", profileFingerprint: "sha256:" + "e".repeat(64), preflightRef: "preflight" },
    deadline: Date.now() + 3_600_000,
  };
  governance.recordAttempt(command("attempt", { qitemId: null, role: "lead", provider: "codex", identity: session.identity,
    state: "running", unknownReason: null, usage: { activeMs: 0, inputTokens: unknown, outputTokens: unknown, costUsd: unknown } }), binding);
  events.emit({ type: "managed.attempt.receipt", rigId: "rig", nodeId: "node", sessionId: "seat",
    sessionName: "lead@rig", receipt: session });
  quiesce = vi.fn(async () => true); requestStop = vi.fn(async () => {});
  reconciliation = createCoordinator();
});
afterEach(async () => {
  const cleanup = reconciliation.shutdown().catch(() => {});
  await vi.runAllTimersAsync(); await cleanup;
  db.close(); vi.useRealTimers();
});

describe("durable managed cancellation", () => {
  it("commits intent and closes dispatch before graceful stop, then escalates at five seconds", async () => {
    requestStop.mockImplementation(async () => {
      expect(governance.getRun("run").state).toBe("cancel_requested");
      expect(receipts("run.stop-requested")).toHaveLength(1);
      expect(governance.getAttempt("attempt")?.state).toBe("running");
    });
    const operation = cancel();
    expect(governance.createTask(command("dependent", { assignment: { taskId: "dependent", role: "implementer",
      paths: ["src"], dependencies: [] }, outputs: [], permissions: [], sourceSession: "lead", destinationSession: "worker", body: "Task" }), binding).status).toBe("denied");
    await vi.advanceTimersByTimeAsync(4_999); expect(quiesce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await operation).toEqual({ stopped: ["attempt"], unresolved: [] });
    expect(quiesce).toHaveBeenCalledExactlyOnceWith(session);
    expect(governance.getRun("run")).toMatchObject({ state: "cancel_requested", activeMs: 5_000, accountedAt: null });
    expect(receipts("run.clock-paused")).toHaveLength(1);
  });

  it.each(["processId", "processStart", "generation", "paneId", "tmuxServer", "nativeSessionId"] as const)(
    "never signals a receipt whose %s no longer matches the recorded attempt", async field => {
      const identity = { ...session.identity, [field]: typeof session.identity[field] === "number" ? 456 : "changed" };
      if (field === "tmuxServer") identity.tmuxServer = "/control/other.sock";
      if (field === "paneId") identity.paneId = "%2";
      db.prepare("UPDATE team_attempts SET identity_json = ?").run(JSON.stringify(identity));
      const operation = cancel();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await operation).toEqual({ stopped: [], unresolved: ["attempt"] });
      expect(quiesce).not.toHaveBeenCalled(); expect(requestStop).not.toHaveBeenCalled();
      expect(governance.getAttempt("attempt")?.state).toBe("running");
    });

  it.each(["throws", "hangs", "resists"])("records unresolved at fifteen seconds when the owned stop %s", async mode => {
    quiesce.mockImplementation(() => mode === "throws" ? Promise.reject(new Error("Unconfirmed"))
      : mode === "hangs" ? new Promise<boolean>(() => {}) : Promise.resolve(false));
    const operation = cancel();
    await vi.advanceTimersByTimeAsync(14_999); expect(receipts("run.stop-observed")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await operation).unresolved).toEqual(["attempt"]);
    expect(governance.getAttempt("attempt")?.state).toBe("running");
    expect(governance.getRun("run").accountedAt).not.toBeNull();
  });

  it("escalates on time even when graceful delivery hangs", async () => {
    requestStop.mockImplementation(() => new Promise<void>(() => {}));
    const operation = cancel(); await vi.advanceTimersByTimeAsync(5_000);
    expect((await operation).stopped).toEqual(["attempt"]);
  });

  it("joins duplicate requests and preserves the original deadline after controller recreation", async () => {
    const first = cancel(); expect(reconciliation.stopRun("run")).toBe(first);
    const resumedAt = Date.now() + 10_000;
    vi.clearAllTimers(); vi.setSystemTime(resumedAt);
    reconciliation = createCoordinator();
    const resumed = reconciliation.stopRun("run");
    await vi.advanceTimersByTimeAsync(0);
    expect((await resumed).stopped).toEqual(["attempt"]);
    expect(receipts("run.stop-requested")).toHaveLength(1);
    expect(governance.getRun("run").activeMs).toBe(10_000);
  });

  it("uses a receipt that arrives after cancellation rather than abandoning its owned attempt", async () => {
    db.prepare("DELETE FROM events WHERE type = 'managed.attempt.receipt'").run();
    const operation = cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    events.emit({ type: "managed.attempt.receipt", rigId: "rig", nodeId: "node", sessionId: "seat", sessionName: "lead@rig", receipt: session });
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await operation).stopped).toEqual(["attempt"]);
  });

  it("does not start another cancellation cycle after all attempts are stopped", async () => {
    const first = cancel(); await vi.advanceTimersByTimeAsync(5_000); await first;
    expect(await reconciliation.stopRun("run")).toEqual({ stopped: [], unresolved: [] });
    expect(receipts("run.stop-requested")).toHaveLength(1);
    expect(receipts("run.stop-observed")).toHaveLength(1);
  });

  it("quiesces an admitted launch whose receipt arrives after the graceful window", async () => {
    db.prepare("DELETE FROM events WHERE type = 'managed.attempt.receipt'").run();
    const operation = cancel(); await vi.advanceTimersByTimeAsync(8_000);
    events.emit({ type: "managed.attempt.receipt", rigId: "rig", nodeId: "node", sessionId: "seat", sessionName: "lead@rig", receipt: session });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await operation).toEqual({ stopped: ["attempt"], unresolved: [] });
    expect(quiesce).toHaveBeenCalledExactlyOnceWith(session);
  });

  it("accepts another execution owner's durable stop observation without signalling it again", async () => {
    const operation = cancel();
    governance.recordUsage(command("attempt", { expectedAttemptVersion: 1, state: "stopped", usage: governance.getAttempt("attempt")!.usage }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await operation).toEqual({ stopped: ["attempt"], unresolved: [] });
    expect(quiesce).not.toHaveBeenCalled();
  });

  it("replays a durable daemon-shutdown intent instead of giving a restarted controller a new grace period", async () => {
    reconciliation.stopRun("run", "daemon_shutdown");
    const resumedAt = Date.now() + 10_000;
    vi.clearAllTimers(); vi.setSystemTime(resumedAt);
    reconciliation = createCoordinator(); reconciliation.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(governance.getAttempt("attempt")?.state).toBe("stopped");
    expect(governance.getRun("run").activeMs).toBe(10_000);
    expect(receipts("run.stop-requested")).toHaveLength(1);
  });

  it("does not append another unresolved receipt on every monitor tick", async () => {
    quiesce.mockResolvedValue(false);
    const operation = cancel(); reconciliation.start();
    await vi.advanceTimersByTimeAsync(15_000); await operation;
    const version = governance.getRun("run").entityVersion;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(receipts("run.stop-observed")).toHaveLength(1);
    expect(governance.getRun("run").entityVersion).toBe(version);
  });

  it("reports unresolved when the process stops but the attempt observation fails to persist", async () => {
    db.exec(`CREATE TRIGGER reject_observation BEFORE UPDATE ON team_attempts
      WHEN NEW.state = 'stopped' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    const operation = cancel(); await vi.advanceTimersByTimeAsync(15_000);
    expect(await operation).toEqual({ stopped: [], unresolved: ["attempt"] });
    expect(governance.getAttempt("attempt")?.state).toBe("running");
    expect(receipts("run.clock-paused")).toHaveLength(0);
  });

  it("clears an unresolved outcome when another owner later records the attempt stopped", async () => {
    quiesce.mockResolvedValue(false);
    const operation = cancel(); reconciliation.start();
    await vi.advanceTimersByTimeAsync(15_000); await operation;
    governance.recordUsage(command("attempt", { expectedAttemptVersion: 1, state: "stopped", usage: governance.getAttempt("attempt")!.usage }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(receipts("run.stop-observed").at(-1).unresolved).toEqual([]);
    expect(receipts("run.stop-requested")).toHaveLength(1);
  });

  it("performs no process effect when cancellation intent persistence fails", () => {
    governance.cancelRun(command("cancel", { reason: "Stop" }), owner);
    db.exec(`CREATE TRIGGER reject_stop BEFORE INSERT ON events
      WHEN json_extract(NEW.payload, '$.action') = 'run.stop-requested' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    expect(() => reconciliation.stopRun("run")).toThrow("disk full");
    expect(quiesce).not.toHaveBeenCalled(); expect(requestStop).not.toHaveBeenCalled();
  });
});

describe("cumulative run boundaries", () => {
  it("starts inactivity at durable execution, not at a much older approval request", () => {
    db.prepare("UPDATE team_runs SET created_at = ?").run(new Date(Date.now() - 600_000).toISOString());
    expect(reconciliation.checkpoint("run").state).toBe("approved");
    reconciliation = createCoordinator(); vi.setSystemTime(Date.now() + 600_000);
    expect(reconciliation.checkpoint("run").stateReason).toBe("no_progress");
  });

  it("projects idle budget checks without changing the owner's entity version each second", async () => {
    const before = governance.getRun("run").entityVersion;
    reconciliation.start(); await vi.advanceTimersByTimeAsync(2_000);
    expect(governance.getRun("run").entityVersion).toBe(before);
  });

  it.each([true, false])("derives progress from a real queue transition, changed=%s, through restart", changed => {
    const created = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer",
      paths: ["src"], dependencies: [] }, outputs: [], permissions: [], sourceSession: "lead", destinationSession: "worker", body: "Task" }), binding);
    const qitemId = (created.value as { qitemId: string }).qitemId;
    vi.setSystemTime(Date.now() + 540_000);
    expect(governance.transitionTask(command(qitemId, { expectedTaskVersion: 1,
      state: changed ? "in-progress" : "pending", actorSession: "worker" }), binding).status).toBe("accepted");
    // SQLite has its own clock; pin the committed event to this fixture's fake wall clock.
    db.prepare("UPDATE events SET created_at = ? WHERE type = 'queue.updated'").run(new Date().toISOString());
    reconciliation = createCoordinator(); vi.setSystemTime(Date.now() + 60_000);
    expect(reconciliation.checkpoint("run").state).toBe(changed ? "approved" : "blocked");
    if (changed) {
      reconciliation = createCoordinator(); vi.setSystemTime(Date.now() + 540_000);
      expect(reconciliation.checkpoint("run").stateReason).toBe("no_progress");
    } else expect(governance.getRun("run").stateReason).toBe("no_progress");
  });

  it("counts an unknown controller interval against the same sixty-minute budget", () => {
    vi.setSystemTime(Date.now() + 3_599_000);
    reconciliation.checkpoint("run", { progress: "tool_step" });
    reconciliation = createCoordinator(); vi.setSystemTime(Date.now() + 1_000);
    expect(reconciliation.checkpoint("run")).toMatchObject({ state: "blocked", stateReason: "run_budget_exhausted", activeMs: 3_600_000 });
  });
  it.each(["heartbeat", "status"] as const)("does not treat %s as progress", progress => {
    vi.setSystemTime(Date.now() + 600_000);
    expect(reconciliation.checkpoint("run", { progress }).stateReason).toBe("no_progress");
  });
  it("waits for a recorded supervised tool, capped by the remaining run deadline", () => {
    reconciliation.checkpoint("run", { tool: { attemptId: "attempt", deadline: Date.now() + 900_000, evidenceRef: "tool:1" } });
    vi.setSystemTime(Date.now() + 600_000);
    expect(reconciliation.checkpoint("run").state).toBe("approved");
    vi.setSystemTime(Date.now() + 300_000);
    expect(reconciliation.checkpoint("run").stateReason).toBe("tool_deadline_exhausted");
  });
  it("gives no inactivity exemption to an unknown or unbounded tool", () => {
    reconciliation.checkpoint("run", { tool: { attemptId: "unowned", deadline: Infinity, evidenceRef: "tool:unknown" } });
    vi.setSystemTime(Date.now() + 600_000);
    expect(reconciliation.checkpoint("run").stateReason).toBe("no_progress");
  });
  it("bounds retained UTF-8 logs and records omitted bytes without deleting evidence", () => {
    reconciliation.checkpoint("run", { rawLogBytes: RAW_LOG_LIMIT - 1 });
    const before = db.prepare("SELECT count(*) AS n FROM events").get() as { n: number };
    expect(reconciliation.retainLog("run", "éa")).toBe("");
    expect(receipts("run.activity").at(-1)).toMatchObject({ rawLogBytes: RAW_LOG_LIMIT - 1, omittedLogBytes: 3 });
    expect(governance.getRun("run").stateReason).toBe("storage_capacity_exhausted");
    expect((db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBeGreaterThan(before.n);
  });
  it("preserves aggregate artifact limits and approved decisions through recreation", () => {
    reconciliation.checkpoint("run", { artifactBytes: ARTIFACT_LIMIT });
    reconciliation = createCoordinator();
    expect(reconciliation.checkpoint("run", { artifactBytes: 0 }).stateReason).toBe("storage_capacity_exhausted");
    expect(receipts("run.activity").at(-1).artifactBytes).toBe(ARTIFACT_LIMIT);
    expect(governance.getApproval("approval")?.state).toBe("approved");
  });
});

describe("production cancellation entrypoints", () => {
  it("returns the durable cancel receipt without waiting for process termination", async () => {
    const app = teamControlRoutes(governance, { credentials: { ownerToken: "owner-token" }, reconciliation }, []);
    const response = await app.request("/runs/run/cancel", { method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify(command("cancel", { reason: "Owner stop" })) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(response.status).toBe(202);
    expect(receipts("run.stop-requested")).toHaveLength(1);
    expect(quiesce).not.toHaveBeenCalled();
  });
  it("routes managed rig teardown around legacy tmux kills and data cleanup", async () => {
    const killSession = vi.fn(), captureSnapshot = vi.fn();
    const teardown = new RigTeardownOrchestrator({ db, eventBus: events,
      rigRepo: { db, getRig: () => ({ id: "rig", nodes: [] }), hasGovernanceHistory: () => true },
      sessionRegistry: { db }, tmuxAdapter: { killSession }, snapshotCapture: { db, captureSnapshot },
      managedCancellation: reconciliation } as unknown as ConstructorParameters<typeof RigTeardownOrchestrator>[0]);
    const operation = teardown.teardown("rig"); await vi.advanceTimersByTimeAsync(5_000);
    expect(await operation).toMatchObject({ sessionsKilled: 1, deleted: false, errors: [] });
    expect(killSession).not.toHaveBeenCalled(); expect(captureSnapshot).not.toHaveBeenCalled();
  });
  it("drains managed cancellation before closing services and never marks unresolved shutdown clean", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "team-cancellation-"));
    try {
      quiesce.mockResolvedValue(false);
      const close = vi.fn(), markClean = vi.fn(), exit = vi.fn(), receiptPath = path.join(directory, "shutdown.json");
      createDaemonShutdown({ managedCancellation: () => reconciliation.shutdown(), phases: [["services", close]],
        markClean, exit, receiptPath, log: () => {} })("SIGTERM");
      await vi.advanceTimersByTimeAsync(14_999); expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledOnce(); expect(markClean).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledWith(1);
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({ outcome: "failed", phase: "managed-cancellation" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
