import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import { TEAM_CONTROL_VERSION, type TeamRun } from "../contracts/team-control.js";
import type { PlanGovernance } from "./plan-governance.js";
import { ensurePlanWorktree, planWorktreePath, runSlug } from "./plan-branch.js";
import { checkedOutBranch } from "./team-workspace.js";

/**
 * U7 / KTD7 — the branch the run's approved work lands on, and the owner's one merge.
 *
 * Every task whose review approves lands as one commit on `team/<run-slug>`, in the
 * daemon-owned worktree U5 already created for the run. The owner's checkout is never written
 * here; the merge is the only step that goes back into it, and it is the owner's own action.
 *
 * The hard part is what an in-flight candidate means once the branch moves. Two tasks start
 * from the same head; the first approval commits and moves it. The second task's candidate was
 * staged at the old head, and is still exactly the work its reviewer approved — so its patch is
 * applied to the new head with `git apply --3way`, and the base it recorded is kept as the
 * candidate's own record. Only a new task is staged from the new head (the runtime asks this
 * module's record which worktree is the delivery base). A candidate is refused as moved only
 * when the owner's own source changed, which is the check `verifySourceUnchanged` still makes.
 *
 * A patch that cannot be applied leaves the branch exactly as it was: the apply happens in the
 * daemon's worktree, every failure resets it to the head it started from, and the task is
 * recorded as failed with `integration_conflict` so the lead can resolve it against that head.
 */

export interface IntegrationCommit {
  /** The short hash, as the owner reads it. */
  hash: string;
  subject: string;
  /** The run's own task id, so the owner can tie a commit to the work it carries. */
  task: string;
}

export interface IntegrationStatus {
  runId: string;
  branch: string;
  repository: string | null;
  worktree: string | null;
  commits: IntegrationCommit[];
  /** Every task the run admitted as work has finished; a merge is not refused for an open one. */
  tasksDone: boolean;
  merge: { possible: boolean; reason: string | null };
}

export interface MergeOutcome {
  status: "merged" | "refused";
  code: string | null;
  reason: string | null;
  branch: string;
  mode: "fast-forward" | "merge-commit" | "up-to-date" | null;
  head: string | null;
}

export interface IntegrationResult {
  taskId: string;
  status: "committed" | "already-integrated" | "nothing-to-commit" | "conflict" | "skipped";
  commitSha: string | null;
  reason: string | null;
}

export interface IntegrationDeps {
  db: Database.Database;
  governance: PlanGovernance;
  /** Where the daemon's per-run worktrees live: the same root U5's plan worktree uses. */
  worktreeRoot: () => string;
  /** The candidate's own patch and manifest, the way `rig team apply` and the result read take it. */
  candidateManifest: (runId: string, taskId: string) => {
    base: "commit" | "snapshot"; baseIdentifier: string; patch: string; manifestDigest: string };
  /**
   * The run's current binding, read the way every control command reads it. Absent leaves the
   * recorded binding in place, which is right for a run bound to the owner's checkout: its
   * repository identity does not move when the daemon commits elsewhere.
   */
  currentBinding?: (runId: string) => unknown;
  log?: (message: string) => void;
}

export interface Integration {
  /** Land one approved task's patch on the run's branch. Serialised: one branch, one writer. */
  integrate(runId: string, taskId: string): Promise<IntegrationResult>;
  /** The branch, the commits on it, and whether the owner can merge now. Writes nothing. */
  status(runId: string): IntegrationStatus;
  /** Merge the branch into the owner's checkout. The owner's one delivery action. */
  merge(runId: string): MergeOutcome;
}

/** The daemon's own commit identity on the integration branch, as U5's plan commits use. */
const DAEMON_GIT_ENV = { GIT_AUTHOR_NAME: "openrig", GIT_AUTHOR_EMAIL: "openrig@localhost",
  GIT_COMMITTER_NAME: "openrig", GIT_COMMITTER_EMAIL: "openrig@localhost" };

function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 120_000,
    env: { ...process.env, ...DAEMON_GIT_ENV } });
}

function gitOrNull(cwd: string, args: readonly string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

function headOf(root: string): string {
  return git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  try { git(root, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch { return false; }
}

/** Anything uncommitted in a checkout. Untracked files are the owner's own drafts. */
function dirty(root: string): boolean {
  return git(root, ["status", "--porcelain=v1", "--untracked-files=no"]).trim() !== "";
}

/** The most useful lines of a failed git command, for the recorded conflict reason. */
function gitFailure(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer }).stderr;
  const text = (typeof stderr === "string" ? stderr : stderr?.toString("utf8") ?? "").trim();
  const informative = text.split("\n").map(line => line.trim())
    .filter(line => line && !/^hint:/i.test(line) && !/^warning:/i.test(line));
  return (informative.slice(0, 3).join("; ") || (error as Error).message).slice(0, 500);
}

/** The commit the run's plan was read at, when the binding names one. */
function baseCommit(run: TeamRun): string | undefined {
  const identity = run.binding.repository.identity;
  return identity.startsWith("git:") ? identity.slice(4) : undefined;
}

/** The branch and worktree this run delivers onto. */
interface Target { repository: string; worktree: string; branch: string }

export function composeIntegration(deps: IntegrationDeps): Integration {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const governance = deps.governance;
  // The branch has one writer. An integration waits for the one before it rather than racing it,
  // and a failed one never stops the queue behind it.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => T): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  /** The run's branch name. The record holds it once something landed; the slug derives it before. */
  const branchOf = (run: TeamRun): string =>
    governance.integrationRecord(run.id).branch ?? runSlug({ runId: run.id, name: run.displayName });

  /**
   * The owner's repository — the checkout `rig team merge` writes into.
   *
   * A planning run's binding root is already the run's own worktree, so the owner's repository
   * is the one that worktree was added to: a linked worktree's common git directory lives in
   * the main working tree. A run bound anywhere else is bound in the owner's checkout itself.
   */
  const repositoryOf = (run: TeamRun): string => {
    const recorded = governance.integrationRecord(run.id).repository;
    if (recorded !== null) return recorded;
    const root = realpathSync(run.binding.repository.root);
    if (checkedOutBranch(root) !== branchOf(run)) return root;
    const common = git(root, ["rev-parse", "--git-common-dir"]).trim();
    return dirname(isAbsolute(common) ? common : resolve(root, common));
  };

  /** The run's worktree, creating it at the run's base commit when the run has none yet. */
  const targetOf = (run: TeamRun): Target => {
    const recorded = governance.integrationRecord(run.id);
    if (recorded.worktree !== null && recorded.repository !== null && existsSync(recorded.worktree)) {
      return { repository: recorded.repository, worktree: recorded.worktree, branch: recorded.branch ?? branchOf(run) };
    }
    const repository = repositoryOf(run);
    const created = ensurePlanWorktree({ repositoryRoot: repository, worktreeRoot: deps.worktreeRoot(),
      runId: run.id, name: run.displayName, base: baseCommit(run) });
    return { repository, worktree: created.path, branch: created.branch };
  };

  /** The run's own work tasks the owner would still call open: the work, not the management. */
  const openTasks = (runId: string): Array<{ taskId: string; state: string }> =>
    (deps.db.prepare(`SELECT a.task_id AS taskId, q.state AS state FROM team_queue_authority a
      JOIN queue_items q ON q.qitem_id = a.qitem_id
      WHERE a.run_id = ? AND json_extract(a.assignment_json, '$.role') IN ('implementer', 'reviewer')`)
      .all(runId) as Array<{ taskId: string; state: string }>)
      .filter(task => task.state !== "done" && task.state !== "denied" && task.state !== "canceled");

  /**
   * Every task the run recorded as failed, whatever its role.
   *
   * `openTasks` asks only about the work tasks, which is what "still open" means. A failure is a
   * different question: a lead that never decomposed the plan has failed the run's delivery just
   * as an implementer has, and neither case may reach the owner's branch. The live acceptance
   * run showed the gap — its only task was the failed lead and `merge.possible` was true with no
   * commit landed.
   */
  const failedTasks = (runId: string): Array<{ taskId: string; state: string }> =>
    deps.db.prepare(`SELECT a.task_id AS taskId, q.state AS state FROM team_queue_authority a
      JOIN queue_items q ON q.qitem_id = a.qitem_id
      WHERE a.run_id = ? AND q.state = 'failed' ORDER BY a.rowid`).all(runId) as Array<{ taskId: string; state: string }>;

  /** The refusals both the readiness read and the merge itself must apply. */
  const blocked = (run: TeamRun): { reason: string } | null => {
    const failed = failedTasks(run.id);
    if (failed.length) return { reason: `Task(s) failed: ${failed.map(task => task.taskId).join(", ")}` };
    // A branch exists from the run's base commit, so "the branch exists" is not "work landed".
    // Without this, an owner could merge a branch that carries nothing but the plan.
    if (governance.integrationRecord(run.id).commits.length === 0) {
      return { reason: "No task's work has landed on the integration branch yet." };
    }
    return null;
  };

  /** Whether the owner's one merge would go through now, and what stops it when it would not. */
  const readiness = (run: TeamRun): { possible: boolean; reason: string | null } => {
    const open = openTasks(run.id);
    if (open.length) return { possible: false, reason: `Task(s) still open: ${open.map(task => task.taskId).join(", ")}` };
    const stopped = blocked(run);
    if (stopped) return { possible: false, reason: stopped.reason };
    let repository: string;
    try { repository = repositoryOf(run); } catch (error) { return { possible: false, reason: (error as Error).message }; }
    if (!existsSync(repository)) return { possible: false, reason: "The owner's repository is not on this machine." };
    if (dirty(repository)) return { possible: false, reason: "The owner's checkout has uncommitted changes." };
    if (checkedOutBranch(repository) === null) return { possible: false, reason: "The owner's checkout has no branch checked out." };
    if (gitOrNull(repository, ["rev-parse", "--verify", `refs/heads/${branchOf(run)}`]) === null) {
      return { possible: false, reason: "The integration branch does not exist yet." };
    }
    return { possible: true, reason: null };
  };

  /** Put the daemon's worktree back exactly where the attempt to land found it. */
  const restore = (worktree: string, before: string): void => {
    try { git(worktree, ["reset", "--hard", "--quiet", before]); } catch (error) {
      log(`team integration: the integration worktree could not be reset: ${gitFailure(error)}`);
    }
    // A failed three-way apply can leave files it created behind. The worktree is the daemon's
    // and was clean before the attempt, so anything untracked now came from the attempt.
    try { git(worktree, ["clean", "-fdq"]); } catch (error) {
      log(`team integration: the integration worktree could not be cleaned: ${gitFailure(error)}`);
    }
  };

  /** Apply one candidate's patch to the branch head and commit it there, or leave the branch alone. */
  const applyAndCommit = (worktree: string, patch: string, subject: string, body: string):
    { ok: true; commitSha: string } | { ok: false; reason: string } => {
    let before: string;
    try { before = headOf(worktree); } catch (error) {
      return { ok: false, reason: `the integration worktree could not be read: ${gitFailure(error)}` };
    }
    // The daemon is the only writer here. Anything uncommitted is left over from something the
    // daemon did not finish, and applying on top of it would commit work nobody approved.
    if (dirty(worktree)) {
      restore(worktree, before);
      return { ok: false, reason: "the integration worktree had uncommitted changes" };
    }
    try {
      // `--3way` is what makes an in-flight candidate land: its patch was computed against the
      // base it was staged from, and the branch head has moved past that base since.
      git(worktree, ["apply", "--3way", "-"], patch);
    } catch (error) {
      restore(worktree, before);
      return { ok: false, reason: gitFailure(error) };
    }
    try {
      git(worktree, ["commit", "--quiet", "-m", subject, "-m", body]);
    } catch (error) {
      restore(worktree, before);
      return { ok: false, reason: gitFailure(error) };
    }
    return { ok: true, commitSha: headOf(worktree) };
  };

  /**
   * Record that the approved work could not land.
   *
   * The task is failed through the same observed-outcome command every daemon outcome uses, with
   * the reason code that names this case, so a reader — and the lead's wake policy — sees one
   * kind of failure whichever half of the run failed. A failure to record it is logged rather
   * than thrown: the caller is a sweep, and a throw there would stop the next tick.
   */
  const conflict = (runId: string, task: { qitemId: string; assignment: { taskId: string } }, reason: string): IntegrationResult => {
    const attempt = governance.getLatestTaskAttempt(task.qitemId);
    const actorSession = governance.taskSeat(task.qitemId);
    const current = governance.getTask(task.qitemId);
    if (attempt === null || actorSession === null || current === null) {
      log(`team integration: ${task.assignment.taskId} did not apply and has no stopped attempt to record it against: ${reason}`);
      return { taskId: task.assignment.taskId, status: "conflict", commitSha: null, reason };
    }
    const outcome = governance.recordTaskOutcome({
      protocolVersion: TEAM_CONTROL_VERSION, runId, actionId: task.qitemId,
      expectedEntityVersion: governance.getRun(runId).entityVersion,
      idempotencyKey: `daemon-integration-conflict:${task.assignment.taskId}`,
      payload: { expectedTaskVersion: current.entityVersion, state: "failed", actorSession, attemptId: attempt.id,
        expectedAttemptVersion: attempt.entityVersion,
        evidence: { ...(current.evidence ?? {}), reasonCode: "integration_conflict", integrationConflict: reason },
        transitionNote: `Integration conflict: ${reason}` },
    }, { kind: "daemon", sessionId: "daemon" });
    if (outcome.status !== "observed" && !outcome.replayed) {
      log(`team integration: ${task.assignment.taskId} did not apply and the failure was not recorded: ${outcome.reason ?? outcome.status}`);
    }
    return { taskId: task.assignment.taskId, status: "conflict", commitSha: null, reason };
  };

  /** Land one task's work, from the candidate the run recorded for it. */
  const land = (run: TeamRun, task: { qitemId: string; assignment: { taskId: string } }, patch: string, target: Target): IntegrationResult => {
    const subject = governance.taskDisplayName(task.qitemId) ?? task.assignment.taskId;
    const body = `Run: ${run.displayName}\nTask: ${task.assignment.taskId}`;
    const landed = applyAndCommit(target.worktree, patch, subject, body);
    if (!landed.ok) return conflict(run.id, task, landed.reason);
    // The commit already moved the branch. A binding that cannot be re-read is a fact about the
    // run, not a reason to forget the commit: it is recorded as the daemon found it.
    let binding: unknown;
    try { binding = deps.currentBinding?.(run.id); } catch (error) {
      log(`team integration: the run's binding could not be refreshed after ${landed.commitSha}: ${(error as Error).message}`);
    }
    const receipt = governance.recordIntegrationCommit({
      protocolVersion: TEAM_CONTROL_VERSION, runId: run.id, actionId: task.assignment.taskId,
      expectedEntityVersion: governance.getRun(run.id).entityVersion,
      idempotencyKey: `daemon-integration-commit:${task.assignment.taskId}:${landed.commitSha}`,
      payload: { taskId: task.assignment.taskId, commitSha: landed.commitSha, subject, branch: target.branch,
        worktree: target.worktree, repository: target.repository, ...(binding === undefined ? {} : { binding }) },
    }, { kind: "daemon", sessionId: "daemon" });
    if (receipt.status !== "observed" && !receipt.replayed) {
      // The commit is on the branch; the record is what a reader needs. Saying so loudly is the
      // only honest thing left, and the next attempt records the same commit again.
      const reason = receipt.reason ?? receipt.status;
      log(`team integration: ${task.assignment.taskId} landed as ${landed.commitSha} but was not recorded: ${reason}`);
      return { taskId: task.assignment.taskId, status: "conflict", commitSha: landed.commitSha, reason };
    }
    return { taskId: task.assignment.taskId, status: "committed", commitSha: landed.commitSha, reason: null };
  };

  const integrateOne = (runId: string, taskId: string): IntegrationResult => {
    const run = governance.getRun(runId);
    // A canceled or invalidated run delivers nothing: its approval no longer covers new work.
    if (run.state === "cancel_requested" || run.state === "canceled" || run.state === "invalidated") {
      return { taskId, status: "skipped", commitSha: null, reason: `run is ${run.state}` };
    }
    const task = governance.findTask(runId, taskId);
    if (!task || task.assignment.role !== "implementer") {
      return { taskId, status: "skipped", commitSha: null, reason: "not this run's implementer task" };
    }
    if (governance.integrationRecord(runId).commits.some(commit => commit.taskId === taskId)) {
      return { taskId, status: "already-integrated", commitSha: null, reason: null };
    }
    if (governance.queueState(task.qitemId) !== "done") {
      return { taskId, status: "skipped", commitSha: null, reason: "the task has no completed outcome" };
    }
    let manifest;
    try { manifest = deps.candidateManifest(runId, taskId); } catch (error) {
      return conflict(runId, task, `the task's candidate could not be read: ${(error as Error).message}`);
    }
    if (manifest.base !== "commit") {
      return conflict(runId, task, "the repository has no commit for the work to be applied to");
    }
    // A task that changed nothing has nothing to land; its absence from the commit list is the
    // honest record of that, and nothing is committed for it.
    if (manifest.patch.trim() === "") return { taskId, status: "nothing-to-commit", commitSha: null, reason: null };
    let target: Target;
    try { target = targetOf(run); } catch (error) {
      return conflict(runId, task, `the run's integration worktree could not be prepared: ${(error as Error).message}`);
    }
    return land(run, task, manifest.patch, target);
  };

  return {
    integrate: (runId, taskId) => serial(() => integrateOne(runId, taskId)),

    status(runId) {
      const run = governance.getRun(runId);
      const recorded = governance.integrationRecord(runId);
      let repository: string | null = null;
      try { repository = repositoryOf(run); } catch { /* reported by merge, not by a read */ }
      const derived = planWorktreePath(deps.worktreeRoot(), run.id);
      return {
        runId, branch: branchOf(run), repository,
        worktree: recorded.worktree ?? (existsSync(derived) ? derived : null),
        commits: recorded.commits.map(commit => ({ hash: commit.commitSha.slice(0, 7), subject: commit.subject, task: commit.taskId })),
        tasksDone: openTasks(runId).length === 0,
        merge: readiness(run),
      };
    },

    merge(runId) {
      const run = governance.getRun(runId);
      const branch = branchOf(run);
      const refuse = (code: string, reason: string): MergeOutcome =>
        ({ status: "refused", code, reason, branch, mode: null, head: null });
      const open = openTasks(runId);
      if (open.length) return refuse("merge_tasks_open", `${open.length} task(s) are still open: ${open.map(task => task.taskId).join(", ")}`);
      const stopped = blocked(run);
      if (stopped) return refuse("merge_not_ready", stopped.reason);
      let repository: string;
      try { repository = repositoryOf(run); } catch (error) { return refuse("merge_unavailable", (error as Error).message); }
      if (!existsSync(repository)) return refuse("merge_unavailable", "The owner's repository is not on this machine.");
      const current = checkedOutBranch(repository);
      if (current === null) return refuse("merge_detached_head", "The owner's checkout has no branch checked out; check one out and merge again.");
      if (current === branch) return refuse("merge_already_on_branch", "The owner's checkout is already on the integration branch.");
      if (dirty(repository)) return refuse("merge_checkout_dirty", "The owner's checkout has uncommitted changes; commit or stash them and merge again.");
      if (gitOrNull(repository, ["rev-parse", "--verify", `refs/heads/${branch}`]) === null) {
        return refuse("merge_no_branch", "The integration branch does not exist yet.");
      }
      const before = headOf(repository);
      if (isAncestor(repository, branch, before)) {
        return { status: "merged", code: null, reason: null, branch, mode: "up-to-date", head: before };
      }
      // Fast-forward when the owner's branch has not moved past the run's base, which is the
      // ordinary case; otherwise the work needs one merge commit to join the two histories.
      try {
        git(repository, ["merge", "--ff-only", "--quiet", branch]);
        return { status: "merged", code: null, reason: null, branch, mode: "fast-forward", head: headOf(repository) };
      } catch { /* Not a fast-forward. A refused one leaves the checkout untouched. */ }
      try {
        git(repository, ["merge", "--no-ff", "--quiet", "-m", `Merge ${branch}: ${run.displayName}`, branch]);
        return { status: "merged", code: null, reason: null, branch, mode: "merge-commit", head: headOf(repository) };
      } catch (error) {
        // The conflict is reported and everything is put back: the owner's working tree, index
        // and HEAD are where they were before the request, with no half-merged state behind.
        const reason = gitFailure(error);
        try { git(repository, ["merge", "--abort"]); } catch { /* Nothing to abort: the worktree was clean, so nothing was merged. */ }
        const restored = headOf(repository);
        if (restored !== before) log(`team integration: the merge abort left ${repository} at ${restored}, not ${before}`);
        return refuse("merge_conflict", reason);
      }
    },
  };
}