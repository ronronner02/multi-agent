import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalPath, isWindows, samePath } from "./platform.js";

/**
 * KTD10 — one policy for every worktree the daemon creates.
 *
 * Three call sites add worktrees: the run's plan branch (`plan-branch.ts`), the integration
 * worktree that reuses it (`integration-branch.ts`), and each task's candidate
 * (`team-workspace.ts`). Git for Windows decides whether any of them can exist, and it decides
 * it from the absolute path: measured on Windows 11 / Git 2.55.0.windows.5, `git worktree add`
 * succeeds at 215 characters and fails at 216 with `fatal: '$GIT_DIR' too big`, and the same
 * ceiling appears on the *administrative* path `<repo>/.git/worktrees/<leaf>`, which fails at
 * 250 characters. `core.longpaths=true` is necessary below the Win32 limit and does not lift
 * either wall, so the only defense is a short root and a refusal before Git is asked.
 *
 * One helper therefore owns the ceiling, the root, and the command. Callers name the run or
 * the task; the helper names the directory, refuses a path Git cannot take, and passes
 * `-c core.longpaths=true`.
 */

/**
 * The longest absolute worktree path this host can take, or `null` where Git has no such wall.
 *
 * Windows: 215. The measurement above puts the ceiling on the absolute path length; the probe
 * matrix in `windows-probes.md` (probe 6) agrees at 215/216. Unix: no ceiling here, because
 * `PATH_MAX` is a syscall limit that long paths do not hit the same way and Linux is the
 * path this unit must not change.
 */
export const WORKTREE_PATH_CEILING = process.platform === "win32" ? 215 : null;

/**
 * Headroom kept below the ceiling for the administrative path Git derives from the worktree.
 *
 * Git also writes `<repository>/.git/worktrees/<leaf>`, where the leaf is the worktree's own
 * basename. Measured on the same host: that path succeeds at 249 characters and fails at 250.
 * The plan worktree's leaf is the run id and the candidate's leaf is `<runId>-<taskId>`, so the
 * headroom the admin path needs is the difference between the two leaves, which is why the
 * preflight checks both paths instead of subtracting a fixed margin.
 */
export const WORKTREE_ADMIN_CEILING = process.platform === "win32" ? 249 : null;

/** The marker that makes the default root short enough for the ceiling above. */
const WINDOWS_STATE_DIRECTORY = "Multi-Agent";

/**
 * Where the daemon's per-run and per-task worktrees live.
 *
 * On Windows the default is `%LOCALAPPDATA%\Multi-Agent\wt`: `%LOCALAPPDATA%` is the per-user
 * mutable-state location KTD7 names, and the two short segments keep the default root near
 * 40 characters so a run id and a task id still fit under the ceiling. Elsewhere the default
 * stays `~/.multi-agent/wt`, which is where the existing plan worktrees already are.
 *
 * `MULTI_AGENT_WORKTREE_ROOT` overrides both, because a host whose repository sits under a
 * deep checkout may need a root on another volume; the override is resolved against the
 * daemon's own working directory, so a relative value names one place rather than drifting
 * with each request.
 */
export function defaultWorktreeRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.MULTI_AGENT_WORKTREE_ROOT?.trim();
  if (configured) return resolve(configured);
  if (isWindows()) {
    const localAppData = environment.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(localAppData, WINDOWS_STATE_DIRECTORY, "wt");
  }
  return join(homedir(), ".multi-agent", "wt");
}

/** A refusal the owner can act on: the requested worktree path cannot exist on this host. */
export class WorktreePathError extends Error {
  readonly code = "worktree_path_too_long";
  constructor(readonly worktree: string, readonly length: number, readonly ceiling: number, readonly kind: "worktree" | "admin") {
    super(`The worktree path is too long for this host: ${length} characters, and Git accepts at most ${ceiling} here. `
      + "Set MULTI_AGENT_WORKTREE_ROOT to a shorter directory.");
    this.name = "WorktreePathError";
  }
}

/** The repository's administrative directory for linked worktrees, as Git names it. */
function adminDirectory(repository: string): string {
  const reported = execFileSync("git", ["-C", repository, "rev-parse", "--git-path", "worktrees"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return isAbsolute(reported) ? reported : join(repository, reported);
}

/**
 * Refuse a worktree path this host cannot create, before Git is asked.
 *
 * Both paths Git will write are checked: the worktree itself against the worktree ceiling, and
 * `<admin>/<leaf>` against the administrative one. The leaf is what Git copies from the
 * worktree basename, so a short root with a long task id fails here rather than inside Git with
 * `'$GIT_DIR' too big`.
 */
export function assertWorktreePathFits(input: { repository: string; worktree: string }): void {
  if (WORKTREE_PATH_CEILING === null) return;
  const worktree = resolve(input.worktree);
  if (worktree.length > WORKTREE_PATH_CEILING) {
    throw new WorktreePathError(worktree, worktree.length, WORKTREE_PATH_CEILING, "worktree");
  }
  const admin = join(adminDirectory(input.repository), worktree.slice(worktree.lastIndexOf(sep) + 1));
  if (WORKTREE_ADMIN_CEILING !== null && admin.length > WORKTREE_ADMIN_CEILING) {
    throw new WorktreePathError(worktree, admin.length, WORKTREE_ADMIN_CEILING, "admin");
  }
}

/**
 * The one place the daemon runs `git worktree add`.
 *
 * `-c core.longpaths=true` is passed on every host: it is what lets the paths under the ceiling
 * reach Git's own filesystem calls on Windows, and it is inert elsewhere. The caller decides the
 * arguments; this function decides that the ceiling was checked and the flag is present.
 */
export function addWorktree(input: { repository: string; worktree: string; args: readonly string[] }): void {
  assertWorktreePathFits(input);
  mkdirSync(dirname(input.worktree), { recursive: true });
  execFileSync("git", ["-C", input.repository, "-c", "core.longpaths=true", "worktree", "add", ...input.args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

/** Whether a directory is already a worktree of this repository, so a replay reuses it. */
export function isWorktreeOf(repository: string, path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const top = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    // Git answers with the long form of the path; a Windows root reached through an 8.3 name
    // compares unequal to it unless both sides are canonicalised.
    return samePath(canonicalPath(top), canonicalPath(path));
  } catch {
    return false;
  }
}
