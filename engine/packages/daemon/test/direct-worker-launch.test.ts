import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DirectWorkerLauncher } from "../src/adapters/direct-worker-launch.js";
import type { WorkerLaunchInput } from "../src/adapters/worker-launch.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import { writeAgentTurnPrompt } from "../src/domain/agent-turn.js";
import { TEAM_CONTROL_VERSION } from "../src/contracts/team-control.js";
import { unisolatedWorkerRoots } from "../src/domain/unisolated-roots.js";
import type { createDaemon } from "../src/startup.js";

const threadId = "019a527e-91e7-7000-8aac-35cd290bda12";
const clientsBin = "/opt/multi-agent/toolchain/clients/bin";
const view = fileURLToPath(new URL("../assets/agent-turn-view.mjs", import.meta.url));

function writable(path: string): void {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) writable(child); else chmodSync(child, 0o600);
  }
}

describe("managed Codex turns", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "codex-turn-")); });
  afterEach(() => { writable(root); rmSync(root, { recursive: true, force: true }); });

  const launch = async (options: Partial<WorkerLaunchInput> = {}) => {
    const context = {
      runId: "run", assignment: { taskId: "task", role: "implementer", paths: ["plan.md"], dependencies: [] },
      client: "codex", mutableStateRoot: root, projection: { attemptId: "attempt-1" },
      binding: { policyFingerprint: "sha256:" + "b".repeat(64) }, generatedHash: "sha256:" + "a".repeat(64),
    } as ContextManifest;
    writeAgentTurnPrompt(context, "Read the assigned plan.\n");
    const terminal = {
      sendText: vi.fn(async (_pane: string, _line: string) => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPanePid: vi.fn(async () => process.pid), getPaneCommand: vi.fn(async () => "node"),
      capturePaneScreen: vi.fn(async () => ""), getPaneExit: vi.fn(async () => ({ dead: true, code: 0 })),
    };
    const launcher = new DirectWorkerLauncher({ tmux: terminal, resolvePane: async () => "%1",
      resolveAssignedTree: () => join(root, "candidate tree"), tmuxServer: () => join(root, "tmux") });
    const input: WorkerLaunchInput = { client: "codex",
      attempt: { attemptId: "attempt-1", deadline: Date.now() + 60_000, context }, ...options };
    const result = await launcher.launch(input);
    return { result, input, launcher, terminal, line: terminal.sendText.mock.calls[0]?.[1] ?? "" };
  };

  it("launches exec with stdin, a per-attempt final message, and the supported model and effort flags", async () => {
    const { result, line } = await launch({ model: "fixture-model", effort: "high" });
    expect(result).toMatchObject({ ok: true });
    expect(line).toContain("agent-turn-view.mjs");
    expect(line).toContain("'codex' 'exec' '--json' '-o' '" + join(root, "turns/attempt-1/last-message.txt") + "'");
    expect(line).toContain("'-C' '" + join(root, "candidate tree") + "' '-s' 'workspace-write'");
    expect(line).toContain("'-c' 'sandbox_workspace_write.network_access=true'");
    expect(line).toContain("'-c' 'check_for_update_on_startup=false'");
    expect(line).toContain("'-m' 'fixture-model' '-c' 'model_reasoning_effort=high'");
    expect(line).toContain("'-' < '" + join(root, "turns/attempt-1.prompt") + "'");
    expect(line).not.toContain("'--effort'");
    expect(line).not.toContain("danger-full-access");
    expect(line).not.toContain("CODEX_HOME");
    expect(result.ok && result.resumeToken).toBeUndefined();
  });

  it.each(["resumeToken", "continueSessionId"] as const)("continues the stored thread through %s", async key => {
    const { line } = await launch({ [key]: threadId });
    expect(line).toContain("'codex' 'exec' 'resume' '--json' '-o'");
    expect(line).toContain("'-c' 'sandbox_mode=workspace-write'");
    expect(line).toContain("'-c' 'sandbox_workspace_write.network_access=true'");
    expect(line).toContain("'" + threadId + "' '-' < '");
    expect(line).toContain("cd '" + join(root, "candidate tree") + "'");
    expect(line).not.toContain("'-C'");
    expect(line).not.toContain("'-s'");
  });

  it.each(["resumeToken", "continueSessionId"] as const)("refuses hostile %s values before submitting a command", async key => {
    for (const token of ["--last", "with whitespace", "trailing\n", "", "x".repeat(129)]) {
      const { result, terminal } = await launch({ [key]: token });
      expect(result).toMatchObject({ ok: false });
      expect(terminal.sendText).not.toHaveBeenCalled();
    }
  });

  it("treats a finished headless turn as ready without an interactive composer", async () => {
    const { result, input, launcher } = await launch();
    expect(result).toMatchObject({ ok: true });
    expect(await launcher.checkReady(input.attempt)).toEqual({ ready: true });
  });

  it("renders Codex events, captures only the first thread, and preserves stdin and the exit status", () => {
    const script = join(root, "events.cjs"), threadFile = join(root, "thread-id.txt");
    writeFileSync(script, `const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
const events = [
  {type:'thread.started',thread_id:${JSON.stringify(threadId)}},
  {type:'thread.started',thread_id:'later-thread'},
  {type:'turn.started'},
  {type:'item.started',item:{type:'command_execution',command:'git status',status:'in_progress'}},
  {type:'item.completed',item:{type:'command_execution',command:'git status',aggregated_output:'clean tree',exit_code:0}},
  {type:'item.completed',item:{type:'file_change',changes:[{kind:'update',path:'plan.md'}]}},
  {type:'item.completed',item:{type:'agent_message',text:'Read: '+prompt}},
  {type:'error',message:'502 high demand'},
  {type:'turn.failed',error:{message:'provider unavailable'}}
];
process.stdout.write(events.map(event => JSON.stringify(event)).join('\\n'));
process.exitCode = 7;
`);
    const result = spawnSync(process.execPath, [view, "--thread-id-file", threadFile, process.execPath, script],
      { input: "the assigned plan", encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(7);
    expect(readFileSync(threadFile, "utf8")).toBe(threadId);
    expect(result.stdout).toContain("git status");
    expect(result.stdout).toContain("clean tree");
    expect(result.stdout).toContain("plan.md");
    expect(result.stdout).toContain("Read: the assigned plan");
    expect(result.stdout).toContain("502 high demand");
    expect(result.stdout).toContain("provider unavailable");
    expect(result.stdout).not.toContain('"type":');
  });

  it("keeps Claude output and a client's signal observable through the wrapper", () => {
    const result = spawnSync(process.execPath, [view, process.execPath, "-e",
      `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Still readable'}]}})); process.kill(process.pid, 'SIGTERM');`],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 10_000 });
    expect(result.stdout).toContain("Still readable");
    expect(result.signal).toBe("SIGTERM");
  });
});

it.each([
  { label: "valid thread and continuation", reportedThread: threadId, clientsEntries: 0 },
  { label: "clients directory already present", reportedThread: threadId, clientsEntries: 1 },
  { label: "duplicate clients directories", reportedThread: threadId, clientsEntries: 2 },
  { label: "leading dash refused", reportedThread: "--last", clientsEntries: 0 },
  { label: "whitespace refused", reportedThread: "bad thread", clientsEntries: 0 },
])("sweeps a native Codex stub to stopped ($label)", async ({ reportedThread, clientsEntries }) => {
  const root = mkdtempSync(join(tmpdir(), "codex-sweep-"));
  const home = join(root, "home"), repo = join(root, "repo"), bin = join(root, "bin");
  for (const path of [home, repo, bin, join(root, "tmux")]) mkdirSync(path);
  const saved = { OPENRIG_HOME: process.env.OPENRIG_HOME, TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, PATH: process.env.PATH };
  process.env.OPENRIG_HOME = home;
  process.env.TMUX_TMPDIR = join(root, "tmux");
  delete process.env.TMUX; delete process.env.TMUX_PANE;
  process.env.PATH = [bin, ...(saved.PATH ?? "").split(delimiter).filter(part => part !== clientsBin),
    ...Array<string>(clientsEntries).fill(clientsBin)].join(delimiter);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  try {
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repo, "plan.md"), "Read the plan and report the result.\n");
    git("add", "plan.md"); git("commit", "-qm", "fixture");
    writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'exec') { console.error('expected exec'); process.exit(2); }
const output = args[args.indexOf('-o') + 1];
fs.writeFileSync(output + '.launch.json', JSON.stringify({args, prompt:fs.readFileSync(0,'utf8'), cwd:process.cwd(), path:process.env.PATH}));
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(reportedThread)}}));
console.log(JSON.stringify({type:'turn.started'}));
fs.writeFileSync(output, 'The assigned plan was read.');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'The assigned plan was read.'}}));
const firstTurn = ${JSON.stringify(join(root, 'first-turn'))};
if (!fs.existsSync(firstTurn)) {
  fs.writeFileSync(firstTurn, 'observed');
  console.log(JSON.stringify({type:'error',message:'Error: connect ECONNRESET'}));
  process.exit(1);
}
console.log(JSON.stringify({type:'turn.completed'}));
`, { mode: 0o755 });
    vi.resetModules();
    const { createDaemon } = await import("../src/startup.js");
    expect(process.env.PATH!.split(delimiter).filter(part => part === clientsBin)).toHaveLength(clientsEntries);
    daemon = await createDaemon({ dbPath: join(root, "demo.db"), managedMode: true, workersIsolation: "none",
      teamControl: { credentials: { ownerToken: "fixture-owner" } },
      cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
    const rig = daemon.deps.rigRepo.createRig("codex-fixture", repo);
    const node = daemon.deps.rigRepo.addNode(rig.id, "builder", { role: "implementer", runtime: "codex", cwd: repo });
    const seat = "builder@codex-fixture";
    daemon.deps.sessionRegistry.registerSession(node.id, seat);
    const response = await daemon.app.fetch(new Request("http://127.0.0.1/api/team-control/runs", {
      method: "POST", headers: { Authorization: "Bearer fixture-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Read the assigned plan and report the result.", seat, writePaths: ["plan.md"] }),
    }), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    const body = await response.json() as { runId: string };
    expect(response.status, JSON.stringify(body)).toBe(201);
    const governance = daemon.deps.teamGovernance!;
    const qitemId = governance.findTask(body.runId, "task-1")!.qitemId;
    const attemptIds = () => (daemon!.db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? ORDER BY rowid")
      .all(qitemId) as Array<{ id: string }>).map(row => row.id);
    // Provider failures retain their native thread while the counted retry waits.
    await vi.waitFor(async () => {
      await daemon!.deps.attemptCompletion!.sweep();
      const ids = attemptIds();
      expect(ids).toHaveLength(1);
      expect(governance.getAttempt(ids[0]!)?.state).toBe("stopped");
    }, { timeout: 20_000, interval: 100 });
    const retryAt = governance.getTask(qitemId)!.evidence?.retryNotBefore;
    expect(typeof retryAt).toBe("string");
    expect(Date.parse(retryAt as string)).toBeGreaterThan(Date.now());
    await daemon.deps.attemptCompletion!.sweep();
    expect(attemptIds()).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(retryAt as string));
    await vi.waitFor(async () => {
      await daemon!.deps.attemptCompletion!.sweep();
      const ids = attemptIds();
      expect(ids).toHaveLength(2);
      expect(ids.every(id => governance.getAttempt(id)?.state === "stopped")).toBe(true);
    }, { timeout: 20_000, interval: 100 });
    const [firstId, secondId] = attemptIds();
    const first = governance.getAttempt(firstId!)!;
    const second = governance.getAttempt(secondId!)!;
    // The transport retry resumes once; its empty candidate then needs lead judgment, not another retry.
    expect(first.failure).toMatchObject({ reasonCode: "agent_error.provider_network", retryEligible: true });
    expect(second.failure).toMatchObject({ reasonCode: "evidence_invalid", retryEligible: false });
    expect(governance.getRun(body.runId).retriesUsed).toBe(1);
    const session = daemon.deps.sessionRegistry.getSessionsForRig(rig.id).find(row => row.sessionName === seat)!;
    if (reportedThread !== threadId) {
      expect(session.resumeToken).toBeNull();
      expect(session.startupStatus).toBe("pending");
      return;
    }
    expect(first.identity?.nativeSessionId).toBe(threadId);
    expect(session).toMatchObject({ resumeType: "codex_id", resumeToken: threadId, startupStatus: "pending" });
    const stateRoot = join(unisolatedWorkerRoots(home).workerRoot, "local", "scratch");
    const finalMessage = join(stateRoot, "turns", first.id, "last-message.txt");
    expect(readFileSync(finalMessage, "utf8")).toBe("The assigned plan was read.");
    const initial = JSON.parse(readFileSync(finalMessage + ".launch.json", "utf8"));
    expect(initial.prompt).toContain("Read the assigned plan and report the result.");
    expect(initial.cwd).toBe(daemon.deps.workflowRuntime!.assignedTreeFor(body.runId, governance.getTask(qitemId)!.assignment));
    expect(initial.path.split(delimiter).filter((part: string) => part === clientsBin)).toHaveLength(1);

    const continued = JSON.parse(readFileSync(join(stateRoot, "turns", second.id, "last-message.txt.launch.json"), "utf8"));
    expect(continued.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(continued.args.slice(-2)).toEqual([threadId, "-"]);
    expect(continued.cwd).toBe(initial.cwd);
    expect(continued.path.split(delimiter).filter((part: string) => part === clientsBin)).toHaveLength(1);
    expect(second.identity?.nativeSessionId).toBe(threadId);
    expect(dirname(finalMessage)).not.toContain(initial.cwd);
  } finally {
    vi.useRealTimers();
    daemon?.deps.attemptCompletion?.stop();
    try { execFileSync("tmux", ["kill-server"], { stdio: "ignore" }); } catch { /* The private server may already be stopped. */ }
    await daemon?.deps.workflowRuntime?.closeManagedAttempts();
    if (daemon?.db.open) daemon.db.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    writable(root); rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
