import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
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
import type { ManagedSessionReceipt } from "../src/domain/runtime-adapter.js";
import type { ContextInput } from "../src/integrations/framework/context-manifest.js";
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
  let frameworkRoot: string, controlStateDir: string, toolchainDir: string;
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
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir }) });
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
    // The recipient's own capability: poll matches on it, so the endpoint must carry this
    // value rather than mint a fresh one, or the worker's mailbox reads empty.
    mailboxCapability: "mailbox:" + "c".repeat(43),
    deadline: Date.now() + 60_000, isCurrent: () => true,
    delivery: new MailboxDelivery(new ChatRepository(db)), chat: new ChatRepository(db),
    // A real worker credential: the bootstrap carries it as `Bearer`, and the endpoint
    // authenticates with it. A constant here would make every request 401.
    readCredentials: () => ({ ownerToken: "owner-fixture",
      workers: [{ token: "worker-fixture-token", sessionId: "implementer-session", runId: "run-1" }] }),
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
    // The pinned toolchain the native policy is built against; only its shape is read.
    toolchainDir = join(directory, "toolchain");
    // The control's own directories, then the roots it provisions for the worker.
    for (const path of [join(assignmentRoot, "ma-worker1"), frameworkRoot, controlStateDir,
      mailboxRoot, join(directory, "state"), toolchainDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
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
      // Revision 5 is what a provisioned host ships and the launcher refuses anything below
      // it, so exercising any other revision would test a configuration production cannot
      // have. It also means the projection must carry the pinned native policy.
      policyRevision: 5, policyFingerprint: hashBytes("policy"),
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
    const task = produceInput();
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES ('task-item', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z', 'lead@rig-1', 'implementer-session', 'pending', 'body')`).run();
    db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json, outputs_json, permissions_json)
      VALUES ('task-item', 'run-1', 'T042', ?, ?, ?)`).run(
      JSON.stringify(task.assignment), JSON.stringify(task.outputs), JSON.stringify(task.permissions));
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
    // Drive the production producer, remove one instruction entry from what it projected,
    // then resume. The root is left sealed at 0550 so the refusal cannot be the earlier
    // "not private and control-owned" check — the assertion below is on the reason, so a
    // test that failed for the wrong one could not pass.
    await runtime.produceManagedAttempt("run-1", produceInput());
    const root = projectionDir("attempt-1");
    await runtime.retireManagedAttempt("attempt-1");
    chmodSync(root, 0o755);
    chmodSync(join(root, "charter"), 0o644);
    rmSync(join(root, "charter"));
    chmodSync(root, 0o550);
    const restarted = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1",
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot, controlStateDir,
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir }) });
    await expect(restarted.produceManagedAttempt("run-1", produceInput()))
      .rejects.toThrow(/role charter|core instructions/);
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
    // "Listening" has to mean admission, not a socket file. The request carries the
    // bootstrap's own authorization, so this fails if that value is not a credential
    // the endpoint accepts — which is exactly the defect a socket-existence check hides.
    const produced = await runtime.produceManagedAttempt("run-1", produceInput());
    const body = JSON.parse(readFileSync(join(mailboxDir("attempt-1"), "bootstrap.json"), "utf8"));
    const ask = async (authorization: string) => {
      const socketPath = produced.bridge.binding.socketPath;
      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(socketPath, () => {
          socket.write(JSON.stringify({ authorization, sessionId: body.sessionId,
            runId: body.runId, attemptId: body.attemptId, generation: body.generation,
            operation: "poll", taskId: body.taskId, capability: body.capability }) + "\n");
        });
        let data = "";
        socket.on("data", chunk => { data += chunk; });
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
        setTimeout(() => { socket.destroy(); resolve(data); }, 2_000);
      });
      return JSON.parse(response.trim());
    };
    // The bootstrap's authorization must be accepted: this is the assertion the earlier
    // version lacked, so a constant placeholder could not pass it.
    const admitted = await ask(body.authorization);
    if (!admitted.ok) throw new Error("endpoint refused the bootstrap credential: " + JSON.stringify(admitted));
    expect(admitted.ok).toBe(true);
    // And a wrong credential is refused, so the endpoint is authenticating rather than
    // admitting everything.
    const refused = await ask("Bearer not-the-worker-token");
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("control_auth_required");
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
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir }) });
    const resumed = await runtime.produceManagedAttempt("run-1", produceInput());
    expect(resumed.attempt.context.root).toBe(projectionDir("attempt-1"));
    // The recorded bytes are what a resume is held to, and they are the same bytes.
    expect(resumed.attempt.context.generatedHash).toBe(before);
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  describe("lead context reconstruction", () => {
    const leadInput = (phase?: "planning" | "delivery", emptyRoster = false) => {
      const base = produceInput();
      const assignment = { ...base.assignment, role: "lead" as const };
      const lead: NonNullable<ContextInput["lead"]> = {
        activationId: "activation-1", ...(phase ? { phase } : {}),
        roster: emptyRoster ? [] : [{ member: "backend", role: "implementer", mailbox: "run/backend" }],
        instructions: "Current run instructions",
      };
      db.prepare(`UPDATE team_queue_authority SET assignment_json = ?, outputs_json = '[]',
        permissions_json = '[]' WHERE qitem_id = 'task-item'`).run(JSON.stringify(assignment));
      return { ...base, assignment, role: "lead" as const, outputs: [], permissions: [],
        context: { ...base.context, lead } };
    };
    const restart = async () => {
      await runtime.retireManagedAttempt("attempt-1");
      runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
        candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
        assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1",
        managedAttemptRoots: () => ({ contextRoot, mailboxRoot, controlStateDir,
          policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
          frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir }) });
    };
    // Only these two receipt fields participate in projection reconstruction. Full
    // native identity validation belongs to the launcher's existing resume tests.
    const previous = (contextHash: string, attemptId = "attempt-1") =>
      ({ attemptId, contextHash } as ManagedSessionReceipt);

    afterEach(async () => { await runtime.closeManagedAttempts(); });

    it.each(["planning", "delivery"] as const)("preserves a legacy nonempty lead context on %s resume", async phase => {
      const first = await runtime.produceManagedAttempt("run-1", leadInput());
      const recorded = first.attempt.context;
      const bytes = recorded.files.map(file => readFileSync(file.path));
      await restart();
      const resumed = await runtime.produceManagedAttempt("run-1", {
        ...leadInput(phase), previous: previous(recorded.generatedHash),
      });
      expect(resumed.attempt.context.generatedHash).toBe(recorded.generatedHash);
      expect(resumed.attempt.context.lead).not.toHaveProperty("phase");
      expect(resumed.attempt.context.root).toBe(recorded.root);
      expect(recorded.files.map(file => readFileSync(file.path))).toEqual(bytes);
    }, 30_000);

    it("retains the explicit phase when an empty-roster planning attempt resumes", async () => {
      const input = leadInput("planning", true);
      const first = await runtime.produceManagedAttempt("run-1", input);
      await restart();
      const resumed = await runtime.produceManagedAttempt("run-1", {
        ...input, previous: previous(first.attempt.context.generatedHash),
      });
      expect(resumed.attempt.context.generatedHash).toBe(first.attempt.context.generatedHash);
      expect(resumed.attempt.context.lead).toMatchObject({ phase: "planning", roster: [] });
    }, 30_000);

    it.each(["wrong-hash", "other-attempt"])("does not select the legacy form for a %s receipt", async kind => {
      const first = await runtime.produceManagedAttempt("run-1", leadInput());
      const hash = first.attempt.context.generatedHash;
      await restart();
      const receipt = previous(kind === "wrong-hash" ? hashBytes("wrong") : hash,
        kind === "other-attempt" ? "attempt-other" : "attempt-1");
      const resumed = await runtime.produceManagedAttempt("run-1", {
        ...leadInput("delivery"), previous: receipt,
      });
      expect(resumed.attempt.context.generatedHash).not.toBe(hash);
      expect(resumed.attempt.context.generatedHash).not.toBe(receipt.contextHash);
      expect(resumed.attempt.context.lead?.phase).toBe("delivery");
    }, 30_000);

    it.each(["roster", "instructions"])("still rejects changed %s with the exact legacy receipt", async field => {
      const first = await runtime.produceManagedAttempt("run-1", leadInput());
      await restart();
      const input = leadInput("delivery");
      if (field === "roster") input.context.lead.roster[0]!.mailbox = "run/changed";
      else input.context.lead.instructions = "Different run instructions";
      await expect(runtime.produceManagedAttempt("run-1", {
        ...input, previous: previous(first.attempt.context.generatedHash),
      })).rejects.toThrow("Stale Lead protocol, roster or run instructions");
    }, 30_000);
  });

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
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir }) });
    // Assert the reason, not just that something threw: without toolchainDir this case
    // would pass on the native-policy builder's own argument error instead.
    await expect(runtime.produceManagedAttempt("run-1", produceInput()))
      .rejects.toThrow(/mailbox root is not beneath the control state directory/);
    expect(existsSync(join(directory, "elsewhere-mailboxes"))).toBe(false);
  }, 30_000);

  it("seals the whole projection, not just its root, because the launcher re-checks every directory", async () => {
    // The launcher refuses any directory below the worker root that its owner can still
    // write, so sealing only the attempt root leaves `framework/` and `native/` writable
    // and the launch is refused as an unverified context source. This is asserted on
    // every directory in the tree, not just the root.
    const produced = await runtime.produceManagedAttempt("run-1", produceInput());
    const root = produced.attempt.context.root;
    const writable: string[] = [];
    const walk = (directory: string): void => {
      if ((lstatSync(directory).mode & 0o222) !== 0) writable.push(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(directory, entry.name));
      }
    };
    walk(root);
    expect(writable).toEqual([]);
    // The subdirectories exist, so this is not vacuous.
    expect(existsSync(join(root, "framework"))).toBe(true);
    expect(existsSync(join(root, "native"))).toBe(true);
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it("keeps an earlier attempt's projection when a later produce is refused", async () => {
    // A refused produce must not delete run evidence. The projection belongs to the
    // attempt that made it, and KTD24 retains projections with the run evidence.
    await runtime.produceManagedAttempt("run-1", produceInput());
    const root = projectionDir("attempt-1");
    await runtime.retireManagedAttempt("attempt-1");
    const restarted = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1",
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot, controlStateDir,
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir }) });
    await expect(restarted.produceManagedAttempt("run-1", produceInput({ candidate: join(directory, "elsewhere") })))
      .rejects.toThrow("Managed attempt candidate mismatch");
    // Still there, still sealed, still the recorded bytes.
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, "charter"))).toBe(true);
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
