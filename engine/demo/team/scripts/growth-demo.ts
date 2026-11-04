import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "team-growth-"));
const repository = join(scratch, "repository"), ownerToken = "demo-growth-owner";
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
let failed = true;
try {
  const rig = daemon.deps.rigRepo.createRig("growth-demo", repository);
  for (const id of ["a", "b"]) {
    const node = daemon.deps.rigRepo.addNode(rig.id, id, { role: "implementer", runtime: "claude-code", cwd: repository });
    daemon.deps.sessionRegistry.registerSession(node.id, id + "@growth-demo");
  }
  const start = await api("/runs", { goal: "Implement the first scoped module", seat: "a@growth-demo", writePaths: ["src/a.ts"] });
  const runId = start.runId;
  const read = () => api(`/runs/${runId}/read`);
  const command = async (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId, actionId,
    expectedEntityVersion: (await api(`/runs/${runId}`)).run.entityVersion, idempotencyKey: crypto.randomUUID(), payload });
  const launches = () => daemon.db.prepare("SELECT count(*) AS n FROM events WHERE type='managed.attempt.receipt'").get() as { n: number };
  const waitForLaunches = async (count: number) => {
    const deadline = Date.now() + 60_000;
    while (launches().n < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(launches().n, count, "The newly admitted task must reach the composed dispatch path");
  };
  // A dispatch hands its seat to a launch and returns, so the request that admitted the task
  // does not wait for readiness. Closing the database under a launch still waiting on readiness
  // fails that launch's own bookkeeping, so the demo waits for both seats to settle.
  const settleLaunches = async () => {
    const starting = () => (daemon.db.prepare("SELECT count(*) AS n FROM sessions WHERE startup_status = 'pending'").get() as { n: number }).n;
    const deadline = Date.now() + 60_000;
    while (starting() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(starting(), 0, "Every dispatched seat must settle before the demo tears down");
  };
  await waitForLaunches(1);
  const before = (await read()).read;
  const added = { assignment: { taskId: "task-2", role: "implementer", paths: ["src/b.ts"], dependencies: [] },
    outputs: ["src/b.ts"], destinationSession: "b@growth-demo", body: "Implement the additional scoped module" };
  const edit = await api(`/runs/${runId}/tasks/task-1/edit`);
  await api(`/runs/${runId}/tasks/task-1/edit`, await command("task-1", {
    expectedTaskVersion: edit.task.taskVersion, changes: { addTask: added },
  }));
  writeFileSync(join(repository, "plan.md"), "Implement the first and additional scoped modules.\n");
  const propose = async (id: string) => api(`/runs/${runId}/growth`, await command(id, {
    writePaths: ["src/a.ts", "src/b.ts"], tasks: [added], expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }));
  await propose("rejected-growth");
  assert.equal((await read()).read.tasks.length, 1);
  await api(`/runs/${runId}/approvals/decide`, await command("rejected-growth", { approvalVersion: 1, decision: "rejected" }));
  let state = (await read()).read;
  assert.equal(state.run.state, "invalidated"); assert.equal(state.tasks.length, 1);
  assert.equal(state.run.bindingDigest, before.run.bindingDigest);
  console.log("Rejected approval: binding unchanged, run suspended, added task absent.");
  writeFileSync(join(repository, "plan.md"), "Implement both scoped modules with the owner's clarified acceptance.\n");
  await propose("approved-growth");
  state = (await read()).read;
  assert.equal(state.run.state, "invalidated"); assert.equal(state.tasks.length, 1);
  await api(`/runs/${runId}/approvals/decide`, await command("approved-growth", { approvalVersion: 1, decision: "approved" }));
  await waitForLaunches(2);
  await settleLaunches();
  state = (await read()).read;
  assert.equal(state.run.state, "approved"); assert.equal(state.tasks.length, 2);
  assert.notEqual(state.run.bindingDigest, before.run.bindingDigest);
  assert.equal(state.tasks.find((task: { taskId: string }) => task.taskId === "task-2").queueState, "pending");
  assert.equal(state.run.retriesUsed, before.run.retriesUsed); assert.equal(state.run.reviewRoundsUsed, before.run.reviewRoundsUsed);
  console.log("Approved replacement: exact new binding, two durable tasks, second seat dispatched, counters preserved.");
  console.log("C1 demo passed. Task completion is not claimed by this admission demo.");
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
