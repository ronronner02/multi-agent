import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * MVP slice C2 — the review loop, end to end, with no live client.
 *
 * One implementer seat and one reviewer seat, both played by the compiled stub runner. The
 * owner starts a run, the implementer completes with validated evidence, and the daemon
 * creates the `reviewOf`-bound reviewer task and launches it on the reviewer seat. The
 * reviewer's first round finds a P1, which sends the implementer back for rework and spends
 * one round; the second round approves, which closes the task.
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
let failed = true;
try {
  const governance = daemon.deps.teamGovernance!;
  const rig = daemon.deps.rigRepo.createRig("review-demo", repository);
  for (const [id, seat] of [["impl", "impl@review-demo"], ["reviewer", "reviewer@review-demo"]]) {
    const node = daemon.deps.rigRepo.addNode(rig.id, id, { role: id === "reviewer" ? "reviewer" : "implementer",
      runtime: "claude-code", cwd: repository });
    daemon.deps.sessionRegistry.registerSession(node.id, seat);
  }
  const command = async (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId,
    actionId, expectedEntityVersion: (await api(`/runs/${runId}`)).run.entityVersion,
    idempotencyKey: crypto.randomUUID(), payload });
  const read = () => api(`/runs/${runId}/read`);
  const launches = () => daemon.db.prepare("SELECT count(*) AS n FROM events WHERE type='managed.attempt.receipt'").get() as { n: number };
  // The two candidate trees, so the settle helper can clear the stub runner's scratch out of
  // each one before a read stages its manifest.
  let implementerTree: string | undefined, reviewerTree: string | undefined;
  const waitForLaunches = async (count: number) => {
    const deadline = Date.now() + 60_000;
    while (launches().n < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(launches().n, count, `Launch ${count} must reach the composed dispatch path`);
  };
  const settleLaunches = async (...seats: string[]) => {
    const pending = (seat: string) => (daemon.db.prepare(
      "SELECT count(*) AS n FROM sessions WHERE session_name = ? AND startup_status = 'pending'").get(seat) as { n: number }).n;
    const deadline = Date.now() + 60_000;
    while (seats.some(pending) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    for (const seat of seats) assert.equal(pending(seat), 0, `Seat ${seat} must settle before the demo reads its candidate`);
    // The stub runner's own scratch (`.openrig/stub/*`) is the client's state, not the
    // deliverable: the candidate scope check would read it as a change outside the task's
    // paths. The seat has settled, so removing it touches nothing that is still running.
    for (const tree of [implementerTree, reviewerTree]) if (tree) rmSync(join(tree, ".openrig"), { recursive: true, force: true });
  };

  console.log("==> The owner starts a run with an implementer seat and a reviewer seat");
  const start = await api("/runs", { goal: "Implement the first scoped module", seat: "impl@review-demo",
    reviewerSeat: "reviewer@review-demo", writePaths: ["src/a.ts"] });
  const runId = start.runId;
  assert.equal(start.reviewerSeat, "reviewer@review-demo");
  await waitForLaunches(1);
  const tree = daemon.deps.workflowRuntime!.assignedTreeFor(runId, { taskId: "task-1" });
  implementerTree = tree;
  // The stub runner's scratch (`.openrig/stub/*`) is the client's own state, not the
  // deliverable. It lives inside the candidate tree, where the scope check would read it as
  // a change outside the task's paths — so the seat settles first and the scratch is removed
  // before anything reads the candidate.
  await settleLaunches("impl@review-demo");

  /**
   * The owner observes one task's stopped attempt and records its outcome. Production records
   * the attempt through the control surface before the outcome; the demo does the same two
   * writes, so nothing about the review loop is stubbed.
   */
  const metric = { value: null, reason: "not reported" }, usage = { activeMs: 0, inputTokens: metric, outputTokens: metric, costUsd: metric };
  const observe = async (taskId: string, state: "done" | "failed", evidence: Record<string, unknown>) => {
    const task = governance.findTask(runId, taskId)!;
    const seat = daemon.deps.queueRepo!.getById(task.qitemId)!.destinationSession;
    const attemptId = `${taskId}-attempt-${crypto.randomUUID().slice(0, 8)}`;
    const binding = governance.getRun(runId).binding;
    const recorded = governance.recordAttempt(await command(attemptId, { qitemId: task.qitemId, role: task.assignment.role,
      provider: "claude", state: "stopped", unknownReason: null, usage,
      identity: { nativeSessionId: attemptId, tmuxServer: process.env.TMUX_TMPDIR!, paneId: "%1", processId: 4242,
        processStart: "demo-process-start", generation: 1, policyFingerprint: binding.policyFingerprint } }), binding);
    assert.equal(recorded.status, "observed", "attempt: " + recorded.reason);
    return api(`/runs/${runId}/tasks/outcome`, await command(task.qitemId, { expectedTaskVersion: governance.getTask(task.qitemId)!.entityVersion,
      state, ...(state === "done" ? { closureReason: "no-follow-on" } : {}), actorSession: seat, attemptId,
      expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion, evidence }));
  };

  console.log("==> The implementer finishes its candidate with validated evidence");
  writeFileSync(join(tree, "src", "a.ts"), "export const a = 1; // round one\n");
  const completed = await observe("task-1", "done", { validated: true, manifestDigest: `sha256:${"a".repeat(64)}` });
  assert.equal(completed.reviewTaskId, "task-1-review-1", "the completion must admit its reviewer task");
  reviewerTree = daemon.deps.workflowRuntime!.assignedTreeFor(runId, { taskId: "task-1-review-1", reviewOf: "task-1" });
  await waitForLaunches(2);
  await settleLaunches("impl@review-demo", "reviewer@review-demo");
  let state = (await read()).read;
  const review1 = state.tasks.find((task: { taskId: string }) => task.taskId === "task-1-review-1");
  assert.equal(review1?.role, "reviewer");
  assert.equal(state.run.reviewRoundsUsed, 1);
  console.log("Reviewer task task-1-review-1 bound to task-1 and launched on the reviewer seat.");

  console.log("==> The reviewer's first round finds a P1: the implementer goes back for rework");
  const findings = [{ id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness", file: "src/a.ts",
    scenario: "the exported constant keeps the stale value after the owner's clarification" }];
  const reviewed = await observe("task-1-review-1", "done", { findings, manifestDigest: `sha256:${"a".repeat(64)}` });
  assert.equal(reviewed.reworkTaskId, "task-1", "blocking findings must reopen the implementer");
  state = (await read()).read;
  assert.equal(state.tasks.find((task: { taskId: string }) => task.taskId === "task-1")?.queueState, "pending");
  assert.equal(state.run.reviewRoundsUsed, 1);
  console.log("Rework round recorded: task-1 is pending again, review_rounds_used is 1.");

  console.log("==> The implementer's second candidate fixes the finding");
  writeFileSync(join(tree, "src", "a.ts"), "export const a = 2; // reworked\n");
  const reworked = await observe("task-1", "done", { validated: true, manifestDigest: `sha256:${"b".repeat(64)}` });
  assert.equal(reworked.reviewTaskId, "task-1-review-2");

  console.log("==> The reviewer's second round approves: the task is done");
  const approved = await observe("task-1-review-2", "done", { findings: [], manifestDigest: `sha256:${"b".repeat(64)}` });
  assert.equal(approved.reworkTaskId, undefined, "an approving review must not reopen the implementer");
  state = (await read()).read;
  const implementer = state.tasks.find((task: { taskId: string }) => task.taskId === "task-1");
  assert.equal(implementer?.queueState, "done");
  assert.equal(state.run.reviewRoundsUsed, 2);
  assert.deepEqual(implementer?.verdicts.map((round: { round: number; verdict: string }) => [round.round, round.verdict]),
    [[1, "changes-required"], [2, "approved"]]);
  console.log("Task task-1 is done, with two recorded rounds: changes-required then approved.");
  console.log("C2 demo passed.");
  failed = false;
} catch (error) {
  console.error(error);
} finally {
  try { execFileSync("tmux", ["kill-server"], { stdio: "ignore" }); } catch { /* The private server may already be stopped. */ }
  await daemon.deps.workflowRuntime?.closeManagedAttempts();
  daemon.db.close(); writable(scratch); rmSync(scratch, { recursive: true, force: true });
  // The daemon's owners keep timers that outlive their teardown; with the scratch tree gone,
  // there is nothing left to wait for.
  process.exit(failed ? 1 : 0);
}
