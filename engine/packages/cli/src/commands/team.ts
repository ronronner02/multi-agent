import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

interface StartReceipt { runId: string; rigId: string; taskId: string; seat: string; state: string }

/** The result the daemon serves for one finished task; the shape `TeamTaskResult` publishes. */
interface TeamTaskResult {
  schema: "multi-agent-team-result/v1"; runId: string; taskId: string; attemptId: string | null;
  repositoryRoot: string; base: "commit" | "snapshot"; baseIdentifier: string; manifestDigest: string;
  files: Array<{ path: string; hash: string; tracked: boolean }>; patch: string;
}

/** The completion read the owner action forwards: what the daemon observed and could verify. */
interface TaskCompletion {
  taskId: string; role: "lead" | "implementer" | "reviewer"; subjectTaskId: string;
  queueState: string | null; taskVersion: number; actorSession: string | null;
  attempt: { attemptId: string; entityVersion: number; state: string; observed: boolean } | null;
  openAttempts: number; blockedReason: string | null; findingsRequired: boolean;
  evidence: { validated: boolean; manifestDigest: string | null; base: string | null; baseIdentifier: string | null;
    fileCount: number; changedPaths: string[]; outsideAssignment: string[]; reasons: string[] };
}

const BASE = "/api/team-control";

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

export function teamCommand(depsOverride?: TeamStartDeps): Command {
  const deps = (): TeamStartDeps => depsOverride ?? { lifecycleDeps: realDeps() };
  const cmd = new Command("team").description("start and inspect owner-governed team runs");
  cmd
    .command("start <goal>")
    .description("create a run and a task from a goal, then print how to watch it")
    .option("--rig <id-or-name>", "rig to run the work on (default: the only active rig)")
    .option("--seat <session>", "seat that takes the task (default: the rig's first agent node)")
    .option("--reviewer <session>", "seat every review round routes to (omit to create no review task)")
    .option("--repository <path>", "repository the plan and the work belong to (default: the seat's cwd)")
    .option("--plan <path>", "plan artifact, relative to the repository (default: plan.md)")
    .option("--write <path...>", "repository-relative paths the task may write (default: src)")
    .option("--json", "print the daemon's receipt as JSON")
    .action(async (goal: string, opts: Record<string, unknown>) => {
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
        ...(opts.reviewer ? { reviewerSeat: String(opts.reviewer) } : {}),
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
      console.log("");
      console.log("Watch it:");
      console.log(`  ${base}/team?run=${encodeURIComponent(receipt.runId)}   (after rig config set ui.enabled true)`);
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
      const body = { protocolVersion: "1.0", runId, actionId: completion.taskId,
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

  return cmd;
}
