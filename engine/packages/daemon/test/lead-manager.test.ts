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
import { composeAttemptCompletion } from "../src/domain/attempt-completion.js";
import { agentTurnOutputPaths, continuationNote } from "../src/domain/agent-turn.js";
import { EventBus } from "../src/domain/event-bus.js";
import { composeLeadTurnEnd, leadChatTurnNote, pendingOwnerMessages } from "../src/domain/lead-chat.js";
import { composeLeadManager, deliveredLeadEvents, leadTeamEvents } from "../src/domain/lead-manager.js";
import { LeadWakePolicy } from "../src/domain/lead-wake-policy.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { composePendingDispatch } from "../src/domain/pending-dispatch.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";

/**
 * U6 — after the owner approves the plan, the lead runs the team.
 *
 * Everything here drives the real governance owner against a repository on disk. The runtime's
 * readers are injected, because a candidate tree belongs to the launch path; what a lead would
 * have written is the test's input, and the daemon's own admission, refusal, decision and wake
 * are what the assertions read.
 */

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const daemon = { kind: "daemon", sessionId: "daemon" } as const;
const unavailable = { value: null, reason: "provider did not report usage" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };

describe("U6 — the lead as manager", () => {
  let root: string, turnRoot: string;
  let db: Database.Database, governance: PlanGovernance;
  let binding: ReturnType<typeof bindingForGoal>;
  let dispatch: ReturnType<typeof vi.fn>;
  let serial = 0;
  let leadQitemId: string;

  const request = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `fixture-${++serial}`, payload,
  });

  const admit = (taskId: string, role: "lead" | "implementer" | "reviewer", seat: string,
    paths: string[], extra: Record<string, unknown> = {}) => governance.createTask(request(taskId, {
      assignment: { taskId, role, paths, dependencies: [], ...extra }, outputs: [], permissions: [...roleConfiguration[role].permissions],
      sourceSession: "owner", destinationSession: seat, body: `Work ${taskId}`,
    }), binding);

  const manager = (proposal: readonly unknown[] | Error) => composeLeadManager({ db, governance,
    readLeadProposal: () => { if (proposal instanceof Error) throw proposal; return proposal as never; },
    currentBinding: () => structuredClone(binding), dispatch: () => dispatch, log: () => {} });

  const leadTurnEnd = async (proposal: readonly unknown[] | Error, attemptId = "attempt-lead") =>
    manager(proposal).turnEnd({ id: attemptId, runId: "run", qitemId: leadQitemId, role: "lead" });

  const wakeEvents = () => db.prepare(`SELECT json_extract(payload, '$.payload.keys') AS keys, json_extract(payload, '$.payload.note') AS note
    FROM events WHERE type = 'team.control' AND json_extract(payload, '$.action') = 'lead.woken' ORDER BY seq`)
    .all() as Array<{ keys: string; note: string }>;

  beforeEach(() => {
    serial = 0; dispatch = vi.fn(async () => {});
    root = mkdtempSync(join(tmpdir(), "u6-lead-manager-"));
    turnRoot = mkdtempSync(join(tmpdir(), "u6-turns-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const policy = unisolatedPolicyCapability(2);
    binding = { ...bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy }),
      limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 } };
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    for (const [id, role, seat] of [["lead-node", "lead", "lead@rig"], ["a-node", "implementer", "a@rig"],
      ["b-node", "implementer", "b@rig"], ["rev-node", "reviewer", "reviewer@rig"]] as const) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, 'rig', ?, ?, 'claude-code', ?)")
        .run(id, id, role, root);
      db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run(`s-${id}`, id, seat);
    }
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-06T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding, reviewerSeat: "reviewer@rig" });
    governance.requestApproval(request("approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-06T01:00:00.000Z" }), owner);
    governance.decideApproval(request("approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    expect(admit("task-1", "lead", "lead@rig", ["src"]).status).toBe("accepted");
    leadQitemId = governance.findTask("run", "task-1")!.qitemId;
  });
  afterEach(() => {
    if (db?.open) db.close();
    for (const path of [root, turnRoot]) if (path) rmSync(path, { recursive: true, force: true });
  });

  /** The lead's last delivery turn ended: the state its next turn is reopened from. */
  const endLeadTurn = () => db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(leadQitemId);

  it("admits a valid decomposition with no owner approval, and its tasks dispatch", async () => {
    endLeadTurn();
    const approvalsBefore = (db.prepare("SELECT count(*) AS n FROM team_approvals").get() as { n: number }).n;
    await leadTurnEnd([{ taskId: "task-2", seat: "a@rig", paths: ["src/a.ts"], dependencies: [], body: "Implement the first module" },
      { taskId: "task-3", seat: "b@rig", paths: ["src/b.ts"], dependencies: [], body: "Implement the second module" }]);
    // Admitted through the one admission write, with nothing for the owner to decide.
    expect(governance.findTask("run", "task-2")).not.toBeNull();
    expect(governance.findTask("run", "task-3")).not.toBeNull();
    expect((db.prepare("SELECT count(*) AS n FROM team_approvals").get() as { n: number }).n).toBe(approvalsBefore);
    expect(db.prepare("SELECT count(*) AS n FROM team_approvals WHERE action = 'scope-change'").get()).toEqual({ n: 0 });
    // The lead's own task stays done: it delivered its list, and its next turn is a later event.
    expect(governance.queueState(leadQitemId)).toBe("done");
    // A freed slot starts them, the same dispatch every other admission uses.
    await composePendingDispatch({ db, dispatch: () => dispatch as never, liveSessions: () => 0, maxSessions: () => 2 })("run");
    expect(dispatch.mock.calls.map(call => call[1])).toEqual(["task-2", "task-3"]);
    // A replayed turn end admits nothing twice: the same attempt replays its own receipt.
    await leadTurnEnd([{ taskId: "task-2", seat: "a@rig", paths: ["src/a.ts"], dependencies: [], body: "Implement the first module" }]);
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority").get()).toEqual({ n: 3 });
  });

  it("does not admit a list the run already admitted when a later turn only answered an event", async () => {
    endLeadTurn();
    const list = [{ taskId: "task-2", seat: "a@rig", paths: ["src/a.ts"], dependencies: [], body: "Implement the module" }];
    await leadTurnEnd(list);
    expect(governance.findTask("run", "task-2")).not.toBeNull();
    // The lead's tree keeps the file it wrote, so the wake turn — a new attempt — reads the same
    // list. It is not a new request, and it must not be refused as a duplicate either.
    endLeadTurn();
    dispatch.mockClear();
    await leadTurnEnd(list, "attempt-lead-2");
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority").get()).toEqual({ n: 2 });
    expect(governance.queueState(leadQitemId)).toBe("done");
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.action') = 'lead.proposal-refused'`).get()).toEqual({ n: 0 });
  });

  it("treats a list the owner decided earlier as admitted too", async () => {
    // The compatibility path is still a way a lead's batch reaches the run: the owner records a
    // decision and `applyLeadProposal` admits it. The turn end must read the run's own tasks, not
    // its own admission events, or every later lead turn refuses that same list as a duplicate.
    endLeadTurn();
    const list = [{ taskId: "task-2", seat: "a@rig", paths: ["src/a.ts"], dependencies: [], body: "Implement the module" }];
    const requested = governance.proposeLeadTasks(request("lead-proposal",
      { leadProposal: { expiresAt: "2026-11-06T02:00:00.000Z" } }), owner, binding, list);
    expect(requested.status).toBe("accepted");
    const approval = requested.value as { id: string; entityVersion: number };
    expect(governance.decideApproval(request(approval.id, { approvalVersion: approval.entityVersion,
      decision: "approved" }), owner, binding).status).toBe("accepted");
    expect(governance.findTask("run", "task-2")).not.toBeNull();
    dispatch.mockClear();
    await leadTurnEnd(list, "attempt-lead-2");
    expect(governance.queueState(leadQitemId)).toBe("done");
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.action') = 'lead.proposal-refused'`).get()).toEqual({ n: 0 });
    // A list that changes what an admitted task is remains a different request, and the daemon
    // says so rather than silently ignoring it.
    await leadTurnEnd([{ taskId: "task-2", seat: "a@rig", paths: ["src/a.ts"], dependencies: [], body: "Do more" }], "attempt-lead-3");
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.action') = 'lead.proposal-refused'`).get()).toEqual({ n: 1 });
  });

  it("refuses a list outside the approved plan and reopens the lead with the reason", async () => {
    endLeadTurn();
    await leadTurnEnd([{ taskId: "task-2", seat: "a@rig", paths: ["lib/outside.ts"], dependencies: [], body: "Widen the scope" }]);
    // Nothing was admitted, and the lead is the one doing the next piece of work.
    expect(governance.findTask("run", "task-2")).toBeNull();
    expect(governance.queueState(leadQitemId)).toBe("pending");
    expect(dispatch).toHaveBeenCalledWith("run", "task-1");
    // The reason is the daemon's own words, and it is what the lead's next prompt carries.
    const refused = db.prepare(`SELECT json_extract(payload, '$.payload.note') AS note FROM events
      WHERE type = 'team.control' AND json_extract(payload, '$.action') = 'lead.proposal-refused'
      ORDER BY seq DESC LIMIT 1`).get() as { note: string };
    expect(refused.note).toBe("Assignment path is outside the binding");
    const note = continuationNote(db, "run", "task-1", "lead")!;
    expect(note).toContain("Assignment path is outside the binding");
    expect(note).toContain("lead-escalation.json");
  });

  it("stores an escalation as one owner decision, and the owner's answer resumes the lead", async () => {
    const output = agentTurnOutputPaths(turnRoot, "attempt-lead");
    mkdirSync(output.directory, { recursive: true });
    writeFileSync(output.lastMessage, "I need one decision before I can split this.\n");
    const escalation = { question: "Should the run also cover the CLI?", options: ["Yes, add a task", "No, ship the API only"],
      context: "The plan names the API only; the CLI would widen the write scope." };
    const turnEnd = composeLeadTurnEnd({ db, governance, turnStateRoot: turnRoot, readEscalation: () => escalation,
      dispatch: () => dispatch as never, now: () => new Date("2026-11-06T00:00:00.000Z") });
    await turnEnd({ id: "attempt-lead", runId: "run", qitemId: leadQitemId, role: "lead" });
    // One decision message, carrying the question and the choices; the run now waits on it.
    const decision = governance.chatDecision("run")!;
    expect(decision).toMatchObject({ sender: "lead", kind: "decision", options: escalation.options,
      body: `${escalation.question}\n\n${escalation.context}`, answeredBy: null });
    expect(governance.chatMessages("run")).toHaveLength(1);
    // A replayed observation records the same one row.
    await turnEnd({ id: "attempt-lead", runId: "run", qitemId: leadQitemId, role: "lead" });
    expect(governance.chatMessages("run")).toHaveLength(1);
    // The escalation file stays in the tree, so a later turn reads it again. The same question
    // is one decision, and that turn still speaks with its own message.
    const next = agentTurnOutputPaths(turnRoot, "attempt-lead-2");
    mkdirSync(next.directory, { recursive: true });
    writeFileSync(next.lastMessage, "Still waiting on your answer.\n");
    await turnEnd({ id: "attempt-lead-2", runId: "run", qitemId: leadQitemId, role: "lead" });
    expect(governance.chatMessages("run")).toHaveLength(2);
    expect(governance.chatMessages("run")[1]).toMatchObject({ sender: "lead", kind: "text",
      body: "Still waiting on your answer." });

    endLeadTurn();
    const answered = governance.postChatMessage(request("chat-answer", { body: escalation.options[0], answerTo: decision.id }),
      owner, binding);
    expect(answered.status).toBe("accepted");
    expect((answered.value as { answered: string }).answered).toBe(decision.id);
    expect(answered.revisionTaskId).toBe("task-1");
    // The decision is answered exactly once, and the answer is the lead's next prompt.
    expect(governance.chatDecision("run")).toBeNull();
    expect(governance.chatMessages("run").find(message => message.id === decision.id)?.answeredBy).toBe("chat-answer");
    const note = leadChatTurnNote(pendingOwnerMessages(db, "run"))!;
    expect(note).toContain(escalation.options[0]!);
    // A second message naming the same decision is refused rather than recorded as an answer.
    expect(governance.postChatMessage(request("chat-again", { body: "Or neither", answerTo: decision.id }),
      owner, binding)).toMatchObject({ status: "denied", reason: "That decision was already answered" });
    expect(governance.postChatMessage(request("chat-unknown", { body: "Or neither", answerTo: "chat-nope" }),
      owner, binding)).toMatchObject({ status: "denied" });
  });

  it("counts a daemon-recorded outcome as progress for the lead-wake guard", () => {
    // Two lead wakes with nothing between them is the cycle the guard exists for.
    const leadWake = new LeadWakePolicy(db, new EventBus(db));
    const run = governance.getRun("run");
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 0, minute)).toISOString();
    const wake = (minute: number) => {
      const check = leadWake.check(run, leadQitemId, at(minute));
      const reason = check.reason;
      if (!reason) leadWake.record(run, leadQitemId, at(minute), check, () => {});
      return reason;
    };
    expect([wake(0), wake(1), wake(2)]).toEqual([null, null, "lead-wake:cycles"]);
    // A daemon-recorded outcome is the team making progress, and it must count: without it a
    // working team's lead trips the guard on the next wake.
    expect(admit("task-2", "implementer", "a@rig", ["src/a.ts"]).status).toBe("accepted");
    const qitemId = governance.findTask("run", "task-2")!.qitemId;
    governance.recordAttempt(request("attempt-impl", { qitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "native", tmuxServer: "/tmp/tmux.sock", paneId: "%1", processId: 123,
        processStart: "start-1", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage }), binding);
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'attempt-impl'").run();
    expect(governance.recordTaskOutcome(request(qitemId, { expectedTaskVersion: 1, state: "done", actorSession: "a@rig",
      attemptId: "attempt-impl", expectedAttemptVersion: 1, evidence: { validated: true, changedPaths: ["src/a.ts"] },
      closureReason: "no-follow-on" }), daemon).status).toBe("observed");
    const outcome = db.prepare(`SELECT json_extract(payload, '$.payload.observedBy') AS observedBy FROM events
      WHERE type = 'team.control' AND json_extract(payload, '$.action') = 'task.outcome' ORDER BY seq DESC LIMIT 1`).get() as
      { observedBy: string };
    expect(outcome.observedBy).toBe("daemon");
    expect(wake(3)).toBeNull();
  });

  it("wakes the lead once when a task uses its whole review allowance, not once per sweep", async () => {
    endLeadTurn();
    expect(admit("task-2", "implementer", "a@rig", ["src/a.ts"]).status).toBe("accepted");
    for (const round of [1, 2]) {
      expect(admit(`task-2-review-${round}`, "reviewer", "reviewer@rig", ["src/a.ts"], { reviewOf: "task-2" }).status).toBe("accepted");
    }
    expect(leadTeamEvents(db, "run").map(event => event.key)).toContain("review-limit:task-2");
    const lead = composeLeadManager({ db, governance, currentBinding: () => structuredClone(binding),
      dispatch: () => dispatch as never, log: () => {} });
    await lead.sweep();
    expect(wakeEvents()).toHaveLength(1);
    expect(wakeEvents()[0]!.note).toContain("used every review round");
    expect(governance.queueState(leadQitemId)).toBe("pending");
    expect(dispatch).toHaveBeenCalledWith("run", "task-1");
    // The facts did not change, so the same sweep has nothing new to say — and says nothing.
    dispatch.mockClear();
    await lead.sweep();
    expect(wakeEvents()).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(deliveredLeadEvents(db, "run").has("review-limit:task-2")).toBe(true);
  });

  it("wakes the lead once when an approved task will not apply to the integration branch", async () => {
    // U7 records the conflict through the observed-outcome command: the task's work was
    // approved and closed, the patch could not land, and the failure names `integration_conflict`
    // in the task's evidence. The row is `failed`, which the lead must still hear about — and
    // it is not a retry, so "failed after its retry" is not what makes it news.
    endLeadTurn();
    expect(admit("task-2", "implementer", "a@rig", ["src/a.ts"]).status).toBe("accepted");
    const qitemId = governance.findTask("run", "task-2")!.qitemId;
    governance.recordAttempt(request("attempt-impl", { qitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "native", tmuxServer: "/tmp/tmux.sock", paneId: "%1", processId: 123,
        processStart: "start-1", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "stopped", usage }), binding);
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitemId);
    expect(governance.recordTaskOutcome(request(qitemId, { expectedTaskVersion: 1, state: "failed", actorSession: "a@rig",
      attemptId: "attempt-impl", expectedAttemptVersion: 1, evidence: { reasonCode: "integration_conflict" } }), daemon).status)
      .toBe("observed");
    expect(governance.queueState(qitemId)).toBe("failed");
    expect(leadTeamEvents(db, "run").map(event => event.key)).toContain("conflict:task-2");
    const lead = composeLeadManager({ db, governance, currentBinding: () => structuredClone(binding),
      dispatch: () => dispatch as never, log: () => {} });
    await lead.sweep();
    expect(wakeEvents()).toHaveLength(1);
    expect(wakeEvents()[0]!.keys).toContain("conflict:task-2");
    expect(wakeEvents()[0]!.note).toContain("does not apply to the run's integration branch");
    expect(dispatch).toHaveBeenCalledWith("run", "task-1");
    // One fact, one wake: the sweep does not repeat it, and it does not also call it a failure.
    await lead.sweep();
    expect(wakeEvents()).toHaveLength(1);
    expect(wakeEvents()[0]!.keys).not.toContain("failed:");
  });

  it("wakes the lead once when every task is done, and again only for a later task set", async () => {
    endLeadTurn();
    expect(admit("task-2", "implementer", "a@rig", ["src/a.ts"]).status).toBe("accepted");
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(governance.findTask("run", "task-2")!.qitemId);
    const lead = composeLeadManager({ db, governance, currentBinding: () => structuredClone(binding),
      dispatch: () => dispatch as never, log: () => {} });
    await lead.sweep();
    expect(wakeEvents()).toHaveLength(1);
    expect(wakeEvents()[0]!.keys).toContain("all-done:");
    await lead.sweep();
    expect(wakeEvents()).toHaveLength(1);
    // A task this run admits later is a new finish line, not the old one restated. The lead's
    // own task must be finished for the team to be at one: it answers its wake first.
    expect(admit("task-3", "implementer", "b@rig", ["src/b.ts"]).status).toBe("accepted");
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(governance.findTask("run", "task-3")!.qitemId);
    await lead.sweep();
    expect(wakeEvents()).toHaveLength(1);
    endLeadTurn();
    await lead.sweep();
    expect(wakeEvents()).toHaveLength(2);
    expect(wakeEvents()[1]!.keys).not.toBe(wakeEvents()[0]!.keys);
  });

  it("admits the lead's list at the turn end the completion sweep observes", async () => {
    // The end of the turn is the observation, so the admission must happen from it — not from a
    // route the lead cannot call and not from the owner.
    const proposal = [{ taskId: "task-2", seat: "a@rig", paths: ["src/a.ts"], dependencies: [], body: "Implement it" }];
    const completion = composeAttemptCompletion({ db, governance, turnStateRoot: turnRoot,
      sessions: { findResumeContextByName: () => null, updateStartupStatus: () => {} },
      currentBinding: () => structuredClone(binding),
      candidateManifestFor: () => ({ base: "commit" as const, baseIdentifier: "a".repeat(40),
        files: [{ path: "lead-proposal.json" }], manifestDigest: `sha256:${"b".repeat(64)}`,
        patch: "diff --git a/lead-proposal.json b/lead-proposal.json\n+++ b/lead-proposal.json\n" }),
      readLeadProposal: () => proposal,
      readLeadEscalation: () => { throw new Error("no escalation"); },
      onAttemptStopped: async attempt => {
        await composeLeadTurnEnd({ db, governance, turnStateRoot: turnRoot,
          readEscalation: () => null, dispatch: () => dispatch as never })(attempt);
        await manager(proposal).turnEnd(attempt);
      },
      intervalMs: 60_000 });
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason, state,
      usage_json, active_ms, created_at, updated_at) VALUES ('attempt-lead', 'run', ?, 'lead', 'claude', ?, NULL, 'running', ?, 0, ?, ?)`)
      .run(leadQitemId, JSON.stringify({ nativeSessionId: "gone", tmuxServer: "/tmp/tmux", paneId: "%1", processId: 999_999_999,
        processStart: "0", generation: 1, policyFingerprint: binding.policyFingerprint }),
      JSON.stringify({ activeMs: 0, inputTokens: { value: null, reason: "unobserved" },
        outputTokens: { value: null, reason: "unobserved" }, costUsd: { value: null, reason: "unobserved" } }),
      "2026-11-06T00:00:00.000Z", "2026-11-06T00:00:00.000Z");
    await completion.sweep();
    completion.stop();
    // The lead's turn was a management turn: it wrote the proposal and nothing else, so its own
    // evidence validates, and the list it delivered is admitted with no owner decision.
    expect(governance.getTask(leadQitemId)?.evidence).toMatchObject({ validated: true });
    expect(governance.findTask("run", "task-2")).not.toBeNull();
    expect(governance.getRun("run").state).toBe("approved");
  });
});