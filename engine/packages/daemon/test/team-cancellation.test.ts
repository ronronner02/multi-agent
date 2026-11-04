import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { composeCancellation } from "../src/domain/team-cancellation.js";
import { runningAttemptIdentities, terminateProcessGroup, type ProcessState } from "../src/domain/process-termination.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import type { PlanBinding } from "../src/contracts/team-control.js";
import { createTestApp } from "./helpers/test-app.js";

/**
 * T017 (cancellation half) — the owner's cancel stops the work.
 *
 * The gap this closes is a live-run one. `cancelRun` recorded `cancel_requested` and said in
 * its own reason that termination had not been observed; nothing ended the client, nothing
 * closed the task, and no code path could ever record the observation, so the run stayed in
 * that state for good. These tests drive the real owners — governance, the queue, the
 * cancellation owner and the route — against a database and a repository on disk.
 *
 * The termination itself is decided by an injected `read`/`signal` pair, because a test that
 * spawned processes could not prove which identity was signalled. The demo
 * (`demo/team/scripts/cancel-demo.ts`) is the one that runs real ones.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(parent: string): string {
  const root = realpathSync(mkdtempSync(join(parent, "repo-")));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan\n");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "base");
  return root;
}

describe("T017 — the owner's cancel stops the work", () => {
  let directory: string, repo: string, db: Database.Database, governance: PlanGovernance, binding: PlanBinding;
  let app: ReturnType<typeof createTestApp>["app"], serial = 0;

  /** What the fake `/proc` says about the recorded process, and every signal sent to it. */
  let live: ProcessState | null, signals: Array<[number, NodeJS.Signals]>;
  const identity = { processId: 4242, processStart: "process-start-1" };
  /** The identity check the production reader makes: a moved start tick is another process. */
  const readLive = () => live && live.processStart === identity.processStart && live.state !== "Z" && live.state !== "X" ? live : null;
  /** A process that leaves when asked: SIGTERM ends it. */
  const leavesOnTerm = () => (target: number, kind: NodeJS.Signals) => { signals.push([target, kind]); live = null; };
  /** A process that ignores SIGTERM: only SIGKILL ends it. */
  const ignoresTerm = () => (target: number, kind: NodeJS.Signals) => {
    signals.push([target, kind]); if (kind === "SIGKILL") live = null;
  };

  const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost${path}`,
    { ...init, headers: { Host: "localhost", Authorization: "Bearer owner-fixture", ...(init.headers ?? {}) } },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "mvp-cancel-" + ++serial, payload });

  const owner = { kind: "owner", sessionId: "owner-control" } as const;

  /** The receipt a direct launch records: the client process the seat's pane runs. */
  const receipt = (attemptId: string, seat: string) => {
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig', 'node', 'managed.attempt.receipt', ?)")
      .run(JSON.stringify({ type: "managed.attempt.receipt", rigId: "rig", nodeId: "node", sessionId: "session",
        runId: "run", sessionName: seat, receipt: { attemptId, runId: "run", client: "claude-code",
          identity: { nativeSessionId: "native-" + attemptId, tmuxServer: "/control/tmux.sock", paneId: "%1",
            processId: identity.processId, processStart: identity.processStart, generation: 1,
            policyFingerprint: binding.policyFingerprint } } }));
  };

  /**
   * The real sweep, which is what observes the end: an attempt whose process is gone is
   * recorded stopped. `terminate` below decides when the process is gone, so the sweep and the
   * cancellation see one story about it. In production the sweep is on a 1 Hz timer of its own;
   * here it is driven explicitly, because a test that waited on a real timer would be slower
   * without proving anything more.
   */
  const cancellation = (signal: (target: number, kind: NodeJS.Signals) => void) => composeCancellation({ db, governance,
    terminate: async (target) => {
      const result = await terminateProcessGroup(target, { read: readLive, signal,
        sleep: async () => { await sweep(); }, now: (() => { let t = 0; return () => (t += 100); })() });
      await sweep();
      return result;
    },
    settleMs: 300, log: () => {} });
  let sweep = async (): Promise<void> => {};

  const queueState = (taskId: string) => governance.queueState(governance.findTask("run", taskId)!.qitemId);

  beforeEach(() => {
    serial = 0; signals = [];
    directory = realpathSync(mkdtempSync(join(tmpdir(), "mvp-cancel-")));
    repo = repository(directory);
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"), repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 4, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    const capability = () => ({ policyRevision: 4, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] as const });
    governance = new PlanGovernance(db, bus, queue, undefined, capability);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'rig')").run();
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }), owner, binding);
    const created = governance.createTask(command("task-1", { assignment: { taskId: "task-1", role: "implementer",
      paths: ["src"], dependencies: [] }, outputs: [], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file." }), binding);
    expect(created.status).toBe("accepted");
    live = { ...identity, state: "S", groupId: identity.processId };
    // The sweep reads the receipt and, once the process is gone, records the attempt stopped.
    sweep = async () => {
      const { composeAttemptCompletion } = await import("../src/domain/attempt-completion.js");
      await composeAttemptCompletion({ db, governance, alive: () => live !== null, log: () => {},
        currentBinding: () => structuredClone(binding),
        sessions: { findResumeContextByName: () => null, updateStartupStatus: () => {} } }).sweep();
    };
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      teamControl: { credentials: { ownerToken: "owner-fixture" }, resolveBinding: () => structuredClone(binding),
        readPolicyCapability: capability, cancellation: cancellation(leavesOnTerm()) } } }).app;
  });

  afterEach(() => {
    if (db?.open) db.close();
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* the projection seals its own tree */ }
  });

  it("records the intent, ends the client the run launched, and reaches canceled", async () => {
    receipt("attempt-1", "builder@rig");
    await sweep();
    expect(governance.getAttempt("attempt-1")?.state).toBe("running");
    const response = await request("/api/team-control/runs/run/cancel", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command("run", { reason: "Owner stopped it" })) });
    expect(response.status).toBe(200);
    const receiptBody = await response.json() as { status: string; value: { state: string; attempts: unknown[]; canceledTasks: string[] } };
    expect(receiptBody.status).toBe("observed");
    expect(receiptBody.value).toMatchObject({ state: "canceled", canceledTasks: ["task-1"] });
    // The signal went to the group the recorded client leads, not to the daemon's own.
    expect(signals).toEqual([[-identity.processId, "SIGTERM"]]);
    expect(governance.getAttempt("attempt-1")?.state).toBe("stopped");
    expect(governance.getRun("run").state).toBe("canceled");
    expect(queueState("task-1")).toBe("canceled");
  });

  it("writes the intent before any signal, so a crash halfway still closes dispatch", async () => {
    receipt("attempt-1", "builder@rig");
    await sweep();
    const seen: string[] = [];
    const stop = composeCancellation({ db, governance, settleMs: 1, log: () => {},
      terminate: async () => { seen.push(governance.getRun("run").state); return { outcome: "stopped", escalated: false, waitedMs: 0 }; } });
    const intent = stop.request("run", command("run", { reason: "Stop" }), owner);
    expect(intent.status).toBe("pending-execution");
    // Nothing is signalled until the intent is durable, and the run is already closed here.
    await stop.stop("run", owner);
    expect(seen).toEqual(["cancel_requested"]);
    // A second task cannot be admitted in the window the intent opened either.
    expect(governance.createTask(command("task-2", { assignment: { taskId: "task-2", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [...roleConfiguration.implementer.permissions], sourceSession: "lead@rig",
      destinationSession: "builder@rig", body: "Second." }), binding)).toMatchObject({ status: "denied" });
  });

  it("escalates to SIGKILL after the grace and reports the escalation", async () => {
    receipt("attempt-1", "builder@rig");
    await sweep();
    app = createTestApp(db, { appDeps: { teamGovernance: governance, teamControl: { credentials: { ownerToken: "owner-fixture" },
      resolveBinding: () => structuredClone(binding), readPolicyCapability: () => ({ policyRevision: 4,
        policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] }),
      cancellation: cancellation(ignoresTerm()) } } }).app;
    const response = await request("/api/team-control/runs/run/cancel", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command("run", { reason: "Owner stopped it" })) });
    const body = await response.json() as { status: string; value: { state: string; attempts: Array<{ escalated: boolean; waitedMs: number }> } };
    expect(body.status).toBe("observed");
    expect(body.value.attempts[0]).toMatchObject({ escalated: true });
    expect(body.value.attempts[0]!.waitedMs).toBeGreaterThanOrEqual(5_000);
    expect(signals).toEqual([[-identity.processId, "SIGTERM"], [-identity.processId, "SIGKILL"]]);
    expect(governance.getAttempt("attempt-1")?.state).toBe("stopped");
  });

  it("never signals a pid whose start time moved, and never one that is not its own group", async () => {
    receipt("attempt-1", "builder@rig");
    await sweep();
    // The pid was reused by another process: a different start tick, so it is not this run's.
    live = { ...identity, processStart: "a-different-process", state: "S", groupId: identity.processId };
    const moved = await terminateProcessGroup(identity, { read: readLive, signal: () => { throw new Error("must not signal"); } });
    expect(moved.outcome).toBe("not-running");
    // The recorded process leads someone else's group: the group id would name strangers.
    live = { ...identity, state: "S", groupId: 9999 };
    const shared = await terminateProcessGroup(identity, { read: readLive, signal: () => { throw new Error("must not signal"); } });
    expect(shared.outcome).toBe("unresolved");
    // A pid that never existed is an end, not a signal.
    expect(await terminateProcessGroup(identity, { read: () => null, signal: () => { throw new Error("must not signal"); } }))
      .toMatchObject({ outcome: "not-running" });
  });

  it("reports an attempt that survives the whole limit as unresolved and keeps the run requested", async () => {
    receipt("attempt-1", "builder@rig");
    await sweep();
    // Nothing ever ends it: not SIGTERM, not SIGKILL.
    const never = async (target: { processId: number; processStart: string }) =>
      terminateProcessGroup(target, { read: readLive, signal: () => {}, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1_000); })() });
    const stop = composeCancellation({ db, governance, terminate: never, settleMs: 1, log: () => {} });
    stop.request("run", command("run", { reason: "Stop" }), owner);
    const result = await stop.stop("run", owner);
    expect(result.state).toBe("cancel_requested");
    expect(result.attempts[0]).toMatchObject({ outcome: "unresolved", escalated: true });
    expect(result.unresolvedAttempts).toEqual(["attempt-1"]);
    // The run did not claim a stop it did not see, and the task is not closed either.
    expect(governance.getRun("run").state).toBe("cancel_requested");
    expect(queueState("task-1")).toBe("pending");
  });

  it("cancels only the attempts this run recorded", async () => {
    receipt("attempt-1", "builder@rig");
    await sweep();
    // A second attempt, recorded for a different run, with the same identity on disk.
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
      VALUES ('other', 'rig', ?, ?, 'approved', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .run(JSON.stringify(binding), hashBinding(binding));
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, state, usage_json, active_ms, created_at, updated_at)
      VALUES ('other-attempt', 'other', NULL, 'implementer', 'claude', ?, 'running', ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .run(JSON.stringify({ ...identity, nativeSessionId: "native-other", tmuxServer: "/control/tmux.sock", paneId: "%2",
        generation: 1, policyFingerprint: binding.policyFingerprint }),
      JSON.stringify({ activeMs: 0, inputTokens: { value: null, reason: "x" },
        outputTokens: { value: null, reason: "x" }, costUsd: { value: null, reason: "x" } }));
    expect(runningAttemptIdentities(db, "run")).toEqual([identity]);
    const stop = composeCancellation({ db, governance, settleMs: 1, log: () => {},
      terminate: async (target) => { signals.push([-target.processId, "SIGTERM"]); return { outcome: "stopped", escalated: false, waitedMs: 0 }; } });
    stop.request("run", command("run", { reason: "Stop" }), owner);
    await stop.stop("run", owner);
    expect(signals).toEqual([[-identity.processId, "SIGTERM"]]);
    expect(governance.getAttempt("other-attempt")?.state).toBe("running");
  });

  it("refuses to cancel a run that already came to rest", async () => {
    receipt("attempt-1", "builder@rig");
    await sweep();
    const first = await request("/api/team-control/runs/run/cancel", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command("run", { reason: "Owner stopped it" })) });
    expect(first.status).toBe(200);
    const second = await request("/api/team-control/runs/run/cancel", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command("run", { reason: "Again" })) });
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ status: "denied", reason: "Run is already canceled" });
    expect(governance.getRun("run").state).toBe("canceled");
  });
});
