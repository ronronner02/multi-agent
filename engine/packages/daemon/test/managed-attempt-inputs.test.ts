import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTeamControlCredential } from "../src/middleware/auth-bearer-token.js";
import { hashBinding, hashBytes, type PlanGovernance } from "../src/domain/plan-governance.js";
import type { PlanBinding, TeamTaskAuthority } from "../src/contracts/team-control.js";
import { WorkerControlAccess } from "../src/domain/worker-control-access.js";
import { resolveWorkerIdentity } from "../src/domain/worker-identity.js";
import { SeatMailboxCapabilities } from "../src/domain/seat-mailbox-capability.js";
import { WorkerMailboxBridge } from "../src/adapters/worker-mailbox-bridge.js";
import { FRAMEWORK_PIN } from "../src/integrations/framework/catalog.js";
import { createDaemon } from "../src/startup.js";

// T053: the four inputs the producer had no production owner for — the worker control
// credential, the seat's mailbox capability, the task's recorded outputs/permissions and a
// worker identity read from the host — plus the composition point that supplies them.
//
// Scenario 1 drives the daemon's own composition (`createDaemon` in managed mode), so the
// roots, credential and identity are the ones startup installed rather than fixture values.
// The privileged launcher is never invoked: production here is offline, and the endpoint it
// would mount is proven by connecting to it.

const host = vi.hoisted(() => ({ policy: "", passwd: "", group: "" }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const file = String(args[0]);
      const fake = file === "/etc/multi-agent/worker-policy.json" ? host.policy
        : file === "/etc/passwd" ? host.passwd : file === "/etc/group" ? host.group : undefined;
      return fake === undefined ? actual.readFileSync(...args) : fake;
    },
  };
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "t053-repo-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** Every directory the projection seals is chmod'ed back before removal. */
function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

describe("the managed attempt's production inputs", () => {
  let directory: string, repo: string, assignmentRoot: string, contextRoot: string, mailboxRoot: string;
  let frameworkRoot: string, controlStateDir: string, toolchainDir: string, workerRoot: string, stateRoot: string;
  let frameworkSource = "";
  let db: Database.Database, governance: PlanGovernance, runtime: NonNullable<Awaited<ReturnType<typeof createDaemon>>["deps"]["workflowRuntime"]>;
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  let binding: PlanBinding, credentials: { ownerToken: string | null; workers?: readonly { token: string; sessionId: string; runId: string }[] };
  let workerUid: number, workerGid: number, serial: number;

  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "t053-" + ++serial, payload });
  const identity = () => resolveWorkerIdentity({ workerRoot, assignmentRoot, identities: ["ma-worker1", "ma-worker2"] }, "ma-worker1");
  const attemptRoot = () => join(contextRoot, "ma-worker1", "run", "attempt-1");
  const mailboxDir = () => join(mailboxRoot, "ma-worker1", "run", "attempt-1");

  const produceInput = (overrides: Record<string, unknown> = {}) => ({
    attemptId: "attempt-1", worker: "ma-worker1",
    assignment: { taskId: "task", role: "implementer" as const, paths: ["src"], dependencies: [] },
    outputs: ["src/result.ts"], permissions: ["write-assigned-tree"],
    role: "implementer" as const, client: "claude-code" as const,
    candidate: join(assignmentRoot, "ma-worker1", "run-task"),
    sessionId: "builder@rig", rigId: "rig", taskId: "task", recipients: ["lead@rig"],
    deadline: Date.now() + 60_000, isCurrent: () => true,
    delivery: daemon.deps.mailboxDelivery!, chat: daemon.deps.chatRepo!,
    context: { discoveryRoots: [], mutableStateRoot: stateRoot },
    frameworkFiles: [{ path: "skills/autoresearch/SKILL.md", source: frameworkSource }],
    ...overrides,
  });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "t053-inputs-"));
    chmodSync(directory, 0o755);
    repo = repository();
    assignmentRoot = join(directory, "assignments");
    contextRoot = join(directory, "context");
    controlStateDir = join(directory, "control");
    mailboxRoot = join(controlStateDir, "mailboxes");
    frameworkRoot = join(directory, "framework");
    toolchainDir = join(directory, "toolchain");
    workerRoot = join(directory, "workers");
    stateRoot = join(directory, "state");
    for (const path of [join(assignmentRoot, "ma-worker1"), frameworkRoot, controlStateDir,
      join(workerRoot, "ma-worker1"), stateRoot, toolchainDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
    // The anchors a provisioned host installs: the context root is root-owned 0755 and the
    // per-worker anchors carry the worker's group, which is what the producer reads back.
    mkdirSync(contextRoot, { recursive: true, mode: 0o755 });
    chmodSync(contextRoot, 0o755);
    for (const anchor of [join(contextRoot, "ma-worker1"), join(mailboxRoot, "ma-worker1")]) mkdirSync(anchor, { recursive: true });
    chmodSync(join(contextRoot, "ma-worker1"), 0o2750);
    chmodSync(join(mailboxRoot, "ma-worker1"), 0o700);
    chmodSync(frameworkRoot, 0o2750);
    frameworkSource = join(frameworkRoot, "skills", "autoresearch", "SKILL.md");
    mkdirSync(join(frameworkRoot, "skills", "autoresearch"), { recursive: true });
    writeFileSync(frameworkSource, "pinned instructions\n", { mode: 0o644 });
    chmodSync(join(frameworkRoot, "skills"), 0o2750);
    chmodSync(join(frameworkRoot, "skills", "autoresearch"), 0o2750);
    workerGid = lstatSync(join(contextRoot, "ma-worker1")).gid;
    workerUid = process.getuid!() === 0 ? 60_000 : process.getuid!() + 1;
    // The host account database the launcher reads: the worker's primary group is the one
    // its anchors carry, and a supplementary group makes the membership rule visible.
    host.passwd = `ma-worker1:x:${workerUid}:${workerGid}::/home/ma-worker1:/bin/sh\n` +
      `ma-worker2:x:${workerUid + 1}:${workerGid}::/home/ma-worker2:/bin/sh\n`;
    host.group = `ma-worker:x:${workerGid}:\nshared:x:${workerGid + 1_000}:ma-worker1,ma-worker2\n`;
    host.policy = JSON.stringify({ schema: "multi-agent-worker-policy/v1", policy_revision: 5,
      worker_identities: ["ma-worker1", "ma-worker2"],
      paths: { assignment_root: assignmentRoot, control_state_dir: controlStateDir, worker_root: workerRoot,
        context_root: contextRoot, mailbox_root: mailboxRoot, framework_dir: frameworkRoot, toolchain_dir: toolchainDir } });
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"),
      repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src", "docs"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 5, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    credentials = { ownerToken: "owner-fixture" };
    daemon = await createDaemon({ dbPath: join(directory, "t053.db"), managedMode: true,
      teamControl: { credentials, resolveBinding: () => structuredClone(binding),
        readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: binding.policyFingerprint,
          verifiedProviders: ["claude", "codex"] }) },
      tmuxExec: async () => "", cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
    db = daemon.db;
    governance = daemon.deps.teamGovernance!;
    runtime = daemon.deps.workflowRuntime!;
    serial = 0;
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'rig')").run();
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }),
      { kind: "owner", sessionId: "owner-control" }, binding);
  });

  afterEach(async () => {
    await runtime?.closeManagedAttempts();
    if (db?.open) db.close();
    if (existsSync(directory)) { writable(directory); rmSync(directory, { recursive: true, force: true }); }
  });

  const createTask = (overrides: Record<string, unknown> = {}) => governance.createTask(command("task", {
    assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
    outputs: ["src/result.ts"], permissions: ["write-assigned-tree"],
    sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file.",
    ...overrides,
  }), binding);

  const ask = async (frame: Record<string, unknown>, attemptId = "attempt-1") => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(join(mailboxRoot, "ma-worker1", "run", attemptId, "mailbox.sock"),
        () => socket.write(JSON.stringify(frame) + "\n"));
      let data = "";
      socket.on("data", chunk => { data += chunk; });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      setTimeout(() => { socket.destroy(); resolve(data); }, 2_000);
    });
    return JSON.parse(response.trim());
  };

  it("produces an attempt in a composed startup, from the policy's roots and the composed owners", async () => {
    expect(createTask().status).toBe("accepted");
    const produced = await runtime.produceManagedAttempt("run", produceInput());
    // The roots are the installed policy's, not values this test chose.
    expect(produced.attempt.context.root).toBe(join(contextRoot, "ma-worker1", "run", "attempt-1"));
    expect(produced.candidate).toBe(join(assignmentRoot, "ma-worker1", "run-task"));
    expect(produced.attempt.context.frameworkRoot).toBe(frameworkRoot);
    // The recorded inputs, not the caller's claim, are what the projection carries.
    expect(produced.attempt.context.outputs).toEqual(["src/result.ts"]);
    expect(produced.attempt.context.permissions).toEqual(["write-assigned-tree"]);
    // The identity owner filled what the caller left out.
    expect(produced.attempt.context.workerUid).toBe(workerUid);
    expect(produced.attempt.context.workerGroups).toEqual(identity().groupIds);
    expect(lstatSync(attemptRoot()).gid).toBe(workerGid);
    // Endpoint and bootstrap exist, and the bootstrap carries a token this daemon issued.
    expect(lstatSync(join(mailboxDir(), "mailbox.sock")).isSocket()).toBe(true);
    const bootstrap = JSON.parse(readFileSync(join(mailboxDir(), "bootstrap.json"), "utf8"));
    expect(bootstrap.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(bootstrap.capability).toMatch(/^mailbox:[A-Za-z0-9_-]{43}$/);
    const token = bootstrap.authorization.slice("Bearer ".length);
    const worker = credentials.workers?.find(entry => entry.sessionId === "builder@rig" && entry.runId === "run");
    expect(worker?.token).toBe(token);
    const stored = db.prepare("SELECT token_digest AS digest FROM team_worker_credentials WHERE run_id = 'run' AND session_id = ?")
      .get("builder@rig") as { digest: string };
    // Only the digest is durable, and it is not the plaintext.
    expect(stored.digest).toBe("sha256:" + createHash("sha256").update(token).digest("hex"));
    expect(stored.digest).not.toContain(token);
  }, 60_000);

  it("admits the issued token on its own endpoint and refuses it for another seat or the owner", async () => {
    createTask();
    await runtime.produceManagedAttempt("run", produceInput());
    const bootstrap = JSON.parse(readFileSync(join(mailboxDir(), "bootstrap.json"), "utf8"));
    const frame = { authorization: bootstrap.authorization, sessionId: "builder@rig", runId: "run",
      attemptId: "attempt-1", generation: bootstrap.generation, operation: "poll", taskId: "task",
      capability: bootstrap.capability };
    expect((await ask(frame) as { ok: boolean }).ok).toBe(true);
    // The owner credential is an owner, never a worker one.
    const owner = resolveTeamControlCredential("Bearer owner-fixture", daemon.deps.teamControl!.credentials);
    expect(owner.ok && owner.actor.kind).toBe("owner");
    expect((await ask({ ...frame, authorization: "Bearer owner-fixture" }) as { ok: boolean; code?: string }).code)
      .toBe("mailbox_not_admitted");
    // The same token addressed as another seat's scope is refused by the bridge itself.
    expect((await ask({ ...frame, sessionId: "other@rig" }) as { ok: boolean; code?: string }).code)
      .toBe("mailbox_not_admitted");
    // A credential configured for another seat is unknown to this endpoint.
    const other = new WorkerControlAccess(db, { ownerToken: "owner-fixture" });
    other.issue("run", "other@rig");
    expect((await ask({ ...frame, authorization: "Bearer " + other.readCredentials().workers![0]!.token }) as { code?: string }).code)
      .toBe("control_auth_required");
  }, 60_000);

  it("keeps the worker token out of everything but the bootstrap's authorization field", async () => {
    createTask();
    const produced = await runtime.produceManagedAttempt("run", produceInput());
    const bootstrap = JSON.parse(readFileSync(join(mailboxDir(), "bootstrap.json"), "utf8"));
    const token = bootstrap.authorization.slice("Bearer ".length);
    // No file the attempt owns carries the secret; the bootstrap is the one exception the
    // launcher needs, and there only in `authorization`.
    const leaked = files(attemptRoot()).filter(file => readFileSync(file, "utf8").includes(token));
    expect(leaked).toEqual([]);
    const lines = Object.entries(bootstrap).filter(([, value]) => String(value).includes(token)).map(([key]) => key);
    expect(lines).toEqual(["authorization"]);
    // The projection records the attempt, not the credential.
    expect(JSON.stringify(produced.attempt.context)).not.toContain(token);
  }, 60_000);

  it("uses one persisted seat capability for the producer, the bootstrap and a later send", async () => {
    createTask();
    await runtime.produceManagedAttempt("run", produceInput());
    const bootstrap = JSON.parse(readFileSync(join(mailboxDir(), "bootstrap.json"), "utf8"));
    const row = db.prepare("SELECT capability FROM team_seat_mailbox_capabilities WHERE run_id = 'run' AND session_id = ?")
      .get("builder@rig") as { capability: string };
    expect(row.capability).toBe(bootstrap.capability);
    // A later send that names no capability must land under the seat's own value, not a fresh
    // one: a send that named it here would pass even with the resolver deleted.
    const delivery = daemon.deps.mailboxDelivery!;
    const sent = delivery.send({ rigId: "rig", sender: "lead@rig", recipient: "builder@rig", taskId: "task", runId: "run",
      body: "review this", messageId: "message-1" }) as { capability?: string };
    expect(sent.capability).toBe(row.capability);
    // Delivery is held while no live seat is at a safe boundary, so the capability's effect is
    // read where poll reads it: the scope match. A different capability matches nothing.
    const scope = { rigId: "rig", recipient: "builder@rig", taskId: "task", runId: "run" };
    expect(delivery.poll({ ...scope, capability: row.capability }).pendingCount).toBe(1);
    expect(daemon.deps.chatRepo!.listMailbox({ ...scope, capability: row.capability }, 10).map(message => message.id))
      .toEqual(["message-1"]);
    const stranger = delivery.poll({ ...scope, capability: "mailbox:" + "d".repeat(43) });
    expect(stranger.messages).toEqual([]);
    expect(stranger.pendingCount).toBe(0);
  }, 60_000);

  it("refuses a caller whose inputs disagree with the record, and an output outside the assignment at creation", async () => {
    // Creation refuses an output the assignment never claimed, an output under a read-only
    // path, and a permission the role lacks.
    expect(createTask({ outputs: ["docs/readme.md"] })).toMatchObject({ status: "denied", reason: "An output is outside the assignment's reviewable write paths" });
    // A reviewer may read `docs` but must not produce there: its assignment covers the read
    // paths, and an output under one would describe a write the approval never granted.
    expect(createTask({ assignment: { taskId: "task", role: "reviewer", paths: ["docs"], dependencies: [] },
      outputs: ["docs/report.md"], permissions: ["submit-review"] })).toMatchObject({
      status: "denied", reason: "An output is outside the assignment's reviewable write paths" });
    expect(createTask({ permissions: ["approve-plan"] })).toMatchObject({ status: "denied", reason: "A permission is outside the assignment role's vocabulary" });
    expect(db.prepare("SELECT count(*) AS count FROM team_queue_authority").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM team_seat_mailbox_capabilities").get()).toEqual({ count: 0 });
    expect(createTask().status).toBe("accepted");
    // A produced attempt whose arrays differ from the record is refused before admission, so
    // it leaves no candidate claim, projection or endpoint behind.
    await expect(runtime.produceManagedAttempt("run", produceInput({ outputs: ["src/other.ts"] })))
      .rejects.toThrow("Assignment inputs disagree with the recorded task");
    await expect(runtime.produceManagedAttempt("run", produceInput({ permissions: [] })))
      .rejects.toThrow("Assignment inputs disagree with the recorded task");
    expect(existsSync(attemptRoot())).toBe(false);
    expect(existsSync(mailboxDir())).toBe(false);
  }, 60_000);

  it("refuses a seat, capability, identity or credential the composition did not issue", async () => {
    createTask();
    // A seat this task does not have: the capability and credential are keyed on (run, seat),
    // so producing for another session would mint authority for a seat that does not exist.
    await expect(runtime.produceManagedAttempt("run", produceInput({ sessionId: "other@rig" })))
      .rejects.toThrow("seat is not the task's destination");
    expect(db.prepare("SELECT count(*) AS count FROM team_seat_mailbox_capabilities WHERE session_id = 'other@rig'").get())
      .toEqual({ count: 0 });
    // A capability that disagrees with the seat's record is refused rather than preferred.
    await expect(runtime.produceManagedAttempt("run", produceInput({ mailboxCapability: "mailbox:" + "d".repeat(43) })))
      .rejects.toThrow("mailbox capability disagrees with the composition");
    // A caller-supplied credential would be a second credential authority for one seat.
    await expect(runtime.produceManagedAttempt("run", produceInput({ readCredentials: () => ({ ownerToken: null }) })))
      .rejects.toThrow("credentials come from the composition");
    // An identity that disagrees with the host's account database is refused, not overridden.
    await expect(runtime.produceManagedAttempt("run", produceInput({ workerGid: workerGid + 1 })))
      .rejects.toThrow("worker gid disagrees with the composition");
    expect(existsSync(attemptRoot())).toBe(false);
    expect(existsSync(mailboxDir())).toBe(false);
    // None of the refusals left a credential behind.
    expect(db.prepare("SELECT count(*) AS count FROM team_worker_credentials").get()).toEqual({ count: 0 });
    expect(credentials.workers ?? []).toEqual([]);
  }, 60_000);

  it("revokes a credential whose production failed after issuance", async () => {
    createTask();
    // The failure has to land *after* issuance, or this proves nothing: a candidate mismatch
    // throws before the token exists. `listen` fails here, which is the first step that runs
    // after the credential is minted, so this case fails if the revoke is removed.
    const failing = { invalidateNativeChannel: () => { throw new Error("fixture endpoint failure"); } };
    await expect(runtime.produceManagedAttempt("run", produceInput({ delivery: failing as never })))
      .rejects.toThrow("fixture endpoint failure");
    expect(db.prepare("SELECT count(*) AS count FROM team_worker_credentials").get()).toEqual({ count: 0 });
    expect(credentials.workers ?? []).toEqual([]);
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
  }, 60_000);

  it("hands a duplicate caller the same production instead of a half-started endpoint", async () => {
    createTask();
    // Two callers race for one attempt id. The second must await the first's listen rather than
    // receive the record published for a sibling retirement to see, and a failed start must not
    // delete anything the duplicate is still holding.
    const [first, second] = await Promise.all([
      runtime.produceManagedAttempt("run", produceInput()),
      runtime.produceManagedAttempt("run", produceInput()),
    ]);
    expect(second).toBe(first);
    expect(first.bridge.binding.attemptId).toBe("attempt-1");
    const bootstrap = JSON.parse(readFileSync(join(mailboxDir(), "bootstrap.json"), "utf8"));
    expect((await ask({ authorization: bootstrap.authorization, sessionId: "builder@rig", runId: "run",
      attemptId: "attempt-1", generation: bootstrap.generation, operation: "poll", taskId: "task",
      capability: bootstrap.capability }, "attempt-1")).ok).toBe(true);
  }, 60_000);

  it("does not hand a duplicate caller an attempt whose endpoint is still listening", async () => {
    createTask();
    // The window the finding names: the first production is between publishing its attempt and
    // its endpoint finishing `listen`. Holding the real `listen` here makes that window
    // deterministic. A duplicate that settles inside it was handed a record whose endpoint never
    // listened, and the failed start below then deletes that record under the duplicate's feet.
    const listen = WorkerMailboxBridge.prototype.listen;
    let entered!: () => void;
    let release!: () => void;
    const listening = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(WorkerMailboxBridge.prototype, "listen").mockImplementation(async function (this: WorkerMailboxBridge) {
      entered();
      await gate;
      return listen.call(this);
    });
    try {
      const failing = { invalidateNativeChannel: () => { throw new Error("fixture endpoint failure"); } };
      const first = runtime.produceManagedAttempt("run", produceInput({ delivery: failing as never }));
      await listening;
      const second = runtime.produceManagedAttempt("run", produceInput({ delivery: failing as never }));
      let joined: string | undefined;
      const observed = (outcome: string) => { if (joined === undefined) joined = outcome; };
      void first.then(() => observed("resolved"), () => observed("rejected"));
      void second.then(() => observed("resolved"), () => observed("rejected"));
      await new Promise(resolve => setTimeout(resolve, 50));
      const early = joined;
      release();
      // The duplicate must still be waiting on the one production, not holding a half-started
      // record. On the pre-fix source it has already resolved here.
      expect(early).toBeUndefined();
      await expect(first).rejects.toThrow("fixture endpoint failure");
      await expect(second).rejects.toThrow("fixture endpoint failure");
      expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
      expect(db.prepare("SELECT count(*) AS count FROM team_worker_credentials").get()).toEqual({ count: 0 });
    } finally {
      release();
      spy.mockRestore();
    }
  }, 60_000);

  it("closes an endpoint that was still starting when the close-all ran", async () => {
    createTask();
    // R5-1: a production inside `listen` is not in `managedAttempts` yet, so a close-all that
    // only visits that map returns while the endpoint is still coming up — and the endpoint then
    // publishes and keeps its credential past a close that reported success. Holding the real
    // `listen` makes the window deterministic.
    const listen = WorkerMailboxBridge.prototype.listen;
    let entered!: () => void;
    let release!: () => void;
    const listening = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(WorkerMailboxBridge.prototype, "listen").mockImplementation(async function (this: WorkerMailboxBridge) {
      entered();
      await gate;
      return listen.call(this);
    });
    try {
      const starting = runtime.produceManagedAttempt("run", produceInput());
      await listening;
      const closed = runtime.closeManagedAttempts();
      release();
      await closed;
      // Nothing may be left live when the close returns: the drained production either published
      // (and was then retired) or failed and cleaned itself up.
      expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
      expect(db.prepare("SELECT count(*) AS count FROM team_worker_credentials").get()).toEqual({ count: 0 });
      await expect(starting).resolves.toBeDefined();
    } finally {
      release();
      spy.mockRestore();
    }
  }, 60_000);

  it("refuses an endpoint bound to a task the assignment does not name", async () => {
    createTask();
    await expect(runtime.produceManagedAttempt("run", produceInput({ taskId: "task-b" })))
      .rejects.toThrow("task is not the assignment's task");
    expect(existsSync(mailboxDir())).toBe(false);
    expect(db.prepare("SELECT count(*) AS count FROM team_worker_credentials").get()).toEqual({ count: 0 });
  }, 60_000);

  it("keeps a live attempt's credential when a superseded attempt of the same seat retires", async () => {
    createTask();
    const first = await runtime.produceManagedAttempt("run", produceInput());
    const second = await runtime.produceManagedAttempt("run", produceInput({ attemptId: "attempt-2" }));
    expect(second.bridge.binding.attemptId).toBe("attempt-2");
    const secondBootstrap = JSON.parse(readFileSync(join(join(mailboxRoot, "ma-worker1", "run", "attempt-2"), "bootstrap.json"), "utf8"));
    const token = secondBootstrap.authorization.slice("Bearer ".length);
    // One credential per seat: retiring the superseded attempt must not take the token the
    // live attempt's endpoint is authenticating with.
    await runtime.retireManagedAttempt(first.bridge.binding.attemptId);
    expect(credentials.workers?.some(worker => worker.token === token)).toBe(true);
    expect(db.prepare("SELECT count(*) AS count FROM team_worker_credentials").get()).toEqual({ count: 1 });
    const admitted = await ask({ authorization: secondBootstrap.authorization, sessionId: "builder@rig", runId: "run",
      attemptId: "attempt-2", generation: secondBootstrap.generation, operation: "poll", taskId: "task",
      capability: secondBootstrap.capability }, "attempt-2");
    expect(admitted.ok).toBe(true);
  }, 60_000);

  it("resolves every worker the policy lists, with the launcher's own account rules, and refuses the rest", async () => {
    const policy = { workerRoot, assignmentRoot, identities: ["ma-worker1", "ma-worker2"] };
    const first = resolveWorkerIdentity(policy, "ma-worker1");
    expect(first).toMatchObject({ name: "ma-worker1", uid: workerUid, gid: workerGid,
      groups: ["ma-worker", "shared"], groupIds: [workerGid, workerGid + 1_000],
      home: join(workerRoot, "ma-worker1", "home"), scratch: join(workerRoot, "ma-worker1", "scratch"),
      tree: join(assignmentRoot, "ma-worker1") });
    // The second worker resolves too, and its own gid is not inferred from the first.
    expect(resolveWorkerIdentity(policy, "ma-worker2").uid).toBe(workerUid + 1);
    // A name the policy does not list, and one the host has no account for, are both refused.
    expect(() => resolveWorkerIdentity(policy, "ma-worker3")).toThrow("not in the installed policy");
    expect(() => resolveWorkerIdentity({ ...policy, identities: [...policy.identities, "ma-ghost"] }, "ma-ghost"))
      .toThrow("is not provisioned");
    // What the composed producer wrote is the same identity the launcher will observe.
    createTask();
    const produced = await runtime.produceManagedAttempt("run", produceInput());
    expect(produced.attempt.context.workerUid).toBe(first.uid);
    expect(produced.attempt.context.projection.workerGid).toBe(first.gid);
  }, 60_000);

  it("revokes the token when the attempt retires and on daemon-restart reconciliation", async () => {
    createTask();
    await runtime.produceManagedAttempt("run", produceInput());
    const bootstrap = JSON.parse(readFileSync(join(mailboxDir(), "bootstrap.json"), "utf8"));
    const token = bootstrap.authorization.slice("Bearer ".length);
    expect(credentials.workers?.some(worker => worker.token === token)).toBe(true);
    await runtime.retireManagedAttempt("attempt-1");
    // Endpoint and bootstrap are gone with the credential, on the one retirement path.
    expect(existsSync(join(mailboxDir(), "mailbox.sock"))).toBe(false);
    expect(existsSync(join(mailboxDir(), "bootstrap.json"))).toBe(false);
    expect(credentials.workers?.some(worker => worker.token === token)).toBe(false);
    expect(db.prepare("SELECT count(*) AS count FROM team_worker_credentials").get()).toEqual({ count: 0 });
    // A restart inherits rows from a process whose plaintext died with it; reconciliation
    // revokes them, while a credential the process entry supplied stays configuration.
    db.prepare(`INSERT INTO team_worker_credentials (run_id, session_id, token_digest, issued_at)
      VALUES ('run', 'builder@rig', 'sha256:${"0".repeat(64)}', '2026-10-27T00:00:00.000Z')`).run();
    const restarted = new WorkerControlAccess(db, { ownerToken: "owner-fixture",
      workers: [{ token: "supplied-token", sessionId: "lead@rig", runId: "run" }] });
    restarted.reconcile();
    expect(db.prepare("SELECT count(*) AS count FROM team_worker_credentials").get()).toEqual({ count: 0 });
    expect(restarted.readCredentials().workers).toEqual([{ token: "supplied-token", sessionId: "lead@rig", runId: "run" }]);
  }, 60_000);

  it("changes no durable row, file, session or provider state on any read it introduces", async () => {
    createTask();
    const task = governance.findTask("run", "task") as TeamTaskAuthority;
    const tables = ["team_queue_authority", "team_worker_credentials", "team_seat_mailbox_capabilities", "team_attempts"];
    const counts = () => tables.map(table => db.prepare(`SELECT count(*) AS count FROM ${table}`).get());
    // A seat with a live credential, so the read paths run against a populated store.
    credentials.workers = [{ token: "live-token", sessionId: "builder@rig", runId: "run" }];
    const before = counts();
    // The reads: the recorded task, the credential list (the endpoint's every-request path),
    // the seat's capability and the identity resolution. A read that minted would show up in
    // the counts below; a read that revoked would show up as a shorter credential list.
    expect(governance.getTask(task.qitemId)).toEqual(task);
    expect(governance.findTask("run", "task")).toEqual(task);
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
    expect(new WorkerControlAccess(db, { ownerToken: "owner-fixture" }).readCredentials()).toEqual({ ownerToken: "owner-fixture" });
    expect(new SeatMailboxCapabilities(db).find("run", "builder@rig"))
      .toBe((db.prepare("SELECT capability FROM team_seat_mailbox_capabilities WHERE run_id = 'run' AND session_id = 'builder@rig'")
        .get() as { capability: string }).capability);
    resolveWorkerIdentity({ workerRoot, assignmentRoot, identities: ["ma-worker1"] }, "ma-worker1");
    expect(counts()).toEqual(before);
    expect(credentials.workers).toEqual([{ token: "live-token", sessionId: "builder@rig", runId: "run" }]);
    expect(db.prepare("SELECT count(*) AS count FROM team_attempts").get()).toEqual({ count: 0 });
    // Nothing reached a privileged launcher or a provider session.
    expect(existsSync(contextRoot) ? files(contextRoot).length : 0).toBe(0);
  }, 60_000);
});