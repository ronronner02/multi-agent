import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { appendChatMessage } from "../src/domain/lead-chat.js";
import { ensurePlanWorktree } from "../src/domain/plan-branch.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import type { PlanBinding } from "../src/contracts/team-control.js";

// MVP — a fresh install starts the agent a start request puts work on.
//
// The seat is created exactly as `demo/team/scripts/start-team-demo.ts` creates it: a rig, a
// node and a session row, and nothing else. No tmux session exists and no binding records a
// pane, so this is the state a friend following the README is in. The start request is the
// real owner endpoint, the dispatch is the one startup composes, and the launch is the real
// direct launcher in a real tmux server with the compiled stub runner in place of the native
// client. Nothing is written by hand between the start and the launch.

const ownerToken = "owner-fixture";
const SEAT = "dev-impl@team-demo";
const STUB_RUNNER = new URL("../dist/adapters/stub-runner.js", import.meta.url).pathname;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(parent: string): string {
  const root = realpathSync(mkdtempSync(join(parent, "repo-")));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/**
 * Where the daemon writes an attempt's turn text.
 *
 * It lives in the unisolated worker's mutable state, which sits beside the candidate root:
 * `.../state/workers/assignments/local/<run>-<task>` and `.../state/workers/homes/local/scratch`.
 * The candidate the launch actually used is the anchor, so this reads the daemon's own layout
 * rather than rebuilding a home the test guessed.
 */
function turnPromptDir(candidate: string): string {
  return join(dirname(dirname(dirname(candidate))), "homes", "local", "scratch", "turns");
}

/** A projection is sealed read-only, so every directory is opened before removal. */
function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

describe("a start request launches the seat it put work on", () => {
  let directory: string, repo: string, db: Database.Database, savedEnv: Record<string, string | undefined>;
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  let nodeId: string;
  let binding: PlanBinding;

  /** A tmux server of this test's own, so nothing touches the operator's sessions. */
  const tmuxRun = (...args: string[]): string =>
    execFileSync("tmux", args, { encoding: "utf8", env: { ...process.env, TMUX_TMPDIR: join(directory, "tmux") } });

  const start = (body: unknown) => daemon.app.fetch(new Request("http://127.0.0.1/api/team-control/runs", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + ownerToken },
    body: JSON.stringify(body),
  }), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  const receipts = () => db.prepare(
    "SELECT payload FROM events WHERE type = 'managed.attempt.receipt' ORDER BY seq DESC").all() as Array<{ payload: string }>;

  beforeEach(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "seat-pane-")));
    mkdirSync(join(directory, "tmux"), { recursive: true });
    savedEnv = { OPENRIG_HOME: process.env.OPENRIG_HOME, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
    process.env.OPENRIG_HOME = join(directory, "home");
    process.env.TMUX_TMPDIR = join(directory, "tmux");
    repo = repository(directory);
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"),
      repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 4, policyFingerprint: hashBytes("workers.isolation:none"),
      limits: { maxSessions: 1, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 1 },
    };
    daemon = await createDaemon({ dbPath: join(directory, "seat-pane.db"), managedMode: true,
      teamControl: { credentials: { ownerToken }, resolveBinding: () => structuredClone(binding),
        readPolicyCapability: () => ({ policyRevision: 4, policyFingerprint: binding.policyFingerprint,
          verifiedProviders: ["claude", "codex"] }) },
      cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
      directLaunchCommand: facts => [process.execPath, STUB_RUNNER,
        "--session-name", facts.taskId, "--cwd", facts.tree, "--launch-id", facts.attemptId, "--posture", "floor", "--turn"] });
    db = daemon.db;
    // The demo seed's rows and nothing else: a rig, one implementer node, one registered seat.
    const rig = daemon.deps.rigRepo.createRig("team-demo", repo);
    nodeId = daemon.deps.rigRepo.addNode(rig.id, "dev.impl", { role: "implementer", runtime: "claude-code", cwd: repo }).id;
    daemon.deps.sessionRegistry.registerSession(nodeId, SEAT);
    // Startup composes the dispatch for an unisolated managed daemon, so the start request below
    // reaches a real launch without this test wiring one.
    expect(daemon.deps.teamControl!.dispatch).toBeTypeOf("function");
  });

  afterEach(async () => {
    try { tmuxRun("kill-server"); } catch { /* already gone */ }
    await daemon?.deps.workflowRuntime?.closeManagedAttempts();
    if (db?.open) db.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (existsSync(directory)) { writable(directory); rmSync(directory, { recursive: true, force: true }); }
  });

  /** Every session on this test's own server; none at all while the server does not exist. */
  const sessions = (): string[] => {
    try { return tmuxRun("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean); }
    catch { return []; }
  };

  it("opens the seat's terminal, launches the runner into it and records the launch receipt", async () => {
    // The seat has no terminal before the start: no tmux session, no recorded pane.
    expect(sessions()).toEqual([]);
    expect(daemon.deps.sessionRegistry.getBindingForNode(nodeId)).toBeNull();

    const response = await start({ goal: "Say hello from the demo team" });
    expect(response.status).toBe(201);
    const receipt = await response.json() as { runId: string; rigId: string; seat: string; taskId: string };
    // The seat the task routes to is the one the seed registered, not an address derived from
    // the node's logical id.
    expect(receipt.seat).toBe(SEAT);

    // The dispatch runs after the response is built, so the launch is awaited here rather than
    // inside the request. The receipt is recorded before readiness, so the seat being ready is
    // what says the launch finished.
    await vi.waitFor(() => expect(receipts()).toHaveLength(1), { timeout: 60_000 });
    const ready = () => db.prepare("SELECT 1 FROM events WHERE type = 'node.startup_ready'").get();
    await vi.waitFor(() => expect(ready()).toBeDefined(), { timeout: 60_000 });

    // Empty startup actions must still deliver the queued-work instruction. A managed Claude
    // attempt is one headless turn, so its prompt is written before the launch and fed on
    // stdin, and the turn ends by itself — which is why the pane is already dead here. The
    // prompt is asserted where the daemon wrote it, and the pane keeps the turn's own exit.
    const launchEvent = JSON.parse(receipts()[0]!.payload) as { runId: string;
      receipt: { attemptId: string; identity: { paneId: string; processId: number }; workerUid: number } };
    // The turn ends by itself, and the held pane keeps its own exit status — the evidence the
    // completion sweep classifies. The launch returns once the turn has started, so the end is
    // waited for rather than assumed to have already happened.
    await vi.waitFor(() => expect(tmuxRun("display-message", "-p", "-t", launchEvent.receipt.identity.paneId,
      "#{pane_dead}|#{pane_dead_status}").trim()).toBe("1|0"), { timeout: 30_000 });
    // The turn's own text is the file the launcher fed it, and it carries the same facts the
    // interactive prompt did: the task, its body, the assignment and the instruction files.
    const prompt = readFileSync(join(turnPromptDir(
      daemon.deps.workflowRuntime!.assignedTreeFor(receipt.runId, { taskId: receipt.taskId })),
      `${launchEvent.receipt.attemptId}.prompt`), "utf8");
    expect(prompt).toContain(`Managed task ${receipt.taskId} for run ${receipt.runId}`);
    expect(prompt).toContain("Say hello from the demo team");
    expect(prompt).toContain('"paths":["src"]');
    // KTD28 keeps the core and the charter out of the brief, so the projection is the only
    // place they exist and the prompt is the only place the client can be told where it is.
    // An implementer attempt names exactly those two, at the path an unisolated client opens.
    expect(prompt).toContain("Read these files before you start work");
    expect(prompt).toMatch(/^- \/.*\/state\/workers\/context\/local\/[^/]+\/[^/]+\/core$/m);
    expect(prompt).toMatch(/^- \/.*\/state\/workers\/context\/local\/[^/]+\/[^/]+\/charter$/m);
    // The mount path only exists inside a sandbox; naming it to an unisolated client would
    // point at a directory that is not there.
    expect(prompt).not.toMatch(/^- \/context\//m);
    expect(prompt).not.toContain("rig whoami");
    expect(prompt).not.toContain("rig queue list");
    expect(prompt).not.toContain(ownerToken);
    expect(prompt).not.toContain("Team progress snapshot:");

    // The daemon created the terminal itself, and recorded the pane the way every binding is.
    // The pane is read by id: a turn that has ended leaves no current path to report, and the
    // candidate it worked in is asserted below from the tree the launch actually used.
    const paneId = tmuxRun("list-panes", "-t", `=${SEAT}:`, "-F", "#{pane_id}").trim();
    expect(paneId).toMatch(/^%[0-9]+$/);
    expect(daemon.deps.sessionRegistry.getBindingForNode(nodeId)).toMatchObject({
      attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: paneId });

    // The launch receipt is run evidence for this run, and names the identity the pane runs under.
    expect(launchEvent.runId).toBe(receipt.runId);
    expect(launchEvent.receipt.identity.paneId).toBe(paneId);
    expect(launchEvent.receipt.workerUid).toBe(process.getuid!());
    expect(launchEvent.receipt.identity.processId).toBeGreaterThan(0);

    // The stub runner is what came up in that pane, and the seat is ready. The candidate is a
    // real git worktree under the unisolated roots, and the sidecar is the runner's own write.
    const tree = daemon.deps.workflowRuntime!.assignedTreeFor(receipt.runId, { taskId: receipt.taskId });
    expect(JSON.parse(String(readFileSync(join(tree, ".openrig", "stub", "state.json"))))).toMatchObject({ ready: true });
    expect(git(tree, "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
    expect(statSync(tree).uid).toBe(process.getuid!());
    const session = daemon.deps.sessionRegistry.findResumeContextByName(SEAT)!;
    expect(daemon.deps.sessionRegistry.getSessionsForRig(receipt.rigId)
      .find(row => row.id === session.sessionId)!.startupStatus).toBe("ready");
  }, 90_000);

  it("recreates a removed bound seat while another session keeps its server alive", async () => {
    const { ensureSeatPane } = await import("../src/domain/seat-pane.js");
    const dependencies = { rigRepo: daemon.deps.rigRepo, sessions: daemon.deps.sessionRegistry,
      tmux: daemon.deps.tmuxAdapter, sessionEnv: {} };
    const stalePane = await ensureSeatPane(dependencies, SEAT);
    const neighbor = `${SEAT}-neighbor`;
    tmuxRun("new-session", "-d", "-s", neighbor, "-c", repo);
    const neighborPane = tmuxRun("list-panes", "-t", `=${neighbor}:`, "-F", "#{pane_id}").trim();
    tmuxRun("kill-session", "-t", `=${SEAT}:`);
    expect(sessions()).toEqual([neighbor]);
    expect(daemon.deps.sessionRegistry.getBindingForNode(nodeId)!.tmuxPane).toBe(stalePane);

    const pane = await ensureSeatPane(dependencies, SEAT);

    expect(pane).not.toBe(stalePane);
    expect(pane).not.toBe(neighborPane);
    expect(sessions().sort()).toEqual([SEAT, neighbor].sort());
    expect(tmuxRun("list-panes", "-t", `=${neighbor}:`, "-F", "#{pane_id}").trim()).toBe(neighborPane);
    expect(daemon.deps.sessionRegistry.getBindingForNode(nodeId)).toMatchObject({
      attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: pane });
  });

  it("preserves a bound seat when its presence probe fails", async () => {
    const { ensureSeatPane } = await import("../src/domain/seat-pane.js");
    const dependencies = { rigRepo: daemon.deps.rigRepo, sessions: daemon.deps.sessionRegistry,
      tmux: daemon.deps.tmuxAdapter, sessionEnv: {} };
    const pane = await ensureSeatPane(dependencies, SEAT);
    const failure = new Error("fixture permission denied");
    const probe = vi.spyOn(daemon.deps.tmuxAdapter, "hasSession").mockRejectedValue(failure);
    const create = vi.spyOn(daemon.deps.tmuxAdapter, "createSession");
    try {
      await expect(ensureSeatPane(dependencies, SEAT)).rejects.toBe(failure);
      expect(create).not.toHaveBeenCalled();
      expect(daemon.deps.sessionRegistry.getBindingForNode(nodeId)!.tmuxPane).toBe(pane);
      expect(sessions()).toEqual([SEAT]);
    } finally {
      probe.mockRestore();
      create.mockRestore();
    }
  });

  it("writes durable review progress into the lead's actual launch prompt while a worker is busy", async () => {
    const governance = daemon.deps.teamGovernance!;
    const rigId = daemon.deps.sessionRegistry.findResumeContextByName(SEAT)!.rigId;
    const leadSeat = "lead@team-demo", reviewSeat = "review@team-demo";
    for (const [logicalId, role, runtime, seat] of [
      ["lead", "lead", "claude-code", leadSeat], ["review", "reviewer", "codex", reviewSeat],
    ] as const) {
      const node = daemon.deps.rigRepo.addNode(rigId, logicalId, { role, runtime, cwd: repo });
      daemon.deps.sessionRegistry.registerSession(node.id, seat);
    }
    const runId = "lead-progress-run";
    const sourceRoot = ensurePlanWorktree({ repositoryRoot: repo, worktreeRoot: join(directory, "plan-worktrees"),
      runId, name: "Progress" }).path;
    binding = { ...binding, repository: { root: sourceRoot, identity: "git:" + git(sourceRoot, "rev-parse", "HEAD").trim() } };
    governance.createRun({ id: runId, rigId, binding, reviewerSeat: reviewSeat });
    let serial = 0;
    const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId, actionId,
      expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: `${actionId}-${++serial}`, payload });
    governance.requestApproval(command("approve", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), { kind: "owner", sessionId: "owner" });
    expect(governance.decideApproval(command("approve", { approvalVersion: 1, decision: "approved" }),
      { kind: "owner", sessionId: "owner" }, binding).status).toBe("accepted");
    for (const [taskId, role, seat] of [
      ["lead-task", "lead", leadSeat], ["impl-task", "implementer", SEAT], ["review-task", "reviewer", reviewSeat],
    ] as const) {
      const admitted = governance.createTask(command(taskId, {
        assignment: { taskId, role, paths: ["src"], dependencies: [], ...(role === "reviewer" ? { reviewOf: "impl-task" } : {}) },
        outputs: [], permissions: role === "lead" ? ["request-assignment"] : role === "reviewer" ? ["submit-review"] : ["write-assigned-tree"],
        sourceSession: "owner", destinationSession: seat, body: "Report the recorded task and review progress.",
      }), binding);
      expect(admitted.status, JSON.stringify(admitted)).toBe("accepted");
    }
    const impl = governance.findTask(runId, "impl-task")!, review = governance.findTask(runId, "review-task")!;
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(impl.qitemId);
    db.prepare("UPDATE queue_items SET state = 'in-progress' WHERE qitem_id = ?").run(review.qitemId);
    expect(governance.recordAttempt(command("review-running", { qitemId: review.qitemId, role: "reviewer", provider: "codex",
      identity: { nativeSessionId: "native-review", tmuxServer: "/tmp/fixture-review.sock", paneId: "%1",
        processId: 4242, processStart: "fixture-review-start", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage: { activeMs: 0, inputTokens: { value: null, reason: "unobserved" },
        outputTokens: { value: null, reason: "unobserved" }, costUsd: { value: null, reason: "unobserved" } },
    }), binding).status).toBe("observed");
    appendChatMessage(db, { id: "progress-question", runId, sender: "owner", body: "Which work is done, and has review started?",
      createdAt: new Date().toISOString() });

    await daemon.deps.teamControl!.dispatch!(runId, "lead-task");
    expect(receipts()).toHaveLength(1);
    const launch = JSON.parse(receipts()[0]!.payload) as { receipt: { attemptId: string } };
    const prompt = readFileSync(join(turnPromptDir(daemon.deps.workflowRuntime!.assignedTreeFor(runId, { taskId: "lead-task" })),
      launch.receipt.attemptId + ".prompt"), "utf8");
    expect(prompt).toContain("Team progress snapshot:");
    const progress = JSON.parse(prompt.match(/Team progress snapshot:\n([^\n]+)/)![1]!);
    expect(progress).toMatchObject({ runId, totalTasks: 2, truncated: false, tasks: [
      { taskId: "impl-task", role: "implementer", queueState: "done", client: "claude-code", latestAttempt: null },
      { taskId: "review-task", role: "reviewer", queueState: "in-progress", client: "codex", reviewOf: "impl-task",
        latestAttempt: { id: "review-running", state: "running", provider: "codex" } },
    ] });
    expect(Number.isFinite(Date.parse(progress.observedAt))).toBe(true);
    expect(prompt).toContain("This snapshot is not a live query");
    expect(prompt).not.toContain(ownerToken);
    expect(db.prepare("SELECT delivered_attempt AS attempt FROM team_chat_messages WHERE id = 'progress-question'").get())
      .toEqual({ attempt: launch.receipt.attemptId });
  }, 90_000);

  const continueTask = (runId: string, taskId: string, version: number, token = ownerToken) =>
    daemon.app.fetch(new Request(`http://127.0.0.1/api/team-control/runs/${runId}/tasks/${taskId}/continue`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ protocolVersion: "1.0", expectedEntityVersion: version }),
    }), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  /**
   * A managed Claude attempt is one headless turn, and that changes what a continuation is.
   *
   * Measured on the installed 2.1.296 build: `-p` skips the workspace-trust dialog, so the gate
   * this route exists to clear cannot appear, and the prompt is read from stdin before the
   * client starts rather than typed into a composer. The route therefore refuses a managed
   * attempt by name instead of pretending to deliver a prompt nothing is waiting for, and the
   * owner's answer is a new attempt on the same candidate tree.
   */
  it("refuses to continue a managed attempt, because a headless turn has no staged prompt", async () => {
    const run = await (await start({ goal: "Write a hello-world file in src" })).json() as { runId: string; taskId: string };
    await vi.waitFor(() => expect(receipts()).toHaveLength(1), { timeout: 60_000 });
    const version = daemon.deps.teamGovernance!.getRun(run.runId).entityVersion;
    daemon.deps.teamControl!.credentials.workers = [{ token: "worker-fixture", sessionId: SEAT, runId: run.runId }];
    // The route stays owner-only and keeps its authority checks.
    expect((await continueTask(run.runId, run.taskId, version, "")).status).toBe(401);
    expect((await continueTask(run.runId, run.taskId, version, "worker-fixture")).status).toBe(403);
    expect((await continueTask(run.runId, "wrong-task", version)).status).toBe(404);
    expect((await continueTask(run.runId, run.taskId, version - 1)).status).toBe(409);
    expect((await continueTask(run.runId, run.taskId, 0)).status).toBe(400);
    // A managed attempt is not continuable: nothing was left staged, so nothing can be delivered.
    const refused = await continueTask(run.runId, run.taskId, version);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "continuation_unavailable" });
    expect(receipts()).toHaveLength(1);
    // The seat's own work is unaffected: the attempt ran as a turn and the candidate is there.
    const receipt = JSON.parse(receipts()[0]!.payload) as { receipt: { attemptId: string } };
    const tree = daemon.deps.workflowRuntime!.assignedTreeFor(run.runId, { taskId: run.taskId });
    expect(git(tree, "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
    const prompt = readFileSync(join(turnPromptDir(tree), `${receipt.receipt.attemptId}.prompt`), "utf8");
    expect(prompt).toContain("Write a hello-world file in src");
  }, 90_000);


  it("launches once for a seat, so a second start does not open a second client", async () => {
    expect((await start({ goal: "First goal" })).status).toBe(201);
    await vi.waitFor(() => expect(receipts()).toHaveLength(1), { timeout: 60_000 });
    expect((await start({ goal: "Second goal" })).status).toBe(201);
    // Give the second dispatch the same window the first had to do its work.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(receipts()).toHaveLength(1);
    expect(sessions()).toEqual([SEAT]);
  }, 90_000);

  it("gives a reused pane id to the seat that just created it, so the next launch resolves one seat", async () => {
    // A pane id is unique only within one tmux server's lifetime. A server whose last client
    // exits is gone, and the next server numbers its panes from `%0` again — so a dead seat's
    // binding names the new seat's pane. Two seats resolving to one pane makes the delivery
    // guard's target lookup ambiguous, and the launch that opened the pane is refused. The seat
    // that created the pane is the one it belongs to, so it takes it.
    const first = await (await start({ goal: "First seat's work" })).json() as { runId: string; taskId: string };
    await vi.waitFor(() => expect(receipts()).toHaveLength(1), { timeout: 60_000 });
    const firstPane = daemon.deps.sessionRegistry.getBindingForNode(nodeId)!.tmuxPane;
    expect(firstPane).toMatch(/^%[0-9]+$/);
    // A second seat on the same server, in its own session.
    const rigId = daemon.deps.sessionRegistry.findResumeContextByName(SEAT)!.rigId;
    const second = daemon.deps.rigRepo.addNode(rigId, "dev.reviewer", { role: "reviewer", runtime: "claude-code", cwd: repo });
    daemon.deps.sessionRegistry.registerSession(second.id, "dev-reviewer@team-demo");
    // The first seat's terminal is gone, exactly as it is when its client exits, and its
    // binding is left naming the pane that no longer exists — which is the state a later launch
    // has to cope with, not one it may assume away.
    tmuxRun("kill-session", "-t", `=${SEAT}:`);
    // The second seat's launch is what opens a fresh terminal, and it reuses the first pane id.
    const { ensureSeatPane } = await import("../src/domain/seat-pane.js");
    const pane = await ensureSeatPane({ rigRepo: daemon.deps.rigRepo, sessions: daemon.deps.sessionRegistry,
      tmux: daemon.deps.tmuxAdapter, sessionEnv: {} }, "dev-reviewer@team-demo");
    expect(pane).toBe(firstPane);
    // One pane, one seat: the binding that names it is the seat that created it, so the delivery
    // guard's target lookup resolves one node instead of refusing an ambiguous pair.
    expect(daemon.db.prepare("SELECT node_id FROM bindings WHERE tmux_pane = ?").all(pane)).toEqual([{ node_id: second.id }]);
    void first;
  }, 90_000);
});

describe("workers.isolation: hardened", () => {
  // The hardened path is unchanged, so it composes no dispatcher: an agent there starts through
  // the privileged launcher under a policy this daemon does not own. That needs the installed
  // policy to boot, which is a host-provisioning fact rather than a repository one, so this
  // skips where it is absent instead of reporting a code defect.
  const provisioned = existsSync("/etc/multi-agent/worker-policy.json");

  it.skipIf(!provisioned)("refuses an unbound seat instead of opening a terminal for it", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "seat-pane-hardened-")));
    const repo = repository(directory);
    const binding: PlanBinding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"),
      repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 5, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    const hardened = await createDaemon({ dbPath: join(directory, "hardened.db"), managedMode: true,
      workersIsolation: "hardened",
      teamControl: { credentials: { ownerToken }, resolveBinding: () => structuredClone(binding),
        readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: binding.policyFingerprint,
          verifiedProviders: ["claude", "codex"] }) },
      tmuxExec: async () => "", cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
    try {
      // No dispatcher is composed, and the launcher it does build refuses a seat with no pane.
      expect(hardened.deps.teamControl!.dispatch).toBeUndefined();
      expect(() => hardened.deps.managedLaunch!.launcher).not.toThrow();
      const { resolveManagedWorkerSeat } = await import("../src/adapters/worker-launch-control.js");
      expect(() => resolveManagedWorkerSeat({ runId: "run", binding, assignment: { taskId: "task", role: "implementer",
        paths: ["src"], dependencies: [] }, role: "implementer", client: "claude-code" },
      { db: hardened.db, governance: hardened.deps.teamGovernance!, queue: hardened.deps.queueRepo!,
        options: hardened.deps.teamControl!, rigRepo: hardened.deps.rigRepo, sessions: hardened.deps.sessionRegistry }))
        .toThrow("managed_launch_seat_unverified");
    } finally {
      hardened.db.close();
      writable(directory);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
