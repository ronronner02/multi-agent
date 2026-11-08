import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { classificationFor, OWNER_ACTIONS } from "../src/domain/attempt-failure.js";
import { TEAM_CONTROL_VERSION, LEAD_FAILED_REASON, type ControlRequest, type PlanBinding, type UsageEvidence } from "../src/contracts/team-control.js";
import { teamControlRoutes } from "../src/routes/team-control.js";

const owner = { kind: "owner", sessionId: "owner" } as const;
const worker = { kind: "worker", sessionId: "worker" } as const;
const daemon = { kind: "daemon", sessionId: "daemon" } as const;
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: digest("a"), repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 2, policyFingerprint: digest("c"),
  limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
};
const policy = () => ({ policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint,
  verifiedProviders: ["claude", "codex"] as const });
const unavailable = { value: null, reason: "not reported" };
const usage = (activeMs = 0): UsageEvidence => ({ activeMs, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable });

describe("U8 automatic recovery and Resume", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queue: QueueRepository;
  let governance: PlanGovernance;
  let now: Date;
  let serial: number;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus);
    now = new Date("2026-11-06T00:00:00.000Z");
    serial = 0;
    governance = new PlanGovernance(db, bus, queue, () => now, policy);
    governance.createRun({ id: "run", rigId: "rig", binding });
  });

  afterEach(() => db.close());

  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion,
    idempotencyKey: `u8-${++serial}`, payload,
  });

  const approve = () => {
    const approval = governance.requestApproval(command("implementation-request", {
      kind: "orchestrator", action: "implementation", payload: { bindingDigest: hashBinding(binding) },
      targetDigest: hashBinding(binding), expiresAt: "2026-11-07T00:00:00.000Z",
    }), worker);
    expect(approval.status).toBe("accepted");
    expect(governance.decideApproval(command(approval.value && typeof approval.value === "object" && "id" in approval.value
      ? String(approval.value.id) : "implementation-request", { approvalVersion: 1, decision: "approved" }), owner, binding).status).toBe("accepted");
  };

  const block = (reason: string) => {
    db.prepare("UPDATE team_runs SET state = 'blocked', state_reason = ? WHERE id = 'run'").run(reason);
  };

  /** One daemon-observed failed turn, recorded the way the completion sweep records it. */
  const failTask = (taskId: string, seat: string, role: "lead" | "implementer", attemptId: string,
    reasonCode: Parameters<typeof classificationFor>[0]) => {
    const task = governance.findTask("run", taskId)!;
    expect(governance.recordAttempt(command(attemptId, { qitemId: task.qitemId, role, provider: "claude",
      identity: { nativeSessionId: `native-${attemptId}`, tmuxServer: "/tmp/tmux.sock", paneId: "%1", processId: 4242,
        processStart: `${attemptId}-start`, generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage: usage() }), binding).status).toBe("observed");
    expect(governance.recordUsage(command(attemptId, {
      expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion, state: "stopped", usage: usage(),
      failure: classificationFor(reasonCode),
    })).status).toBe("observed");
    const outcome = governance.recordTaskOutcome(command(task.qitemId, {
      expectedTaskVersion: governance.getTask(task.qitemId)!.entityVersion, state: "failed", actorSession: seat, attemptId,
      expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion,
      evidence: { validated: false, reasonCode },
    }), daemon);
    expect(outcome.status, JSON.stringify(outcome)).toBe("observed");
  };

  it("renews a past 24-hour implementation approval at dispatch time and records a daemon action", () => {
    approve();
    db.prepare("UPDATE team_approvals SET expires_at = ? WHERE run_id = 'run' AND action = 'implementation'")
      .run("2026-11-05T23:30:00.000Z");

    expect(governance.renewImplementationApproval("run")).toBe(true);
    const approval = governance.listApprovals("run").find(row => row.action === "implementation");
    expect(approval).toMatchObject({ state: "approved", expiresAt: "2026-11-07T00:00:00.000Z", decisionActor: "daemon" });
    const event = db.prepare("SELECT payload FROM events WHERE json_extract(payload, '$.action') = 'approval.renewed' ORDER BY seq DESC LIMIT 1")
      .get() as { payload: string };
    expect(JSON.parse(event.payload).payload).toMatchObject({ observedBy: "daemon", approvalId: approval!.id });
  });

  it.each([
    ["lead-wake:hourly", {}],
    ["lead-wake:cycles", {}],
    ["review limit exhausted", {}],
    ["Initial attempt registration must precede work; elapsed intervals require reconciliation", {}],
    ["Clock moved backwards; budget reconciliation is required", {}],
    ["owner-paused", {}],
  ] as const)("resumes the blocked reason %s", (reason, payload) => {
    approve();
    block(reason);
    const receipt = governance.ownerCommand("resume", command("run", payload), owner, binding);
    expect(receipt).toMatchObject({ status: "observed", effectMayStart: true, reason: null });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", stateReason: null, stateReasonKey: null });
  });

  it("refuses a retry budget block without an increase and resumes with --add-retries", () => {
    approve();
    block("retry limit exhausted");
    expect(governance.ownerCommand("resume", command("run", {}), owner, binding)).toMatchObject({
      status: "denied", reason: expect.stringContaining("addRetries"), reasonKey: "team.reason.retryLimitExhausted",
    });
    const resumed = governance.ownerCommand("resume", command("run", { addRetries: 1 }), owner, binding);
    expect(resumed).toMatchObject({ status: "observed", effectMayStart: true });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", stateReason: null, binding: { limits: { maxRetries: 2 } } });
  });

  /**
   * KTD3 — a retry-eligible failure is retried by the daemon, without the owner. A lead cannot
   * wake itself, so when the run's budget is gone the run moves to the one state Resume handles
   * instead of sitting failed forever. This is the live acceptance run's second stall.
   */
  it("spends the run's retry on a retry-eligible lead failure, then blocks when the budget is gone", () => {
    approve();
    expect(governance.createTask(command("lead-task", {
      assignment: { taskId: "lead-task", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "owner", destinationSession: "lead@rig", body: "Decompose the plan",
    }), binding).status).toBe("accepted");
    const qitemId = governance.findTask("run", "lead-task")!.qitemId;

    failTask("lead-task", "lead@rig", "lead", "lead-attempt-1", "agent_error.provider_network");
    // One retry is spent by the daemon, and the lead's task is work nobody is doing again.
    expect(governance.getRun("run").retriesUsed).toBe(1);
    expect(governance.getRun("run").state).toBe("approved");
    expect(governance.queueState(qitemId)).toBe("pending");
    expect(governance.getTask(qitemId)!.evidence?.retryNotBefore).toBe("2026-11-06T00:02:00.000Z");

    now = new Date("2026-11-06T00:02:00.000Z");
    failTask("lead-task", "lead@rig", "lead", "lead-attempt-2", "agent_error.provider_network");
    // No budget left and no one to wake: the owner gets the one Resume action that adds it.
    expect(governance.getRun("run")).toMatchObject({ state: "blocked", stateReason: "retry limit exhausted",
      stateReasonKey: "team.reason.retryLimitExhausted" });
    const resumed = governance.ownerCommand("resume", command("run", { addRetries: 1 }), owner, binding);
    expect(resumed).toMatchObject({ status: "observed", resumeTaskIds: ["lead-task"] });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", binding: { limits: { maxRetries: 2 } } });
    // The click restarts the manager: the lead's failed task is back in the queue, not stranded.
    expect(governance.queueState(qitemId)).toBe("pending");
  });

  /**
   * A lead failure the classifier forbids retrying has no retry to spend and no one to wake, so
   * the run must reach the owner as a blocked run Resume can restart. Before this, it stayed
   * `approved` with a failed lead task and nothing ever happened again.
   */
  it.each([
    ["evidence_invalid", LEAD_FAILED_REASON, "team.reason.leadFailed"],
    ["agent_error.provider_auth_or_access", OWNER_ACTIONS["agent_error.provider_auth_or_access"], "team.reason.generic"],
  ] as const)("blocks a lead after %s without a retry, and Resume reopens it", (reasonCode, stateReason, stateReasonKey) => {
    approve();
    expect(governance.createTask(command("lead-task", {
      assignment: { taskId: "lead-task", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "owner", destinationSession: "lead@rig", body: "Decompose the plan",
    }), binding).status).toBe("accepted");
    const qitemId = governance.findTask("run", "lead-task")!.qitemId;

    failTask("lead-task", "lead@rig", "lead", "lead-attempt-1", reasonCode);
    expect(governance.getRun("run").retriesUsed).toBe(0);
    expect(governance.getRun("run")).toMatchObject({ state: "blocked", stateReason, stateReasonKey });
    expect(governance.queueState(qitemId)).toBe("failed");

    // One plain Resume: no budget increase, because nothing was spent.
    const resumed = governance.ownerCommand("resume", command("run", {}), owner, binding);
    expect(resumed).toMatchObject({ status: "observed", effectMayStart: true, resumeTaskIds: ["lead-task"] });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", stateReason: null });
    expect(governance.queueState(qitemId)).toBe("pending");
  });

  it("leaves an implementer's retry-eligible failure to the lead rather than blocking the run", () => {
    approve();
    expect(governance.createTask(command("task-1", {
      assignment: { taskId: "task-1", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Do the work",
    }), binding).status).toBe("accepted");
    const qitemId = governance.findTask("run", "task-1")!.qitemId;

    failTask("task-1", "builder@rig", "implementer", "attempt-1", "agent_error.provider_network");
    expect(governance.getTask(qitemId)!.evidence?.retryNotBefore).toBe("2026-11-06T00:02:00.000Z");
    now = new Date("2026-11-06T00:02:00.000Z");
    failTask("task-1", "builder@rig", "implementer", "attempt-2", "agent_error.provider_network");
    // The implementer's second failure is the lead's news: its budget is spent, but the lead can
    // still replace, split or re-scope the task without an owner decision.
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 1, stateReason: null });
    expect(governance.queueState(qitemId)).toBe("failed");
  });

  it("refuses a wall-clock budget block without an increase and resumes with --add-minutes", () => {
    approve();
    block("Active wall-clock budget exhausted");
    expect(governance.ownerCommand("resume", command("run", {}), owner, binding)).toMatchObject({
      status: "denied", reason: expect.stringContaining("addMinutes"), reasonKey: "team.reason.activeWallClockBudget",
    });
    const resumed = governance.ownerCommand("resume", command("run", { addMinutes: 5 }), owner, binding);
    expect(resumed).toMatchObject({ status: "observed", effectMayStart: true });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", stateReason: null, binding: { limits: { maxActiveMs: 3_900_000 } } });
  });

  it("returns pending work for the dispatcher when Resume clears a block", () => {
    approve();
    const created = governance.createTask(command("task-1", {
      assignment: { taskId: "task-1", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Do the work",
    }), binding);
    expect(created.status).toBe("accepted");
    block("lead-wake:cycles");
    const resumed = governance.ownerCommand("resume", command("run", {}), owner, binding);
    expect(resumed.resumeTaskIds).toEqual(["task-1"]);
  });

  it("reissues the implementation grant when the blocking transition revoked it", () => {
    approve();
    block("review limit exhausted");
    db.prepare("UPDATE team_approvals SET state = 'invalidated' WHERE action = 'implementation'").run();
    expect(governance.ownerCommand("resume", command("run", {}), owner, binding).status).toBe("observed");
    expect(governance.listApprovals("run").some(row => row.action === "implementation" && row.state === "approved")).toBe(true);
  });

  it("routes one Resume action to the pending task dispatcher", async () => {
    approve();
    const created = governance.createTask(command("task-1", {
      assignment: { taskId: "task-1", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Do the work",
    }), binding);
    expect(created.status).toBe("accepted");
    block("lead-wake:cycles");
    const dispatched: string[] = [];
    const app = teamControlRoutes(governance, { credentials: { ownerToken: "owner-token" }, resolveBinding: () => binding,
      dispatch: async (_runId, taskId) => { dispatched.push(taskId); } }, []);
    const run = governance.getRun("run");
    const response = await app.request("/runs/run/resume", {
      method: "POST", headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: TEAM_CONTROL_VERSION, runId: "run", actionId: "run",
        expectedEntityVersion: run.entityVersion, idempotencyKey: "route-resume", payload: {} }),
    }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(response.status).toBe(200);
    expect((await response.json()) as { effectMayStart: boolean }).toMatchObject({ effectMayStart: true });
    expect(dispatched).toEqual(["task-1"]);
  });

  it("publishes a stable label for an implementation dispatch denial", () => {
    approve();
    db.prepare("UPDATE team_approvals SET expires_at = ? WHERE action = 'implementation'").run("2026-11-05T23:00:00.000Z");
    const receipt = governance.recordAttempt(command("attempt", {
      qitemId: null, role: "lead", provider: "claude", identity: null, state: "unknown",
      unknownReason: "waiting for identity", usage: usage(),
    }), binding);
    expect(receipt).toMatchObject({ status: "denied", reason: "Implementation approval is not active",
      reasonKey: "team.reason.implementationApprovalInactive" });
    expect(governance.getRun("run").stateReasonKey).toBeNull();
  });
});
