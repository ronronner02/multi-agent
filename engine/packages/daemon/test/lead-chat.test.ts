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
import { bindingForGoal, unisolatedPolicyCapability, refreshPlanBinding } from "../src/routes/team-start.js";
import { composeLeadTurnEnd, responseLanguageNote, leadChatTurnNote, listChatMessages, pendingOwnerMessages, recordLeadReply, takeOwnerMessages } from "../src/domain/lead-chat.js";
import { AttemptTelemetry } from "../src/domain/attempt-telemetry.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { composeAttemptCompletion } from "../src/domain/attempt-completion.js";
import { commitPlan, ensurePlanWorktree, runSlug } from "../src/domain/plan-branch.js";
import { ScopeExtensionError } from "../src/domain/scope-extension.js";
import { LeadWakePolicy } from "../src/domain/lead-wake-policy.js";
import { createTestApp } from "./helpers/test-app.js";
import { leadRosterPath, parseLeadRoster } from "../src/domain/lead-roster.js";

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
const rosterBytes = JSON.stringify({ seats: [{ role: "implementer", client: "claude-code" },
  { role: "reviewer", client: "claude-code" }] });

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

      rosterFor: (_runId: string, taskId: string, planRef: string) => {
        const content = readFileSync(join(candidates, taskId, leadRosterPath(planRef)), "utf8");
        return { seats: parseLeadRoster(JSON.parse(content)), digest: hashBytes(content) };
      },
      leadProposalFor: () => { throw new Error("no proposal"); },
      forgetCandidate,
    };
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      workflowRuntime: runtime as never, attemptTelemetry: new AttemptTelemetry(db, { turnStateRoot: candidates }),
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
    expect(run.binding.writePaths).toEqual(["plan.md", "lead-roster.json", "lead-escalation.json"]);
    // The owner's scope travels with the run until the approval turns it into the delivery scope.
    expect(run.binding.readPaths).toEqual(["plan.md", "lead-roster.json", "lead-escalation.json", "src"]);
    // The plan worktree is a checkout of the daemon's own branch at the run's commit.
    expect(execFileSync("git", ["-C", run.binding.repository.root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim())
      .toBe(runSlug({ runId: receipt.runId!, name: "Add a health endpoint" }));
    expect(readFileSync(join(run.binding.repository.root, "plan.md"), "utf8")).toContain("Goal: Add a health endpoint");
    // The lead's first task is the conversation and its planning files.
    const task = governance.findTask(receipt.runId!, "task-1")!;
    expect(task.assignment).toEqual({ taskId: "task-1", role: "lead", paths: ["plan.md", "lead-roster.json", "lead-escalation.json"], dependencies: [] });
    expect(dispatch).toHaveBeenCalledWith(receipt.runId, "task-1");
  });

  it("retains the selected reply language across start, chat, and delivered turns", async () => {
    const { runId } = await planningRun({ responseLanguage: "zh-CN" });
    expect(listChatMessages(db, runId!)[0]).toMatchObject({ responseLanguage: "zh-CN" });
    expect(responseLanguageNote(listChatMessages(db, runId!))).toContain("Simplified Chinese (zh-CN)");
    takeOwnerMessages(db, runId!, "first-turn");
    const reply = await call(`/runs/${runId}/chat`, command(runId!, "english", {
      body: "Continue the discussion.", responseLanguage: "en",
    }));
    expect(reply.status).toBe(200);
    const history = listChatMessages(db, runId!);
    expect(db.prepare("SELECT response_language AS language FROM team_runs WHERE id = ?").get(runId))
      .toEqual({ language: "en" });
    expect(history.at(-1)).toMatchObject({ body: "Continue the discussion.", responseLanguage: "en" });
    expect(responseLanguageNote(history)).toContain("English (en)");
    expect(responseLanguageNote(history)).not.toContain("Simplified Chinese");
    expect(responseLanguageNote([])).toBeNull();
  });

  it("validates reply languages before a start or chat has effects", async () => {
    expect((await startPlanning({ responseLanguage: "invalid-language" })).status).toBe(400);
    const { runId } = await planningRun();
    const count = listChatMessages(db, runId!).length;
    expect((await call(`/runs/${runId}/chat`, command(runId!, "invalid-language", {
      body: "Continue", responseLanguage: "invalid-language",
    }))).status).toBe(400);
    expect(listChatMessages(db, runId!)).toHaveLength(count);
    expect(responseLanguageNote(listChatMessages(db, runId!))).toBeNull();
  });

  it("retains the first project discussion without admitting execution tasks", async () => {
    const receipt = await planningRun({ goal: "Discuss the scope before execution." });
    const response = await call(`/runs/${receipt.runId}/chat`);
    expect((await response.json()).messages).toMatchObject([
      { sender: "owner", body: "Discuss the scope before execution." },
    ]);
    expect(db.prepare("SELECT assignment_json FROM team_queue_authority WHERE run_id = ?").all(receipt.runId!))
      .toEqual([{ assignment_json: expect.stringContaining('"role":"lead"') }]);
    const backup = join(worktrees, "reopened.sqlite");
    await db.backup(backup);
    const reopened = createDb(backup);
    try {
      expect(listChatMessages(reopened, receipt.runId!).map(message => message.body))
        .toEqual(["Discuss the scope before execution."]);
    } finally { reopened.close(); }
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
    expect(run.binding.writePaths).toEqual(["plan.md", "lead-roster.json", "lead-escalation.json"]);
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
    expect(read.messages).toEqual([{ id: receipt.runId + ":initial", sender: "owner", kind: "text", body: "Add a health endpoint",
      options: null, answeredBy: null, createdAt: expect.any(String) }, { id: "chat-1", sender: "owner", kind: "text", body: "What would you build first?",
      options: null, answeredBy: null, createdAt: expect.any(String) }]);
    expect(pendingOwnerMessages(db, receipt.runId!).map(message => message.body)).toEqual(["Add a health endpoint", "What would you build first?"]);
    expect(leadChatTurnNote(pendingOwnerMessages(db, receipt.runId!))).toContain("Brief public progress updates are shown live");
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
    expect(governance.chatMessages(receipt.runId!).map(message => message.body)).toEqual(["Add a health endpoint", "Also add tests."]);
    expect(pendingOwnerMessages(db, receipt.runId!)).toHaveLength(2);
    const output = agentTurnOutputPaths(candidates, "attempt-live"); mkdirSync(output.directory, { recursive: true });
    writeFileSync(join(output.directory, "progress.json"), JSON.stringify({ version: 1, sequence: 2, at: "2026-11-08T01:00:00Z",
      status: "responding", blocks: [{ id: "text-1", text: "I am checking the current files.", complete: false }], truncated: false }));
    writeFileSync(output.activity, JSON.stringify({ id: "call-1", seq: 1, at: "2026-11-08T01:00:00Z", tool: "Read", summary: "src/base.ts", status: "running" }) + "\n");
    const response = await call(`/runs/${receipt.runId}/chat`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const current = await response.json();
    expect(current).toMatchObject({ liveTurn: { attemptId: "attempt-live", state: "running",
      progress: { sequence: 2, status: "responding", blocks: [{ text: "I am checking the current files." }] },
      activity: { records: [{ tool: "Read", status: "running" }] } } });
    expect(current.messages).toHaveLength(2);
    expect((await call(`/runs/${receipt.runId}/chat`, undefined, workerToken)).status).toBe(403);
    const other = await planningRun();
    expect(await (await call(`/runs/${other.runId}/chat`)).json()).toMatchObject({ liveTurn: null });
    recordLeadReply(db, { id: "chat-attempt-live", runId: receipt.runId!, attemptId: "attempt-live", body: "The final reply.",
      createdAt: "2026-11-08T01:01:00Z" });
    expect(await (await call(`/runs/${receipt.runId}/chat`)).json()).toMatchObject({ liveTurn: null });
  });

  it("refuses a plan approval with no plan in the lead's tree", async () => {
    const receipt = await planningRun();
    const response = await call(`/runs/${receipt.runId}/plan/approve`, command(receipt.runId!, "approve-1", {}));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "plan_missing" });
    expect(governance.getRun(receipt.runId!).phase).toBe("planning");
    expect(forgetCandidate).not.toHaveBeenCalled();
  });

  it.each(["running", "admitted", "queued", "question"])("waits for a %s planning turn before recording plan approval", async state => {
    const { runId } = await planningRun();
    const task = governance.findTask(runId!, "task-1")!;
    mkdirSync(join(candidates, "task-1"), { recursive: true });
    writeFileSync(join(candidates, "task-1", "plan.md"), "# An earlier plan");
    writeFileSync(join(candidates, "task-1", "lead-roster.json"), rosterBytes);
    if (state !== "queued") takeOwnerMessages(db, runId!, "planning-turn");
    if (state === "running") {
      db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason, state,
        usage_json, active_ms, created_at, updated_at) VALUES ('planning-turn', ?, ?, 'lead', 'claude', ?, NULL, 'running', ?, 0, '2026-11-08', '2026-11-08')`)
        .run(runId, task.qitemId, JSON.stringify({ nativeSessionId: 's', tmuxServer: '/tmp/tmux', paneId: '%1', processId: process.pid,
          processStart: '0', generation: 1, policyFingerprint: policy.policyFingerprint }),
        JSON.stringify({ activeMs: 0, inputTokens: { value: null, reason: 'unobserved' }, outputTokens: { value: null, reason: 'unobserved' }, costUsd: { value: null, reason: 'unobserved' } }));
    } else if (state === "admitted") {
      db.prepare("INSERT INTO events (type, payload) VALUES ('team.control', ?)").run(JSON.stringify({
        runId, attemptId: "planning-turn", action: "attempt.launch-intent", payload: { state: "admitted", qitemId: task.qitemId },
      }));
    }
    if (state === "question") recordLeadReply(db, { id: "open-question", runId: runId!, attemptId: "question-turn",
      body: "Which behavior?", decision: { options: ["A", "B"] }, createdAt: new Date().toISOString() });
    const before = governance.getRun(runId!);
    const head = () => execFileSync("git", ["-C", before.binding.repository.root, "rev-parse", "HEAD"], { encoding: "utf8" });
    const originalHead = head();
    dispatch.mockClear();
    const response = await call(`/runs/${runId}/plan/approve`, command(runId!, "approve-active", { rosterDigest: hashBytes(rosterBytes) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "plan_not_awaiting_approval" });
    expect(head()).toBe(originalHead);
    expect(governance.getRun(runId!).phase).toBe("planning");
    expect(forgetCandidate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(governance.approvePlan(command(runId!, "approve-direct", {}), { kind: "owner", sessionId: "owner" },
      before.binding, before.binding, { seats: parseLeadRoster(JSON.parse(rosterBytes)), maxSeats: 6 }).status).toBe("denied");
  });

  it("approves the plan: records it on the run's branch, rebinds the run and starts the decomposition", async () => {
    const receipt = await planningRun();
    const runId = receipt.runId!;
    const planText = "# Plan\n\n1. Add `GET /healthz` in src/health.ts.\n";
    mkdirSync(join(candidates, "task-1"), { recursive: true });
    writeFileSync(join(candidates, "task-1", "plan.md"), planText);
    writeFileSync(join(candidates, "task-1", "lead-roster.json"), rosterBytes);
    const before = governance.getRun(runId);
    const currentBinding = refreshPlanBinding(before.binding, policy);
    expect(hashBinding(currentBinding)).toBe(before.bindingDigest);
    dispatch.mockClear();
    takeOwnerMessages(db, runId!, "completed-planning-turn");
    const response = await call(`/runs/${runId}/plan/approve`, command(runId, "approve-1", { rosterDigest: hashBytes(rosterBytes) }));
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
    expect(run.binding.writePaths).toEqual(["plan.md", "lead-roster.json", "lead-escalation.json", "src"]);
    expect(governance.listApprovals(runId).filter(approval => approval.action === "implementation"
      && approval.bindingDigest === run.bindingDigest).map(approval => approval.state)).toEqual(["approved"]);
    // The lead's tree is re-adopted at the new base, and its next turn is the decomposition.
    expect(forgetCandidate).toHaveBeenCalledWith(runId, "task-1");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dispatch).toHaveBeenCalledWith(runId, "task-1");
    // Approving twice is refused rather than re-binding what the owner already approved.
    expect((await call(`/runs/${runId}/plan/approve`, command(runId, "approve-2", {}))).status).toBe(409);
  });


  it.each([undefined, ["src"]])("grants project-wide implementation only when the planning scope requests it (%j)", async writePaths => {
    const { runId: id } = await planningRun({ writePaths });
    const runId = id!;
    const planning = governance.getRun(runId);
    expect(planning.binding.readPaths).toContain(writePaths ? "src" : ".");
    expect(planning.binding.writePaths).not.toContain(".");
    expect(() => governance.stageCandidateScope(runId, "task-1", {
      root: candidates, candidateDigest: hashBytes("premature implementation"), files: ["index.html"],
      changes: [{ path: "index.html", before: null, after: Buffer.from("<main>App</main>") }],
    })).toThrow(/outside-write-paths/);

    mkdirSync(join(candidates, "task-1"), { recursive: true });
    writeFileSync(join(candidates, "task-1", "plan.md"), "# Plan\nBuild the agreed web application.\n");
    writeFileSync(join(candidates, "task-1", "lead-roster.json"), rosterBytes);
    takeOwnerMessages(db, runId, "completed-project-planning");
    const response = await call(`/runs/${runId}/plan/approve`, command(runId, "approve-project", { rosterDigest: hashBytes(rosterBytes) }));
    expect(response.status, await response.clone().text()).toBe(200);
    const approved = governance.getRun(runId);
    expect(approved.binding.limits).toEqual(planning.binding.limits);
    expect(approved.binding.repository.root).toBe(planning.binding.repository.root);
    const tasks = [
      { taskId: "backend", seat: "impl@demo", paths: ["package.json", "server"], dependencies: [], body: "Build the server." },
      { taskId: "frontend", seat: "impl@demo", paths: ["client", "index.html"], dependencies: [], body: "Build the client." },
    ];
    const admit = governance.admitLeadProposal(command(runId, "implementation-tasks", {}),
      { kind: "daemon", sessionId: "lead-manager" }, approved.binding, tasks);
    if (writePaths) {
      expect(admit).toMatchObject({ status: "denied", reason: "Assignment path is outside the binding" });
      expect(governance.findTask(runId, "backend")).toBeNull();
      expect(governance.getRun(runId).binding.writePaths).not.toContain(".");
      return;
    }
    expect(admit.status, admit.reason).toBe("accepted");
    for (const task of tasks) expect(governance.findTask(runId, task.taskId)?.assignment.paths).toEqual(task.paths);
    const stage = (path: string) => governance.stageCandidateScope(runId, "backend", {
      root: candidates, candidateDigest: hashBytes(path), files: [path],
      changes: [{ path, before: null, after: Buffer.from("fixture content") }],
    });
    expect(stage("package.json")).toBeTruthy();
    expect(stage("server/main.ts")).toBeTruthy();
    for (const path of ["server/.env.local", "server/.github/workflows/build.yml", "server/contracts/auth.ts"]) {
      expect(() => stage(path)).toThrow(/protected-path/);
    }
    expect(() => stage("client/main.ts")).toThrow(/other-task-scope/);
    const overlap = governance.admitLeadProposal(command(runId, "overlapping-task", {}),
      { kind: "daemon", sessionId: "lead-manager" }, approved.binding,
      [{ ...tasks[0]!, taskId: "overlap", paths: ["server/routes.ts"] }]);
    expect(overlap.status).toBe("denied");
    expect(governance.getRun(runId).bindingDigest).toBe(approved.bindingDigest);
  });

  it("applies the exact allowed models from the approved planning roster to existing idle seats", async () => {
    db.prepare("UPDATE rigs SET team_model_allowlist = ? WHERE id = 'rig'").run(JSON.stringify([
      { client: "claude-code", model: "approved-worker" },
    ]));
    const { runId } = await planningRun();
    mkdirSync(join(candidates, "task-1"), { recursive: true });
    writeFileSync(join(candidates, "task-1", "plan.md"), "# Plan\n\nAdd a health endpoint.\n");
    const roster = JSON.stringify({ seats: [
      { role: "implementer", client: "claude-code", model: "approved-worker" },
      { role: "reviewer", client: "claude-code", model: "approved-worker" },
    ] });
    writeFileSync(join(candidates, "task-1", "lead-roster.json"), roster);
    takeOwnerMessages(db, runId!, "completed-planning-turn");
    const response = await call(`/runs/${runId}/plan/approve`, command(runId!, "approve-models", { rosterDigest: hashBytes(roster) }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(db.prepare("SELECT model FROM nodes WHERE role <> 'lead' ORDER BY id").all())
      .toEqual([{ model: "approved-worker" }, { model: "approved-worker" }]);
    expect(governance.getRun(runId!).phase).toBe("delivery");
  });

  it.each([null, {}, { ownerMessage: "Confirm plan" }, { responseLanguage: "zh-CN" }])("approves a persisted pre-roster planning run without retrofitting its binding or requiring a roster (payload: %s)", async payload => {
    const runId = "legacy-pre-roster";
    const root = ensurePlanWorktree({ repositoryRoot: directory, worktreeRoot: worktrees, runId, name: "Legacy plan" }).path;
    commitPlan({ worktree: root, planRef: "plan.md", plan: "# Legacy bootstrap", message: "Legacy planning fixture" });
    const binding = { ...bindingForGoal({ root, planRef: "plan.md", writePaths: ["plan.md"], policy }),
      readPaths: ["plan.md", "src"] };
    const owner = { kind: "owner", sessionId: "owner-control" } as const;
    const digest = hashBinding(binding);
    governance.createRun({ id: runId, rigId: "rig", binding, phase: "planning", reviewerSeat: "review@demo" });
    governance.requestApproval(command(runId, "legacy-approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: digest }, targetDigest: digest, expiresAt: "2099-01-01T00:00:00.000Z" }), owner);
    expect(governance.decideApproval(command(runId, "legacy-approval", { approvalVersion: 1, decision: "approved" }), owner, binding).status)
      .toBe("accepted");
    expect(governance.createTask(command(runId, "task-1", {
      assignment: { taskId: "task-1", role: "lead", paths: ["plan.md"], dependencies: [] },
      outputs: [], permissions: ["request-assignment"], sourceSession: "owner-control", destinationSession: "lead@demo",
      body: "Continue the persisted planning conversation",
    }), binding).status).toBe("accepted");
    mkdirSync(join(candidates, "task-1"), { recursive: true });
    writeFileSync(join(candidates, "task-1", "plan.md"), "# The persisted run's agreed plan");
    expect(governance.getRun(runId).binding.writePaths).toEqual(["plan.md"]);
    const response = await call(`/runs/${runId}/plan/approve`, command(runId, "approve-legacy", payload));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(governance.getRun(runId)).toMatchObject({ phase: "delivery", reviewerSeat: "review@demo",
      binding: { writePaths: ["plan.md", "src"] } });
    if (payload && "responseLanguage" in payload) {
      expect(db.prepare("SELECT response_language AS language FROM team_runs WHERE id = ?").get(runId))
        .toEqual({ language: "zh-CN" });
      expect(governance.chatMessages(runId)).toEqual([]);
    }
    if (payload && "ownerMessage" in payload) expect(governance.chatMessages(runId)).toEqual([
      expect.objectContaining({ kind: "confirmation", body: payload.ownerMessage }),
    ]);
  });

  it("refuses a lead write outside the plan during planning", async () => {
    const receipt = await planningRun();
    const run = governance.getRun(receipt.runId!);
    const stage = () => governance.stageCandidateScope(receipt.runId!, "task-1", { root: candidates,
      candidateDigest: "sha256:" + "1".repeat(64), files: ["src/base.ts"],
      changes: [{ path: "src/base.ts", before: Buffer.from("export const base = 1;\n"), after: Buffer.from("export const base = 2;\n") }] });
    expect(stage).toThrow(ScopeExtensionError);
    expect(stage).toThrow(/outside-write-paths/);
    // The plan itself remains one of the permitted planning files.
    expect(governance.stageCandidateScope(receipt.runId!, "task-1", { root: candidates,
      candidateDigest: "sha256:" + "2".repeat(64), files: ["plan.md"],
      changes: [{ path: "plan.md", before: null, after: Buffer.from("# Plan\n") }] })).toBeTruthy();
    expect(run.binding.writePaths).toEqual(["plan.md", "lead-roster.json", "lead-escalation.json"]);
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
      .toEqual(["Add a health endpoint", "First question."]);
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
    expect(reopened.chatMessages(receipt.runId!).map(message => message.body)).toEqual(["Add a health endpoint", "First question.", "Second question."]);
  });

  it("refuses the chat to a caller that is not the owner", async () => {
    const receipt = await planningRun();
    const response = await call(`/runs/${receipt.runId}/chat`, command(receipt.runId!, "chat-1", { body: "hi" }), workerToken);
    expect(response.status).toBe(403);
    expect(listChatMessages(db, receipt.runId!).map(message => message.body)).toEqual(["Add a health endpoint"]);
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
