import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import {
  WINDOWS_PROCESS_QUERY, isWindows, normalizeCreationTime, queryWindowsProcesses, treeKillArgv,
} from "./platform.js";

/**
 * T017 (cancellation half) — what a recorded attempt identity is, and how to end it.
 *
 * A receipt records the client process as the kernel saw it: a pid *and* the clock tick that
 * process started at. The pid alone is not an identity — the kernel reuses it — so every
 * decision here is made against the pair, and a pid whose start tick has moved is a different
 * process that this run never launched.
 *
 * The client leads its own process group (tmux starts a pane's foreground process in a new
 * session), so signalling the group reaches the client and everything it spawned while leaving
 * the tmux server, the daemon and every other seat alone. The group is only signalled after
 * `/proc` says its leader is still the recorded process: a group id is a pid, so a recycled one
 * would otherwise name whatever now leads it.
 *
 * Windows has neither `/proc` nor process groups. There the pair is the pid plus the CIM creation
 * time, and the tree is ended with `taskkill /T /F`. A query that is denied, times out, or returns
 * a different creation time is `unknown`/`not-ours`: nothing is signalled and nothing is called
 * dead, because an unproved identity is not evidence of an end.
 */

export interface ProcessIdentity {
  processId: number;
  processStart: string;
}

export interface ProcessState extends ProcessIdentity {
  /** The kernel's state letter: `R`, `S`, `D`, `Z` (exited, not yet reaped), and so on. */
  state: string;
  /** The process group this process leads or belongs to. */
  groupId: number;
}

/** How a termination attempt ended, in the terms the owner's cancel reports. */
export type TerminationOutcome = "stopped" | "unresolved" | "not-running";

/** How long a client gets to exit after SIGTERM before SIGKILL, and when the outcome is decided. */
export const TERM_GRACE_MS = 5_000;
export const TERMINATION_LIMIT_MS = 15_000;

/** The interval between liveness reads while a termination is in progress. */
const POLL_MS = 100;

const execFileAsync = promisify(execFile);

/** `/proc/<pid>/stat`, read past the parenthesised command name (which may contain spaces). */
export function readProcessState(processId: number): ProcessState | null {
  let raw: string;
  try { raw = readFileSync("/proc/" + processId + "/stat", "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  const groupId = Number(fields[2]), start = fields[19];
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || !start || !fields[0]) throw new Error("process_state_unreadable");
  return { processId, processStart: start, state: fields[0], groupId };
}

/** A zombie has exited: `/proc` still lists it until its parent reaps it, but it runs nothing. */
export const isRunning = (state: ProcessState): boolean => state.state !== "Z" && state.state !== "X";

/**
 * Whether the process the identity names is still running, and — when it is — the group to
 * signal. A recycled pid is not the recorded process, so it is reported as gone and never
 * signalled; the same answer `attempt-completion.ts` gives, for the same reason.
 */
export function liveProcess(identity: ProcessIdentity): ProcessState | null {
  const state = readProcessState(identity.processId);
  return state && state.processStart === identity.processStart && isRunning(state) ? state : null;
}

/**
 * How the recorded identity reads on this host, in the terms every recovery decision uses.
 *
 * `alive` is the only answer that permits action against the process; `dead` is the only answer
 * that permits recording an end. `unknown` is neither, and `not-ours` means the pid now belongs to
 * another process — never signalled, never called dead.
 */
export type IdentityState = "alive" | "dead" | "not-ours" | "unknown";

/**
 * Whether a recorded identity is alive, on this host.
 *
 * POSIX reads `/proc`, where a missing pid is dead and an unreadable `/proc` is not. Windows asks
 * the OS for the pid's creation time: a parsed time that matches the record is `alive`, a parsed
 * time that differs is `not-ours`, an answered-but-missing pid is `dead`, and a denied or timed-out
 * query is `unknown`. The timeout is `WINDOWS_PROCESS_QUERY.timeoutMs`, and an unknown is never
 * retried into a decision.
 */
export async function observeIdentity(identity: ProcessIdentity): Promise<IdentityState> {
  if (!isWindows()) {
    let state: ProcessState | null;
    try { state = liveProcess(identity); }
    catch { return "unknown"; }
    if (state !== null) return "alive";
    // A missing process is dead; a `/proc` that cannot be read at all is not evidence of an end.
    try { readProcessState(identity.processId); return "dead"; }
    catch { return "unknown"; }
  }
  try {
    const row = (await queryWindowsProcesses([identity.processId])).get(identity.processId);
    if (!row) return "unknown";
    if (row.state === "absent") return "dead";
    if (row.state === "unknown") return "unknown";
    return normalizeCreationTime(row.creationTime) === normalizeCreationTime(identity.processStart) ? "alive" : "not-ours";
  } catch { return "unknown"; }
}

/** Whether a recorded identity is alive, in the terms a termination decision uses. Unknown is not. */
export async function processIdentityAlive(identity: ProcessIdentity): Promise<boolean> {
  return await observeIdentity(identity) === "alive";
}

/**
 * End the recorded process and everything it started on Windows.
 *
 * `taskkill /T /F` walks the process tree, which is what `child.kill()` cannot do there (measured:
 * the direct child exits and its grandchild keeps running). The identity is checked first, because
 * a taskkill aimed at a recycled pid would end a stranger; afterwards the identity is checked
 * again, and only its absence is a `stopped` outcome. A survivor, or a query that cannot answer,
 * is `unresolved` — the caller records that rather than claiming a stop it did not see.
 */
async function terminateWindowsTree(identity: ProcessIdentity, dependencies: TerminateDependencies,
  started: number, now: () => number, limit: number): Promise<TerminationResult> {
  const observe = dependencies.observeWindows ?? observeIdentity;
  const before = await observe(identity);
  if (before !== "alive") {
    return { outcome: before === "dead" ? "not-running" : "unresolved", escalated: false, waitedMs: now() - started };
  }
  const argv = treeKillArgv(identity.processId);
  const kill = dependencies.killTree ?? ((command: string, args: string[]) => execFileAsync(command, args, {
    encoding: "utf8", timeout: limit, windowsHide: true, maxBuffer: 64 * 1024,
  }));
  let escalated = false;
  try {
    await kill(argv.command, argv.args);
    escalated = true;
  } catch {
    // taskkill reports "not found" as a non-zero exit; the identity check below decides, not this.
  }
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = started + limit;
  for (;;) {
    const state = await observe(identity);
    if (state === "dead") return { outcome: "stopped", escalated, waitedMs: now() - started };
    if (state !== "alive") return { outcome: "unresolved", escalated, waitedMs: now() - started };
    if (now() >= deadline) return { outcome: "unresolved", escalated, waitedMs: now() - started };
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
  }
}

export interface TerminateDependencies {
  /** Injectable for the tests; production leaves the defaults. */
  read?: (identity: ProcessIdentity) => ProcessState | null;
  signal?: (target: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  termGraceMs?: number;
  limitMs?: number;
  /** Windows: how the recorded identity is read, and how its tree is ended. */
  observeWindows?: (identity: ProcessIdentity) => Promise<IdentityState>;
  killTree?: (command: string, args: string[]) => Promise<unknown>;
}

export interface TerminationResult {
  outcome: TerminationOutcome;
  /** True when the group survived SIGTERM and had to be killed. */
  escalated: boolean;
  /** How long the wait took, in milliseconds, so the owner can see a slow exit. */
  waitedMs: number;
}

/**
 * End the process the recorded identity names, by the means this host has.
 *
 * POSIX signals the process group the client leads: SIGTERM, then SIGKILL after the grace. The
 * group is signalled only while its leader is still the recorded process, which is what keeps a
 * recycled pid from reaching a stranger. A client that already exited is `not-running` and
 * nothing is signalled at all. A group still alive at the limit is `unresolved`: the caller
 * records that rather than claiming a stop it did not see.
 *
 * Windows has no groups, so `terminateWindowsTree` ends the tree with `taskkill /T /F` and proves
 * the end from the recorded identity afterwards.
 */
export async function terminateProcessGroup(identity: ProcessIdentity, dependencies: TerminateDependencies = {}): Promise<TerminationResult> {
  const now = dependencies.now ?? Date.now;
  const grace = dependencies.termGraceMs ?? TERM_GRACE_MS, limit = dependencies.limitMs ?? TERMINATION_LIMIT_MS;
  const started = now();
  if (isWindows()) return terminateWindowsTree(identity, dependencies, started, now, limit);
  const read = dependencies.read ?? liveProcess;
  const signal = dependencies.signal ?? ((target, kind) => process.kill(target, kind));
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const waitUntil = async (deadline: number): Promise<boolean> => {
    for (;;) {
      if (read(identity) === null) return true;
      if (now() >= deadline) return false;
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
    }
  };
  const send = (target: number, kind: NodeJS.Signals): void => {
    try { signal(target, kind); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const leader = read(identity);
  if (leader === null) return { outcome: "not-running", escalated: false, waitedMs: 0 };
  // A leader that is not its own group leader would make the group id name someone else's
  // processes; this run's client always leads its own, so anything else is not signalled.
  if (leader.groupId !== identity.processId) return { outcome: "unresolved", escalated: false, waitedMs: 0 };
  send(-leader.groupId, "SIGTERM");
  if (await waitUntil(Math.min(started + grace, started + limit))) {
    return { outcome: "stopped", escalated: false, waitedMs: now() - started };
  }
  // Re-read before escalating: the grace may have covered the whole limit, and the group must
  // still be the recorded one for the kill to be this run's.
  const current = read(identity);
  if (current === null) return { outcome: "stopped", escalated: false, waitedMs: now() - started };
  if (current.groupId !== identity.processId) return { outcome: "unresolved", escalated: false, waitedMs: now() - started };
  send(-current.groupId, "SIGKILL");
  const stopped = await waitUntil(started + limit);
  return { outcome: stopped ? "stopped" : "unresolved", escalated: true, waitedMs: now() - started };
}

/**
 * Every live attempt of one run that recorded an identity, newest first.
 *
 * Read from `team_attempts`, which is the row a launch receipt admitted: an attempt with no
 * identity has nothing this module could safely signal, so it is left for reconciliation.
 */
export function runningAttemptIdentities(db: { prepare(sql: string): { all(...parameters: string[]): unknown[] } }, runId: string): ProcessIdentity[] {
  const rows = db.prepare("SELECT identity_json AS identityJson FROM team_attempts WHERE run_id = ? AND state = 'running' AND identity_json IS NOT NULL")
    .all(runId) as Array<{ identityJson: string }>;
  return rows.map(row => {
    const identity = JSON.parse(row.identityJson) as ProcessIdentity;
    return { processId: identity.processId, processStart: identity.processStart };
  });
}

/**
 * Every live attempt on this daemon that recorded an identity, across every run.
 *
 * A desktop-owned daemon uses this at shutdown: the app is closing, so the workers it started
 * end with it through the same tree kill cancellation uses. An identity that cannot be parsed
 * is skipped here rather than throwing, because a shutdown phase must finish.
 */
export function allRunningAttemptIdentities(db: { prepare(sql: string): { all(...parameters: string[]): unknown[] } }): ProcessIdentity[] {
  const rows = db.prepare("SELECT identity_json AS identityJson FROM team_attempts WHERE state = 'running' AND identity_json IS NOT NULL")
    .all() as Array<{ identityJson: string }>;
  const identities: ProcessIdentity[] = [];
  for (const row of rows) {
    try {
      const identity = JSON.parse(row.identityJson) as ProcessIdentity;
      if (Number.isSafeInteger(identity.processId) && typeof identity.processStart === "string") identities.push(identity);
    } catch { /* an unreadable identity has nothing safe to signal; recovery reconciles it */ }
  }
  return identities;
}

/**
 * End every live attempt's process tree, through the identity-checked termination above.
 *
 * A desktop-owned daemon runs this in its shutdown: the app that started the daemon is closing,
 * so the agents it started end with it. `stopped` and `not-running` are both proof the tree is
 * gone; anything else (a survivor, an unproven identity) is counted as unresolved and left for
 * the boot reconciliation, which is the owner that never claims a stop it did not see.
 */
export async function endRunningWorkerTrees(
  db: { prepare(sql: string): { all(...parameters: string[]): unknown[] } },
  terminate: (identity: ProcessIdentity) => Promise<TerminationResult> = identity => terminateProcessGroup(identity),
): Promise<{ attempted: number; stopped: number; unresolved: number }> {
  const identities = allRunningAttemptIdentities(db);
  const outcomes = await Promise.allSettled(identities.map(identity => terminate(identity)));
  const unresolved = outcomes.filter(outcome => outcome.status === "rejected"
    || (outcome.status === "fulfilled" && outcome.value.outcome !== "stopped"
      && outcome.value.outcome !== "not-running")).length;
  return { attempted: identities.length, stopped: identities.length - unresolved, unresolved };
}
