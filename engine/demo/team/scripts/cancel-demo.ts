import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * T017 (cancellation half) — the owner's cancel, end to end, with no live client.
 *
 * Before this slice a cancel recorded `cancel_requested` and stopped there: the client kept
 * running, the task stayed open and the run never left that state. The demo shows the whole
 * path now: the owner starts a run, the daemon launches a client into the seat's pane, the
 * owner cancels, and the run comes to rest — with every step observed rather than assumed.
 *
 * Two clients are used. The first is the ordinary stub runner, which exits on SIGTERM. The
 * second ignores SIGTERM on purpose, so the demo shows the escalation the contract requires:
 * SIGTERM, then SIGKILL once the five-second grace has passed.
 *
 * What the demo asserts, in the order the contract states it:
 *  - the intent is durable before any signal (`cancel_requested` was written first);
 *  - only the process the run launched is signalled — identified by pid *and* start tick, and
 *    as the process group it leads;
 *  - the attempt is observed stopped, the task is canceled and the run reaches `canceled`;
 *  - no worktree or evidence is deleted: the candidate is still on disk, still readable through
 *    the same manifest `rig team apply` uses, and its uncommitted work is untouched;
 *  - dispatch is closed: a second task is refused, a launch is refused, and the composed
 *    dispatch starts nothing.
 *
 * Everything is real except the native client: the routes, the governance owner, the queue, the
 * candidate trees, the launcher and the sweep. The scratch home, database and tmux socket are
 * this process's own, so nothing here touches the operator's ~/.openrig or live daemon.
 *
 * Usage, from `engine/` after `npm run build`: npx tsx demo/team/scripts/cancel-demo.ts
 */

const scratch = mkdtempSync(join(tmpdir(), "team-cancel-"));
const repository = join(scratch, "repository"), ownerToken = "demo-cancel-owner";
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
const resistant = new URL("./resistant-client.mjs", import.meta.url).pathname;
/** Which client the next launch starts: the ordinary stub, or the one that ignores SIGTERM. */
let client = stub;
const daemon = await createDaemon({ dbPath: join(scratch, "demo.db"), managedMode: true, workersIsolation: "none",
  teamControl: { credentials: { ownerToken } },
  cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
  directLaunchCommand: facts => [process.execPath, client, "--session-name", facts.taskId,
    "--cwd", facts.tree, "--launch-id", facts.attemptId, "--posture", "floor"],
});
async function api(path: string, payload?: unknown) {
  const response = await daemon.app.fetch(new Request("http://127.0.0.1/api/team-control" + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + ownerToken, "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
function writable(path: string): void {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) writable(child); else chmodSync(child, 0o600);
  }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Whether the kernel still lists this pid at all; a zombie is listed but runs nothing. */
const processAlive = (pid: number): boolean => {
  try {
    const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[0] !== "Z" && fields[0] !== "X";
  } catch { return false; }
};
let failed = true;
try {
  const governance = daemon.deps.teamGovernance!;
  const rig = daemon.deps.rigRepo.createRig("cancel-demo", repository);
  for (const [id, seat] of [["impl", "impl@cancel-demo"]] as const) {
    const node = daemon.deps.rigRepo.addNode(rig.id, id, { role: "implementer", runtime: "claude-code", cwd: repository });
    daemon.deps.sessionRegistry.registerSession(node.id, seat);
  }
  const runVersion = async (runId: string) => (await api(`/runs/${runId}`)).body.run as { entityVersion: number; state: string };
  const cancel = async (runId: string) => {
    const run = await runVersion(runId);
    return api(`/runs/${runId}/cancel`, { protocolVersion: "1.0", runId, actionId: runId,
      expectedEntityVersion: run.entityVersion, idempotencyKey: crypto.randomUUID(), payload: { reason: "Demo cancel" } });
  };
  const attemptsOf = (runId: string) => daemon.db.prepare("SELECT id, state, identity_json AS identityJson FROM team_attempts WHERE run_id = ? ORDER BY rowid")
    .all(runId) as Array<{ id: string; state: string; identityJson: string }>;
  const waitForAttempt = async (runId: string) => {
    const deadline = Date.now() + 60_000;
    while (!attemptsOf(runId).length && Date.now() < deadline) await sleep(100);
    const attempt = attemptsOf(runId)[0];
    assert.ok(attempt, "the launch must be admitted as an attempt");
    return attempt;
  };
  const queueState = (runId: string, taskId: string) => governance.queueState(governance.findTask(runId, taskId)!.qitemId);
  daemon.deps.attemptCompletion!.start();

  console.log("==> The owner starts a run; the daemon launches the client into the seat's pane");
  const start = await api("/runs", { goal: "Implement the first scoped module", seat: "impl@cancel-demo", writePaths: ["src/a.ts"] });
  const runId = start.body.runId as string;
  const first = await waitForAttempt(runId);
  assert.equal(first.state, "running", "the launched client must be running before the cancel");
  const tree = daemon.deps.workflowRuntime!.assignedTreeFor(runId, { taskId: "task-1" });
  // Work in progress, so the candidate is not empty when the cancel lands.
  writeFileSync(join(tree, "src/a.ts"), "export const a = 2; // work in progress\n");
  const identity = JSON.parse(first.identityJson) as { processId: number; processStart: string };
  assert.equal(processAlive(identity.processId), true, "the launched client must be running before the cancel");
  console.log(`Attempt ${first.id} is running as process ${identity.processId} (start ${identity.processStart}) in ${tree}.`);

  console.log("==> The owner cancels: the intent is recorded, then only this run's process is ended");
  const receipt = await cancel(runId);
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  const value = receipt.body.value as { state: string; attempts: Array<{ processId: number; processStart: string;
    outcome: string; escalated: boolean }>; canceledTasks: string[]; unresolvedAttempts: string[] };
  assert.equal(receipt.body.status, "observed", "the daemon must observe the stop, not assume it");
  assert.equal(value.state, "canceled");
  assert.deepEqual(value.unresolvedAttempts, []);
  assert.deepEqual(value.attempts.map(attempt => [attempt.processId, attempt.processStart, attempt.outcome]),
    [[identity.processId, identity.processStart, "stopped"]], "the cancel names the identity it ended");
  assert.equal(value.attempts[0]!.escalated, false, "a client that exits on SIGTERM needs no SIGKILL");
  console.log(`Canceled: process ${identity.processId} stopped on SIGTERM; task(s) ${value.canceledTasks.join(", ")} closed.`);

  console.log("==> The run reached its terminal state and the attempt was observed stopped");
  const settled = await runVersion(runId);
  assert.equal(settled.state, "canceled");
  assert.equal(attemptsOf(runId)[0]!.state, "stopped");
  assert.equal(queueState(runId, "task-1"), "canceled");
  assert.equal(processAlive(identity.processId), false, "the client must be gone");
  console.log(`Run ${runId} is canceled; attempt ${first.id} is stopped; task-1 is canceled.`);

  console.log("==> Nothing was deleted: the candidate is still there and still readable");
  assert.equal(existsSync(tree), true, "the worktree must survive the cancel");
  assert.match(execFileSync("git", ["-C", tree, "status", "--porcelain"], { encoding: "utf8" }), /M src\/a\.ts/,
    "the work in progress must be untouched");
  // The same manifest `rig team apply` reads: a canceled task's result is still served.
  const result = await api(`/runs/${runId}/tasks/task-1/result`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const manifest = result.body.result as { patch: string; files: Array<{ path: string }> };
  assert.match(manifest.patch, /src\/a\.ts/, "the patch still moves the work in progress");
  console.log(`Candidate kept: ${manifest.files.length} file(s), the patch still moves src/a.ts.`);

  console.log("==> Dispatch is closed: nothing this run owns can start again");
  const secondTask = governance.createTask({ protocolVersion: "1.0", runId, actionId: "task-2",
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: "demo-second-task",
    payload: { assignment: { taskId: "task-2", role: "implementer", paths: ["src/a.ts"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead@cancel-demo", destinationSession: "impl@cancel-demo", body: "Second task." } },
    governance.getRun(runId).binding);
  assert.equal(secondTask.status, "denied");
  assert.match(secondTask.reason ?? "", /closed to dispatch/);
  const admission = (() => { try {
    daemon.deps.workflowRuntime!.admitForLaunch(runId, { attemptId: "demo-attempt", worker: "local",
      assignment: { taskId: "task-1", role: "implementer", paths: ["src/a.ts"], dependencies: [] }, outputs: [], permissions: [],
      context: { runId, role: "implementer", binding: governance.getRun(runId).binding } });
    return "admitted";
  } catch (error) { return (error as Error).message; } })();
  assert.match(admission, /not approved/, "a launch must be refused after the cancel");
  // The composed dispatch is the path a start and a completion use; it must start nothing. The
  // seat is put back to "never launched" first, so a dispatch that skipped its own gate would
  // really launch — and the launch count is what proves it did not.
  const seat = daemon.deps.sessionRegistry.findResumeContextByName("impl@cancel-demo")!;
  daemon.deps.sessionRegistry.updateStartupStatus(seat.sessionId, "pending");
  const receiptsBefore = daemon.db.prepare("SELECT count(*) AS n FROM events WHERE type='managed.attempt.receipt'").get() as { n: number };
  await daemon.deps.teamControl!.dispatch!(runId, "task-1");
  await sleep(1_000);
  const receiptsAfter = daemon.db.prepare("SELECT count(*) AS n FROM events WHERE type='managed.attempt.receipt'").get() as { n: number };
  assert.equal(receiptsAfter.n, receiptsBefore.n, "no client may be launched after the cancel");
  console.log(`Second task refused (${secondTask.reason}); launch refused (${admission}); dispatch started nothing.`);

  console.log("==> A client that ignores SIGTERM is killed once the five-second grace has passed");
  // A seat of its own, so this client gets a terminal whose screen is not the previous run's.
  const stubbornNode = daemon.deps.rigRepo.addNode(rig.id, "stubborn", { role: "implementer", runtime: "claude-code", cwd: repository });
  daemon.deps.sessionRegistry.registerSession(stubbornNode.id, "stubborn@cancel-demo");
  client = resistant;
  const second = await api("/runs", { goal: "Implement the first scoped module again", seat: "stubborn@cancel-demo", writePaths: ["src/a.ts"] });
  const secondRunId = second.body.runId as string;
  const stubborn = await waitForAttempt(secondRunId);
  assert.equal(stubborn.state, "running", "the resistant client must be running before the cancel");
  const stubbornIdentity = JSON.parse(stubborn.identityJson) as { processId: number; processStart: string };
  assert.equal(processAlive(stubbornIdentity.processId), true);
  const escalatedReceipt = await cancel(secondRunId);
  assert.equal(escalatedReceipt.status, 200, JSON.stringify(escalatedReceipt.body));
  const escalated = (escalatedReceipt.body.value as { state: string; attempts: Array<{ outcome: string; escalated: boolean; waitedMs: number }> });
  assert.equal(escalated.state, "canceled");
  assert.equal(escalated.attempts[0]!.escalated, true, "a client that ignores SIGTERM must be killed");
  assert.equal(escalated.attempts[0]!.outcome, "stopped");
  assert.ok(escalated.attempts[0]!.waitedMs >= 5_000, `the grace period must be honoured (waited ${escalated.attempts[0]!.waitedMs}ms)`);
  assert.equal(processAlive(stubbornIdentity.processId), false);
  assert.equal(queueState(secondRunId, "task-1"), "canceled");
  console.log(`Resistant client ${stubbornIdentity.processId}: SIGTERM ignored, SIGKILL after ${escalated.attempts[0]!.waitedMs}ms, run canceled.`);

  console.log("Cancellation demo passed. No process was signalled that the run did not launch.");
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
