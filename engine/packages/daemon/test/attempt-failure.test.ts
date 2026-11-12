import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import { composeAttemptCompletion } from "../src/domain/attempt-completion.js";
import {
  ATTEMPT_REASON_CODES, OWNER_ACTIONS, RETRY_ELIGIBLE_REASON_CODES, classifyAttemptFailure,
  classificationFor, parseAttemptClassification, type AttemptReasonCode,
} from "../src/domain/attempt-failure.js";
import { TEAM_CONTROL_VERSION, type ControlRequest, type PlanBinding } from "../src/contracts/team-control.js";

/**
 * T033 — the one classifier for a failed attempt, and the owner retry that reads it.
 *
 * KTD20 gives every failed attempt one reason code and a `resume_safe` flag, lets only five
 * codes retry, and says that when the evidence is uncertain the answer is "not retried". These
 * cases drive the production classifier over fixtures captured from evidence this repository
 * already carries, then drive the production retry command over the decision it recorded.
 */

interface Fixture {
  id: string;
  client: string;
  source: string;
  exit: number | null;
  tail: string | null;
  expected: { reasonCode: AttemptReasonCode; resumeSafe: boolean; retryEligible: boolean; failureClass: string } | null;
}
const fixtures = (JSON.parse(readFileSync(
  new URL("./fixtures/attempt-failure/client-errors.json", import.meta.url), "utf8")) as { fixtures: Fixture[] }).fixtures;

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const owner = { kind: "owner", sessionId: "owner-session" } as const;
const unavailable = { value: null, reason: "provider did not report usage" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };
const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: sha("a"), repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src", "test"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 2, policyFingerprint: sha("c"),
  limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
};
const identity = { nativeSessionId: "native-session", tmuxServer: "/control/tmux.sock", paneId: "%1", processId: 123,
  processStart: "process-start-1", generation: 1, policyFingerprint: binding.policyFingerprint };

describe("KTD20 classification of captured client errors", () => {
  it("maps every captured fixture to its code, resume safety and retry eligibility", () => {
    for (const fixture of fixtures) {
      const decision = classifyAttemptFailure({
        canceled: false,
        exit: fixture.exit === null ? null : { code: fixture.exit },
        terminalTail: fixture.tail, now: new Date(2026, 10, 7, 1, 0),
      });
      expect(decision, fixture.id).toEqual(fixture.expected === null ? null : {
        ...fixture.expected, ownerAction: OWNER_ACTIONS[fixture.expected.reasonCode],
        ...(fixture.expected.reasonCode === "agent_error.provider_quota" ? { resetAt: new Date(2026, 10, 7, 4, 14).toISOString() } : {}),
      });
    }
  });

  it("names a real source for every fixture instead of inventing provider output", () => {
    for (const fixture of fixtures) expect(fixture.source, fixture.id).not.toHaveLength(0);
  });

  it("never retries an unknown code, and never retries anything outside the current eligible set", () => {
    expect(classifyAttemptFailure({ canceled: false, exit: { code: 1 }, terminalTail: "segfault\n" }))
      .toMatchObject({ reasonCode: "agent_error.unknown", retryEligible: false });
    // Provider waits are retryable; judgment failures belong to the lead.
    expect([...RETRY_ELIGIBLE_REASON_CODES].sort()).toEqual([
      "agent_error.provider_network", "agent_error.provider_quota", "agent_error.provider_rate_limit", "agent_error.provider_server_error",
      "daemon_recovery", "run_timeout", "runtime_offline",
    ]);
    for (const code of ATTEMPT_REASON_CODES) {
      expect(classificationFor(code).retryEligible, code).toBe(RETRY_ELIGIBLE_REASON_CODES.includes(code));
      expect(classificationFor(code).ownerAction.length, code).toBeGreaterThan(0);
    }
  });

  it("names an integration conflict and never retries it", () => {
    // U7: the patch was approved and could not be applied to the run's branch. Replaying the
    // same patch onto the same branch fails the same way, so the repair is a task based on the
    // branch head, not a retry.
    expect(classificationFor("integration_conflict")).toMatchObject({ retryEligible: false, resumeSafe: true });
    expect(OWNER_ACTIONS.integration_conflict).toMatch(/integration branch/);
    expect(OWNER_ACTIONS.integration_conflict).toMatch(/lead/);
  });

  it("treats a cancelled run as the reason, whatever the exit or the pane says", () => {
    // A cancel is the owner's own action, so it outranks any fingerprint the client printed.
    expect(classifyAttemptFailure({ canceled: true, exit: { code: 1 }, terminalTail: "401 authentication_error\n" }))
      .toMatchObject({ reasonCode: "canceled", retryEligible: false });
    // A cancel is not a poisoned conversation: a later continuation may still resume.
    expect(classifyAttemptFailure({ canceled: true, exit: null, terminalTail: null })).toMatchObject({ resumeSafe: true });
  });

  it("does not read a failure marker the agent quoted, or one it already worked past", () => {
    // Inside a fence: quoted content, the same rule the Codex banner detector applies.
    expect(classifyAttemptFailure({ canceled: false, exit: { code: 0 },
      terminalTail: "Here is the error the test expects:\n```\nAPI Error: 401 authentication_error\n```\n" })).toBeNull();
    // In prose that merely mentions it: the line does not begin like a terminal error.
    expect(classifyAttemptFailure({ canceled: false, exit: { code: 0 },
      terminalTail: "The fixture asserts that 401 authentication_error is mirrored exactly once.\n" })).toBeNull();
    // Older than the tail the classifier reads: the agent recovered and finished its turn.
    const recovered = ["API Error: 529 overloaded_error", ...Array.from({ length: 60 }, (_, index) => `line ${index}`),
      "Done; the suite passes."].join("\n");
    expect(classifyAttemptFailure({ canceled: false, exit: { code: 0 }, terminalTail: recovered })).toBeNull();
  });

  it("reads the newest error first when a tail carries more than one", () => {
    const tail = "API Error: 529 overloaded_error\nretrying\n401 authentication_error: API key is invalid.\n";
    expect(classifyAttemptFailure({ canceled: false, exit: { code: 1 }, terminalTail: tail }))
      .toMatchObject({ reasonCode: "agent_error.provider_auth_or_access" });
  });

  it("refuses a stored classification that disagrees with its own code", () => {
    const valid = classificationFor("agent_error.provider_network");
    expect(parseAttemptClassification(valid)).toEqual(valid);
    // A row claiming an ineligible code may retry would grant authority KTD20 does not give.
    expect(() => parseAttemptClassification({ ...valid, reasonCode: "agent_error.provider_auth_or_access" }))
      .toThrow(/disagrees with the reason code/);
    expect(() => parseAttemptClassification({ ...valid, resumeSafe: false })).toThrow(/disagrees with the reason code/);
    expect(() => parseAttemptClassification({ ...valid, reasonCode: "agent_error.invented" })).toThrow(/no known reason code/);
    expect(() => parseAttemptClassification({ ...valid, ownerAction: "" })).toThrow(/no owner action/);
  });
});

describe("the owner retry reads the recorded classification", () => {
  let db: Database.Database;
  let governance: PlanGovernance;
  let nextKey: number;
  let alive: boolean;
  let sessions: SessionRegistry;
  let paneExit: { dead: boolean; code: number | null } | null;
  let paneTail: string | null;

  beforeEach(() => {
    db = createDb();
    initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'test')").run();
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, () => new Date("2026-10-14T00:00:00.000Z"),
      () => ({ policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint,
        verifiedProviders: ["claude", "codex"] as const }));
    governance.createRun({ id: "run-1", rigId: "rig-1", binding });
    const request = (actionId: string, payload: unknown, key?: string): ControlRequest<unknown> => ({
      protocolVersion: TEAM_CONTROL_VERSION, runId: "run-1", actionId,
      expectedEntityVersion: governance.getRun("run-1").entityVersion, idempotencyKey: key ?? `key-${++nextKey}`, payload });
    const plan = governance.requestApproval(request("plan-approval", {
      kind: "orchestrator", action: "implementation", payload: { bindingDigest: hashBinding(binding) },
      targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z",
    }, "plan-request"), { kind: "worker", sessionId: "builder@rig-1" });
    expect(plan.status).toBe("accepted");
    governance.decideApproval(request("plan-approval", { approvalVersion: 1, decision: "approved" }, "plan-decide"), owner, binding);
    const created = governance.createTask(request("task-1", {
      assignment: { taskId: "task-1", role: "implementer", paths: ["src/change.ts"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead@rig-1", destinationSession: "builder@rig-1", body: "Implement the approved scope",
    }), binding);
    expect(created.status).toBe("accepted");
    const node = new RigRepository(db).addNode("rig-1", "builder", { role: "implementer", runtime: "claude-code", cwd: "/workspace/project" });
    sessions = new SessionRegistry(db);
    const session = sessions.registerSession(node.id, "builder@rig-1");
    sessions.updateStartupStatus(session.id, "ready");
    sessions.updateResumeToken(session.id, "claude_id", "poisoned-native-session");
    nextKey = 0;
    alive = true;
    paneExit = { dead: false, code: null };
    paneTail = null;
  });
  afterEach(() => { if (db?.open) db.close(); });

  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId: "run-1", actionId,
    expectedEntityVersion: governance.getRun("run-1").entityVersion, idempotencyKey: `retry-${++nextKey}`, payload });

  const completion = () => composeAttemptCompletion({ db, governance, sessions, alive: () => alive,
    currentBinding: () => structuredClone(binding), log: () => {},
    paneExit: async () => paneExit, paneTail: async () => paneTail });

  /** Admit an attempt from a launch receipt, as the direct launch's own event does. */
  const launch = (attemptId = "attempt-1", seat = "builder@rig-1") => {
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig-1', 'node-1', 'managed.attempt.receipt', ?)")
      .run(JSON.stringify({ type: "managed.attempt.receipt", rigId: "rig-1", nodeId: "node-1", sessionId: "session-1",
        runId: "run-1", sessionName: seat, receipt: { attemptId, runId: "run-1", client: "claude-code",
          identity: { ...identity, nativeSessionId: attemptId } } }));
  };
  /** The owner records the outcome the daemon observed, which is what makes a task retryable. */
  const fail = (attemptId = "attempt-1") => {
    const task = governance.findTask("run-1", "task-1")!;
    const outcome = governance.recordTaskOutcome(command(task.qitemId, {
      expectedTaskVersion: task.entityVersion, state: "failed", actorSession: "builder@rig-1",
      attemptId, expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion,
      evidence: { observed: "client ended" },
    }), owner);
    expect(outcome.status).toBe("observed");
  };
  const retry = (attemptId = "attempt-1") => {
    const task = governance.findTask("run-1", "task-1")!;
    return governance.ownerCommand("retry", command(task.qitemId, {
      expectedTaskVersion: task.entityVersion, attemptId,
      expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion,
    }), owner, binding);
  };
  /** Run one attempt to its observed end with the given terminal evidence. */
  const end = async (exit: { dead: boolean; code: number | null } | null, tail: string | null) => {
    launch();
    const owner_ = completion();
    await owner_.sweep();
    expect(governance.getAttempt("attempt-1")?.state).toBe("running");
    alive = false;
    paneExit = exit;
    paneTail = tail;
    await owner_.sweep();
    expect(governance.getAttempt("attempt-1")?.state).toBe("stopped");
    return governance.getAttempt("attempt-1")!;
  };

  it("records the classifier's decision with the stop, from the pane's own exit status", async () => {
    const stopped = await end({ dead: true, code: 7 }, "Error: connect ECONNREFUSED 127.0.0.1:443\n");
    expect(stopped.failure).toEqual({ ...classificationFor("agent_error.provider_network"),
      ownerAction: OWNER_ACTIONS["agent_error.provider_network"] });
    // The decision is durable on the attempt row, so every later read gets the same answer.
    expect(governance.getAttempt("attempt-1")?.failure?.reasonCode).toBe("agent_error.provider_network");
  });

  it("spends maxRetries once for an eligible failure and refuses a second retry", async () => {
    await end({ dead: true, code: 7 }, "API Error: Unable to connect to API (ECONNREFUSED)\n");
    fail();
    const first = retry();
    expect(first).toMatchObject({ status: "accepted" });
    expect(governance.getRun("run-1").retriesUsed).toBe(1);
    // The budget is spent once: a replayed request does not count again, and a fresh one is refused.
    const task = governance.findTask("run-1", "task-1")!;
    expect(governance.ownerCommand("retry", command(task.qitemId, {
      expectedTaskVersion: task.entityVersion, attemptId: "attempt-1",
      expectedAttemptVersion: governance.getAttempt("attempt-1")!.entityVersion,
    }), owner, binding)).toMatchObject({ status: "denied" });
    expect(governance.getRun("run-1").retriesUsed).toBe(1);
  });

  it("refuses an ineligible failure and names the owner action", async () => {
    await end({ dead: true, code: 1 }, "401 authentication_error: API key is invalid.\n");
    fail();
    const refused = retry();
    expect(refused.status).toBe("denied");
    expect(refused.reason).toContain("agent_error.provider_auth_or_access");
    expect(refused.reason).toContain(OWNER_ACTIONS["agent_error.provider_auth_or_access"]);
    expect(governance.getRun("run-1").retriesUsed).toBe(0);
  });

  it("refuses a retry for an attempt that ended without a classification", async () => {
    // A clean exit is not a failure: nothing is recorded, so nothing may be retried on a guess.
    await end({ dead: true, code: 0 }, "Done. The module exports one constant.\n");
    expect(governance.getAttempt("attempt-1")?.failure).toBeNull();
    fail();
    expect(retry().reason).toMatch(/no classification/);
  });

  it.each(["failed", "ready"] as const)("does no pane work for a retired seat with status %s", async status => {
    const seat = sessions.findResumeContextByName("builder@rig-1")!;
    sessions.updateBinding(seat.nodeId, { attachmentType: "tmux", tmuxSession: "builder@rig-1", tmuxPane: "%1" });
    sessions.updateStartupStatus(seat.sessionId, status);
    db.prepare("UPDATE nodes SET retired_at = CURRENT_TIMESTAMP WHERE id = ?").run(seat.nodeId);
    const before = sessions.getSessionsForRig("rig-1").find(row => row.id === seat.sessionId);
    const { composeTaskDispatch } = await import("../src/domain/task-dispatch.js");
    const listPanes = vi.fn(async () => [{ id: "%1" }]), getPaneExit = vi.fn(async () => ({ dead: true, code: 0 }));
    const respawnPane = vi.fn(async () => ({ ok: true })), startNode = vi.fn(async () => ({ ok: true }));
    await composeTaskDispatch({ rigRepo: new RigRepository(db), sessions,
      tmux: { hasSession: async () => true, listPanes, getPaneExit, respawnPane } as never, startupOrchestrator: { startNode } as never,
      runtimeAdapters: { "claude-code": { runtime: "claude-code" } } as never,
      maxSessions: () => 2, liveSessions: () => 0,
    })("run-1", "task-1");
    for (const operation of [listPanes, getPaneExit, respawnPane, startNode]) expect(operation).not.toHaveBeenCalled();
    expect(sessions.getSessionsForRig("rig-1").find(row => row.id === seat.sessionId)).toEqual(before);
  });

  it("asks once for a launch the owner must decide, and never again at the same run version", async () => {
    // The live defect: a scope stage that refused an untouched candidate said
    // `plan-change-required: outside-write-paths` on every dispatch tick, so the event log filled
    // with `node.startup_failed` and the daemon log repeated the same line once a second. The
    // refusal is the owner's to answer, so it must be recorded once and then left alone — and an
    // owner action, which moves the run's entity version, is exactly what may ask once more.
    const { composeTaskDispatch, ownerActionRefusal } = await import("../src/domain/task-dispatch.js");
    expect(ownerActionRefusal("plan-change-required: outside-write-paths")).toBe(true);
    expect(ownerActionRefusal("extension-pending: owner-decision")).toBe(true);
    expect(ownerActionRefusal("listen EACCES: permission denied")).toBe(false);
    expect(ownerActionRefusal("Managed attempt task is not recorded")).toBe(false);
    const seat = sessions.findResumeContextByName("builder@rig-1")!;
    sessions.updateBinding(seat.nodeId, { attachmentType: "external_cli", tmuxSession: null, tmuxPane: null, tmuxWindow: null });
    sessions.updateStartupStatus(seat.sessionId, "pending");
    const startNode = vi.fn(async () => ({ ok: false as const, startupStatus: "failed" as const,
      errors: ["plan-change-required: outside-write-paths"] }));
    const dispatch = composeTaskDispatch({ rigRepo: new RigRepository(db), sessions, startupOrchestrator: { startNode } as never,
      runtimeAdapters: { "claude-code": { runtime: "claude-code", managedTransport: "direct" } } as never,
      maxSessions: () => 2, liveSessions: () => 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const _ of [1, 2, 3]) await dispatch("run-1", "task-1");
      expect(startNode).toHaveBeenCalledTimes(1);
      // The seat is left for the owner rather than re-armed for the next tick.
      expect(sessions.getSessionsForRig("rig-1").find(row => row.id === seat.sessionId)?.startupStatus)
        .toBe("attention_required");
      // An owner action moves the run's entity version, and only then is one more attempt spent.
      db.prepare("UPDATE team_runs SET entity_version = entity_version + 1 WHERE id = 'run-1'").run();
      await dispatch("run-1", "task-1");
      expect(startNode).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });

  it("retries a launch that failed for another reason on a doubling interval, not every tick", async () => {
    // The same loop with a non-governance cause: an endpoint this host cannot bind failed every
    // second and each refusal wrote a `node.startup_failed`. A failure that may be transient is
    // still retried, but on a bounded backoff rather than the sweep's cadence.
    const { composeTaskDispatch } = await import("../src/domain/task-dispatch.js");
    const seat = sessions.findResumeContextByName("builder@rig-1")!;
    sessions.updateBinding(seat.nodeId, { attachmentType: "external_cli", tmuxSession: null, tmuxPane: null, tmuxWindow: null });
    sessions.updateStartupStatus(seat.sessionId, "pending");
    let clock = Date.parse("2026-10-14T00:00:00.000Z");
    const startNode = vi.fn(async () => ({ ok: false as const, startupStatus: "failed" as const,
      errors: ["listen EACCES: permission denied mailbox.sock"] }));
    const dispatch = composeTaskDispatch({ rigRepo: new RigRepository(db), sessions, now: () => new Date(clock),
      startupOrchestrator: { startNode } as never,
      runtimeAdapters: { "claude-code": { runtime: "claude-code", managedTransport: "direct" } } as never,
      maxSessions: () => 2, liveSessions: () => 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await dispatch("run-1", "task-1");
      expect(startNode).toHaveBeenCalledTimes(1);
      // Inside the first interval nothing is asked again, however often the sweep calls.
      for (let tick = 0; tick < 9; tick++) { clock += 100; await dispatch("run-1", "task-1"); }
      expect(startNode).toHaveBeenCalledTimes(1);
      clock += 1_000;
      await dispatch("run-1", "task-1");
      expect(startNode).toHaveBeenCalledTimes(2);
      // The second wait is twice the first, and the cap is a minute.
      for (let tick = 0; tick < 10; tick++) { clock += 100; await dispatch("run-1", "task-1"); }
      expect(startNode).toHaveBeenCalledTimes(2);
      clock += 2_000;
      await dispatch("run-1", "task-1");
      expect(startNode).toHaveBeenCalledTimes(3);
    } finally { warn.mockRestore(); }
  });

});
