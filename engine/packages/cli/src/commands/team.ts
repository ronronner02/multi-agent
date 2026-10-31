import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard, type LifecycleDeps } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";

/**
 * `rig team start "<goal>"` — MVP slice 2.
 *
 * One owner action that turns a goal into a run and a task, then prints the two ways to
 * watch it. The start itself is the daemon's: this verb authenticates with the owner
 * credential the managed daemon was started with, calls the one endpoint, and reports what
 * came back. It never builds a plan, a binding or a task of its own, so a CLI start and a
 * Web or TUI start cannot disagree about what was created.
 */

export interface TeamStartDeps {
  lifecycleDeps: LifecycleDeps;
  /** Owner control credential. Defaults to `MULTI_AGENT_OWNER_TOKEN` in this process. */
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
      const token = deps.ownerToken ?? readOpenRigEnv("MULTI_AGENT_OWNER_TOKEN")?.trim() ?? null;
      if (!token) {
        console.error("error: no owner credential. Start the daemon with ./scripts/start.sh, or set MULTI_AGENT_OWNER_TOKEN.");
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
      console.log(`  rig tui --team --run ${receipt.runId}`);
      console.log(`  ${base}/team?run=${encodeURIComponent(receipt.runId)}   (after rig config set ui.enabled true)`);
    });
  return cmd;
}
