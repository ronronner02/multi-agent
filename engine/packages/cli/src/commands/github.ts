import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { daemonStatusGuard, getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";
import { readOwnerTokenFile, type TeamStartDeps } from "./team.js";

interface GithubStatus { signedIn: boolean; login: string | null; host: string; code?: string }

export function githubCommand(depsOverride?: TeamStartDeps): Command {
  const command = new Command("github").description("inspect the owner's GitHub sign-in");
  command.command("status").description("show the GitHub account used by the daemon")
    .option("--json", "print the sign-in status as JSON")
    .action(async (options: { json?: boolean }) => {
      const deps = depsOverride ?? { lifecycleDeps: realDeps() };
      const token = deps.ownerToken === undefined
        ? readOpenRigEnv("MULTI_AGENT_OWNER_TOKEN")?.trim() || readOwnerTokenFile() : deps.ownerToken;
      if (!token) {
        console.error("error: no owner credential. Run ./setup.sh.");
        process.exitCode = 1;
        return;
      }
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = new DaemonClient(getDaemonUrl(status), deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
      try {
        const response = await client.get<GithubStatus>("/api/team-control/github/status",
          { headers: { Authorization: "Bearer " + token } });
        if (response.status !== 200) {
          console.error(response.data?.code === "github_cli_missing"
            ? "error: GitHub CLI is not installed. Run ./setup.sh." : "error: GitHub status is unavailable.");
          process.exitCode = 1;
          return;
        }
        const account = response.data;
        const value = { signedIn: account.signedIn, login: account.login, host: account.host };
        if (options.json) console.log(JSON.stringify(value));
        else console.log(account.signedIn ? "Signed in to " + account.host + " as " + account.login + "."
          : "Not signed in to GitHub.");
        if (!account.signedIn) process.exitCode = 1;
      } catch {
        console.error("error: GitHub status could not be read. Check that the daemon is running.");
        process.exitCode = 1;
      }
    });
  return command;
}
