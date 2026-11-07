import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { composeTaskDispatch } from "../src/domain/task-dispatch.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { createTeam, listTeams } from "../src/domain/team-setup.js";
import { leadRoster, parseLeadProposal, parseLeadProposalFile } from "../src/domain/lead-proposal.js";
import { composeLeadManager, proposalAlreadyAdmitted } from "../src/domain/lead-manager.js";
import { parseLeadRoster } from "../src/domain/lead-roster.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";

const implementer = { role: "implementer", client: "codex" } as const;
const reviewer = { role: "reviewer", client: "claude-code" } as const;
const owner = { kind: "owner", sessionId: "owner" } as const;
const daemon = { kind: "daemon", sessionId: "daemon" } as const;
const unavailable = { value: null, reason: "unobserved" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };

describe("delivery roster changes", () => {
  let root: string, rigId: string, db: Database.Database, governance: PlanGovernance;
  let binding: ReturnType<typeof bindingForGoal>;
  let serial: number;
  const request = (actionId: string, payload: unknown, runId = "run") => ({ protocolVersion: "1.0", runId, actionId,
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: `request-${++serial}`, payload });
  const task = (taskId: string, seat = "impl-1@demo", paths = [`src/${taskId}.ts`]) => ({ taskId, seat, paths, dependencies: [], body: `Work ${taskId}` });
  const approveRun = (runId: string, reviewerSeat: string | null = "review-1@demo") => {
    governance.createRun({ id: runId, rigId, binding, reviewerSeat });
    governance.requestApproval(request("approval-" + runId, { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2099-01-01T00:00:00.000Z" }, runId), owner);
    governance.decideApproval(request("approval-" + runId, { approvalVersion: 1, decision: "approved" }, runId), owner, binding);
  };
  const state = () => ({ nodes: db.prepare("SELECT id, logical_id, retired_at FROM nodes ORDER BY id").all(),
    sessions: db.prepare("SELECT id, session_name FROM sessions ORDER BY id").all(),
    tasks: db.prepare("SELECT run_id, task_id FROM team_queue_authority ORDER BY run_id, task_id").all(),
    reviewer: governance.getRun("run").reviewerSeat });
  const addTask = (taskId: string, seat: string, runId = "run") => {
    const result = governance.admitLeadProposal(request("tasks-" + taskId, {}, runId), daemon, binding, [task(taskId, seat)]);
    expect(result.status, result.reason ?? "").toBe("accepted");
    return governance.findTask(runId, taskId)!.qitemId;
  };
  const completeTask = (taskId: string, evidence: Record<string, unknown>, runId = "run") => {
    const assigned = governance.findTask(runId, taskId)!;
    const item = new QueueRepository(db, new EventBus(db)).getById(assigned.qitemId)!;
    const attemptId = `${taskId}-attempt-${++serial}`;
    const recorded = governance.recordAttempt(request(attemptId, { qitemId: assigned.qitemId,
      role: assigned.assignment.role, provider: assigned.assignment.role === "reviewer" ? "claude" : "codex",
      identity: { nativeSessionId: attemptId, tmuxServer: join(root, "tmux.sock"), paneId: "%1", processId: 1,
        processStart: "0", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "stopped", usage }, runId), binding);
    expect(recorded.status, recorded.reason ?? "").toBe("observed");
    return governance.recordTaskOutcome(request(assigned.qitemId, { expectedTaskVersion: assigned.entityVersion,
      state: "done", closureReason: "no-follow-on", actorSession: item.destinationSession,
      attemptId, expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion, evidence }, runId), owner);
  };
  beforeEach(() => {
    serial = 0; root = mkdtempSync(join(tmpdir(), "delivery-roster-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q"); writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    git("add", "plan.md"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    rigId = createTeam(db, { repository: root, name: "demo", seats: [{ role: "lead", client: "claude-code" }, implementer, reviewer] }).id;
    const policy = unisolatedPolicyCapability(2), bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), undefined, () => policy);
    binding = bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy });
    approveRun("run");
    expect(governance.createTask(request("lead", { assignment: { taskId: "lead", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["request-assignment"], sourceSession: "owner", destinationSession: "lead-1@demo", body: "Manage the work" }), binding).status).toBe("accepted");
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("adds and assigns together, then allocates the next role index on another proposal", () => {
    for (const index of [2, 3]) {
      const receipt = governance.admitLeadProposal(request("add-" + index, {}), daemon, binding,
        [task("work-" + index, `impl-${index}@demo`)], { add: [implementer], retire: [] }, 6);
      expect(receipt.status, receipt.reason ?? "").toBe("accepted");
      expect(governance.findTask("run", "work-" + index)).not.toBeNull();
    }
    expect(leadRoster(db, { rigId, roles: ["implementer"], excludeSeat: "lead-1@demo" }).map(seat => seat.member))
      .toEqual(["impl-1@demo", "impl-2@demo", "impl-3@demo"]);
  });

  it("retires an idle reviewer without deleting history, then adds its successor", () => {
    expect(governance.admitLeadProposal(request("retire", {}), daemon, binding, [task("first")],
      { add: [], retire: ["review-1@demo"] }, 6).status).toBe("accepted");
    expect(governance.getRun("run").reviewerSeat).toBeNull();
    expect(db.prepare("SELECT retired_at FROM nodes WHERE logical_id = 'demo.review-1'").get()).toEqual({ retired_at: expect.any(String) });
    expect(listTeams(db)[0]!.seats.filter(seat => seat.role === "reviewer")).toHaveLength(0);
    expect(governance.admitLeadProposal(request("replace", {}), daemon, binding, [task("second")],
      { add: [reviewer], retire: [] }, 2).status).toBe("accepted");
    expect(governance.getRun("run").reviewerSeat).toBe("review-2@demo");
    expect(leadRoster(db, { rigId, roles: ["reviewer"], excludeSeat: "lead-1@demo" }).map(seat => seat.member)).toEqual(["review-2@demo"]);
  });

  it("reserves retired implementer names", () => {
    expect(governance.admitLeadProposal(request("replace", {}), daemon, binding, [task("new", "impl-2@demo")],
      { add: [implementer], retire: ["impl-1@demo"] }, 6).status).toBe("accepted");
    expect(db.prepare("SELECT retired_at FROM nodes WHERE logical_id = 'demo.impl-1'").get()).toEqual({ retired_at: expect.any(String) });
    expect(governance.admitLeadProposal(request("another", {}), daemon, binding, [task("next", "impl-3@demo")],
      { add: [implementer], retire: [] }, 6).status).toBe("accepted");
  });

  it.each(["cap", "scope", "destination"])("refuses an invalid %s without partial seat or task effects", cause => {
    const before = state();
    const proposed = cause === "scope" ? task("bad", "impl-2@demo", ["outside/file.ts"])
      : task("bad", cause === "destination" ? "missing@demo" : "impl-2@demo");
    const result = governance.admitLeadProposal(request("bad", {}), daemon, binding, [proposed],
      { add: [implementer], retire: [] }, cause === "cap" ? 2 : 6);
    expect(result.status).toBe("denied");
    expect(state()).toEqual(before);
  });

  it.each(["no implementer", "two reviewers"])("refuses a final roster with %s without partial writes", cause => {
    const before = state();
    const changes = cause === "no implementer" ? { add: [], retire: ["impl-1@demo"] } : { add: [reviewer], retire: [] };
    const receipt = governance.admitLeadProposal(request("invalid-roles", {}), daemon, binding, [task("new")], changes, 6);
    expect(receipt.status).toBe("denied");
    expect(receipt.reason).toContain(cause === "no implementer" ? "at least one implementer" : "more than one reviewer");
    expect(state()).toEqual(before);
  });

  it.each(["pending", "in-progress", "blocked", "failed"])("keeps a seat assigned a %s task in another run", queueState => {
    approveRun("other", null);
    const qitem = addTask("busy", "impl-1@demo", "other");
    db.prepare("UPDATE queue_items SET state = ? WHERE qitem_id = ?").run(queueState, qitem);
    const before = state();
    const result = governance.admitLeadProposal(request("retire", {}), daemon, binding, [task("next", "impl-2@demo")],
      { add: [implementer], retire: ["impl-1@demo"] }, 6);
    expect(result.status).toBe("denied"); expect(result.reason).toContain("unfinished"); expect(state()).toEqual(before);
  });

  it.each([
    { runId: "run", reviewState: "pending" }, { runId: "run", reviewState: "in-progress" },
    { runId: "other", reviewState: "pending" }, { runId: "other", reviewState: "in-progress" },
  ])("keeps an implementer awaiting a $reviewState review in $runId, then dispatches its rework", async ({ runId, reviewState }) => {
    if (runId === "other") approveRun(runId);
    const qitemId = addTask("reviewed", "impl-1@demo", runId);
    expect(completeTask("reviewed", { validated: true }, runId)).toMatchObject({ status: "observed", reviewTaskId: "reviewed-review-1" });
    expect(governance.queueState(qitemId)).toBe("done");
    const review = governance.findTask(runId, "reviewed-review-1")!;
    expect(review.assignment.reviewOf).toBe("reviewed");
    if (reviewState === "in-progress") {
      expect(governance.transitionTask(request(review.qitemId, { expectedTaskVersion: review.entityVersion,
        state: "in-progress", actorSession: "review-1@demo" }, runId), binding).status).toBe("accepted");
    }
    const before = state();
    const result = governance.admitLeadProposal(request("retire-reviewed", {}), daemon, binding,
      [task("replacement", "impl-2@demo")], { add: [implementer], retire: ["impl-1@demo"] }, 6);
    expect(result.status).toBe("denied");
    expect(result.reason).toContain("unresolved review");
    expect(state()).toEqual(before);
    expect(completeTask("reviewed-review-1", { findings: [{ id: "R1-1", severity: "P1", citation: "KTD5",
      file: "src/reviewed.ts", category: "correctness", scenario: "The assigned task needs its first implementation corrected." }] }, runId))
      .toMatchObject({ status: "observed", reworkTaskId: "reviewed" });
    expect(governance.queueState(qitemId)).toBe("pending");
    const sessions = new SessionRegistry(db), seat = sessions.findResumeContextByName("impl-1@demo")!;
    sessions.updateBinding(seat.nodeId, { attachmentType: "tmux", tmuxSession: "impl-1@demo", tmuxPane: "%1" });
    const started: unknown[] = [];
    await composeTaskDispatch({ rigRepo: new RigRepository(db), sessions,
      tmux: { listPanes: async () => [{ id: "%1" }], getPaneExit: async () => ({ dead: false, code: null }) } as never,
      startupOrchestrator: { startNode: async (input: unknown) => { started.push(input); return { ok: true }; } } as never,
      runtimeAdapters: { codex: { runtime: "codex" } } as never,
      maxSessions: () => binding.limits.maxSessions, liveSessions: () => 0,
    })(runId, "reviewed");
    expect(started).toEqual([expect.objectContaining({ sessionName: "impl-1@demo", taskId: "reviewed" })]);
  });

  it("allows retirement after the implementer's review approves its completed work", () => {
    const qitemId = addTask("reviewed", "impl-1@demo");
    expect(completeTask("reviewed", { validated: true }).status).toBe("observed");
    expect(completeTask("reviewed-review-1", { findings: [] }).status).toBe("observed");
    expect(governance.queueState(qitemId)).toBe("done");
    expect(governance.admitLeadProposal(request("retire-reviewed", {}), daemon, binding,
      [task("replacement", "impl-2@demo")], { add: [implementer], retire: ["impl-1@demo"] }, 6).status).toBe("accepted");
    expect(leadRoster(db, { rigId, roles: ["implementer"], excludeSeat: "lead-1@demo" }).map(seat => seat.member)).toEqual(["impl-2@demo"]);
  });

  it.each(["running", "unknown"])("keeps a seat with a %s attempt even after its task is canceled", attemptState => {
    const qitem = addTask("busy", "impl-1@demo");
    db.prepare("UPDATE queue_items SET state = 'canceled' WHERE qitem_id = ?").run(qitem);
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, state, identity_json, unknown_reason,
      usage_json, active_ms, created_at, updated_at)
      VALUES ('busy-attempt', 'run', ?, 'implementer', 'codex', ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .run(qitem, attemptState, attemptState === "unknown" ? null : JSON.stringify({ nativeSessionId: "fixture",
        tmuxServer: "fixture", paneId: "%1", processId: 1, processStart: "0", generation: 1, policyFingerprint: binding.policyFingerprint }),
      attemptState === "unknown" ? "receipt pending" : null, JSON.stringify(usage));
    const before = state();
    const result = governance.admitLeadProposal(request("retire", {}), daemon, binding, [task("next", "impl-2@demo")],
      { add: [implementer], retire: ["impl-1@demo"] }, 6);
    expect(result.status).toBe("denied"); expect(result.reason).toContain("live attempt"); expect(state()).toEqual(before);
  });

  it("keeps an admitted native launch reserved until its latest intent is resolved", () => {
    approveRun("other", null);
    const qitemId = addTask("native", "impl-1@demo", "other");
    db.prepare("UPDATE queue_items SET state = 'canceled' WHERE qitem_id = ?").run(qitemId);
    const recordIntent = (state: "admitted" | "not_started") => db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'team.control', ?)").run(rigId,
      JSON.stringify({ type: "team.control", protocolVersion: "1.0", runId: "other", rigId, taskId: "native",
        attemptId: "native-attempt", action: "attempt.launch-intent", payload: { attemptId: "native-attempt", qitemId,
          sessionId: "impl-1@demo", role: "implementer", provider: "codex", generation: 1, previous: null,
          bindingDigest: hashBinding(binding), policyFingerprint: binding.policyFingerprint, commandDigest: "fixture", taskVersion: 1, state } }));
    recordIntent("admitted");
    expect(governance.getNativeLaunchIntent("other", "native-attempt")?.state).toBe("admitted");
    const before = state();
    const propose = () => governance.admitLeadProposal(request("retire", {}), daemon, binding, [task("replacement", "impl-2@demo")],
      { add: [implementer], retire: ["impl-1@demo"] }, 6);
    const refused = propose();
    expect(refused.status).toBe("denied"); expect(refused.reason).toContain("pending native launch"); expect(state()).toEqual(before);
    recordIntent("not_started");
    expect(governance.getNativeLaunchIntent("other", "native-attempt")?.state).toBe("not_started");
    expect(propose().status).toBe("accepted");
    expect(leadRoster(db, { rigId, roles: ["implementer"], excludeSeat: "lead-1@demo" }).map(seat => seat.member)).toEqual(["impl-2@demo"]);
  });

  it.each(["approved", "blocked"])("keeps the reviewer reserved by another %s run with no reviewer task yet", runState => {
    approveRun("other"); db.prepare("UPDATE team_runs SET state = ? WHERE id = 'other'").run(runState);
    const before = state();
    const result = governance.admitLeadProposal(request("retire", {}), daemon, binding, [task("next")],
      { add: [], retire: ["review-1@demo"] }, 6);
    expect(result.status).toBe("denied"); expect(result.reason).toContain("another open run");
    expect(governance.getRun("other").reviewerSeat).toBe("review-1@demo"); expect(state()).toEqual(before);
  });

  it("replays the whole seat-bearing proposal but refuses a changed seat delta with the same tasks", async () => {
    const lead = governance.findTask("run", "lead")!;
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(lead.qitemId);
    const proposal = { tasks: [task("new", "impl-2@demo")], seats: { add: [implementer], retire: [] as string[] } };
    const manager = composeLeadManager({ db, governance, readLeadProposal: () => proposal,
      currentBinding: () => binding, dispatch: () => undefined, log: () => {} });
    const turn = (id: string) => manager.turnEnd({ id, runId: "run", qitemId: lead.qitemId, role: "lead" });
    await turn("first");
    expect(governance.findTask("run", "new")).not.toBeNull();
    expect(proposalAlreadyAdmitted(db, "run", proposal.tasks, proposal.seats)).toBe(true);
    const admitted = state();
    await turn("replayed");
    expect(state()).toEqual(admitted);
    expect(governance.queueState(lead.qitemId)).toBe("done");
    expect(db.prepare(`SELECT count(*) AS n FROM team_control_requests WHERE run_id = 'run'
      AND json_extract(response_json, '$.value.proposalDigest') IS NOT NULL`).get()).toEqual({ n: 1 });
    proposal.seats.add.push(implementer);
    expect(proposalAlreadyAdmitted(db, "run", proposal.tasks, proposal.seats)).toBe(false);
    await turn("changed");
    expect(state()).toEqual(admitted);
    expect(governance.queueState(lead.qitemId)).toBe("pending");
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.action') = 'lead.proposal-refused'`).get()).toEqual({ n: 1 });
  });

  it("preserves task-only proposal behavior", () => {
    const before = state(); addTask("ordinary", "impl-1@demo");
    expect(state().nodes).toEqual(before.nodes); expect(state().sessions).toEqual(before.sessions);
    expect(state().reviewer).toBe(before.reviewer);
  });
});

describe("planning roster parser", () => {
  it("accepts different clients and rejects unknown fields and roles", () => {
    expect(parseLeadRoster({ seats: [implementer, reviewer] })).toEqual([implementer, reviewer]);
    for (const value of [{ seats: [] }, { seats: [reviewer] }, { seats: [implementer, reviewer, reviewer] },
      { seats: [implementer], extra: true }, { seats: [{ ...implementer, model: "extra" }] },
      { seats: [{ role: "lead", client: "codex" }] }, { seats: [{ role: "implementer", client: "claude" }] }]) {
      expect(() => parseLeadRoster(value)).toThrow();
    }
  });
});


describe("delivery proposal parser", () => {
  const tasks = [{ taskId: "new", seat: "impl-2@demo", paths: ["src/health.ts"], dependencies: [], body: "Add health" }];

  it("keeps the task-only contract and normalizes omitted seat operations", () => {
    expect(parseLeadProposalFile({ tasks })).toEqual({ tasks: parseLeadProposal({ tasks }) });
    expect(parseLeadProposalFile({ tasks, seats: { add: [implementer] } }))
      .toEqual({ tasks, seats: { add: [implementer], retire: [] } });
    expect(parseLeadProposalFile({ tasks, seats: { retire: ["review-1@demo"] } }))
      .toEqual({ tasks, seats: { add: [], retire: ["review-1@demo"] } });
    expect(() => parseLeadProposal({ tasks, seats: {} })).toThrow();
  });

  it.each([
    { tasks: [], seats: { add: [implementer] } },
    { tasks, extra: true },
    { tasks, seats: null },
    { tasks, seats: { add: null } },
    { tasks, seats: { add: [{ role: "lead", client: "codex" }] } },
    { tasks, seats: { add: [{ ...implementer, model: "extra" }] } },
    { tasks, seats: { add: [{ role: "implementer", client: "other" }] } },
    { tasks, seats: { retire: "review-1@demo" } },
    { tasks, seats: { retire: ["review-1@demo", "review-1@demo"] } },
    { tasks, seats: { retire: [""] } },
    { tasks, seats: { extra: true } },
  ])("rejects an invalid seat-bearing proposal: %j", proposal => {
    expect(() => parseLeadProposalFile(proposal)).toThrow();
  });
});
