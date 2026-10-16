import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QUEUE_STATES, isTerminalState } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import {
  TEAM_CONTROL_VERSION, TEAM_QUEUE_STATES, canonicalJson, parseAssignment, parseAttemptIdentity, parseControlRequest,
  parsePlanBinding, parseTeamEvent, parseUsage, type ControlRequest, type PlanBinding, type UsageEvidence,
} from "../src/team-control-surface.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const owner = { kind: "owner", sessionId: "owner-session" } as const;
const worker = { kind: "worker", sessionId: "worker-session" } as const;
const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: sha("a"), repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src", "test"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 2, policyFingerprint: sha("c"),
  limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
};
const verifiedPolicy = () => ({ policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint,
  verifiedProviders: ["claude", "codex"] as const });
const unavailable = { value: null, reason: "provider did not report usage" };
const usage = (activeMs = 0): UsageEvidence => ({ activeMs, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable });
const identity = { nativeSessionId: "native-session", tmuxServer: "/control/tmux.sock", paneId: "%1", processId: 123,
  processStart: "process-start-1", generation: 1, policyFingerprint: binding.policyFingerprint };

describe("shared team control contracts", () => {
  it("keeps the existing queue states and archive semantics without claiming handoff success", () => {
    expect(QUEUE_STATES).toBe(TEAM_QUEUE_STATES);
    expect(isTerminalState("handed-off")).toBe(true);
    expect(isTerminalState("failed")).toBe(false);
  });

  it.each([
    { artifactReadiness: "requirements-only" }, { artifactContract: "task-pack/v1" }, { status: "completed" },
    { writePaths: ["../outside"] }, { readPaths: ["/control"] }, { writePaths: ["src/**"] },
    { planDigest: "not-a-digest" }, { roles: ["owner"] }, { policyRevision: 0 },
    { repository: { ...binding.repository, identity: `git:${"a".repeat(42)}` } },
    { limits: { ...binding.limits, maxSessions: 4 } },
  ])("rejects an ineligible or unbounded plan binding: %j", (change) => {
    expect(() => parsePlanBinding({ ...binding, ...change })).toThrow();
  });

  it("preserves exact-byte plan changes rather than normalizing approval digests", () => {
    expect(hashBytes(Buffer.from("plan\n"))).not.toBe(hashBytes(Buffer.from("plan\r\n")));
    expect(hashBinding(binding)).not.toBe(hashBinding({ ...binding, planDigest: sha("d") }));
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(() => canonicalJson({ value: Number.NaN })).toThrow();
  });

  it("accepts additive minor protocol fields but rejects unknown major versions", () => {
    const request = { protocolVersion: "1.7", runId: "run", actionId: "action", expectedEntityVersion: 1, idempotencyKey: "key", payload: {}, optionalFutureField: true };
    expect(parseControlRequest(request).protocolVersion).toBe("1.7");
    expect(() => parseControlRequest({ ...request, protocolVersion: "2.0" })).toThrow();
    expect(() => parseAssignment({ taskId: "task", role: "implementer", paths: ["src"], dependencies: ["task"] })).toThrow();
  });

  it("keeps unavailable metrics null with a reason and distinguishes measured zero", () => {
    expect(parseUsage(usage()).inputTokens).toEqual(unavailable);
    expect(parseUsage({ ...usage(), inputTokens: { value: 0, reason: null } }).inputTokens.value).toBe(0);
    expect(() => parseUsage({ ...usage(), inputTokens: { value: null, reason: null } })).toThrow();
    expect(() => parseUsage({ ...usage(), inputTokens: { value: 1.5, reason: null } })).toThrow();
    expect(() => parseUsage({ ...usage(), activeMs: -1 })).toThrow();
  });

  it("rejects lossy JSON shapes instead of binding them to a different serialized payload", () => {
    expect(() => canonicalJson(new Array(1))).toThrow();
    expect(() => canonicalJson(Object.assign([], { ignored: "authority" }))).toThrow();
    expect(() => canonicalJson({ [Symbol("hidden")]: "authority" })).toThrow();
    const withGetter = Object.defineProperty({}, "a", { enumerable: true, get() { throw new Error("getter executed"); } });
    expect(() => canonicalJson(withGetter)).toThrow(/Invalid team contract/);
  });

  it("bounds direct request validation as well as downstream canonicalization", () => {
    const request = { protocolVersion: "1.0", runId: "run", actionId: "action", expectedEntityVersion: 1, idempotencyKey: "key", payload: "x".repeat(1_048_577) };
    expect(() => parseControlRequest(request)).toThrow(/payload_size/);
  });

  it.each(["@abstract", "default", "../tmux.sock"])("requires an absolute path socket for attempt identity: %s", (tmuxServer) => {
    expect(() => parseAttemptIdentity({ ...identity, tmuxServer })).toThrow();
  });
});

describe("transactional plan governance", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queue: QueueRepository;
  let governance: PlanGovernance;
  let now: Date;
  let nextKey: number;
  const directories: string[] = [];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'test')").run();
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus);
    now = new Date("2026-10-14T00:00:00.000Z");
    governance = new PlanGovernance(db, bus, queue, () => now, verifiedPolicy);
    nextKey = 0;
    governance.createRun({ id: "run-1", rigId: "rig-1", binding });
  });
  afterEach(() => {
    if (db.open) db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const command = (actionId: string, payload: unknown, key?: string): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId: "run-1", actionId,
    expectedEntityVersion: governance.getRun("run-1").entityVersion,
    idempotencyKey: key ?? `key-${++nextKey}`, payload,
  });
  const requestPlan = (expiresAt = "2026-10-14T01:00:00.000Z") => governance.requestApproval(command("plan-approval", {
    kind: "orchestrator", action: "implementation", payload: { bindingDigest: hashBinding(binding) },
    targetDigest: hashBinding(binding), expiresAt,
  }), worker);
  const approvePlan = (expiresAt?: string) => {
    requestPlan(expiresAt);
    governance.decideApproval(command("plan-approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
  };
  const recordAttempt = (id = "attempt-1", state = "running") => governance.recordAttempt(command(id, {
    qitemId: null, role: "lead", provider: "claude", identity: state === "unknown" ? null : { ...identity, nativeSessionId: id },
    unknownReason: state === "unknown" ? "restart identity not yet reconciled" : null, state, usage: usage(),
  }), binding);
  const requestCommit = () => governance.requestApproval(command("commit-approval", {
    kind: "orchestrator", action: "commit", payload: { candidateDigest: sha("d") }, targetDigest: sha("d"), expiresAt: "2026-10-14T01:00:00.000Z",
  }), worker);
  const createTask = () => governance.createTask(command("logical-task", {
    assignment: { taskId: "logical-task", role: "implementer", paths: ["src/change.ts"], dependencies: [] },
    sourceSession: "lead@rig-1", destinationSession: "builder@rig-1", body: "Implement the approved scope",
  }), binding);
  it("requires verified provider policy rather than a matching policy digest alone", () => {
    approvePlan();
    governance = new PlanGovernance(db, bus, queue, () => now);
    const receipt = createTask();
    expect(receipt.status).toBe("denied");
    expect(receipt.reason).toMatch(/provider.policy.*verified/i);
    expect(db.prepare("SELECT count(*) AS count FROM team_queue_authority").get()).toEqual({ count: 0 });
  });

  it.each([
    () => null,
    () => ({ ...verifiedPolicy(), policyRevision: binding.policyRevision + 1 }),
    () => ({ ...verifiedPolicy(), policyFingerprint: sha("d") }),
    () => ({ ...verifiedPolicy(), verifiedProviders: ["claude"] as const }),
    () => { throw new Error("policy evidence unavailable"); },
  ])("fails closed on unavailable, stale or incomplete provider capability", (readCapability) => {
    approvePlan();
    governance = new PlanGovernance(db, bus, queue, () => now, readCapability);
    expect(createTask()).toMatchObject({ status: "denied", effectMayStart: false });
    expect(db.prepare("SELECT count(*) AS count FROM team_queue_authority").get()).toEqual({ count: 0 });
  });

  it("does not leak the transactional queue grant to legacy writers", () => {
    approvePlan();
    const created = createTask();
    const qitemId = (created.value as { qitemId: string }).qitemId;
    expect(() => queue.update({ qitemId, actorSession: "owner-control", state: "in-progress" })).toThrow(/managed/i);
    expect(() => db.transaction(() => queue.updateWithinTransaction({ qitemId, actorSession: "owner-control", state: "done" }))()).toThrow(/managed/i);
    expect(() => queue.claim({ qitemId, destinationSession: "builder@rig-1" })).toThrow(/managed/i);
    expect(() => queue.unclaim(qitemId, "builder@rig-1", "forged owner")).toThrow(/managed/i);
    expect(queue.getById(qitemId)?.state).toBe("pending");
  });

  const useFileDatabase = () => {
    const directory = mkdtempSync(path.join(tmpdir(), "team-governance-"));
    directories.push(directory);
    const file = path.join(directory, "control.db");
    db.close();
    db = createDb(file); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'test')").run();
    bus = new EventBus(db); queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, () => now, verifiedPolicy);
    governance.createRun({ id: "run-1", rigId: "rig-1", binding });
    return file;
  };
  const reopen = (file: string) => {
    db.close(); db = createDb(file); bus = new EventBus(db); queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, () => now, verifiedPolicy);
  };

  it("creates a pending run and does not grant work just because its binding is well formed", () => {
    expect(governance.getRun("run-1").state).toBe("pending");
    expect(createTask().status).toBe("denied");
    expect(db.prepare("SELECT count(*) AS count FROM team_queue_authority").get()).toEqual({ count: 0 });
  });

  it("rejects a worker decision even when its payload claims owner identity", () => {
    requestPlan();
    expect(() => governance.decideApproval(command("plan-approval", { approvalVersion: 1, decision: "approved", actor: owner }), worker, binding)).toThrow(/owner/);
    expect(governance.getApproval("plan-approval")?.state).toBe("pending");
  });

  it("acknowledges an identical retried decision once and rejects key reuse with another payload", () => {
    requestPlan();
    const decision = command("plan-approval", { approvalVersion: 1, decision: "approved" }, "decision-1");
    const first = governance.decideApproval(decision, owner, binding);
    const events = db.prepare("SELECT count(*) AS count FROM events").get();
    expect(governance.decideApproval(decision, owner, binding)).toEqual({ ...first, replayed: true, effectMayStart: false });
    expect(db.prepare("SELECT count(*) AS count FROM events").get()).toEqual(events);
    expect(() => governance.decideApproval({ ...decision, payload: { approvalVersion: 1, decision: "rejected" } }, owner, binding)).toThrow(/idempotency/);
    expect(() => governance.decideApproval(decision, worker, binding)).toThrow(/owner/);
    expect(() => governance.decideApproval(decision, { ...owner, sessionId: "another-owner-session" }, binding)).toThrow(/idempotency/);
  });

  it("requires the exact implementation payload and does not let a native grant approve a plan", () => {
    expect(governance.requestApproval(command("mismatched-plan", {
      kind: "orchestrator", action: "implementation", payload: { bindingDigest: hashBinding(binding) },
      targetDigest: sha("d"), expiresAt: "2026-10-14T01:00:00.000Z",
    }), worker).status).toBe("denied");
    expect(() => governance.requestApproval(command("native-plan", {
      kind: "native", action: "implementation", payload: {}, targetDigest: hashBinding(binding), expiresAt: "2026-10-14T01:00:00.000Z",
    }), worker)).toThrow();
    expect(governance.getRun("run-1").state).toBe("pending");
  });

  it("keeps a rejection through controller recreation and stops a renamed duplicate request", () => {
    requestPlan();
    governance.decideApproval(command("plan-approval", { approvalVersion: 1, decision: "rejected" }), owner, binding);
    governance = new PlanGovernance(db, new EventBus(db), new QueueRepository(db, new EventBus(db)), () => now, verifiedPolicy);
    expect(governance.getApproval("plan-approval")?.state).toBe("rejected");
    expect(governance.requestApproval(command("new-plan-approval", {
      kind: "orchestrator", action: "implementation", payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-10-14T01:00:00.000Z",
    }), worker).status).toBe("denied");
  });

  it.each(["approve-first", "cancel-first"])("serializes competing approve and cancel decisions: %s", (order) => {
    requestPlan();
    const approve = command("plan-approval", { approvalVersion: 1, decision: "approved" });
    const cancel = command("cancel", { reason: "owner stop" });
    if (order === "approve-first") {
      governance.decideApproval(approve, owner, binding);
      expect(() => governance.cancelRun(cancel, owner)).toThrow(/version/);
      expect(governance.getRun("run-1").state).toBe("approved");
    } else {
      governance.cancelRun(cancel, owner);
      expect(() => governance.decideApproval(approve, owner, binding)).toThrow(/version/);
      expect(governance.getRun("run-1").state).toBe("cancel_requested");
      expect(governance.getApproval("plan-approval")?.state).toBe("invalidated");
    }
  });

  it.each([
    { planDigest: sha("e") }, { repository: { ...binding.repository, identity: `git:${"f".repeat(40)}` } },
    { policyRevision: 3 }, { artifactReadiness: "requirements-only" },
  ])("durably invalidates unused grants on changed or ineligible source: %j", (change) => {
    approvePlan();
    const result = governance.reconcileBinding(command("observe", { ...binding, ...change }));
    expect(result.status).toBe("denied");
    expect(governance.getRun("run-1").state).toBe("invalidated");
    expect(governance.getApproval("plan-approval")?.state).toBe("invalidated");
    expect(createTask().status).toBe("denied");
  });

  it("creates and transitions the existing queue atomically with authority and post-commit events", () => {
    approvePlan();
    const observed: Array<{ transaction: boolean; action: string }> = [];
    bus.subscribe((event) => {
      if (event.type === "team.control") {
        parseTeamEvent(event);
        observed.push({ transaction: db.inTransaction, action: event.action });
      }
    });
    const created = createTask();
    const qitemId = (created.value as { qitemId: string }).qitemId;
    expect(queue.getById(qitemId)?.state).toBe("pending");
    governance.transitionTask(command(qitemId, { expectedTaskVersion: 1, state: "in-progress", actorSession: "builder@rig-1" }), binding);
    expect(queue.getById(qitemId)?.state).toBe("in-progress");
    expect(governance.getTask(qitemId)?.entityVersion).toBe(2);
    expect(observed.map((event) => event.transaction)).toEqual([false, false]);
    expect(observed.map((event) => event.action)).toEqual(["task.created", "task.transitioned"]);
  });

  it("rolls back the queue, authority record and all events on persistence failure", () => {
    approvePlan();
    const before = db.prepare("SELECT count(*) AS count FROM events").get();
    const version = governance.getRun("run-1").entityVersion;
    db.exec("CREATE TRIGGER fail_team_event BEFORE INSERT ON events WHEN NEW.type = 'team.control' BEGIN SELECT RAISE(ABORT, 'simulated persistence failure'); END");
    const delivered: unknown[] = [];
    bus.subscribe((event) => delivered.push(event));
    expect(() => createTask()).toThrow(/simulated persistence failure/);
    expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM team_queue_authority").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM events").get()).toEqual(before);
    expect(governance.getRun("run-1").entityVersion).toBe(version);
    expect(delivered).toEqual([]);
  });

  it("rolls back every participant if receipt persistence fails, and then accepts the same request once", () => {
    approvePlan();
    const request = command("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["src/a.ts"], dependencies: [] },
      sourceSession: "lead@rig-1", destinationSession: "builder@rig-1", body: "A task",
    }, "failed-receipt");
    const eventsBefore = db.prepare("SELECT count(*) AS count FROM events").get();
    const delivered: unknown[] = [];
    bus.subscribe((event) => delivered.push(event));
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON team_control_requests BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
    expect(() => governance.createTask(request, binding)).toThrow(/receipt failure/);
    expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM team_queue_authority").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM events").get()).toEqual(eventsBefore);
    expect(delivered).toEqual([]);
    db.exec("DROP TRIGGER fail_receipt");
    expect(governance.createTask(request, binding).status).toBe("accepted");
    expect(governance.createTask(request, binding).replayed).toBe(true);
    expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 1 });
  });

  it("rejects adjacent path prefixes and records task evidence without another queue-state field", () => {
    approvePlan();
    expect(governance.createTask(command("outside", {
      assignment: { taskId: "outside", role: "implementer", paths: ["src-other/a.ts"], dependencies: [] },
      sourceSession: "lead@rig-1", destinationSession: "builder@rig-1", body: "Outside the scope",
    }), binding).status).toBe("denied");
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.transitionTask(command(qitemId, { expectedTaskVersion: 1, state: "in-progress", actorSession: "builder@rig-1", evidence: { artifactDigest: sha("d") } }), binding);
    expect(governance.getTask(qitemId)?.evidence).toEqual({ artifactDigest: sha("d") });
    expect(() => governance.transitionTask(command(qitemId, { expectedTaskVersion: 1, state: "blocked", actorSession: "builder@rig-1" }), binding)).toThrow(/version/);
    expect(queue.getById(qitemId)?.state).toBe("in-progress");
  });

  it("emits references rather than copying arbitrary approval payloads into the event stream", () => {
    approvePlan();
    governance.requestApproval(command("private-action", {
      kind: "orchestrator", action: "commit", payload: { privateInput: "sensitive-fixture-content" },
      targetDigest: sha("d"), expiresAt: "2026-10-14T01:00:00.000Z",
    }), worker);
    expect(governance.getApproval("private-action")?.payload).toEqual({ privateInput: "sensitive-fixture-content" });
    expect(JSON.stringify(bus.replayAll(0))).not.toContain("sensitive-fixture-content");
  });

  it("rejects an outer transaction so nested commit cannot publish uncommitted authority", () => {
    expect(() => db.transaction(() => requestPlan())()).toThrow(/outer transaction/);
    expect(governance.getApproval("plan-approval")).toBeNull();
  });

  it("keeps a stopped queue outcome separate from cancellation intent", () => {
    approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.cancelRun(command("cancel", { reason: "owner stop" }), owner);
    expect(governance.getRun("run-1").state).toBe("cancel_requested");
    expect(queue.getById(qitemId)?.state).toBe("pending");
  });

  it("records an admitted task's outcome after cancellation but admits no new task", () => {
    approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.recordAttempt(command("task-attempt", { qitemId, role: "implementer", provider: "claude", identity,
      unknownReason: null, state: "stopped", usage: usage() }), binding);
    governance.cancelRun(command("cancel", { reason: "owner stop" }), owner);
    expect(governance.recordTaskOutcome(command(qitemId, { expectedTaskVersion: 1, state: "failed", actorSession: "builder@rig-1",
      attemptId: "task-attempt", expectedAttemptVersion: 1, evidence: { receipt: "observed-exit" } }), owner).status).toBe("observed");
    expect(queue.getById(qitemId)?.state).toBe("failed");
    expect(governance.createTask(command("next-task", {
      assignment: { taskId: "next-task", role: "implementer", paths: ["src/next.ts"], dependencies: [] },
      sourceSession: "lead@rig-1", destinationSession: "builder@rig-1", body: "Start more work",
    }), binding).status).toBe("denied");
  });

  it.each(["done", "failed", "denied", "canceled", "handed-off"])("denies ordinary %s transitions in an approved run with a live attempt", (state) => {
    approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.recordAttempt(command("task-attempt", { qitemId, role: "implementer", provider: "claude", identity,
      unknownReason: null, state: "running", usage: usage() }), binding);
    const result = governance.transitionTask(command(qitemId, { expectedTaskVersion: 1, state, actorSession: "builder@rig-1",
      ...(state === "done" ? { closureReason: "no-follow-on" } : {}), evidence: { receipt: "not-observed" } }), binding);
    expect(result).toMatchObject({ status: "denied", effectMayStart: false });
    expect(queue.getById(qitemId)?.state).toBe("pending");
    expect(governance.getAttempt("task-attempt")?.state).toBe("running");
    expect(governance.getRun("run-1")).toMatchObject({ state: "approved", retriesUsed: 0 });
  });

  it.each(["failed", "denied"])("does not silently reopen an observed %s task while its run remains approved", (state) => {
    approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.recordAttempt(command("task-attempt", { qitemId, role: "implementer", provider: "claude", identity,
      unknownReason: null, state: "stopped", usage: usage() }), binding);
    expect(governance.recordTaskOutcome(command(qitemId, { expectedTaskVersion: 1, state, actorSession: "builder@rig-1",
      attemptId: "task-attempt", expectedAttemptVersion: 1, evidence: { receipt: "observed-exit" } }), owner).status).toBe("observed");
    expect(governance.transitionTask(command(qitemId, { expectedTaskVersion: 2, state: "in-progress", actorSession: "builder@rig-1" }), binding).status).toBe("denied");
    expect(queue.getById(qitemId)?.state).toBe(state);
    expect(governance.getRun("run-1")).toMatchObject({ state: "approved", retriesUsed: 0 });
  });

  it("retains readable owner attribution for a task observation through a database reopen", () => {
    const file = useFileDatabase(); approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.recordAttempt(command("task-attempt", { qitemId, role: "implementer", provider: "claude", identity,
      unknownReason: null, state: "stopped", usage: usage() }), binding);
    const request = command(qitemId, { expectedTaskVersion: 1, state: "done", closureReason: "no-follow-on", actorSession: "builder@rig-1",
      attemptId: "task-attempt", expectedAttemptVersion: 1, evidence: { receipt: "verified-exit" } });
    governance.recordTaskOutcome(request, owner); reopen(file);
    const transition = queue.listTransitions(qitemId).find((entry) => entry.state === "done");
    expect(transition).toMatchObject({ actorSession: owner.sessionId });
    expect(transition?.transitionNote).toContain("Owner observation of builder@rig-1");
    const events = (db.prepare("SELECT payload FROM events WHERE type = 'team.control'").all() as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload)).filter((event) => event.action === "task.outcome");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ attemptId: "task-attempt", payload: { observedBy: owner.sessionId } });
    expect(governance.recordTaskOutcome(request, owner).replayed).toBe(true);
    expect(queue.listTransitions(qitemId).filter((entry) => entry.state === "done")).toHaveLength(1);
  });

  it.each(["cancel", "blocked", "invalidated", "expired"])("records a stopped task outcome after %s without reopening dispatch", (closedBy) => {
    approvePlan("2026-10-14T00:00:01.000Z");
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.transitionTask(command(qitemId, { expectedTaskVersion: 1, state: "in-progress", actorSession: "builder@rig-1" }), binding);
    governance.recordAttempt(command("task-attempt", { qitemId, role: "implementer", provider: "claude", identity,
      unknownReason: null, state: "running", usage: usage() }), binding);
    if (closedBy === "cancel") governance.cancelRun(command("cancel", { reason: "owner stop" }), owner);
    if (closedBy === "invalidated") governance.reconcileBinding(command("drift", { ...binding, planDigest: sha("e") }));
    now = new Date(closedBy === "blocked" ? "2026-10-14T01:00:00.001Z" : "2026-10-14T00:00:02.000Z");
    governance.recordUsage(command("task-attempt", { expectedAttemptVersion: 1, state: "stopped", usage: usage(2000) }));
    const state = closedBy === "cancel" ? "canceled" : "done";
    const payload = { expectedTaskVersion: 2, state, actorSession: "builder@rig-1", ...(state === "done" ? { closureReason: "no-follow-on" } : {}),
      attemptId: "task-attempt", expectedAttemptVersion: 2, evidence: { receipt: "observed-native-exit", tests: "verified-result" } };
    expect(governance.transitionTask(command(qitemId, payload), binding).status).toBe("denied");
    const closedState = governance.getRun("run-1").state;
    const notifications: boolean[] = [];
    bus.subscribe(() => notifications.push(db.inTransaction));
    const request = command(qitemId, payload);
    expect(governance.recordTaskOutcome(request, owner)).toMatchObject({ status: "observed", effectMayStart: false });
    expect(queue.getById(qitemId)?.state).toBe(state);
    expect(governance.getTask(qitemId)).toMatchObject({ entityVersion: 3, evidence: payload.evidence });
    expect(governance.getRun("run-1").state).toBe(closedState);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.every((inTransaction) => !inTransaction)).toBe(true);
    const count = notifications.length;
    expect(governance.recordTaskOutcome(request, owner)).toMatchObject({ replayed: true, effectMayStart: false });
    expect(notifications).toHaveLength(count);
    expect(governance.transitionTask(command(qitemId, { expectedTaskVersion: 3, state: "in-progress", actorSession: "builder@rig-1" }), binding).status).toBe("denied");
  });

  it.each(["running", "unknown"])("does not infer a stopped task outcome from a %s attempt", (state) => {
    approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.recordAttempt(command("task-attempt", { qitemId, role: "implementer", provider: "claude", identity,
      unknownReason: null, state: "running", usage: usage() }), binding);
    if (state === "unknown") governance.recordUsage(command("task-attempt", { expectedAttemptVersion: 1, state, usage: usage(), unknownReason: "exit not verified" }));
    governance.cancelRun(command("cancel", { reason: "intent only" }), owner);
    expect(governance.recordTaskOutcome(command(qitemId, { expectedTaskVersion: 1, state: "canceled", actorSession: "builder@rig-1",
      attemptId: "task-attempt", expectedAttemptVersion: state === "unknown" ? 2 : 1, evidence: { receipt: "unverified-exit" } }), owner).status).toBe("denied");
    expect(queue.getById(qitemId)?.state).toBe("pending");
  });

  it("requires owner observation authority, exact task membership, versions and nonempty evidence", () => {
    approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.recordAttempt(command("task-attempt", { qitemId, role: "implementer", provider: "claude", identity,
      unknownReason: null, state: "stopped", usage: usage() }), binding);
    const payload = { expectedTaskVersion: 1, state: "failed", actorSession: "builder@rig-1", attemptId: "task-attempt",
      expectedAttemptVersion: 1, evidence: { receipt: "native-exit-1" } };
    expect(() => governance.recordTaskOutcome(command(qitemId, payload), worker)).toThrow(/owner/);
    expect(() => governance.recordTaskOutcome(command(qitemId, { ...payload, expectedTaskVersion: 9 }), owner)).toThrow(/Task version/);
    expect(() => governance.recordTaskOutcome(command(qitemId, { ...payload, expectedAttemptVersion: 9 }), owner)).toThrow(/Attempt version/);
    expect(() => governance.recordTaskOutcome(command(qitemId, { ...payload, evidence: {} }), owner)).toThrow(/evidence/);
    expect(governance.recordTaskOutcome(command(qitemId, { ...payload, attemptId: "missing" }), owner).status).toBe("denied");
    expect(governance.recordTaskOutcome(command(qitemId, { ...payload, actorSession: "unrelated" }), owner).status).toBe("denied");
    expect(governance.recordTaskOutcome(command(qitemId, { ...payload, state: "in-progress" }), owner).status).toBe("denied");
    recordAttempt("unassigned", "stopped");
    expect(governance.recordTaskOutcome(command(qitemId, { ...payload, attemptId: "unassigned" }), owner).status).toBe("denied");
    expect(queue.getById(qitemId)?.state).toBe("pending");
    expect(governance.recordTaskOutcome(command(qitemId, payload), owner).status).toBe("observed");
    expect(governance.recordTaskOutcome(command(qitemId, { ...payload, expectedTaskVersion: 2, state: "canceled" }), owner).status).toBe("denied");
  });

  it("rejects an older stopped attempt and any still-live task attempt when recording an outcome", () => {
    approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    for (const [id, state] of [["old", "stopped"], ["current", "running"]]) {
      governance.recordAttempt(command(id, { qitemId, role: "implementer", provider: "claude", identity: { ...identity, nativeSessionId: id },
        unknownReason: null, state, usage: usage() }), binding);
    }
    const payload = { expectedTaskVersion: 1, state: "canceled", actorSession: "builder@rig-1", attemptId: "old",
      expectedAttemptVersion: 1, evidence: { receipt: "old-exit" } };
    expect(governance.recordTaskOutcome(command(qitemId, payload), owner).status).toBe("denied");
    governance.recordUsage(command("current", { expectedAttemptVersion: 1, state: "stopped", usage: usage() }));
    expect(governance.recordTaskOutcome(command(qitemId, payload), owner).status).toBe("denied");
    expect(governance.recordTaskOutcome(command(qitemId, { ...payload, attemptId: "current", expectedAttemptVersion: 2 }), owner).status).toBe("observed");
  });

  it("rolls back a stopped task outcome and notifications if its durable receipt fails", () => {
    approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.recordAttempt(command("task-attempt", { qitemId, role: "implementer", provider: "claude", identity,
      unknownReason: null, state: "stopped", usage: usage() }), binding);
    governance.cancelRun(command("cancel", { reason: "owner stop" }), owner);
    const request = command(qitemId, { expectedTaskVersion: 1, state: "canceled", actorSession: "builder@rig-1",
      attemptId: "task-attempt", expectedAttemptVersion: 1, evidence: { receipt: "observed-exit" } });
    const before = db.prepare("SELECT count(*) AS n FROM events").get();
    const notifications: unknown[] = []; bus.subscribe((event) => notifications.push(event));
    db.exec("CREATE TRIGGER reject_outcome BEFORE INSERT ON team_control_requests BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
    expect(() => governance.recordTaskOutcome(request, owner)).toThrow(/receipt failed/);
    expect(queue.getById(qitemId)?.state).toBe("pending");
    expect(governance.getTask(qitemId)).toMatchObject({ entityVersion: 1, evidence: null });
    expect(db.prepare("SELECT count(*) AS n FROM events").get()).toEqual(before);
    expect(notifications).toEqual([]);
    db.exec("DROP TRIGGER reject_outcome");
    expect(governance.recordTaskOutcome(request, owner).status).toBe("observed");
  });

  it("binds operation consumption to the payload, target, kind and exact attempt", () => {
    approvePlan();
    recordAttempt();
    requestCommit();
    governance.decideApproval(command("commit-approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    const payload = { kind: "orchestrator", action: "commit", payload: { candidateDigest: sha("d") }, targetDigest: sha("d"), attemptId: "attempt-1" };
    expect(governance.reserveApproval(command("commit-approval", { ...payload, kind: "native" }), binding).status).toBe("denied");
    expect(governance.reserveApproval(command("commit-approval", { ...payload, payload: { candidateDigest: sha("e") } }), binding).status).toBe("denied");
    expect(governance.reserveApproval(command("commit-approval", { ...payload, targetDigest: sha("e") }), binding).status).toBe("denied");
    expect(governance.reserveApproval(command("commit-approval", { ...payload, attemptId: "missing" }), binding).status).toBe("denied");
    const consume = command("commit-approval", payload, "consume-once");
    expect(governance.reserveApproval(consume, binding).effectMayStart).toBe(true);
    expect(governance.reserveApproval(consume, binding).effectMayStart).toBe(false);
    expect(governance.reserveApproval(command("commit-approval", payload), binding).effectMayStart).toBe(false);
    expect(governance.getConsumption("commit-approval")?.state).toBe("reserved");
    governance.recordOutcome(command("commit-approval", { state: "ambiguous", receipt: { reason: "lost native outcome" } }));
    expect(governance.getConsumption("commit-approval")?.state).toBe("ambiguous");
    expect(governance.reserveApproval(command("commit-approval", payload), binding).effectMayStart).toBe(false);
  });

  it("retains a reserved operation across lost acknowledgement, cancellation and a real database reopen", () => {
    const file = useFileDatabase();
    approvePlan(); recordAttempt(); requestCommit();
    governance.decideApproval(command("commit-approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    const request = command("commit-approval", { kind: "orchestrator", action: "commit", payload: { candidateDigest: sha("d") }, targetDigest: sha("d"), attemptId: "attempt-1" });
    expect(governance.reserveApproval(request, binding).effectMayStart).toBe(true);
    reopen(file);
    expect(governance.reserveApproval(request, binding).effectMayStart).toBe(false);
    expect(governance.getConsumption("commit-approval")?.attemptId).toBe("attempt-1");
    governance.cancelRun(command("cancel", { reason: "owner stop" }), owner);
    expect(governance.getApproval("commit-approval")?.state).toBe("approved");
    expect(governance.getApproval("plan-approval")?.state).toBe("invalidated");
    governance.recordOutcome(command("commit-approval", { state: "ambiguous", receipt: { reason: "effect may have started before cancellation" } }));
    expect(governance.getConsumption("commit-approval")?.state).toBe("ambiguous");
    expect(governance.getRun("run-1").state).toBe("cancel_requested");
  });

  it("grants no permission to start an effect if the reservation receipt fails to persist", () => {
    approvePlan(); recordAttempt(); requestCommit();
    governance.decideApproval(command("commit-approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    const request = command("commit-approval", { kind: "orchestrator", action: "commit", payload: { candidateDigest: sha("d") }, targetDigest: sha("d"), attemptId: "attempt-1" });
    const delivered: unknown[] = [];
    bus.subscribe((event) => delivered.push(event));
    db.exec("CREATE TRIGGER fail_reservation BEFORE INSERT ON team_control_requests BEGIN SELECT RAISE(ABORT, 'reservation receipt failure'); END");
    expect(() => governance.reserveApproval(request, binding)).toThrow(/receipt failure/);
    expect(governance.getConsumption("commit-approval")).toBeNull();
    expect(delivered).toEqual([]);
    db.exec("DROP TRIGGER fail_reservation");
    expect(governance.reserveApproval(request, binding).effectMayStart).toBe(true);
  });

  it.each(["task", "reservation"])("rolls back a %s when the outer COMMIT fails", (kind) => {
    approvePlan();
    if (kind === "reservation") {
      recordAttempt(); requestCommit();
      governance.decideApproval(command("commit-approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    }
    const request = kind === "task" ? command("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["src/a.ts"], dependencies: [] },
      sourceSession: "lead@rig-1", destinationSession: "builder@rig-1", body: "A task",
    }) : command("commit-approval", { kind: "orchestrator", action: "commit", payload: { candidateDigest: sha("d") }, targetDigest: sha("d"), attemptId: "attempt-1" });
    const invoke = () => kind === "task" ? governance.createTask(request, binding) : governance.reserveApproval(request, binding);
    const counts = () => ["queue_items", "team_queue_authority", "team_approval_consumptions", "team_control_requests", "events"]
      .map((table) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get());
    const before = counts();
    const version = governance.getRun("run-1").entityVersion;
    const delivered: unknown[] = [];
    bus.subscribe((event) => delivered.push(event));
    db.exec(`CREATE TABLE commit_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE commit_fault (parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_at_commit AFTER INSERT ON team_control_requests BEGIN INSERT INTO commit_fault VALUES (-1); END;`);
    expect(() => invoke()).toThrow(/FOREIGN KEY/);
    expect(db.inTransaction).toBe(false);
    expect(counts()).toEqual(before);
    expect(governance.getRun("run-1").entityVersion).toBe(version);
    expect(db.prepare("SELECT * FROM commit_fault").all()).toEqual([]);
    expect(delivered).toEqual([]);
    db.exec("DROP TRIGGER fail_at_commit");
    const first = invoke();
    expect(first.status).toBe(kind === "task" ? "accepted" : "pending-execution");
    expect(first.effectMayStart).toBe(kind === "reservation");
    expect(invoke()).toEqual({ ...first, replayed: true, effectMayStart: false });
  });

  it("rejects cross-run task and approval references at the domain and foreign-key boundaries", () => {
    approvePlan();
    const qitemId = (createTask().value as { qitemId: string }).qitemId;
    governance.createRun({ id: "run-2", rigId: "rig-1", binding });
    const secondCommand = (actionId: string, payload: unknown) => ({ ...command(actionId, payload), runId: "run-2", expectedEntityVersion: governance.getRun("run-2").entityVersion });
    governance.requestApproval(secondCommand("plan-2", { kind: "orchestrator", action: "implementation", payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-10-14T01:00:00.000Z" }), worker);
    governance.decideApproval(secondCommand("plan-2", { approvalVersion: 1, decision: "approved" }), owner, binding);
    expect(() => governance.transitionTask(secondCommand(qitemId, { expectedTaskVersion: 1, state: "in-progress", actorSession: "builder@rig-1" }), binding)).toThrow(/this run/);
    expect(() => governance.decideApproval(secondCommand("plan-approval", { approvalVersion: 2, decision: "approved" }), owner, binding)).toThrow(/this run/);
    expect(() => governance.recordAttempt(secondCommand("foreign-attempt", { qitemId, role: "implementer", provider: "codex", identity, state: "running", unknownReason: null, usage: usage() }), binding)).toThrow(/this run/);
    expect(() => db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, state, usage_json, active_ms, created_at, updated_at)
      VALUES ('foreign-attempt', 'run-2', ?, 'implementer', 'codex', ?, 'running', ?, 0, ?, ?)`)
      .run(qitemId, canonicalJson(identity), canonicalJson(usage()), now.toISOString(), now.toISOString())).toThrow(/FOREIGN KEY/);
    expect(queue.getById(qitemId)?.state).toBe("pending");
  });

  it("records expiry and denies dispatch without erasing the original approval", () => {
    approvePlan();
    recordAttempt();
    requestCommit();
    governance.decideApproval(command("commit-approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    now = new Date("2026-10-14T01:00:00.000Z");
    expect(createTask().status).toBe("denied");
    expect(governance.getApproval("commit-approval")?.state).toBe("expired");
  });

  it("renews an expired plan only through a new pending owner decision without resetting counters", () => {
    const file = useFileDatabase();
    approvePlan("2026-10-14T00:00:01.000Z");
    governance.recordCycle(command("retry-1", { kind: "retry", reason: "diagnosed retry" }), binding);
    governance.recordCycle(command("review-1", { kind: "review", reason: "candidate review" }), binding);
    recordAttempt();
    now = new Date("2026-10-14T00:00:02.000Z");
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "stopped", usage: usage(2000) }));
    reopen(file);
    const renewal = command("renewed-plan", {
      kind: "orchestrator", action: "implementation", payload: { bindingDigest: hashBinding(binding) },
      targetDigest: hashBinding(binding), expiresAt: "2026-10-14T01:00:00.000Z",
    });
    expect(governance.requestApproval(renewal, worker)).toMatchObject({ status: "accepted", effectMayStart: false });
    expect(governance.getApproval("plan-approval")).toMatchObject({ state: "expired", decisionActor: owner.sessionId });
    expect(governance.getApproval("renewed-plan")).toMatchObject({ state: "pending", decisionActor: null });
    expect(createTask().status).toBe("denied");
    expect(() => governance.decideApproval(command("renewed-plan", { approvalVersion: 1, decision: "approved" }), worker, binding)).toThrow(/owner/);
    expect(governance.decideApproval(command("renewed-plan", { approvalVersion: 1, decision: "approved" }), owner, binding).status).toBe("accepted");
    expect(governance.requestApproval(renewal, worker)).toMatchObject({ replayed: true, effectMayStart: false });
    expect(createTask().status).toBe("accepted");
    expect(governance.getRun("run-1")).toMatchObject({ activeMs: 2000, retriesUsed: 1, reviewRoundsUsed: 1, bindingDigest: hashBinding(binding) });
  });

  it("renews an expired unconsumed operation but keeps the prior record immutable", () => {
    approvePlan("2026-10-14T02:00:00.000Z");
    requestCommit();
    governance.decideApproval(command("commit-approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    now = new Date("2026-10-14T01:00:00.000Z");
    const payload = { kind: "orchestrator", action: "commit", payload: { candidateDigest: sha("d") },
      targetDigest: sha("d"), expiresAt: "2026-10-14T02:00:00.000Z" };
    expect(governance.requestApproval(command("renewed-commit", payload), worker).status).toBe("accepted");
    expect(governance.getApproval("commit-approval")?.state).toBe("expired");
    expect(governance.getApproval("renewed-commit")?.state).toBe("pending");
    expect(governance.requestApproval(command("third-commit", payload), worker).status).toBe("denied");
  });

  it("never renews a consumed operation when its deadline passes", () => {
    approvePlan("2026-10-14T02:00:00.000Z"); recordAttempt(); requestCommit();
    governance.decideApproval(command("commit-approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    governance.reserveApproval(command("commit-approval", { kind: "orchestrator", action: "commit", payload: { candidateDigest: sha("d") },
      targetDigest: sha("d"), attemptId: "attempt-1" }), binding);
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "stopped", usage: usage() }));
    now = new Date("2026-10-14T01:00:00.000Z");
    expect(governance.requestApproval(command("renamed-consumed", {
      kind: "orchestrator", action: "commit", payload: { candidateDigest: sha("d") }, targetDigest: sha("d"), expiresAt: "2026-10-14T02:00:00.000Z",
    }), worker).status).toBe("denied");
    expect(governance.getConsumption("commit-approval")?.state).toBe("reserved");
    expect(governance.getApproval("renamed-consumed")).toBeNull();
  });

  it("counts overlapping attempts once in the run clock while retaining each attempt's cumulative usage", () => {
    approvePlan();
    recordAttempt();
    recordAttempt("attempt-2");
    now = new Date("2026-10-14T00:00:01.000Z");
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "stopped", usage: usage(1000) }));
    now = new Date("2026-10-14T00:00:02.000Z");
    governance.recordUsage(command("attempt-2", { expectedAttemptVersion: 1, state: "running", usage: usage(2000) }));
    expect(governance.getRun("run-1").activeMs).toBe(2000);
    expect(governance.getAttempt("attempt-1")?.usage.activeMs).toBe(1000);
    expect(governance.getAttempt("attempt-2")?.usage.activeMs).toBe(2000);
  });

  it.each([
    { kind: "retry", limit: 1, counter: "retriesUsed" as const },
    { kind: "review", limit: 2, counter: "reviewRoundsUsed" as const },
  ])("retains the $kind counter across retries and controller recreation", ({ kind, limit, counter }) => {
    approvePlan();
    for (let i = 0; i < limit; i++) {
      const cycle = command(`${kind}-${i}`, { kind, reason: "diagnosed, bounded follow-up" });
      expect(governance.recordCycle(cycle, binding).status).toBe("accepted");
      expect(governance.recordCycle(cycle, binding).replayed).toBe(true);
    }
    governance = new PlanGovernance(db, bus, queue, () => now, verifiedPolicy);
    expect(governance.recordCycle(command(`${kind}-over`, { kind, reason: "over limit" }), binding).status).toBe("denied");
    expect(governance.getRun("run-1")[counter]).toBe(limit);
    expect(governance.getRun("run-1").state).toBe("blocked");
    expect(recordAttempt("fresh-id").status).toBe("denied");
  });

  it.each(["scope-change", "limit-increase"])("records owner %s escalation while blocked without reopening work or changing counters", (action) => {
    const file = useFileDatabase();
    approvePlan("2026-10-14T03:00:00.000Z");
    governance.recordCycle(command("retry", { kind: "retry", reason: "diagnosed retry" }), binding);
    governance.recordCycle(command("review", { kind: "review", reason: "candidate review" }), binding);
    recordAttempt();
    now = new Date("2026-10-14T01:00:00.001Z");
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "stopped", usage: usage(3_600_001) }));
    const before = governance.getRun("run-1");
    const payload = { kind: "orchestrator", action, payload: { requestedChange: "owner review required" },
      targetDigest: sha("e"), expiresAt: "2026-10-14T03:00:00.000Z" };
    expect(governance.requestApproval(command("worker-escalation", payload), worker).status).toBe("denied");
    const request = command("escalation", payload);
    expect(governance.requestApproval(request, owner)).toMatchObject({ status: "accepted", effectMayStart: false });
    const decision = command("escalation", { approvalVersion: 1, decision: "approved" });
    expect(governance.decideApproval(decision, owner, binding)).toMatchObject({ status: "accepted", effectMayStart: false });
    reopen(file);
    expect(governance.decideApproval(decision, owner, binding)).toMatchObject({ replayed: true, effectMayStart: false });
    expect(governance.getApproval("escalation")?.state).toBe("approved");
    const after = governance.getRun("run-1");
    expect(after).toMatchObject({ state: "blocked", activeMs: 3_600_001, retriesUsed: 1, reviewRoundsUsed: 1,
      binding: before.binding, bindingDigest: before.bindingDigest });
    expect(createTask().status).toBe("denied");
    expect(recordAttempt("new-attempt").status).toBe("denied");
    expect(requestCommit().status).toBe("denied");
    expect(governance.reserveApproval(command("escalation", { kind: "orchestrator", action, payload: payload.payload,
      targetDigest: payload.targetDigest, attemptId: "attempt-1" }), binding).effectMayStart).toBe(false);
    expect(governance.getConsumption("escalation")).toBeNull();
  });

  it("keeps a pending limit escalation across budget exhaustion but invalidates it on cancellation", () => {
    approvePlan("2026-10-14T03:00:00.000Z"); recordAttempt();
    const payload = { kind: "orchestrator", action: "limit-increase", payload: { maxActiveMs: 7_200_000 },
      targetDigest: sha("e"), expiresAt: "2026-10-14T03:00:00.000Z" };
    expect(governance.requestApproval(command("escalation", payload), worker).status).toBe("accepted");
    now = new Date("2026-10-14T01:00:00.001Z");
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "running", usage: usage(3_600_001) }));
    expect(governance.getApproval("escalation")?.state).toBe("pending");
    expect(governance.decideApproval(command("escalation", { approvalVersion: 1, decision: "approved" }), owner, binding).status).toBe("accepted");
    expect(governance.getRun("run-1").binding.limits.maxActiveMs).toBe(3_600_000);
    governance.cancelRun(command("cancel", { reason: "owner stop" }), owner);
    expect(governance.getApproval("escalation")?.state).toBe("invalidated");
    expect(governance.requestApproval(command("another-escalation", payload), owner).status).toBe("denied");
  });

  it.each(["scope-change", "limit-increase"])("never turns an approved %s record into a process effect", (action) => {
    approvePlan(); recordAttempt();
    const payload = { kind: "orchestrator", action, payload: { reason: "requires a later binding decision" },
      targetDigest: sha("e"), expiresAt: "2026-10-14T01:00:00.000Z" };
    governance.requestApproval(command("escalation", payload), owner);
    governance.decideApproval(command("escalation", { approvalVersion: 1, decision: "approved" }), owner, binding);
    expect(governance.reserveApproval(command("escalation", { ...payload, attemptId: "attempt-1" }), binding))
      .toMatchObject({ status: "denied", effectMayStart: false });
    expect(governance.getConsumption("escalation")).toBeNull();
    expect(governance.getRun("run-1").binding).toEqual(binding);
  });

  it("preserves measured overshoot and closes eligibility rather than rolling usage back", () => {
    approvePlan("2026-10-14T02:00:00.000Z");
    recordAttempt();
    now = new Date("2026-10-14T01:00:00.001Z");
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "running", usage: usage(3_600_001) }));
    expect(governance.getRun("run-1").activeMs).toBe(3_600_001);
    expect(governance.getRun("run-1").state).toBe("blocked");
    expect(governance.getApproval("plan-approval")?.state).toBe("invalidated");
    expect(recordAttempt("another-id").status).toBe("denied");
  });

  it.each(["running", "stopped"])("rejects prior elapsed work in an initial %s registration and preserves the blocker through reopen", (state) => {
    const file = useFileDatabase();
    approvePlan();
    const result = governance.recordAttempt(command("late-attempt", {
      qitemId: null, role: "lead", provider: "claude", identity, unknownReason: null, state, usage: usage(3_600_000),
    }), binding);
    expect(result.status).toBe("denied");
    expect(result.reason).toMatch(/registration must precede work/);
    expect((result.value as { reportedUsage: UsageEvidence }).reportedUsage.activeMs).toBe(3_600_000);
    expect(governance.getAttempt("late-attempt")).toBeNull();
    reopen(file);
    expect(governance.getRun("run-1").state).toBe("blocked");
    expect(recordAttempt("renamed-attempt").status).toBe("denied");
    expect(createTask().status).toBe("denied");
  });

  it("requires a fresh binding even when an internal caller omits the argument", () => {
    approvePlan();
    expect(governance.createTask(command("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["src/x.ts"], dependencies: [] },
      sourceSession: "lead@rig-1", destinationSession: "builder@rig-1", body: "Work",
    }), undefined).status).toBe("denied");
    expect(governance.getRun("run-1").state).toBe("invalidated");
    expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 0 });
  });

  it("persists expiry when a decision arrives after its approval deadline", () => {
    requestPlan();
    now = new Date("2026-10-14T01:00:00.000Z");
    expect(governance.decideApproval(command("plan-approval", { approvalVersion: 1, decision: "approved" }), owner, binding).status).toBe("denied");
    expect(governance.getApproval("plan-approval")?.state).toBe("expired");
  });

  it("charges controller downtime and pauses only after all attempts are durably stopped", () => {
    const file = useFileDatabase();
    approvePlan();
    recordAttempt();
    now = new Date("2026-10-14T00:00:10.000Z");
    reopen(file);
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "stopped", usage: usage(10_000) }));
    expect(governance.getRun("run-1").activeMs).toBe(10_000);
    expect(governance.getRun("run-1").accountedAt).toBeNull();
    expect(bus.replayAll(0).some((event) => event.type === "team.control" && event.action === "run.clock-paused")).toBe(true);
    now = new Date("2026-10-14T00:00:20.000Z");
    recordAttempt("attempt-2");
    now = new Date("2026-10-14T00:00:21.000Z");
    governance.recordUsage(command("attempt-2", { expectedAttemptVersion: 1, state: "stopped", usage: usage(1000) }));
    expect(governance.getRun("run-1").activeMs).toBe(11_000);
  });

  it("keeps the last observed native identity when an outcome becomes unknown", () => {
    approvePlan(); recordAttempt();
    const previous = governance.getAttempt("attempt-1")?.identity;
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "unknown", unknownReason: "process outcome not yet observed", usage: usage() }));
    expect(governance.getAttempt("attempt-1")?.identity).toEqual(previous);
    expect(governance.getAttempt("attempt-1")?.unknownReason).toBe("process outcome not yet observed");
    expect(createTask().status).toBe("denied");
    expect(governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 2, state: "running", usage: usage() })).status).toBe("denied");
  });

  it("retains the run budget if its registration is retried and charges unknown intervals", () => {
    const file = useFileDatabase();
    approvePlan(); recordAttempt("attempt-1", "unknown");
    now = new Date("2026-10-14T00:00:10.000Z");
    reopen(file);
    expect(createTask().status).toBe("denied");
    governance.createRun({ id: "run-1", rigId: "rig-1", binding });
    expect(governance.getRun("run-1").activeMs).toBe(10_000);
    expect(governance.getAttempt("attempt-1")?.state).toBe("unknown");
    expect(() => governance.createRun({ id: "run-1", rigId: "rig-1", binding: { ...binding, planDigest: sha("e") } })).toThrow(/conflict/);
  });

  it("orders decisions across separate controllers sharing a database", () => {
    const file = useFileDatabase();
    requestPlan();
    const decision = command("plan-approval", { approvalVersion: 1, decision: "approved" });
    const cancel = command("cancel", { reason: "owner stop" });
    const otherDb = createDb(file);
    try {
      const otherBus = new EventBus(otherDb);
      const other = new PlanGovernance(otherDb, otherBus, new QueueRepository(otherDb, otherBus), () => now, verifiedPolicy);
      other.cancelRun(cancel, owner);
      expect(() => governance.decideApproval(decision, owner, binding)).toThrow(/version/);
      expect(governance.getRun("run-1").state).toBe("cancel_requested");
    } finally { otherDb.close(); }
  });

  it("keeps pending deletion fenced across connections and database reopen without blocking another rig", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "team-governance-"));
    directories.push(directory);
    const file = path.join(directory, "control.db");
    db.close();
    db = createDb(file); migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db); queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, () => now, verifiedPolicy);
    const repository = new RigRepository(db);
    const rig = repository.createRig("pending-deletion");
    const independent = repository.createRig("independent");
    const reservation = repository.reserveRigDeletion(rig.id, "teardown", bus);
    const otherDb = createDb(file);
    try {
      const otherBus = new EventBus(otherDb);
      const other = new PlanGovernance(otherDb, otherBus, new QueueRepository(otherDb, otherBus), () => now, verifiedPolicy);
      expect(() => other.createRun({ id: "blocked-run", rigId: rig.id, binding })).toThrow(/deletion is in progress/);
      expect(other.createRun({ id: "independent-run", rigId: independent.id, binding }).state).toBe("pending");
      expect(otherDb.inTransaction).toBe(false);
    } finally { otherDb.close(); }
    reopen(file);
    now = new Date("2026-10-15T00:00:00.000Z");
    expect(() => governance.createRun({ id: "blocked-run", rigId: rig.id, binding })).toThrow(/deletion is in progress/);
    expect(db.prepare("SELECT id FROM team_runs WHERE rig_id = ?").all(rig.id)).toEqual([]);
    const reopenedRepository = new RigRepository(db);
    expect(() => reopenedRepository.deleteRig(rig.id)).toThrow(/deletion is in progress/);
    reopenedRepository.finishRigDeletion(rig.id, reservation, bus);
    expect(governance.createRun({ id: "released-run", rigId: rig.id, binding }).state).toBe("pending");
  });

  it("retains known usage totals across attempts and rejects decreased or missing reported evidence", () => {
    approvePlan();
    recordAttempt(); recordAttempt("attempt-2");
    const measured = (tokens: number) => ({ ...usage(), inputTokens: { value: tokens, reason: null }, outputTokens: { value: 0, reason: null }, costUsd: { value: 0.1, reason: null } });
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "stopped", usage: measured(10) }));
    expect(governance.getRun("run-1").usage.inputTokens.value).toBeNull();
    governance.recordUsage(command("attempt-2", { expectedAttemptVersion: 1, state: "stopped", usage: measured(20) }));
    expect(governance.getRun("run-1").usage.inputTokens).toEqual({ value: 30, reason: null });
    expect(governance.getRun("run-1").usage.outputTokens).toEqual({ value: 0, reason: null });
    expect(() => governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 2, state: "stopped", usage: measured(9) }))).toThrow(/decrease/);
    expect(() => governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 2, state: "stopped", usage: usage() }))).toThrow(/disappear/);
  });

  it("does not multiply the session cap or treat unknown process identity as a successful launch", () => {
    approvePlan();
    recordAttempt(); recordAttempt("attempt-2"); recordAttempt("attempt-3");
    expect(recordAttempt("attempt-4").status).toBe("denied");
    governance.recordUsage(command("attempt-1", { expectedAttemptVersion: 1, state: "stopped", usage: usage(10) }));
    expect(recordAttempt("unknown-attempt", "unknown").status).toBe("observed");
    expect(governance.getAttempt("unknown-attempt")?.unknownReason).toBe("restart identity not yet reconciled");
    expect(createTask().status).toBe("denied");
  });

  it("persists authority and idempotency across a real database reopen", () => {
    const file = useFileDatabase();
    requestPlan();
    const decision = command("plan-approval", { approvalVersion: 1, decision: "rejected" }, "durable-decision");
    governance.decideApproval(decision, owner, binding);
    reopen(file);
    expect(governance.getApproval("plan-approval")?.state).toBe("rejected");
    expect(governance.decideApproval(decision, owner, binding).replayed).toBe(true);
  });
});
