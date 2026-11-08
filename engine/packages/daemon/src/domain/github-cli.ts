import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const HOST = "github.com";
const DEVICE_URL = "https://github.com/login/device";

export interface GithubStatus { signedIn: boolean; login: string | null; host: string }
export interface GithubLoginState {
  state: "idle" | "pending" | "done" | "failed";
  code?: string;
  url?: string;
}

const ERROR_MESSAGES = {
  github_cli_missing: "GitHub CLI is not installed. Run ./setup.sh.",
  github_login_failed: "GitHub sign-in failed. Start a new sign-in.",
  github_not_signed_in: "Sign in to GitHub before creating a project.",
  github_identity_failed: "The signed-in GitHub account identity could not be read.",
  github_repo_exists: "A GitHub repository with that name already exists. Choose another name.",
  github_repo_create_failed: "The private GitHub repository was not created. Retry Create.",
  github_push_failed: "The initial push did not finish. Check repository access and private visibility, then retry Create.",
} as const;
export class GithubCliError extends Error {
  constructor(readonly code: keyof typeof ERROR_MESSAGES) { super(ERROR_MESSAGES[code]); }
}
export interface GithubAccount { login: string; name: string; email: string }

interface LoginFlow {
  child: ChildProcess;
  stopping?: boolean;
  ready: Promise<GithubLoginState>;
  closed: Promise<void>;
}

/** gh owns credentials; this owner retains only the public device-code flow. */
export class GithubCli {
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: string;
  private state: GithubLoginState = { state: "idle" };
  private flow: LoginFlow | null = null;
  private lifecycle: Promise<void> | null = null;

  constructor(options: { executable?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.command = options.executable ?? "gh";
    this.env = { ...(options.env ?? process.env), GH_HOST: HOST, GH_PROMPT_DISABLED: "1",
      GH_BROWSER: "true", NO_COLOR: "1", CLICOLOR: "0" };
    // An inherited token would override gh's store and make sign-out ineffective.
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
      delete this.env[key];
    }
    for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete this.env[key];
  }

  private executable(): string {
    const candidates = isAbsolute(this.command) ? [this.command]
      : (this.env.PATH ?? "").split(delimiter).map(path => join(path, this.command));
    for (const candidate of candidates) {
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
    }
    throw new GithubCliError("github_cli_missing");
  }

  private async run(args: string[], options: { cwd?: string; timeout?: number; failure?: keyof typeof ERROR_MESSAGES } = {}):
    Promise<{ stdout: string; stderr: string; ok: boolean }> {
    const executable = this.executable();
    try {
      const { stdout, stderr } = await execute(executable, args, {
        env: this.env, encoding: "utf8", timeout: options.timeout ?? 15_000, maxBuffer: 65_536, cwd: options.cwd,
      });
      return { stdout, stderr, ok: true };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (failure.code === "ENOENT") throw new GithubCliError("github_cli_missing");
      if (Number(failure.code) === 1) return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", ok: false };
      throw new GithubCliError(options.failure ?? "github_login_failed");
    }
  }

  private async activeAccount(): Promise<{ login: string; signedIn: boolean } | null> {
    const result = await this.run(["auth", "status", "--hostname", HOST, "--active", "--json", "hosts"]);
    if (!result.ok && !result.stdout.trim()) return null;
    try {
      const accounts = JSON.parse(result.stdout).hosts?.[HOST] as
        Array<{ state: string; login: string; active: boolean }> | undefined;
      const account = accounts?.find(value => value.active);
      if (!account || !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(account.login)) return null;
      return { login: account.login, signedIn: result.ok && account.state === "success" };
    } catch { throw new GithubCliError("github_login_failed"); }
  }

  async status(): Promise<GithubStatus> {
    const account = await this.activeAccount();
    return { signedIn: account?.signedIn ?? false, login: account?.signedIn ? account.login : null, host: HOST };
  }

  private async signedInLogin(expected?: string): Promise<string> {
    const account = await this.activeAccount();
    if (this.flow || !account?.signedIn || (expected !== undefined && account.login !== expected)) {
      throw new GithubCliError("github_not_signed_in");
    }
    return account.login;
  }

  account(): Promise<GithubAccount> {
    return this.mutateLifecycle(async () => {
      const login = await this.signedInLogin();
      const result = await this.run(["api", "user", "--hostname", HOST, "--jq", "{login,name,id}"], { failure: "github_identity_failed" });
      try {
        const value = JSON.parse(result.stdout);
        if (!result.ok || value.login !== login || !Number.isSafeInteger(value.id) || value.id < 1) throw new Error();
        const name = typeof value.name === "string" ? value.name.replace(/[\r\n<>]/g, " ").trim().slice(0, 128) : "";
        return { login, name: name || login, email: `${value.id}+${login}@users.noreply.github.com` };
      } catch { throw new GithubCliError("github_identity_failed"); }
    });
  }

  createPrivateRepository(name: string, repository: string, login: string): Promise<string> {
    return this.mutateLifecycle(async () => {
      await this.signedInLogin(login);
      const result = await this.run(["repo", "create", `${login}/${name}`, "--private", "--source", repository, "--remote", "origin"],
        { cwd: repository, timeout: 60_000, failure: "github_repo_create_failed" });
      if (!result.ok) throw new GithubCliError(/already exists/i.test(result.stderr) ? "github_repo_exists" : "github_repo_create_failed");
      return `https://${HOST}/${login}/${name}.git`;
    });
  }

  push(repository: string, remote: string, refspec: string, login: string): Promise<void> {
    return this.mutateLifecycle(async () => {
      await this.signedInLogin(login);
      try {
        const target = /^https:\/\/github\.com\/([^/]+)\/([a-z\d_.-]+)\.git$/i.exec(remote);
        if (!target || target[1] !== login) throw new Error();
        const identity = `${login}/${target[2]}`;
        const result = await this.run(["repo", "view", identity, "--json", "nameWithOwner,isPrivate"], { failure: "github_push_failed" });
        const value = JSON.parse(result.stdout);
        if (!result.ok || value.isPrivate !== true || String(value.nameWithOwner).toLowerCase() !== identity.toLowerCase()) throw new Error();
        const destination = await execute("git", ["-C", repository, "remote", "get-url", "--push", "--all", "origin"], {
          env: this.env, encoding: "utf8", timeout: 15_000, maxBuffer: 65_536,
        });
        // Git resolves push URLs and both rewrite rules. Use that same named remote,
        // only when its sole destination is the HTTPS repository whose privacy was checked.
        if (destination.stdout.trim() !== remote) throw new Error();
        await execute("git", ["-C", repository, ...this.gitCredentialArgs(), "-c", "remote.origin.mirror=false",
          "push", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", refspec], {
          env: { ...this.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8", timeout: 120_000, maxBuffer: 65_536,
        });
      } catch { throw new GithubCliError("github_push_failed"); }
    });
  }

  private mutateLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = (this.lifecycle ?? Promise.resolve()).then(operation);
    const settled = result.then(() => {}, () => {});
    this.lifecycle = settled;
    void settled.then(() => { if (this.lifecycle === settled) this.lifecycle = null; });
    return result;
  }

  loginState(): GithubLoginState {
    this.executable();
    return { ...this.state };
  }

  startLogin(): Promise<GithubLoginState> {
    const executable = this.executable();
    if (this.lifecycle) return this.lifecycle.then(() => this.startLogin());
    if (this.flow) return this.flow.ready;
    this.state = { state: "pending" };
    let ready!: (value: GithubLoginState) => void;
    let closed!: () => void;
    const child = spawn(executable, ["auth", "login", "--hostname", HOST, "--web", "--git-protocol", "https"],
      { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    const flow: LoginFlow = { child,
      ready: new Promise(resolve => { ready = resolve; }),
      closed: new Promise(resolve => { closed = resolve; }) };
    this.flow = flow;
    let output = "";
    const read = (chunk: Buffer) => {
      if (this.flow !== flow || flow.stopping || this.state.code) return;
      output = (output + chunk.toString("utf8")).slice(-8192);
      const code = /one-time code(?::\s*|\s+\()([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output)?.[1];
      if (code && output.includes(DEVICE_URL)) {
        this.state = { state: "pending", code, url: DEVICE_URL };
        output = "";
        ready({ ...this.state });
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    const timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    timeout.unref();
    let failed = false;
    child.on("error", () => { failed = true; });
    child.once("close", code => {
      clearTimeout(timeout);
      output = "";
      if (this.flow === flow) {
        this.flow = null;
        this.state = flow.stopping ? { state: "idle" } : !failed && code === 0 ? { state: "done" }
          : { state: "failed", code: "github_login_failed" };
      }
      ready({ ...this.state });
      closed();
    });
    return flow.ready;
  }

  private async stopFlow(): Promise<void> {
    const flow = this.flow;
    if (flow) {
      flow.stopping = true;
      flow.child.kill("SIGTERM");
      await flow.closed;
    }
    this.state = { state: "idle" };
  }

  stop(): Promise<void> {
    return this.mutateLifecycle(() => this.stopFlow());
  }

  async logout(): Promise<GithubStatus> {
    this.executable();
    return this.mutateLifecycle(async () => {
      await this.stopFlow();
      const account = await this.activeAccount();
      if (account) {
        const result = await this.run(["auth", "logout", "--hostname", HOST, "--user", account.login]);
        if (!result.ok) throw new GithubCliError("github_login_failed");
      }
      return this.status();
    });
  }

  /** Only the daemon's git command gets this helper; no global git configuration changes. */
  gitCredentialArgs(): string[] {
    const quoted = "'" + this.executable().replaceAll("'", "'\\''") + "'";
    return ["-c", "credential.helper=", "-c", "credential.helper=!" + quoted + " auth git-credential"];
  }
}
