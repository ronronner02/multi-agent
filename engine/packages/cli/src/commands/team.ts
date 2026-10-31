import { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard, type LifecycleDeps } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";

/**
 * `rig team start "<goal>"` — MVP slice 2.
 *
 * One owner action that turns a goal into a run and a task, then prints how to watch it. The
 * start itself is the daemon's: this verb authenticates with the owner credential the managed
 * daemon was started with, calls the one endpoint, and reports what came back. It never builds
 * a plan, a binding or a task of its own, so a CLI start and a Web start cannot disagree about
 * what was created.
 */

export interface TeamStartDeps {
  lifecycleDeps: LifecycleDeps;
  /** Owner control credential. Defaults to `MULTI_AGENT_OWNER_TOKEN`, then `owner.env`. */
  ownerToken?: string | null;
  fetchImpl?: typeof fetch;
}

interface StartReceipt {
  runId: string;
  rigId: string;
  taskId: string;
  seat: string;
  state: string;
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

export function teamCommand(depsOverride?: TeamStartDeps): Command {
  const cmd = new Command("team").description("start and inspect owner-governed team runs");
  cmd
    .command("start <goal>")
    .description("create a run and a task from a goal, then print how to watch it")
    .option("--rig <id-or-name>", "rig to run the work on (default: the only active rig)")
    .option("--seat <session>", "seat that takes the task (default: the rig's first agent node)")
    .option("--repository <path>", "repository the plan and the work belong to (default: the seat's cwd)")
    .option("--plan <path>", "plan artifact, relative to the repository (default: plan.md)")
    .option("--write <path...>", "repository-relative paths the task may write (default: src)")
    .option("--json", "print the daemon's receipt as JSON")
    .action(async (goal: string, opts: Record<string, unknown>) => {
      const deps = depsOverride ?? { lifecycleDeps: realDeps() };
      const token = deps.ownerToken ?? readOpenRigEnv("MULTI_AGENT_OWNER_TOKEN")?.trim() ?? readOwnerTokenFile();
      if (!token) {
        console.error("error: no owner credential. Run ./setup.sh, which writes the owner token, or set MULTI_AGENT_OWNER_TOKEN.");
        process.exitCode = 1;
        return;
      }
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = new DaemonClient(getDaemonUrl(status), { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
      const body = { goal, ...(opts.rig ? { rig: String(opts.rig) } : {}), ...(opts.seat ? { seat: String(opts.seat) } : {}),
        ...(opts.repository ? { repository: { root: String(opts.repository), ...(opts.plan ? { planRef: String(opts.plan) } : {}) } }
          : opts.plan ? { repository: { planRef: String(opts.plan) } } : {}),
        ...(opts.write ? { writePaths: (opts.write as string[]) } : {}) };
      let receipt: StartReceipt;
      const response = await client.post<StartReceipt & { error?: string }>(BASE + "/runs", body,
        { headers: { Authorization: "Bearer " + token } });
      if (response.status !== 201 || !response.data?.runId) {
        console.error("error: the start was refused: " + (response.data?.error ?? `HTTP ${response.status}`));
        process.exitCode = 1;
        return;
      }
      receipt = response.data;
      if (opts.json) { console.log(JSON.stringify(receipt)); return; }
      const base = getDaemonUrl(status);
      console.log(`Run:  ${receipt.runId}`);
      console.log(`Task: ${receipt.taskId} on ${receipt.seat}`);
      console.log("");
      console.log("Watch it:");
      console.log(`  ${base}/team?run=${encodeURIComponent(receipt.runId)}   (after rig config set ui.enabled true)`);
    });
  return cmd;
}
