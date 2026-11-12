import { Command } from "commander";
import { DaemonClient, DaemonHttpError, type DaemonResponse } from "../client.js";
import { readOwnerTokenFile, type TeamStartDeps } from "./team.js";

interface GithubStatus { signedIn: boolean; login: string | null; host: string; code?: string; error?: string }
interface LoginState { state: "idle" | "pending" | "done" | "failed"; code?: string; url?: string; error?: string }
const BASE = "/api/team-control/github";

function checked<T extends { code?: string; error?: string }>(response: DaemonResponse<T>): T {
  if (response.status !== 200) throw new DaemonHttpError(response.data.code ?? "github_login_failed",
    response.data.code === "github_cli_missing" ? "GitHub CLI is not installed (github_cli_missing)."
      : `GitHub request failed (${response.data.code ?? response.status}).`);
  return response.data;
}

async function request<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch (error) {
    if (error instanceof DaemonHttpError) throw error;
    throw new DaemonHttpError("github_unavailable", "GitHub could not be read. Check that the daemon is running.");
  }
}

async function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 1_000);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export function githubCommand(depsOverride?: TeamStartDeps): Command {
  const command = new Command("github").description("Manage GitHub sign-in through the daemon");
  async function connection() {
    const deps = depsOverride ?? {};
    const token = deps.ownerToken === undefined
      ? process.env.MULTI_AGENT_OWNER_TOKEN?.trim() || readOwnerTokenFile() : deps.ownerToken;
    if (!token) throw new DaemonHttpError("control_auth_required",
      "No owner credential. Set MULTI_AGENT_OWNER_TOKEN or configure the owner token.");
    const client = new DaemonClient(deps.baseUrl, { fetchImpl: deps.fetchImpl, senderIdentity: false });
    await request(client.waitForReady());
    return { client, headers: { Authorization: `Bearer ${token}` } };
  }
  command.command("status").description("Show the GitHub account used by the daemon")
    .option("--json", "Print the sign-in status as JSON")
    .action(async (options: { json?: boolean }) => {
      const { client, headers } = await connection();
      const account = checked(await request(client.get<GithubStatus>(BASE + "/status", { headers })));
      const value = { signedIn: account.signedIn, login: account.login, host: account.host };
      if (options.json) console.log(JSON.stringify(value));
      else console.log(account.signedIn ? `Signed in to ${account.host} as ${account.login}.` : "Not signed in to GitHub.");
      if (!account.signedIn) process.exitCode = 1;
    });
  command.command("sign-in").description("Sign in using GitHub's device code")
    .option("--json", "Print device flow updates as JSON")
    .action(async (options: { json?: boolean }) => {
      const { client, headers } = await connection();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const signal = controller.signal;
      process.on("SIGINT", cancel);
      try {
        let state = checked(await request(client.post<LoginState>(BASE + "/login", undefined, { headers, signal, timeoutMs: 60_000 })));
        if (state.state === "pending" && state.code && state.url) {
          if (options.json) console.log(JSON.stringify({ state: state.state, code: state.code, url: state.url }));
          else console.log(`Open ${state.url} and enter code ${state.code}.`);
        }
        while (state.state === "pending") {
          await waitForPoll(signal);
          state = checked(await request(client.get<LoginState>(BASE + "/login", { headers, signal })));
        }
        if (state.state !== "done") throw new DaemonHttpError(state.code ?? "github_login_failed",
          state.error ?? "GitHub sign-in did not complete.");
        const account = checked(await request(client.get<GithubStatus>(BASE + "/status", { headers, signal })));
        if (!account.signedIn) throw new DaemonHttpError("github_not_signed_in", "GitHub did not confirm a signed-in account.");
        if (options.json) console.log(JSON.stringify({ signedIn: account.signedIn, login: account.login, host: account.host }));
        else console.log(`Signed in to ${account.host} as ${account.login}.`);
      } catch (error) {
        if (!signal.aborted) throw error;
        try {
          checked(await request(client.post<LoginState>(BASE + "/login/stop", undefined, { headers })));
        } catch {
          throw new DaemonHttpError("github_login_cancelled", "GitHub sign-in cancelled; daemon login stop could not be confirmed.");
        }
        throw new DaemonHttpError("github_login_cancelled", "GitHub sign-in cancelled.");
      } finally {
        process.off("SIGINT", cancel);
      }
    });
  return command;
}
