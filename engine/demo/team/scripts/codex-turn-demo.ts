import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { parse as parseToml } from "smol-toml";

// From engine/: OPENRIG_HOME=<private absolute path> DEMO_PORT=7631 npx tsx demo/team/scripts/codex-turn-demo.ts
// Uses the local client configuration and leaves the attempt files in that private home.
const home = process.env.OPENRIG_HOME;
assert.ok(home && isAbsolute(home), "Set OPENRIG_HOME to a private absolute path for this demo.");
assert.notEqual(resolve(home), join(homedir(), ".openrig"), "The demo needs its own OPENRIG_HOME.");
const port = Number(process.env.DEMO_PORT ?? 7631);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536 && port !== 7433, "Use a private demo port, such as 7631.");
const baseUrl = `http://127.0.0.1:${port}`;
mkdirSync(home, { recursive: true });
const scratch = mkdtempSync(join(dirname(home), "codex-turn-demo-"));
const repository = join(scratch, "repository");
process.env.TMUX_TMPDIR = join(scratch, "tmux");
delete process.env.TMUX; delete process.env.TMUX_PANE;
process.env.OPENRIG_PORT = String(port);
process.env.OPENRIG_HOST = "127.0.0.1";
process.env.OPENRIG_URL = baseUrl;
process.env.OPENRIG_SHARED_DOCS_ROOT = join(home, "shared-docs");
mkdirSync(repository);
mkdirSync(process.env.TMUX_TMPDIR);
writeFileSync(join(repository, "plan.md"), "Write result.txt containing exactly: Codex one-turn demo passed.\n");
for (const args of [["init", "-q", "--initial-branch=main"], ["config", "user.name", "Demo"],
  ["config", "user.email", "demo@example.invalid"], ["add", "plan.md"], ["commit", "-qm", "demo baseline"]]) {
  execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
}

// Import after setting the instance environment: OPENRIG_HOME is captured at module load.
const { createDaemon } = await import("../../../packages/daemon/src/startup.js");
const { agentTurnOutputPaths, isNativeSessionToken } = await import("../../../packages/daemon/src/domain/agent-turn.js");
const { unisolatedWorkerRoots } = await import("../../../packages/daemon/src/domain/unisolated-roots.js");
const config = parseToml(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"), "utf8"));
const configuredModel = typeof config.model === "string" ? config.model : "CLI default";
const ownerToken = randomUUID();
let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
let server: ReturnType<typeof serve> | undefined;
let failed = true;
try {
  // Use a private server without the user's tmux configuration. The managed launch itself
  // must supply the client PATH after the pane's normal shell startup.
  execFileSync("tmux", ["-f", "/dev/null", "new-session", "-d", "-s", "demo-control", "/bin/bash --noprofile --norc"], { stdio: "ignore" });
  daemon = await createDaemon({ dbPath: join(scratch, "daemon.db"), managedMode: true, workersIsolation: "none",
    teamControl: { credentials: { ownerToken } },
    cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
  server = serve({ fetch: daemon.app.fetch, hostname: "127.0.0.1", port });
  await once(server, "listening");
  console.log(`Managed demo daemon: ${baseUrl}; state: ${home}`);
  const rig = daemon.deps.rigRepo.createRig("codex-turn-demo", repository);
  const governance = daemon.deps.teamGovernance!;
  const roots = unisolatedWorkerRoots(home);
  const stateRoot = join(roots.workerRoot, roots.worker, "scratch");

  async function turn(model?: string) {
    const active = daemon!;
    const name = model ? "fallback" : "builder", seat = `${name}@codex-turn-demo`;
    const node = active.deps.rigRepo.addNode(rig.id, name, { role: "implementer", runtime: "codex", cwd: repository,
      ...(model ? { model } : {}) });
    active.deps.sessionRegistry.registerSession(node.id, seat);
    console.log(`Starting one turn with model ${model ?? configuredModel}.`);
    const response = await fetch(baseUrl + "/api/team-control/runs", {
      method: "POST", headers: { Authorization: "Bearer " + ownerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Read plan.md. Write only result.txt containing exactly 'Codex one-turn demo passed.' followed by a newline. Report the result when finished.",
        seat, writePaths: ["result.txt"] }),
    });
    const body = await response.json() as { runId: string };
    assert.equal(response.status, 201, JSON.stringify(body));
    const task = governance.findTask(body.runId, "task-1")!;
    const deadline = Date.now() + 180_000;
    let exitCode: number | null = null, paneOutput = "";
    // Drive the daemon's sweep on its normal cadence, keeping the pane evidence before it
    // releases the held terminal. No attempt, stop, token or outcome is written by the demo.
    while (Date.now() < deadline) {
      const row = active.db.prepare(`SELECT payload FROM events WHERE type = 'managed.attempt.receipt'
        AND json_extract(payload, '$.runId') = ? ORDER BY seq DESC LIMIT 1`).get(body.runId) as { payload: string } | undefined;
      if (row) {
        const { receipt } = JSON.parse(row.payload) as { receipt: { identity: { paneId: string } } };
        const exit = await active.deps.tmuxAdapter!.getPaneExit(receipt.identity.paneId);
        if (exit?.dead) {
          exitCode = exit.code;
          paneOutput = await active.deps.tmuxAdapter!.capturePaneTail(receipt.identity.paneId, 200) ?? "";
        }
      }
      await active.deps.attemptCompletion!.sweep();
      const attempt = governance.getLatestTaskAttempt(task.qitemId);
      if (attempt?.state === "stopped") {
        const output = agentTurnOutputPaths(stateRoot, attempt.id);
        const session = active.deps.sessionRegistry.getSessionsForRig(rig.id).find(item => item.sessionName === seat)!;
        console.log(JSON.stringify({ model: model ?? configuredModel, runId: body.runId, attemptId: attempt.id,
          state: attempt.state, exitCode, resumeToken: session.resumeToken, lastMessage: output.lastMessage,
          failure: attempt.failure?.reasonCode ?? null }));
        return { attempt, output, session, paneOutput, exitCode,
          candidate: active.deps.workflowRuntime!.assignedTreeFor(body.runId, task.assignment) };
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    const failure = active.db.prepare("SELECT payload FROM events WHERE type = 'node.startup_failed' AND node_id = ? ORDER BY seq DESC LIMIT 1")
      .get(node.id) as { payload: string } | undefined;
    assert.fail(`No stopped attempt within three minutes. ${failure?.payload ?? ""}`);
  }

  let result = await turn();
  if (result.exitCode !== 0 && /502/.test(result.paneOutput) && /high demand/i.test(result.paneOutput)) {
    console.log("The relay returned 502 high demand; retrying once with gpt-6.1-sol.");
    result = await turn("gpt-6.1-sol");
  }
  assert.equal(result.exitCode, 0, result.paneOutput);
  assert.equal(result.attempt.failure, null);
  assert.equal(result.session.resumeType, "codex_id");
  assert.ok(isNativeSessionToken(result.session.resumeToken));
  assert.equal(result.session.resumeToken, result.attempt.identity?.nativeSessionId);
  assert.ok(readFileSync(result.output.lastMessage, "utf8").trim(), "The final message must be discoverable for this attempt.");
  assert.equal(readFileSync(join(result.candidate, "result.txt"), "utf8"), "Codex one-turn demo passed.\n");
  console.log(`Demo passed: the daemon observed the turn stop, saved its thread, and kept its final message. Evidence: ${scratch}`);
  failed = false;
} catch (error) {
  console.error(error);
} finally {
  daemon?.deps.attemptCompletion?.stop();
  try { execFileSync("tmux", ["kill-server"], { stdio: "ignore" }); } catch { /* The private server may already be stopped. */ }
  await daemon?.deps.workflowRuntime?.closeManagedAttempts();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (daemon?.db.open) daemon.db.close();
  // Other daemon owners keep timers; this standalone demo owns no further work.
  process.exit(failed ? 1 : 0);
}
