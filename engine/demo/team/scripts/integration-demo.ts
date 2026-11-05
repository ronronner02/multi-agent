import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * U7 / KTD7 — approved work lands on the run's branch, and the owner merges it once.
 *
 * One planning run, one lead, two implementer seats and one reviewer, all played by a stub
 * client. The stubs are the only thing standing in for an agent: they read the prompt the
 * daemon actually wrote and do what a turn would do — the lead agrees a plan and then writes
 * its decomposition, each implementer edits its own file in its own candidate tree, and the
 * reviewer answers with a findings block. Everything else is the daemon's own work: the launch,
 * the attempt observation, the candidate manifest, the review round, the outcome, and the
 * commit that lands on `team/<slug>`.
 *
 * What the demo shows, in order:
 *
 * 1. the owner approves the plan once, and the lead decomposes it into two tasks;
 * 2. each task's approved review lands one commit on the run's branch, in the daemon's
 *    worktree, and the owner's checkout is untouched while that happens;
 * 3. `rig team merge <run>` — the compiled CLI against this demo daemon — fast-forwards the
 *    owner's `main` to the branch, so both files are in the scratch repository;
 * 4. a second `rig team merge` says the branch is already up to date.
 *
 * Usage, from `engine/` after `npm run build`: npx tsx demo/team/scripts/integration-demo.ts
 */

const scratch = mkdtempSync(join(tmpdir(), "team-integration-"));
const repository = join(scratch, "repository"), ownerToken = "demo-integration-owner";
process.env.OPENRIG_HOME = join(scratch, "home");
process.env.TMUX_TMPDIR = join(scratch, "tmux");
delete process.env.TMUX; delete process.env.TMUX_PANE;
mkdirSync(join(repository, "src"), { recursive: true });
mkdirSync(process.env.TMUX_TMPDIR);
writeFileSync(join(repository, "src", "base.ts"), "export const base = 1;\n");
for (const args of [["init", "-q", "--initial-branch=main"], ["config", "user.name", "Demo"], ["config", "user.email", "demo@example.invalid"],
  ["add", "src/base.ts"], ["commit", "-qm", "demo baseline"]]) {
  execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
}

// The one stub client every seat runs. What it does is decided by the task the launch names:
// the lead writes the plan and then the decomposition, each implementer edits its own file, and
// every review answers with a findings block the daemon records as the round's verdict.
const client = join(scratch, "team-stub.mjs");
writeFileSync(client, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
const taskId = arg("--task"), result = arg("--result");
const prompt = readFileSync(0, "utf8");
const reply = (message) => { mkdirSync(dirname(result), { recursive: true }); writeFileSync(result, message); };
if (taskId === "task-1") {
  if (prompt.includes("The owner approved the plan")) {
    writeFileSync("lead-proposal.json", JSON.stringify({ tasks: [
      { taskId: "task-2", seat: "impl-a@integration-demo", paths: ["src/health.ts"], dependencies: [], body: "Add the health endpoint" },
      { taskId: "task-3", seat: "impl-b@integration-demo", paths: ["src/metrics.ts"], dependencies: [], body: "Add the metrics hook" },
    ] }));
    reply("The plan is two tasks, each on its own implementer seat.");
  } else {
    writeFileSync("plan.md", "# Plan\\n\\n1. Add src/health.ts with GET /healthz.\\n2. Add src/metrics.ts with a counter hook.\\n");
    reply("Two independent modules: the health endpoint and the metrics hook.");
  }
} else if (taskId === "task-2") {
  writeFileSync(join("src", "health.ts"), "export const health = () => ({ status: 'ok' });\\n");
  reply("The health endpoint is in src/health.ts.");
} else if (taskId === "task-3") {
  writeFileSync(join("src", "metrics.ts"), "export const metrics = { requests: 0 };\\n");
  reply("The metrics hook is in src/metrics.ts.");
} else {
  reply("\`\`\`json\\n" + JSON.stringify({ findings: [] }) + "\\n\`\`\`\\n");
}
`);

const { createDaemon } = await import("../../../packages/daemon/src/startup.js");
const daemon = await createDaemon({ dbPath: join(scratch, "demo.db"), managedMode: true, workersIsolation: "none",
  teamControl: { credentials: { ownerToken } },
  cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
  directLaunchCommand: facts => [process.execPath, client, "--task", facts.taskId,
    "--launch", facts.attemptId, "--result", facts.resultPath ?? ""] });

async function api(path: string, payload?: unknown) {
  const response = await daemon.app.fetch(new Request("http://127.0.0.1/api/team-control" + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + ownerToken, "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const result = await response.json() as Record<string, unknown>;
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
let server: ReturnType<typeof createServer> | undefined;
try {
  const governance = daemon.deps.teamGovernance!;
  const rig = daemon.deps.rigRepo.createRig("integration-demo", repository);
  for (const [id, role, seat] of [["lead", "lead", "lead@integration-demo"],
    ["impl-a", "implementer", "impl-a@integration-demo"], ["impl-b", "implementer", "impl-b@integration-demo"],
    ["reviewer", "reviewer", "review@integration-demo"]] as const) {
    const node = daemon.deps.rigRepo.addNode(rig.id, id, { role, runtime: "claude-code", cwd: repository });
    daemon.deps.sessionRegistry.registerSession(node.id, seat);
  }
  const waitFor = async (what: string, check: () => boolean | Promise<boolean>, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
      await sleep(100);
    }
  };
  const integration = async () => (await api(`/runs/${runId}/integration`)).integration as {
    branch: string; worktree: string; commits: Array<{ hash: string; subject: string; task: string }>; merge: { possible: boolean } };

  console.log("==> The owner starts a planning run for a scratch repository");
  const start = await api("/runs", { goal: "Add a health endpoint and a metrics hook", planning: true, writePaths: ["src"] });
  const runId = start.runId as string;
  assert.equal(start.phase, "planning");
  daemon.deps.attemptCompletion!.start();

  console.log("==> The owner approves the plan once");
  await waitFor("the lead's first reply", () => governance.chatMessages(runId).some(message => message.sender === "lead"));
  await api(`/runs/${runId}/plan/approve`, { protocolVersion: "1.0", runId, actionId: crypto.randomUUID(),
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: crypto.randomUUID(), payload: {} });
  assert.equal(governance.getRun(runId).phase, "delivery");

  console.log("==> The lead decomposes the approved plan into two tasks");
  await waitFor("the lead's proposal", () => {
    try { return daemon.deps.workflowRuntime!.leadProposalFor(runId, "task-1").length === 2; } catch { return false; }
  });
  const proposal = await api(`/runs/${runId}/tasks/task-1/proposal`, { protocolVersion: "1.0", runId, actionId: "task-1",
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: crypto.randomUUID(),
    // The daemon re-reads the batch from the lead's own tree and needs only the window the
    // decision is held under. An empty payload is refused as a malformed request.
    payload: { leadProposal: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() } } });
  assert.equal(proposal.status, "accepted");
  const pending = (await api(`/runs/${runId}/approvals`)).approvals as Array<{ id: string; entityVersion: number;
    action: string; state: string }>;
  const batch = pending.find(approval => approval.state === "pending" && approval.action === "scope-change")!;
  assert.ok(batch, "the lead's batch is a pending owner decision");
  await api(`/runs/${runId}/approvals/decide`, { protocolVersion: "1.0", runId, actionId: batch.id,
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: crypto.randomUUID(),
    payload: { approvalVersion: batch.entityVersion, decision: "approved" } });
  console.log("The two tasks are admitted and dispatched to their implementer seats.");

  console.log("==> Each review approves, and each approval lands one commit on the run's branch");
  const ownerHead = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await waitFor("two landed commits", async () => (await integration()).commits.length === 2);
  const landed = await integration();
  console.log(`Branch ${landed.branch} in ${landed.worktree}`);
  for (const commit of landed.commits) console.log(`  ${commit.hash}  ${commit.subject}  (${commit.task})`);
  assert.deepEqual(landed.commits.map(commit => commit.task).sort(), ["task-2", "task-3"],
    "each approved task landed as its own commit");
  assert.equal(execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), ownerHead,
    "the owner's checkout did not move while the work landed");
  assert.equal(execFileSync("git", ["-C", repository, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(), "main");
  console.log("The owner's checkout still has neither file, and is still on main.");

  console.log("==> rig team merge (the compiled CLI, against this demo daemon)");
  // The demo's daemon answers through the app; the CLI needs a URL, so one private server
  // forwards to the same app — the product's own transport, no second code path.
  const port = await new Promise<number>(resolve => {
    server = createServer(async (request, response) => {
      const body = await new Promise<string>(done => { let data = ""; request.on("data", chunk => { data += chunk; });
        request.on("end", () => done(data)); });
      const answer = await daemon.app.fetch(new Request(new URL(request.url ?? "/", `http://127.0.0.1:${port}`), {
        method: request.method, headers: request.headers as HeadersInit, ...(body ? { body } : {}) }),
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    }).listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
  });
  const cli = new URL("../../../packages/cli/dist/bin-wrapper.js", import.meta.url).pathname;
  const runCli = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [cli, ...args],
      { encoding: "utf8", env: { ...process.env, OPENRIG_URL: `http://127.0.0.1:${port}`, MULTI_AGENT_OWNER_TOKEN: ownerToken } },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
        resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr });
      });
  });
  const merge = await runCli(["team", "merge", runId]);
  process.stdout.write(merge.stdout);
  if (merge.code !== 0) throw new Error("rig team merge failed: " + merge.stderr);
  const bothFiles = execFileSync("git", ["-C", repository, "log", "--format=", "--name-only", "HEAD~2..HEAD"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(bothFiles, ["src/health.ts", "src/metrics.ts"]);
  assert.equal(execFileSync("git", ["-C", repository, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(), "main");
  assert.equal(execFileSync("git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=no"], { encoding: "utf8" }).trim(), "");

  const again = await runCli(["team", "merge", runId]);
  assert.equal(again.code, 0, again.stderr);
  console.log(again.stdout.trim());
  assert.match(again.stdout, /already up to date/);
  console.log("U7 demo passed: two approvals, two commits on the branch, and one owner merge.");
  failed = false;
} catch (error) {
  console.error(error);
} finally {
  daemon.deps.attemptCompletion?.stop();
  server?.close();
  try { execFileSync("tmux", ["kill-server"], { stdio: "ignore" }); } catch { /* The private server may already be stopped. */ }
  await daemon.deps.workflowRuntime?.closeManagedAttempts();
  daemon.db.close(); writable(scratch); rmSync(scratch, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}