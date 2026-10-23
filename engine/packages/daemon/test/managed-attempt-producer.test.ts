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
import { createContextManifest } from "../src/integrations/framework/context-manifest.js";
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

/** Every directory the fixture creates is chmod'ed back before removal. */
function writable(path: string): void {
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

describe("the managed attempt a seat launches from", () => {
  let directory: string, repo: string, assignmentRoot: string, contextRoot: string, mailboxRoot: string;
  let frameworkRoot: string;
  let db: Database.Database, bus: EventBus, queue: QueueRepository, runtime: WorkflowRuntime;
  let binding: AssignmentInput["binding"];

  const candidateDir = (worker: string, runId = "run-1", taskId = "T042") =>
    join(assignmentRoot, worker, `${runId}-${taskId}`);
  /** The projection layout the manifest requires: one per attempt, under the worker's context root. */
  const projectionDir = (attemptId: string, worker = "ma-worker1", runId = "run-1") =>
    join(contextRoot, worker, runId, attemptId);

  const open = () => {
    db = createDb(join(directory, "t042.db"));
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { now: () => new Date("2026-10-23T00:00:00.000Z") } as never);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1",
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot, controlStateDir: join(directory, "control"),
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision }) });
  };

  /** The pinned framework file the projection carries; a real file under the framework root. */
  const frameworkFiles = () => {
    const source = join(frameworkRoot, "skill.md");
    writeFileSync(source, "pinned instructions\n", { mode: 0o644 });
    return [{ path: "skill.md", source }];
  };

  /** Everything the producer takes besides the attempt identity. */
  const produceInput = (overrides: Record<string, unknown> = {}) => ({
    attemptId: "attempt-1", worker: "ma-worker1",
    assignment: { taskId: "T042", role: "implementer" as const, paths: ["src"], dependencies: ["T011"] },
    outputs: ["src/result.ts"], permissions: ["write-assigned-tree"], role: "implementer" as const,
    client: "claude-code" as const, candidate: candidateDir("ma-worker1"), sessionId: "implementer-session",
    rigId: "rig-1", taskId: "T042", recipients: ["lead@rig-1"], workerGid: process.getgid!(),
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
    mailboxRoot = join(directory, "control", "mailboxes");
    frameworkRoot = join(directory, "framework");
    for (const path of [join(assignmentRoot, "ma-worker1"), frameworkRoot, join(directory, "control"),
      join(directory, "state")]) mkdirSync(path, { recursive: true, mode: 0o700 });
    // The installed control provisions these roots: the context ancestry group-searchable
    // for the worker (the manifest requires the worker to read what it follows) and the
    // mailbox root control-private. The producer creates only the per-attempt leaf.
    for (const path of [join(contextRoot, "ma-worker1"), join(mailboxRoot, "ma-worker1"), frameworkRoot]) {
      mkdirSync(path, { recursive: true });
    }
    chmodSync(join(contextRoot, "ma-worker1"), 0o2750);
    chmodSync(join(mailboxRoot, "ma-worker1"), 0o700);
    // The pinned framework tree is read by the worker through the same group.
    chmodSync(frameworkRoot, 0o2750);
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
    // The dependency is satisfied only by a done row carrying validated evidence, and
    // its claim sits outside this task's paths so the two do not overlap.
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
    // KTD28 (T045): the projection carries the shared core and this role's charter, and
    // the manifest records their versions rather than trusting today's bytes.
    const kinds = produced.attempt.context.files.map(file => file.kind);
    expect(kinds).toContain("core");
    expect(kinds).toContain("charter");
    expect(produced.attempt.context.instructionVersions.core).not.toBe("");
    expect(produced.attempt.context.instructionVersions.charter).not.toBe("");
    // Every projected file is private to the worker and read-only to it.
    for (const file of produced.attempt.context.files) {
      const stat = lstatSync(file.path);
      if (file.kind === "framework") continue;
      expect(stat.mode & 0o7777).toBe(0o440);
    }
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it("refuses a projection without the pinned instructions", () => {
    // The producer is the only writer, so the check is that its own manifest builder
    // rejects the omission rather than that a caller remembered to include them.
    const root = projectionDir("attempt-no-charter");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "plan"), "approved plan\n", { mode: 0o440 });
    writeFileSync(join(root, "role"), "{}", { mode: 0o440 });
    expect(() => createContextManifest({ runId: "run-1", role: "implementer", client: "claude-code",
      binding, assignment: { taskId: "T042", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["write-assigned-tree"], root, frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision,
      mutableStateRoot: join(directory, "state"), workerUid: 60000, workerGroups: [], discoveryRoots: [],
      files: [], projection: { worker: "ma-worker1", attemptId: "attempt-no-charter", controlUid: process.getuid!(),
        workerGid: process.getgid!(), policy: { policy_revision: 4, worker_identities: ["ma-worker1"],
          paths: { context_root: contextRoot, framework_dir: frameworkRoot }, sandbox: { context: "/context", framework: "/framework" } } },
    } as never)).toThrow();
  }, 30_000);

  it("listens on a private endpoint and writes the bootstrap the launcher binds", async () => {
    const produced = await runtime.produceManagedAttempt("run-1", produceInput());
    const socket = join(mailboxRoot, "ma-worker1", "run-1", "attempt-1", "mailbox.sock");
    const bootstrap = join(mailboxRoot, "ma-worker1", "run-1", "attempt-1", "bootstrap.json");
    expect(produced.bridge.binding.socketPath).toBe(socket);
    expect(lstatSync(socket).isSocket()).toBe(true);
    const stat = lstatSync(bootstrap);
    expect(stat.mode & 0o7777).toBe(0o600);
    const body = JSON.parse(readFileSync(bootstrap, "utf8"));
    // The launcher requires exactly these seven string fields, an unguessable
    // capability, and the attempt identity it was asked to launch.
    expect(Object.keys(body).sort()).toEqual(["attemptId", "authorization", "capability", "generation", "runId", "sessionId", "taskId"]);
    expect(body.attemptId).toBe("attempt-1");
    expect(body.runId).toBe("run-1");
    expect(body.capability).toMatch(/^mailbox:[A-Za-z0-9_-]{43}$/);
    await runtime.retireManagedAttempt("attempt-1");
    // Retirement removes the bootstrap and unlinks the socket, so a stale endpoint
    // cannot be relaunched against.
    expect(existsSync(bootstrap)).toBe(false);
  }, 30_000);

  it("creates no projection, endpoint or attempt for an assignment admission refuses", async () => {
    // An output outside the approved write scope is refused before anything is written.
    await expect(runtime.produceManagedAttempt("run-1", produceInput({ outputs: ["outside/escape.ts"] })))
      .rejects.toThrow();
    expect(existsSync(projectionDir("attempt-1"))).toBe(false);
    expect(existsSync(join(mailboxRoot, "ma-worker1", "run-1", "attempt-1"))).toBe(false);
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
  }, 30_000);

  it("returns the attempt it already produced for the same attempt id", async () => {
    const first = await runtime.produceManagedAttempt("run-1", produceInput());
    const second = await runtime.produceManagedAttempt("run-1", produceInput());
    // A second projection over one attempt would fork the reviewed bytes.
    expect(second).toBe(first);
    expect(runtime.managedAttemptFor("attempt-1")).toBe(first);
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it("refuses a candidate that is not the task's own", async () => {
    // The projection names the tree the worker will work in; another tree would
    // describe work that cannot happen.
    await expect(runtime.produceManagedAttempt("run-1", produceInput({ candidate: join(directory, "elsewhere") })))
      .rejects.toThrow("Managed attempt candidate mismatch");
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
  }, 30_000);

  it("closes every endpoint this daemon owns", async () => {
    await runtime.produceManagedAttempt("run-1", produceInput());
    const second = await runtime.produceManagedAttempt("run-1", produceInput({ attemptId: "attempt-2",
      assignment: { taskId: "T042", role: "implementer", paths: ["src"], dependencies: ["T011"] } }));
    expect(existsSync(second.bridge.binding.socketPath)).toBe(true);
    await runtime.closeManagedAttempts();
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
    expect(runtime.managedAttemptFor("attempt-2")).toBeUndefined();
  }, 30_000);
});