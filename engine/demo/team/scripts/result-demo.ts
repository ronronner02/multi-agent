/**
 * MVP slice 3 — a finished task's patch, all the way back to the owner's repository.
 *
 * Seeds a run and a task, launches the seat through the real direct launcher with the compiled
 * stub runner standing in for the native client, records the owner's observed outcome, then
 * reads the patch through the daemon and lands it with `rig team apply` in a fresh clone.
 * Everything is real except the native client. No provider account, no live token, and no
 * operator tmux session is touched.
 *
 * Run it through `result-demo.sh`, which is what makes it hermetic: the daemon reads
 * OPENRIG_HOME once at module load, so the temp home, database and tmux socket must be in the
 * environment before node starts. The wrapper also owns the cleanup that kills the seat and
 * the tmux server and removes the scratch tree, on success and on failure alike.
 *
 * Usage, from `engine/` after `npm run build`: bash demo/team/scripts/result-demo.sh
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createDaemon } from "../../../packages/daemon/src/startup.js";
import { hashBinding, hashBytes } from "../../../packages/daemon/src/domain/plan-governance.js";
import { unisolatedWorkerRoots } from "../../../packages/daemon/src/domain/unisolated-roots.js";
import { unisolatedPolicyCapability } from "../../../packages/daemon/src/routes/team-start.js";
import type { PlanBinding } from "../../../packages/daemon/src/contracts/team-control.js";

const run = promisify(execFile), engine = realpathSync(new URL("../../..", import.meta.url).pathname);
// The home and the tmux socket are read before this module loads, so the wrapper has to have
// set them. Running this file directly would put a candidate tree and a tmux server in the
// operator's own ~/.openrig, which is exactly what this guard refuses.
const home = process.env.OPENRIG_HOME ?? "";
if (!home.startsWith(tmpdir()) || !process.env.OPENRIG_DB || !process.env.TMUX_TMPDIR) {
  throw new Error("Run this through result-demo.sh: it sets a temp OPENRIG_HOME, OPENRIG_DB and TMUX_TMPDIR.");
}
const scratch = realpathSync(mkdtempSync(join(home, "..", "work-")));
mkdirSync(process.env.TMUX_TMPDIR, { recursive: true });
const tmux = (...args: string[]) => execFileSync("tmux", args,
  { encoding: "utf8", env: { ...process.env }, stdio: ["ignore", "pipe", "ignore"] }).trim();
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(name: string): string {
  const root = join(scratch, name);
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "demo@example.invalid"); git(root, "config", "user.name", "demo");
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan\n");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "base");
  return root;
}

const repo = repository("project"), policy = unisolatedPolicyCapability(unisolatedWorkerRoots(home).policyRevision);
const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "plan.md", planDigest: hashBytes("approved plan\n"), repository: { root: repo, identity: "git:" + "a".repeat(40) },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: policy.policyRevision, policyFingerprint: policy.policyFingerprint,
  limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
};
const stub = new URL("../../../packages/daemon/dist/adapters/stub-runner.js", import.meta.url).pathname;
const daemon = await createDaemon({ dbPath: join(scratch, "demo.db"), managedMode: true,
  teamControl: { credentials: { ownerToken: "demo-owner" }, resolveBinding: () => structuredClone(binding),
    readPolicyCapability: () => policy },
  cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
  directLaunchCommand: facts => [process.execPath, stub,
    "--session-name", facts.taskId, "--cwd", facts.tree, "--launch-id", facts.attemptId, "--posture", "floor"] });
const governance = daemon.deps.teamGovernance!;
let serial = 0;
const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
  expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "demo-" + ++serial, payload });
const metric = { value: null, reason: "not reported" }, usage = { activeMs: 0, inputTokens: metric, outputTokens: metric, costUsd: metric };

try {
  daemon.db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'rig')").run();
  governance.createRun({ id: "run", rigId: "rig", binding });
  governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
    payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }),
  { kind: "worker", sessionId: "builder@rig" });
  governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }),
    { kind: "owner", sessionId: "owner-control" }, binding);
  tmux("new-session", "-d", "-s", "builder@rig", "-c", repo); const pane = tmux("list-panes", "-t", "builder@rig", "-F", "#{pane_id}");
  const nodeId = daemon.deps.rigRepo.addNode("rig", "builder", { runtime: "claude-code", cwd: repo }).id;
  const seats = daemon.deps.sessionRegistry;
  seats.registerSession(nodeId, "builder@rig"); seats.updateBinding(nodeId, { tmuxSession: "builder@rig", tmuxPane: pane });
  const sessionId = seats.findResumeContextByName("builder@rig")!.sessionId;
  const created = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer",
    paths: ["src"], dependencies: [] }, outputs: ["src/result.ts"], permissions: ["write-assigned-tree"],
    sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file." }), binding);
  if (created.status !== "accepted") throw new Error("task seed failed: " + created.reason);
  const qitemId = (created.value as { qitemId: string }).qitemId;

  console.log("==> Launching the seat through the real direct launcher, with the stub runner as the agent");
  const launched = await daemon.deps.startupOrchestrator!.startNode({ rigId: "rig", nodeId, sessionId,
    binding: { id: "b", nodeId, tmuxSession: "builder@rig", tmuxWindow: null, tmuxPane: pane,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: repo },
    adapter: daemon.deps.runtimeAdapters!["claude-code"]!,
    plan: { runtime: "claude-code", cwd: repo, entries: [], diagnostics: [], conflicts: [], noOps: [] },
    resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "builder@rig", includeDurableObligations: false });
  if (!launched.ok) throw new Error("launch failed: " + launched.errors.join(" "));
  const tree = daemon.deps.workflowRuntime!.assignedTreeFor("run", { taskId: "task" });
  console.log("    candidate: " + tree);

  console.log("==> The agent's edit lands in the candidate");
  writeFileSync(join(tree, "src", "result.ts"), "export const result = 42;\n");
  // The seat is done. The stub runner's cwd state is the client's scratch, not the deliverable.
  tmux("kill-pane", "-t", pane); rmSync(join(tree, ".openrig"), { recursive: true, force: true });

  console.log("==> Recording the owner-observed stop and outcome");
  const row = daemon.db.prepare("SELECT payload FROM events WHERE type = 'managed.attempt.receipt' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
  const receipt = (JSON.parse(row.payload) as { receipt: { attemptId: string; identity: unknown } }).receipt;
  const recorded = governance.recordAttempt(command(receipt.attemptId, { qitemId, role: "implementer",
    provider: "claude", state: "running", identity: receipt.identity, unknownReason: null, usage }), binding);
  if (recorded.status !== "observed") throw new Error("attempt record failed: " + recorded.reason);
  const attempt = governance.getLatestTaskAttempt(qitemId)!;
  governance.recordUsage(command(attempt.id, { expectedAttemptVersion: attempt.entityVersion, state: "stopped", usage }));
  const outcome = governance.recordTaskOutcome(command(qitemId, { expectedTaskVersion: governance.getTask(qitemId)!.entityVersion,
    state: "done", actorSession: "builder@rig", attemptId: attempt.id, closureReason: "no-follow-on",
    expectedAttemptVersion: governance.getAttempt(attempt.id)!.entityVersion, evidence: { validated: true },
    transitionNote: "Owner verified the delivered file" }), { kind: "owner", sessionId: "owner-control" });
  if (outcome.status !== "observed") throw new Error("outcome failed: " + outcome.reason);

  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request, env) => daemon.app.fetch(request, env) });
  await once(server, "listening");
  // Async on purpose: the daemon is served by this process, so a synchronous child would block
  // the event loop that has to answer the CLI's health probe.
  const env = { ...process.env, OPENRIG_URL: "http://127.0.0.1:" + (server.address() as { port: number }).port, MULTI_AGENT_OWNER_TOKEN: "demo-owner" };
  const cli = async (args: string[]) => process.stdout.write((await run(process.execPath,
    [join(engine, "packages/cli/dist/index.js"), ...args], { encoding: "utf8", env })).stdout);
  try {
    console.log("==> rig team diff run");
    await cli(["team", "diff", "run"]);
    console.log("==> rig team apply run --repo <the owner's clone>");
    const target = repository("owner-clone"); await cli(["team", "apply", "run", "--repo", target]);
    console.log("    the owner's file now holds: " + JSON.stringify(git(target, "show", ":src/result.ts")));
    console.log("    git status: " + git(target, "status", "--porcelain").trim().replace(/\n/g, " | "));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  console.log("==> Done. The patch the agent wrote is in the owner's tree.");
} finally {
  // The seat's pane is the stub runner's parent, so killing the server ends it. This runs on
  // every path, including a failure, so a refused demo leaves nothing running.
  try { tmux("kill-server"); } catch { /* the pane was already closed by the seat's stop */ }
  await daemon.deps.workflowRuntime?.closeManagedAttempts();
  daemon.db.close();
  rmSync(scratch, { recursive: true, force: true });
  // The daemon's owners keep timers that outlive their teardown; with the scratch tree gone,
  // there is nothing left to wait for.
  process.exit(0);
}
