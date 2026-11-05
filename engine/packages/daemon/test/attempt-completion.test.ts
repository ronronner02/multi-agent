import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TEAM_CONTROL_VERSION, type ControlRequest } from "../src/contracts/team-control.js";
import { composeAttemptCompletion, extractReviewerReport } from "../src/domain/attempt-completion.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const unavailable = { value: null, reason: "provider did not report usage" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };

describe("U4 daemon-recorded outcomes", () => {
  let root: string;
  let turnRoot: string;
  let db: Database.Database;
  let governance: PlanGovernance;
  let binding: ReturnType<typeof bindingForGoal>;
  let taskQitemId: string;
  let attemptId: string;
  let serial = 0;

  const request = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION,
    runId: "run",
    actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion,
    idempotencyKey: `fixture-${++serial}`,
    payload,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "u4-outcomes-"));
    turnRoot = mkdtempSync(join(tmpdir(), "u4-turns-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);

    const policy = unisolatedPolicyCapability(1);
    binding = { ...bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy }),
      limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 } };
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-06T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding, reviewerSeat: "reviewer@rig" });
    governance.requestApproval(request("approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-06T01:00:00.000Z" }), owner);
    governance.decideApproval(request("approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    const created = governance.createTask(request("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: ["src/a.ts"], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@rig", destinationSession: "implementer@rig", body: "Implement the task",
    }), binding);
    expect(created.status).toBe("accepted");
    taskQitemId = (created.value as { qitemId: string }).qitemId;
    attemptId = "attempt-1";
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "native", tmuxServer: "/tmp/tmux.sock", paneId: "%1", processId: 123,
        processStart: "start-1", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (root) rmSync(root, { recursive: true, force: true });
    if (turnRoot) rmSync(turnRoot, { recursive: true, force: true });
  });

  const manifest = (patch: string) => ({ base: "commit" as const, baseIdentifier: "a".repeat(40), files: [{ path: "src/a.ts" }],
    manifestDigest: `sha256:${"b".repeat(64)}`, patch });

  const completion = (candidateManifestFor: (runId: string, taskId: string) => ReturnType<typeof manifest>, readLeadProposal?: (runId: string, taskId: string) => readonly unknown[]) => composeAttemptCompletion({
    db, governance, currentBinding: () => structuredClone(binding), alive: () => false, log: () => {}, turnStateRoot: turnRoot,
    sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() }, candidateManifestFor,
    ...(readLeadProposal ? { readLeadProposal } : {}),
  });

  const addAttempt = (taskId: string, id: string, role: "implementer" | "reviewer") => {
    const task = governance.findTask("run", taskId)!;
    return governance.recordAttempt(request(id, {
      qitemId: task.qitemId, role, provider: "claude",
      identity: { nativeSessionId: `native-${id}`, tmuxServer: "/tmp/tmux.sock", paneId: `%${id.length + 1}`,
        processId: 123 + id.length, processStart: `${id}-start`, generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);
  };

  const writeTurn = (id: string, message: string) => {
    const path = agentTurnOutputPaths(turnRoot, id).lastMessage;
    mkdirSync(join(turnRoot, "turns", id), { recursive: true });
    writeFileSync(path, message);
  };

  it("extracts the final fenced findings block and rejects missing or malformed reports", () => {
    expect(extractReviewerReport("Earlier```json\n{\"findings\": [{\"id\": \"old\"}]}\n```\nFinal```json\n{\"findings\": []}\n```"))
      .toEqual({ findings: [] });
    expect(extractReviewerReport("no report")).toBeNull();
    expect(extractReviewerReport("```json\n{\"findings\": [}\n```"))
      .toBeNull();
  });

  it("records a validated implementer outcome and review from one stop observation", async () => {
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));

    await observe.sweep();

    expect(governance.getAttempt(attemptId)?.state).toBe("stopped");
    expect(governance.queueState(taskQitemId)).toBe("done");
    expect(governance.findTask("run", "task-review-1")?.assignment.role).toBe("reviewer");
    const outcomes = (db.prepare("SELECT payload FROM events WHERE type = 'team.control' AND json_extract(payload, '$.action') = 'task.outcome'").all() as Array<{ payload: string }>)
      .map(row => JSON.parse(row.payload));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ payload: { observedBy: "daemon" } });

    await observe.sweep();
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'team.control' AND json_extract(payload, '$.action') = 'task.outcome'").get()).toEqual({ n: 1 });
  });

  it("records invalid candidate evidence as a retry-eligible daemon failure", async () => {
    const observe = completion(() => manifest("diff --git a/docs/outside.md b/docs/outside.md\n+++ b/docs/outside.md\n"));
    await observe.sweep();

    expect(governance.queueState(taskQitemId)).toBe("failed");
    expect(governance.findTask("run", "task-review-1")).toBeNull();
    expect(governance.getTask(taskQitemId)?.evidence).toMatchObject({ validated: false, reasonCode: "evidence_invalid" });
    expect(governance.getAttempt(attemptId)?.failure).toMatchObject({ reasonCode: "evidence_invalid", retryEligible: true });
  });

  it("records reviewer findings from the final message and reopens on a cited P1", async () => {
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));
    await observe.sweep();
    const reviewer = governance.findTask("run", "task-review-1")!;
    addAttempt(reviewer.assignment.taskId, "review-attempt", "reviewer");
    writeTurn("review-attempt", "```json\n" + JSON.stringify({ findings: [{ id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness",
      file: "src/a.ts", scenario: "The changed path fails the task's acceptance check." }] }) + "\n```");

    await observe.sweep();

    expect(governance.queueState(reviewer.qitemId)).toBe("done");
    expect(governance.queueState(taskQitemId)).toBe("pending");
    expect(db.prepare("SELECT json_extract(payload, '$.payload.verdict') AS verdict FROM events WHERE json_extract(payload, '$.action') = 'review.verdict'").get())
      .toEqual({ verdict: "changes-required" });
  });

  it("approves a reviewer report with no blocking findings", async () => {
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));
    await observe.sweep();
    const reviewer = governance.findTask("run", "task-review-1")!;
    addAttempt(reviewer.assignment.taskId, "review-attempt", "reviewer");
    writeTurn("review-attempt", "```json\n{\"findings\":[{\"id\":\"R1-2\",\"severity\":\"P3\",\"citation\":\"KTD8\",\"category\":\"style\",\"file\":\"src/a.ts\"}]}\n```");

    await observe.sweep();

    expect(governance.queueState(reviewer.qitemId)).toBe("done");
    expect(governance.queueState(taskQitemId)).toBe("done");
    expect(db.prepare("SELECT json_extract(payload, '$.payload.verdict') AS verdict FROM events WHERE json_extract(payload, '$.action') = 'review.verdict'").get())
      .toEqual({ verdict: "approved" });
  });

  it("marks a reviewer without a findings block as retry-eligible", async () => {
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));
    await observe.sweep();
    const reviewer = governance.findTask("run", "task-review-1")!;
    addAttempt(reviewer.assignment.taskId, "review-attempt", "reviewer");

    await observe.sweep();

    expect(governance.queueState(reviewer.qitemId)).toBe("failed");
    expect(governance.getAttempt("review-attempt")?.failure).toMatchObject({ reasonCode: "review_report_missing", retryEligible: true });
    expect(governance.getTask(reviewer.qitemId)?.evidence).toEqual({ reasonCode: "review_report_missing" });
  });

  it("records a validated lead proposal without creating a review task", async () => {
    // Close the fixture implementer so this test can focus on the lead's own task.
    governance.recordUsage(request(attemptId, { expectedAttemptVersion: 1, state: "stopped", usage }));
    const implementer = governance.findTask("run", "task")!;
    governance.recordTaskOutcome(request(implementer.qitemId, { expectedTaskVersion: implementer.entityVersion, state: "done",
      closureReason: "no-follow-on", actorSession: "implementer@rig", attemptId, expectedAttemptVersion: 2,
      evidence: { validated: true, manifestDigest: `sha256:${"b".repeat(64)}` } }), owner);
    const created = governance.createTask(request("lead-task", {
      assignment: { taskId: "lead-task", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [...roleConfiguration.lead.permissions],
      sourceSession: "owner-control", destinationSession: "lead@rig", body: "Decompose the approved goal",
    }), binding);
    expect(created.status).toBe("accepted");
    const lead = governance.findTask("run", "lead-task")!;
    const leadAttempt = "lead-attempt";
    governance.recordAttempt(request(leadAttempt, { qitemId: lead.qitemId, role: "lead", provider: "claude",
      identity: { nativeSessionId: "native-lead", tmuxServer: "/tmp/tmux.sock", paneId: "%7", processId: 777,
        processStart: "lead-start", generation: 1, policyFingerprint: binding.policyFingerprint }, unknownReason: null, state: "running", usage }), binding);
    const observe = completion(() => ({ base: "commit", baseIdentifier: "a".repeat(40), files: [{ path: "lead-proposal.json" }],
      manifestDigest: `sha256:${"c".repeat(64)}`, patch: "diff --git a/lead-proposal.json b/lead-proposal.json\n+++ b/lead-proposal.json\n" }),
      () => [{ taskId: "follow-up", paths: ["src"], dependencies: [] }]);

    await observe.sweep();

    expect(governance.queueState(lead.qitemId)).toBe("done");
    expect(governance.findTask("run", "lead-task-review-1")).toBeNull();
    expect(governance.getTask(lead.qitemId)?.evidence).toMatchObject({ validated: true, changedPaths: ["lead-proposal.json"] });
  });
});
