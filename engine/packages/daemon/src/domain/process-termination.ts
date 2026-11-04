import { readFileSync } from "node:fs";

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

export interface TerminateDependencies {
  /** Injectable for the tests; production leaves the defaults. */
  read?: (identity: ProcessIdentity) => ProcessState | null;
  signal?: (target: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  termGraceMs?: number;
  limitMs?: number;
}

export interface TerminationResult {
  outcome: TerminationOutcome;
  /** True when the group survived SIGTERM and had to be killed. */
  escalated: boolean;
  /** How long the wait took, in milliseconds, so the owner can see a slow exit. */
  waitedMs: number;
}

/**
 * End the process group the recorded client leads: SIGTERM, then SIGKILL after the grace.
 *
 * The group is signalled only while its leader is still the recorded process, which is what
 * keeps a recycled pid from reaching a stranger. A client that already exited is
 * `not-running` and nothing is signalled at all. A group still alive at the limit is
 * `unresolved`: the caller records that rather than claiming a stop it did not see.
 */
export async function terminateProcessGroup(identity: ProcessIdentity, dependencies: TerminateDependencies = {}): Promise<TerminationResult> {
  const read = dependencies.read ?? liveProcess;
  const signal = dependencies.signal ?? ((target, kind) => process.kill(target, kind));
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const grace = dependencies.termGraceMs ?? TERM_GRACE_MS, limit = dependencies.limitMs ?? TERMINATION_LIMIT_MS;
  const started = now();
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
