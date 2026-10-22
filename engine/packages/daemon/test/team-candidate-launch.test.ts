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
    policy: { policy_revision: 5, worker_identities: ["ma-worker1"],
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
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan"),
      repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 5, policyFingerprint: hashBytes("policy"),
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
        // The control resolves the assigned tree from the installed policy; the
        // launcher must have admitted exactly that tree beforehand.
        const tree = options.assignedTree ?? candidateDir(ma-worker1, run-1, input.attempt.context.assignment.taskId);
        return ({ assignment: { binding, currentBinding: binding, assignment: input.attempt.context.assignment,
          outputs: [...input.attempt.context.outputs], permissions: [...input.attempt.context.permissions],
          context: input.attempt.context, observed: { discoveryRoots: [], files: [] }, dependencySatisfied: () => true },
          worker: { name: "ma-worker1", uid: 1001, gid: 1001, groups: [], home: "/var/lib/multi-agent/workers/ma-worker1/home",
            scratch: "/var/lib/multi-agent/workers/ma-worker1/scratch", tree },
          control: { uid: 1000, mountNamespace: "mnt:control", userNamespace: "user:control" },
          executable: "/opt/multi-agent/toolchain/clients/bin/claude", executableVersion: "fixture", generation: 1,
          policyFingerprint: binding.policyFingerprint, policyRevision: binding.policyRevision,
          clientLock: { digest: hashBytes("lock"), version: "fixture", files: [], observedFiles: [] },
          installedPolicy: { policy_revision: binding.policyRevision, worker_identities: ["ma-worker1"],
            paths: { context_root: join(directory, "context"), framework_dir: join(directory, "framework"),
              toolchain_dir: "/opt/multi-agent/toolchain", egress_socket_dir: "/run/multi-agent-egress" },
            sandbox: { network: "filtered-proxy", etc_ro_binds: [], masked_paths: [] } },
          network: { mode: "filtered-proxy", hostNamespace: "net:[100]", profileFingerprint: hashBytes("egress"), preflightRef: "evidence" },
          provider: { status: "signed_in", client: "claude-code", home: "/var/lib/multi-agent/workers/ma-worker1/home", evidenceRef: "evidence" },
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

  const launcher = (fake: WorkerLaunchControl) =>
    new RestrictedWorkerLauncher(fake, () => 1000, () => "native-session", admission);

  it("creates exactly one candidate for the task before the control preflights", async () => {
    let treeSeenByControl: string | undefined;
    const { fake, calls } = control({ observe: input => { treeSeenByControl = input.attempt.context.assignment.taskId; } });
    const result = await launcher(fake).launch(launchInput());
    // The launch stops at the privileged boundary, which this test never crosses.
    expect(result.ok).toBe(false);
    expect(calls.preflight).toBeGreaterThan(0);
    expect(treeSeenByControl).toBe("T039");
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

  it("admits a reviewer into the same candidate the implementer produced", async () => {
    // A reviewer's assigned tree is the candidate, not the seat's working
    // directory: the packet it receives is bound to that tree's manifest, so
    // launching it anywhere else would review something the implementer never
    // wrote. Admission returns the candidate for every role, so resolving the seat
    // tree here would refuse every reviewer launch after its privileged preflight.
    const implementer = runtime.admitForLaunch("run-1", { attemptId: "attempt-impl", worker: "ma-worker1",
      assignment: context.assignment, outputs: context.outputs, permissions: context.permissions, context });
    const reviewer = runtime.admitForLaunch("run-1", { attemptId: "attempt-review", worker: "ma-worker1",
      assignment: { taskId: "T039", role: "reviewer", paths: ["src"], dependencies: ["T011"] },
      outputs: [], permissions: ["submit-review"], context: contextFor({ role: "reviewer" }) });
    expect(reviewer.candidate).toBe(implementer.candidate);
    expect(reviewer.manifestDigest).toBe(implementer.manifestDigest);
  });

  it("refuses a candidate in another worker's assignment directory", async () => {
    // The kernel mounts a tree only under `assignment_root/<that attempt's worker>`,
    // so reusing a candidate across workers would hand a launch a tree the
    // privileged launcher rejects. The mismatch is refused before any of that.
    const first = runtime.candidateFor("run-1", "T039", "ma-worker1");
    expect(() => runtime.candidateFor("run-1", "T039", "ma-worker2")).toThrow(/different worker/);
    expect(runtime.candidateFor("run-1", "T039")).toBe(first);
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
    // about a message that *does* quote a path. Occupying the candidate directory
    // makes `git worktree add` fail from inside the workspace layer, whose message
    // names that absolute path. That message must not reach the caller.
    const occupied = candidateDir("ma-worker1");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "placeholder"), "occupied");
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
});