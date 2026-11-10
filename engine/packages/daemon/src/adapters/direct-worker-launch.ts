import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { parseAttemptIdentity } from "../contracts/team-control.js";
import type { WorkerEvent } from "../contracts/worker-events.js";
import { agentTurnPromptPath, agentTurnOutputPaths, isNativeSessionToken, readAgentTurnThreadId } from "../domain/agent-turn.js";
import { hashBytes } from "../domain/plan-governance.js";
import { resolveExecutable } from "../domain/executable-resolver.js";
import type { HarnessLaunchResult, ManagedAttempt, ManagedSessionReceipt, ReadinessResult } from "../domain/runtime-adapter.js";
import { ChildProcessSupervisor, type SupervisedTurn, type SupervisorLaunch, type SupervisorResult } from "./child-process-supervisor.js";
import { workerArgv } from "./worker-launch-argv.js";
import type { WorkerClient, WorkerLauncher, WorkerLaunchInput } from "./worker-launch.js";

/**
 * U3 — the unisolated managed launch, as a direct child process.
 *
 * What a person relies on has not changed: the client starts only in the tree the runtime
 * admitted, and the receipt names the process the kernel actually runs rather than repeating the
 * daemon's own. What changed is the transport. The old path typed a command line into the seat's
 * tmux pane, read the screen for readiness and recovered the exit status from the pane's dead
 * flag; KTD1 replaces all three with a piped child the daemon starts itself, because both clients
 * already expose a headless JSONL mode and a PTY adds only lifecycle to scrape.
 *
 * The receipt is still the run's evidence, so it still names a pid *and* a start marker. On
 * Windows that pair is the CIM creation time, on POSIX the `/proc` start tick, and both come from
 * U1. `paneId`/`tmuxServer` are recorded as null: there is no pane, and a reader that needs one
 * asks the identity, not the launch.
 */

export interface DirectWorkerLaunchDeps {
  /** The tree the runtime admitted for this assignment. */
  resolveAssignedTree: (runId: string, assignment: ManagedAttempt["context"]["assignment"]) => string;
  /**
   * The client command to run. Production leaves this out and resolves the real executable
   * through U1; tests inject a stub, which needs the attempt's own facts.
   */
  command?: (facts: DirectLaunchFacts) => string[];
  /**
   * The client executable an operator configured explicitly. It is used as given when it is a
   * launchable file, which is how a fixture names a stub `.exe`.
   */
  executablePath?: (client: WorkerClient) => string | undefined;
  /** Installer-bundled resources, for the resolver's bundled branch. */
  bundledRoots?: string[];
  modelRefusal?: (input: WorkerLaunchInput) => string | null;
  documentRefusal?: (input: WorkerLaunchInput) => string | null;
  /** Start one supervised turn. Injectable so a test can drive the launcher without spawning. */
  supervise?: (launch: SupervisorLaunch, deps: { onEvent: (event: WorkerEvent) => void }) => SupervisedTurn;
  /** Publish a normalized event. Absent means the launch records only its receipt. */
  onEvent?: (facts: DirectLaunchFacts, event: WorkerEvent) => void;
  now?: () => number;
}

export interface DirectLaunchFacts {
  client: WorkerClient;
  /** The admitted candidate tree; the client starts here. */
  tree: string;
  /** The native session id this launch runs under. */
  sessionId: string;
  attemptId: string;
  runId: string;
  taskId: string;
  /** Where this turn's prompt was written. */
  promptPath?: string;
  /**
   * Where this turn's final message is recorded: the attempt's `last-message.txt`, the same file
   * `readAgentTurnLastMessage` reads for either client. Codex writes it through its own `-o`; a
   * Claude turn's `result` record is written there by the supervisor. An injected command (a
   * stub, a fixture) may write it itself — either way the daemon reads one path.
   */
  resultPath?: string;
  reportPath?: string;
  /** The process this turn runs as, once it started. */
  processId?: number;
  processStart?: string;
}

/** How long a launch waits for its turn to reach the first provider event before it is ready. */
const TURN_START_WINDOW_MS = 30_000;
/** How often readiness re-reads the turn's observed events. */
const READINESS_POLL_MS = 50;

/** What one launch keeps, so a later readiness check and a cancel read the same facts. */
interface LiveTurn {
  turn: SupervisedTurn;
  facts: DirectLaunchFacts;
  receipt: ManagedSessionReceipt;
  events: WorkerEvent[];
}

export class DirectWorkerLauncher implements WorkerLauncher {
  private readonly receipts = new Map<string, ManagedSessionReceipt>();
  private readonly turns = new Map<string, LiveTurn>();
  private readonly now: () => number;

  constructor(private readonly deps: DirectWorkerLaunchDeps) {
    this.now = deps.now ?? Date.now;
  }

  async launch(input: WorkerLaunchInput): Promise<HarnessLaunchResult> {
    const { attempt, client } = input;
    if (this.receipts.has(attempt.attemptId)) return this.refuse("managed_attempt_already_started");
    if (!Number.isSafeInteger(attempt.deadline) || attempt.deadline <= this.now()) return this.refuse("managed_deadline_expired");
    if (attempt.context.client !== client) return this.refuse("managed_client_mismatch");
    for (const token of [input.resumeToken, input.continueSessionId]) {
      if (token !== undefined && !isNativeSessionToken(token)) return this.refuse("managed_resume_identity_mismatch");
    }
    try {
      const modelError = this.deps.modelRefusal?.(input) ?? this.deps.documentRefusal?.(input);
      if (modelError) return this.refuse(modelError);
      const tree = this.deps.resolveAssignedTree(attempt.context.runId, attempt.context.assignment);
      // A fresh attempt opens a conversation; a continuation keeps the one it is given.
      const continuing = input.continueSessionId !== undefined || input.resumeToken !== undefined;
      const sessionId = input.continueSessionId ?? input.resumeToken ?? randomUUID();
      const promptPath = agentTurnPromptPath(attempt.context);
      const output = agentTurnOutputPaths(attempt.context.mutableStateRoot, attempt.attemptId);
      // The per-attempt output is cleared by the supervisor before it spawns, so a stale report
      // can never describe this turn.
      mkdirSync(output.directory, { recursive: true, mode: 0o700 });
      const facts: DirectLaunchFacts = { client, tree, sessionId, attemptId: attempt.attemptId,
        runId: attempt.context.runId, taskId: attempt.context.assignment.taskId, promptPath,
        resultPath: output.lastMessage, reportPath: output.taskReport };
      const readOnly = attempt.context.workflow?.readOnly === true;
      const argv = this.deps.command ? this.deps.command(facts) : this.nativeArgv(client, input, sessionId, tree, output, continuing, readOnly);
      // The client command is either an injected program or the resolved real executable. A bare
      // name is never a spawn target: `shell: false` cannot find it, and on Windows it would be a
      // `.cmd` shim Node refuses to start (KTD2).
      const [executable, ...args] = argv;
      if (!executable) return this.refuse("managed_executable_unresolved");
      const resolved = this.deps.command ? executable : this.resolveExecutable(client);
      if (resolved === null) return this.refuse("managed_executable_unresolved");
      // The prompt is the file the orchestrator already wrote for this attempt. A turn whose
      // prompt file is missing has nothing to work on, and is a refusal rather than an empty turn.
      const prompt = this.readPrompt(promptPath);
      if (prompt === null) return this.refuse("managed_prompt_unavailable");
      const changedModelError = this.deps.modelRefusal?.(input) ?? this.deps.documentRefusal?.(input);
      if (changedModelError) return this.refuse(changedModelError);

      const launch: SupervisorLaunch = { executable: resolved, args, cwd: tree, prompt,
        mutableStateRoot: attempt.context.mutableStateRoot, attemptId: attempt.attemptId,
        provider: client === "codex" ? "codex" : "claude",
        ...(client === "codex" ? { threadIdPath: output.threadId } : {}) };
      const events: WorkerEvent[] = [];
      const turn = this.deps.supervise
        ? this.deps.supervise(launch, { onEvent: event => events.push(event) })
        : new ChildProcessSupervisor(launch, { onEvent: event => {
          events.push(event);
          this.deps.onEvent?.(facts, event);
        } });
      const identity = await turn.start();
      facts.processId = identity.processId;
      facts.processStart = identity.processStart;
      // A turn that takes minutes must not block the launch that started it: `wait()` is what a
      // cancellation or a shutdown awaits, and readiness polls `settled()`.
      // A turn that never said anything is a no-response, not a launch failure: the attempt was
      // started and its process exists, so the receipt is recorded and the sweep decides from
      // the exit facts. The launch therefore waits only long enough to give the client its
      // chance to report its own identity — a Codex thread id, which the receipt must not invent.
      await this.waitForTurn(turn, attempt.deadline, client === "codex" ? output.threadId : undefined);
      // Codex allocates its own thread id and reports it in its first event; the receipt names
      // the id the client gave, never one this side invented. A turn that ended before reporting
      // one keeps the id it launched under, and the sweep saves the captured thread separately.
      const nativeSessionId = client === "codex" ? readAgentTurnThreadId(output.threadId) ?? sessionId : sessionId;
      const receipt = this.receipt(facts, attempt, client, nativeSessionId, identity);
      this.receipts.set(attempt.attemptId, receipt);
      this.turns.set(attempt.attemptId, { turn, facts, receipt, events });
      // The turn's end is recorded as soon as it happens, not when someone asks: `wait()` writes
      // the exit facts beside the attempt's output, and that file is what the completion sweep
      // classifies after the process is gone. Nothing awaits this promise, so a client that runs
      // for minutes never holds the launch open.
      void turn.wait().catch(() => { /* A turn that cannot report its end is the sweep's problem. */ });
      return { ok: true, managedSession: receipt,
        ...(client === "claude-code" ? { resumeToken: sessionId, resumeType: "claude_id" } : {}) };
    } catch (error) {
      return this.refuse(error instanceof Error && /^direct_launch_|^managed_/.test(error.message) ? error.message : "managed_launch_unverified");
    }
  }

  /**
   * The receipt for a turn that started.
   *
   * The identity is the process pair U1 captured at spawn, which is what recovery reconciles and
   * cancellation aims at. `paneId`/`tmuxServer` are null: a direct child has no pane, and the
   * fields stay in the contract for the hardened launcher that does.
   */
  private receipt(facts: DirectLaunchFacts, attempt: ManagedAttempt, client: WorkerClient, sessionId: string,
    identity: { processId: number; processStart: string }): ManagedSessionReceipt {
    return {
      identity: parseAttemptIdentity({ nativeSessionId: sessionId, tmuxServer: null, paneId: null,
        processId: identity.processId, processStart: identity.processStart,
        generation: (attempt.previous?.identity.generation ?? 0) + 1,
        policyFingerprint: attempt.context.binding.policyFingerprint }),
      attemptId: attempt.attemptId, runId: attempt.context.runId, client,
      contextHash: attempt.context.generatedHash, observedContextHash: attempt.context.generatedHash,
      // An unisolated worker is the daemon's own user, which Windows has no numeric id for.
      workerUid: typeof process.getuid === "function" ? process.getuid() : 0,
      processGroupId: identity.processId, executableVersion: "unknown",
      // Nothing filters this worker's network, so no profile is claimed.
      network: { namespace: "host", mode: "unknown", profileFingerprint: hashBytes("unisolated"),
        preflightRef: "direct-launch:" + attempt.attemptId },
      deadline: attempt.deadline,
    };
  }

  /**
   * Whether the turn this attempt started is running.
   *
   * A direct child has no composer and no gate screen, so there is nothing to wait for beyond
   * the child existing: the launch itself waited for the client's first provider event, and a
   * turn that ended before readiness is checked is a valid, fast turn whose exit facts are the
   * completion sweep's evidence. Only a turn this launcher does not know is unobserved.
   */
  async checkReady(attempt: ManagedAttempt): Promise<ReadinessResult> {
    return this.turns.has(attempt?.attemptId) ? { ready: true } : { ready: false, code: "managed_identity_unobserved" };
  }

  /**
   * Stop a turn this launcher started.
   *
   * Cancellation is the owner's, and the run's own cancel route ends recorded identities through
   * U1; this is the launch's own handle on the same child, used by a shutdown that is ending work
   * it started. Closing stdin first lets a headless client leave on its own.
   */
  async cancel(attemptId: string): Promise<SupervisorResult | null> {
    const live = this.turns.get(attemptId);
    if (!live) return null;
    await live.turn.cancel();
    return live.turn.wait();
  }

  private refuse(code: string): HarnessLaunchResult {
    return { ok: false, error: "Direct launch blocked: " + code, recovery: "attention_required" };
  }

  /** The prompt the orchestrator wrote for this attempt, or null when it is not readable. */
  private readPrompt(path: string): string | null {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  }

  /**
   * The real executable for one client, through U1's resolver.
   *
   * An explicit configured path wins (a fixture, or an operator override); otherwise the resolver
   * follows PATH and `PATHEXT` to a real `.exe`, following an npm shim when that is what is
   * installed. A bare name that resolves to nothing is a refusal: `shell: false` would fail
   * anyway, and a `.cmd` target is exactly what the resolver refuses to return.
   */
  private resolveExecutable(client: WorkerClient): string | null {
    const configuredPath = this.deps.executablePath?.(client);
    // The resolver's names are the clients' own names: a Claude turn is `claude`, not the
    // adapter's `claude-code`.
    const resolution = resolveExecutable(client === "codex" ? "codex" : "claude", {
      ...(configuredPath ? { configuredPath } : {}),
      ...(this.deps.bundledRoots ? { bundledRoots: this.deps.bundledRoots } : {}),
    });
    return resolution.ok ? resolution.path : null;
  }

  /** The native argv for one managed turn, from the frozen launch contract. */
  private nativeArgv(client: WorkerClient, input: WorkerLaunchInput, sessionId: string, tree: string,
    output: ReturnType<typeof agentTurnOutputPaths>, continuing: boolean, readOnly: boolean): string[] {
    return [client === "codex" ? "codex" : "claude",
      ...workerArgv({ client, tree, output, readOnly, role: input.attempt.context.assignment.role, sessionId,
        continuing, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) })];
  }

  /**
   * Wait for a turn to show it started.
   *
   * A turn that already ended is also ready: even a client that failed before opening a session
   * must have its exit classified by the completion sweep. A Codex turn supplies its own thread
   * id in its first event, so the receipt must not invent that id — the wait is for the client's
   * own answer, or for the turn to end.
   */
  private async waitForTurn(turn: SupervisedTurn, deadline: number, threadIdPath?: string): Promise<boolean> {
    const limit = Math.min(deadline, this.now() + TURN_START_WINDOW_MS);
    for (;;) {
      if (turn.observedEvents.length > 0) {
        if (!threadIdPath || turn.observedEvents.some(event => event.type === "session.started")) return true;
      }
      // An ended turn is ready whatever it produced: its exit facts are the sweep's evidence.
      if (turn.settled()) return true;
      if (this.now() >= limit) return false;
      await new Promise<void>(resolve => setTimeout(resolve, READINESS_POLL_MS));
    }
  }
}
