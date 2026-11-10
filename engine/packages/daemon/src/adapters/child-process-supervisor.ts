import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkerEvent, WorkerProvider } from "../contracts/worker-events.js";
import { agentTurnOutputPaths } from "../domain/agent-turn.js";
import { queryWindowsProcesses } from "../domain/platform.js";
import { observeIdentity, terminateProcessGroup, type IdentityState, type TerminationResult } from "../domain/process-termination.js";
import { redactTranscriptContent } from "../domain/transcript-redaction.js";
import { loadTurnTelemetry, type TurnTelemetry } from "../domain/turn-telemetry.js";
import { WorkerEventNormalizer } from "./worker-event-normalizer.js";

/**
 * U3 / KTD1 — one managed turn is one piped child process.
 *
 * A pane was the old transport: the launcher typed a command line into tmux, read the screen for
 * readiness, and recovered the exit status from the pane's dead flag. Both clients already expose
 * a headless JSONL mode, so none of that is needed — the supervisor writes the prompt once, reads
 * the stream as it arrives, and records the exit the child itself reported.
 *
 * Four facts this module owns, and no other:
 *
 * - **One prompt, on stdin.** The prompt is already a file (`writeAgentTurnPrompt`), so the child
 *   gets its bytes as a stream and nothing about its length or quoting reaches a shell. stdin is
 *   closed immediately after: a client that reads to EOF must see EOF.
 * - **Incremental parsing.** Lines are split on newlines as bytes arrive and fed to
 *   `WorkerEventNormalizer.normalizeLine`; each event is streamed out through `onEvent` rather
 *   than collected, because the normalizer keeps one turn's events and a live reader needs them
 *   while the turn runs.
 * - **Bounded diagnostics.** stderr is kept to a tail and the rendered stdout to a tail, so a
 *   client that prints megabytes cannot grow the daemon. The failure classifier reads those tails.
 * - **One exit fact.** The exit code and signal are recorded once, into `exit.json` beside the
 *   attempt's other output, so a later process reads the same facts this one observed.
 *
 * The process identity is captured at spawn, through U1: on Windows the pid plus the CIM creation
 * time, on POSIX the pid plus the `/proc` start tick. Cancellation closes stdin first — a headless
 * client leaves on EOF — and then ends the recorded tree, so a grandchild cannot outlive the
 * daemon's intent.
 */

/** How much stderr is retained for the owner and the classifier, in bytes. */
export const STDERR_TAIL_LIMIT = 8 * 1024;
/** How much rendered stdout is retained as the turn's readable tail, in bytes. */
export const OUTPUT_TAIL_LIMIT = 64 * 1024;
/** How long a cancelled child gets to honour the closed stdin before its tree is ended. */
export const CANCEL_GRACE_MS = 2_000;
/** The interval between liveness reads while a cancellation waits for the child to leave. */
const CANCEL_POLL_MS = 100;
/**
 * The recorded start marker for a child the OS would not answer for.
 *
 * A one-shot client can exit before the creation-time query returns. That turn is over, so the
 * pair only needs to be non-empty and impossible to confuse with a real creation time; the
 * recorded exit fact is what proves the end, and no later observation may read this as alive.
 */
export const UNOBSERVED_PROCESS_START = "unobserved";

export interface SupervisorLaunch {
  /** The resolved real executable. Never a `.cmd`, a `.ps1` or a bare name. */
  executable: string;
  args: readonly string[];
  /** The tree the turn runs in. */
  cwd: string;
  /** The prompt text, written once to stdin. */
  prompt: string;
  /** Where this attempt's durable output lives; it is cleared before the child starts. */
  mutableStateRoot: string;
  attemptId: string;
  provider: WorkerProvider;
  /** Where a provider thread id is captured, when the client reports one (Codex). */
  threadIdPath?: string;
  /** Extra environment for this child only. */
  env?: Record<string, string>;
}

export interface SupervisorDependencies {
  /** A normalized provider event, in the order the child produced it. */
  onEvent?: (event: WorkerEvent) => void;
  /** How a recorded identity reads on this host. Injectable for the tests. */
  observe?: (identity: { processId: number; processStart: string }) => Promise<IdentityState>;
  /** How a recorded tree is ended. Injectable for the tests. */
  terminate?: (identity: { processId: number; processStart: string }) => Promise<TerminationResult>;
  /** The child's creation time at spawn, on a host that reports one outside `/proc`. */
  creationTime?: (processId: number) => Promise<string | null>;
  /** The POSIX start tick at spawn. */
  startTick?: (processId: number) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onStderr?: (chunk: string) => void;
  /** The sidecar writer for this turn; null disables the sidecars. */
  telemetry?: (resultFile: string, args: readonly string[]) => Promise<TurnTelemetry | null>;
}

/** The durable facts one supervised turn leaves behind. */
export interface SupervisorExitFacts {
  version: 1;
  attemptId: string;
  provider: WorkerProvider;
  /** The child's own exit code, or null when it was ended by a signal or never started. */
  exitCode: number | null;
  signal: string | null;
  acknowledged: boolean;
  noResponse: boolean;
  threadId: string | null;
  stderrTail: string;
  /** The last rendered stdout lines, bounded. */
  outputTail: string;
  at: string;
}

/** The facts a completed turn reports to its launcher. */
export interface SupervisorResult extends SupervisorExitFacts {
  /** The identity captured at spawn; recovery and cancellation are aimed at this pair. */
  identity: { processId: number; processStart: string };
  /** Every normalized event this turn produced, in order. */
  events: WorkerEvent[];
  finalMessage: string | null;
  resumeToken: string | null;
  /** How the cancellation ended, when this turn was cancelled. */
  cancellation?: TerminationResult;
}

/** What a launcher needs from one supervised turn, so a test can stand in for the process. */
export interface SupervisedTurn {
  start(): Promise<{ processId: number; processStart: string }>;
  wait(): Promise<SupervisorResult>;
  cancel(): Promise<TerminationResult>;
  /** The turn's facts when it has already ended, without waiting for one that has not. */
  settled(): SupervisorResult | null;
  readonly processIdentity: { processId: number; processStart: string } | null;
  readonly observedEvents: readonly WorkerEvent[];
}

/** A bounded tail of a byte stream, decoded once at the end. */
class ByteTail {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    // Trim whole chunks from the front until the tail fits; a single oversized chunk is kept
    // whole so the most recent evidence is never cut in half mid-character.
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.limit) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  text(): string {
    const joined = Buffer.concat(this.chunks);
    const kept = joined.length > this.limit ? joined.subarray(joined.length - this.limit) : joined;
    return kept.toString("utf8").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  }
}

/**
 * The creation time of a pid this process just spawned, read through the query recovery uses.
 *
 * `observeIdentity` answers a different question — whether a *recorded* pair is still alive — so
 * nothing is recorded yet at spawn. A query that cannot answer is `null`, and the caller records
 * the unobserved marker rather than inventing a time.
 */
export async function readSpawnCreationTime(processId: number): Promise<string | null> {
  try {
    const row = (await queryWindowsProcesses([processId])).get(processId);
    return row?.state === "present" ? row.creationTime : null;
  } catch { return null; }
}

/** The child's start tick from `/proc`, or null when the host has no such file. */
export function readStartTick(processId: number): string | null {
  try {
    const raw = readFileSync("/proc/" + processId + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch { return null; }
}

/** One supervised turn. Construct it, `start()` it, then `wait()` for it or `cancel()` it. */
export class ChildProcessSupervisor implements SupervisedTurn {
  private child: ChildProcessWithoutNullStreams | null = null;
  private identity: { processId: number; processStart: string } | null = null;
  private readonly normalizer: WorkerEventNormalizer;
  private readonly events: WorkerEvent[] = [];
  private readonly stderr = new ByteTail(STDERR_TAIL_LIMIT);
  private readonly output = new ByteTail(OUTPUT_TAIL_LIMIT);
  private pending = "";
  private exit: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  private closed: Promise<void> | null = null;
  private closedResolved = false;
  private finished: SupervisorResult | null = null;
  private cancellation: TerminationResult | null = null;
  private telemetry: TurnTelemetry | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly launch: SupervisorLaunch, private readonly dependencies: SupervisorDependencies = {}) {
    this.normalizer = new WorkerEventNormalizer({ provider: launch.provider, attemptId: launch.attemptId });
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  }

  /** The attempt's output paths, including the exit facts this turn will record. */
  private outputPaths() { return agentTurnOutputPaths(this.launch.mutableStateRoot, this.launch.attemptId); }

  /**
   * Clear this attempt's output, start the child, write the prompt once, and capture its identity.
   *
   * Clearing first is what keeps a stale report from describing this turn: completion requires a
   * report whose attempt id matches, and a stale exit record would otherwise describe this child.
   * The prompt is written after the child exists so a client that exits immediately still cannot
   * race a file that was never there.
   */
  async start(): Promise<{ processId: number; processStart: string }> {
    const output = this.outputPaths();
    mkdirSync(output.directory, { recursive: true, mode: 0o700 });
    for (const path of [output.threadId, output.lastMessage, output.exit, output.taskReport]) rmSync(path, { force: true });
    mkdirSync(dirname(output.taskReport), { recursive: true, mode: 0o700 });

    const child = spawn(this.launch.executable, [...this.launch.args], {
      cwd: this.launch.cwd,
      // `shell: false` is the launch contract: a resolved `.exe` is started directly, so no shell
      // parses the prompt or the tree path.
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: the child leads its own process group, which is what cancellation signals and what
      // a daemon restart leaves behind for recovery to reconcile. Windows has no groups; the
      // recorded pid is the root `taskkill /T` walks.
      detached: process.platform !== "win32",
      ...(this.launch.env ? { env: { ...process.env, ...this.launch.env } } : {}),
    });
    this.child = child;
    this.closed = new Promise<void>(resolve => child.once("close", () => { this.closedResolved = true; resolve(); }));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      this.stderr.push(bytes);
      this.dependencies.onStderr?.(bytes.toString("utf8"));
    });
    child.once("exit", (code, signal) => { this.exit ??= { exitCode: code, signal }; });
    // A spawn that never produced a process (a missing file, a permission refusal) reports here.
    // It is recorded as an exit fact with no code, so the turn is classified rather than hanging.
    child.once("error", () => { this.exit ??= { exitCode: null, signal: null }; });

    if (child.pid === undefined) {
      this.exit ??= { exitCode: null, signal: null };
      throw new Error("direct_launch_spawn_failed");
    }
    const processId = child.pid;
    const processStart = await this.captureIdentity(processId);
    this.identity = { processId, processStart };

    const create = this.dependencies.telemetry
      ?? ((resultFile: string, args: readonly string[]) => loadTurnTelemetry(resultFile, args, redactTranscriptContent));
    this.telemetry = await create(output.lastMessage, this.launch.args);

    // The prompt is written once and stdin closed: a headless client reads its turn text to EOF.
    child.stdin.on("error", () => { /* A client that exits before reading leaves EPIPE; the exit decides. */ });
    child.stdin.end(this.launch.prompt);
    return this.identity;
  }

  /**
   * The creation time (Windows) or start tick (POSIX) of the child just spawned.
   *
   * A child that already exited has no enumerable creation time; that turn is over, and the exit
   * fact this supervisor records is what proves it. `UNOBSERVED_PROCESS_START` says exactly that.
   */
  private async captureIdentity(processId: number): Promise<string> {
    const windows = process.platform === "win32";
    const read = windows
      ? this.dependencies.creationTime ?? readSpawnCreationTime
      : async (id: number) => (this.dependencies.startTick ?? readStartTick)(id);
    const start = await read(processId);
    return start ?? UNOBSERVED_PROCESS_START;
  }

  /** Split the arriving bytes into lines and normalize each one as it completes. */
  private consume(chunk: string): void {
    this.pending += chunk;
    for (;;) {
      const index = this.pending.indexOf("\n");
      if (index < 0) break;
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      this.emitLine(line);
    }
  }

  private emitLine(line: string): void {
    if (!line.trim()) return;
    this.output.push(Buffer.from(line + "\n"));
    // The sidecar observations want the provider record itself; the normalizer owns the contract.
    try { this.telemetry?.observe(JSON.parse(line)); } catch { /* A malformed line is the normalizer's fact. */ }
    for (const event of this.normalizer.normalizeLine(line)) {
      this.events.push(event);
      // A Codex turn's identity arrives in its first thread event, and the receipt must not
      // invent one, so it is captured as soon as it is seen.
      if (event.type === "session.started" && this.launch.threadIdPath) this.writeThreadId(event.resumeToken);
      this.dependencies.onEvent?.(event);
    }
  }

  /** Record the first thread id a client reported. A later one is not this turn's identity. */
  private writeThreadId(token: string): void {
    const path = this.launch.threadIdPath;
    if (!path || !token) return;
    try { writeFileSync(path, token, { mode: 0o600 }); } catch { /* The receipt reads what exists. */ }
  }

  /** The identity captured at spawn, or null before `start()` returned. */
  get processIdentity(): { processId: number; processStart: string } | null { return this.identity; }

  /** The turn's facts once it has ended, or null while it is still running. */
  settled(): SupervisorResult | null {
    if (this.finished) return this.finished;
    // `close` is emitted after both pipes drained, so a resolved promise here means the turn is
    // over and its facts can be built without waiting.
    if (!this.closedResolved) return null;
    return this.buildResult();
  }

  /** The events normalized so far, in order. */
  get observedEvents(): readonly WorkerEvent[] { return this.events; }

  /**
   * Wait for the child to end and report the turn's facts once.
   *
   * A line left without a trailing newline is normalized first: a client that exits mid-line has
   * still said something. The result is built once, so a repeated `wait()` after a cancellation
   * returns the same facts rather than a second exit. The durable `exit.json` is written here, so
   * a later process — a sweep after a restart — reads the same facts this one observed.
   */
  async wait(): Promise<SupervisorResult> {
    if (this.finished) return this.finished;
    if (!this.child || !this.closed) throw new Error("direct_launch_not_started");
    await this.closed;
    return this.buildResult();
  }

  /** Build the turn's facts once, from everything observed up to now. */
  private buildResult(): SupervisorResult {
    if (this.finished) return this.finished;
    if (this.pending.trim()) { this.emitLine(this.pending); this.pending = ""; }
    this.telemetry?.finish();
    const exit = this.exit ?? { exitCode: null, signal: null };
    const normalized = this.normalizer.result();
    // A Claude turn's final message is the `result` record's text; Codex writes the same file
    // through its own `-o`, so only the client that does not write it is recorded here.
    if (this.launch.provider === "claude" && normalized.finalMessage !== null) {
      try { writeFileSync(this.outputPaths().lastMessage, normalized.finalMessage, { mode: 0o600 }); }
      catch { /* The turn's outcome does not depend on the readable copy. */ }
    }
    const facts: SupervisorExitFacts = {
      version: 1,
      attemptId: this.launch.attemptId,
      provider: this.launch.provider,
      exitCode: exit.exitCode,
      signal: exit.signal,
      acknowledged: normalized.acknowledged,
      noResponse: normalized.noResponse,
      threadId: readThreadId(this.launch.threadIdPath),
      stderrTail: this.stderr.text(),
      outputTail: this.output.text(),
      at: new Date(this.now()).toISOString(),
    };
    try {
      mkdirSync(this.outputPaths().directory, { recursive: true, mode: 0o700 });
      writeFileSync(this.outputPaths().exit, JSON.stringify(facts) + "\n", { mode: 0o600 });
    } catch { /* The in-memory facts still reach this launch's own reader. */ }
    this.finished = {
      ...facts,
      identity: this.identity ?? { processId: 0, processStart: UNOBSERVED_PROCESS_START },
      events: [...this.events],
      finalMessage: normalized.finalMessage,
      resumeToken: normalized.resumeToken,
      ...(this.cancellation ? { cancellation: this.cancellation } : {}),
    };
    return this.finished;
  }

  /**
   * Stop this turn: close stdin, let the child leave on its own, then end the recorded tree.
   *
   * The grace exists because a headless client that is reading its prompt sees EOF and exits
   * cleanly; killing it first would turn a tidy cancel into a signal. Whatever is still running
   * after the grace is the recorded identity's tree, and `taskkill /T /F` (or the POSIX group
   * signal) is what reaches a grandchild the direct child spawned.
   */
  async cancel(): Promise<TerminationResult> {
    if (this.cancellation) return this.cancellation;
    const identity = this.identity;
    if (!identity) throw new Error("direct_launch_not_started");
    try { this.child?.stdin.end(); } catch { /* Already closed by the client's own exit. */ }
    const observe = this.dependencies.observe ?? observeIdentity;
    const started = this.now();
    const deadline = started + CANCEL_GRACE_MS;
    while (this.now() < deadline) {
      if (await observe(identity) !== "alive") {
        this.cancellation = { outcome: "stopped", escalated: false, waitedMs: this.now() - started };
        return this.cancellation;
      }
      await this.sleep(CANCEL_POLL_MS);
    }
    this.cancellation = await (this.dependencies.terminate ?? (target => terminateProcessGroup(target)))(identity);
    return this.cancellation;
  }
}

/** The provider thread id a turn captured, if it captured a valid one. */
function readThreadId(path: string | undefined): string | null {
  if (!path) return null;
  try {
    const token = readFileSync(path, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch { return null; }
}

/**
 * The exit facts a supervised turn recorded for one attempt, or null when it recorded none.
 *
 * This is the boundary a later process reads: the file is worker-adjacent output, so its shape is
 * checked rather than trusted, and anything that does not read back as this supervisor's own
 * version is treated as absent — the classifier then decides from no evidence, which is its
 * "not retried" answer, rather than from a shape it invented.
 */
export function readSupervisorExit(mutableStateRoot: string, attemptId: string): SupervisorExitFacts | null {
  try {
    const raw = JSON.parse(readFileSync(agentTurnOutputPaths(mutableStateRoot, attemptId).exit, "utf8")) as Partial<SupervisorExitFacts>;
    if (raw.version !== 1 || raw.attemptId !== attemptId || (raw.provider !== "claude" && raw.provider !== "codex")) return null;
    if (raw.exitCode !== null && !Number.isSafeInteger(raw.exitCode)) return null;
    if (raw.signal !== null && typeof raw.signal !== "string") return null;
    return {
      version: 1, attemptId, provider: raw.provider,
      exitCode: raw.exitCode ?? null,
      signal: raw.signal ?? null,
      acknowledged: raw.acknowledged === true,
      noResponse: raw.noResponse === true,
      threadId: typeof raw.threadId === "string" ? raw.threadId : null,
      stderrTail: typeof raw.stderrTail === "string" ? raw.stderrTail : "",
      outputTail: typeof raw.outputTail === "string" ? raw.outputTail : "",
      at: typeof raw.at === "string" ? raw.at : "",
    };
  } catch { return null; }
}
