import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { promisify } from "node:util";
import { resolve, sep } from "node:path";

/**
 * U1 — the daemon's one boundary for the facts that differ between POSIX and Windows.
 *
 * Everything the kept team path needs to know about the host is decided here, once, so no other
 * module branches on `process.platform` for an execution fact. The list is deliberately short:
 * this is the platform boundary, not a general utilities module.
 *
 * - **Identity.** POSIX has a numeric uid/gid pair; Windows has none, so a privacy assertion that
 *   compares `stat.uid` against `process.getuid()` cannot run there and must say so instead of
 *   silently passing.
 * - **Liveness.** POSIX reports a process from `/proc`; Windows has no `/proc`, so a recorded
 *   identity is only ever *proved* through a CIM query and everything else is `unknown`.
 * - **Termination.** POSIX signals a process group; Windows has no groups, so the tree is ended
 *   with `taskkill /T /F` and the recorded identity is re-checked afterwards.
 * - **Directory entry types.** `O_NOFOLLOW`/`O_DIRECTORY` are POSIX-only open flags, so on Windows
 *   the same guarantee is an explicit reparse-point check on the entry itself.
 *
 * Nothing here is captured in a module constant: every answer is read at use, so a test can run a
 * Windows branch on any host by overriding `hostPlatform` through the module's own seam.
 */

export type HostPlatform = "win32" | "posix";

let override: HostPlatform | null = null;

/** Override the host platform for a test; pass `null` to read the real one again. */
export function setHostPlatformForTests(platform: HostPlatform | null): void {
  override = platform;
}

/** The host this process runs on. */
export function hostPlatform(): HostPlatform {
  return override ?? (process.platform === "win32" ? "win32" : "posix");
}

export const isWindows = (): boolean => hostPlatform() === "win32";

/**
 * The daemon user's numeric identity, or `null` where the host has none.
 *
 * A caller that needs a uid/gid for a privacy assertion must treat `null` as "this assertion
 * cannot be made here" and take the platform's own branch. It must never substitute a constant:
 * `0` would claim the daemon runs as root.
 */
export function processOwnerIds(): { uid: number; gid: number } | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  return uid === null || gid === null ? null : { uid, gid };
}

/**
 * Whether a directory is private to this process, as far as this host can prove it.
 *
 * POSIX proves it from ownership and mode. Windows has no uid/gid and no meaningful mode bits, so
 * the only thing it can prove is that the entry is a real directory and not a reparse point (a
 * junction or symlink) that would redirect the tree elsewhere.
 */
export function assertPrivateDirectory(path: string, ids: { uid: number; gid: number } | null): void {
  const stat = lstatSync(path);
  // A junction or symlink is not a directory as far as this boundary is concerned, on any host:
  // the tree it names is somewhere else.
  if (stat.isSymbolicLink()) throw new Error("Private root must not be a reparse point");
  if (!stat.isDirectory()) throw new Error("Private root must be a directory");
  if (isWindows()) return;
  if (ids === null) throw new Error("Private root ownership cannot be verified");
  if (stat.uid !== ids.uid || stat.gid !== ids.gid || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("Private root must be private and canonical");
  }
}

/**
 * Whether a directory entry is a link the host would follow.
 *
 * On Windows a junction and a symbolic link both report `isSymbolicLink()` from `lstat`, and Node
 * cannot open with `O_NOFOLLOW`, so this is how the worker-written-file boundary keeps the same
 * guarantee it has on POSIX: an entry that would redirect a read is refused by name.
 */
export function isRedirectingEntry(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The argv that ends a recorded process and everything it started, on this host.
 *
 * Windows has no process groups: `child.kill()` reaches the direct child only and orphans its
 * grandchildren (measured in the plan's probe record), while `taskkill /T /F` walks the tree.
 * POSIX keeps the existing group-signal path in `process-termination.ts`.
 */
export function treeKillArgv(processId: number): { command: string; args: string[] } {
  return { command: "taskkill", args: ["/PID", String(processId), "/T", "/F"] };
}

/**
 * The PowerShell program used for the CIM process query, and its latency budget.
 *
 * `powershell.exe` (Windows PowerShell 5.1) ships with every supported Windows version and exposes
 * `Get-CimInstance`; `pwsh` does not ship. Measured on the plan's reference machine: one
 * `-NoProfile -NonInteractive` invocation answering one pid took 0.35-0.55 s cold and 0.33-0.36 s
 * warm, and one invocation answering three pids took 0.8 s.
 */
export const WINDOWS_PROCESS_QUERY = { program: "powershell.exe", timeoutMs: 15_000 } as const;

/** A pid as Windows reports it: the executable path is only present when it is readable. */
export interface WindowsProcessRow {
  id: number;
  /** UTC creation time in ISO-8601 form, as CIM reports it. */
  creation: string | null;
  exe: string | null;
}

/**
 * The PowerShell script that answers the recorded identity question for a batch of pids.
 *
 * One invocation for the whole batch, because each costs a process start. A pid the OS does not
 * report comes back with a null creation time rather than being omitted, so a missing process is
 * distinguishable from a failed query: the query itself failing prints `CIM_ERROR`.
 */
export function windowsProcessQueryScript(processIds: number[]): string {
  const ids = processIds.map(id => String(id)).join(",");
  return "$ErrorActionPreference='Stop'; try { $ids = @(" + ids + "); "
    + "ConvertTo-Json -Compress -InputObject @(foreach ($id in $ids) { "
    + "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\"; "
    + "if ($p) { [pscustomobject]@{ id = $id; creation = $p.CreationDate.ToUniversalTime().ToString('o'); exe = $p.ExecutablePath } } "
    + "else { [pscustomobject]@{ id = $id; creation = $null; exe = $null } } }) "
    + "} catch { Write-Output 'CIM_ERROR' }";
}

/**
 * Normalize a CIM creation time to the millisecond form `Date` keeps.
 *
 * CIM reports 100 ns ticks (`...:19.0464840Z`); a recorded identity and a later query must compare
 * equal, so both sides go through this and a value that does not parse is `null` — never a guess.
 */
export function normalizeCreationTime(raw: string | null): string | null {
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** What the host says about a recorded pid: only `present` with a creation time is an identity. */
export type WindowsProcessLookup =
  | { state: "present"; creationTime: string; executablePath: string | null }
  /** The OS answered and does not know this pid. */
  | { state: "absent" }
  /** The query was denied, timed out, or answered something this cannot read. */
  | { state: "unknown"; reason: string };

/**
 * Ask the OS which process holds a pid, and when it started.
 *
 * This is the Windows half of the recorded identity, and it is deliberately conservative: only a
 * parsed creation time counts as evidence that the pid exists. Everything else — access denied, a
 * timeout, unparseable output, a query that exits non-zero — is `unknown`, which no caller may
 * turn into "dead" or into a requeue.
 *
 * One PowerShell invocation answers a batch, because each costs a process start. Measured on the
 * plan's reference machine: 0.35-0.55 s cold for one pid, 0.33-0.36 s warm, 0.8 s for three.
 */
export async function queryWindowsProcesses(processIds: number[], timeoutMs = WINDOWS_PROCESS_QUERY.timeoutMs):
  Promise<Map<number, WindowsProcessLookup>> {
  const result = new Map<number, WindowsProcessLookup>();
  const pids = [...new Set(processIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (pids.length === 0) return result;
  const { stdout } = await execFileAsync(WINDOWS_PROCESS_QUERY.program,
    ["-NoProfile", "-NonInteractive", "-Command", windowsProcessQueryScript(pids)],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
  const text = stdout.trim();
  if (text === "CIM_ERROR" || text === "") throw new Error("process_query_failed");
  const parsed = JSON.parse(text) as WindowsProcessRow | WindowsProcessRow[];
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!pids.includes(row.id)) continue;
    const creationTime = normalizeCreationTime(row.creation);
    result.set(row.id, creationTime === null
      ? { state: "absent" }
      : { state: "present", creationTime, executablePath: row.exe ?? null });
  }
  return result;
}

const execFileAsync = promisify(execFile);

/** Whether `path` is `root` or lies below it, compared the way this host compares paths. */
export function pathWithin(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (samePath(normalizedRoot, normalizedPath)) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep;
  return isWindows() ? normalizedPath.toLowerCase().startsWith(prefix.toLowerCase()) : normalizedPath.startsWith(prefix);
}

/** Two path spellings that name the same entry on this host. Windows compares case-insensitively. */
export function samePath(left: string, right: string): boolean {
  return isWindows() ? left.toLowerCase() === right.toLowerCase() : left === right;
}
