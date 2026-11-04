import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { hashBytes } from "../src/domain/plan-governance.js";
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
    const binding: PlanBinding = {
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
        "--session-name", facts.taskId, "--cwd", facts.tree, "--launch-id", facts.attemptId, "--posture", "floor"] });
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

    // Empty startup actions must still deliver the queued-work instruction through real tmux.
    const terminal = tmuxRun("capture-pane", "-p", "-J", "-S", "-100", "-t", `=${SEAT}:`);
    expect(terminal).toContain(`Managed task ${receipt.taskId} for run ${receipt.runId}`);
    expect(terminal).toContain("Say hello from the demo team");
    expect(terminal).toContain('"paths":["src"]');
    expect(terminal).not.toContain("rig whoami");
    expect(terminal).not.toContain("rig queue list");
    expect(terminal).not.toContain(ownerToken);
    // KTD28 keeps the core and the charter out of the brief, so the projection is the only
    // place they exist and the prompt is the only place the client can be told where it is.
    // An implementer attempt names exactly those two, at the path an unisolated client opens.
    expect(terminal).toContain("Read these files before you start work");
    expect(terminal).toMatch(/^- \/.*\/state\/workers\/context\/local\/[^/]+\/[^/]+\/core$/m);
    expect(terminal).toMatch(/^- \/.*\/state\/workers\/context\/local\/[^/]+\/[^/]+\/charter$/m);
    // The mount path only exists inside a sandbox; naming it to an unisolated client would
    // point at a directory that is not there.
    expect(terminal).not.toMatch(/^- \/context\//m);

    // The daemon created the terminal itself, and recorded the pane the way every binding is.
    const pane = tmuxRun("list-panes", "-t", `=${SEAT}:`, "-F", "#{pane_id} #{pane_current_path}").trim();
    const [paneId, paneCwd] = pane.split(" ");
    expect(paneId).toMatch(/^%[0-9]+$/);
    // The launch moved the pane into the task's candidate, which is where the runner works.
    expect(paneCwd).toContain(join("state", "workers", "assignments", "local"));
    expect(daemon.deps.sessionRegistry.getBindingForNode(nodeId)).toMatchObject({
      attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: paneId });

    // The launch receipt is run evidence for this run, and names the identity the pane runs under.
    const event = JSON.parse(receipts()[0]!.payload) as { runId: string;
      receipt: { attemptId: string; identity: { paneId: string; processId: number }; workerUid: number } };
    expect(event.runId).toBe(receipt.runId);
    expect(event.receipt.identity.paneId).toBe(paneId);
    expect(event.receipt.workerUid).toBe(process.getuid!());
    expect(event.receipt.identity.processId).toBeGreaterThan(0);

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

  const continueTask = (runId: string, taskId: string, version: number, token = ownerToken) =>
    daemon.app.fetch(new Request(`http://127.0.0.1/api/team-control/runs/${runId}/tasks/${taskId}/continue`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ protocolVersion: "1.0", expectedEntityVersion: version }),
    }), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  it("continues the same managed attempt after trust without opening legacy or worker owner access", async () => {
    const adapter = daemon.deps.runtimeAdapters!["claude-code"]!;
    const readiness = vi.spyOn(adapter, "checkReady").mockResolvedValueOnce({ ready: false, code: "trust_gate" });
    const response = await start({ goal: "Write a hello-world file in src" });
    const run = await response.json() as { runId: string; taskId: string };
    const context = daemon.deps.sessionRegistry.findResumeContextByName(SEAT)!;
    await vi.waitFor(() => expect(daemon.deps.startupOrchestrator!.canContinueFresh(nodeId, context.sessionId)).toBe(true), { timeout: 60_000 });
    const original = JSON.parse(receipts()[0]!.payload).receipt;
    const version = daemon.deps.teamGovernance!.getRun(run.runId).entityVersion;
    daemon.deps.teamControl!.credentials.workers = [{ token: "worker-fixture", sessionId: SEAT, runId: run.runId }];
    expect((await continueTask(run.runId, run.taskId, version, "")).status).toBe(401);
    expect((await continueTask(run.runId, run.taskId, version, "worker-fixture")).status).toBe(403);
    expect((await continueTask(run.runId, "wrong-task", version)).status).toBe(404);
    expect((await continueTask(run.runId, run.taskId, version - 1)).status).toBe(409);
    expect((await continueTask(run.runId, run.taskId, 0)).status).toBe(400);
    const continued = await Promise.all([continueTask(run.runId, run.taskId, version), continueTask(run.runId, run.taskId, version)]);
    expect(continued.map(response => response.status).sort()).toEqual([200, 409]);
    const result = continued.find(response => response.status === 200)!;
    expect(await result.json()).toMatchObject({ ok: true, seat: SEAT, startupStatus: "ready" });
    expect(result.status).toBe(200);
    expect(receipts()).toHaveLength(1);
    expect(readiness.mock.calls.slice(1).every(([binding]) => binding.managedAttempt?.attemptId === original.attemptId)).toBe(true);
    expect(Number(tmuxRun("display-message", "-p", "-t", original.identity.paneId, "#{pane_pid}").trim())).toBe(original.identity.processId);
    const terminal = tmuxRun("capture-pane", "-p", "-J", "-S", "-200", "-t", `=${SEAT}:`);
    expect(terminal).toContain("Write a hello-world file in src");
    expect(terminal).not.toContain("rig whoami");
    expect(terminal).not.toContain("rig queue list");
    expect((await continueTask(run.runId, run.taskId, version)).status).toBe(409);
    for (const path of ["/api/seat/continue/" + encodeURIComponent(SEAT), "/api/whoami", "/api/queue/list"]) {
      const legacy = await daemon.app.fetch(new Request("http://127.0.0.1" + path, {
        method: path.includes("continue") ? "POST" : "GET", headers: { Authorization: "Bearer " + ownerToken },
      }), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
      expect(legacy.status).toBe(403);
      expect(await legacy.json()).toMatchObject({ code: "managed_control_required" });
    }
  }, 90_000);

  it("rechecks run authority after asynchronous readiness before delivering continued work", async () => {
    const adapter = daemon.deps.runtimeAdapters!["claude-code"]!;
    const readiness = vi.spyOn(adapter, "checkReady").mockResolvedValueOnce({ ready: false, code: "trust_gate" });
    const run = await (await start({ goal: "Do not deliver after cancellation" })).json() as { runId: string; taskId: string };
    const context = daemon.deps.sessionRegistry.findResumeContextByName(SEAT)!;
    await vi.waitFor(() => expect(daemon.deps.startupOrchestrator!.canContinueFresh(nodeId, context.sessionId)).toBe(true), { timeout: 60_000 });
    let release!: () => void;
    readiness.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ready: true }); }));
    const governance = daemon.deps.teamGovernance!;
    const version = governance.getRun(run.runId).entityVersion;
    const continuation = continueTask(run.runId, run.taskId, version);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    governance.cancelRun({ protocolVersion: "1.0", runId: run.runId, actionId: "cancel",
      expectedEntityVersion: version, idempotencyKey: "cancel-during-readiness", payload: { reason: "Cancel before context delivery" } }, { kind: "owner", sessionId: "owner-control" });
    release();
    expect((await continuation).status).toBe(409);
    expect(tmuxRun("capture-pane", "-p", "-J", "-S", "-200", "-t", `=${SEAT}:`)).not.toContain("Do not deliver after cancellation");
    expect(receipts()).toHaveLength(1);
  }, 90_000);

  it.each(["paste", "Enter"])("rechecks managed continuation at the final %s boundary", async boundary => {
    const adapter = daemon.deps.runtimeAdapters!["claude-code"]!;
    vi.spyOn(adapter, "checkReady").mockResolvedValueOnce({ ready: false, code: "trust_gate" });
    const goal = "Do not submit after write-boundary cancellation";
    const run = await (await start({ goal })).json() as { runId: string; taskId: string };
    const context = daemon.deps.sessionRegistry.findResumeContextByName(SEAT)!;
    await vi.waitFor(() => expect(daemon.deps.startupOrchestrator!.canContinueFresh(nodeId, context.sessionId)).toBe(true), { timeout: 60_000 });
    const governance = daemon.deps.teamGovernance!;
    const version = governance.getRun(run.runId).entityVersion;
    let rejected: unknown;
    const beforeWrite = (beforeInput?: () => void) => () => {
      governance.cancelRun({ protocolVersion: "1.0", runId: run.runId, actionId: "cancel",
        expectedEntityVersion: version, idempotencyKey: "cancel-at-write", payload: { reason: "Cancel at the terminal write boundary" } }, { kind: "owner", sessionId: "owner-control" });
      try { beforeInput?.(); } catch (error) { rejected = error; throw error; }
    };
    const tmux = daemon.deps.tmuxAdapter;
    if (boundary === "paste") {
      const sendText = tmux.sendText.bind(tmux);
      vi.spyOn(tmux, "sendText").mockImplementationOnce((target, text, beforeInput, options) =>
        sendText(target, text, beforeWrite(beforeInput), options));
    } else {
      const sendKeys = tmux.sendKeys.bind(tmux);
      vi.spyOn(tmux, "sendKeys").mockImplementationOnce((target, keys, beforeInput) =>
        sendKeys(target, keys, beforeWrite(beforeInput)));
    }
    const response = await continueTask(run.runId, run.taskId, version);
    expect(rejected).toBeInstanceOf(Error);
    expect(response.status).toBe(409);
    expect(receipts()).toHaveLength(1);
    if (boundary === "paste") expect(tmuxRun("capture-pane", "-p", "-J", "-S", "-200", "-t", `=${SEAT}:`)).not.toContain(goal);
  }, 90_000);

  it("keeps persisted pending startup unavailable after its in-memory owner is replaced", async () => {
    const adapter = daemon.deps.runtimeAdapters!["claude-code"]!;
    vi.spyOn(adapter, "checkReady").mockResolvedValueOnce({ ready: false, code: "trust_gate" });
    const goal = "Do not reconstruct the previous managed attempt";
    const run = await (await start({ goal })).json() as { runId: string; taskId: string };
    const context = daemon.deps.sessionRegistry.findResumeContextByName(SEAT)!;
    const original = daemon.deps.startupOrchestrator!;
    await vi.waitFor(() => expect(original.pendingManagedBinding(nodeId, context.sessionId)).toBeDefined(), { timeout: 60_000 });
    const replacement = new StartupOrchestrator({ db, sessionRegistry: daemon.deps.sessionRegistry,
      eventBus: daemon.deps.eventBus, tmuxAdapter: daemon.deps.tmuxAdapter, readFile: path => readFileSync(path, "utf8") });
    daemon.deps.startupOrchestrator = replacement;
    expect(replacement.canContinueFresh(nodeId, context.sessionId)).toBe(true);
    expect(replacement.pendingManagedBinding(nodeId, context.sessionId)).toBeUndefined();
    const response = await continueTask(run.runId, run.taskId, daemon.deps.teamGovernance!.getRun(run.runId).entityVersion);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "continuation_unavailable" });
    expect(tmuxRun("capture-pane", "-p", "-J", "-S", "-200", "-t", `=${SEAT}:`)).not.toContain(goal);
    expect(receipts()).toHaveLength(1);
  }, 90_000);

  it.each(["plan", "approval", "deadline"])("refuses managed continuation when its %s changes", async kind => {
    const adapter = daemon.deps.runtimeAdapters!["claude-code"]!;
    vi.spyOn(adapter, "checkReady").mockResolvedValueOnce({ ready: false, code: "trust_gate" });
    const run = await (await start({ goal: "Keep changed authority out of the native prompt" })).json() as { runId: string; taskId: string };
    const context = daemon.deps.sessionRegistry.findResumeContextByName(SEAT)!;
    const startup = daemon.deps.startupOrchestrator!;
    await vi.waitFor(() => expect(startup.canContinueFresh(nodeId, context.sessionId)).toBe(true));
    const version = daemon.deps.teamGovernance!.getRun(run.runId).entityVersion;
    if (kind === "plan") writeFileSync(join(repo, "plan.md"), "changed plan\n");
    if (kind === "approval") db.prepare("UPDATE team_approvals SET expires_at = ? WHERE run_id = ?").run("2000-01-01T00:00:00.000Z", run.runId);
    const now = kind === "deadline" ? vi.spyOn(Date, "now").mockReturnValue(startup.pendingManagedBinding(nodeId, context.sessionId)!.managedAttempt!.deadline + 1) : null;
    try {
      expect((await continueTask(run.runId, run.taskId, version)).status).toBe(409);
      expect(tmuxRun("capture-pane", "-p", "-J", "-S", "-200", "-t", `=${SEAT}:`)).not.toContain("Keep changed authority out of the native prompt");
      expect(receipts()).toHaveLength(1);
    } finally { now?.mockRestore(); }
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
