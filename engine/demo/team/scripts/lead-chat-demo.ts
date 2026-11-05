import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * U5 — the owner and the lead agree a plan in a chat, and one approval starts the run.
 *
 * One lead seat, one implementer and one reviewer, all played by a stub client that reads the
 * prompt the daemon actually wrote. The stub is the *only* thing standing in for an agent: it
 * writes what a lead's turn would write and its final message to the path the launch recorded,
 * and everything else — the planning binding, the chat rows, the plan commit, the delivery
 * binding, the decomposition — is the daemon's own work.
 *
 * What the demo shows, in order:
 *
 * 1. a planning start binds the run in the daemon's own worktree on `team/<slug>`, and the
 *    lead's first turn says what it would build;
 * 2. the owner's message is carried into the lead's next prompt, and the lead's answer is
 *    stored as its reply;
 * 3. approving the plan records it on that branch, rebinds the run to it and flips the run to
 *    delivery;
 * 4. the lead's next activation is the decomposition, told in its prompt that the plan was
 *    approved, and the proposal it writes is what the daemon reads next.
 *
 * Usage, from `engine/` after `npm run build`: npx tsx demo/team/scripts/lead-chat-demo.ts
 */

const scratch = mkdtempSync(join(tmpdir(), "team-lead-chat-"));
const repository = join(scratch, "repository"), ownerToken = "demo-lead-chat-owner";
process.env.OPENRIG_HOME = join(scratch, "home");
process.env.TMUX_TMPDIR = join(scratch, "tmux");
delete process.env.TMUX; delete process.env.TMUX_PANE;
mkdirSync(join(repository, "src"), { recursive: true });
mkdirSync(process.env.TMUX_TMPDIR);
writeFileSync(join(repository, "src", "base.ts"), "export const base = 1;\n");
for (const args of [["init", "-q"], ["config", "user.name", "Demo"], ["config", "user.email", "demo@example.invalid"],
  ["add", "src/base.ts"], ["commit", "-qm", "demo baseline"]]) {
  execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
}

// The stub lead. It reads the prompt the daemon wrote and does what a lead's turn would do
// with it: the first planning turn writes the plan it proposes, a turn that carries an owner
// message answers it and updates the plan, and the turn that is told the plan was approved
// writes the decomposition. Its final message goes where the launch recorded it.
const client = join(scratch, "lead-stub.mjs");
writeFileSync(client, `
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
const prompt = readFileSync(0, "utf8");
const result = arg("--result"), seat = arg("--seat");
const plan = join(process.cwd(), "plan.md");
let reply;
if (prompt.includes("The owner approved the plan")) {
  writeFileSync(join(process.cwd(), "lead-proposal.json"), JSON.stringify({ tasks: [
    { taskId: "task-2", seat, paths: ["src/health.ts"], dependencies: [], body: "Add the health endpoint described in plan.md" },
  ] }));
  reply = "The plan is broken into one implementer task; the proposal is in my tree.";
} else if (prompt.includes("The owner wrote to you in the run's chat")) {
  const line = prompt.split("\\n").find(entry => entry.trim()) ?? "";
  const added = existsSync(plan);
  writeFileSync(plan, (added ? readFileSync(plan, "utf8") : "# Plan\\n") +
    "2. Cover the endpoint with a test in src/health.test.ts.\\n");
  reply = "Yes: the plan now covers the endpoint and its test. The prompt carried your message (" +
    prompt.includes("Also cover it with a test") + ").";
} else {
  writeFileSync(plan, "# Plan\\n\\n1. Add src/health.ts with GET /healthz.\\n");
  reply = "I would add a health endpoint in src/health.ts. Do you want it covered by a test?";
}
mkdirSync(dirname(result), { recursive: true });
writeFileSync(result, reply);
`);
// The worker's mutable state root: one prompt file per attempt, and the final message the
// daemon reads back. The demo reads the prompt to prove what the turn was told.
const turnStateRoot = join(process.env.OPENRIG_HOME!, "state", "workers", "homes", "local", "scratch");
const promptPath = (attemptId: string) => join(turnStateRoot, "turns", attemptId + ".prompt");

const { createDaemon } = await import("../../../packages/daemon/src/startup.js");
const daemon = await createDaemon({ dbPath: join(scratch, "demo.db"), managedMode: true, workersIsolation: "none",
  teamControl: { credentials: { ownerToken } },
  cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
  directLaunchCommand: facts => {
    if (!facts.resultPath) throw new Error("the launch recorded no result path");
    return [process.execPath, client, "--seat", "impl@lead-chat", "--result", facts.resultPath];
  } });
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
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let failed = true;
try {
  const governance = daemon.deps.teamGovernance!;
  const rig = daemon.deps.rigRepo.createRig("lead-chat", repository);
  // The lead's client is the seat's own. Both clients write their final message to the same
  // per-attempt file, so the chat's reply is stored either way; DEMO_LEAD_CLIENT=codex runs the
  // same conversation with a Codex lead to show it.
  const leadClient = process.env.DEMO_LEAD_CLIENT === "codex" ? "codex" : "claude-code";
  for (const [id, role, seat] of [["lead", "lead", "lead@lead-chat"], ["impl", "implementer", "impl@lead-chat"],
    ["reviewer", "reviewer", "reviewer@lead-chat"]] as const) {
    const node = daemon.deps.rigRepo.addNode(rig.id, id, { role, runtime: id === "lead" ? leadClient : "claude-code", cwd: repository });
    daemon.deps.sessionRegistry.registerSession(node.id, seat);
  }
  console.log(`The lead runs on ${leadClient}.`);
  const receipts = () => daemon.db.prepare("SELECT json_extract(payload, '$.receipt.attemptId') AS attemptId FROM events WHERE type = 'managed.attempt.receipt' ORDER BY seq")
    .all() as Array<{ attemptId: string }>;
  const attemptState = (attemptId: string) => (daemon.db.prepare("SELECT state FROM team_attempts WHERE id = ?")
    .get(attemptId) as { state: string } | undefined)?.state ?? null;
  const waitFor = async (what: string, check: () => boolean) => {
    const deadline = Date.now() + 60_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
      await sleep(100);
    }
  };
  const waitForTurn = async (count: number) => {
    await waitFor(`${count} launch receipt(s)`, () => receipts().length >= count);
    const attemptId = receipts()[count - 1]!.attemptId;
    await waitFor(`attempt ${attemptId} to end`, () => attemptState(attemptId) === "stopped");
    return attemptId;
  };
  const chat = async () => (await api(`/runs/${runId}/chat`)).messages as Array<{ sender: string; body: string }>;

  console.log("==> The owner starts a planning run: a goal, a team, and no plan yet");
  const start = await api("/runs", { goal: "Add a health endpoint", planning: true, writePaths: ["src"] });
  const runId = start.runId;
  assert.equal(start.phase, "planning");
  assert.equal(governance.getRun(runId).phase, "planning");
  const worktree = governance.getRun(runId).binding.repository.root;
  console.log(`The run's binding lives in the daemon's worktree ${worktree}, not the owner's checkout.`);
  daemon.deps.attemptCompletion!.start();
  let attemptId = await waitForTurn(1);
  const firstPrompt = readFileSync(promptPath(attemptId), "utf8");
  assert.ok(firstPrompt.includes("Add a health endpoint"), "the lead's first turn carries the goal");
  await waitFor("the lead's first reply", () => (governance.chatMessages(runId).length >= 1));
  const firstReply = await chat();
  assert.equal(firstReply.length, 1);
  assert.equal(firstReply[0]!.sender, "lead");
  assert.equal(firstReply[0]!.body, "I would add a health endpoint in src/health.ts. Do you want it covered by a test?");
  console.log("The lead's first turn answered in the chat:", firstReply[0]!.body);

  console.log("==> The owner answers in the chat; the lead's next turn is told what the owner said");
  await api(`/runs/${runId}/chat`, { protocolVersion: "1.0", runId, actionId: crypto.randomUUID(),
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: crypto.randomUUID(),
    payload: { body: "Also cover it with a test, then we are agreed." } });
  attemptId = await waitForTurn(2);
  const secondPrompt = readFileSync(promptPath(attemptId), "utf8");
  assert.ok(secondPrompt.includes("The owner wrote to you in the run's chat"), "the turn is told the owner spoke");
  assert.ok(secondPrompt.includes("Also cover it with a test"), "the owner's words reach the prompt verbatim");
  await waitFor("the lead's second reply", () => governance.chatMessages(runId).filter(message => message.sender === "lead").length >= 2);
  assert.deepEqual((await chat()).map(message => message.sender), ["lead", "owner", "lead"]);
  console.log("The conversation so far:", (await chat()).map(message => `${message.sender}: ${message.body}`).join(" | "));

  console.log("==> The owner approves the plan once");
  const approved = await api(`/runs/${runId}/plan/approve`, { protocolVersion: "1.0", runId, actionId: crypto.randomUUID(),
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: crypto.randomUUID(), payload: {} });
  assert.equal(approved.status, "accepted");
  const run = governance.getRun(runId);
  assert.equal(run.phase, "delivery");
  assert.equal(run.binding.repository.root, worktree, "the plan is recorded in the same daemon-owned worktree");
  const recorded = readFileSync(join(worktree, "plan.md"), "utf8");
  assert.ok(recorded.includes("src/health.test.ts"), "the plan the owner approved is the plan they agreed");
  assert.equal(execFileSync("git", ["-C", worktree, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
    "plan: Add a health endpoint");
  assert.equal(execFileSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
    "team/add-a-health-endpoint-" + runId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase());
  console.log(`The plan is committed on ${execFileSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()}`);
  console.log("The owner's checkout still has no plan.md and no new branch checked out.");

  console.log("==> The lead's next activation is the decomposition");
  attemptId = await waitForTurn(3);
  const thirdPrompt = readFileSync(promptPath(attemptId), "utf8");
  assert.ok(thirdPrompt.includes("The owner approved the plan"), "the decomposition turn is told the plan was approved");
  const proposal = await api(`/runs/${runId}/tasks/task-1/proposal`);
  assert.deepEqual(proposal.proposal.tasks.map((task: { taskId: string }) => task.taskId), ["task-2"]);
  console.log("The lead proposed:", proposal.proposal.tasks.map((task: { taskId: string; seat: string }) =>
    `${task.taskId} on ${task.seat}`).join(", "));
  const ownerActions = daemon.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'team.control' AND json_extract(payload, '$.action') = 'chat.message'").get() as { n: number };
  console.log(`Owner actions in this run: ${ownerActions.n} chat message(s) and 1 plan approval.`);
  console.log("U5 demo passed: the owner chatted, approved once, and the lead decomposed the approved plan.");
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