import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseAttemptIdentity } from "../contracts/team-control.js";
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
    & Partial<Pick<TmuxAdapter, "holdPaneOnExit" | "respawnPane" | "getPaneExit">>;
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
}

/** The shells a pane falls back to; anything else is the client the launch started. */
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);
/** How long the client may take to become the pane's foreground process. */
const READY_WINDOW_MS = 60_000;

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
    try {
      const pane = await this.deps.resolvePane(attempt.context.runId, attempt.context.assignment.taskId);
      const tree = this.deps.resolveAssignedTree(attempt.context.runId, attempt.context.assignment);
      const sessionId = input.resumeToken ?? randomUUID();
      const facts: DirectLaunchFacts = { client, tree, pane, sessionId, attemptId: attempt.attemptId,
        runId: attempt.context.runId, taskId: attempt.context.assignment.taskId };
      const argv = this.deps.command ? this.deps.command(facts) : this.nativeArgs(client, input, sessionId);
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
      const line = "cd " + shellQuote(tree) + " && exec " + argv.map(shellQuote).join(" ");
      const typed = await this.deps.tmux.sendText(pane, line);
      if (!typed.ok) return this.refuse(typed.code);
      const submitted = await this.deps.tmux.sendKeys(pane, ["Enter"]);
      if (!submitted.ok) return this.refuse(submitted.code);
      const ready = await this.waitForClient(pane, attempt.deadline);
      if (!ready) return this.refuse("managed_readiness_unknown");
      const pid = await this.deps.tmux.getPanePid(pane);
      if (pid === null) return this.refuse("managed_identity_unobserved");
      const identity = processFacts(pid);
      const receipt: ManagedSessionReceipt = {
        identity: parseAttemptIdentity({ nativeSessionId: sessionId, tmuxServer: this.deps.tmuxServer(), paneId: pane,
          processId: pid, processStart: identity.start, generation: (attempt.previous?.identity.generation ?? 0) + 1,
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
      return { ok: true, managedSession: receipt, resumeToken: sessionId,
        resumeType: client === "codex" ? "codex_id" : "claude_id" };
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
      return probe.status === "resumed" ? { ready: true } : { ready: false, code: probe.code, reason: probe.detail };
    } catch {
      return { ready: false, code: "managed_observation_unavailable" };
    }
  }

  private refuse(code: string): HarnessLaunchResult {
    return { ok: false, error: "Direct launch blocked: " + code, recovery: "attention_required" };
  }

  /** The native argv, matching the hardened launcher so a seat behaves the same either way. */
  private nativeArgs(client: WorkerClient, input: WorkerLaunchInput, sessionId: string): string[] {
    const model = input.model ? ["--model", input.model] : [];
    const effort = input.effort ? ["--effort", input.effort] : [];
    return client === "claude-code"
      ? ["claude", "--permission-mode", "bypassPermissions", ...model, ...effort,
          ...(input.resumeToken ? ["--resume", input.resumeToken] : ["--session-id", sessionId])]
      : ["codex", "-a", "never", "-s", "danger-full-access", "-c", "check_for_update_on_startup=false", ...model, ...effort,
          ...(input.resumeToken ? ["resume", input.resumeToken] : [])];
  }

  /** Ready once the client, not a shell, is the pane's foreground process. */
  private async waitForClient(pane: string, deadline: number): Promise<boolean> {
    const limit = Math.min(deadline, this.now() + READY_WINDOW_MS);
    for (;;) {
      const command = await this.deps.tmux.getPaneCommand(pane);
      if (command !== null && !SHELL_COMMANDS.has(command)) return true;
      if (this.now() >= limit) return false;
      await this.sleep(250);
    }
  }
}
