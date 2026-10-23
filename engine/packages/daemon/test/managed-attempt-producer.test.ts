import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { ChatRepository } from "../src/domain/chat-repository.js";
import { MailboxDelivery } from "../src/domain/mailbox-delivery.js";
import type { AssignmentInput } from "../src/domain/team-assignment.js";
import { FRAMEWORK_PIN } from "../src/integrations/framework/catalog.js";

// T042: the attempt an admitted assignment launches from is produced by the runtime,
// not assembled at a call site.
//
// Every case goes through `WorkflowRuntime.produceManagedAttempt` with the privileged
// launcher absent: this task proves what the control produces offline. T038 observes
// the composed chain against installed clients, and T047 attaches the result.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "t042-repo-"));
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

/** Every directory the fixture seals is chmod'ed back before removal. */
function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

describe("the managed attempt a seat launches from", () => {
  let directory: string, repo: string, assignmentRoot: string, contextRoot: string, mailboxRoot: string;
  let frameworkRoot: string, controlStateDir: string;
  let db: Database.Database, bus: EventBus, queue: QueueRepository, runtime: WorkflowRuntime;
  let binding: AssignmentInput["binding"];
  let workerGid: number;

  const candidateDir = (worker: string, runId = "run-1", taskId = "T042") =>
    join(assignmentRoot, worker, `${runId}-${taskId}`);
  const projectionDir = (attemptId: string, worker = "ma-worker1", runId = "run-1") =>
    join(contextRoot, worker, runId, attemptId);
  const mailboxDir = (attemptId: string, worker = "ma-worker1", runId = "run-1") =>
    join(mailboxRoot, worker, runId, attemptId);

  const open = () => {
    db = createDb(join(directory, "t042.db"));
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { now: () => new Date("2026-10-23T00:00:00.000Z") } as never);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1",
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot, controlStateDir,
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision }) });
  };

  /** A real pinned framework file, in the layout the catalog uses. Fixed bytes: a resumed
   * attempt must be compared against what it recorded, so this must not change per call. */
  let frameworkSource = "";
  const frameworkFiles = () => [{ path: "skills/autoresearch/SKILL.md", source: frameworkSource }];

  const produceInput = (overrides: Record<string, unknown> = {}) => ({
    attemptId: "attempt-1", worker: "ma-worker1",
    assignment: { taskId: "T042", role: "implementer" as const, paths: ["src"], dependencies: ["T011"] },
    outputs: ["src/result.ts"], permissions: ["write-assigned-tree"], role: "implementer" as const,
    client: "claude-code" as const, candidate: candidateDir("ma-worker1"), sessionId: "implementer-session",
    rigId: "rig-1", taskId: "T042", recipients: ["lead@rig-1"], workerGid,
    deadline: Date.now() + 60_000, isCurrent: () => true,
    delivery: new MailboxDelivery(), chat: new ChatRepository(db),
    readCredentials: () => ({ ownerToken: null }),
    context: { frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, workerUid: 60000, workerGroups: [],
      discoveryRoots: [], mutableStateRoot: join(directory, "state") },
    frameworkFiles: frameworkFiles(),
    ...overrides,
  });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "t042-attempt-"));
    chmodSync(directory, 0o755);
    repo = repository();
    assignmentRoot = join(directory, "assignments");
    contextRoot = join(directory, "context");
    controlStateDir = join(directory, "control");
    mailboxRoot = join(controlStateDir, "mailboxes");
    frameworkRoot = join(directory, "framework");
    // The control's own directories, then the roots it provisions for the worker.
    for (const path of [join(assignmentRoot, "ma-worker1"), frameworkRoot, controlStateDir,
      mailboxRoot, join(directory, "state")]) mkdirSync(path, { recursive: true, mode: 0o700 });
    // The context root is root-owned 0755 on a provisioned host, not control 0700.
    mkdirSync(contextRoot, { recursive: true, mode: 0o755 });
    chmodSync(contextRoot, 0o755);
    // The worker's own group on a provisioned host is the group of `<context_root>/<worker>`,
    // which `provision-host.sh` installs setgid, so a directory created beneath it inherits
    // that group rather than the daemon's. The anchor's group is read back rather than
    // assumed, so the fixture cannot silently make the two ownership rules agree.
    const anchors = [join(contextRoot, "ma-worker1"), join(mailboxRoot, "ma-worker1")];
    for (const anchor of anchors) mkdirSync(anchor, { recursive: true });
    chmodSync(join(contextRoot, "ma-worker1"), 0o2750);
    chmodSync(join(mailboxRoot, "ma-worker1"), 0o700);
    // The pinned framework tree is control-owned and worker-readable through the worker
    // group, exactly as provisioning installs it.
    chmodSync(frameworkRoot, 0o2750);
    // The pinned framework bytes, written once per test so a resumed attempt is compared
    // against exactly what it recorded.
    frameworkSource = join(frameworkRoot, "skills", "autoresearch", "SKILL.md");
    mkdirSync(join(frameworkRoot, "skills", "autoresearch"), { recursive: true });
    writeFileSync(frameworkSource, "pinned instructions\n", { mode: 0o644 });
    chmodSync(join(frameworkRoot, "skills"), 0o2750);
    chmodSync(join(frameworkRoot, "skills", "autoresearch"), 0o2750);
    workerGid = lstatSync(join(contextRoot, "ma-worker1")).gid;
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"),
      repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 4, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    open();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'test')").run();
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
      VALUES ('run-1', 'rig-1', ?, ?, 'approved', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z')`)
      .run(JSON.stringify(binding), hashBinding(binding));
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES ('dep-item', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z', 'lead@rig-1', 'dep-session', 'done', 'body')`).run();
    db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json, evidence_json)
      VALUES ('dep-item', 'run-1', 'T011', ?, ?)`).run(
      JSON.stringify({ taskId: "T011", role: "implementer", paths: ["test/dependency"], dependencies: [] }),
      JSON.stringify({ validated: true }));
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (existsSync(directory)) writable(directory);
    rmSync(directory, { recursive: true, force: true });
  });

  it("projects the attempt's context once, under the policy's root, with the core and its role charter", async () => {
    const produced = await runtime.produceManagedAttempt("run-1", produceInput());
    const root = projectionDir("attempt-1");
    expect(produced.attempt.context.root).toBe(root);
    expect(produced.candidate).toBe(candidateDir("ma-worker1"));
    const kinds = produced.attempt.context.files.map(file => file.kind);
    expect(kinds).toContain("core");
    expect(kinds).toContain("charter");
    expect(produced.attempt.context.instructionVersions.core).not.toBe("");
    expect(produced.attempt.context.instructionVersions.charter).not.toBe("");
    // The root carries the worker's group, which is what a setgid anchor produces; a
    // control-gid check here would throw on a real host. It is sealed to 0550 once its
    // entries exist, because the manifest refuses a root its owner could still write to.
    expect(lstatSync(root).gid).toBe(workerGid);
    expect(lstatSync(root).mode & 0o7777).toBe(0o550);
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it("refuses a projection missing the core or the role charter", async () => {
    // Drive the production producer and remove one instruction entry from what it
    // projected, then resume. The manifest must refuse rather than adopt a projection
    // that is missing what it is supposed to carry. A fresh runtime is used because the
    // in-memory map would otherwise return the first attempt without re-reading disk.
    await runtime.produceManagedAttempt("run-1", produceInput());
    const root = projectionDir("attempt-1");
    await runtime.retireManagedAttempt("attempt-1");
    chmodSync(root, 0o755);
    chmodSync(join(root, "charter"), 0o644);
    rmSync(join(root, "charter"));
    const restarted = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1",
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot, controlStateDir,
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision }) });
    await expect(restarted.produceManagedAttempt("run-1", produceInput())).rejects.toThrow();
  }, 30_000);

  it("listens on a private endpoint and writes the bootstrap the launcher binds", async () => {
    const produced = await runtime.produceManagedAttempt("run-1", produceInput());
    const socket = join(mailboxDir("attempt-1"), "mailbox.sock");
    const bootstrap = join(mailboxDir("attempt-1"), "bootstrap.json");
    expect(produced.bridge.binding.socketPath).toBe(socket);
    expect(lstatSync(socket).isSocket()).toBe(true);
    const stat = lstatSync(bootstrap);
    expect(stat.mode & 0o7777).toBe(0o600);
    const body = JSON.parse(readFileSync(bootstrap, "utf8"));
    expect(Object.keys(body).sort()).toEqual(["attemptId", "authorization", "capability", "generation", "runId", "sessionId", "taskId"]);
    expect(body.attemptId).toBe("attempt-1");
    expect(body.runId).toBe("run-1");
    expect(body.capability).toMatch(/^mailbox:[A-Za-z0-9_-]{43}$/);
    await runtime.retireManagedAttempt("attempt-1");
    expect(existsSync(bootstrap)).toBe(false);
  }, 30_000);

  it("admits an actual request on the produced endpoint rather than only existing", async () => {
    // "Listening" has to mean admission, not a socket file. The frame is refused for a
    // credential reason, which proves the server read and dispatched it.
    const produced = await runtime.produceManagedAttempt("run-1", produceInput());
    const body = JSON.parse(readFileSync(join(mailboxDir("attempt-1"), "bootstrap.json"), "utf8"));
    const socketPath = produced.bridge.binding.socketPath;
    const response = await new Promise<string>((resolve, reject) => {
      const socket = require("node:net").createConnection(socketPath, () => {
        socket.write(JSON.stringify({ authorization: body.authorization, sessionId: body.sessionId,
          runId: body.runId, attemptId: body.attemptId, generation: body.generation,
          operation: "poll", taskId: body.taskId, capability: body.capability }) + "\n");
      });
      let data = "";
      socket.on("data", chunk => { data += chunk; });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      setTimeout(() => { socket.destroy(); resolve(data); }, 2_000);
    });
    const parsed = JSON.parse(response.trim());
    // It answered: the endpoint dispatched the frame rather than dropping it.
    expect(typeof parsed.ok).toBe("boolean");
    expect(parsed.ok === false ? parsed.code : "admitted").toBeTruthy();
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it("creates no projection, endpoint or attempt for an assignment admission refuses", async () => {
    await expect(runtime.produceManagedAttempt("run-1", produceInput({ outputs: ["outside/escape.ts"] })))
      .rejects.toThrow();
    expect(existsSync(projectionDir("attempt-1"))).toBe(false);
    expect(existsSync(mailboxDir("attempt-1"))).toBe(false);
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
  }, 30_000);

  it("releases the candidate claim when production fails after admission", async () => {
    // Admission retains the claim; a later refusal must give it back, or the task's tree
    // stays claimed for the life of the daemon.
    await expect(runtime.produceManagedAttempt("run-1", produceInput({ candidate: join(directory, "elsewhere") })))
      .rejects.toThrow("Managed attempt candidate mismatch");
    // With the claim released, the same attempt can be produced against the real tree.
    const produced = await runtime.produceManagedAttempt("run-1", produceInput());
    expect(produced.candidate).toBe(candidateDir("ma-worker1"));
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it("returns the attempt it already produced for the same attempt id", async () => {
    const first = await runtime.produceManagedAttempt("run-1", produceInput());
    const second = await runtime.produceManagedAttempt("run-1", produceInput());
    expect(second).toBe(first);
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it("adopts an existing projection on resume instead of rewriting a sealed root", async () => {
    // A restart empties the in-memory map, so the resumed attempt re-enters produce with
    // its projection still on disk. Rewriting it would fail EACCES on the sealed root.
    const first = await runtime.produceManagedAttempt("run-1", produceInput());
    const before = first.attempt.context.generatedHash;
    await runtime.retireManagedAttempt("attempt-1");
    // A second runtime over the same database is the state a restarted daemon has.
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1",
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot, controlStateDir,
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision }) });
    const resumed = await runtime.produceManagedAttempt("run-1", produceInput());
    expect(resumed.attempt.context.root).toBe(projectionDir("attempt-1"));
    // The recorded bytes are what a resume is held to, and they are the same bytes.
    expect(resumed.attempt.context.generatedHash).toBe(before);
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it("refuses a candidate that is not the task's own", async () => {
    await expect(runtime.produceManagedAttempt("run-1", produceInput({ candidate: join(directory, "elsewhere") })))
      .rejects.toThrow("Managed attempt candidate mismatch");
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
  }, 30_000);

  it("refuses a mailbox root that is not beneath the control state directory", async () => {
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1",
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot: join(directory, "elsewhere-mailboxes"), controlStateDir,
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision }) });
    await expect(runtime.produceManagedAttempt("run-1", produceInput())).rejects.toThrow();
    expect(existsSync(join(directory, "elsewhere-mailboxes"))).toBe(false);
  }, 30_000);

  it("closes every endpoint this daemon owns", async () => {
    await runtime.produceManagedAttempt("run-1", produceInput());
    const second = await runtime.produceManagedAttempt("run-1", produceInput({ attemptId: "attempt-2" }));
    expect(existsSync(second.bridge.binding.socketPath)).toBe(true);
    await runtime.closeManagedAttempts();
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
    expect(runtime.managedAttemptFor("attempt-2")).toBeUndefined();
  }, 30_000);
});