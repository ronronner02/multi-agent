import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { composePendingDispatch } from "../src/domain/pending-dispatch.js";
import { composeTaskDispatch } from "../src/domain/task-dispatch.js";
import { appendChatMessage, composeLeadTurnEnd, leadChatTurnNote, listChatMessages, pendingOwnerMessages, takeOwnerMessages } from "../src/domain/lead-chat.js";
import { composeAttemptCompletion } from "../src/domain/attempt-completion.js";
import { leadTeamEvents } from "../src/domain/lead-manager.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import type { ControlRequest, PlanBinding } from "../src/contracts/team-control.js";

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const policy = unisolatedPolicyCapability(4);
const now = "2026-11-07T00:00:00.000Z";
const unavailable = { value: null, reason: "Not observed" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };

describe("the owner's reserved lead slot", () => {
  let db: Database.Database, governance: PlanGovernance, sessions: SessionRegistry, binding: PlanBinding, root: string, sequence: number;
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: "1.0", runId: "run", actionId, payload,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "request-" + ++sequence,
  });
  const task = (taskId: string) => governance.findTask("run", taskId)!;
  const identity = (id: string) => ({ nativeSessionId: id, tmuxServer: "/fixture/tmux", paneId: "%1",
    processId: 123, processStart: "fixture-start", generation: 1, policyFingerprint: binding.policyFingerprint });
  const record = (id: string, taskId: string) => governance.recordAttempt(command(id, {
    role: task(taskId).assignment.role, provider: "claude", qitemId: task(taskId).qitemId,
    state: "running", identity: identity(id), unknownReason: null, usage,
  }), binding);
  const live = () => (db.prepare("SELECT count(*) AS n FROM team_attempts WHERE state <> 'stopped'").get() as { n: number }).n;
  const message = (id = "owner-message") => appendChatMessage(db, { id, runId: "run", body: "What is happening?", createdAt: now });
  const admitLead = (id: string) => governance.admitNativeAttempt(command(id, {
    qitemId: task("lead").qitemId, expectedTaskVersion: task("lead").entityVersion,
    sessionId: "lead@fixture", provider: "claude", commandDigest: hashBytes("command"),
    previousAttemptId: null, expectedPreviousVersion: null,
  }), owner, binding);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "owner-slot-"));
    sequence = 0;
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    for (const [id, role] of [["a", "implementer"], ["b", "implementer"], ["lead", "lead"]] as const) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, 'rig', ?, ?, 'claude-code', ?)")
        .run(id, id, role, root);
      db.prepare("INSERT INTO sessions (id, node_id, session_name, startup_status) VALUES (?, ?, ?, 'pending')")
        .run("session-" + id, id, id + "@fixture");
    }
    const events = new EventBus(db);
    sessions = new SessionRegistry(db, events);
    governance = new PlanGovernance(db, events, new QueueRepository(db, events), () => new Date(now), () => policy);
    binding = { artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("plan"), repository: { root, identity: "git:" + "b".repeat(40) },
      readPaths: ["plan.md", "src"], writePaths: ["plan.md", "src"], roles: ["lead", "implementer"],
      policyRevision: policy.policyRevision, policyFingerprint: policy.policyFingerprint,
      limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 } };
    governance.createRun({ id: "run", rigId: "rig", binding });
    const digest = hashBinding(binding);
    governance.requestApproval(command("approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: digest }, targetDigest: digest, expiresAt: "2099-01-01T00:00:00.000Z" }), owner);
    expect(governance.decideApproval(command("approval", { approvalVersion: 1, decision: "approved" }), owner, binding).status).toBe("accepted");
    for (const id of ["a", "b", "lead"]) {
      expect(governance.createTask(command(id, { assignment: { taskId: id, role: id === "lead" ? "lead" : "implementer",
        paths: [id === "lead" ? "plan.md" : "src/" + id + ".ts"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "owner-control", destinationSession: id + "@fixture", body: "Work on " + id }), binding).status)
        .toBe("accepted");
    }
    expect(record("worker-a", "a").status).toBe("observed");
    expect(record("worker-b", "b").status).toBe("observed");
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("dispatches the owner-carrying lead above two busy workers, but nothing without an owner message", async () => {
    const started: string[] = [];
    const pending = composePendingDispatch({ db, maxSessions: () => 2, liveSessions: live,
      dispatch: () => async (_runId, taskId) => {
        started.push(taskId);
        expect(record("lead-attempt", taskId).status).toBe("observed");
        takeOwnerMessages(db, "run", "lead-attempt");
      } });
    await pending("run");
    expect(started).toEqual([]);
    message();
    await pending("run");
    expect(started).toEqual(["lead"]);
    expect(live()).toBe(3);
    await pending("run");
    expect(started).toEqual(["lead"]);
    expect(record("extra-worker", "a")).toMatchObject({ status: "denied", reason: "Live session limit reached" });
  });

  it("uses the same exception before client launch and keeps same-seat launch serialization", async () => {
    sessions.updateBinding("lead", { attachmentType: "tmux", tmuxSession: "lead@fixture", tmuxPane: "%1" });
    let release!: () => void;
    const startNode = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, startupStatus: "ready" };
    });
    const dispatch = composeTaskDispatch({ rigRepo: new RigRepository(db), sessions,
      tmux: { listPanes: async () => [{ id: "%1" }] } as never,
      startupOrchestrator: { startNode } as never,
      runtimeAdapters: { "claude-code": { runtime: "claude-code" } } as never,
      maxSessions: () => 2, liveSessions: live });
    await dispatch("run", "lead");
    expect(startNode).not.toHaveBeenCalled();
    message();
    const launching = dispatch("run", "lead");
    await vi.waitFor(() => expect(startNode).toHaveBeenCalledTimes(1));
    await dispatch("run", "lead");
    expect(startNode).toHaveBeenCalledTimes(1);
    release(); await launching;
  });

  it("does not relaunch a dead pane until its launch receipt and stop are observed", async () => {
    db.prepare("UPDATE team_attempts SET state = 'stopped'").run();
    sessions.updateBinding("lead", { attachmentType: "tmux", tmuxSession: "lead@fixture", tmuxPane: "%1" });
    sessions.updateStartupStatus("session-lead", "ready");
    db.prepare("INSERT INTO events(type, payload) VALUES ('managed.attempt.receipt', ?)").run(JSON.stringify({
      runId: "run", sessionName: "lead@fixture", receipt: { attemptId: "lead-receipt" },
    }));
    const startNode = vi.fn(async () => ({ ok: true, startupStatus: "ready" }));
    const respawnPane = vi.fn(async () => {});
    const dispatch = composeTaskDispatch({ rigRepo: new RigRepository(db), sessions,
      tmux: { listPanes: async () => [{ id: "%1" }], getPaneExit: async () => ({ dead: true, code: 0 }), respawnPane } as never,
      startupOrchestrator: { startNode } as never,
      runtimeAdapters: { "claude-code": { runtime: "claude-code" } } as never, maxSessions: () => 2, liveSessions: live });
    await dispatch("run", "lead");
    expect(startNode).not.toHaveBeenCalled();
    expect(respawnPane).not.toHaveBeenCalled();
    expect(record("lead-receipt", "lead").status).toBe("observed");
    await dispatch("run", "lead");
    expect(startNode).not.toHaveBeenCalled();
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'lead-receipt'").run();
    sessions.updateStartupStatus("session-lead", "pending");
    await dispatch("run", "lead");
    expect(startNode).toHaveBeenCalledTimes(1);
  });

  it("counts launches awaiting registration against the cap but keeps the owner slot", async () => {
    db.prepare("UPDATE team_attempts SET state = 'stopped'").run();
    for (const seat of ["a@fixture", "b@fixture"]) {
      db.prepare("INSERT INTO events(type, payload) VALUES ('managed.attempt.receipt', ?)").run(JSON.stringify({
        runId: "run", sessionName: seat, receipt: { attemptId: "unregistered-" + seat },
      }));
    }
    sessions.updateBinding("lead", { attachmentType: "tmux", tmuxSession: "lead@fixture", tmuxPane: "%1" });
    const startNode = vi.fn(async () => ({ ok: true, startupStatus: "ready" }));
    const dispatch = composeTaskDispatch({ rigRepo: new RigRepository(db), sessions,
      tmux: { listPanes: async () => [{ id: "%1" }] } as never, startupOrchestrator: { startNode } as never,
      runtimeAdapters: { "claude-code": { runtime: "claude-code" } } as never, maxSessions: () => 2, liveSessions: live });
    await dispatch("run", "lead");
    expect(startNode).not.toHaveBeenCalled();
    message(); await dispatch("run", "lead");
    expect(startNode).toHaveBeenCalledTimes(1);
  });

  it("honors messages already assigned to the native attempt at both admission and observation", () => {
    expect(admitLead("no-message")).toMatchObject({ status: "denied", reason: "Live session limit reached" });
    message();
    takeOwnerMessages(db, "run", "native-lead");
    expect(admitLead("native-lead")).toMatchObject({ status: "pending-execution", effectMayStart: true });
    expect(governance.reconcileNativeAttempt(command("native-lead", {
      commandDigest: hashBytes("command"), outcome: "running", identity: identity("native-lead"),
      expectedAttemptVersion: null, evidenceRef: "fixture/native-lead",
    }), owner, binding)).toMatchObject({ status: "observed" });
    expect(live()).toBe(3);
    expect(admitLead("second-lead").effectMayStart).toBe(false);
  });

  it("returns only unanswered messages to pending and carries them into the next lead turn", async () => {
    message();
    takeOwnerMessages(db, "run", "empty-lead");
    const dispatch = vi.fn(async (_runId: string, _taskId: string) => {});
    const turnEnd = composeLeadTurnEnd({ db, governance, turnStateRoot: root, dispatch: () => dispatch });
    await turnEnd({ id: "empty-lead", runId: "run", qitemId: task("lead").qitemId, role: "lead" });
    expect(pendingOwnerMessages(db, "run").map(row => row.id)).toEqual(["owner-message"]);
    expect(dispatch).toHaveBeenCalledWith("run", "lead");
    expect(takeOwnerMessages(db, "run", "reply-lead").map(row => row.id)).toEqual(["owner-message"]);
    const output = agentTurnOutputPaths(root, "reply-lead");
    mkdirSync(output.directory, { recursive: true });
    writeFileSync(output.lastMessage, "Both implementers are running.");
    await turnEnd({ id: "reply-lead", runId: "run", qitemId: task("lead").qitemId, role: "lead" });
    expect(pendingOwnerMessages(db, "run")).toEqual([]);
    rmSync(output.lastMessage);
    await turnEnd({ id: "reply-lead", runId: "run", qitemId: task("lead").qitemId, role: "lead" });
    expect(pendingOwnerMessages(db, "run")).toEqual([]);
    expect(listChatMessages(db, "run").filter(row => row.sender === "lead")).toHaveLength(1);
  });

  it.each(["at launch", "during the turn"])("reopens a silent delivery lead for an owner message received %s", async arrival => {
    if (arrival === "at launch") message();
    else db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'worker-b'").run();
    expect(record("empty-lead", "lead").status).toBe("observed");
    takeOwnerMessages(db, "run", "empty-lead");
    if (arrival === "during the turn") message();
    db.prepare("UPDATE team_attempts SET identity_json = json_set(identity_json, '$.processId', 456) WHERE id = 'empty-lead'").run();
    const dispatch = vi.fn(async () => {});
    const end = composeLeadTurnEnd({ db, governance, turnStateRoot: root, dispatch: () => dispatch });
    await composeAttemptCompletion({ db, governance, currentBinding: () => binding, turnStateRoot: root,
      sessions, alive: identity => identity.processId !== 456,
      candidateManifestFor: () => ({ base: "commit", baseIdentifier: "a".repeat(40), files: [], manifestDigest: hashBytes("empty"), patch: "" }),
      readLeadEscalation: () => null, onAttemptStopped: end }).sweep();
    expect(governance.getTask(task("lead").qitemId)!.evidence).toMatchObject({ validated: true });
    expect(governance.queueState(task("lead").qitemId)).toBe("pending");
    expect(pendingOwnerMessages(db, "run").map(row => row.id)).toEqual(["owner-message"]);
    expect(dispatch).toHaveBeenCalledWith("run", "lead");
    expect(leadTeamEvents(db, "run")).toEqual([]);
    const nextMessages = takeOwnerMessages(db, "run", "replacement-lead");
    expect(nextMessages.map(row => row.id)).toEqual(["owner-message"]);
    expect(leadChatTurnNote(nextMessages)).toContain("What is happening?");
  });

  it("keeps messages that arrived during a successful delivery reply eligible for the next turn", async () => {
    const output = agentTurnOutputPaths(root, "reply-before-next");
    mkdirSync(output.directory, { recursive: true }); writeFileSync(output.lastMessage, "The work is underway.");
    message("next-message");
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(task("lead").qitemId);
    const dispatch = vi.fn(async () => {});
    await composeLeadTurnEnd({ db, governance, turnStateRoot: root, dispatch: () => dispatch })({
      id: "reply-before-next", runId: "run", qitemId: task("lead").qitemId, role: "lead" });
    expect(governance.queueState(task("lead").qitemId)).toBe("pending");
    expect(dispatch).toHaveBeenCalledWith("run", "lead");
    expect(pendingOwnerMessages(db, "run").map(row => row.id)).toEqual(["next-message"]);
  });

  it("keeps the reserved owner slot behind a persisted retry time at direct and native launch", async () => {
    message(); sessions.updateBinding("lead", { attachmentType: "tmux", tmuxSession: "lead@fixture", tmuxPane: "%1" });
    db.prepare("UPDATE team_queue_authority SET evidence_json = ? WHERE qitem_id = ?")
      .run(JSON.stringify({ retryNotBefore: "2026-11-07T00:02:00.000Z" }), task("lead").qitemId);
    const startNode = vi.fn(async () => ({ ok: true }));
    await composeTaskDispatch({ rigRepo: new RigRepository(db), sessions, now: () => new Date(now),
      tmux: { listPanes: async () => [{ id: "%1" }] } as never, startupOrchestrator: { startNode } as never,
      runtimeAdapters: { "claude-code": { runtime: "claude-code" } } as never,
      maxSessions: () => 2, liveSessions: live })("run", "lead");
    expect(startNode).not.toHaveBeenCalled();
    expect(admitLead("too-soon")).toMatchObject({ status: "denied", reason: "The task is waiting for its retry time" });
    expect(pendingOwnerMessages(db, "run")).toHaveLength(1);
  });

  it("preserves the lead wake-cycle guard while messages are redelivered", () => {
    message();
    expect(record("lead-1", "lead").status).toBe("observed");
    takeOwnerMessages(db, "run", "lead-1");
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'lead-1'").run();
    db.prepare("UPDATE team_chat_messages SET delivered_attempt = NULL").run();
    expect(record("lead-2", "lead").status).toBe("observed");
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'lead-2'").run();
    expect(record("lead-3", "lead")).toMatchObject({ status: "denied", reason: "lead-wake:cycles" });
  });
});
