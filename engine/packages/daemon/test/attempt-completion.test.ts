import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TEAM_CONTROL_VERSION, type ControlRequest } from "../src/contracts/team-control.js";
import { composeAttemptCompletion, extractReviewerReport } from "../src/domain/attempt-completion.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { pendingTasks } from "../src/domain/pending-dispatch.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { leadTeamEvents } from "../src/domain/lead-manager.js";
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
    readTaskReport: (runId, id) => {
      const eventBus = new EventBus(db);
      return new WorkflowRuntime({ db, eventBus, queueRepo: new QueueRepository(db, eventBus) }).taskReportFor(runId, id, turnRoot);
    },
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


  const writeReport = (id: string, content: unknown) => {
    const path = agentTurnOutputPaths(turnRoot, id).taskReport;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  };

  it.each(["blocked", "needs-decision"] as const)("pauses a %s report for the lead without a retry or owner decision", async status => {
    writeReport(attemptId, { status, question: "Which response is required?", evidence: "The approved plan names two responses." });
    const candidate = vi.fn(() => manifest("diff --git a/src/a.ts b/src/a.ts\n"));
    const observe = completion(candidate);
    await observe.sweep();
    expect(candidate).not.toHaveBeenCalled();
    expect(governance.queueState(taskQitemId)).toBe("blocked");
    expect(governance.getTask(taskQitemId)?.evidence).toMatchObject({
      taskReport: { status, question: "Which response is required?" }, reportedAttemptId: attemptId, validated: false,
    });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM team_chat_messages WHERE kind = 'decision'").get()).toEqual({ n: 0 });
    expect(leadTeamEvents(db, "run")).toEqual([expect.objectContaining({ key: "report:task:" + attemptId,
      note: expect.stringContaining("Which response is required?") })]);
    expect(pendingTasks(db, "run")).not.toContain("task");
  });

  it.each(["implementer", "reviewer"] as const)("closes a dropped %s report without reading a candidate or recording a review verdict", async role => {
    let id = attemptId, qitemId = taskQitemId;
    if (role === "reviewer") {
      await completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n")).sweep();
      id = "review-attempt"; qitemId = governance.findTask("run", "task-review-1")!.qitemId;
      addAttempt("task-review-1", id, "reviewer");
    }
    writeReport(id, { status: "dropped", evidence: "This task has no remaining work." });
    const candidate = vi.fn(() => manifest(""));
    await completion(candidate).sweep();
    expect(candidate).not.toHaveBeenCalled();
    expect(governance.queueState(qitemId)).toBe("done");
    expect(governance.getTask(qitemId)?.evidence).toMatchObject({ taskReport: { status: "dropped" }, validated: false });
    expect(governance.getRun("run").retriesUsed).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(payload, '$.action') = 'review.verdict'").get()).toEqual({ n: 0 });
    if (role === "implementer") expect(governance.findTask("run", "task-review-1")).toBeNull();
  });

  it("turns malformed report bytes into a paused task with the parse error as its question", async () => {
    writeReport(attemptId, "{");
    await completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n")).sweep();
    expect(governance.queueState(taskQitemId)).toBe("blocked");
    expect(governance.getTask(taskQitemId)?.evidence).toMatchObject({ taskReport: {
      status: "blocked", question: expect.stringContaining("not valid JSON"),
    } });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 0 });
  });

  it("sends invalid candidate evidence to the lead without spending a retry", async () => {
    const observe = completion(() => manifest("diff --git a/docs/outside.md b/docs/outside.md\n+++ b/docs/outside.md\n"));
    await observe.sweep();
    expect(governance.findTask("run", "task-review-1")).toBeNull();
    expect(governance.getTask(taskQitemId)?.evidence).toMatchObject({ validated: false, reasonCode: "evidence_invalid" });
    expect(governance.getAttempt(attemptId)?.failure).toMatchObject({ reasonCode: "evidence_invalid", failureClass: "judgment", retryEligible: false });
    expect(governance.queueState(taskQitemId)).toBe("failed");
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 0 });
    expect(pendingTasks(db, "run")).toEqual([]);
    expect(leadTeamEvents(db, "run").some(event => event.key.startsWith("failed:task"))).toBe(true);
  });

  it("does not repeat a judgment outcome on later sweeps", async () => {
    const observe = completion(() => manifest("diff --git a/docs/outside.md b/docs/outside.md\n+++ b/docs/outside.md\n"));
    await observe.sweep();
    const version = governance.getTask(taskQitemId)!.entityVersion;
    await observe.sweep();
    expect(governance.queueState(taskQitemId)).toBe("failed");
    expect(governance.getTask(taskQitemId)!.entityVersion).toBe(version);
    expect(governance.getRun("run").retriesUsed).toBe(0);
    expect(pendingTasks(db, "run")).toEqual([]);
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

  it("sends a missing reviewer report to the lead rather than retrying it", async () => {
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));
    await observe.sweep();
    const reviewer = governance.findTask("run", "task-review-1")!;
    addAttempt(reviewer.assignment.taskId, "review-attempt", "reviewer");

    await observe.sweep();

    expect(governance.queueState(reviewer.qitemId)).toBe("failed");
    expect(governance.getAttempt("review-attempt")?.failure).toMatchObject({ reasonCode: "review_report_missing", failureClass: "judgment", retryEligible: false });
    expect(governance.getTask(reviewer.qitemId)?.evidence).toEqual({ reasonCode: "review_report_missing" });
    expect(governance.getRun("run").retriesUsed).toBe(0);
    expect(leadTeamEvents(db, "run").some(event => event.key.startsWith("failed:task-review-1"))).toBe(true);
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
