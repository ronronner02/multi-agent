import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * MVP slice C3 — a lead decomposes the goal, and the owner approves what it proposed.
 *
 * One lead seat and two implementer seats, all played by the compiled stub runner, plus one
 * reviewer seat. The owner starts a run naming a lead; the daemon launches the lead and its
 * context carries the protocol, the roster and the run instructions. The lead writes its
 * decomposition into its own candidate tree; the owner reads it through the daemon and records
 * the decision, which admits both implementer tasks through the same admission path a start
 * uses. Each task then runs and completes through the owner's action, and the first one goes
 * through the review loop C2 already owns.
 *
 * Nothing here records an attempt, a task or an outcome by hand: the attempts are admitted from
 * each launch's own receipt, the tasks come from the owner-approved batch, and the evidence is
 * the candidate's own manifest. The lead's proposal is the only worker-written file the demo
 * writes, and it is written into the lead's candidate tree, exactly as a real lead would.
 *
 * Usage, from `engine/` after `npm run build`: npx tsx demo/team/scripts/lead-demo.ts
 */

const scratch = mkdtempSync(join(tmpdir(), "team-lead-"));
const repository = join(scratch, "repository"), ownerToken = "demo-lead-owner";
process.env.OPENRIG_HOME = join(scratch, "home");
process.env.TMUX_TMPDIR = join(scratch, "tmux");
delete process.env.TMUX; delete process.env.TMUX_PANE;
mkdirSync(join(repository, "src"), { recursive: true });
mkdirSync(process.env.TMUX_TMPDIR);
writeFileSync(join(repository, "plan.md"), "Implement the first and second scoped modules.\n");
writeFileSync(join(repository, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(repository, "src/b.ts"), "export const b = 1;\n");
for (const args of [["init", "-q"], ["config", "user.name", "Demo"], ["config", "user.email", "demo@example.invalid"],
  ["add", "plan.md", "src/a.ts", "src/b.ts"], ["commit", "-qm", "demo baseline"]]) {
  execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
}
const { createDaemon } = await import("../../../packages/daemon/src/startup.js");
const stub = new URL("../../../packages/daemon/dist/adapters/stub-runner.js", import.meta.url).pathname;
const daemon = await createDaemon({ dbPath: join(scratch, "demo.db"), managedMode: true, workersIsolation: "none",
  teamControl: { credentials: { ownerToken } },
  cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
  directLaunchCommand: facts => [process.execPath, stub, "--session-name", facts.taskId,
    "--cwd", facts.tree, "--launch-id", facts.attemptId, "--posture", "floor"],
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
  const rig = daemon.deps.rigRepo.createRig("lead-demo", repository);
  for (const [id, role, seat] of [["lead", "lead", "lead@lead-demo"], ["impl-a", "implementer", "a@lead-demo"],
    ["impl-b", "implementer", "b@lead-demo"], ["reviewer", "reviewer", "reviewer@lead-demo"]] as const) {
    const node = daemon.deps.rigRepo.addNode(rig.id, id, { role, runtime: "claude-code", cwd: repository });
    daemon.deps.sessionRegistry.registerSession(node.id, seat);
  }
  const command = async (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId,
    actionId, expectedEntityVersion: (await api(`/runs/${runId}`)).run.entityVersion,
    idempotencyKey: crypto.randomUUID(), payload });
  const read = () => api(`/runs/${runId}/read`);
  const launches = () => daemon.db.prepare("SELECT count(*) AS n FROM events WHERE type='managed.attempt.receipt'").get() as { n: number };
  const waitForLaunches = async (count: number) => {
    const deadline = Date.now() + 60_000;
    while (launches().n < count && Date.now() < deadline) await sleep(100);
    if (launches().n !== count) {
      // A launch that never reached the receipt path is a startup failure the demo cannot
      // explain from the outside; say which one, so a broken seat is not mistaken for a wait.
      const failed = daemon.db.prepare(`SELECT json_extract(payload, '$.error') AS error FROM events
        WHERE type = 'node.startup_failed' ORDER BY seq DESC LIMIT 3`).all() as Array<{ error: string }>;
      assert.fail(`Launch ${count} must reach the composed dispatch path (holds ${launches().n})` +
        (failed.length ? `; startup failures: ${failed.map(row => row.error).join(" | ")}` : ""));
    }
  };
  const waitForReady = async (...seats: string[]) => {
    const ready = (seat: string) => (daemon.db.prepare(
      "SELECT count(*) AS n FROM sessions WHERE session_name = ? AND startup_status = 'ready'").get(seat) as { n: number }).n;
    const deadline = Date.now() + 60_000;
    while (seats.some(seat => !ready(seat)) && Date.now() < deadline) await sleep(100);
    for (const seat of seats) assert.equal(ready(seat), 1, `Seat ${seat} must come up before the demo reads its candidate`);
  };
  const paneOf = (seat: string) => {
    const context = daemon.deps.sessionRegistry.findResumeContextByName(seat);
    const binding = context ? daemon.deps.sessionRegistry.getBindingForNode(context.nodeId) : null;
    assert.ok(binding?.tmuxPane, `Seat ${seat} must have a recorded pane`);
    return binding.tmuxPane!;
  };
  const finishSeat = async (seat: string, taskId: string, attempts: number) => {
    const qitemId = governance.findTask(runId, taskId)!.qitemId;
    const recorded = () => (daemon.db.prepare("SELECT count(*) AS n FROM team_attempts WHERE qitem_id = ?")
      .get(qitemId) as { n: number }).n;
    tmux("send-keys", "-t", paneOf(seat), "C-c");
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (recorded() === attempts) {
        const { completion } = await api(`/runs/${runId}/tasks/${taskId}/completion`);
        if (completion.attempt?.state === "stopped") return;
      }
      if (Date.now() > deadline) assert.fail(`The daemon must observe ${seat}'s attempt ${attempts} stop (holds ${recorded()})`);
      await sleep(100);
    }
  };
  const trees: string[] = [];
  const treeOf = (taskId: string, reviewOf?: string) => {
    const tree = daemon.deps.workflowRuntime!.assignedTreeFor(runId, { taskId, ...(reviewOf ? { reviewOf } : {}) });
    trees.push(tree);
    return tree;
  };
  const clearClientScratch = () => { for (const tree of trees) rmSync(join(tree, ".openrig"), { recursive: true, force: true }); };
  const complete = async (taskId: string, state: "done" | "failed", findings?: unknown) => {
    const { completion } = await api(`/runs/${runId}/tasks/${taskId}/completion`);
    assert.equal(completion.blockedReason, null, `task ${taskId} must be recordable: ${completion.blockedReason}`);
    assert.ok(completion.attempt, `task ${taskId} must have an observed attempt`);
    return api(`/runs/${runId}/tasks/outcome`, await command(governance.findTask(runId, taskId)!.qitemId, {
      expectedTaskVersion: completion.taskVersion, state, ...(state === "done" ? { closureReason: "no-follow-on" } : {}),
      actorSession: completion.actorSession, attemptId: completion.attempt.attemptId,
      expectedAttemptVersion: completion.attempt.entityVersion,
      evidence: { ...completion.evidence, ...(findings === undefined ? {} : { findings }) },
    }));
  };
  const relaunch = (taskId: string) => daemon.deps.teamControl!.dispatch!(runId, taskId);
  const attempts = () => daemon.db.prepare("SELECT id, state FROM team_attempts ORDER BY rowid").all() as Array<{ id: string; state: string }>;
  const waitForAttempts = async (count: number) => {
    const deadline = Date.now() + 30_000;
    while (attempts().length < count && Date.now() < deadline) await sleep(100);
    assert.equal(attempts().length, count, `The daemon's sweep must admit ${count} attempt(s) from the launch receipts`);
  };

  console.log("==> The owner starts a run with a lead seat, an implementer seat and a reviewer seat");
  const start = await api("/runs", { goal: "Implement the two scoped modules", lead: "lead@lead-demo",
    seat: "a@lead-demo", reviewerSeat: "reviewer@lead-demo", writePaths: ["src/a.ts", "src/b.ts"] });
  const runId = start.runId;
  assert.equal(start.leadSeat, "lead@lead-demo");
  assert.equal(start.taskId, "task-1");
  daemon.deps.attemptCompletion!.start();
  await waitForLaunches(1);
  const leadTree = treeOf("task-1");
  await waitForReady("lead@lead-demo");
  await waitForAttempts(1);
  assert.equal(attempts()[0]!.state, "running");
  console.log("The lead is running with its protocol, roster and run instructions.");

  console.log("==> The lead writes its decomposition; the owner reads it and approves the exact batch");
  // The lead's one output: a structured file in its own candidate tree, which the daemon reads
  // at the boundary that owns worker-written data.
  writeFileSync(join(leadTree, "lead-proposal.json"), JSON.stringify({ tasks: [
    { taskId: "task-2", seat: "a@lead-demo", paths: ["src/a.ts"], dependencies: [], body: "Implement the first scoped module" },
    { taskId: "task-3", seat: "b@lead-demo", paths: ["src/b.ts"], dependencies: [], body: "Implement the second scoped module" },
  ] }));
  const proposal = await api(`/runs/${runId}/tasks/task-1/proposal`);
  assert.deepEqual(proposal.proposal.tasks.map((task: { taskId: string }) => task.taskId), ["task-2", "task-3"]);
  // Nothing is admitted by reading it.
  assert.equal((await read()).read.tasks.length, 1);
  await finishSeat("lead@lead-demo", "task-1", 1);
  clearClientScratch();
  const requested = await api(`/runs/${runId}/tasks/task-1/proposal`,
    await command("lead-proposal", { leadProposal: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }));
  assert.equal(requested.status, "accepted");
  assert.equal((await read()).read.tasks.length, 1, "a recorded proposal admits nothing until the owner decides it");
  const approval = requested.value as { id: string; entityVersion: number };
  const decided = await api(`/runs/${runId}/approvals/decide`,
    await command(approval.id, { approvalVersion: approval.entityVersion, decision: "approved" }));
  assert.deepEqual((decided.value as { addedTasks: string[] }).addedTasks, ["task-2", "task-3"]);
  let state = (await read()).read;
  assert.equal(state.tasks.length, 3);
  assert.equal(state.tasks.find((task: { taskId: string }) => task.taskId === "task-1")?.role, "lead");
  assert.equal(state.tasks.find((task: { taskId: string }) => task.taskId === "task-2")?.queueState, "pending");
  console.log("Both implementer tasks admitted through the owner's decision, and dispatched.");

  console.log("==> Both implementer tasks run; the first goes through review and the second completes");
  const treeA = treeOf("task-2"), treeB = treeOf("task-3");
  await waitForLaunches(3);
  await waitForReady("a@lead-demo", "b@lead-demo");
  await waitForAttempts(3);
  writeFileSync(join(treeA, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(treeB, "src", "b.ts"), "export const b = 2;\n");
  await finishSeat("a@lead-demo", "task-2", 1);
  await finishSeat("b@lead-demo", "task-3", 1);
  clearClientScratch();
  // One reviewer seat serves one live task at a time — that is C2's own rule, and the launch
  // composition refuses a seat with two — so the reviews are taken in turn, as a run with one
  // reviewer actually does.
  const doneA = await complete("task-2", "done");
  assert.equal(doneA.reviewTaskId, "task-2-review-1", "the first task must enter the review loop");
  console.log("task-2 completed through the owner action; its review task was created.");

  const reviewTree = treeOf("task-2-review-1", "task-2");
  await waitForLaunches(4);
  await waitForReady("reviewer@lead-demo");
  await finishSeat("reviewer@lead-demo", "task-2-review-1", 1);
  clearClientScratch();
  const approved = await complete("task-2-review-1", "done", []);
  assert.equal(approved.reworkTaskId, undefined, "an approving review must not reopen the implementer");
  state = (await read()).read;
  assert.equal(state.tasks.find((task: { taskId: string }) => task.taskId === "task-2")?.queueState, "done");
  assert.equal(state.run.reviewRoundsUsed, 1);
  assert.ok(reviewTree.length > 0);
  console.log("task-2 is done after one approving review round.");

  console.log("==> The second task completes and its review is admitted too");
  const doneB = await complete("task-3", "done");
  assert.equal(doneB.reviewTaskId, "task-3-review-1", "the second task enters the same review loop");
  state = (await read()).read;
  assert.equal(state.run.reviewRoundsUsed, 2);
  assert.equal(state.tasks.find((task: { taskId: string }) => task.taskId === "task-3")?.queueState, "done");
  assert.equal(state.tasks.find((task: { taskId: string }) => task.taskId === "task-3-review-1")?.role, "reviewer");
  console.log("task-3 completed and task-3-review-1 was admitted against it.");
  console.log("C3 demo passed. The lead proposed, the owner approved, and the tasks ran and reviewed.");
  failed = false;
} catch (error) {
  console.error(error);
} finally {
  daemon.deps.attemptCompletion?.stop();
  try { execFileSync("tmux", ["kill-server"], { stdio: "ignore" }); } catch { /* The private server may already be stopped. */ }
  await daemon.deps.workflowRuntime?.closeManagedAttempts();
  daemon.db.close(); writable(scratch); rmSync(scratch, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
