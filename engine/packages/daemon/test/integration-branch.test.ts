import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TEAM_CONTROL_VERSION, type ControlRequest, type PlanBinding } from "../src/contracts/team-control.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { composeIntegration, type Integration } from "../src/domain/integration-branch.js";
import { commitPlan, ensurePlanWorktree, runSlug } from "../src/domain/plan-branch.js";
import { bindingForGoal, refreshPlanBinding, unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { taskCompletionEvidence } from "../src/domain/task-completion.js";
import { classificationFor } from "../src/domain/attempt-failure.js";
import { composeAttemptCompletion, type AttemptCompletion } from "../src/domain/attempt-completion.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { createTestApp } from "./helpers/test-app.js";

/**
 * U7 — approved work lands on the run's branch, and the owner merges once.
 *
 * Everything here is real git over a real repository: the run is bound to the daemon worktree
 * U5 creates, the candidates are staged by the real runtime, and the patch that lands is the
 * candidate's own. The one thing the fixture decides is *when* an approval is recorded, which
 * is what lets an in-flight candidate be staged from a head the branch then moves past.
 */

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const policy = unisolatedPolicyCapability(4);
const unusedUsage = { activeMs: 0, inputTokens: { value: null, reason: "unobserved" },
  outputTokens: { value: null, reason: "unobserved" }, costUsd: { value: null, reason: "unobserved" } };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(parent: string): string {
  const root = realpathSync(mkdtempSync(join(parent, "owner-")));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** A worktree is sealed read-only by git; open every directory before removing the scratch tree. */
function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

describe("U7 integration branch and merge", () => {
  let directory: string, repo: string, worktrees: string, assignments: string, dbPath: string;
  let db: Database.Database, bus: EventBus, queue: QueueRepository, governance: PlanGovernance;
  let runtime: WorkflowRuntime, integration: Integration, binding: PlanBinding;
  let runId: string, serial = 0;

  const runName = "Add the health endpoint";
  const branch = () => runSlug({ runId, name: runName });

  const request = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId, actionId,
    expectedEntityVersion: governance.getRun(runId).entityVersion,
    idempotencyKey: `u7-${++serial}`, payload,
  });

  /** The run's current binding, read the way every production caller reads it. */
  const currentBinding = () => refreshPlanBinding(governance.getRun(runId).binding, policy);

  const open = () => {
    db = createDb(dbPath);
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => policy);
  };

  /** Compose the runtime and the integration owner over the current database connection. */
  const compose = () => {
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (id, taskId, worker) => join(assignments, worker, `${id}-${taskId}`),
      assignmentRoot: () => assignments, defaultWorker: () => "worker1" });
    integration = composeIntegration({ db, governance, worktreeRoot: () => worktrees,
      candidateManifest: (id, taskId) => runtime.candidateManifestFor(id, taskId),
      currentBinding, log: () => {} });
  };

  /** The commit the run's worktree has out, which is the branch head. */
  const head = () => git(governance.getRun(runId).binding.repository.root, "rev-parse", "HEAD").trim();

  /** Write one file into a task's candidate, as the agent's turn would. */
  const stage = (taskId: string, path: string, content: string) => {
    const workspace = runtime.candidateFor(runId, taskId, "worker1");
    writeFileSync(join(workspace.root, path), content);
    return workspace;
  };

  const admit = (taskId: string, role: "implementer" | "reviewer", seat: string, extra: Record<string, unknown> = {}) =>
    governance.createTask(request(taskId, {
      assignment: { taskId, role, paths: ["src"], dependencies: [], ...extra },
      outputs: [], permissions: role === "reviewer" ? ["read-assigned-tree"] : ["write-assigned-tree"],
      sourceSession: "lead@rig", destinationSession: seat, body: `Implement ${taskId}`,
    }), currentBinding());

  /** Start one attempt for a task, as a launch's receipt does. */
  const startAttempt = (taskId: string, attemptId: string, role: "implementer" | "reviewer") => {
    const task = governance.findTask(runId, taskId)!;
    const recorded = governance.recordAttempt(request(attemptId, {
      qitemId: task.qitemId, role, provider: "claude",
      identity: { nativeSessionId: `native-${attemptId}`, tmuxServer: "/tmp/tmux.sock", paneId: "%1",
        processId: 4242, processStart: `${attemptId}-start`, generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage: unusedUsage,
    }), currentBinding());
    expect(recorded.status, JSON.stringify(recorded)).toBe("observed");
    return recorded;
  };

  /** Observe that attempt's process gone, as the daemon's sweep does. */
  const stopAttempt = (attemptId: string) => {
    governance.recordUsage({
      protocolVersion: TEAM_CONTROL_VERSION, runId, actionId: attemptId,
      expectedEntityVersion: governance.getRun(runId).entityVersion,
      idempotencyKey: `stop-${attemptId}`,
      payload: { expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion, state: "stopped", usage: unusedUsage },
    });
    return attemptId;
  };

  const attempt = (taskId: string, attemptId: string, role: "implementer" | "reviewer") => {
    startAttempt(taskId, attemptId, role);
    return stopAttempt(attemptId);
  };

  /** Complete an implementer task from its own candidate, as the daemon's evidence read does. */
  const complete = (taskId: string) => {
    const attemptId = attempt(taskId, `attempt-${taskId}`, "implementer");
    const task = governance.findTask(runId, taskId)!;
    const manifest = runtime.candidateManifestFor(runId, taskId);
    const evidence = taskCompletionEvidence({ role: "implementer", assignmentPaths: task.assignment.paths, manifest });
    expect(evidence.validated, evidence.reasons.join("; ")).toBe(true);
    const outcome = governance.recordTaskOutcome(request(task.qitemId, {
      expectedTaskVersion: task.entityVersion, state: "done", closureReason: "no-follow-on",
      actorSession: "impl@rig", attemptId, expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion,
      evidence,
    }), { kind: "daemon", sessionId: "daemon" });
    expect(outcome.status, JSON.stringify(outcome)).toBe("observed");
    return outcome;
  };

  /** Approve the review round the implementer's completion created. */
  const approveReview = (implementerTaskId: string) => {
    const reviewer = governance.findTask(runId, `${implementerTaskId}-review-1`)!;
    const attemptId = attempt(reviewer.assignment.taskId, `attempt-${implementerTaskId}-review`, "reviewer");
    const outcome = governance.recordTaskOutcome(request(reviewer.qitemId, {
      expectedTaskVersion: governance.getTask(reviewer.qitemId)!.entityVersion, state: "done", closureReason: "no-follow-on",
      actorSession: "review@rig", attemptId, expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion,
      evidence: { findings: [] },
    }), { kind: "daemon", sessionId: "daemon" });
    expect(outcome.status, JSON.stringify(outcome)).toBe("observed");
    expect((outcome.value as { review?: { verdict?: string } }).review?.verdict).toBe("approved");
    return outcome;
  };

  beforeEach(() => {
    serial = 0;
    directory = realpathSync(mkdtempSync(join(tmpdir(), "u7-integration-")));
    repo = repository(directory);
    worktrees = join(directory, "worktrees");
    assignments = join(directory, "assignments");
    mkdirSync(join(assignments, "worker1"), { recursive: true });
    dbPath = join(directory, "team.db");
    runId = "run-1";
    open();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'demo')").run();
    // The run is bound exactly where U5 leaves it after plan approval: the daemon's own
    // worktree, on the run's branch, with the approved plan committed there.
    const worktree = ensurePlanWorktree({ repositoryRoot: repo, worktreeRoot: worktrees, runId, name: runName }).path;
    commitPlan({ worktree, planRef: "plan.md", plan: "# Plan\n\nAdd the health endpoint.\n", message: `plan: ${runName}` });
    binding = bindingForGoal({ root: worktree, planRef: "plan.md", writePaths: ["src"], policy });
    governance.createRun({ id: runId, rigId: "rig", binding, reviewerSeat: "review@rig", displayName: runName });
    governance.requestApproval(request("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), { kind: "worker", sessionId: "lead@rig" });
    const decided = governance.decideApproval(request("implementation", { approvalVersion: 1, decision: "approved" }),
      owner, binding);
    expect(decided.status).toBe("accepted");
    compose();
    expect(admit("task-a", "implementer", "impl@rig").status).toBe("accepted");
  });

  afterEach(() => {
    if (db?.open) db.close();
    // The daemon's worktrees are registered in the owner repository's admin directory; the
    // scratch tree is removed whole, so git's own bookkeeping does not need unwinding.
    if (directory) { writable(directory); rmSync(directory, { recursive: true, force: true }); }
  });

  it("lands two approved tasks as two commits in approval order, and never touches the owner's checkout", async () => {
    const ownerHead = git(repo, "rev-parse", "HEAD").trim();
    const ownerStatus = git(repo, "status", "--porcelain=v1").trim();
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    stage("task-b", "src/metrics.ts", "export const metrics = () => ({});\n");

    complete("task-a");
    approveReview("task-a");
    // The first approval landed before the second was approved, which is what makes the
    // second candidate an in-flight one.
    const first = await integration.integrate(runId, "task-a");
    expect(first.status).toBe("committed");
    complete("task-b");
    approveReview("task-b");
    const second = await integration.integrate(runId, "task-b");
    expect(second.status).toBe("committed");

    const root = governance.getRun(runId).binding.repository.root;
    expect(git(root, "log", "--format=%s", "-2").trim().split("\n")).toEqual(["Implement task-b", "Implement task-a"]);
    expect(git(root, "log", "-1", "--format=%b")).toContain(`Run: ${runName}`);

    const status = integration.status(runId);
    expect(status.branch).toBe(branch());
    expect(status.commits.map(commit => commit.task)).toEqual(["task-a", "task-b"]);
    expect(status.commits.map(commit => commit.hash)).toEqual([first.commitSha!.slice(0, 7), second.commitSha!.slice(0, 7)]);
    expect(status.tasksDone).toBe(true);
    expect(status.merge.possible).toBe(true);

    // The owner's checkout is exactly where it was: no branch, commit, or working-tree change.
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(ownerHead);
    expect(git(repo, "status", "--porcelain=v1").trim()).toBe(ownerStatus);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  it("keeps an in-flight candidate's recorded base and applies it on top of the moved head", async () => {
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    // Both tasks start from the same head; the second candidate is staged before anything lands.
    const a = stage("task-a", "src/shared.ts", "export const shared = 'a';\n");
    const b = stage("task-b", "src/other.ts", "export const other = 'b';\n");
    expect(b.base).toMatchObject({ kind: "commit", commit: a.base.kind === "commit" ? a.base.commit : "" });
    const stagedAt = b.base.kind === "commit" ? b.base.commit : "";

    complete("task-a");
    approveReview("task-a");
    expect((await integration.integrate(runId, "task-a")).status).toBe("committed");
    expect(head()).not.toBe(stagedAt);

    // The candidate was staged from a head the branch has moved past, and the daemon can still
    // read it: it keeps its own base, and its patch lands on top of the landed work.
    const manifest = runtime.candidateManifestFor(runId, "task-b");
    expect(manifest.baseIdentifier).toBe(stagedAt);
    complete("task-b");
    approveReview("task-b");
    expect((await integration.integrate(runId, "task-b")).status).toBe("committed");

    const root = governance.getRun(runId).binding.repository.root;
    expect(git(root, "show", "--format=", "--name-only", "HEAD").trim()).toBe("src/other.ts");
    expect(git(root, "show", "--format=", "--name-only", "HEAD~1").trim()).toBe("src/shared.ts");
    expect(git(root, "log", "--format=%s", "-1").trim()).toBe("Implement task-b");
  });

  it("fails the task with integration_conflict and leaves the branch unchanged when the patch will not apply", async () => {
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-a", "src/shared.ts", "export const shared = 'a';\n");
    stage("task-b", "src/shared.ts", "export const shared = 'b';\n");

    complete("task-a");
    approveReview("task-a");
    const landed = await integration.integrate(runId, "task-a");
    expect(landed.status).toBe("committed");
    const headAfterA = head();

    complete("task-b");
    approveReview("task-b");
    const conflict = await integration.integrate(runId, "task-b");
    expect(conflict.status).toBe("conflict");

    // The branch is exactly where the first approval left it.
    expect(head()).toBe(headAfterA);
    expect(integration.status(runId).commits.map(commit => commit.task)).toEqual(["task-a"]);
    // The task is failed, named, and never retried: replaying the same patch fails the same way.
    const task = governance.findTask(runId, "task-b")!;
    expect(governance.queueState(task.qitemId)).toBe("failed");
    expect(task.evidence).toMatchObject({ reasonCode: "integration_conflict" });
    expect(String(task.evidence?.integrationConflict)).toMatch(/patch|conflict|merge/i);
    expect(classificationFor("integration_conflict").retryEligible).toBe(false);
    const events = db.prepare(`SELECT payload FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.action') = 'task.outcome'`).all() as Array<{ payload: string }>;
    expect(events.map(event => JSON.parse(event.payload).payload.observedBy)).toContain("daemon");
    expect(integration.status(runId).tasksDone).toBe(false);
  });

  it("still refuses an in-flight candidate when the owner's own source moved", async () => {
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-b", "src/other.ts", "export const other = 1;\n");
    // The owner commits on their own branch while the candidate is staged. The daemon owns the
    // `team/` namespace, not this ref, so the candidate is refused exactly as it was before U7.
    writeFileSync(join(repo, "src", "owner.ts"), "export const owner = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "owner work");
    expect(() => runtime.candidateManifestFor(runId, "task-b")).toThrow(/Source checkout changed/);
  });

  it("lands the commit when the daemon's own sweep records an approving review", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    const turnRoot = join(directory, "turns");
    startAttempt("task-a", "attempt-sweep", "implementer");
    const completion: AttemptCompletion = composeAttemptCompletion({
      db, governance, currentBinding, alive: () => false, log: () => {}, turnStateRoot: turnRoot,
      sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() },
      candidateManifestFor: (id, taskId) => runtime.candidateManifestFor(id, taskId),
      integrateTask: (id, taskId) => integration.integrate(id, taskId),
    });
    await completion.sweep();
    expect(governance.findTask(runId, "task-a-review-1")?.assignment.role).toBe("reviewer");

    const reviewerAttempt = startAttempt("task-a-review-1", "attempt-review", "reviewer");
    const path = agentTurnOutputPaths(turnRoot, "attempt-review").lastMessage;
    mkdirSync(join(turnRoot, "turns", "attempt-review"), { recursive: true });
    writeFileSync(path, "```json\n" + JSON.stringify({ findings: [] }) + "\n```\n");
    expect(reviewerAttempt.status).toBe("observed");
    await completion.sweep();

    expect(integration.status(runId).commits.map(commit => commit.task)).toEqual(["task-a"]);
    const root = governance.getRun(runId).binding.repository.root;
    expect(git(root, "log", "--format=%s", "-1").trim()).toBe("Implement task-a");

    // A second sweep finds the commit already recorded, so it commits nothing twice.
    await completion.sweep();
    expect(integration.status(runId).commits).toHaveLength(1);
  });

  it("refuses a merge while work is open, fast-forwards a clean checkout, and refuses a dirty one", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    const stillOpen = integration.merge(runId);
    expect(stillOpen).toMatchObject({ status: "refused", code: "merge_tasks_open" });

    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");

    // A dirty owner checkout is refused before anything moves, and nothing does.
    const ownerHead = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "src", "base.ts"), "export const base = 2;\n");
    expect(integration.merge(runId)).toMatchObject({ status: "refused", code: "merge_checkout_dirty" });
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(ownerHead);
    git(repo, "checkout", "--", "src/base.ts");

    const merged = integration.merge(runId);
    expect(merged).toMatchObject({ status: "merged", mode: "fast-forward", branch: branch() });
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head());
    expect(git(repo, "show", "--format=", "--name-only", "HEAD").trim()).toBe("src/health.ts");
  });

  it("makes one merge commit when the owner's branch diverged, and aborts a conflicting merge", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");
    // The owner moves their own branch after the run's base, so a fast-forward is impossible.
    writeFileSync(join(repo, "src", "owner.ts"), "export const owner = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "owner works on main");

    const merged = integration.merge(runId);
    expect(merged.status).toBe("merged");
    expect(merged.mode).toBe("merge-commit");
    expect(git(repo, "log", "--format=%s", "-1").trim()).toBe(`Merge ${branch()}: ${runName}`);
    // Both histories are in the merged result: the owner's own commit and the run's work.
    expect(git(repo, "log", "--format=%s").trim().split("\n")).toEqual(expect.arrayContaining([
      "owner works on main", "Implement task-a", `Merge ${branch()}: ${runName}`]));

    // Now a run whose work conflicts with the owner's: the merge is refused, aborted, unchanged.
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    writeFileSync(join(repo, "src", "health.ts"), "export const health = 'owner version';\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "owner edits the same file");
    const conflictingHead = git(repo, "rev-parse", "HEAD").trim();
    stage("task-b", "src/health.ts", "export const health = 'team version';\n");
    complete("task-b");
    approveReview("task-b");
    await integration.integrate(runId, "task-b");
    const refused = integration.merge(runId);
    expect(refused).toMatchObject({ status: "refused", code: "merge_conflict" });
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(conflictingHead);
    expect(git(repo, "status", "--porcelain=v1").trim()).toBe("");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  it("finds the branch and worktree again after a restart, and keeps landing on it", async () => {
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");
    const firstHead = head();
    db.close();

    // A restart forgets every in-process record but not the run, its rows or the worktree.
    open();
    compose();
    const status = integration.status(runId);
    expect(status.branch).toBe(branch());
    expect(status.worktree).toBe(governance.getRun(runId).binding.repository.root);
    expect(status.commits.map(commit => commit.task)).toEqual(["task-a"]);

    stage("task-b", "src/metrics.ts", "export const metrics = () => ({});\n");
    complete("task-b");
    approveReview("task-b");
    expect((await integration.integrate(runId, "task-b")).status).toBe("committed");
    expect(git(status.worktree!, "rev-parse", "HEAD").trim()).not.toBe(firstHead);
    expect(integration.status(runId).commits.map(commit => commit.task)).toEqual(["task-a", "task-b"]);
  });

  it("serves the integration read and the merge to the owner only", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");

    const app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      workflowRuntime: runtime, integration,
      teamControl: { credentials: { ownerToken: "owner-fixture", workers: [{ token: "worker-fixture", sessionId: "impl@rig", runId: "other" }] },
        readPolicyCapability: () => policy, planWorktreeRoot: () => worktrees } } }).app;
    const call = (path: string, token: string, method: "GET" | "POST" = "GET", body?: unknown) =>
      app.request(`/api/team-control${path}`, { method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

    const read = await call(`/runs/${runId}/integration`, "owner-fixture");
    expect(read.status).toBe(200);
    const body = await read.json() as { integration: { branch: string; commits: Array<{ task: string }>; tasksDone: boolean; merge: { possible: boolean } } };
    expect(body.integration).toMatchObject({ branch: branch(), tasksDone: true, merge: { possible: true } });
    expect(body.integration.commits.map(commit => commit.task)).toEqual(["task-a"]);

    // A worker credential is scoped to its own run and never reads another run's delivery.
    expect((await call(`/runs/${runId}/integration`, "worker-fixture")).status).toBe(403);

    const mergeBody = { protocolVersion: "1.0", runId, actionId: runId,
      expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: "merge-route-1", payload: {} };
    const merged = await call(`/runs/${runId}/merge`, "owner-fixture", "POST", mergeBody);
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ status: "merged", mode: "fast-forward", branch: branch() });
    const again = await call(`/runs/${runId}/merge`, "owner-fixture", "POST", { ...mergeBody, idempotencyKey: "merge-route-2" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "merged", mode: "up-to-date" });
  });
});