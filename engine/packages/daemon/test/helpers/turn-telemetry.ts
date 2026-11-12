import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/baseline.js";
import { TEAM_CONTROL_VERSION, type ControlRequest } from "../../src/contracts/team-control.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { PlanGovernance, hashBinding } from "../../src/domain/plan-governance.js";
import { QueueRepository } from "../../src/domain/queue-repository.js";
import { roleConfiguration } from "../../src/domain/role-configuration.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../../src/routes/team-start.js";
import { agentTurnOutputPaths } from "../../src/domain/agent-turn.js";

export const nativeThread = "00000000-0000-4000-8000-000000000001";
export const tokenCounts = { inputTokens: 100, cacheReadInputTokens: 20, cacheWriteInputTokens: 5,
  outputTokens: 10, reasoningOutputTokens: null };
export const toolStart = { id: "call-1", seq: 1, at: "2026-11-07T12:00:00.000Z",
  tool: "Bash", summary: "cat src/input.txt", status: "running" };

export function turnTelemetryFixture() {
  const root = mkdtempSync(join(tmpdir(), "turn-telemetry-store-"));
  const repository = join(root, "repository"), turnRoot = join(root, "state"), dbPath = join(root, "test.db");
  mkdirSync(repository); mkdirSync(join(repository, "src"));
  execFileSync("git", ["init", "-q", repository], { stdio: "ignore" });
  writeFileSync(join(repository, "plan.md"), "Fixture plan.\n");
  execFileSync("git", ["-C", repository, "add", "plan.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "fixture"], { stdio: "ignore" });
  const db = createDb(dbPath);
  initializeDatabase(db);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('node', 'rig', 'implementer', 'claude-code', ?)").run(repository);
  const events = new EventBus(db), queue = new QueueRepository(db, events), policy = unisolatedPolicyCapability(1);
  let now = new Date("2026-11-07T12:00:00.000Z"), serial = 0;
  const clock = () => new Date(now);
  const governance = new PlanGovernance(db, events, queue, clock, () => policy);
  const binding = { ...bindingForGoal({ root: repository, planRef: "plan.md", writePaths: ["src"], policy }),
    limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 2, maxReviewRounds: 2 } };
  const owner = { kind: "owner", sessionId: "owner-control" } as const;
  const request = (runId: string, actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId, actionId,
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: "fixture-" + ++serial, payload,
  });
  const addRun = (id: string) => {
    governance.createRun({ id, rigId: "rig", binding });
    governance.requestApproval(request(id, "approval-" + id, { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-12-01T00:00:00.000Z" }), owner);
    governance.decideApproval(request(id, "approval-" + id, { approvalVersion: 1, decision: "approved" }), owner, binding);
  };
  const addTask = (taskId: string, runId = "run", seat = "implementer@fixture") => {
    const created = governance.createTask(request(runId, taskId, {
      assignment: { taskId, role: "implementer", paths: ["src"], dependencies: [] },
      outputs: ["src/result.txt"], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@fixture", destinationSession: seat, body: "Implement the fixture task",
    }), binding);
    assert.equal(created.status, "accepted");
    return (created.value as { qitemId: string }).qitemId;
  };
  addRun("run");
  const qitemId = addTask("task");
  const addAttempt = (id: string, options: { provider?: "claude" | "codex"; task?: string; runId?: string } = {}) => {
    const runId = options.runId ?? "run";
    const receipt = governance.recordAttempt(request(runId, id, {
      qitemId: options.task ?? qitemId, role: "implementer", provider: options.provider ?? "claude",
      identity: { nativeSessionId: "native-" + id, tmuxServer: join(root, "tmux.sock"), paneId: "%1",
        processId: 123, processStart: id, generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage: { activeMs: 0,
        inputTokens: { value: null, reason: "Not observed" }, outputTokens: { value: null, reason: "Not observed" },
        costUsd: { value: null, reason: "Not observed" } },
    }), binding);
    assert.equal(receipt.status, "observed");
    return governance.getAttempt(id)!;
  };
  const stop = (id: string) => {
    const attempt = governance.getAttempt(id)!;
    const receipt = governance.recordUsage(request(attempt.runId, id, {
      expectedAttemptVersion: attempt.entityVersion, state: "stopped", usage: attempt.usage,
    }));
    assert.equal(receipt.status, "observed");
    return governance.getAttempt(id)!;
  };
  const writeSidecars = (id: string, native: unknown, records: unknown[] = []) => {
    const paths = agentTurnOutputPaths(turnRoot, id);
    mkdirSync(paths.directory, { recursive: true });
    if (native !== undefined) writeFileSync(paths.usage, JSON.stringify(native));
    writeFileSync(paths.activity, records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
    return paths;
  };
  return { root, repository, turnRoot, dbPath, db, events, queue, policy, governance, binding, owner, request, qitemId,
    clock, setNow: (value: string) => { now = new Date(value); }, addRun, addTask, addAttempt, stop, writeSidecars,
    cleanup: () => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); } };
}

export function nativeUsage(options: { client?: "claude-code" | "codex"; resumed?: boolean; thread?: string;
  counts?: { [K in keyof typeof tokenCounts]: number | null }; model?: string } = {}) {
  const client = options.client ?? "claude-code";
  return { version: 1, available: true, client, nativeSessionId: options.thread ?? nativeThread,
    model: options.model ?? "fixture-model", resumed: options.resumed ?? false,
    mode: client === "codex" ? "cumulative" : "turn", counts: options.counts ?? tokenCounts, reason: null };
}
