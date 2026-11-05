import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAttemptIdentity } from "../contracts/team-control.js";
import { agentTurnOutputPaths, agentTurnPromptPath, isNativeSessionToken, readAgentTurnThreadId } from "../domain/agent-turn.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { hashBytes } from "../domain/plan-governance.js";
import type { HarnessLaunchResult, ManagedAttempt, ManagedSessionReceipt, ReadinessResult } from "../domain/runtime-adapter.js";
import type { TmuxAdapter } from "./tmux.js";
import { shellQuote } from "./shell-quote.js";
import type { WorkerClient, WorkerLauncher, WorkerLaunchInput } from "./worker-launch.js";

/**
 * MVP — the unisolated managed launch.
 *
 * With `workers.isolation: none` an attempt runs as the daemon's own user, inside the
 * candidate worktree the runtime admitted for it, in the seat's tmux pane. Nothing here
 * reads `/etc/multi-agent`, spawns sudo or needs the `ma-*` accounts, so the managed path
 * works on an ordinary Linux or WSL host after `./setup.sh`.
 *
 * What still holds is the part a person relies on: the client starts only in the tree the
 * runtime admitted, and the receipt names the kernel identity the pane actually runs under
 * rather than repeating the daemon's own. Network isolation is genuinely absent, so the
 * receipt says `unknown` instead of claiming a profile nothing enforces.
 */

export interface DirectWorkerLaunchDeps {
  tmux: Pick<TmuxAdapter, "sendText" | "sendKeys" | "getPanePid" | "getPaneCommand" | "capturePaneScreen">
    & Partial<Pick<TmuxAdapter, "holdPaneOnExit" | "respawnPane" | "getPaneExit" | "setPaneTask">>;
  /** The pane this attempt's seat owns, resolved from the task's recorded destination. */
  resolvePane: (runId: string, taskId: string) => Promise<string>;
  /** The tree the runtime admitted for this assignment. */
  resolveAssignedTree: (runId: string, assignment: ManagedAttempt["context"]["assignment"]) => string;
  /**
   * The client command to run in the pane. Production leaves this out and runs the native
   * client by name; tests inject the stub runner, which needs the attempt's own facts.
   */
  command?: (facts: DirectLaunchFacts) => string[];
  /** The tmux server path the receipt records, as the daemon resolved it at startup. */
  tmuxServer: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface DirectLaunchFacts {
  client: WorkerClient;
  /** The admitted candidate tree; the client starts here. */
  tree: string;
  pane: string;
  /** The native session id this launch runs under. */
  sessionId: string;
  attemptId: string;
  runId: string;
  taskId: string;
  /** Where this turn's prompt was written. */
  promptPath?: string;
}

/** The shells a pane falls back to; anything else is the client the launch started. */
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);
/**
 * How long a headless turn may take to show it started before readiness gives up on it.
 *
 * A turn that ends before readiness is checked is a valid, fast turn, not a launch failure: the
 * pane's dead flag and its exit status are that turn's own evidence, and the sweep records the
 * stop from them. Only a pane whose command is still the shell is "not yet ready".
 */
const TURN_START_WINDOW_MS = 30_000;

/** `/proc/<pid>/stat`, read past the parenthesised command name. */
function processFacts(pid: number): { groupId: number; start: string } {
  const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  const groupId = Number(fields[2]);
  const start = fields[19];
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || !start) throw new Error("direct_launch_process_unreadable");
  return { groupId, start };
}

export class DirectWorkerLauncher implements WorkerLauncher {
  private readonly receipts = new Map<string, ManagedSessionReceipt>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: DirectWorkerLaunchDeps) {
    this.sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
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
      const pane = await this.deps.resolvePane(attempt.context.runId, attempt.context.assignment.taskId);
      const tree = this.deps.resolveAssignedTree(attempt.context.runId, attempt.context.assignment);
      // A fresh attempt opens a conversation; a continuation keeps the one it is given.
      const sessionId = input.continueSessionId ?? input.resumeToken ?? randomUUID();
      const promptPath = agentTurnPromptPath(attempt.context);
      const output = client === "codex" && !this.deps.command
        ? agentTurnOutputPaths(attempt.context.mutableStateRoot, attempt.attemptId) : undefined;
      if (output) {
        mkdirSync(output.directory, { recursive: true, mode: 0o700 });
        // An exact resume can reuse an attempt id; its previous output cannot describe this turn.
        rmSync(output.threadId, { force: true });
        rmSync(output.lastMessage, { force: true });
      }
      const facts: DirectLaunchFacts = { client, tree, pane, sessionId, attemptId: attempt.attemptId,
        runId: attempt.context.runId, taskId: attempt.context.assignment.taskId, promptPath };
      const argv = this.deps.command ? this.deps.command(facts)
        : this.nativeArgs(client, input, sessionId, tree);
      // T033 — hold the pane before the client starts. Measured on tmux 3.6: without this, the
      // client exiting destroys the pane (and a seat's only pane destroys its session), leaving
      // no exit status and no output for the completion sweep to classify. With it, the pane
      // stays dead and carries `pane_dead_status` and its last lines. A host whose tmux refuses
      // the option still launches: the sweep then has no exit evidence and records no code,
      // which is the conservative answer, not a retry.
      await this.deps.tmux.holdPaneOnExit?.(pane);
      // A pane held from an earlier attempt is still the seat's, but its shell is gone: measured
      // on tmux 3.6, typing into a dead pane is accepted and does nothing. So the held pane is
      // put back to a live shell first, in the seat's own pane, and the launch proceeds as it
      // does for a pane that never ran a client.
      if ((await this.deps.tmux.getPaneExit?.(pane))?.dead) {
        const revived = await this.deps.tmux.respawnPane?.(pane);
        if (revived && !revived.ok) return this.refuse(revived.code);
      }
      // The pane already belongs to this seat, so the launch changes only what runs in it:
      // the admitted tree as the working directory, then the client as the foreground process.
      //
      // A turn's identity is read before the line is submitted, because `exec` keeps the
      // process: the pid tmux started the pane with is the pid the client runs under, and its
      // start tick is unchanged by the exec. Reading it afterwards loses the identity of a turn
      // that ends immediately, before the launch observes it.
      const identity = await this.paneIdentity(pane);
      if (identity === null) return this.refuse("managed_identity_unobserved");
      // A seat is a terminal, and one seat can hold two live tasks: the review loop creates a
      // review task per completed implementer, so two completed tasks are two pending reviews
      // on the same reviewer seat. The receipt names the seat, so a reader that resolves "the
      // seat's one live task" finds two and records nothing. The pane says which one this
      // launch is starting, so it is stamped before the client starts.
      await this.deps.tmux.setPaneTask?.(pane, attempt.context.assignment.taskId);
      const line = "cd " + shellQuote(tree) + " && exec "
        + this.turnCommand(argv, this.deps.command !== undefined, output?.threadId).map(shellQuote).join(" ")
        // The turn's text is fed on stdin, so its length and quoting never reach this line.
        + " < " + shellQuote(promptPath);
      const typed = await this.deps.tmux.sendText(pane, line);
      if (!typed.ok) return this.refuse(typed.code);
      const submitted = await this.deps.tmux.sendKeys(pane, ["Enter"]);
      if (!submitted.ok) return this.refuse(submitted.code);
      const ready = await this.waitForTurn(pane, attempt.deadline, output?.threadId);
      if (!ready) return this.refuse("managed_readiness_unknown");
      const observedThreadId = output ? readAgentTurnThreadId(output.threadId) : null;
      const receipt: ManagedSessionReceipt = {
        identity: parseAttemptIdentity({ nativeSessionId: observedThreadId ?? sessionId, tmuxServer: this.deps.tmuxServer(), paneId: pane,
          processId: identity.processId, processStart: identity.start, generation: (attempt.previous?.identity.generation ?? 0) + 1,
          policyFingerprint: attempt.context.binding.policyFingerprint }),
        attemptId: attempt.attemptId, runId: attempt.context.runId, client,
        contextHash: attempt.context.generatedHash, observedContextHash: attempt.context.generatedHash,
        workerUid: process.getuid!(), processGroupId: identity.groupId, executableVersion: "unknown",
        // Nothing filters this worker's network, so no profile is claimed.
        network: { namespace: "host", mode: "unknown", profileFingerprint: hashBytes("unisolated"),
          preflightRef: "direct-launch:" + attempt.attemptId },
        deadline: attempt.deadline,
      };
      this.receipts.set(attempt.attemptId, receipt);
      // Codex allocates its own thread id. The sweep saves the captured id before freeing the seat.
      return { ok: true, managedSession: receipt,
        ...(client === "claude-code" ? { resumeToken: sessionId, resumeType: "claude_id" } : {}) };
    } catch (error) {
      return this.refuse(error instanceof Error && /^direct_launch_/.test(error.message) ? error.message : "managed_launch_unverified");
    }
  }

  async checkReady(attempt: ManagedAttempt): Promise<ReadinessResult> {
    const receipt = this.receipts.get(attempt?.attemptId);
    if (!receipt) return { ready: false, code: "managed_identity_unobserved" };
    try {
      if (await this.deps.tmux.getPanePid(receipt.identity.paneId) !== receipt.identity.processId) {
        return { ready: false, code: "managed_identity_changed" };
      }
      // The injected stub runner has no native composer. Production always uses the screen probe.
      if (this.deps.command) return { ready: true };
      const paneContent = await this.deps.tmux.capturePaneScreen(receipt.identity.paneId);
      const paneCommand = await this.deps.tmux.getPaneCommand(receipt.identity.paneId);
      const probe = assessNativeResumeProbe({ runtime: receipt.client, paneContent, paneCommand,
        claudeResumeIdentityVerified: false });
      // A headless turn has no composer to probe, and a turn that already ended is a valid, fast
      // turn: its exit status is the sweep's evidence, not a launch failure. What the probe is
      // still read for is the one thing a turn can also hit — a positive gate that needs the
      // owner (a bypass-consent prompt, a refused login, a resume it cannot honour). Anything
      // else is the turn doing its work.
      const gated = probe.status === "attention_required" || probe.code === "login_required"
        || probe.code === "no_conversation_found" || probe.code === "trust_gate" || probe.code === "mcp_gate";
      return gated ? { ready: false, code: probe.code, reason: probe.detail } : { ready: true };
    } catch {
      return { ready: false, code: "managed_observation_unavailable" };
    }
  }

  /** The pane's own process and its start tick, or null when tmux cannot name one. */
  private async paneIdentity(pane: string): Promise<{ processId: number; groupId: number; start: string } | null> {
    const pid = await this.deps.tmux.getPanePid(pane);
    if (pid === null) return null;
    const facts = processFacts(pid);
    return { processId: pid, groupId: facts.groupId, start: facts.start };
  }

  private refuse(code: string): HarnessLaunchResult {
    return { ok: false, error: "Direct launch blocked: " + code, recovery: "attention_required" };
  }

  /**
   * The process the pane `exec`s for one turn.
   *
   * A headless turn's stream is JSON, so the readable view sits in front of it: the pane runs
   * the shipped formatter, which starts the client, forwards stdin from the attempt's prompt
   * file and exits with the client's own status. An injected command is started directly.
   *
   * `exec` stays on the process the pane ends up in, so the pane's exit status is the client's
   * own — T033's classifier reads that status, and a wrapper that swallowed it would turn every
   * failed turn into a successful one.
   */
  private turnCommand(argv: string[], injected: boolean, threadIdPath?: string): string[] {
    // An injected command is already the caller's own program (a stub, a fixture), so it is
    // started as given: wrapping it would make the pane's exit status the wrapper's.
    if (injected) return argv;
    const view = fileURLToPath(new URL("../../assets/agent-turn-view.mjs", import.meta.url));
    return [process.execPath, view, ...(threadIdPath ? ["--thread-id-file", threadIdPath] : []), ...argv];
  }

  /**
   * The native argv for one managed turn.
   *
   * Claude Code runs one headless turn (`-p`): the process exits when the turn ends, which is
   * what lets the completion sweep, the session slot and T033's exit classification work at
   * all. The prompt is fed on stdin from the file the daemon wrote, so its length and its
   * quoting never reach the shell line. `stream-json --verbose` is the only mode the installed
   * build streams in — measured 2.1.296: `text` prints nothing until the turn ends — and a
   * small formatter turns each event into a readable line in the pane.
   *
   * Codex 0.160.0 accepts -C/-s on exec, but not exec resume. A continuation already starts
   * in the candidate via the shell's cd, and sets its sandbox through the supported config flag.
   */
  private nativeArgs(client: WorkerClient, input: WorkerLaunchInput, sessionId: string, tree: string): string[] {
    if (client === "claude-code") {
      return ["claude", "-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose",
        ...(input.model ? ["--model", input.model] : []), ...(input.effort ? ["--effort", input.effort] : []),
        ...(input.continueSessionId || input.resumeToken ? ["--resume", sessionId] : ["--session-id", sessionId])];
    }
    const continuing = input.continueSessionId !== undefined || input.resumeToken !== undefined;
    const output = agentTurnOutputPaths(input.attempt.context.mutableStateRoot, input.attempt.attemptId);
    return ["codex", "exec", ...(continuing ? ["resume"] : []), "--json", "-o", output.lastMessage,
      ...(continuing ? ["-c", "sandbox_mode=workspace-write"] : ["-C", tree, "-s", "workspace-write"]),
      "-c", "sandbox_workspace_write.network_access=true", "-c", "check_for_update_on_startup=false",
      ...(input.model ? ["-m", input.model] : []), ...(input.effort ? ["-c", "model_reasoning_effort=" + input.effort] : []),
      ...(continuing ? [sessionId] : []), "-"];
  }

  /**
   * Observe Codex's first thread event before issuing its receipt. A turn that already
   * ended is also ready: even a client that failed before opening a thread must have its
   * exit classified by the sweep. Other commands are ready once the pane runs the client.
   */
  private async waitForTurn(pane: string, deadline: number, threadIdPath?: string): Promise<boolean> {
    const limit = Math.min(deadline, this.now() + TURN_START_WINDOW_MS);
    for (;;) {
      if ((await this.deps.tmux.getPaneExit?.(pane))?.dead) return true;
      const command = await this.deps.tmux.getPaneCommand(pane);
      // Codex supplies its identity in its first event; the receipt must not invent that id.
      if (threadIdPath ? readAgentTurnThreadId(threadIdPath) !== null
        : command !== null && !SHELL_COMMANDS.has(command)) return true;
      if (this.now() >= limit) return false;
      await this.sleep(50);
    }
  }
}
