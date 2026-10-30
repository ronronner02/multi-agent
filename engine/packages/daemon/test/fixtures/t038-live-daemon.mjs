// T038 live harness — daemon-mediated launch lane.
//
// Driven by `worker-live-acceptance.test.ts`, which runs it as the control identity through
// sudo so every step happens with the identity the daemon actually uses. Composes the
// production daemon exactly as startup does (real policy, real launcher, real tmux, real
// mailbox producer) and drives one managed attempt through it. Phases:
//   produce    — rows, seat, projection and mailbox endpoint only; no client starts.
//   fresh      — one fresh native launch through the composed adapters.
//   resume     — one exact resume of the receipt recorded by an earlier fresh run.
//   restart    — a second daemon process on the same database, then the recorded session state.
//
// The home directory comes from HOME, which the runner sets to a fresh temporary directory, so
// every run starts from an empty database. That matters: governance refuses a new launch while
// an earlier attempt's intent is unresolved, which is the correct behaviour and would otherwise
// make a rerun after a failed start look like a new defect.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const [phase = "produce", client = "claude-code"] = process.argv.slice(2);
// The runner sets HOME to a fresh temporary directory; the explicit override stays for a
// hand-run against a directory kept between phases (a resume needs one).
const HOME_DIR = process.env.T038_LIVE_HOME ?? process.env.HOME;
const DB = join(HOME_DIR, "daemon.sqlite");
const REPO = join(HOME_DIR, "repo");
const WORK = join(HOME_DIR, "work");
const STATE = join(HOME_DIR, "state.json");
const RUN = "run", TASK = "task", SEAT = "builder@rig";

mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
mkdirSync(WORK, { recursive: true, mode: 0o700 });
process.env.OPENRIG_HOME = join(HOME_DIR, "home");
process.env.OPENRIG_SLICES_ROOT = join(HOME_DIR, "slices");
mkdirSync(process.env.OPENRIG_HOME, { recursive: true, mode: 0o700 });
mkdirSync(process.env.OPENRIG_SLICES_ROOT, { recursive: true, mode: 0o700 });

const git = (...args) => execFileSync("git", ["-C", REPO, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" });
mkdirSync(join(REPO, "src"), { recursive: true });
try { git("init", "--quiet", "--initial-branch=main"); } catch { /* already a repository */ }
writeFileSync(join(REPO, "plan.md"), "T038 live acceptance plan\n");
writeFileSync(join(REPO, "src", "base.ts"), "export const base = 1;\n");
git("add", ".");
try { git("commit", "--quiet", "-m", "base"); } catch { /* nothing new */ }

const sha = file => "sha256:" + execFileSync("sha256sum", [file], { encoding: "utf8" }).split(" ")[0];
const fingerprint = sha("/etc/multi-agent/worker-policy.json");
const binding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "plan.md", planDigest: sha(join(REPO, "plan.md")),
  repository: { root: realpathSync(REPO), identity: "git:" + git("rev-parse", "HEAD").trim() },
  readPaths: ["src"], writePaths: ["src"], roles: ["implementer", "reviewer"], policyRevision: 5,
  policyFingerprint: fingerprint,
  limits: { maxSessions: 3, maxActiveMs: 1_800_000, maxRetries: 1, maxReviewRounds: 2 },
};
const workerToken = "worker-" + "w".repeat(40);
const teamControl = {
  credentials: { ownerToken: "owner-" + "o".repeat(40), workers: [{ token: workerToken, sessionId: SEAT, runId: RUN }] },
  resolveBinding: () => structuredClone(binding),
  readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: fingerprint, verifiedProviders: ["claude", "codex"] }),
};

const { createDaemon } = await import("/home/leo/src/multi-agent/engine/packages/daemon/src/startup.ts");
const { RigRepository } = await import("/home/leo/src/multi-agent/engine/packages/daemon/src/domain/rig-repository.ts");
const { SessionRegistry } = await import("/home/leo/src/multi-agent/engine/packages/daemon/src/domain/session-registry.ts");
const { hashBinding } = await import("/home/leo/src/multi-agent/engine/packages/daemon/src/domain/plan-governance.ts");

const daemon = await createDaemon({ dbPath: DB, managedMode: true, teamControl });
const { db, deps } = daemon;
const governance = deps.teamGovernance, runtime = deps.workflowRuntime, adapters = deps.runtimeAdapters;
const owner = { kind: "owner", sessionId: "owner-control" };
let serial = 0;
const command = (actionId, payload) => ({ protocolVersion: "1.0", runId: RUN, actionId,
  expectedEntityVersion: governance.getRun(RUN).entityVersion, idempotencyKey: `${phase}-${actionId}-${++serial}`, payload });

const out = { phase, client };
try {
  const rigRepo = new RigRepository(db), sessions = new SessionRegistry(db);
  let hasRun = false;
  try { governance.getRun(RUN); hasRun = true; } catch { /* first phase creates it */ }
  if (!hasRun) {
    db.prepare("INSERT OR IGNORE INTO rigs(id, name) VALUES ('rig', 'rig')").run();
    governance.createRun({ id: RUN, rigId: "rig", binding });
    const digest = hashBinding(binding);
    const requested = governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: digest }, targetDigest: digest, expiresAt: "2099-01-01T00:00:00.000Z" }),
    { kind: "worker", sessionId: SEAT });
    if (requested.status !== "accepted") throw new Error("approval request refused: " + JSON.stringify(requested));
    const decided = governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }), owner, binding);
    if (decided.status !== "accepted") throw new Error("approval decision refused: " + JSON.stringify(decided));
  }
  const existing = db.prepare("SELECT id FROM nodes WHERE rig_id = 'rig' AND logical_id = 'builder'").get();
  const nodeId = existing?.id ?? rigRepo.addNode("rig", "builder", { runtime: client, cwd: realpathSync(WORK) }).id;
  if (!sessions.findResumeContextByName(SEAT)) sessions.registerSession(nodeId, SEAT);
  // `startNode` takes the session by its row id, not its name.
  const sessionRecord = sessions.findResumeContextByName(SEAT);
  // A real pane for the seat: the launch control resolves it, and the launcher starts the client
  // there. Two facts about the pane shape matter, both from the production code:
  //
  //   * It must outlive a command that exits. `respawn-pane` (used without `-k`, so the pane's
  //     scrollback survives) refuses a live pane with "still active", and production expects a
  //     pane kept present by `remain-on-exit` after its command finished (tmux.ts, seat handover).
  //   * A pane created with no command runs the default shell, which exits at once on this host
  //     and takes the session — and the pane id the seat binding records — with it.
  //
  // So the server keeps one long-lived session, `remain-on-exit` is set globally before any seat
  // pane is created, and the seat's own command exits immediately, leaving a dead pane the launch
  // can respawn into.
  //
  // `default-shell` is set for the same reason: tmux runs a respawned line through the server's
  // `default-shell`, and the control account's login shell here is `/usr/sbin/nologin`, so the
  // line would die with "This account is currently not available" before the launcher ran. The
  // daemon's own service has a real shell; this only restores what the account is missing.
  if (!(await deps.tmuxAdapter.hasSession(SEAT))) {
    execFileSync("tmux", ["new-session", "-d", "-s", "t038-keepalive", "-c", realpathSync(WORK), "--", "sleep", "1800"]);
    execFileSync("tmux", ["set-option", "-g", "remain-on-exit", "on"]);
    execFileSync("tmux", ["set-option", "-g", "default-shell", "/bin/sh"]);
    execFileSync("tmux", ["new-session", "-d", "-s", SEAT, "-c", realpathSync(WORK), "--", "/usr/bin/true"]);
  }
  const panes = await deps.tmuxAdapter.listPanes(SEAT);
  const pane = panes[0]?.id ?? panes[0]?.target;
  if (!/^%[0-9]+$/.test(pane ?? "")) throw new Error("seat pane is unresolved: " + JSON.stringify(panes));
  sessions.updateBinding(nodeId, { attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: pane });
  out.seat = { nodeId, pane };

  let task = governance.getTask(
    db.prepare("SELECT qitem_id AS q FROM queue_items WHERE destination_session = ? ORDER BY rowid DESC LIMIT 1").get(SEAT)?.q
    ?? "none");
  if (!task) {
    task = governance.createTask(command("task", { assignment: { taskId: TASK, role: "implementer", paths: ["src"], dependencies: [] },
      outputs: ["src/result.ts"], permissions: ["write-assigned-tree"], sourceSession: "lead@rig", destinationSession: SEAT,
      body: "Implement the assigned file." }), binding).value;
  }
  out.task = { qitemId: task.qitemId, role: task.assignment.role };

  const prior = readState();
  const resumeToken = phase === "resume" ? prior?.resumeToken : undefined;
  const attemptId = resumeToken && prior?.attemptId ? prior.attemptId : `attempt-${Date.now()}`;
  const previous = resumeToken ? prior?.receipt : undefined;

  // A resume re-enters the attempt it recorded: same attempt id, same projection, exact receipt.
  const admitted = runtime.admitForLaunch(RUN, { attemptId, worker: "ma-worker1", assignment: task.assignment,
    outputs: task.outputs ?? [], permissions: task.permissions ?? [],
    context: { binding, runId: RUN, role: task.assignment.role } });
  const produced = await runtime.produceManagedAttempt(RUN, {
    attemptId, worker: "ma-worker1", assignment: task.assignment,
    outputs: task.outputs ?? [], permissions: task.permissions ?? [],
    role: task.assignment.role, client, candidate: admitted.candidate, sessionId: SEAT,
    rigId: "rig", taskId: task.assignment.taskId, recipients: ["lead@rig"],
    deadline: Date.now() + 900_000, isCurrent: () => true,
    ...(previous ? { previous } : {}),
    delivery: deps.mailboxDelivery, chat: deps.chatRepo ?? deps.chat,
    context: { client, discoveryRoots: [], mutableStateRoot: "/var/lib/multi-agent/workers/ma-worker1/scratch" },
    frameworkFiles: [{ path: "skills/using-spec-first/SKILL.md",
      source: "/opt/multi-agent/framework/skills/using-spec-first/SKILL.md" }],
  });
  deps.managedLaunch.endpoints.set(attemptId, produced.bridge);
  out.attempt = { attemptId, contextHash: produced.attempt.context.generatedHash,
    root: produced.attempt.context.root, mailbox: produced.attempt.context.projection.worker,
    deadline: produced.attempt.deadline };
  out.candidate = admitted.candidate;

  if (phase === "restart") {
    // A second daemon process on the same database: the receipt the fresh launch recorded must
    // still name the same attempt and the same context, read from durable state alone. No
    // client starts here, so this phase spends none of the allowance.
    const prior = readState();
    if (!prior?.attemptId) throw new Error("restart requires a recorded receipt from an earlier fresh phase");
    const recorded = governance.getAttempt(prior.attemptId);
    out.restart = {
      sameAttempt: prior.attemptId === attemptId,
      recordedAttemptId: recorded?.attemptId ?? null,
      recordedState: recorded?.state ?? null,
      contextHash: produced.attempt.context.generatedHash,
      recordedContextHash: prior.receipt?.contextHash ?? null,
    };
    if (!out.restart.sameAttempt) throw new Error("restart produced a different attempt id");
  } else if (phase !== "produce") {
    // The production entry point, not `adapter.launchHarness` directly. `startNode` is what takes
    // the seat's lifecycle lease from the delivery guard, and a pane write without that lease is
    // refused as a legacy operation (`managed_control_required`) — which is correct, and is why
    // driving the adapter by hand cannot prove a managed launch. `startNode` also resolves the
    // managed attempt through the same composition this script used above.
    const bindingForNode = { id: "binding-" + attemptId, nodeId, tmuxSession: SEAT, tmuxPane: pane,
      tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: admitted.candidate,
      permissionMode: "acceptEdits" };
    const result = await deps.startupOrchestrator.startNode({
      rigId: "rig", nodeId, sessionId: sessionRecord.sessionId, binding: bindingForNode,
      adapter: adapters[client],
      plan: { runtime: client, cwd: admitted.candidate, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: SEAT,
      ...(resumeToken ? { resumeToken, resumeType: client === "codex" ? "codex_id" : "claude_id" } : {}),
    });
    // The orchestrator returns no receipt: it records the launcher's receipt as an event and the
    // resume token on the session. Both are read back from those durable records, which is also
    // what a later resume and the restart phase consume.
    const receiptEvent = db.prepare(`SELECT payload FROM events WHERE type = 'managed.attempt.receipt'
      ORDER BY seq DESC LIMIT 1`).get();
    const receipt = receiptEvent ? JSON.parse(receiptEvent.payload).receipt ?? null : null;
    // The orchestrator writes the token on the session row, which is the durable record a resume reads.
    const tokenRow = db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(sessionRecord.sessionId);
    out.launch = { ok: result.ok, startupStatus: result.startupStatus,
      errors: result.ok ? null : result.errors, warnings: result.warnings ?? null,
      managedSession: receipt, resumeToken: tokenRow?.resume_token ?? null };
    if (result.ok && tokenRow?.resume_token) {
      writeFileSync(STATE, JSON.stringify({ attemptId, resumeToken: tokenRow.resume_token, receipt }, null, 1));
    }
  }
} catch (error) {
  out.error = String(error?.stack ?? error);
} finally {
  console.log("T038-RESULT " + JSON.stringify(out));
  try { db.close(); } catch { /* already closed */ }
  process.exit(out.error ? 1 : 0);
}

function digestOf(value) {
  return "sha256:" + execFileSync("/usr/bin/sha256sum", { input: JSON.stringify(value, Object.keys(value).sort()) })
    .toString().split(" ")[0];
}
function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return null; }
}