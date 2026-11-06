import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, fixDaemonMode, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { unisolatedPolicyCapability, refreshPlanBinding } from "../src/routes/team-start.js";
import { composeLeadTurnEnd, listChatMessages, pendingOwnerMessages } from "../src/domain/lead-chat.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { composeAttemptCompletion } from "../src/domain/attempt-completion.js";
import { runSlug } from "../src/domain/plan-branch.js";
import { ScopeExtensionError } from "../src/domain/scope-extension.js";
import { LeadWakePolicy } from "../src/domain/lead-wake-policy.js";
import { createTestApp } from "./helpers/test-app.js";

/**
 * U5 — the owner and the lead agree a plan in a chat, and one approval starts the run.
 *
 * Everything is driven through the real routes and the real governance owner against a
 * repository on disk. The one injected piece is the candidate runtime: it stands in for the
 * lead's tree, which the launch path owns, so the plan read is exercised without a client.
 */

const ownerToken = "owner-lead-fixture";
const workerToken = "worker-lead-fixture";
const policy = unisolatedPolicyCapability(4);

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "u5-lead-chat-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  return root;
}

describe("U5 — lead chat and plan approval", () => {
  let directory: string, worktrees: string, candidates: string;
  let db: Database.Database, governance: PlanGovernance;
  let app: ReturnType<typeof createTestApp>["app"];
  let dispatch: ReturnType<typeof vi.fn>;
  let forgetCandidate: ReturnType<typeof vi.fn>;

  const call = (path: string, payload?: unknown, token: string | null = ownerToken) => app.request(`/api/team-control${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  const startPlanning = (body: Record<string, unknown> = {}) => call("/runs", {
    goal: "Add a health endpoint", planning: true, writePaths: ["src"], ...body });

  /** One control request, with the run's current entity version, as a client builds it. */
  const command = (runId: string, actionId: string, payload: unknown) => ({
    protocolVersion: "1.0", runId, actionId, expectedEntityVersion: governance.getRun(runId).entityVersion,
    idempotencyKey: `key-${actionId}-${Math.random()}`, payload,
  });

  beforeEach(() => {
    directory = repository();
    worktrees = mkdtempSync(join(tmpdir(), "u5-worktrees-"));
    candidates = mkdtempSync(join(tmpdir(), "u5-candidates-"));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    fixDaemonMode(db, true);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'demo')").run();
    for (const [id, role, seat] of [["lead-node", "lead", "lead@demo"], ["impl-node", "implementer", "impl@demo"],
      ["review-node", "reviewer", "review@demo"]] as const) {
      db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, 'rig', ?, ?, 'claude-code', ?)`)
        .run(id, id, role, directory);
      db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run(`s-${id}`, id, seat);
    }
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => policy);
    dispatch = vi.fn(async () => {});
    forgetCandidate = vi.fn();
    // The lead's candidate tree, which the launch path would own. The runtime here is only the
    // reader the routes use for worker-written files, so a test can write the plan the way a
    // lead's turn would.
    const runtime = {
      planFor: (_runId: string, taskId: string, planRef: string) => {
        const path = join(candidates, taskId, planRef);
        return { content: readFileSync(path, "utf8"), hash: "sha256:" + "0".repeat(64) };
      },
      leadProposalFor: () => { throw new Error("no proposal"); },
      forgetCandidate,
    };
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      workflowRuntime: runtime as never,
      teamControl: { credentials: { ownerToken, workers: [{ token: workerToken, sessionId: "impl@demo", runId: "other" }] },
        readPolicyCapability: () => policy, planWorktreeRoot: () => worktrees, dispatch } } }).app;
  });

  afterEach(() => {
    if (db?.open) db.close();
    for (const path of [directory, worktrees, candidates]) rmSync(path, { recursive: true, force: true });
  });

  /** Start a planning run and return its receipt. */
  const planningRun = async (body: Record<string, unknown> = {}) => {
    const response = await startPlanning(body);
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as Record<string, string>;
  };

  it("starts a planning run whose binding lives in the daemon's worktree, not the owner's checkout", async () => {
    const receipt = await planningRun();
    expect(receipt).toMatchObject({ taskId: "task-1", seat: "lead@demo", leadSeat: "lead@demo", reviewerSeat: "review@demo",
      state: "approved", phase: "planning" });
    const run = governance.getRun(receipt.runId!);
    expect(run.phase).toBe("planning");
    // The binding names the daemon-owned worktree, and the owner's checkout still has no plan.md.
    expect(run.binding.repository.root).toBe(join(worktrees, receipt.runId!));
    expect(() => readFileSync(join(directory, "plan.md"))).toThrow();
    expect(run.binding.writePaths).toEqual(["plan.md"]);
    // The owner's scope travels with the run until the approval turns it into the delivery scope.
    expect(run.binding.readPaths).toEqual(["plan.md", "src"]);
    // The plan worktree is a checkout of the daemon's own branch at the run's commit.
    expect(execFileSync("git", ["-C", run.binding.repository.root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim())
      .toBe(runSlug({ runId: receipt.runId!, name: "Add a health endpoint" }));
    expect(readFileSync(join(run.binding.repository.root, "plan.md"), "utf8")).toContain("Goal: Add a health endpoint");
    // The lead's first task is the conversation, and the plan file is all it may write.
    const task = governance.findTask(receipt.runId!, "task-1")!;
    expect(task.assignment).toEqual({ taskId: "task-1", role: "lead", paths: ["plan.md"], dependencies: [] });
    expect(dispatch).toHaveBeenCalledWith(receipt.runId, "task-1");
  });

  it("refuses a planning run with no lead seat on the rig", async () => {
    db.prepare("UPDATE nodes SET role = 'implementer' WHERE id = 'lead-node'").run();
    const response = await startPlanning();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "lead_required" });
  });

  it("starts planning with only the lead, while delivery still requires an implementer", async () => {
    db.prepare("DELETE FROM sessions WHERE node_id != 'lead-node'").run();
    db.prepare("DELETE FROM nodes WHERE id != 'lead-node'").run();
    const receipt = await planningRun();
    expect(receipt).toMatchObject({ seat: "lead@demo", leadSeat: "lead@demo", reviewerSeat: null, phase: "planning" });
    const run = governance.getRun(receipt.runId!);
    expect(run.binding.repository.root).toBe(join(worktrees, receipt.runId!));
    expect(readFileSync(join(run.binding.repository.root, "plan.md"), "utf8")).toContain("Goal: Add a health endpoint");
    expect(run.binding.writePaths).toEqual(["plan.md"]);
    expect(dispatch).toHaveBeenCalledWith(receipt.runId, "task-1");
    const delivery = await startPlanning({ planning: false });
    expect(delivery.status).toBe(400);
    expect(await delivery.json()).toMatchObject({ code: "lead_roster_empty" });
  });

  it("stores the owner's message and starts exactly one lead turn for it", async () => {
    const receipt = await planningRun();
    dispatch.mockClear();
    const sent = await call(`/runs/${receipt.runId}/chat`, command(receipt.runId!, "chat-1", { body: "What would you build first?" }));
    expect(sent.status, await sent.clone().text()).toBe(200);
    const answer = await sent.json() as { status: string; value: { queued: boolean } };
    expect(answer.status).toBe("accepted");
    expect(answer.value.queued).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(receipt.runId, "task-1");
    // The conversation lists it in order, and the message is waiting for a lead prompt.
    const read = await (await call(`/runs/${receipt.runId}/chat`)).json() as { phase: string;
      messages: Array<{ sender: string; body: string }> };
    expect(read.phase).toBe("planning");
    expect(read.messages).toEqual([{ id: "chat-1", sender: "owner", kind: "text", body: "What would you build first?",
      options: null, answeredBy: null, createdAt: expect.any(String) }]);
    expect(pendingOwnerMessages(db, receipt.runId!).map(message => message.body)).toEqual(["What would you build first?"]);
  });

  it("queues a second message while a lead turn is running, and never starts a second turn", async () => {
    const receipt = await planningRun();
    const task = governance.findTask(receipt.runId!, "task-1")!;
    // A lead turn observed running: the same row the sweep writes from a launch receipt.
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason, state,
      usage_json, active_ms, created_at, updated_at) VALUES (?, ?, ?, 'lead', 'claude', ?, NULL, 'running', ?, 0, ?, ?)`)
      .run("attempt-live", receipt.runId, task.qitemId, JSON.stringify({ nativeSessionId: "s", tmuxServer: "/tmp/tmux",
        paneId: "%1", processId: process.pid, processStart: "0", generation: 1, policyFingerprint: policy.policyFingerprint }),
      JSON.stringify({ activeMs: 0, inputTokens: { value: null, reason: "unobserved" },
        outputTokens: { value: null, reason: "unobserved" }, costUsd: { value: null, reason: "unobserved" } }),
      "2026-11-04T00:00:00.000Z", "2026-11-04T00:00:00.000Z");
    dispatch.mockClear();
    const sent = await call(`/runs/${receipt.runId}/chat`, command(receipt.runId!, "chat-2", { body: "Also add tests." }));
    expect(sent.status).toBe(200);
    expect((await sent.json() as { value: { queued: boolean } }).value.queued).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dispatch).not.toHaveBeenCalled();
    // The message is kept, and the enough rows exist for the next turn to answer it.
    expect(governance.chatMessages(receipt.runId!).map(message => message.body)).toEqual(["Also add tests."]);
    expect(pendingOwnerMessages(db, receipt.runId!)).toHaveLength(1);
  });

  it("refuses a plan approval with no plan in the lead's tree", async () => {
    const receipt = await planningRun();
    const response = await call(`/runs/${receipt.runId}/plan/approve`, command(receipt.runId!, "approve-1", {}));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "plan_missing" });
    expect(governance.getRun(receipt.runId!).phase).toBe("planning");
    expect(forgetCandidate).not.toHaveBeenCalled();
  });

  it("approves the plan: records it on the run's branch, rebinds the run and starts the decomposition", async () => {
    const receipt = await planningRun();
    const runId = receipt.runId!;
    const planText = "# Plan\n\n1. Add `GET /healthz` in src/health.ts.\n";
    mkdirSync(join(candidates, "task-1"), { recursive: true });
    writeFileSync(join(candidates, "task-1", "plan.md"), planText);
    const before = governance.getRun(runId);
    const currentBinding = refreshPlanBinding(before.binding, policy);
    expect(hashBinding(currentBinding)).toBe(before.bindingDigest);
    dispatch.mockClear();
    const response = await call(`/runs/${runId}/plan/approve`, command(runId, "approve-1", {}));
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { status: string; value: { phase: string; planRef: string } };
    expect(body).toMatchObject({ status: "accepted", value: { phase: "delivery", planRef: "plan.md" } });
    const run = governance.getRun(runId);
    expect(run.phase).toBe("delivery");
    expect(run.state).toBe("approved");
    // The plan's own bytes are what the run is bound to, recorded on the run's branch.
    expect(run.binding.planDigest).toBe(hashBytes(planText));
    expect(readFileSync(join(run.binding.repository.root, "plan.md"), "utf8")).toContain("GET /healthz");
    expect(execFileSync("git", ["-C", run.binding.repository.root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim())
      .toBe("plan: Add a health endpoint");
    // A delivery binding covers the owner's scope and still covers the lead task it admitted.
    expect(run.binding.writePaths).toEqual(["plan.md", "src"]);
    expect(governance.listApprovals(runId).filter(approval => approval.action === "implementation"
      && approval.bindingDigest === run.bindingDigest).map(approval => approval.state)).toEqual(["approved"]);
    // The lead's tree is re-adopted at the new base, and its next turn is the decomposition.
    expect(forgetCandidate).toHaveBeenCalledWith(runId, "task-1");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dispatch).toHaveBeenCalledWith(runId, "task-1");
    // Approving twice is refused rather than re-binding what the owner already approved.
    expect((await call(`/runs/${runId}/plan/approve`, command(runId, "approve-2", {}))).status).toBe(409);
  });

  it("refuses a lead write outside the plan during planning", async () => {
    const receipt = await planningRun();
    const run = governance.getRun(receipt.runId!);
    const stage = () => governance.stageCandidateScope(receipt.runId!, "task-1", { root: candidates,
      candidateDigest: "sha256:" + "1".repeat(64), files: ["src/base.ts"],
      changes: [{ path: "src/base.ts", before: Buffer.from("export const base = 1;\n"), after: Buffer.from("export const base = 2;\n") }] });
    expect(stage).toThrow(ScopeExtensionError);
    expect(stage).toThrow(/outside-write-paths/);
    // The plan itself is the one file the lead may write.
    expect(governance.stageCandidateScope(receipt.runId!, "task-1", { root: candidates,
      candidateDigest: "sha256:" + "2".repeat(64), files: ["plan.md"],
      changes: [{ path: "plan.md", before: null, after: Buffer.from("# Plan\n") }] })).toBeTruthy();
    expect(run.binding.writePaths).toEqual(["plan.md"]);
  });

  it("keeps every message and resumes the same conversation after the daemon is recomposed", async () => {
    const receipt = await planningRun();
    await call(`/runs/${receipt.runId}/chat`, command(receipt.runId!, "chat-1", { body: "First question." }));
    // A fresh composition over the same database: the rows, not the process, hold the chat.
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    const reopened = new PlanGovernance(db, bus, queue, undefined, () => policy);
    const again = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: reopened,
      workflowRuntime: { planFor: () => ({ content: "", hash: "" }), leadProposalFor: () => [], forgetCandidate: () => {} } as never,
      teamControl: { credentials: { ownerToken }, readPolicyCapability: () => policy, planWorktreeRoot: () => worktrees, dispatch } } }).app;
    const listed = await again.request(`/api/team-control/runs/${receipt.runId}/chat`, {
      headers: { Authorization: "Bearer " + ownerToken } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { messages: Array<{ body: string }> }).messages.map(message => message.body))
      .toEqual(["First question."]);
    // The next owner message is a new turn on the same lead task, so the launch resumes the
    // seat's recorded conversation rather than starting a second one.
    dispatch.mockClear();
    const sent = await again.request(`/api/team-control/runs/${receipt.runId}/chat`, { method: "POST",
      headers: { Authorization: "Bearer " + ownerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: "1.0", runId: receipt.runId, actionId: "chat-2",
        expectedEntityVersion: reopened.getRun(receipt.runId!).entityVersion, idempotencyKey: "key-chat-2",
        payload: { body: "Second question." } }) }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(sent.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dispatch).toHaveBeenCalledWith(receipt.runId, "task-1");
    expect(reopened.chatMessages(receipt.runId!).map(message => message.body)).toEqual(["First question.", "Second question."]);
  });

  it("refuses the chat to a caller that is not the owner", async () => {
    const receipt = await planningRun();
    const response = await call(`/runs/${receipt.runId}/chat`, command(receipt.runId!, "chat-1", { body: "hi" }), workerToken);
    expect(response.status).toBe(403);
    expect(listChatMessages(db, receipt.runId!)).toEqual([]);
  });

  it("counts the owner's message as progress, so a planning conversation is not a lead spin", async () => {
    // Without this, three lead turns in a row trip `lead-wake:cycles` and the run blocks in the
    // middle of a conversation the owner is driving — measured on this slice's own demo.
    const receipt = await planningRun();
    const run = governance.getRun(receipt.runId!), task = governance.findTask(receipt.runId!, "task-1")!;
    const bus = new EventBus(db), leadWake = new LeadWakePolicy(db, bus);
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 5, 12, minute)).toISOString();
    const wakes = db.transaction(() => {
      const reasons: Array<string | null> = [];
      for (const minute of [0, 1, 2]) {
        const check = leadWake.check(run, task.qitemId, at(minute));
        reasons.push(check.reason);
        if (!check.reason) leadWake.record(run, task.qitemId, at(minute), check, () => {});
      }
      return reasons;
    })();
    // Two lead turns with nothing between them is the cycle the guard exists for.
    expect(wakes).toEqual([null, null, "lead-wake:cycles"]);
    // The owner's message is the progress: it is an observed owner action on this run.
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig', 'lead-node', 'team.control', ?)")
      .run(JSON.stringify({ type: "team.control", protocolVersion: "1.0", eventId: "e-chat", rigId: "rig",
        runId: receipt.runId, taskId: "task-1", attemptId: null, entityId: receipt.runId, entityVersion: 1,
        action: "chat.message", payload: { messageId: "chat-1", observedBy: "owner-control" } }));
    const after = db.transaction(() => {
      const check = leadWake.check(run, task.qitemId, at(3));
      const reason = check.reason;
      if (!reason) leadWake.record(run, task.qitemId, at(3), check, () => {});
      return reason;
    })();
    expect(after).toBeNull();
  });
});

describe("U5 — the lead turn's end is its reply", () => {
  let root: string, db: Database.Database, governance: PlanGovernance;

  const bindingFixture = () => ({ artifactContract: "spec-unified-plan/v1" as const, artifactReadiness: "implementation-ready" as const,
    execution: "code" as const, status: "active" as const, planRef: "plan.md", planDigest: "sha256:" + "a".repeat(64),
    repository: { root, identity: "git:" + "b".repeat(40) }, readPaths: ["plan.md", "src"], writePaths: ["plan.md"],
    roles: ["lead", "implementer", "reviewer"] as ("lead" | "implementer" | "reviewer")[],
    policyRevision: policy.policyRevision, policyFingerprint: policy.policyFingerprint,
    limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 } });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "u5-turn-end-"));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'demo')").run();
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-05T00:00:00.000Z"), () => policy);
    const binding = bindingFixture();
    db.prepare("INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, phase, created_at, updated_at) VALUES ('run', 'rig', ?, ?, 'approved', 'planning', ?, ?)")
      .run(JSON.stringify(binding), hashBinding(binding), "2026-11-05T00:00:00.000Z", "2026-11-05T00:00:00.000Z");
  });
  afterEach(() => { if (db?.open) db.close(); rmSync(root, { recursive: true, force: true }); });

  it("stores the turn's final message as the lead's reply, once, from either client's one file", async () => {
    // The same file a Codex turn writes through `-o`, under the attempt's own output directory.
    const output = agentTurnOutputPaths(root, "attempt-1");
    mkdirSync(output.directory, { recursive: true });
    writeFileSync(output.lastMessage, "  I would start with a health endpoint.\n");
    const turnEnd = composeLeadTurnEnd({ db, governance, turnStateRoot: root, dispatch: () => undefined });
    await turnEnd({ id: "attempt-1", runId: "run", qitemId: null, role: "lead" });
    expect(listChatMessages(db, "run")).toMatchObject([{ sender: "lead", body: "I would start with a health endpoint.",
      attemptId: "attempt-1" }]);
    // A second sweep observation records nothing twice.
    await turnEnd({ id: "attempt-1", runId: "run", qitemId: null, role: "lead" });
    expect(listChatMessages(db, "run")).toHaveLength(1);
    // A turn with no recorded final message stores no reply at all.
    await turnEnd({ id: "attempt-2", runId: "run", qitemId: null, role: "lead" });
    expect(listChatMessages(db, "run")).toHaveLength(1);
    // A non-lead attempt's message is not a chat reply.
    const implementer = agentTurnOutputPaths(root, "attempt-3");
    mkdirSync(implementer.directory, { recursive: true });
    writeFileSync(implementer.lastMessage, "implemented\n");
    await turnEnd({ id: "attempt-3", runId: "run", qitemId: null, role: "implementer" });
    expect(listChatMessages(db, "run")).toHaveLength(1);
  });

  it("asks the turn-end owner once the sweep has observed the lead's attempt stop", async () => {
    // The conversation owner cannot see the end of a turn for itself; the sweep is the
    // observation. Without this call the lead's reply is never stored and the chat goes quiet.
    const onAttemptStopped = vi.fn(async () => {});
    const completion = composeAttemptCompletion({ db, governance, sessions: { findResumeContextByName: () => null,
      updateStartupStatus: () => {} }, currentBinding: () => refreshPlanBinding(governance.getRun("run").binding, policy),
      onAttemptStopped, intervalMs: 60_000 });
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason, state,
      usage_json, active_ms, created_at, updated_at) VALUES ('attempt-gone', 'run', NULL, 'lead', 'claude', ?, NULL, 'running', ?, 0, ?, ?)`)
      .run(JSON.stringify({ nativeSessionId: "gone", tmuxServer: "/tmp/tmux", paneId: "%1", processId: 999_999_999,
        processStart: "0", generation: 1, policyFingerprint: policy.policyFingerprint }),
      JSON.stringify({ activeMs: 0, inputTokens: { value: null, reason: "unobserved" },
        outputTokens: { value: null, reason: "unobserved" }, costUsd: { value: null, reason: "unobserved" } }),
      "2026-11-05T00:00:00.000Z", "2026-11-05T00:00:00.000Z");
    await completion.sweep();
    expect(governance.getAttempt("attempt-gone")?.state).toBe("stopped");
    expect(onAttemptStopped).toHaveBeenCalledWith(expect.objectContaining({ id: "attempt-gone", role: "lead" }));
    completion.stop();
  });
});
