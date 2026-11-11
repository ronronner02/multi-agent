import { realpathSync } from "node:fs";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { createInterface } from "node:readline/promises";
import { DaemonClient } from "../client.js";
import { readOpenRigEnv } from "../openrig-compat.js";

/**
 * Owner actions and result reads use the daemon HTTP API.
 *
 * `start` turns a goal into a run and a task; `result` and `diff` read a finished task's patch
 * back to the owner. Every verb is the daemon's work: these only authenticate with the owner
 * credential the managed daemon was started with and report what came back, so a CLI action and
 * a Web action cannot disagree about what exists.
 */

export interface TeamStartDeps {
  baseUrl?: string;
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

const BASE = "/api/team-control";

/** Read the owner credential from the per-user configuration. */
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
  return deps.ownerToken === undefined
    ? readOpenRigEnv("MULTI_AGENT_OWNER_TOKEN")?.trim() || readOwnerTokenFile() : deps.ownerToken;
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
  const deps = (): TeamStartDeps => depsOverride ?? {};
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
      const client = new DaemonClient(deps().baseUrl, { fetchImpl: deps().fetchImpl, senderIdentity: false });
      await client.waitForReady();
      const body = { goal, ...(opts.rig ? { rig: String(opts.rig) } : {}), ...(opts.seat ? { seat: String(opts.seat) } : {}),
        ...(opts.workflow ? { workflow: { entrypoint: String(opts.workflow), readOnly: opts.readOnly === true } } : {}),
        ...(opts.lead ? { lead: String(opts.lead) } : {}),
        ...(opts.reviewer ? { reviewerSeat: String(opts.reviewer) } : {}),
        ...(opts.planning ? { planning: true } : {}),
        ...(opts.repository ? { repository: { root: String(opts.repository), ...(opts.plan ? { planRef: String(opts.plan) } : {}) } }
          : opts.plan ? { repository: { planRef: String(opts.plan) } } : {}),
        ...(opts.write ? { writePaths: (opts.write as string[]) } : {}) };
      const response = await client.post<StartReceipt & { code?: string; error?: string }>(BASE + "/runs", body,
        { headers: { Authorization: "Bearer " + token } });
      if (response.status !== 201 || !response.data?.runId) {
        throw new TeamCommandError(response.data?.code ?? "team_start_refused",
          "the start was refused: " + (response.data?.error ?? `HTTP ${response.status}`));
      }
      const receipt = response.data;
      if (opts.json) { console.log(JSON.stringify(receipt)); return; }
      const base = client.baseUrl;
      console.log(`Run:  ${receipt.runId}`);
      console.log(`Task: ${receipt.taskId} on ${receipt.seat}`);
      if (receipt.phase === "planning") {
        console.log("");
        console.log("Agree the plan with the lead in the chat:");
        console.log(`  rig team chat ${receipt.runId} "your message"`);
        console.log(`  rig team chat ${receipt.runId}        (the conversation so far)`);
        console.log("Then approve it once, which starts the work:");
        console.log(`  rig team approve ${receipt.runId}`);
        return;
      }
      console.log("");
      console.log("Watch it:");
      console.log(`  ${base}/team?run=${encodeURIComponent(receipt.runId)}`);
    });

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
      let root = named && !win32.isAbsolute(repository) ? resolve(repository) : repository;
      if (!isAbsolute(root) && !win32.isAbsolute(root)) {
        try { root = realpathSync.native(root); } catch {
          throw new TeamCommandError("team_repository_unreadable", `The repository path "${repository}" could not be read.`);
        }
      }
      const token = ownerToken(deps());
      if (!token) {
        console.error("error: no owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
        process.exitCode = 1;
        return;
      }
      const client = new DaemonClient(deps().baseUrl, { fetchImpl: deps().fetchImpl, senderIdentity: false });
      await client.waitForReady();
      const headers = { Authorization: "Bearer " + token };
      if (named) {
        const response = await client.post<{ preview?: { repository: string; name: string; action: "create" | "push" | "register";
          fileCount: number; excludedPaths: string[] }; code?: string; error?: string }>(BASE + "/teams",
        { repository: root, name: opts.name, dryRun: true }, { headers });
        const preview = response.data?.preview;
        if (response.status !== 200 || !preview) {
          throw new TeamCommandError(response.data?.code ?? "team_preview_refused",
            "the project preview was refused: " + (response.data?.error ?? `HTTP ${response.status}`));
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
        throw new TeamCommandError(response.data?.code ?? "team_create_refused",
          "the team was refused: " + (response.data?.error ?? `HTTP ${response.status}`));
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
   * Fetch one task's result. `result` and `diff` share this: the patch and the manifest are the
   * candidate's own computation, and neither verb may produce a second reading of the tree.
   */
  async function readResult(runId: string, taskId: string | undefined): Promise<TeamTaskResult> {
    const token = ownerToken(deps());
    if (!token) throw new TeamCommandError("control_auth_required",
      "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
    const client = new DaemonClient(deps().baseUrl, { fetchImpl: deps().fetchImpl, senderIdentity: false });
    await client.waitForReady();
    const headers = { Authorization: "Bearer " + token };
    const resolved = taskId ?? await firstTask(client, runId, headers);
    const response = await client.get<{ protocolVersion: string; result: TeamTaskResult }>(
      `${BASE}/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(resolved)}/result`, { headers });
    if (response.status === 200 && response.data.result?.schema === "multi-agent-team-result/v1") return response.data.result;
    const code = (response.data as { code?: string } | undefined)?.code ?? "team_result_unavailable";
    const message = (response.data as { error?: string } | undefined)?.error ?? "The daemon refused the result read.";
    if (response.status === 401) throw new TeamCommandError(code,
      "The owner credential was refused. Check MULTI_AGENT_OWNER_TOKEN or re-run ./setup.sh.");
    if (response.status === 409) throw new TeamCommandError(code, `${message} Wait for the task to finish, then retry.`);
    throw new TeamCommandError(code, message);
  }

  /** The run's only implementer task, so `rig team diff <run-id>` needs no task id for a one-task run. */
  async function firstTask(client: DaemonClient, runId: string, headers: Record<string, string>): Promise<string> {
    const response = await client.get<{ code?: string; error?: string; read?: { tasks: Array<{ taskId: string; role: string }> } }>(
      `${BASE}/runs/${encodeURIComponent(runId)}/read`, { headers });
    if (response.status !== 200) throw new TeamCommandError(response.data?.code ?? "team_result_unavailable",
      response.data?.error ?? "The run could not be read.");
    const tasks = response.data.read?.tasks.filter(task => task.role === "implementer") ?? [];
    if (response.status !== 200 || tasks.length !== 1) {
      throw new TeamCommandError("team_task_required",
        tasks.length === 0 ? "This run has no implementer task to read."
          : "This run has more than one implementer task; name one with --task <id>.");
    }
    return tasks[0]!.taskId;
  }

  cmd.command("chat <run-id> [message]")
    .description("print the run's owner↔lead conversation, or send the lead a message")
    .option("--json", "print the daemon's answer as JSON")
    .action(async (runId: string, message: string | undefined, options: { json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required",
        "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
      const client = new DaemonClient(deps().baseUrl, { fetchImpl: deps().fetchImpl, senderIdentity: false });
      await client.waitForReady();
      const headers = { Authorization: "Bearer " + token }, path = `${BASE}/runs/${encodeURIComponent(runId)}/chat`;
      if (message !== undefined) {
        const run = await client.get<{ code?: string; error?: string; run?: { entityVersion: number } }>(`${BASE}/runs/${encodeURIComponent(runId)}`, { headers });
        if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
          throw new TeamCommandError(run.data?.code ?? "control_unavailable", run.data?.error ?? "The current run version could not be read.");
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
  cmd.command("approve <run-id>")
    .description("approve the plan the lead wrote; the run starts delivery")
    .option("--json", "print the daemon's receipt as JSON")
    .action(async (runId: string, options: { json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required",
        "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
      const client = new DaemonClient(deps().baseUrl, { fetchImpl: deps().fetchImpl, senderIdentity: false });
      await client.waitForReady();
      const headers = { Authorization: "Bearer " + token };
      const run = await client.get<{ code?: string; error?: string; run?: { entityVersion: number; phase?: string } }>(
        `${BASE}/runs/${encodeURIComponent(runId)}`, { headers });
      if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
        throw new TeamCommandError(run.data?.code ?? "control_unavailable", run.data?.error ?? "The current run version could not be read.");
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

    });

  cmd.command("result <run-id>")
    .description("print a finished task's result as JSON")
    .option("--json", "Print the result as JSON")
    .option("--task <id>", "the task whose result to read (default: the run's only implementer task)")
    .action(async (runId: string, options: { task?: string }) => {
      console.log(JSON.stringify(await readResult(runId, options.task)));
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

  cmd.command("merge <run-id>")
    .description("merge the run's integration branch into the repository the team was created for")
    .option("--json", "print the daemon's answer as JSON")
    .action(async (runId: string, options: { json?: boolean }) => {
      const token = ownerToken(deps());
      if (!token) throw new TeamCommandError("control_auth_required",
        "No owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
      const client = new DaemonClient(deps().baseUrl, { fetchImpl: deps().fetchImpl, senderIdentity: false });
      await client.waitForReady();
      const headers = { Authorization: "Bearer " + token }, path = `${BASE}/runs/${encodeURIComponent(runId)}`;
      const run = await client.get<{ code?: string; error?: string; run?: { entityVersion: number } }>(path, { headers });
      if (run.status !== 200 || !Number.isSafeInteger(run.data?.run?.entityVersion)) {
        throw new TeamCommandError(run.data?.code ?? "team_run_unavailable", run.data?.error ?? "The current run version could not be read.");
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

  return cmd;
}
