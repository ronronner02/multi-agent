import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * MVP slice C2 — the review loop, end to end, with no live client.
 *
 * One implementer seat and one reviewer seat, both played by the compiled stub runner. The
 * owner starts a run and the daemon launches the implementer; the agent finishes, the daemon
 * observes the attempt end, computes what it can verify about the candidate and records the
 * outcome. The daemon then creates the `reviewOf`-bound reviewer task and launches it on the
 * reviewer seat. The reviewer's first round finds a P1, which sends the implementer back for
 * rework and spends one round; the second round approves, which closes the task.
 *
 * Nothing here records an attempt or an outcome by hand: the attempt is admitted from the
 * launch's own receipt, its end is the client process ending, and the evidence is the candidate's
 * own manifest or the reviewer's final findings block.
 *
 * Everything is real except the native client: the routes, the governance owner, the queue,
 * the candidate trees and the dispatch chain. The scratch home, database and tmux socket are
 * this process's own, so nothing here touches the operator's ~/.openrig or live daemon.
 *
 * Usage, from `engine/` after `npm run build`: npx tsx demo/team/scripts/review-demo.ts
 */

const scratch = mkdtempSync(join(tmpdir(), "team-review-"));
const repository = join(scratch, "repository"), ownerToken = "demo-review-owner";
process.env.OPENRIG_HOME = join(scratch, "home");
process.env.TMUX_TMPDIR = join(scratch, "tmux");
delete process.env.TMUX; delete process.env.TMUX_PANE;
mkdirSync(join(repository, "src"), { recursive: true });
mkdirSync(process.env.TMUX_TMPDIR);
writeFileSync(join(repository, "plan.md"), "Implement the first scoped module.\n");
writeFileSync(join(repository, "src/a.ts"), "export const a = 1;\n");
for (const args of [["init", "-q"], ["config", "user.name", "Demo"], ["config", "user.email", "demo@example.invalid"],
  ["add", "plan.md", "src/a.ts"], ["commit", "-qm", "demo baseline"]]) {
  execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
}
const { createDaemon } = await import("../../../packages/daemon/src/startup.js");
const stub = new URL("../../../packages/daemon/dist/adapters/stub-runner.js", import.meta.url).pathname;
const turnStateRoot = join(process.env.OPENRIG_HOME, "state", "workers", "homes", "local", "scratch");
const reviewStub = join(scratch, "review-stub.mjs");
writeFileSync(reviewStub, `
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseStubRunnerArgs, runStubRunner } from ${JSON.stringify(stub)};
const args = parseStubRunnerArgs(process.argv.slice(2));
if (args.sessionName === "task-1") {
  const target = join(args.cwd, "src", "a.ts");
  const prior = existsSync(target) ? readFileSync(target, "utf8") : "";
  writeFileSync(target, prior.includes("round one") ? "export const a = 2; // reworked\\n" : "export const a = 1; // round one\\n");
}
const report = args.sessionName === "task-1-review-1"
  ? { findings: [{ id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness", file: "src/a.ts", scenario: "the exported constant keeps the stale value after the owner's clarification" }] }
  : args.sessionName === "task-1-review-2" ? { findings: [] } : null;
if (report) {
  const path = join(${JSON.stringify(turnStateRoot)}, "turns", args.launchId, "last-message.txt");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "\`\`\`json\\n" + JSON.stringify(report) + "\\n\`\`\`\\n", { mode: 0o600 });
}
await runStubRunner(args);
rmSync(join(args.cwd, ".openrig"), { recursive: true, force: true });
`);
const daemon = await createDaemon({ dbPath: join(scratch, "demo.db"), managedMode: true, workersIsolation: "none",
  teamControl: { credentials: { ownerToken } },
  cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
  directLaunchCommand: facts => [process.execPath, reviewStub, "--session-name", facts.taskId,
    "--cwd", facts.tree, "--launch-id", facts.attemptId, "--posture", "floor", "--turn"],
});
async function api(path: string, payload?: unknown) {
  const response = await daemon.app.fetch(new Request("http://127.0.0.1/api/team-control" + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + ownerToken, "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const result = await response.json();
  assert(response.ok, JSON.stringify({ path, status: response.status, result }));
  return result;
}
function writable(path: string): void {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) writable(child); else chmodSync(child, 0o600);
  }
}
const tmux = (...args: string[]) => execFileSync("tmux", args,
  { encoding: "utf8", env: { ...process.env }, stdio: ["ignore", "pipe", "ignore"] }).trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let failed = true;
try {
  const governance = daemon.deps.teamGovernance!;
  const rig = daemon.deps.rigRepo.createRig("review-demo", repository);
  for (const [id, seat] of [["impl", "impl@review-demo"], ["reviewer", "reviewer@review-demo"]]) {
    const node = daemon.deps.rigRepo.addNode(rig.id, id, { role: id === "reviewer" ? "reviewer" : "implementer",
      runtime: "claude-code", cwd: repository });
    daemon.deps.sessionRegistry.registerSession(node.id, seat);
  }
  const read = () => api(`/runs/${runId}/read`);
  const launches = () => daemon.db.prepare("SELECT count(*) AS n FROM events WHERE type='managed.attempt.receipt'").get() as { n: number };
  // The two candidate trees, so the settle helper can clear the stub runner's scratch out of
  // each one before a read stages its manifest.
  let implementerTree: string | undefined, reviewerTree: string | undefined;
  const waitForLaunches = async (count: number) => {
    const deadline = Date.now() + 60_000;
    while (launches().n < count && Date.now() < deadline) await sleep(100);
    assert.equal(launches().n, count, `Launch ${count} must reach the composed dispatch path`);
  };
  /**
   * Wait for the seats a dispatch just started to reach their client.
   *
   * A launch runs after the request that admitted the task returns, so the demo waits for the
   * seats it just dispatched to report `ready` before reading anything that depends on them. A
   * seat that is not being launched stays out of this list: an ended attempt correctly leaves its
   * seat at `pending`, waiting to be started again.
   */
  const waitForReady = async (...seats: string[]) => {
    const ready = (seat: string) => (daemon.db.prepare(
      "SELECT count(*) AS n FROM sessions WHERE session_name = ? AND startup_status = 'ready'").get(seat) as { n: number }).n;
    const deadline = Date.now() + 60_000;
    while (seats.some(seat => !ready(seat)) && Date.now() < deadline) await sleep(100);
    for (const seat of seats) assert.equal(ready(seat), 1, `Seat ${seat} must come up before the demo reads its candidate`);
  };
  /** The pane the seat's client runs in, from the binding the launch recorded. */
  const paneOf = (seat: string) => {
    const context = daemon.deps.sessionRegistry.findResumeContextByName(seat);
    const binding = context ? daemon.deps.sessionRegistry.getBindingForNode(context.nodeId) : null;
    assert.ok(binding?.tmuxPane, `Seat ${seat} must have a recorded pane`);
    return binding.tmuxPane!;
  };
  /**
   * The agent finishes: the seat's client process ends, exactly as a native client that
   * completed its turn would. The daemon's own sweep is what turns that into a stopped attempt.
   *
   * `attempts` is how many this task's own history must hold by now. Waiting for that count as
   * well as the stop is what makes a rework round wait for *its* attempt: the task already has
   * the previous round's stopped attempt behind it, so a stop alone would match the old one.
   */
  const finishSeat = async (seat: string, taskId: string, attempts: number) => {
    const qitemId = governance.findTask(runId, taskId)!.qitemId;
    const recorded = () => (daemon.db.prepare("SELECT count(*) AS n FROM team_attempts WHERE qitem_id = ?")
      .get(qitemId) as { n: number }).n;
    // A stub turn ends by itself now, so nothing is signalled into the pane: the demo waits
    // for the process to end exactly as the daemon does.
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (recorded() === attempts) {
        const { completion } = await api(`/runs/${runId}/tasks/${taskId}/completion`);
        if (completion.attempt?.state === "stopped") return;
      }
      if (Date.now() > deadline) {
        assert.fail(`The daemon must observe ${seat}'s attempt ${attempts} stop (holds ${recorded()})`);
      }
      await sleep(100);
    }
  };
  const waitForTaskState = async (taskId: string, expected: string) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const state = (await read()).read.tasks.find((task: { taskId: string; queueState: string }) => task.taskId === taskId)?.queueState;
      if (state === expected) return;
      if (Date.now() > deadline) assert.fail(`Task ${taskId} must reach ${expected} (holds ${state})`);
      await sleep(100);
    }
  };
  /** The stub runner's scratch is the client's state, not the deliverable. */
  const clearClientScratch = () => {
    for (const tree of [implementerTree, reviewerTree]) if (tree) rmSync(join(tree, ".openrig"), { recursive: true, force: true });
  };
  /**
   * Re-launch a seat, so a rework round gets its own attempt.
   *
   * Nothing here resets the seat: the daemon's own attempt-end observation already returned it
   * to the state a start leaves a never-launched seat in, so the composed dispatch starts a
   * fresh client under the seat's lifecycle lease, exactly as a start does.
   */
  const relaunch = (taskId: string) => daemon.deps.teamControl!.dispatch!(runId, taskId);

  console.log("==> The owner starts a run with an implementer seat and a reviewer seat");
  const start = await api("/runs", { goal: "Implement the first scoped module", seat: "impl@review-demo",
    reviewerSeat: "reviewer@review-demo", writePaths: ["src/a.ts"] });
  const runId = start.runId;
  assert.equal(start.reviewerSeat, "reviewer@review-demo");
  // The daemon's completion owner is what a managed daemon starts after its HTTP surface is up.
  daemon.deps.attemptCompletion!.start();
  await waitForLaunches(1);
  const tree = daemon.deps.workflowRuntime!.assignedTreeFor(runId, { taskId: "task-1" });
  implementerTree = tree;
  await waitForReady("impl@review-demo");
  // The receipt is the launch's own evidence: the daemon's sweep admits the attempt from it,
  // and the attempt names the client process the seat runs.
  const attempts = () => daemon.db.prepare("SELECT id, state FROM team_attempts ORDER BY rowid").all() as Array<{ id: string; state: string }>;
  const waitForAttempts = async (count: number) => {
    const deadline = Date.now() + 30_000;
    while (attempts().length < count && Date.now() < deadline) await sleep(100);
    assert.equal(attempts().length, count, `The daemon's sweep must admit ${count} attempt(s) from the launch receipts`);
  };
  await waitForAttempts(1);
  // The agent is one headless turn: it reads its prompt, works and exits by itself. The demo's
  // own edit below is the work that turn produces, and the daemon observes the turn end exactly
  // as it observes a real client's exit.
  console.log(`Attempt ${attempts()[0]!.id} admitted from the launch receipt; the turn runs and ends.`);

  console.log("==> The implementer finishes its candidate; the daemon observes the attempt stop");
  await finishSeat("impl@review-demo", "task-1", 1);
  clearClientScratch();
  await waitForTaskState("task-1", "done");
  assert.ok(governance.findTask(runId, "task-1-review-1"), "the daemon must admit the review task");
  console.log("The daemon validated the candidate, recorded the outcome and admitted the review task.");

  reviewerTree = daemon.deps.workflowRuntime!.assignedTreeFor(runId, { taskId: "task-1-review-1", reviewOf: "task-1" });
  await waitForLaunches(2);
  await waitForReady("reviewer@review-demo");
  let state = (await read()).read;
  const review1 = state.tasks.find((task: { taskId: string }) => task.taskId === "task-1-review-1");
  assert.equal(review1?.role, "reviewer");
  assert.equal(state.run.reviewRoundsUsed, 1);
  console.log("Reviewer task task-1-review-1 bound to task-1 and launched on the reviewer seat.");

  console.log("==> The reviewer's first round finds a P1: the implementer goes back for rework");
  await finishSeat("reviewer@review-demo", "task-1-review-1", 1);
  clearClientScratch();
  await waitForTaskState("task-1-review-1", "done");
  state = (await read()).read;
  assert.equal(state.tasks.find((task: { taskId: string }) => task.taskId === "task-1")?.queueState, "pending");
  assert.equal(state.run.reviewRoundsUsed, 1);
  console.log("Rework round recorded: task-1 is pending again, review_rounds_used is 1.");

  console.log("==> The implementer's second candidate fixes the finding");
  // The rework is a new launch, so it gets its own attempt: the daemon's attempt-end
  // observation returned the seat to "never launched" when the client ended, so the dispatch
  // starts a fresh one and the sweep admits its attempt from the new receipt.
  await relaunch("task-1");
  await waitForReady("impl@review-demo");
  await finishSeat("impl@review-demo", "task-1", 2);
  clearClientScratch();
  await waitForTaskState("task-1", "done");

  await waitForLaunches(3);
  await relaunch("task-1-review-2");
  await waitForReady("reviewer@review-demo");
  console.log("==> The reviewer's second round approves: the task is done");
  await finishSeat("reviewer@review-demo", "task-1-review-2", 1);
  clearClientScratch();
  await waitForTaskState("task-1-review-2", "done");
  state = (await read()).read;
  const implementer = state.tasks.find((task: { taskId: string }) => task.taskId === "task-1");
  assert.equal(implementer?.queueState, "done");
  assert.equal(state.run.reviewRoundsUsed, 2);
  assert.deepEqual(implementer?.verdicts.map((round: { round: number; verdict: string }) => [round.round, round.verdict]),
    [[1, "changes-required"], [2, "approved"]]);
  console.log("Task task-1 is done, with two recorded rounds: changes-required then approved.");
  console.log("C2 demo passed. No attempt or outcome was recorded by hand.");
  failed = false;
} catch (error) {
  console.error(error);
} finally {
  daemon.deps.attemptCompletion?.stop();
  try { execFileSync("tmux", ["kill-server"], { stdio: "ignore" }); } catch { /* The private server may already be stopped. */ }
  await daemon.deps.workflowRuntime?.closeManagedAttempts();
  daemon.db.close(); writable(scratch); rmSync(scratch, { recursive: true, force: true });
  // The daemon's owners keep timers that outlive their teardown; with the scratch tree gone,
  // there is nothing left to wait for.
  process.exit(failed ? 1 : 0);
}
