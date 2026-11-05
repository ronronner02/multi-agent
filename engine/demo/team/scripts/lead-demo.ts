import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * U6 — the lead runs the team from plan approval to every task done.
 *
 * One Claude-shaped lead, two implementers and one reviewer, all played by a stub client that
 * reads the prompt the daemon actually wrote. The owner does three things in the whole run: send
 * one chat message while planning, approve the plan once, and answer one decision the lead asked
 * for. Everything else is the daemon's: the decomposition is admitted with no approval row, the
 * attempts and outcomes are observed, the reviews are recorded, and the lead is woken when its
 * team finishes.
 *
 * What the demo shows, in order:
 *
 * 1. a planning run: the lead proposes a plan, the owner adds one requirement, the plan is agreed;
 * 2. the owner approves the plan once, and the lead's next turn writes its task list;
 * 3. the list is admitted with no owner decision, and its tasks run, complete and review
 *    themselves through the existing loop;
 * 4. every task done wakes the lead once, and it asks the owner the one question only they can
 *    answer; the answer is the lead's next prompt and its last word is a status for the owner.
 *
 * Usage, from `engine/` after `npm run build`: npx tsx demo/team/scripts/lead-demo.ts
 */

const scratch = mkdtempSync(join(tmpdir(), "team-lead-manager-"));
const repository = join(scratch, "repository"), ownerToken = "demo-lead-manager-owner";
process.env.OPENRIG_HOME = join(scratch, "home");
process.env.TMUX_TMPDIR = join(scratch, "tmux");
delete process.env.TMUX; delete process.env.TMUX_PANE;
mkdirSync(join(repository, "src"), { recursive: true });
mkdirSync(process.env.TMUX_TMPDIR);
writeFileSync(join(repository, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(repository, "src/b.ts"), "export const b = 1;\n");
for (const args of [["init", "-q"], ["config", "user.name", "Demo"], ["config", "user.email", "demo@example.invalid"],
  ["add", "src/a.ts", "src/b.ts"], ["commit", "-qm", "demo baseline"]]) {
  execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
}

// The stub client. It reads the prompt and the instruction files the daemon wrote, and does
// what that turn exists to do: plan, answer the owner, decompose, implement, review, or ask the
// one question only the owner can answer. Its final message goes where the launch recorded it.
const client = join(scratch, "agent-stub.mjs");
writeFileSync(client, `
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
const prompt = readFileSync(arg("--prompt"), "utf8");
const task = arg("--task"), result = arg("--result");
// The prompt names the read-only instruction files this attempt must read; a lead's role and
// run instructions live there, not in the prompt text.
const instructions = prompt.split("\\n").filter((line) => line.startsWith("- "))
  .map((line) => line.slice(2).trim()).filter((path) => existsSync(path))
  .map((path) => readFileSync(path, "utf8")).join("\\n");
const cwd = process.cwd();
let reply;
const say = (text) => { reply = text; };
const write = (name, value) => writeFileSync(join(cwd, name), typeof value === "string" ? value : JSON.stringify(value, null, 1) + "\\n");

if (prompt.includes("Since your last turn:")) {
  // A team event. Every task is done, and the only open question is one the owner must decide.
  write("lead-escalation.json", {
    question: "The plan is delivered. Should the run also add a test module?",
    options: ["Add a test task", "Merge the branch as it is"],
    context: "A test module is outside the plan you approved, so adding it is your decision, not mine.",
  });
  say("I need one decision from you before I close this out.");
} else if (prompt.includes("The owner wrote to you in the run's chat:")) {
  if (prompt.includes("Merge the branch as it is")) {
    say("Understood. Both modules are done and reviewed, and the branch is ready for you to merge.");
  } else {
    // The owner's planning message: it changes the plan, so the plan file changes with it.
    write("plan.md", readFileSync(join(cwd, "plan.md"), "utf8") +
      "\\n3. Cover src/a.ts with a test in src/a.test.ts.\\n");
    say("Agreed. The plan now covers the two modules and a test for src/a.ts.");
  }
} else if (instructions.includes("You are planning with the owner")) {
  write("plan.md", "# Plan\\n\\n1. Implement src/a.ts.\\n2. Implement src/b.ts.\\n");
  say("I would implement src/a.ts and src/b.ts, one task each. Do you want a test module as well?");
} else if (task.includes("-review-")) {
  say("Reviewed the candidate.\\n\\n\\u0060\\u0060\\u0060json\\n{\\"findings\\": []}\\n\\u0060\\u0060\\u0060\\n");
} else if (instructions.includes("admitted without the owner")) {
  write("lead-proposal.json", { tasks: [
    { taskId: "task-2", seat: "a@lead-demo", paths: ["src/a.ts"], dependencies: [], body: "Implement the first scoped module" },
    { taskId: "task-3", seat: "b@lead-demo", paths: ["src/b.ts"], dependencies: [], body: "Implement the second scoped module" },
  ] });
  say("The plan is broken into two implementer tasks; the list is in my tree.");
} else if (task === "task-2") {
  write("src/a.ts", "export const a = 2;\\n");
  say("Implemented src/a.ts.");
} else if (task === "task-3") {
  write("src/b.ts", "export const b = 2;\\n");
  say("Implemented src/b.ts.");
} else {
  throw new Error("the stub has no turn for task " + task);
}
mkdirSync(dirname(result), { recursive: true });
writeFileSync(result, reply);
`);

const { createDaemon } = await import("../../../packages/daemon/src/startup.js");
const daemon = await createDaemon({ dbPath: join(scratch, "demo.db"), managedMode: true, workersIsolation: "none",
  teamControl: { credentials: { ownerToken } },
  cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
  directLaunchCommand: facts => {
    if (!facts.resultPath || !facts.promptPath) throw new Error("the launch recorded no prompt or result path");
    return [process.execPath, client, "--task", facts.taskId, "--prompt", facts.promptPath, "--result", facts.resultPath];
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
const turnStateRoot = join(process.env.OPENRIG_HOME!, "state", "workers", "homes", "local", "scratch");
const promptOf = (attemptId: string) => readFileSync(join(turnStateRoot, "turns", attemptId + ".prompt"), "utf8");
let failed = true;
try {
  const governance = daemon.deps.teamGovernance!;
  const rig = daemon.deps.rigRepo.createRig("lead-demo", repository);
  for (const [id, role, seat] of [["lead", "lead", "lead@lead-demo"], ["impl-a", "implementer", "a@lead-demo"],
    ["impl-b", "implementer", "b@lead-demo"], ["reviewer", "reviewer", "reviewer@lead-demo"]] as const) {
    const node = daemon.deps.rigRepo.addNode(rig.id, id, { role, runtime: "claude-code", cwd: repository });
    daemon.deps.sessionRegistry.registerSession(node.id, seat);
  }
  let runId = "";
  const command = async (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId,
    actionId, expectedEntityVersion: governance.getRun(runId).entityVersion,
    idempotencyKey: crypto.randomUUID(), payload });
  const waitFor = async (what: string, check: () => boolean) => {
    const deadline = Date.now() + 120_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
      await sleep(100);
    }
  };
  const qitem = (taskId: string) => governance.findTask(runId, taskId)!.qitemId;
  const attemptsOf = (taskId: string) => daemon.db.prepare("SELECT id, state FROM team_attempts WHERE qitem_id = ? ORDER BY rowid")
    .all(qitem(taskId)) as Array<{ id: string; state: string }>;
  /** Wait for a task's nth turn to end, and return the attempt the daemon observed. */
  const waitTurn = async (taskId: string, count: number) => {
    await waitFor(`${count} turn(s) of ${taskId}`, () => attemptsOf(taskId).length >= count);
    await waitFor(`${taskId}'s turn ${count} to end`, () => attemptsOf(taskId)[count - 1]!.state === "stopped");
    return attemptsOf(taskId)[count - 1]!.id;
  };
  const chat = async () => (await api(`/runs/${runId}/chat`)) as { phase: string;
    messages: Array<{ id: string; sender: string; kind: string; body: string; options: string[] | null;
      answeredBy: string | null }>; pendingDecision: { id: string; body: string; options: string[] } | null };
  const queueState = (taskId: string) => governance.queueState(qitem(taskId));
  const approvalRows = (action: string) => (daemon.db.prepare("SELECT count(*) AS n FROM team_approvals WHERE run_id = ? AND action = ?")
    .get(runId, action) as { n: number }).n;

  console.log("==> The owner starts a planning run and the lead proposes a plan");
  const start = await api("/runs", { goal: "Ship the two scoped modules", planning: true, writePaths: ["src"] });
  runId = start.runId;
  assert.equal(start.phase, "planning");
  daemon.deps.attemptCompletion!.start();
  await waitTurn("task-1", 1);
  const leadTree = daemon.deps.workflowRuntime!.assignedTreeFor(runId, { taskId: "task-1" });
  await waitFor("the lead's first reply", () => governance.chatMessages(runId).length >= 1);
  let conversation = await chat();
  assert.equal(conversation.messages[0]!.sender, "lead");
  assert.match(conversation.messages[0]!.body, /test module/);
  assert.match(readFileSync(join(leadTree, "plan.md"), "utf8"), /src\/a\.ts/);
  console.log("The lead's first turn proposed a plan:", conversation.messages[0]!.body);

  console.log("==> The owner adds one requirement in the chat, and the plan is agreed");
  await api(`/runs/${runId}/chat`, await command("chat-plan", { body: "Cover src/a.ts with a test, then we are agreed." }));
  const planningTurn = await waitTurn("task-1", 2);
  assert.match(promptOf(planningTurn), /Cover src\/a\.ts with a test/);
  await waitFor("the lead's answer", () => governance.chatMessages(runId).filter(message => message.sender === "lead").length >= 2);
  assert.match(readFileSync(join(leadTree, "plan.md"), "utf8"), /src\/a\.test\.ts/);

  console.log("==> The owner approves the plan once");
  const approved = await api(`/runs/${runId}/plan/approve`, await command("approve-plan", {}));
  assert.equal(approved.status, "accepted");
  assert.equal(governance.getRun(runId).phase, "delivery");
  const decompositionTurn = await waitTurn("task-1", 3);
  assert.match(promptOf(decompositionTurn), /The owner approved the plan/);

  console.log("==> The lead's task list is admitted with no owner decision");
  await waitFor("the lead's tasks", () => governance.findTask(runId, "task-2") !== null && governance.findTask(runId, "task-3") !== null);
  // Nothing was recorded for the owner to approve: the batch is inside the binding they approved.
  assert.equal(approvalRows("scope-change"), 0, "the lead's decomposition must not become an owner decision");
  console.log("Admitted:", ["task-2", "task-3"].map(taskId => governance.findTask(runId, taskId)!.assignment.taskId).join(", "));

  console.log("==> Both tasks run, complete on the daemon's evidence, and review themselves");
  for (const taskId of ["task-2", "task-3"]) {
    await waitTurn(taskId, 1);
    await waitFor(`${taskId} to be recorded done`, () => queueState(taskId) === "done");
  }
  const reviewerTasks = ["task-2-review-1", "task-3-review-1"];
  await waitFor("both review tasks", () => reviewerTasks.every(taskId => governance.findTask(runId, taskId) !== null));
  for (const taskId of reviewerTasks) {
    await waitTurn(taskId, 1);
    await waitFor(`${taskId} to be recorded`, () => queueState(taskId) === "done");
  }
  assert.ok(readFileSync(join(daemon.deps.workflowRuntime!.assignedTreeFor(runId, { taskId: "task-2" }), "src/a.ts"), "utf8")
    .includes("export const a = 2;"), "the implementer's candidate holds the delivered change");
  console.log("Both implementer tasks are done after an approving review, with no owner action.");

  console.log("==> Every task done wakes the lead, and it asks the one question only the owner can answer");
  await waitFor("the lead's decision", () => governance.chatDecision(runId) !== null);
  const wakeTurn = await waitTurn("task-1", 4);
  assert.match(promptOf(wakeTurn), /Every task is done/);
  conversation = await chat();
  const decision = conversation.pendingDecision!;
  assert.deepEqual(decision.options, ["Add a test task", "Merge the branch as it is"]);
  assert.match(decision.body, /Should the run also add a test module\?/);
  console.log("The lead escalated:", decision.body.split("\n")[0]);

  console.log("==> The owner answers the decision through the chat");
  await api(`/runs/${runId}/chat`, await command("chat-answer", { body: "Merge the branch as it is", answerTo: decision.id }));
  const answerTurn = await waitTurn("task-1", 5);
  assert.match(promptOf(answerTurn), /Merge the branch as it is/);
  await waitFor("the lead's closing message", () => governance.chatMessages(runId).filter(message => message.sender === "lead").length >= 4);
  conversation = await chat();
  assert.equal(conversation.pendingDecision, null, "the answered decision is no longer pending");
  const closing = conversation.messages.at(-1)!;
  assert.equal(closing.sender, "lead");
  assert.match(closing.body, /ready for you to merge/);
  console.log("The lead's closing message:", closing.body);

  // The whole run, counted: one planning message, one plan approval and one decision answer.
  const ownerMessages = conversation.messages.filter(message => message.sender === "owner").length;
  const planApprovals = (daemon.db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'team.control'
    AND json_extract(payload, '$.action') = 'plan.approved' AND json_extract(payload, '$.runId') = ?`).get(runId) as { n: number }).n;
  const wakes = (daemon.db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'team.control'
    AND json_extract(payload, '$.action') = 'lead.woken' AND json_extract(payload, '$.runId') = ?`).get(runId) as { n: number }).n;
  assert.equal(wakes, 1, "the lead is woken once for the team's events, not once per sweep");
  assert.equal(ownerMessages, 2, "one planning message and one answered decision");
  assert.equal(planApprovals, 1);
  console.log(`Owner actions in this run: ${ownerMessages} chat messages, ${planApprovals} plan approval, 0 other decisions.`);
  console.log("U6 demo passed: the lead decomposed, ran and reviewed the plan with no owner decision, and asked only what it could not decide.");
  failed = false;
} catch (error) {
  // A launch that never reached the receipt path is a startup failure the demo cannot explain
  // from the outside; say what the daemon's own rows hold so a broken seat is not mistaken for
  // a slow one.
  try {
    const rows = daemon.db.prepare(`SELECT s.session_name AS seat, s.startup_status AS status,
        (SELECT q.state FROM queue_items q JOIN team_queue_authority a ON a.qitem_id = q.qitem_id
          WHERE a.task_id = 'task-1') AS leadTask
      FROM sessions s WHERE s.session_name = 'lead@lead-demo'`).all();
    const failures = daemon.db.prepare(`SELECT json_extract(payload, '$.error') AS error FROM events
      WHERE type = 'node.startup_failed' ORDER BY seq DESC LIMIT 3`).all();
    console.error("lead seat:", JSON.stringify(rows), "startup failures:", JSON.stringify(failures));
  } catch { /* the database may already be unusable; the original error is the report */ }
  console.error(error);
} finally {
  daemon.deps.attemptCompletion?.stop();
  try { execFileSync("tmux", ["kill-server"], { stdio: "ignore" }); } catch { /* The private server may already be stopped. */ }
  await daemon.deps.workflowRuntime?.closeManagedAttempts();
  daemon.db.close(); writable(scratch); rmSync(scratch, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}