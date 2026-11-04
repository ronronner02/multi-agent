import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * T033 — a failed attempt is classified once, and the owner's retry obeys that classification.
 *
 * KTD20 gives every failed attempt one reason code, and only five codes may be retried. This
 * demo shows both halves against a client that really fails: the client prints a provider error
 * and exits, the daemon's own sweep observes the process end and records the classification
 * with the stop, and the owner's retry reads that record rather than deciding anything itself.
 *
 *  - **A network failure is retryable.** The owner retries once, which spends `maxRetries`; a
 *    second retry is refused because the budget is gone.
 *  - **An auth failure is not.** The retry is refused, and the refusal names the owner action.
 *
 * Nothing here records an attempt, a failure or an outcome by hand: the attempt is admitted from
 * the launch receipt, the failure is the client's own output and exit status, and the outcome is
 * the owner's one action over evidence the daemon computed. Everything is real except the native
 * client, and the scratch home, database and tmux socket are this process's own.
 *
 * Usage, from `engine/` after `npm run build`: npx tsx demo/team/scripts/failure-demo.ts
 */

const scratch = mkdtempSync(join(tmpdir(), "team-failure-"));
const repository = join(scratch, "repository"), ownerToken = "demo-failure-owner";
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
const failing = new URL("./failing-client.mjs", import.meta.url).pathname;
/** Which failure the next launch prints: a refused connection, or a rejected key. */
let failure = "network";
const daemon = await createDaemon({ dbPath: join(scratch, "demo.db"), managedMode: true, workersIsolation: "none",
  teamControl: { credentials: { ownerToken } },
  cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
  directLaunchCommand: facts => [process.execPath, failing, "--session-name", facts.taskId,
    "--cwd", facts.tree, "--launch-id", facts.attemptId, "--failure", failure],
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
let failed = true;
try {
  const governance = daemon.deps.teamGovernance!;
  const rig = daemon.deps.rigRepo.createRig("failure-demo", repository);
  const seats: Record<string, string> = { network: "net@failure-demo", auth: "auth@failure-demo" };
  for (const [kind, seat] of Object.entries(seats)) {
    const node = daemon.deps.rigRepo.addNode(rig.id, kind, { role: "implementer", runtime: "claude-code", cwd: repository });
    daemon.deps.sessionRegistry.registerSession(node.id, seat);
  }
  const runVersion = async (runId: string) => (await api(`/runs/${runId}`)).body.run as { entityVersion: number };
  const command = async (runId: string, actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId,
    actionId, expectedEntityVersion: (await runVersion(runId)).entityVersion, idempotencyKey: crypto.randomUUID(), payload });
  const attemptsOf = (runId: string) => daemon.db.prepare(
    "SELECT id, state, failure_json AS failureJson FROM team_attempts WHERE run_id = ? ORDER BY rowid")
    .all(runId) as Array<{ id: string; state: string; failureJson: string | null }>;
  /** Wait until the daemon's sweep has observed the launched client end and recorded its stop. */
  const waitForStop = async (runId: string, attemptId: string) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const attempt = attemptsOf(runId).find(row => row.id === attemptId);
      if (attempt?.state === "stopped") return attempt;
      if (Date.now() > deadline) assert.fail(`the daemon must observe attempt ${attemptId} stop (holds ${attempt?.state ?? "none"})`);
      await sleep(100);
    }
  };
  const waitForAttempt = async (runId: string) => {
    const deadline = Date.now() + 60_000;
    while (!attemptsOf(runId).length && Date.now() < deadline) await sleep(100);
    const attempt = attemptsOf(runId)[0];
    assert.ok(attempt, "the launch must be admitted as an attempt");
    return attempt;
  };
  /** The owner's one action over evidence the daemon computed, exactly as `rig team done` sends it. */
  const complete = async (runId: string, taskId: string) => {
    const read = await api(`/runs/${runId}/tasks/${taskId}/completion`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const { completion } = read.body as { completion: {
      taskVersion: number; actorSession: string; attempt: { attemptId: string; entityVersion: number };
      evidence: Record<string, unknown> } };
    const qitemId = governance.findTask(runId, taskId)!.qitemId;
    return api(`/runs/${runId}/tasks/outcome`, await command(runId, qitemId, {
      expectedTaskVersion: completion.taskVersion, state: "failed", actorSession: completion.actorSession,
      attemptId: completion.attempt.attemptId, expectedAttemptVersion: completion.attempt.entityVersion,
      evidence: completion.evidence,
    }));
  };
  const retry = async (runId: string, taskId: string) => {
    const qitemId = governance.findTask(runId, taskId)!.qitemId;
    const attempt = governance.getLatestTaskAttempt(qitemId)!;
    return api(`/runs/${runId}/tasks/retry`, await command(runId, qitemId, {
      expectedTaskVersion: governance.getTask(qitemId)!.entityVersion,
      attemptId: attempt.id, expectedAttemptVersion: attempt.entityVersion,
    }));
  };
  daemon.deps.attemptCompletion!.start();

  console.log("==> A client fails with a refused connection; the daemon classifies the attempt once");
  const network = await api("/runs", { goal: "Implement the first scoped module", seat: seats.network, writePaths: ["src/a.ts"] });
  const networkRun = network.body.runId as string;
  const networkAttempt = await waitForAttempt(networkRun);
  const networkStop = await waitForStop(networkRun, networkAttempt.id);
  const recorded = JSON.parse(networkStop.failureJson ?? "null") as
    { reasonCode: string; resumeSafe: boolean; retryEligible: boolean; ownerAction: string } | null;
  assert.ok(recorded, "the stopped attempt must carry its classification");
  assert.equal(recorded.reasonCode, "agent_error.provider_network");
  assert.equal(recorded.retryEligible, true);
  assert.equal(recorded.resumeSafe, true);
  console.log(`Attempt ${networkAttempt.id} stopped: ${recorded.reasonCode}, retry eligible, resume safe.`);

  console.log("==> The owner marks it failed and retries: one retry, and the budget is spent");
  const failedOutcome = await complete(networkRun, "task-1");
  assert.equal(failedOutcome.status, 200, JSON.stringify(failedOutcome.body));
  const first = await retry(networkRun, "task-1");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, "accepted");
  const run = governance.getRun(networkRun);
  assert.equal(run.retriesUsed, 1, "an eligible retry spends exactly one retry");
  assert.equal(governance.queueState(governance.findTask(networkRun, "task-1")!.qitemId), "pending");
  console.log(`Retry accepted; retriesUsed=${run.retriesUsed} of maxRetries=${run.binding.limits.maxRetries}.`);

  console.log("==> The retried task runs again and fails again: the budget is what stops it");
  // Nothing retries by itself: the owner's retry reopened the task, and the same composed
  // dispatch a start uses is what launches it again.
  await daemon.deps.teamControl!.dispatch!(networkRun, "task-1");
  const deadline = Date.now() + 60_000;
  while (attemptsOf(networkRun).length < 2 && Date.now() < deadline) await sleep(100);
  assert.equal(attemptsOf(networkRun).length, 2, "the retried task must get its own attempt");
  const retried = attemptsOf(networkRun)[1]!;
  const retriedStop = await waitForStop(networkRun, retried.id);
  const retriedFailure = JSON.parse(retriedStop.failureJson ?? "null") as typeof recorded;
  assert.equal(retriedFailure?.reasonCode, "agent_error.provider_network", "the second failure is classified the same way");
  const retriedOutcome = await complete(networkRun, "task-1");
  assert.equal(retriedOutcome.status, 200, JSON.stringify(retriedOutcome.body));
  const second = await retry(networkRun, "task-1");
  assert.equal(second.status, 403, JSON.stringify(second.body));
  assert.match(String(second.body.reason), /Retry limit exhausted/);
  assert.equal(governance.getRun(networkRun).retriesUsed, 1);
  assert.equal(governance.queueState(governance.findTask(networkRun, "task-1")!.qitemId), "failed",
    "an exhausted retry leaves the task failed, with no third attempt");
  console.log(`Second failure classified too; retry refused: ${second.body.reason}`);

  console.log("==> A client fails with a rejected key: the attempt is classified, and not retried");
  failure = "auth";
  const auth = await api("/runs", { goal: "Implement the first scoped module again", seat: seats.auth, writePaths: ["src/a.ts"] });
  const authRun = auth.body.runId as string;
  const authAttempt = await waitForAttempt(authRun);
  const authStop = await waitForStop(authRun, authAttempt.id);
  const authFailure = JSON.parse(authStop.failureJson ?? "null") as typeof recorded;
  assert.ok(authFailure, "the stopped attempt must carry its classification");
  assert.equal(authFailure.reasonCode, "agent_error.provider_auth_or_access");
  assert.equal(authFailure.retryEligible, false);
  console.log(`Attempt ${authAttempt.id} stopped: ${authFailure.reasonCode}, not retryable.`);

  const authOutcome = await complete(authRun, "task-1");
  assert.equal(authOutcome.status, 200, JSON.stringify(authOutcome.body));
  const refused = await retry(authRun, "task-1");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.status, "denied");
  assert.match(String(refused.body.reason), /agent_error\.provider_auth_or_access/);
  assert.match(String(refused.body.reason), new RegExp(authFailure.ownerAction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(governance.getRun(authRun).retriesUsed, 0, "an ineligible failure spends no retry");
  assert.equal(governance.queueState(governance.findTask(authRun, "task-1")!.qitemId), "failed", "the task stays failed");
  console.log(`Retry refused with the owner action: ${refused.body.reason}`);

  console.log("==> The owner read shows the code and the owner action for each failed attempt");
  const read = (await api(`/runs/${authRun}/read`)).body.read as { attempts: Array<{
    attemptId: string; failure: typeof recorded }> };
  const published = read.attempts.find(attempt => attempt.attemptId === authAttempt.id)?.failure;
  assert.ok(published, "the owner read must publish the recorded classification");
  assert.equal(published.reasonCode, "agent_error.provider_auth_or_access");
  assert.equal(published.ownerAction, authFailure.ownerAction);
  console.log(`Tasks screen evidence: ${published.reasonCode} — ${published.ownerAction}`);

  console.log("Failure demo passed. The retry obeyed the one classification; no attempt was added by hand.");
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
