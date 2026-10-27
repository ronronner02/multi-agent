import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { candidateManifest, resolveWorkspaceBase } from "../src/domain/team-workspace.js";
import { verifyReviewPacket } from "../src/domain/team-workspace.js";
import type { AssignmentInput } from "../src/domain/team-assignment.js";
import type { AssignmentInput as _Unused } from "../src/domain/team-assignment.js";
import type { WorkerLaunchAdmission, WorkerLaunchControl, WorkerLaunchEvent, WorkerLaunchInput } from "../src/adapters/worker-launch.js";
import { RestrictedWorkerLauncher } from "../src/adapters/worker-launch.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import { parseAssignment } from "../src/contracts/team-control.js";

// T039: every production launch reaches WorkflowRuntime's eligibility check and
// runs inside the task's own candidate workspace.
//
// The launch path is exercised through RestrictedWorkerLauncher with the control
// faked at its seam — the same boundary T041's composition uses — so the test
// proves the wiring rather than a directly constructed workspace. The privileged
// launcher never runs here; T038 owns the installed-client observation.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "t039-repo-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

describe("production launch runs through runtime eligibility and one candidate workspace", () => {
  let directory: string;
  let repo: string;
  let assignmentRoot: string;
  let db: Database.Database;
  let bus: EventBus;
  let queue: QueueRepository;
  let runtime: WorkflowRuntime;
  let binding: AssignmentInput["binding"];
  let context: ContextManifest;

  /** The candidate layout production uses: `<assignment_root>/<worker>/<runId>-<taskId>`. */
  const candidateDir = (worker: string, runId = "run-1", taskId = "T039"): string =>
    join(assignmentRoot, worker, `${runId}-${taskId}`);

  const open = () => {
    db = createDb(join(directory, "t039.db"));
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { now: () => new Date("2026-10-22T00:00:00.000Z") } as never);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId), assignmentRoot: () => assignmentRoot,
      defaultWorker: () => "ma-worker1" });
  };

  /** The context the launcher reads: only the fields admission and admission-order depend on. */
  const contextFor = (overrides: Partial<ContextManifest> = {}): ContextManifest =>
    ({ runId: "run-1", role: "implementer", client: "claude-code", binding,
       assignment: { taskId: "T039", role: "implementer", paths: ["src"], dependencies: ["T011"] },
       outputs: ["src/result.ts"], permissions: ["write-assigned-tree"],
       ...overrides } as unknown as ContextManifest);

  /** The attempt projection: admission reads the worker from it, and the launcher binds it per attempt. */
  const projectionFor = (attemptId: string) => ({
    worker: "ma-worker1", attemptId, controlUid: 1000, workerGid: 1001,
    policy: { policy_revision: 4, worker_identities: ["ma-worker1"],
      paths: { context_root: join(directory, "context"), framework_dir: join(directory, "framework") },
      sandbox: { context: "/run/context", framework: "/opt/framework" } } });

  /** The attempt the launcher receives; the id is unique so launch state never collides across cases. */
  let attemptSeq = 0;
  /** Runtime-mediated preparations; reset per test so a count proves this launch, not an earlier one. */
  const prepareCalls = { count: 0 };
  const attempt = (overrides: Partial<ContextManifest> = {}) => {
    const attemptId = `attempt-${++attemptSeq}`;
    return ({ attemptId, deadline: Date.now() + 60_000,
      context: { ...contextFor(overrides), projection: projectionFor(attemptId) } });
  };

  /** A launch input in the shape the production adapters send: client, attempt, no resume token. */
  const launchInput = (overrides: Partial<ContextManifest> = {}) =>
    ({ client: "claude-code" as const, attempt: attempt(overrides) });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "t039-launch-"));
    repo = repository();
    assignmentRoot = join(directory, "assignments");
    mkdirSync(join(assignmentRoot, "ma-worker1"), { recursive: true });
    // The launcher requires the worker's home and scratch to be their own realpaths.
    mkdirSync(join(directory, "worker", "home"), { recursive: true });
    mkdirSync(join(directory, "worker", "scratch"), { recursive: true });
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan"),
      repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 4, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    // The plan is committed so the checkout's only dirty entry is the owner's own
    // draft; otherwise every case would carry an unrelated untracked file.
    writeFileSync(join(repo, "plan.md"), "approved plan");
    git(repo, "add", "plan.md");
    git(repo, "commit", "--quiet", "-m", "plan");
    open();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'test')").run();
    // The run carries its own binding, so admission compares against recorded
    // authority rather than against anything the launch supplies.
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
      VALUES ('run-1', 'rig-1', ?, ?, 'approved', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`)
      .run(JSON.stringify(binding), hashBinding(binding));
    // T011's validated-evidence gate: a dependency is satisfied only by a queue row
    // that reached `done` AND carries validated evidence. Either half alone fails.
    // Two live tasks cannot claim the same write path or one containing the other,
// so the completed dependency claims a directory the admitted task does not.
    for (const [id, taskId, session, state, evidence, paths] of [
      ["impl-item", "T039", "implementer-session", "in-progress", null, ["src"]],
      ["dep-item", "T011", "dep-session", "done", JSON.stringify({ validated: true }), ["test/dependency"]],
    ] as const) {
      db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
        VALUES (?, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', 'lead@rig-1', ?, ?, 'body')`)
        .run(id, session, state);
      db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json, evidence_json)
        VALUES (?, 'run-1', ?, ?, ?)`)
        .run(id, taskId, JSON.stringify({ taskId, role: "implementer", paths: [...paths], dependencies: taskId === "T039" ? ["T011"] : [] }), evidence);
    }
    context = contextFor();
    prepareCalls.count = 0;
  });
  afterEach(() => {
    if (db?.open) db.close();
    // A review packet is written read-only on purpose; restore write bits before
    // removing the enclosure, the same way the packet owner's own teardown does.
    const writable = (path: string): void => {
      chmodSync(path, 0o755);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644);
      }
    };
    if (existsSync(directory)) writable(directory);
    rmSync(directory, { recursive: true, force: true });
  });

  /** A control that records what it was asked, and can be told to refuse at any phase. */
  const control = (options: { assignedTree?: string; observe?: (input: WorkerLaunchInput) => void } = {}) => {
    const calls = { preflight: 0, start: 0, observe: 0 };
    const fake: WorkerLaunchControl = {
      preflight: async input => {
        calls.preflight += 1;
        options.observe?.(input);
        // The control resolves the assigned tree from the installed policy; the launcher
        // must have admitted exactly that tree beforehand. This calls the runtime method
        // startup's composition calls (`assignedTreeFor`) rather than re-deriving the
        // mapping here, so a broken production branch cannot be masked by an equivalent
        // one in the fixture.
        const tree = options.assignedTree ?? runtime.assignedTreeFor("run-1", input.attempt.context.assignment);
        return ({ assignment: { binding, currentBinding: binding, assignment: input.attempt.context.assignment,
          outputs: [...input.attempt.context.outputs], permissions: [...input.attempt.context.permissions],
          context: input.attempt.context, observed: { discoveryRoots: [], files: [] }, dependencySatisfied: () => true },
          // The launcher requires each of these to be its own realpath, so the
          // fixture creates real directories instead of naming a host path.
          worker: { name: "ma-worker1", uid: 1001, gid: 1001, groups: [],
            home: join(directory, "worker", "home"), scratch: join(directory, "worker", "scratch"), tree },
          control: { uid: 1000, mountNamespace: "mnt:control", userNamespace: "user:control" },
          executable: "/opt/multi-agent/toolchain/clients/bin/claude", executableVersion: "fixture", generation: 1,
          policyFingerprint: binding.policyFingerprint, policyRevision: binding.policyRevision,
          // A passing KTD27 lock: the launcher requires a sha256 digest, at least
          // one locked file, and the observed hashes to be exactly the locked ones
          // re-rooted at the toolchain directory.
          clientLock: { digest: hashBytes("lock"), version: "fixture",
            files: [{ path: "clients/fixture", sha256: hashBytes("client") }],
            observedFiles: [{ path: "/opt/multi-agent/toolchain/clients/fixture", sha256: hashBytes("client") }] },
          installedPolicy: { policy_revision: binding.policyRevision, worker_identities: ["ma-worker1"],
            paths: { context_root: join(directory, "context"), framework_dir: join(directory, "framework"),
              toolchain_dir: "/opt/multi-agent/toolchain", egress_socket_dir: "/run/multi-agent-egress" },
            // The projection's own policy bytes are compared field by field against
            // these, so the fixture has to carry the same context/framework targets
            // that `projectionFor` supplies; otherwise the launch refuses at
            // `managed_context_mount_policy_mismatch` and never reaches the code
            // these tests exist to prove.
            sandbox: { context: "/run/context", framework: "/opt/framework",
              network: "filtered-proxy", etc_ro_binds: [], masked_paths: [] } },
          network: { mode: "filtered-proxy", hostNamespace: "net:[100]", profileFingerprint: hashBytes("egress"), preflightRef: "evidence" },
          provider: { status: "signed_in", client: "claude-code", home: join(directory, "worker", "home"), evidenceRef: "evidence" },
          credentialValues: [] } as never);
      },
      start: async () => { calls.start += 1; throw new Error("test stops before the privileged call"); },
      observe: async () => { calls.observe += 1; throw new Error("test stops before observation"); },
      quiesce: async () => ({}) as never,
      record: async (_event: WorkerLaunchEvent) => {},
    };
    return { fake, calls };
  };

  // Mirrors startup's composition: the launcher sees the runtime only through this
  // seam, so the production path is what the tests exercise rather than a direct
  // module call. `prepareCalls` counts the runtime-mediated preparations, which is
  // how a test can prove the direct-call fallback was never taken.
  const admission: WorkerLaunchAdmission = {
    admitForLaunch: (runId, input) => runtime.admitForLaunch(runId, input),
    prepareAssignment: input => { prepareCalls.count += 1; return runtime.prepareLaunchAssignment(input); },
    candidateSourceUnchanged: (runId, taskId) => runtime.candidateSourceUnchanged(runId, taskId),
    releaseCandidate: (runId, taskId, attemptId) => runtime.releaseCandidate(runId, taskId, attemptId),
  };

  // The admission seam is bound to one runtime, so a test that models a restart (a fresh
// runtime over the same db and roots, with empty in-memory candidate maps) can build a
// launcher over that instance instead.
  const launcher = (fake: WorkerLaunchControl, over: WorkflowRuntime = runtime) =>
    new RestrictedWorkerLauncher(fake, () => 1000, () => "native-session", over === runtime ? admission : {
      admitForLaunch: (runId, input) => over.admitForLaunch(runId, input),
      prepareAssignment: input => { prepareCalls.count += 1; return over.prepareLaunchAssignment(input); },
      candidateSourceUnchanged: (runId, taskId) => over.candidateSourceUnchanged(runId, taskId),
      releaseCandidate: (runId, taskId, attemptId) => over.releaseCandidate(runId, taskId, attemptId),
    });

  it("creates exactly one candidate for the task before the control preflights", async () => {
    let treeSeenByControl: string | undefined;
    // Captured *inside* preflight: the candidate must already exist by then, which
    // is the ordering this test is named for. Checking afterwards proves nothing,
    // because a refused launch releases the tree it never used.
    let candidateExistedAtPreflight = false;
    const { fake, calls } = control({ observe: input => {
      treeSeenByControl = input.attempt.context.assignment.taskId;
      candidateExistedAtPreflight = existsSync(candidateDir("ma-worker1", "run-1", input.attempt.context.assignment.taskId));
    } });
    const result = await launcher(fake).launch(launchInput());
    // This fixture reaches admission, the control preflight and the tree match, then
    // stops where the runtime re-prepares the assignment: its context is shaped for
    // admission, not a real `ContextManifest` with a verifiable `generatedHash`, so
    // `prepareLaunchAssignment` refuses it. Running past that point is
    // `native-session-contract.test.ts`'s fixture, which builds a real projection.
    // What matters here is that the refusal is not one of the admission codes —
    // those are all decided before preflight — so this proves the launch got past
    // admission and the tree match rather than passing for the wrong reason.
    expect(result.ok).toBe(false);
    expect(String(result.error)).not.toMatch(/Run is not approved|expands the approved scope|Dependency lacks validated success/);
    expect(String(result.error)).toMatch(/managed_launch_unverified|managed_context_mismatch/);
    expect(calls.start).toBe(0);
    expect(calls.preflight).toBeGreaterThan(0);
    expect(treeSeenByControl).toBe("T039");
    expect(candidateExistedAtPreflight).toBe(true);
    // The refused launch released the claim it took, so its tree is gone rather than
    // left on disk for nothing to own.
    expect(existsSync(candidateDir("ma-worker1", "run-1", "T039"))).toBe(false);
    const manifest = candidateManifest(runtime.candidateFor("run-1", "T039"));
    expect(manifest.base).toBe("commit");
    expect(manifest.files.map(file => file.path)).toContain("src/base.ts");
  });

  it("refuses the launch before any privileged call when a dependency lacks validated evidence", async () => {
    // A done row whose evidence was never validated does not satisfy a dependency.
    db.prepare("UPDATE team_queue_authority SET evidence_json = NULL WHERE qitem_id = 'dep-item'").run();
    const { fake, calls } = control();
    const result = await launcher(fake).launch(launchInput());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Dependency lacks validated success/);
    // No preflight, so no candidate was even placed for the refused assignment.
    expect(calls.preflight).toBe(0);
    expect(existsSync(candidateDir("ma-worker1"))).toBe(false);
  });

  it("refuses the launch when the run is no longer approved", async () => {
    db.prepare("UPDATE team_runs SET state = 'blocked' WHERE id = 'run-1'").run();
    const { fake, calls } = control();
    const result = await launcher(fake).launch(launchInput());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Run is not approved/);
    expect(calls.preflight).toBe(0);
  });

  it("refuses an assignment whose paths leave the approved write scope", async () => {
    const { fake, calls } = control();
    const result = await launcher(fake).launch(launchInput({
      assignment: { taskId: "T039", role: "implementer", paths: ["outside"], dependencies: ["T011"] } }));
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/expands the approved scope/);
    expect(calls.preflight).toBe(0);
  });

  it("refuses a launch whose control resolves a different tree than the admitted candidate", async () => {
    const { fake } = control({ assignedTree: repo });
    const result = await launcher(fake).launch(launchInput());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/managed_candidate_mismatch/);
  });

  it("admits a reviewer into the reviewer's own candidate, mounted read-only", async () => {
    // A reviewer without a `reviewOf` link is an ordinary assignment: its own task row,
    // its own tree. T043 added the link; a reviewer that omits it keeps the pre-T043
    // shape, so this pins that role alone does not decide *which* tree a launch gets.
    const implementer = runtime.admitForLaunch("run-1", { attemptId: "attempt-impl", worker: "ma-worker1",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });
    const reviewContext = { ...contextFor({ role: "reviewer" }),
      assignment: { taskId: "review-1", role: "reviewer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["submit-review"] } as unknown as ContextManifest;
    const reviewer = runtime.admitForLaunch("run-1", { attemptId: "attempt-review", worker: "ma-worker1",
      assignment: reviewContext.assignment, outputs: [], permissions: ["submit-review"], context: reviewContext });
    expect(reviewer.candidate).toBe(candidateDir("ma-worker1", "run-1", "review-1"));
    expect(reviewer.candidate).not.toBe(implementer.candidate);
  });

  it("refuses a claimed candidate in another worker's assignment directory", async () => {
    // The kernel mounts a tree only under `assignment_root/<that attempt's worker>`,
    // so handing a *claimed* tree to another worker would both fork the task's work
    // and give the launch a tree the privileged launcher rejects. An attempt holds
    // it; the second worker is refused before any of that. (An unclaimed tree a
    // reader staged is re-homed instead — see the reader test below.)
    const admitted = runtime.admitForLaunch("run-1", { attemptId: "attempt-holder", worker: "ma-worker1",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });
    expect(admitted.candidate).toBe(candidateDir("ma-worker1"));
    expect(() => runtime.candidateFor("run-1", "T039", "ma-worker2")).toThrow(/different worker/);
    expect(runtime.candidateFor("run-1", "T039")).toBe(runtime.candidateFor("run-1", "T039", "ma-worker1"));
  });

  it("does not pin a task to a worker just because a reader named no worker", () => {
    // The packet and identity accessors take no worker, so the runtime falls back to
    // the default one to build a path. Recording that as the task's owner would fix
    // the task to the default worker and refuse the real launch on any other, which
    // is a refusal of a legitimate launch — worse than the mismatch it prevents.
    runtime.candidateIdentityFor("run-1", "T039");
    runtime.reviewPacketFor("run-1", "T039", join(directory, "packet-reader"));
    const launched = runtime.admitForLaunch("run-1", { attemptId: "attempt-other-worker", worker: "ma-worker2",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });
    expect(launched.candidate).toBe(candidateDir("ma-worker2"));
    // A second launch on yet another worker is still refused, because now an attempt
    // does hold the tree.
    expect(() => runtime.admitForLaunch("run-1", { attemptId: "attempt-third", worker: "ma-worker3",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context }))
      .toThrow(/different worker/);
  });

  it("admits a resumed attempt into the same candidate it started from", async () => {
    // The tree a launch receives is decided by admission, so a resume must land on
    // the recorded candidate rather than a second one; otherwise a task's work
    // would be split across two trees that no single manifest describes.
    const admit = (attemptId: string) => runtime.admitForLaunch("run-1", {
      attemptId, worker: "ma-worker1",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });
    const first = admit("attempt-resume-1");
    const resumed = admit("attempt-resume-2");
    expect(resumed.candidate).toBe(first.candidate);
    expect(resumed.manifestDigest).toBe(first.manifestDigest);
    // Two launches through the production boundary also resolve one tree.
    const { fake } = control();
    await launcher(fake).launch(launchInput());
    await launcher(fake).launch(launchInput());
    expect(admit("attempt-resume-3").candidate).toBe(first.candidate);
  });

  it("never prepares an assignment for a launch it refused", async () => {
    // T039's done signal requires no production path to reach
    // `prepareTeamAssignment` outside `WorkflowRuntime`. A refused launch must not
    // prepare at all, and the launcher's only preparation route is the seam.
    db.prepare("UPDATE team_runs SET state = 'blocked' WHERE id = 'run-1'").run();
    const { fake, calls } = control();
    const result = await launcher(fake).launch(launchInput());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Run is not approved/);
    expect(prepareCalls.count).toBe(0);
    expect(calls.preflight).toBe(0);
  });

  it("refuses a launch whose run graph has overlapping write claims", async () => {
    // T039's card requires overlapping write claims to refuse the launch. The graph
    // comes from the run's own authority rows, so a caller cannot skip it by
    // omitting an argument. The conflict comes from a *live* task, since a settled
    // task's claim is history rather than contention.
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES ('live-item', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', 'lead@rig-1', 'other-session', 'in-progress', 'body')`).run();
    db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json)
      VALUES ('live-item', 'run-1', 'T015', ?)`)
      .run(JSON.stringify({ taskId: "T015", role: "implementer", paths: ["src"], dependencies: [] }));
    const { fake, calls } = control();
    const result = await launcher(fake).launch(launchInput());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Dependency graph refused: write path src of T039 overlaps T015/);
    expect(calls.preflight).toBe(0);
    expect(existsSync(candidateDir("ma-worker1"))).toBe(false);
  });

  it("lets a later task claim a path a settled task already worked", async () => {
    // A finished task's claim is history, not contention: the admitted task may
    // legitimately re-touch the same file. Only live tasks can conflict.
    db.prepare("UPDATE team_queue_authority SET assignment_json = ? WHERE qitem_id = 'dep-item'")
      .run(JSON.stringify({ taskId: "T011", role: "implementer", paths: ["src"], dependencies: [] }));
    const admitted = runtime.admitForLaunch("run-1", {
      attemptId: "attempt-settled", worker: "ma-worker1",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });
    expect(admitted.candidate).toContain("T039");
  });

  it("refuses a launch whose run graph is cyclic", async () => {
    db.prepare("UPDATE team_queue_authority SET assignment_json = ? WHERE qitem_id = 'dep-item'")
      .run(JSON.stringify({ taskId: "T011", role: "implementer", paths: ["test/dependency"], dependencies: ["T039"] }));
    const { fake, calls } = control();
    const result = await launcher(fake).launch(launchInput());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Dependency graph refused/);
    expect(calls.preflight).toBe(0);
  });

  it("keeps an admission message out of the caller-visible error", async () => {
    // Admission can reach workspace operations whose messages quote a path. Only the
    // stable refusal clause may travel to the caller, never the raw message.
    db.prepare("UPDATE team_runs SET state = 'blocked' WHERE id = 'run-1'").run();
    const { fake } = control();
    const result = await launcher(fake).launch(launchInput());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Run is not approved");
    expect(String(result.error)).not.toContain(directory);
    expect(String(result.error)).not.toContain(repo);
  });

  it("keeps a path-bearing workspace failure out of the caller-visible error", async () => {
    // The refusal above is decided before any workspace work, so it proves nothing
    // about a message that *does* quote a path. T048 made an entry *at* the candidate
    // path recoverable (it is quarantined and the task proceeds), so the failure this
    // case needs now comes from the directory above it: with `assignments/<worker>` a
    // file, the workspace layer's own `mkdir` fails and its message names the absolute
    // path. That message must not reach the caller.
    const workerRoot = join(assignmentRoot, "ma-worker1");
    rmSync(workerRoot, { recursive: true, force: true });
    writeFileSync(workerRoot, "not a directory");
    const { fake, calls } = control();
    const result = await launcher(fake).launch(launchInput());
    expect(result.ok).toBe(false);
    // The clause is the stable one, so the caller can still classify the refusal.
    expect(String(result.error)).toContain("admission refused");
    expect(String(result.error)).not.toContain(candidateDir("ma-worker1"));
    expect(String(result.error)).not.toContain(directory);
    // And no privileged call happened for the refused assignment.
    expect(calls.preflight).toBe(0);
  });

  it("releases the candidate when a refusal happens after admission", async () => {
    // The tree mismatch is a post-admission refusal: the candidate existed, so it
    // must not outlive the refused launch.
    const { fake } = control({ assignedTree: repo });
    const result = await launcher(fake).launch(launchInput());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/managed_candidate_mismatch/);
    expect(existsSync(candidateDir("ma-worker1"))).toBe(false);
  });

  it("does not release a candidate a different, still-live attempt owns", async () => {
    // A task's candidate is shared by every attempt that launches into it. Attempt A
    // holds the tree and is still working in it. Attempt B is refused *after*
    // admission — the one path that can delete an attempt's tree — and must release
    // only its own claim, never A's work.
    const tree = candidateDir("ma-worker1");
    runtime.admitForLaunch("run-1", { attemptId: "attempt-live", worker: "ma-worker1",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });
    expect(existsSync(tree)).toBe(true);
    const refused = await launcher(control({ assignedTree: repo }).fake).launch(launchInput());
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/managed_candidate_mismatch/);
    // B's release left A's claim — and therefore the tree — intact.
    expect(existsSync(tree)).toBe(true);
    // Only when the last owner lets go does the tree leave.
    runtime.releaseCandidate("run-1", "T039", "attempt-live");
    expect(existsSync(tree)).toBe(false);
  });

  it("does not leave a refused attempt owning the candidate", () => {
    // A refusal that happens after the candidate exists but before it is handed
    // out must not leave a claim behind: the reference count would then hold the
    // tree forever, because no release ever names that attempt. T048 made an entry
    // at the candidate path recoverable, so the refusal has to come from the
    // workspace layer failing for another reason — a file where the worker's
    // assignment directory belongs — and the task must still be admissible once
    // that is cleared.
    const workerRoot = join(assignmentRoot, "ma-worker1");
    rmSync(workerRoot, { recursive: true, force: true });
    writeFileSync(workerRoot, "not a directory");
    expect(() => runtime.candidateFor("run-1", "T039", "ma-worker1")).toThrow();
    rmSync(workerRoot, { force: true });
    mkdirSync(workerRoot, { recursive: true });
    runtime.admitForLaunch("run-1", { attemptId: "attempt-after-refusal", worker: "ma-worker1",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });
    runtime.releaseCandidate("run-1", "T039", "attempt-after-refusal");
    expect(existsSync(candidateDir("ma-worker1"))).toBe(false);
  });

  it("releases a candidate invalidated by a moved source instead of stranding it", () => {
    // A candidate whose source moved is refused at every reuse, but the tree is still
    // on disk and its owners are the only ones who can release it. Dropping the
    // record at refusal would leave the bytes with nothing able to remove them, and
    // the next attempt's `git worktree add` would then fail on the occupied path,
    // wedging the task until someone deleted the directory by hand.
    const tree = candidateDir("ma-worker1");
    const before = readFileSync(join(repo, "src", "base.ts"), "utf8");
    runtime.admitForLaunch("run-1", { attemptId: "attempt-invalidated", worker: "ma-worker1",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });
    expect(existsSync(tree)).toBe(true);
    writeFileSync(join(repo, "src", "base.ts"), "export const base = 9;\n");
    expect(() => runtime.candidateFor("run-1", "T039")).toThrow(/Source checkout changed/);
    // Refused again, not silently re-created.
    expect(() => runtime.candidateFor("run-1", "T039")).toThrow(/Source checkout changed/);
    // The owner can still release it, and the tree actually goes away.
    runtime.releaseCandidate("run-1", "T039", "attempt-invalidated");
    expect(existsSync(tree)).toBe(false);
    writeFileSync(join(repo, "src", "base.ts"), before);
  });

  it("re-enters a candidate that is already on disk after a restart", () => {
    // A restart forgets the in-memory record but not the tree. A resumed task whose
    // candidate survived must adopt that tree: `git worktree add` refuses an
    // existing path, so a fresh runtime that tried to stage a second one would make
    // the task unlaunchable and strand its work in a directory nothing names.
    const created = runtime.candidateFor("run-1", "T039");
    // A second runtime over the same database: the same shape a restarted daemon has.
    const restarted = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId), assignmentRoot: () => assignmentRoot,
      defaultWorker: () => "ma-worker1" });
    const adopted = restarted.candidateFor("run-1", "T039");
    expect(adopted.root).toBe(created.root);
    // The adopted tree is held to the same checks as a created one.
    expect(restarted.candidateSourceUnchanged("run-1", "T039").unchanged).toBe(true);
    expect(candidateManifest(adopted).files.map(file => file.path)).toContain("src/base.ts");
    // And a moved source still refuses it, so adoption is not a way around the check.
    const before = readFileSync(join(repo, "src", "base.ts"), "utf8");
    writeFileSync(join(repo, "src", "base.ts"), "export const base = 3;\n");
    expect(() => restarted.candidateFor("run-1", "T039")).toThrow(/Source checkout changed/);
    writeFileSync(join(repo, "src", "base.ts"), before);
  });

  it("reuses the recorded candidate instead of creating a second one, and blocks once the source moves", () => {
    const first = runtime.candidateFor("run-1", "T039");
    expect(runtime.candidateFor("run-1", "T039")).toBe(first);
    const before = readFileSync(join(repo, "src", "base.ts"), "utf8");
    // A candidate is evidence only while the checkout it was staged from is
    // unmoved; a later owner edit invalidates it rather than silently rebasing.
    writeFileSync(join(repo, "src", "base.ts"), "export const base = 2;\n");
    expect(() => runtime.candidateFor("run-1", "T039")).toThrow(/Source checkout changed/);
    writeFileSync(join(repo, "src", "base.ts"), before);
  });

  it("binds the review packet to the candidate's own manifest digest", () => {
    const identity = runtime.candidateIdentityFor("run-1", "T039");
    const manifest = candidateManifest(runtime.candidateFor("run-1", "T039"));
    expect(identity.manifestDigest).toBe(manifest.manifestDigest);
    const packet = runtime.reviewPacketFor("run-1", "T039", join(directory, "packet"));
    expect(packet.identity.manifestDigest).toBe(identity.manifestDigest);
    expect(verifyReviewPacket(packet).unchanged).toBe(true);
  });

  it("refuses a candidate root outside the kernel's assignment root", () => {
    const outside = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: () => join(directory, "elsewhere", "T039"), assignmentRoot: () => assignmentRoot,
      defaultWorker: () => "ma-worker1" });
    expect(() => outside.candidateFor("run-1", "T039")).toThrow(/outside the assignment root/);
  });

  it("refuses to isolate when the runtime was given no candidate root", () => {
    const unconfigured = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
    expect(() => unconfigured.candidateFor("run-1", "T039")).toThrow(/not configured/);
  });

  it("keeps the source checkout's dirty-file hashes across candidate creation", () => {
    writeFileSync(join(repo, "src", "dirty.ts"), "export const dirty = true;\n");
    const fingerprintBefore = JSON.stringify(resolveWorkspaceBase(repo).kind);
    runtime.candidateFor("run-1", "T039");
    expect(JSON.stringify(resolveWorkspaceBase(repo).kind)).toBe(fingerprintBefore);
    expect(runtime.candidateSourceUnchanged("run-1", "T039").unchanged).toBe(true);
    // The checkout still holds the owner's own bytes and no new commit.
    expect(readFileSync(join(repo, "src", "dirty.ts"), "utf8")).toBe("export const dirty = true;\n");
    expect(git(repo, "status", "--porcelain=v1").trim()).toBe("?? src/dirty.ts");
  });

  // T043: a reviewer launches into the exact candidate the implementer produced.
  //
  // The fixture already records `T039` as a live implementer claiming `src` (see
  // `beforeEach`), so that is the task under review. Extra implementer rows below claim
  // paths none of these cases use, because two live claims on one path refuse the graph
  // before the review link is ever consulted.
  describe("a reviewer launches into the candidate it reviews", () => {
    /** Record another implementer row: the link is checked against recorded authority. */
    const recordImplementer = (taskId: string, paths = ["test/other"]) => {
      db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
        VALUES (?, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', 'lead@rig-1', ?, 'in-progress', 'body')`)
        .run(`item-${taskId}`, `session-${taskId}`);
      db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json)
        VALUES (?, 'run-1', ?, ?)`)
        .run(`item-${taskId}`, taskId, JSON.stringify({ taskId, role: "implementer", paths, dependencies: [] }));
    };
    const reviewer = (reviewOf?: string) => {
      const assignment = { taskId: "T043-review", role: "reviewer" as const,
        ...(reviewOf === undefined ? {} : { reviewOf }), paths: ["src"], dependencies: [] };
      return { assignment,
        context: { ...contextFor({ role: "reviewer" }), assignment, outputs: [],
          permissions: ["submit-review"] } as unknown as ContextManifest };
    };
    const admitReview = (reviewOf?: string, worker = "ma-worker1", attemptId = `attempt-review-${++attemptSeq}`) => {
      const { assignment, context: reviewContext } = reviewer(reviewOf);
      return runtime.admitForLaunch("run-1", { attemptId, worker, assignment, outputs: [],
        permissions: ["submit-review"], context: reviewContext });
    };
    const admitImplementer = (attemptId: string) =>
      runtime.admitForLaunch("run-1", { attemptId, worker: "ma-worker1",
        assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });

    it("hands the reviewer the implementer's tree, not a freshly staged one", () => {
      // The defect this closes: the reviewer's own candidate was a pristine checkout, so
      // it reviewed code nobody wrote. The tree under review is the implementer's.
      const implementer = admitImplementer("attempt-impl-link");
      const review = admitReview("T039");
      expect(review.candidate).toBe(implementer.candidate);
      expect(review.manifestDigest).toBe(implementer.manifestDigest);
      // And nothing was staged under the reviewer's own task id.
      expect(existsSync(candidateDir("ma-worker1", "run-1", "T043-review"))).toBe(false);
    });

    it("resolves the reviewed tree for a launch, and never stages one", () => {
      // `assignedTreeFor` is what startup's composition calls, so this exercises the
      // production decision rather than a re-implementation. Reverting the review branch
      // there makes the first assertion fail.
      const implementer = admitImplementer("attempt-impl-assigned");
      expect(runtime.assignedTreeFor("run-1", { taskId: "T043-review", reviewOf: "T039" })).toBe(implementer.candidate);
      // A review never creates: with no candidate for the named task it refuses rather
      // than staging a tree at that task's path.
      recordImplementer("T039-assigned-missing");
      expect(() => runtime.assignedTreeFor("run-1", { taskId: "T043-review", reviewOf: "T039-assigned-missing" }))
        .toThrow(/no candidate/i);
      expect(existsSync(candidateDir("ma-worker1", "run-1", "T039-assigned-missing"))).toBe(false);
      // An assignment with no link still resolves its own tree.
      expect(runtime.assignedTreeFor("run-1", { taskId: "T039" })).toBe(implementer.candidate);
    });

    it("adopts the reviewed tree after a restart instead of refusing it", () => {
      // A restart forgets the in-memory record but not the tree, which control-owned
      // provenance still accounts for. Refusing here would make a review impossible after
      // any daemon restart while the implementer's work sits on disk.
      const implementer = admitImplementer("attempt-impl-restart");
      const restarted = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
        candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId), assignmentRoot: () => assignmentRoot,
        defaultWorker: () => "ma-worker1" });
      const reviewContext = { ...contextFor({ role: "reviewer" }),
        assignment: { taskId: "T043-review", role: "reviewer", reviewOf: "T039", paths: ["src"], dependencies: [] },
        outputs: [], permissions: ["submit-review"] } as unknown as ContextManifest;
      const review = restarted.admitForLaunch("run-1", { attemptId: "attempt-review-restart", worker: "ma-worker1",
        assignment: reviewContext.assignment, outputs: [], permissions: ["submit-review"], context: reviewContext });
      expect(review.candidate).toBe(implementer.candidate);
      // Adopted, not staged: no second tree appeared.
      expect(existsSync(candidateDir("ma-worker1", "run-1", "T043-review"))).toBe(false);
    });

    it("does not mistake a workerless reader's adoption for another worker's tree", () => {
      // The packet and identity accessors name no worker, so their adoption records no
      // owner. A review on the worker whose directory holds that tree must keep it rather
      // than re-home it — re-homing would delete the candidate the review is about to enter.
      const implementer = admitImplementer("attempt-impl-reader");
      const restarted = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
        candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId), assignmentRoot: () => assignmentRoot,
        defaultWorker: () => "ma-worker1" });
      expect(restarted.candidateFor("run-1", "T039").root).toBe(implementer.candidate);
      const reviewContext = { ...contextFor({ role: "reviewer" }),
        assignment: { taskId: "T043-review", role: "reviewer", reviewOf: "T039", paths: ["src"], dependencies: [] },
        outputs: [], permissions: ["submit-review"] } as unknown as ContextManifest;
      const review = restarted.admitForLaunch("run-1", { attemptId: "attempt-review-reader", worker: "ma-worker1",
        assignment: reviewContext.assignment, outputs: [], permissions: ["submit-review"], context: reviewContext });
      expect(review.candidate).toBe(implementer.candidate);
    });

    it("refuses a review on another worker without destroying the reviewed tree", () => {
      // A refused review must not be able to delete what it was asked to review. Re-homing
      // is a mutation — it drops the record and asks for the tree's removal — so an
      // adopt-only caller must refuse without touching anything. Before this rule the
      // delegation through `candidateFor` deregistered and removed the implementer's
      // candidate on the way to refusing on a different worker.
      const implementer = admitImplementer("attempt-impl-cross");
      const restarted = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
        candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId), assignmentRoot: () => assignmentRoot,
        defaultWorker: () => "ma-worker1" });
      // A workerless reader adopts it, which leaves the owner unrecorded — the state in
      // which a cross-worker launch used to look like an unclaimed tree worth re-homing.
      expect(restarted.candidateFor("run-1", "T039").root).toBe(implementer.candidate);
      const reviewContext = { ...contextFor({ role: "reviewer" }),
        assignment: { taskId: "T043-review", role: "reviewer", reviewOf: "T039", paths: ["src"], dependencies: [] },
        outputs: [], permissions: ["submit-review"] } as unknown as ContextManifest;
      expect(() => restarted.admitForLaunch("run-1", { attemptId: "attempt-review-cross", worker: "ma-worker2",
        assignment: reviewContext.assignment, outputs: [], permissions: ["submit-review"], context: reviewContext }))
        .toThrow(/different worker/i);
      // The implementer's work is still on disk, and still reachable by the worker that owns it.
      expect(existsSync(implementer.candidate)).toBe(true);
      expect(readFileSync(join(implementer.candidate, "src", "base.ts"), "utf8")).toBe("export const base = 1;\n");
      const again = admitReview("T039", "ma-worker1");
      expect(again.candidate).toBe(implementer.candidate);
    });

    it("refuses a review link carried by a writable role", () => {
      // The read-only guarantee must not rest on the parser alone: admission picks the tree
      // and the mount access, so a writable role carrying a link is refused here.
      admitImplementer("attempt-impl-role");
      const writable = { ...contextFor(), assignment: { taskId: "T043-review", role: "implementer" as const,
        reviewOf: "T039", paths: ["src"], dependencies: [] } } as unknown as ContextManifest;
      expect(() => runtime.admitForLaunch("run-1", { attemptId: "attempt-impl-linked", worker: "ma-worker1",
        assignment: writable.assignment, outputs: ["src/result.ts"], permissions: ["write-assigned-tree"], context: writable }))
        .toThrow(/not this run's implementer/i);
    });

    it("refuses a review whose target has no candidate instead of staging one", () => {
      // A missing candidate is a refusal, not a cue to build a tree: staging here would
      // hand the reviewer a checkout nobody wrote, which is the defect itself.
      recordImplementer("T039-uncandidated");
      expect(() => admitReview("T039-uncandidated")).toThrow(/no candidate/i);
      expect(existsSync(candidateDir("ma-worker1", "run-1", "T039-uncandidated"))).toBe(false);
    });

    it("refuses a review whose target is not this run's implementer", () => {
      // The link resolves from recorded authority, so a launch cannot name a task the run
      // never recorded, nor one recorded under another role.
      expect(() => admitReview("T999")).toThrow(/not this run's implementer/i);
      db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
        VALUES ('item-reviewer-row', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', 'lead@rig-1', 's', 'in-progress', 'body')`).run();
      db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json)
        VALUES ('item-reviewer-row', 'run-1', 'T043-otherreview', ?)`)
        .run(JSON.stringify({ taskId: "T043-otherreview", role: "reviewer", paths: ["test/other"], dependencies: [] }));
      expect(() => admitReview("T043-otherreview")).toThrow(/not this run's implementer/i);
    });

    it("refuses a reviewed candidate held by a different worker", () => {
      // The control mounts only trees under the launching worker's directory, so a
      // reviewer on another worker could never be given this tree.
      admitImplementer("attempt-impl-worker");
      expect(() => admitReview("T039", "ma-worker2", "attempt-review-worker")).toThrow(/different worker/i);
    });

    it("never lets a review attempt own the tree it reads", () => {
      // A review reads a tree another task owns. If it took a claim on that tree, the
      // implementer's own release would find the count still non-zero and the candidate
      // would survive for the daemon's life (R2-2), and a refused review could delete it
      // (R2-1). So the review takes no claim: after both attempts release, the tree is
      // gone with the implementer's claim alone.
      admitImplementer("attempt-impl-release");
      admitReview("T039", "ma-worker1", "attempt-review-release");
      expect(existsSync(candidateDir("ma-worker1", "run-1", "T039"))).toBe(true);
      // The reviewer's own release (what the launcher does for it) changes nothing.
      runtime.releaseCandidate("run-1", "T043-review", "attempt-review-release");
      // The implementer's release is the last claim, so the tree goes — unless the review
      // left a claim behind, in which case it survives and this fails.
      runtime.releaseCandidate("run-1", "T039", "attempt-impl-release");
      expect(existsSync(candidateDir("ma-worker1", "run-1", "T039"))).toBe(false);
    });

    it("does not delete the reviewed tree when a review launch is refused", async () => {
      // R2-1: after a restart the implementer's tree has no in-memory claim, so a review
      // that adopted it and then took a claim would be its *only* owner. Any post-admission
      // refusal — here a candidate mismatch — would then delete the work it was asked to
      // review. This is the restart shape the older release test missed by keeping the
      // implementer's attempt live.
      const implementer = admitImplementer("attempt-impl-refused");
      const restarted = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
        candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId), assignmentRoot: () => assignmentRoot,
        defaultWorker: () => "ma-worker1" });
      const reviewContext = { ...contextFor({ role: "reviewer" }),
        assignment: { taskId: "T043-review", role: "reviewer", reviewOf: "T039", paths: ["src"], dependencies: [] },
        outputs: [], permissions: ["submit-review"] } as unknown as ContextManifest;
      const refused = await launcher(control({ assignedTree: repo }).fake, restarted)
        .launch({ client: "claude-code", attempt: { attemptId: "attempt-review-refused",
          deadline: Date.now() + 60_000, context: { ...reviewContext, projection: projectionFor("attempt-review-refused") } } });
      expect(refused.ok).toBe(false);
      expect(String(refused.error)).toMatch(/managed_candidate_mismatch/);
      // The implementer's work is untouched, and still reachable.
      expect(existsSync(implementer.candidate)).toBe(true);
      expect(readFileSync(join(implementer.candidate, "src", "base.ts"), "utf8")).toBe("export const base = 1;\n");
    });

    it("parses the link only on a reviewer, and never onto itself", () => {
      // The contract is the boundary: a non-reviewer naming a target, or a reviewer naming
      // itself, would point a launch at a tree the task does not have.
      const base = { taskId: "R1", role: "reviewer", paths: ["src"], dependencies: [] };
      expect(parseAssignment({ ...base, reviewOf: "T039" })).toMatchObject({ reviewOf: "T039" });
      expect(parseAssignment(base)).not.toHaveProperty("reviewOf");
      expect(() => parseAssignment({ ...base, role: "implementer", reviewOf: "T039" })).toThrow();
      expect(() => parseAssignment({ ...base, reviewOf: "R1" })).toThrow();
      expect(() => parseAssignment({ ...base, reviewOf: "" })).toThrow();
    });
  });
});