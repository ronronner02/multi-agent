import { relativePath } from "../contracts/team-control.js";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runName } from "./display-names.js";

/**
 * U5 — the branch the daemon owns, and the worktree the plan is recorded in.
 *
 * The owner approves a plan by agreeing to text the lead wrote in its own candidate tree. That
 * text has to become a durable artifact in the owner's repository, and the run's binding has to
 * name a root where the daemon can read it back: `bindingForGoal` reads `planRef` from the
 * working tree at a commit. Both facts are answered by one daemon-owned worktree of the owner's
 * repository on `team/<run-slug>`, created at the owner's HEAD and never in the owner's checkout.
 *
 * The same worktree is where KTD7's integration branch lives, so this is also the seam U7 needs:
 * an approved task's patch is applied here, and the commits that land are what the owner merges.
 * U5 only creates the branch and records the plan on it.
 *
 * Nothing here touches the owner's checked-out branch, index or working tree: the worktree is a
 * separate directory, and every git command names the repository it acts on.
 */

/** KTD7's integration branch namespace. */
export const PLAN_BRANCH_PREFIX = "team/";

/**
 * The run's branch name: readable, stable, and unique per run.
 *
 * The readable half is the run's own name, so a branch list says what each branch is for. The
 * suffix is the run id's first eight characters, which is what keeps two runs with the same goal
 * apart without a second registry. Git's own limits are respected by construction: lower-case
 * alphanumerics and single dashes, no leading or trailing dash, at most 40 characters of name.
 */
export function runSlug(input: { runId: string; name?: string | null }): string {
  const name = (input.name ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  const suffix = input.runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return PLAN_BRANCH_PREFIX + [name || "plan", suffix].filter(Boolean).join("-");
}

/** One worktree per run, named by the run's id so no two runs can share a directory. */
export function planWorktreePath(worktreeRoot: string, runId: string): string {
  return join(worktreeRoot, runId);
}

/** The placeholder plan a planning run is bound to before the lead has written one. */
export function bootstrapPlan(goal: string): string {
  return ["# Plan", "", `Goal: ${runName(goal) ?? "the owner's goal"}`, "",
    "The owner and the lead are agreeing this plan in the run's chat. The lead replaces this",
    "text with the plan they agree, and the owner approves it once before any work starts.", ""].join("\n");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    // A daemon-written commit states its own identity rather than borrowing one the owner may
    // have configured for their own work; the branch is the daemon's, and the log says so.
    env: { ...process.env, GIT_AUTHOR_NAME: "openrig", GIT_AUTHOR_EMAIL: "openrig@localhost",
      GIT_COMMITTER_NAME: "openrig", GIT_COMMITTER_EMAIL: "openrig@localhost" } }).trim();
}

function headOf(root: string): string {
  return git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
}

function branchExists(root: string, branch: string): boolean {
  try { git(root, ["rev-parse", "--verify", "refs/heads/" + branch]); return true; } catch { return false; }
}

/** Whether a path is a worktree of this repository, so a replay reuses it instead of failing. */
function isWorktreeOf(root: string, path: string): boolean {
  try { return realpathSync(git(path, ["rev-parse", "--show-toplevel"])) === realpathSync(path); } catch { return false; }
}

/** Write `planRef` into a worktree and commit it, unless the commit already holds those bytes. */
export function commitPlan(input: { worktree: string; planRef: string; plan: string; message: string;
  documents?: readonly { path: string; content: string }[] }): string {
  const files = new Map((input.documents ?? []).map(document => [document.path, document.content]));
  files.set(input.planRef, input.plan);
  // The source worktree may contain repository-provided links; never follow them while publishing documents.
  for (const path of files.keys()) {
    relativePath(path, "document.path");
    let current = realpathSync(input.worktree);
    for (const part of path.split("/")) {
      current = join(current, part);
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("A document destination is a symbolic link");
    }
  }
  for (const [path, content] of files) {
    const destination = join(input.worktree, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  git(input.worktree, ["add", "--", ...files.keys()]);
  // `git diff --cached --quiet` is the "nothing to commit" answer without reading its message.
  try { git(input.worktree, ["diff", "--cached", "--quiet"]); return headOf(input.worktree); }
  catch { /* staged changes exist */ }
  git(input.worktree, ["commit", "--quiet", "-m", input.message, "--", ...files.keys()]);
  return headOf(input.worktree);
}

/**
 * Create the run's plan worktree, or find the one an earlier attempt made.
 *
 * The branch is created at the owner's HEAD the first time; a replay reuses the existing branch
 * and worktree, so a repeated start or a restart cannot fork the run's history or move the
 * owner's checkout. The bootstrap plan is committed by the caller through `commitPlan`.
 */
export function ensurePlanWorktree(input: {
  repositoryRoot: string; worktreeRoot: string; runId: string; name?: string | null;
  /**
   * The commit the branch starts at. Omitted, the owner's current HEAD is used, which is what a
   * planning start wants. U7 passes the commit the run's plan was read at, so a run that
   * integrates before it ever had a worktree still lands on the history it approved.
   */
  base?: string;
}): { path: string; branch: string } {
  const repository = realpathSync(input.repositoryRoot);
  const path = planWorktreePath(input.worktreeRoot, input.runId);
  const branch = runSlug({ runId: input.runId, name: input.name });
  if (existsSync(path)) {
    if (!isWorktreeOf(repository, path)) throw new Error("The plan worktree path is occupied by something else");
    return { path, branch };
  }
  mkdirSync(dirname(path), { recursive: true });
  if (branchExists(repository, branch)) git(repository, ["worktree", "add", "--quiet", path, branch]);
  else git(repository, ["worktree", "add", "--quiet", "-b", branch, path, input.base ?? headOf(repository)]);
  return { path, branch };
}