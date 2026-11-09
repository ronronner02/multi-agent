import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard, type LifecycleDeps } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";

/**
 * `rig team` — MVP slices 2 and 3.
 *
 * `start` turns a goal into a run and a task; `diff` and `apply` hand a finished task's patch
 * back to the owner. Every verb is the daemon's work: these only authenticate with the owner
 * credential the managed daemon was started with and report what came back, so a CLI action and
 * a Web action cannot disagree about what exists.
 */

export interface TeamStartDeps {
  lifecycleDeps: LifecycleDeps;
  /** Owner control credential. Defaults to `MULTI_AGENT_OWNER_TOKEN`, then `owner.env`. */
  ownerToken?: string | null;
  fetchImpl?: typeof fetch;
}

interface StartReceipt { runId: string; rigId: string; taskId: string; seat: string; leadSeat?: string | null; state: string;
  /** U5 — `planning` until the owner approves the plan; `delivery` otherwise. */
  phase?: string }

/** The team `rig team create` returns; the daemon keeps the seat names to itself. */
interface Team {
  id: string; name: string; repository: string;
  seats: Array<{ role: "lead" | "implementer" | "reviewer"; client: "claude-code" | "codex"; model?: string }>;
}

/** The result the daemon serves for one finished task; the shape `TeamTaskResult` publishes. */
interface TeamTaskResult {
  schema: "multi-agent-team-result/v1"; runId: string; taskId: string; attemptId: string | null;
  repositoryRoot: string; base: "commit" | "snapshot"; baseIdentifier: string; manifestDigest: string;
  files: Array<{ path: string; hash: string; tracked: boolean }>; patch: string;
}

interface BrowserPairingReceipt {
  code?: string;
  expiresAt?: number;
  error?: string;
}

/** The completion read the owner action forwards: what the daemon observed and could verify. */
interface TaskCompletion {
  taskId: string; role: "lead" | "implementer" | "reviewer"; subjectTaskId: string;
  /**
   * The queue row the outcome command keys on. The completion read addresses a task by the id
   * the run gave it (`task-1`); `tasks/outcome` addresses the same task by its durable queue
   * row, and a request that names the task id there is refused as an unknown entity.
   */
  qitemId: string;
  queueState: string | null; taskVersion: number; actorSession: string | null;
  attempt: { attemptId: string; entityVersion: number; state: string; observed: boolean } | null;
  openAttempts: number; blockedReason: string | null; findingsRequired: boolean;
  evidence: { validated: boolean; manifestDigest: string | null; base: string | null; baseIdentifier: string | null;
    fileCount: number; changedPaths: string[]; outsideAssignment: string[]; reasons: string[] };
}

const BASE = "/api/team-control";

/**
 * How long an undecided lead proposal stays decidable.
 *
 * The daemon owns the refusal (`run.lead-proposal-requested` refuses an expiry that is not in
 * the future); this is the window the owner's verb asks for, and it matches the route's own
 * one-day constant so a proposal read and decided in a working session never expires between.
 */
const PROPOSAL_WINDOW_MS = 86_400_000;

/**
 * The owner token `./setup.sh` wrote.
 *
 * `./scripts/start.sh` sources this file into the daemon's own process, so a fresh shell
 * that follows the README has the daemon running and no credential of its own. Reading the
 * same file here is what makes the documented quick start work as written. The file holds
 * simple `KEY=value` lines, so it is parsed rather than sourced: this process never executes
 * anything a file in the user's config directory says.
 */
export function readOwnerTokenFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  try {
    for (const line of readFileSync(join(configHome, "multi-agent", "owner.env"), "utf8").split("\n")) {
      const match = /^\s*MULTI_AGENT_OWNER_TOKEN\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1]) return match[1].replace(/^["']|["']$/g, "") || null;
    }
  } catch { /* No setup yet, or an unreadable file: the caller reports the missing credential. */ }
  return null;
}

/** The one credential resolution every verb uses: explicit dep, then the environment, then setup's file. */
function ownerToken(deps: TeamStartDeps): string | null {
  return deps.ownerToken ?? readOpenRigEnv("MULTI_AGENT_OWNER_TOKEN")?.trim() ?? readOwnerTokenFile();
}

class TeamCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** A seat's client, with `claude` accepted as the shorthand the owner types. */
function teamClient(value: string, flag: string): "claude-code" | "codex" {
  const client = value.trim() === "claude" ? "claude-code" : value.trim();
  if (client !== "claude-code" && client !== "codex") {
    throw new TeamCommandError("team_client_invalid",
      `${flag} takes claude-code or codex (claude is shorthand for claude-code), not "${value}".`);
  }
  return client;
}

export function teamCommand(depsOverride?: TeamStartDeps): Command {
  const deps = (): TeamStartDeps => depsOverride ?? { lifecycleDeps: realDeps() };
  const cmd = new Command("team").description("start and inspect owner-governed team runs");
  cmd
    .command("start <goal>")
    .description("create a run and a task from a goal, then print how to watch it")
    .option("--rig <id-or-name>", "rig to run the work on (default: the only active rig)")
    .option("--seat <session>", "seat that takes the task (default: the rig's first agent node)")
    .option("--lead <session>", "seat that takes a lead task first and proposes the implementer tasks (omit for none)")
    .option("--reviewer <session>", "seat every review round routes to (omit to create no review task)")
    .option("--repository <path>", "repository the plan and the work belong to (default: the seat's cwd)")
    .option("--plan <path>", "plan artifact, relative to the repository (default: plan.md)")
    .option("--write <path...>", "repository-relative paths the task may write (default: src)")
    .option("--planning", "start a planning run: the lead agrees a plan with you before any work")
    .option("--workflow <entrypoint>", "select a workflow for direct execution or Lead delegation")
    .option("--read-only", "run the selected workflow without candidate or external writes")
    .option("--json", "print the daemon's receipt as JSON")
    .action(async (goal: string, opts: Record<string, unknown>) => {
      if (opts.readOnly && !opts.workflow) {
        console.error("error: --read-only requires --workflow.");
        process.exitCode = 1;
        return;
      }
      const token = ownerToken(deps());
      if (!token) {
        console.error("error: no owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
        process.exitCode = 1;
        return;
      }
      const status = await getDaemonStatus(deps().lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const body = { goal, ...(opts.rig ? { rig: String(opts.rig) } : {}), ...(opts.seat ? { seat: String(opts.seat) } : {}),
        ...(opts.workflow ? { workflow: { entrypoint: String(opts.workflow), readOnly: opts.readOnly === true } } : {}),
        ...(opts.lead ? { lead: String(opts.lead) } : {}),
        ...(opts.reviewer ? { reviewerSeat: String(opts.reviewer) } : {}),
        ...(opts.planning ? { planning: true } : {}),
        ...(opts.repository ? { repository: { root: String(opts.repository), ...(opts.plan ? { planRef: String(opts.plan) } : {}) } }
          : opts.plan ? { repository: { planRef: String(opts.plan) } } : {}),
        ...(opts.write ? { writePaths: (opts.write as string[]) } : {}) };
      const response = await client.post<StartReceipt & { error?: string }>(BASE + "/runs", body,
        { headers: { Authorization: "Bearer " + token } });
      if (response.status !== 201 || !response.data?.runId) {
        console.error("error: the start was refused: " + (response.data?.error ?? `HTTP ${response.status}`));
        process.exitCode = 1;
        return;
      }
      const receipt = response.data;
      if (opts.json) { console.log(JSON.stringify(receipt)); return; }
      const base = getDaemonUrl(status);
      console.log(`Run:  ${receipt.runId}`);
      console.log(`Task: ${receipt.taskId} on ${receipt.seat}`);
      if (receipt.phase === "planning") {
        console.log("");
        console.log("Agree the plan with the lead in the chat:");
        console.log(`  rig team chat ${receipt.runId} "your message"`);
        console.log(`  rig team chat ${receipt.runId}        (the conversation so far)`);
        console.log("Then approve it once, which starts the work:");
        console.log(`  rig team approve-plan ${receipt.runId}`);
        return;
      }
      if (receipt.leadSeat) {
        console.log("");
        console.log("The lead proposes the implementer tasks. Read and decide them:");
        console.log(`  rig team proposal ${receipt.runId} ${receipt.taskId}`);
      }
      console.log("");
      console.log("Watch it:");
      console.log(`  ${base}/team?run=${encodeURIComponent(receipt.runId)}   (after rig config set ui.enabled true)`);
    });

  cmd.command("pair-browser")
    .description("print a one-time code for pairing the local Web UI")
    .option("--json", "print the code and expiry as JSON")
    .action(async (options: { json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) {
        console.error("error: no owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
        process.exitCode = 1;
        return;
      }
      const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
      if (!daemonStatusGuard(status, { json: options.json })) return;
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const response = await client.post<BrowserPairingReceipt>(BASE + "/owner-session/pairing", undefined,
        { headers: { Authorization: "Bearer " + token } });
      if (response.status !== 200 || !response.data?.code || typeof response.data.expiresAt !== "number") {
        const detail = [response.data?.code, response.data?.error].filter(Boolean).join(": ") || ("HTTP " + response.status);
        if (options.json) console.log(JSON.stringify({ error: detail }));
        else console.error("error: the browser pairing request was refused: " + detail);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify({ code: response.data.code, expiresAt: response.data.expiresAt }));
        return;
      }
      console.log(response.data.code);
    });

  cmd.command("resume <run-id>")
    .description("resume a blocked team run and offer its pending work to dispatch")
    .option("--add-minutes <n>", "increase the active wall-clock budget by N minutes")
    .option("--add-retries <n>", "increase the retry budget by N")
    .option("--add-review-rounds <n>", "increase the review budget by N")
    .option("--json", "print the daemon's receipt as JSON")
    .action(async (runId: string, options: { addMinutes?: string; addRetries?: string; addReviewRounds?: string; json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required", "No owner credential. Run ./setup.sh or set MULTI_AGENT_OWNER_TOKEN.");
      const parseIncrease = (value: string | undefined, flag: string): number | undefined => {
        if (value === undefined) return undefined;
        if (!/^\d+$/.test(value)) throw new TeamCommandError("team_budget_invalid", `${flag} takes a non-negative integer.`);
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) throw new TeamCommandError("team_budget_invalid", `${flag} is outside the safe integer range.`);
        return parsed;
      };
      const addMinutes = parseIncrease(options.addMinutes, "--add-minutes");
      const addRetries = parseIncrease(options.addRetries, "--add-retries");
      const addReviewRounds = parseIncrease(options.addReviewRounds, "--add-review-rounds");
      const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
      if (status.state !== "running" || status.healthy === false) throw new TeamCommandError("team_daemon_unavailable", "The daemon is not running or healthy.");
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const headers = { Authorization: "Bearer " + token }, path = `${BASE}/runs/${encodeURIComponent(runId)}`;
      const run = await client.get<{ run?: { entityVersion: number } }>(path, { headers });
      if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
        throw new TeamCommandError("control_unavailable", "The current run version could not be read.");
      }
      const payload = { ...(addMinutes === undefined ? {} : { addMinutes }), ...(addRetries === undefined ? {} : { addRetries }),
        ...(addReviewRounds === undefined ? {} : { addReviewRounds }) };
      const response = await client.post<{ status?: string; reason?: string; reasonKey?: string; error?: string; resumeTaskIds?: string[] }>(
        `${path}/resume`, { protocolVersion: "1.0", runId, actionId: runId, expectedEntityVersion: run.data.run!.entityVersion,
          idempotencyKey: randomUUID(), payload }, { headers });
      if (options.json) { console.log(JSON.stringify(response.data)); if (response.status >= 400) process.exitCode = 1; return; }
      if (response.status >= 400 || response.data?.status === "denied") {
        throw new TeamCommandError(response.data?.reasonKey ?? "team_resume_refused",
          response.data?.reason ?? response.data?.error ?? `Resume was refused (HTTP ${response.status}).`);
      }
      console.log(`Resumed ${runId}.`);
      if (response.data?.resumeTaskIds?.length) console.log(`Pending tasks offered: ${response.data.resumeTaskIds.join(", ")}`);
    });

  /** A named project uses bootstrap; the unnamed command retains its explicit-seat contract. */
  cmd.command("create <repository>")
    .description("create a private GitHub project with --name, or register a local repository with manual seats")
    .option("--name <name>", "create a project from this folder with only its configured lead")
    .option("--dry-run", "preview the named project's upload without changing it")
    .option("--yes", "confirm the named project's upload without an interactive prompt")
    .option("--lead <client>", "the lead seat's client: claude-code or codex", "claude-code")
    .option("--implementers <clients>", "the implementer seats' clients, comma separated", "claude-code,codex")
    .option("--reviewer <client>", "the reviewer seat's client: claude-code or codex", "claude-code")
    .option("--json", "print the daemon's team as JSON")
    .action(async (repository: string, opts: { name?: string; dryRun?: boolean; yes?: boolean;
      lead: string; implementers: string; reviewer: string; json?: boolean }, command: Command) => {
      const named = opts.name !== undefined;
      if ((named && ["lead", "implementers", "reviewer"].some(flag => command.getOptionValueSource(flag) === "cli"))
        || (!named && (opts.dryRun || opts.yes))) {
        throw new TeamCommandError("team_options_conflict", "Use --name for a lead-only project, without manual seat flags. --dry-run and --yes apply to that path.");
      }
      const seats: Team["seats"] | undefined = named ? undefined : [
        { role: "lead", client: teamClient(opts.lead, "--lead") },
        ...opts.implementers.split(",").map(value => value.trim()).filter(Boolean)
          .map(value => ({ role: "implementer" as const, client: teamClient(value, "--implementers") })),
        { role: "reviewer", client: teamClient(opts.reviewer, "--reviewer") },
      ];
      if (seats && !seats.some(seat => seat.role === "implementer")) {
        throw new TeamCommandError("team_client_invalid", "--implementers needs at least one client.");
      }
      // The daemon resolves a path against its own working directory, and it is the one host a
      // shell here cannot assume is the same, so a relative path is made absolute here.
      let root = named ? resolve(repository) : repository;
      if (!isAbsolute(root)) {
        try { root = realpathSync(root); } catch {
          throw new TeamCommandError("team_repository_unreadable", `The repository path "${repository}" could not be read.`);
        }
      }
      const token = ownerToken(deps());
      if (!token) {
        console.error("error: no owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
        process.exitCode = 1;
        return;
      }
      const status = await getDaemonStatus(deps().lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const headers = { Authorization: "Bearer " + token };
      if (named) {
        const response = await client.post<{ preview?: { repository: string; name: string; action: "create" | "push" | "register";
          fileCount: number; excludedPaths: string[] }; code?: string; error?: string }>(BASE + "/teams",
        { repository: root, name: opts.name, dryRun: true }, { headers });
        const preview = response.data?.preview;
        if (response.status !== 200 || !preview) {
          console.error("error: the project preview was refused: " + (response.data?.error ?? `HTTP ${response.status}`));
          process.exitCode = 1;
          return;
        }
        root = preview.repository;
        if (opts.dryRun && opts.json) { console.log(JSON.stringify(preview)); return; }
        const print = opts.json ? console.error : console.log;
        print(`Folder: ${preview.repository}`);
        print(preview.action === "register" ? "Register the existing origin. Nothing will be created or pushed on GitHub."
          : preview.action === "push" ? `Upload the existing commit (${preview.fileCount} files) and its reachable history to a new private GitHub repository. Uncommitted changes stay local.`
          : `Upload ${preview.fileCount} files to a new private GitHub repository.`);
        if (preview.excludedPaths.length) print(`Excluded: ${preview.excludedPaths.join(", ")}`);
        if (opts.dryRun) return;
        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            print("Preview only. Review it, then repeat the command with --yes to create the project.");
            process.exitCode = 1;
            return;
          }
          const prompt = createInterface({ input: process.stdin, output: process.stderr });
          try { if (!/^y(?:es)?$/i.test((await prompt.question("Create this project? [y/N] ")).trim())) return; }
          finally { prompt.close(); }
        }
      }
      const response = await client.post<{ team?: Team; code?: string; error?: string }>(BASE + "/teams",
        { repository: root, ...(named ? { name: opts.name } : { seats }) }, { headers });
      if (response.status !== 201 || !response.data?.team) {
        console.error("error: the team was refused: " + (response.data?.error ?? `HTTP ${response.status}`));
        process.exitCode = 1;
        return;
      }
      const team = response.data.team;
      if (opts.json) { console.log(JSON.stringify(team)); return; }
      console.log(`Team ${team.name}`);
      console.log(`Repository: ${team.repository}`);
      for (const seat of team.seats) console.log(`  ${seat.role.padEnd(12)} ${seat.client}${seat.model ? "  " + seat.model : ""}`);
      console.log("");
      console.log(`Next: rig team start "<goal>" --rig ${team.name}${named ? " --planning" : ""}`);
    });

  /**
   * Fetch one task's result. `apply` and `diff` share this: the patch and the manifest are the
   * candidate's own computation, and neither verb may produce a second reading of the tree.
   */
  async function readResult(runId: string, taskId: string | undefined): Promise<TeamTaskResult> {
    const token = ownerToken(deps());
    if (!token) throw new TeamCommandError("control_auth_required",
      "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
    const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
    if (status.state !== "running" || status.healthy === false) throw new TeamCommandError("team_daemon_unavailable",
      "The daemon is not running or did not answer its health probe. Check it with 'rig daemon status'.");
    const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
    const headers = { Authorization: "Bearer " + token };
    const resolved = taskId ?? await firstTask(client, runId, headers);
    const response = await client.get<{ protocolVersion: string; result: TeamTaskResult }>(
      `${BASE}/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(resolved)}/result`, { headers });
    if (response.status === 200 && response.data.result?.schema === "multi-agent-team-result/v1") return response.data.result;
    const code = (response.data as { code?: string } | undefined)?.code ?? "team_result_unavailable";
    const message = (response.data as { error?: string } | undefined)?.error ?? "The daemon refused the result read.";
    if (response.status === 401) throw new TeamCommandError("control_auth_required",
      "The owner credential was refused. Check MULTI_AGENT_OWNER_TOKEN or re-run ./setup.sh.");
    if (response.status === 409) throw new TeamCommandError(code, `${message} Wait for the task to finish, then retry.`);
    throw new TeamCommandError(code, message);
  }

  /** The run's only implementer task, so `rig team diff <run-id>` needs no task id for a one-task run. */
  async function firstTask(client: DaemonClient, runId: string, headers: Record<string, string>): Promise<string> {
    const response = await client.get<{ read?: { tasks: Array<{ taskId: string; role: string }> } }>(
      `${BASE}/runs/${encodeURIComponent(runId)}/read`, { headers });
    const tasks = response.data.read?.tasks.filter(task => task.role === "implementer") ?? [];
    if (response.status !== 200 || tasks.length !== 1) {
      throw new TeamCommandError("team_task_required",
        tasks.length === 0 ? "This run has no implementer task to read."
          : "This run has more than one implementer task; name one with --task <id>.");
    }
    return tasks[0]!.taskId;
  }

  /** The changed paths, from git's own reading of the patch. */
  function changedFiles(patch: string, cwd: string): string[] {
    return execFileSync("git", ["apply", "--numstat", "-z"], { cwd, input: patch, encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"] }).split("\0").filter(Boolean).map(entry => entry.split("\t").at(-1)!);
  }

  /** Whether the target tree has anything uncommitted, which `git apply` would then mix into. */
  function dirty(cwd: string): boolean {
    return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd, encoding: "utf8" }).trim() !== "";
  }

  cmd.command("continue <run-id>")
    .description("deliver pending startup instructions after resolving the native prerequisite")
    .option("--task <id>", "task to continue (default: the run's only implementer task)")
    .option("--json", "print the continuation result as JSON")
    .action(async (runId: string, options: { task?: string; json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required", "No owner credential. Run ./setup.sh or set MULTI_AGENT_OWNER_TOKEN.");
      const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
      if (status.state !== "running" || status.healthy === false) throw new TeamCommandError("team_daemon_unavailable", "The daemon is not running or healthy.");
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const headers = { Authorization: "Bearer " + token }, path = `${BASE}/runs/${encodeURIComponent(runId)}`;
      const task = options.task ?? await firstTask(client, runId, headers);
      const run = await client.get<{ run?: { entityVersion: number } }>(path, { headers });
      if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
        throw new TeamCommandError("continuation_unavailable", "The current run version could not be read.");
      }
      const result = await client.post<{ ok?: boolean; error?: string; message?: string; code?: string }>(
        `${path}/tasks/${encodeURIComponent(task)}/continue`,
        { protocolVersion: "1.0", expectedEntityVersion: run.data.run!.entityVersion }, { headers });
      if (result.status !== 200 || !result.data?.ok) throw new TeamCommandError(result.data?.code ?? "continuation_unavailable",
        result.data?.message ?? result.data?.error ?? "Continuation was refused. Resolve the native prerequisite and refresh the run.");
      console.log(options.json ? JSON.stringify(result.data) : result.data.message ?? "Startup instructions delivered to the existing conversation.");
    });

  /**
   * MVP slice C3 — the owner's read of a lead's decomposition, and the decision it becomes.
   *
   * The lead cannot admit work: it writes one file into its own candidate tree, and the daemon
   * reads it at that boundary. This verb asks the daemon to read it, shows the exact batch, and
   * records the owner's decision. Nothing the lead wrote reaches the run without that decision,
   * and the tasks it admits then run, complete and get reviewed through the paths C1, C2 and
   * the completion slice already own.
   *
   * `--decide` is the owner action: it records the pending approval carrying the batch the
   * daemon just read, then decides it through the same `approvals/decide` route the Web UI's
   * decision card uses. Without it the verb only reads, so a proposal can be inspected first.
   */
  cmd.command("proposal <run-id> <task-id>")
    .description("read the lead task's proposed implementer tasks, and decide them as the owner")
    .option("--decide <decision>", "record the owner decision: approved or rejected")
    .option("--reason <text>", "with --decide rejected: why, which the lead's revision is told")
    .option("--json", "print the daemon's answer as JSON")
    .action(async (runId: string, taskId: string, options: { decide?: string; reason?: string; json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required",
        "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
      if (options.decide !== undefined && options.decide !== "approved" && options.decide !== "rejected") {
        throw new TeamCommandError("lead_decision_invalid", "--decide takes approved or rejected.");
      }
      const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
      if (status.state !== "running" || status.healthy === false) throw new TeamCommandError("team_daemon_unavailable",
        "The daemon is not running or did not answer its health probe. Check it with 'rig daemon status'.");
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const headers = { Authorization: "Bearer " + token };
      const runPath = `${BASE}/runs/${encodeURIComponent(runId)}`, path = `${runPath}/tasks/${encodeURIComponent(taskId)}/proposal`;
      const read = await client.get<{ proposal?: { tasks: Array<{ taskId: string; seat: string; paths: string[]; dependencies: string[]; body: string }> };
        code?: string; error?: string }>(path, { headers });
      if (read.status !== 200 || !read.data.proposal) {
        throw new TeamCommandError(read.data.code ?? "lead_proposal_unreadable",
          read.data.error ?? "The daemon did not answer the proposal read.");
      }
      const tasks = read.data.proposal.tasks;
      if (options.json && options.decide === undefined) { console.log(JSON.stringify(read.data.proposal)); return; }
      console.log(`The lead proposed ${tasks.length} implementer task(s):`);
      for (const task of tasks) console.log(`  ${task.taskId} on ${task.seat}: ${task.paths.join(", ")}`);
      if (options.decide === undefined) {
        console.log("");
        console.log("Run the same command with --decide approved (or rejected) to record the owner decision.");
        return;
      }
      const run = await client.get<{ run?: { entityVersion: number } }>(runPath, { headers });
      if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
        throw new TeamCommandError("control_unavailable", "The current run version could not be read.");
      }
      const request = (actionId: string, expectedEntityVersion: number, payload: unknown) => ({ protocolVersion: "1.0", runId,
        actionId, expectedEntityVersion, idempotencyKey: crypto.randomUUID(), payload });
      // The daemon re-reads the batch from the lead's own tree and needs only the expiry the
      // approval is held under. Sending an empty payload is refused as a malformed request, so
      // the window is stated here, one day, the same window a start's approval is given.
      const expiresAt = new Date(Date.now() + PROPOSAL_WINDOW_MS).toISOString();
      const proposed = await client.post<{ status?: string; reason?: string | null; code?: string; error?: string;
        value?: { id?: string; entityVersion?: number } | null }>(path,
        request(crypto.randomUUID(), run.data.run!.entityVersion, { leadProposal: { expiresAt } }), { headers });
      if (proposed.status !== 200 || proposed.data.status !== "accepted" || !proposed.data.value?.id) {
        throw new TeamCommandError(proposed.data.code ?? "lead_proposal_refused",
          proposed.data.reason ?? proposed.data.error ?? "The daemon refused the proposal.");
      }
      const decided = await client.post<{ status?: string; reason?: string | null; code?: string; error?: string;
        value?: { addedTasks?: string[] } | null }>(`${runPath}/approvals/decide`,
        request(proposed.data.value.id, (await client.get<{ run: { entityVersion: number } }>(runPath, { headers })).data.run.entityVersion,
          { approvalVersion: proposed.data.value.entityVersion, decision: options.decide,
            ...(options.reason === undefined ? {} : { reason: options.reason }) }), { headers });
      if (decided.status !== 200 || decided.data.status !== "accepted") {
        throw new TeamCommandError(decided.data.code ?? "lead_decision_refused",
          decided.data.reason ?? decided.data.error ?? "The daemon refused the decision.");
      }
      if (options.json) { console.log(JSON.stringify(decided.data)); return; }
      const added = decided.data.value?.addedTasks ?? [];
      console.log("");
      console.log(added.length ? `Approved; ${added.length} task(s) admitted and dispatched: ${added.join(", ")}.`
        : "Rejected; no task was admitted.");
    });

  /**
   * U5 — the owner's conversation with the lead.
   *
   * With no message the verb prints the conversation; with one it sends it and lets the daemon
   * decide whether a lead turn starts now or the message waits for the turn already running.
   * Nothing here composes a turn: the daemon's own chat owner stores the message and starts the
   * lead's next activation, so the CLI and the Web UI cannot disagree about what the lead saw.
   */
  cmd.command("chat <run-id> [message]")
    .description("print the run's owner↔lead conversation, or send the lead a message")
    .option("--json", "print the daemon's answer as JSON")
    .action(async (runId: string, message: string | undefined, options: { json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required",
        "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
      const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
      if (status.state !== "running" || status.healthy === false) throw new TeamCommandError("team_daemon_unavailable",
        "The daemon is not running or did not answer its health probe. Check it with 'rig daemon status'.");
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const headers = { Authorization: "Bearer " + token }, path = `${BASE}/runs/${encodeURIComponent(runId)}/chat`;
      if (message !== undefined) {
        const run = await client.get<{ run?: { entityVersion: number } }>(`${BASE}/runs/${encodeURIComponent(runId)}`, { headers });
        if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
          throw new TeamCommandError("control_unavailable", "The current run version could not be read.");
        }
        const sent = await client.post<{ status?: string; reason?: string | null; code?: string; error?: string;
          value?: { messageId?: string; queued?: boolean } | null }>(path, { protocolVersion: "1.0", runId,
          actionId: crypto.randomUUID(), expectedEntityVersion: run.data.run!.entityVersion,
          idempotencyKey: crypto.randomUUID(), payload: { body: message } }, { headers });
        if (sent.status !== 200 || sent.data.status !== "accepted") {
          throw new TeamCommandError(sent.data.code ?? "chat_refused",
            sent.data.reason ?? sent.data.error ?? "The daemon refused the message.");
        }
        if (options.json) { console.log(JSON.stringify(sent.data)); return; }
        console.log(sent.data.value?.queued
          ? "Queued: a lead turn is already running, and the lead answers this message when it ends."
          : "Sent: the lead's next turn answers it in the chat.");
        return;
      }
      const read = await client.get<{ phase?: string; messages?: Array<{ sender: string; body: string; createdAt: string }>;
        code?: string; error?: string }>(path, { headers });
      if (read.status !== 200 || !read.data.messages) {
        throw new TeamCommandError(read.data.code ?? "chat_unavailable",
          read.data.error ?? "The daemon did not answer the conversation read.");
      }
      if (options.json) { console.log(JSON.stringify(read.data)); return; }
      console.log(`Phase: ${read.data.phase ?? "unknown"}`);
      for (const entry of read.data.messages) {
        console.log("");
        console.log(`${entry.sender === "lead" ? "Lead" : "Owner"} · ${entry.createdAt}`);
        console.log(entry.body);
      }
    });

  /**
   * U5 — the owner's one action on a planning run: approve the plan.
   *
   * The daemon reads the plan from the lead's own tree and refuses a missing one by name, so
   * this verb cannot approve an artifact the lead did not write. The write scope is the one the
   * owner named when they started planning; the plan, its branch and the binding are the
   * daemon's to record.
   */
  cmd.command("approve-plan <run-id>")
    .description("approve the plan the lead wrote; the run starts delivery")
    .option("--json", "print the daemon's receipt as JSON")
    .action(async (runId: string, options: { json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required",
        "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
      const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
      if (status.state !== "running" || status.healthy === false) throw new TeamCommandError("team_daemon_unavailable",
        "The daemon is not running or did not answer its health probe. Check it with 'rig daemon status'.");
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const headers = { Authorization: "Bearer " + token };
      const run = await client.get<{ run?: { entityVersion: number; phase?: string } }>(
        `${BASE}/runs/${encodeURIComponent(runId)}`, { headers });
      if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
        throw new TeamCommandError("control_unavailable", "The current run version could not be read.");
      }
      const approved = await client.post<{ status?: string; reason?: string | null; code?: string; error?: string;
        value?: { phase?: string; planRef?: string } | null }>(`${BASE}/runs/${encodeURIComponent(runId)}/plan/approve`,
        { protocolVersion: "1.0", runId, actionId: crypto.randomUUID(),
          expectedEntityVersion: run.data.run!.entityVersion, idempotencyKey: crypto.randomUUID(), payload: {} }, { headers });
      if (approved.status !== 200 || approved.data.status !== "accepted") {
        throw new TeamCommandError(approved.data.code ?? "plan_approval_refused",
          approved.data.reason ?? approved.data.error ?? "The daemon refused the plan approval.");
      }
      if (options.json) { console.log(JSON.stringify(approved.data)); return; }
      console.log(`Approved ${approved.data.value?.planRef ?? "the plan"}; the run is ${approved.data.value?.phase ?? "in delivery"}.`);
      console.log("The lead decomposes the plan; read what it proposes with 'rig team proposal <run> <task>'.");
    });

  cmd.command("diff <run-id>")
    .description("print a finished task's patch")
    .option("--task <id>", "the task whose result to read (default: the run's only implementer task)")
    .action(async (runId: string, options: { task?: string }) => {
      const result = await readResult(runId, options.task);
      if (!result.patch) {
        throw new TeamCommandError("team_result_no_patch",
          `Task ${result.taskId} has no patch: its candidate uses the ${result.base} lane, which has no history to diff.`);
      }
      process.stdout.write(result.patch);
    });

  cmd.command("apply <run-id>")
    .description("apply a finished task's patch to your repository with git apply --3way")
    .option("--task <id>", "the task whose result to apply (default: the run's only implementer task)")
    .option("--repo <path>", "the repository to apply into (default: the run's project repository)")
    .option("--allow-dirty", "apply even when the target tree has uncommitted changes")
    .action(async (runId: string, options: { task?: string; repo?: string; allowDirty?: boolean }) => {
      const result = await readResult(runId, options.task);
      if (!result.patch) {
        throw new TeamCommandError("team_result_no_patch",
          `Task ${result.taskId} has no patch: its candidate uses the ${result.base} lane, which has no history to diff.`);
      }
      const target = realpathSync(options.repo ?? result.repositoryRoot);
      if (dirty(target) && !options.allowDirty) {
        throw new TeamCommandError("team_target_dirty",
          `${target} has uncommitted changes. Commit or stash them, or pass --allow-dirty.`);
      }
      const files = changedFiles(result.patch, target);
      try {
        execFileSync("git", ["apply", "--3way"], { cwd: target, input: result.patch, encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        const detail = (error as { stderr?: string }).stderr?.trim();
        throw new TeamCommandError("team_apply_failed",
          `git apply refused the patch in ${target}.${detail ? " " + detail : ""}`);
      }
      console.log(`Applied ${result.taskId} (${result.attemptId ?? "no recorded attempt"}) to ${target}.`);
      for (const file of files) console.log(`  ${file}`);
    });

  /**
   * MVP — the owner's one completion action.
   *
   * Agents cannot complete a task: an outcome is an owner observation, and R18 keeps acceptance
   * on validated evidence rather than on a process that exited. So this verb reads the
   * completion the daemon already computed — the attempt it observed stop and what it could
   * verify about the candidate — and sends exactly that to `tasks/outcome`. It invents no
   * evidence: a candidate the daemon could not validate is refused here, before the write, so
   * the refusal names the check that failed instead of a control error.
   *
   * `--findings` carries a reviewer's report, which is the evidence a review round acts on. It
   * is read from a file rather than typed, because it is JSON the reviewer wrote.
   */
  cmd.command("done <run-id> <task-id>")
    .description("record an owner-observed outcome for a task whose attempt has stopped")
    .option("--failed", "record the task as failed instead of done")
    .option("--findings <path>", "reviewer findings JSON (required for a reviewer task)")
    .option("--note <text>", "transition note recorded with the outcome")
    .option("--json", "print the daemon's receipt as JSON")
    .action(async (runId: string, taskId: string, options: { failed?: boolean; findings?: string; note?: string; json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required",
        "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
      const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
      if (status.state !== "running" || status.healthy === false) throw new TeamCommandError("team_daemon_unavailable",
        "The daemon is not running or did not answer its health probe. Check it with 'rig daemon status'.");
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const headers = { Authorization: "Bearer " + token }, path = `${BASE}/runs/${encodeURIComponent(runId)}`;
      const read = await client.get<{ completion?: TaskCompletion; code?: string; error?: string }>(
        `${path}/tasks/${encodeURIComponent(taskId)}/completion`, { headers });
      const completion = read.data.completion;
      if (read.status !== 200 || !completion) {
        throw new TeamCommandError(read.data.code ?? "team_completion_unavailable",
          read.data.error ?? "The daemon did not answer the completion read.");
      }
      if (completion.blockedReason) throw new TeamCommandError("team_completion_blocked", completion.blockedReason);
      const state = options.failed ? "failed" : "done";
      // A reviewer's report is the review; without it the round has nothing to act on, and the
      // daemon would record a completion that cannot start the loop.
      const findings = options.findings === undefined ? undefined : JSON.parse(readFileSync(options.findings, "utf8")) as unknown;
      if (completion.findingsRequired && state === "done" && findings === undefined) {
        throw new TeamCommandError("team_findings_required",
          `${taskId} is a reviewer task; pass its report with --findings <path>.`);
      }
      // The owner's own evidence is what the daemon could verify. A completion the daemon could
      // not validate is still recordable as `failed`, which is how a candidate that missed its
      // assignment is reported rather than accepted.
      if (state === "done" && !completion.evidence.validated) {
        throw new TeamCommandError("team_evidence_unvalidated",
          `${taskId} is not validated: ${completion.evidence.reasons.join("; ")}. Record it with --failed, or fix the candidate.`);
      }
      const evidence = { ...completion.evidence, ...(findings === undefined ? {} : { findings }) };
      // The outcome command addresses the task by its queue row, not by the id the run gave it.
      const body = { protocolVersion: "1.0", runId, actionId: completion.qitemId,
        expectedEntityVersion: (await client.get<{ run: { entityVersion: number } }>(path, { headers })).data.run.entityVersion,
        idempotencyKey: crypto.randomUUID(),
        payload: { expectedTaskVersion: completion.taskVersion, state,
          ...(state === "done" ? { closureReason: "no-follow-on" } : {}),
          ...(options.note === undefined ? {} : { transitionNote: options.note }),
          actorSession: completion.actorSession, attemptId: completion.attempt!.attemptId,
          expectedAttemptVersion: completion.attempt!.entityVersion, evidence } };
      const result = await client.post<{ status?: string; reason?: string | null; code?: string; error?: string;
        reviewTaskId?: string; reworkTaskId?: string }>(`${path}/tasks/outcome`, body, { headers });
      if (result.status !== 200 || result.data.status === "denied") {
        throw new TeamCommandError(result.data.code ?? "team_outcome_refused",
          result.data.reason ?? result.data.error ?? "The daemon refused the outcome.");
      }
      if (options.json) { console.log(JSON.stringify(result.data)); return; }
      console.log(`Recorded ${taskId} as ${state}.`);
      console.log(`  candidate: ${completion.evidence.manifestDigest ?? "unavailable"} (${completion.evidence.fileCount} file(s), ${completion.evidence.validated ? "validated" : "not validated"})`);
      for (const changed of completion.evidence.changedPaths) console.log(`  ${changed}`);
      if (result.data.reviewTaskId) console.log(`Review: ${result.data.reviewTaskId} was created and routed to the reviewer seat.`);
      if (result.data.reworkTaskId) console.log(`Rework: ${result.data.reworkTaskId} was reopened.`);
    });

  /**
   * U7 — the owner's one delivery action.
   *
   * The daemon does the merge, into the repository the team was created for, and answers with
   * what it did: fast-forwarded, merged with one commit, or already up to date. A refusal names
   * its reason — an open task, a dirty checkout, a conflict — and leaves the checkout as it was,
   * so this verb reports the daemon's answer rather than deciding one.
   */
  cmd.command("merge <run-id>")
    .description("merge the run's integration branch into the repository the team was created for")
    .option("--json", "print the daemon's answer as JSON")
    .action(async (runId: string, options: { json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required",
        "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
      const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
      if (status.state !== "running" || status.healthy === false) throw new TeamCommandError("team_daemon_unavailable",
        "The daemon is not running or did not answer its health probe. Check it with 'rig daemon status'.");
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const headers = { Authorization: "Bearer " + token }, path = `${BASE}/runs/${encodeURIComponent(runId)}`;
      const run = await client.get<{ run?: { entityVersion: number } }>(path, { headers });
      if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
        throw new TeamCommandError("team_run_unavailable", "The current run version could not be read.");
      }
      const answer = await client.post<{ status?: string; code?: string; reason?: string | null; error?: string;
        branch?: string; mode?: string | null; head?: string | null }>(`${path}/merge`, {
        protocolVersion: "1.0", runId, actionId: runId, expectedEntityVersion: run.data.run!.entityVersion,
        idempotencyKey: crypto.randomUUID(), payload: {} }, { headers });
      if (answer.status !== 200 || answer.data.status !== "merged") {
        throw new TeamCommandError(answer.data.code ?? "team_merge_refused",
          answer.data.reason ?? answer.data.error ?? "The daemon refused the merge.");
      }
      if (options.json) { console.log(JSON.stringify(answer.data)); return; }
      const how = answer.data.mode === "fast-forward" ? "fast-forwarded"
        : answer.data.mode === "merge-commit" ? "merged with one commit" : "already up to date";
      console.log(`Merged ${answer.data.branch} (${how}) at ${answer.data.head?.slice(0, 7)}.`);
    });

  /**
   * T017 — the owner's cancel, from the terminal.
   *
   * The daemon does the stopping: it records the intent, ends the processes this run launched
   * and reports what it observed. So this verb prints the daemon's own outcome — `canceled`
   * when every attempt was seen to end, `cancel_requested` with the attempts that are still
   * alive otherwise — and never claims a stop it did not see.
   */
  cmd.command("cancel <run-id>")
    .description("stop a run: record the cancellation and end the agents it launched")
    .option("--reason <text>", "why the run is being canceled", "Owner requested cancellation from the CLI")
    .option("--json", "print the daemon's receipt as JSON")
    .action(async (runId: string, options: { reason: string; json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required",
        "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
      const status = await getDaemonStatus(deps().lifecycleDeps, { cleanupStaleState: false });
      if (status.state !== "running" || status.healthy === false) throw new TeamCommandError("team_daemon_unavailable",
        "The daemon is not running or did not answer its health probe. Check it with 'rig daemon status'.");
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps().fetchImpl ? { fetchImpl: deps().fetchImpl } : {}) });
      const headers = { Authorization: "Bearer " + token }, path = `${BASE}/runs/${encodeURIComponent(runId)}`;
      const run = await client.get<{ run?: { entityVersion: number } }>(path, { headers });
      if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
        throw new TeamCommandError("team_run_unavailable", "The current run version could not be read.");
      }
      const receipt = await client.post<CancelReceipt>(`${path}/cancel`, { protocolVersion: "1.0", runId, actionId: runId,
        expectedEntityVersion: run.data.run!.entityVersion, idempotencyKey: crypto.randomUUID(),
        payload: { reason: options.reason } }, { headers });
      if (receipt.status !== 200 && receipt.status !== 202) {
        throw new TeamCommandError(receipt.data?.code ?? "team_cancel_refused",
          receipt.data?.reason ?? receipt.data?.error ?? "The daemon refused the cancellation.");
      }
      const value = receipt.data.value;
      if (options.json) { console.log(JSON.stringify(receipt.data)); return; }
      if (value?.state === "canceled") {
        console.log(`Canceled ${runId}.`);
        for (const attempt of value.attempts ?? []) {
          console.log(`  process ${attempt.processId}:${attempt.processStart} ${attempt.outcome}` +
            `${attempt.escalated ? " (SIGKILL after the grace period)" : ""}`);
        }
        for (const taskId of value.canceledTasks ?? []) console.log(`  task ${taskId} canceled`);
        console.log("  the candidate and its evidence are kept; rig team diff and rig team apply still read them");
        return;
      }
      console.log(`Cancellation of ${runId} is recorded but not yet observed.`);
      for (const attemptId of value?.unresolvedAttempts ?? []) console.log(`  still alive: ${attemptId}`);
      if (receipt.data.reason) console.log(`  ${receipt.data.reason}`);
      console.log("  run 'rig team cancel' again once the attempts end to record the outcome");
    });

  return cmd;
}

/** The cancel route's receipt, narrowed to what this verb prints. */
interface CancelReceipt {
  status: "accepted" | "pending-execution" | "conflict" | "denied" | "observed"; reason: string | null;
  code?: string; error?: string;
  value?: { state?: string; canceledTasks?: string[]; unresolvedAttempts?: string[];
    attempts?: Array<{ processId: number; processStart: string; outcome: string; escalated: boolean }> } | null;
}
