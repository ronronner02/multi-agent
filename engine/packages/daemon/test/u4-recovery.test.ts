import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { TEAM_CONTROL_VERSION, type ControlRequest } from "../src/contracts/team-control.js";
import { composeAttemptCompletion, identityAlive } from "../src/domain/attempt-completion.js";
import { observeIdentity, terminateProcessGroup } from "../src/domain/process-termination.js";
import { bootReconcileAttempts } from "../src/domain/boot-recovery.js";
import { seatOccupantFromAttempts, occupantTruthFromIdentity } from "../src/domain/seat-occupant.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { readSpawnCreationTime, readSupervisorExit } from "../src/adapters/child-process-supervisor.js";
import { setHostPlatformForTests } from "../src/domain/platform.js";

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const unavailable = { value: null, reason: "provider did not report usage" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };

describe("U4 boot recovery reconciliation", () => {
  let root: string;
  let db: Database.Database;
  let governance: PlanGovernance;
  let binding: ReturnType<typeof bindingForGoal>;
  let serial = 0;

  const request = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion,
    idempotencyKey: `u4-boot-${actionId}-${++serial}`, payload,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "u4-boot-"));
    db = createDb(":memory:");
    initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    const bus = new EventBus(db);
    const policy = unisolatedPolicyCapability(1);
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    binding = { ...bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy }),
      limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 } };
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-06T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(request("approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding),
      expiresAt: "2030-01-01T00:00:00.000Z" }), owner);
    governance.decideApproval(request("approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    const created = governance.createTask(request("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: ["src/a.ts"], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@rig", destinationSession: "implementer@rig", body: "Implement the task",
    }), binding);
    expect(created.status).toBe("accepted");
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("reconciles a confirmed dead process as interrupted", async () => {
    const taskQitemId = (governance.findTask("run", "task")!).qitemId;
    const attemptId = "dead-attempt";
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat", tmuxServer: "/tmp/tmux.sock", paneId: "%1", processId: 999,
        processStart: "start-1", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    const result = await bootReconcileAttempts({ db, governance,
      observe: async () => "dead" as const,
    });
    expect(result.total).toBe(1);
    expect(result.interrupted).toBe(1);
    expect(result.blocked).toBe(0);
    expect(result.unknown).toBe(0);
    expect(governance.getAttempt(attemptId)?.state).toBe("stopped");
  });

  it("tree-kills a confirmed live process and records interrupted after kill", async () => {
    const taskQitemId = (governance.findTask("run", "task")!).qitemId;
    const attemptId = "live-attempt";
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat", tmuxServer: "/tmp/tmux.sock", paneId: "%2", processId: 1000,
        processStart: "start-2", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    let killCalled = false;
    const result = await bootReconcileAttempts({ db, governance,
      observe: async () => "alive" as const,
      terminate: async () => {
        killCalled = true;
        return { outcome: "stopped" as const, escalated: false, waitedMs: 0 };
      },
    });
    expect(killCalled).toBe(true);
    expect(result.total).toBe(1);
    expect(result.interrupted).toBe(1);
    expect(governance.getAttempt(attemptId)?.state).toBe("stopped");
  });

  it("records recovery_blocked for a stubborn survivor after tree-kill", async () => {
    const taskQitemId = (governance.findTask("run", "task")!).qitemId;
    const attemptId = "stubborn-attempt";
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat", tmuxServer: "/tmp/tmux.sock", paneId: "%3", processId: 1001,
        processStart: "start-3", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    const result = await bootReconcileAttempts({ db, governance,
      observe: async () => "alive" as const,
      terminate: async () => ({ outcome: "unresolved" as const, escalated: true, waitedMs: 5000 }),
    });
    expect(result.total).toBe(1);
    expect(result.blocked).toBe(1);
    expect(result.interrupted).toBe(0);
    const attempt = governance.getAttempt(attemptId);
    expect(attempt?.state).toBe("unknown");
    expect(attempt?.unknownReason).toContain("recovery_blocked");
  });

  it("records recovery_blocked for an unknown identity", async () => {
    const taskQitemId = (governance.findTask("run", "task")!).qitemId;
    const attemptId = "unknown-attempt";
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat", tmuxServer: "/tmp/tmux.sock", paneId: "%4", processId: 1002,
        processStart: "start-4", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    const result = await bootReconcileAttempts({ db, governance,
      observe: async () => "unknown" as const,
    });
    expect(result.total).toBe(1);
    expect(result.unknown).toBe(1);
    expect(result.blocked).toBe(0);
    expect(result.interrupted).toBe(0);
    const attempt = governance.getAttempt(attemptId);
    expect(attempt?.state).toBe("unknown");
    expect(attempt?.unknownReason).toContain("recovery_blocked");
  });

  it("records recovery_blocked for a not-ours identity", async () => {
    const taskQitemId = (governance.findTask("run", "task")!).qitemId;
    const attemptId = "notours-attempt";
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat", tmuxServer: "/tmp/tmux.sock", paneId: "%5", processId: 1003,
        processStart: "start-5", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    const result = await bootReconcileAttempts({ db, governance,
      observe: async () => "not-ours" as const,
    });
    expect(result.total).toBe(1);
    expect(result.unknown).toBe(1);
    expect(result.blocked).toBe(0);
    expect(result.interrupted).toBe(0);
    const attempt = governance.getAttempt(attemptId);
    expect(attempt?.state).toBe("unknown");
    expect(attempt?.unknownReason).toContain("recovery_blocked");
  });

  it("handles duplicate restart sweep idempotently", async () => {
    const taskQitemId = (governance.findTask("run", "task")!).qitemId;
    const attemptId = "dup-attempt";
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat", tmuxServer: "/tmp/tmux.sock", paneId: "%6", processId: 1004,
        processStart: "start-6", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    const result1 = await bootReconcileAttempts({ db, governance,
      observe: async () => "dead" as const,
    });
    expect(result1.total).toBe(1);
    expect(result1.interrupted).toBe(1);

    const result2 = await bootReconcileAttempts({ db, governance,
      observe: async () => "dead" as const,
    });
    expect(result2.total).toBe(0);
  });
});

describe("U4 seat occupant truth", () => {
  it("returns none for a seat with no running attempts", () => {
    expect(seatOccupantFromAttempts("implementer@rig", [
      { id: "a1", state: "stopped", identity: { processId: 1, processStart: "t1" } },
    ])).toEqual({ seat: "implementer@rig", occupantId: null, truth: "none" });
  });

  it("returns resolved for a seat with one running attempt and known identity", () => {
    expect(seatOccupantFromAttempts("implementer@rig", [
      { id: "a2", state: "running", identity: { processId: 2, processStart: "t2" } },
    ])).toEqual({ seat: "implementer@rig", occupantId: "a2", truth: "resolved" });
  });

  it("returns ambiguous for a seat with no identity on running attempt", () => {
    expect(seatOccupantFromAttempts("implementer@rig", [
      { id: "a3", state: "running", identity: null },
    ])).toEqual({ seat: "implementer@rig", occupantId: null, truth: "ambiguous" });
  });

  it("returns ambiguous for multiple running attempts", () => {
    expect(seatOccupantFromAttempts("implementer@rig", [
      { id: "a4", state: "running", identity: { processId: 4, processStart: "t4" } },
      { id: "a5", state: "running", identity: { processId: 5, processStart: "t5" } },
    ])).toEqual({ seat: "implementer@rig", occupantId: null, truth: "ambiguous" });
  });

  it("never treats unknown or not-ours as resolved or none", () => {
    expect(occupantTruthFromIdentity("alive")).toBe("resolved");
    expect(occupantTruthFromIdentity("dead")).toBe("resolved");
    expect(occupantTruthFromIdentity("unknown")).toBe("ambiguous");
    expect(occupantTruthFromIdentity("not-ours")).toBe("ambiguous");
  });
});

describe("U4 stale report rejection", () => {
  let root: string;
  let turnRoot: string;
  let db: Database.Database;
  let governance: PlanGovernance;
  let binding: ReturnType<typeof bindingForGoal>;
  let serial = 0;

  const request = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion,
    idempotencyKey: `u4-stale-${actionId}-${++serial}`, payload,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "u4-stale-"));
    turnRoot = mkdtempSync(join(tmpdir(), "u4-stale-turns-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);

    const policy = unisolatedPolicyCapability(1);
    binding = { ...bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy }),
      limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 } };
    db = createDb(":memory:");
    initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-06T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding, reviewerSeat: "reviewer@rig" });
    governance.requestApproval(request("approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) },
      targetDigest: hashBinding(binding), expiresAt: "2026-11-06T01:00:00.000Z" }), owner);
    governance.decideApproval(request("approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    const created = governance.createTask(request("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: ["src/a.ts"], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@rig", destinationSession: "implementer@rig", body: "Implement the task",
    }), binding);
    expect(created.status).toBe("accepted");
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (root) rmSync(root, { recursive: true, force: true });
    if (turnRoot) rmSync(turnRoot, { recursive: true, force: true });
  });

  it("does not complete from a stale report left by a previous attempt", async () => {
    const taskQitemId = (governance.findTask("run", "task")!).qitemId;
    const oldAttemptId = "old-attempt";
    const newAttemptId = "new-attempt";

    // Register old attempt.
    governance.recordAttempt(request(oldAttemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat-old", tmuxServer: "/tmp/tmux.sock", paneId: "%10", processId: 2001,
        processStart: "old-start", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    // Write a stale report into the old attempt's directory (simulating a prior successful turn).
    const oldPath = agentTurnOutputPaths(turnRoot, oldAttemptId);
    mkdirSync(dirname(oldPath.taskReport), { recursive: true });
    writeFileSync(oldPath.taskReport, JSON.stringify({ status: "dropped", evidence: "Old successful work" }));
    writeFileSync(oldPath.lastMessage, "Old final message");

    // Stop the old attempt (simulating it ended normally before the daemon stopped).
    const old = governance.getAttempt(oldAttemptId)!;
    governance.recordUsage(request(oldAttemptId, {
      expectedAttemptVersion: old.entityVersion, state: "stopped", usage,
      failure: { reasonCode: "daemon_recovery", resumeSafe: true, retryEligible: true, ownerAction: "Retry" },
    }));

    // Start a new attempt. The supervisor would have cleared its directory before spawn.
    governance.recordAttempt(request(newAttemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat-new", tmuxServer: "/tmp/tmux.sock", paneId: "%11", processId: 2002,
        processStart: "new-start", generation: 2, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    // The new attempt's directory is empty (simulating the supervisor cleared it).
    // The stale report sits in the old attempt's directory.
    // When the sweep reads new attempt's report (stoppedAttempt.id === "new-attempt"),
    // it reads agentTurnOutputPaths(turnRoot, "new-attempt").taskReport
    // which does not exist (no file at that path).
    // So completion cannot happen from the old stale report.
    const completion = composeAttemptCompletion({
      db, governance, currentBinding: () => structuredClone(binding),
      alive: () => false, log: () => {}, turnStateRoot: turnRoot,
      sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() },
    });
    await completion.sweep();

    // The new attempt was stopped by the sweep (alive() returns false for all),
    // but it was NOT completed from the old stale report — the task outcome would fail.
    expect(governance.getAttempt(newAttemptId)?.state).toBe("stopped");
    // The task is NOT done: the sweep couldn't read a report for the new attempt.
    expect(governance.queueState(taskQitemId)).toBe("failed");
  });

  it("rejects stale exit.json with mismatched attempt id", async () => {
    const attemptId = "stale-exit-attempt";
    const taskQitemId = (governance.findTask("run", "task")!).qitemId;
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat-se", tmuxServer: "/tmp/tmux.sock", paneId: "%12", processId: 3001,
        processStart: "se-start", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    // Write exit.json with mismatched attempt id (stale data from another attempt).
    const path = agentTurnOutputPaths(turnRoot, attemptId);
    mkdirSync(dirname(path.exit), { recursive: true });
    writeFileSync(path.exit, JSON.stringify({
      version: 1, attemptId: "other-attempt", provider: "claude",
      exitCode: 0, signal: null, acknowledged: false, noResponse: false,
      threadId: null, stderrTail: "", outputTail: "", at: new Date().toISOString(),
    }));

    // readSupervisorExit should reject mismatched attempt id.
    const exitFacts = readSupervisorExit(turnRoot, attemptId);
    expect(exitFacts).toBeNull();
  });

  it("ignores a report whose own attemptId names another attempt", async () => {
    const attemptId = "self-named-attempt";
    const taskQitemId = (governance.findTask("run", "task")!).qitemId;
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "nat-self", tmuxServer: "/tmp/tmux.sock", paneId: "%13", processId: 3002,
        processStart: "self-start", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);

    // Write a report at this attempt's own path that names a different attempt. The per-attempt
    // directory is cleared before spawn, so this is a worker-written witness that the report
    // belongs to another generation — completion must not use it.
    const path = agentTurnOutputPaths(turnRoot, attemptId);
    mkdirSync(dirname(path.taskReport), { recursive: true });
    writeFileSync(path.taskReport, JSON.stringify({
      status: "dropped", evidence: "Work for a different attempt", attemptId: "some-other-attempt",
    }));
    // The supervisor writes this attempt's own exit facts.
    mkdirSync(dirname(path.exit), { recursive: true });
    writeFileSync(path.exit, JSON.stringify({
      version: 1, attemptId, provider: "claude", exitCode: 0, signal: null,
      acknowledged: false, noResponse: false, threadId: null, stderrTail: "", outputTail: "", at: new Date().toISOString(),
    }));

    const completion = composeAttemptCompletion({
      db, governance, currentBinding: () => structuredClone(binding),
      alive: () => false, log: () => {}, turnStateRoot: turnRoot,
      sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() },
      turnExit: (id) => readSupervisorExit(turnRoot, id),
      readTaskReport: (runId, id) => {
        const bus = new EventBus(db);
        return new WorkflowRuntime({ db, eventBus: bus, queueRepo: new QueueRepository(db, bus) })
          .taskReportFor(runId, id, turnRoot);
      },
    });
    await completion.sweep();

    // The attempt stopped, but the mismatched report did not complete the task.
    expect(governance.getAttempt(attemptId)?.state).toBe("stopped");
    expect(governance.queueState(taskQitemId)).not.toBe("done");
  });
});

describe("U4 Windows identity liveness", () => {
  afterEach(() => { setHostPlatformForTests(null); });

  it("answers unknown, not dead, when the Windows query cannot be made", async () => {
    setHostPlatformForTests("win32");
    expect(await observeIdentity({ processId: -5, processStart: "recorded" })).toBe("unknown");
    expect(await identityAlive({ processId: -5, processStart: "recorded" })).toBe(true);
  });
});

const windows = process.platform === "win32";
const directories: string[] = [];
const temporary = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(!windows)("U4 an interrupted real stub child leaves no orphan", () => {
  it("tree-kills a real stub process on boot reconciliation and proves it absent", async () => {
    // A real child, started the way a supervised turn starts one: this Node binary running a
    // stub that ignores stdin and keeps a grandchild alive. Boot reconciliation must tree-kill
    // the recorded identity and prove absence before recording the attempt interrupted.
    const root = temporary("u4-orphan-");
    const script = join(root, "stubborn.cjs");
    writeFileSync(script, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(join(root, "grandchild.pid"))}, String(grandchild.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    const { spawn: spawnProcess } = await import("node:child_process");
    const child = spawnProcess(process.execPath, [script], { stdio: "ignore", windowsHide: true });
    try {
      // Wait for the child to write its grandchild pid, so both processes are real.
      const pidFile = join(root, "grandchild.pid");
      let grandchild = 0;
      for (let attempt = 0; attempt < 200 && grandchild === 0; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 50));
        if (existsSync(pidFile)) grandchild = Number(readFileSync(pidFile, "utf8"));
      }
      expect(grandchild).toBeGreaterThan(0);
      const identity = { processId: child.pid!, processStart: (await readSpawnCreationTime(child.pid!)) ?? "unobserved" };
      expect(await observeIdentity(identity)).toBe("alive");
      // Reconciliation's real tree kill, then its own absence proof.
      const termination = await terminateProcessGroup(identity);
      expect(termination.outcome).toBe("stopped");
      expect(await observeIdentity(identity)).toBe("dead");
      // The grandchild the direct child started is gone too.
      const grandchildState = await observeIdentity({ processId: grandchild, processStart: (await readSpawnCreationTime(grandchild)) ?? "unobserved" });
      expect(grandchildState).toBe("dead");
    } finally {
      try { child.kill(); } catch { /* Already gone. */ }
      try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { /* Already gone. */ }
    }
  }, 60_000);
});
