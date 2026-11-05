import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
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
  expected: { reasonCode: AttemptReasonCode; resumeSafe: boolean; retryEligible: boolean } | null;
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
        terminalTail: fixture.tail,
      });
      expect(decision, fixture.id).toEqual(fixture.expected === null ? null : {
        ...fixture.expected, ownerAction: OWNER_ACTIONS[fixture.expected.reasonCode],
      });
    }
  });

  it("names a real source for every fixture instead of inventing provider output", () => {
    for (const fixture of fixtures) expect(fixture.source, fixture.id).not.toHaveLength(0);
  });

  it("never retries an unknown code, and never retries anything outside KTD20's eligible set", () => {
    expect(classifyAttemptFailure({ canceled: false, exit: { code: 1 }, terminalTail: "segfault\n" }))
      .toMatchObject({ reasonCode: "agent_error.unknown", retryEligible: false });
    // The eligible set includes the two daemon-owned evidence failures as one-shot retries.
    expect([...RETRY_ELIGIBLE_REASON_CODES].sort()).toEqual([
      "agent_error.provider_network", "daemon_recovery", "evidence_invalid", "no_progress", "review_report_missing", "run_timeout", "runtime_offline",
    ]);
    for (const code of ATTEMPT_REASON_CODES) {
      expect(classificationFor(code).retryEligible, code).toBe(RETRY_ELIGIBLE_REASON_CODES.includes(code));
      expect(classificationFor(code).ownerAction.length, code).toBeGreaterThan(0);
    }
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
    migrate(db, ALL_MIGRATIONS);
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

  it("starts a fresh session on the same tree after a resume-unsafe failure", async () => {
    const stopped = await end({ dead: true, code: 1 }, "API Error: 400 invalid_request_error\n");
    expect(stopped.failure).toMatchObject({ reasonCode: "agent_error.provider_invalid_request", resumeSafe: false });
    const seat = sessions.findResumeContextByName("builder@rig-1")!;
    // The seat still carries the poisoned native token until the continuation decides about it.
    expect(sessions.getSessionsForRig("rig-1").find(row => row.id === seat.sessionId)?.resumeToken).toBe("poisoned-native-session");
    const { composeTaskDispatch } = await import("../src/domain/task-dispatch.js");
    const started: Array<{ resumeToken?: string; continueSessionId?: string }> = [];
    // A recorded, live binding makes the dispatch resolve the seat's existing terminal instead
    // of opening one, so this case observes the launch decision and nothing about tmux.
    const nodeId = sessions.findResumeContextByName("builder@rig-1")!.nodeId;
    sessions.updateBinding(nodeId, { attachmentType: "tmux", tmuxSession: "builder@rig-1", tmuxPane: "%1" });
    const dispatch = composeTaskDispatch({
      rigRepo: new RigRepository(db), sessions,
      tmux: { listPanes: async () => [{ id: "%1" }] } as never,
      startupOrchestrator: { startNode: async (input: { resumeToken?: string; continueSessionId?: string }) => {
        started.push({ resumeToken: input.resumeToken, continueSessionId: input.continueSessionId });
        return { ok: true, startupStatus: "ready", continuityOutcome: "fresh" };
      } } as never,
      runtimeAdapters: { "claude-code": { runtime: "claude-code" } } as never,
      // This run has room, so the limit is not what decides this case.
      maxSessions: () => 2, liveSessions: () => 0,
    });
    sessions.updateStartupStatus(seat.sessionId, "pending");
    await dispatch("run-1", "task-1");
    expect(started).toHaveLength(1);
    // A fresh session: the token is gone, and the tree the attempt was admitted to is unchanged.
    expect(started[0]!.resumeToken).toBeUndefined();
    expect(started[0]!.continueSessionId).toBeUndefined();
    expect(sessions.getSessionsForRig("rig-1").find(row => row.id === seat.sessionId)?.resumeToken).toBeNull();
  });

  it("recovers a seat whose last launch failed, once, and then launches it", async () => {
    // Measured on the C4 acceptance run: a launch pasted into a held-but-dead pane, failed, and
    // left the seat `failed`. The dispatcher starts only a `pending` seat, and a managed daemon
    // refuses the legacy `rig seat clean` / `rig seat launch` verbs, so the seat stayed wedged for
    // the life of the run and the task it was starting could never be dispatched again.
    const seat = sessions.findResumeContextByName("builder@rig-1")!;
    const nodeId = seat.nodeId;
    sessions.updateBinding(nodeId, { attachmentType: "tmux", tmuxSession: "builder@rig-1", tmuxPane: "%1" });
    sessions.updateStartupStatus(seat.sessionId, "failed");
    const { composeTaskDispatch } = await import("../src/domain/task-dispatch.js");
    const started: unknown[] = [], respawned: string[] = [];
    const dispatchWith = (exit: { dead: boolean; code: number | null } | null) => composeTaskDispatch({
      rigRepo: new RigRepository(db), sessions,
      tmux: { listPanes: async () => [{ id: "%1" }], getPaneExit: async () => exit,
        respawnPane: async (pane: string) => { respawned.push(pane); return { ok: true }; } } as never,
      startupOrchestrator: { startNode: async (input: unknown) => {
        started.push(input);
        return { ok: true, startupStatus: "ready", continuityOutcome: "resumed" };
      } } as never,
      runtimeAdapters: { "claude-code": { runtime: "claude-code" } } as never,
      maxSessions: () => 2, liveSessions: () => 0,
    });
    // The seat's pane is dead: the recovery puts it back to a live shell before the launch, and
    // the seat is `pending` again, which is what the dispatcher reads.
    await dispatchWith({ dead: true, code: 0 })("run-1", "task-1");
    expect(respawned).toEqual(["%1"]);
    expect(started).toHaveLength(1);
    expect(sessions.getSessionsForRig("rig-1").find(row => row.id === seat.sessionId)?.startupStatus).not.toBe("failed");
    // The conversation, the tree and the token are untouched: this is a retry, not a reset.
    expect(sessions.getSessionsForRig("rig-1").find(row => row.id === seat.sessionId)?.resumeToken).toBe("poisoned-native-session");
    // A `ready` seat with a LIVE pane already has an agent, so it is not this dispatch's to
    // overwrite: no recovery and no launch.
    sessions.updateStartupStatus(seat.sessionId, "ready");
    await dispatchWith({ dead: false, code: null })("run-1", "task-1");
    expect(started).toHaveLength(1);
    expect(respawned).toEqual(["%1"]);
    // A `ready` seat whose pane is DEAD has no agent in it, and the status is stale rather than
    // true. Measured on the C4 acceptance run: the turn's attempt was never recorded, so the seat
    // stayed `ready` while its pane died, and the rework could never be dispatched.
    sessions.updateStartupStatus(seat.sessionId, "ready");
    await dispatchWith({ dead: true, code: 0 })("run-1", "task-1");
    expect(respawned).toEqual(["%1", "%1"]);
    expect(started).toHaveLength(2);
    // And a live pane on a failed seat is kept as it stands rather than respawned under an agent.
    sessions.updateStartupStatus(seat.sessionId, "failed");
    await dispatchWith({ dead: false, code: null })("run-1", "task-1");
    expect(respawned).toEqual(["%1", "%1"]);
    expect(started).toHaveLength(3);
    // U8 — attention_required is recoverable once per dispatch, just like a failed seat.
    sessions.updateStartupStatus(seat.sessionId, "attention_required");
    await dispatchWith({ dead: false, code: null })("run-1", "task-1");
    expect(started).toHaveLength(4);
    expect(sessions.getSessionsForRig("rig-1").find(row => row.id === seat.sessionId)?.startupStatus).not.toBe("attention_required");
  });

  it("reports the named startup reason when attention recovery remains wedged", async () => {
    const seat = sessions.findResumeContextByName("builder@rig-1")!;
    sessions.updateBinding(seat.nodeId, { attachmentType: "tmux", tmuxSession: "builder@rig-1", tmuxPane: "%1" });
    sessions.updateStartupStatus(seat.sessionId, "attention_required");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { composeTaskDispatch } = await import("../src/domain/task-dispatch.js");
      const dispatch = composeTaskDispatch({
        rigRepo: new RigRepository(db), sessions,
        tmux: { listPanes: async () => [{ id: "%1" }], getPaneExit: async () => ({ dead: false, code: null }) } as never,
        startupOrchestrator: { startNode: async () => ({ ok: false, startupStatus: "attention_required", errors: ["trust_gate"] }) } as never,
        runtimeAdapters: { "claude-code": { runtime: "claude-code" } } as never,
        maxSessions: () => 2, liveSessions: () => 0,
      });
      await dispatch("run-1", "task-1");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("trust_gate"));
    } finally {
      warning.mockRestore();
    }
  });
});
