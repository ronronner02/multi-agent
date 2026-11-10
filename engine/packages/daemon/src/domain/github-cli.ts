import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { resolveExecutable } from "./executable-resolver.js";
import { isWindows, treeKillArgv } from "./platform.js";

const execute = promisify(execFile);
const HOST = "github.com";
const DEVICE_URL = "https://github.com/login/device";

const MAX_STDERR_BYTES = 2048;
const STAGED_VIEW_TIMEOUT = 15_000;
const PUSH_TIMEOUT_BASE = 120_000;
const VIEW_RETRY_BACKOFF = 3_000;
const PUSH_RETRY_BACKOFF = 4_000;

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
  github_view_retry: "The repository was created but is not yet visible. Retry the upload.",
  github_push_timeout: "The initial push timed out. Check your connection and repository size, then retry.",
  github_large_file_rejected: "The push was rejected because a file exceeds GitHub's 100 MiB limit.",
  github_network_failure: "A network or proxy failure prevented the upload. Check your connection and proxy settings.",
  github_auth_failure: "Authentication to GitHub failed. Sign in again.",
  github_proxy_unreachable: "The configured proxy is unreachable. Check the proxy settings.",
} as const;

export type GithubCliErrorCode = keyof typeof ERROR_MESSAGES;

export class GithubCliError extends Error {
  /** Bounded, credential-redacted stderr from the failed command, or null. */
  readonly stderr: string | null;
  constructor(readonly code: GithubCliErrorCode, stderr?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = "GithubCliError";
    this.stderr = stderr?.length ? stderr : null;
  }
}
export interface GithubAccount { login: string; name: string; email: string }

interface LoginFlow {
  child: ChildProcess;
  stopping?: boolean;
  ready: Promise<GithubLoginState>;
  closed: Promise<void>;
}

/**
 * Redact credentials and tokens from an arbitrary string, returning the safe form.
 * Removes common token patterns and known credential-like strings.
 * Exported for testing.
 */
export function redactCredentials(text: string): string {
  return text.replace(/ghp_[A-Za-z0-9_]{10,}/g, "ghp_REDACTED")
    .replace(/ghs_[A-Za-z0-9_]{10,}/g, "ghs_REDACTED")
    .replace(/gho_[A-Za-z0-9_]{10,}/g, "gho_REDACTED")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_REDACTED")
    .replace(/(?:bearer|password|secret|token)\s*[:=]\s*\S+/gi, "$1: REDACTED")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[PRIVATE KEY REDACTED]");
}

/**
 * Detect whether a push failure looks like a large-file rejection from GitHub.
 * GitHub emits "remote: error: File <name> is XX.XX MB; this exceeds GitHub's file size limit of 100.00 MB"
 * or "this exceeds the file size limit" or "large file detected".
 * Exported for testing.
 */
export function isLargeFileRejection(stderr: string): boolean {
  return /exceeds GitHub.*file size limit|exceeds the file size limit|large file detected|this exceeds.*100\s*MiB/i.test(stderr);
}

/**
 * Detect whether a push failure looks like an auth failure.
 * Exported for testing.
 */
export function isAuthFailure(stderr: string): boolean {
  return /authentication failed|auth failed|not authorized|403|401|permission denied/i.test(stderr);
}

/**
 * Detect whether a push failure looks like a network or proxy failure.
 * Exported for testing.
 */
export function isNetworkFailure(error: NodeJS.ErrnoException & { stderr?: string }): boolean {
  if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET" || error.code === "ETIMEDOUT"
    || error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return true;
  const stderr = (error.stderr ?? error.message ?? "").toLowerCase();
  return /could not resolve proxy|proxy connect|tunnel|getaddrinfo|connect econnrefused/i.test(stderr);
}

/** gh owns credentials; this owner retains only the public device-code flow. */
export class GithubCli {
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: string;
  private readonly execArgv: readonly string[];
  private readonly proxyEnv: { HTTPS_PROXY?: string; HTTP_PROXY?: string; NO_PROXY?: string };
  private state: GithubLoginState = { state: "idle" };
  private flow: LoginFlow | null = null;
  private lifecycle: Promise<void> | null = null;

  constructor(options: { executable?: string; env?: NodeJS.ProcessEnv; execArgv?: string[] } = {}) {
    this.command = options.executable ?? "gh";
    this.execArgv = options.execArgv ?? [];
    this.env = { ...(options.env ?? process.env), GH_HOST: HOST, GH_PROMPT_DISABLED: "1",
      GH_BROWSER: "true", NO_COLOR: "1", CLICOLOR: "0" };
    // An inherited token would override gh's store and make sign-out ineffective.
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
      delete this.env[key];
    }
    for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete this.env[key];
    // Proxy settings: a per-user setting overrides the daemon environment.
    const httpsProxy = readProxy(this.env, "HTTPS_PROXY");
    const httpProxy = readProxy(this.env, "HTTP_PROXY");
    const noProxy = this.env["NO_PROXY"]?.trim() || this.env["no_proxy"]?.trim() || "";
    this.proxyEnv = { HTTPS_PROXY: httpsProxy, HTTP_PROXY: httpProxy, NO_PROXY: noProxy };
  }

  /** Override proxy settings after construction, from the settings store. */
  setProxy(httpsProxy?: string, httpProxy?: string, noProxy?: string): void {
    if (httpsProxy !== undefined) this.proxyEnv.HTTPS_PROXY = httpsProxy || undefined;
    if (httpProxy !== undefined) this.proxyEnv.HTTP_PROXY = httpProxy || undefined;
    if (noProxy !== undefined) this.proxyEnv.NO_PROXY = noProxy || undefined;
  }

  private proxySource: (() => string | undefined) | null = null;

  /**
   * Read the owner's `github.proxy` setting at each spawn, so a change in Settings applies to the
   * next upload without a daemon restart. An empty setting falls back to the environment.
   */
  setProxySource(source: () => string | undefined): void { this.proxySource = source; }

  private proxy(): { HTTPS_PROXY?: string; HTTP_PROXY?: string; NO_PROXY?: string } {
    const configured = this.proxySource?.()?.trim();
    return configured ? { HTTPS_PROXY: configured, HTTP_PROXY: configured, NO_PROXY: this.proxyEnv.NO_PROXY } : this.proxyEnv;
  }

  /** The full argv for spawning gh: [executable, ...execArgv, ...commandArgs]. */
  private ghArgv(commandArgs: string[]): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
    const executable = this.resolvedExecutable();
    const env: NodeJS.ProcessEnv = { ...this.env };
    const proxy = this.proxy();
    if (proxy.HTTPS_PROXY) env.HTTPS_PROXY = proxy.HTTPS_PROXY;
    if (proxy.HTTP_PROXY) env.HTTP_PROXY = proxy.HTTP_PROXY;
    if (proxy.NO_PROXY) env.NO_PROXY = proxy.NO_PROXY;
    return { executable, args: [...this.execArgv, ...commandArgs], env };
  }

  private resolvedExecutable(): string {
    const resolution = resolveExecutable("gh", { configuredPath: this.command === "gh" ? undefined : this.command,
      env: this.env });
    if (resolution.ok) return resolution.path;
    throw new GithubCliError("github_cli_missing");
  }

  private async run(args: string[], options: { cwd?: string; timeout?: number; failure?: GithubCliErrorCode } = {}):
    Promise<{ stdout: string; stderr: string; ok: boolean }> {
    const { executable, args: fullArgs, env } = this.ghArgv(args);
    try {
      const { stdout, stderr } = await execute(executable, fullArgs, {
        env, encoding: "utf8", timeout: options.timeout ?? 15_000, maxBuffer: 65_536, cwd: options.cwd,
      });
      return { stdout, stderr, ok: true };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (failure.code === "ENOENT") throw new GithubCliError("github_cli_missing");
      if (Number.isSafeInteger(Number(failure.code)) && Number(failure.code) === 1) {
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", ok: false };
      }
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
      // After create, the remote may take a moment to propagate. The push step retries if view fails.
      return `https://${HOST}/${login}/${name}.git`;
    });
  }

  push(repository: string, remote: string, refspec: string, login: string): Promise<void> {
    return this.mutateLifecycle(async () => {
      await this.signedInLogin(login);
      // Validate remote identity.
      const target = /^https:\/\/github\.com\/([^/]+)\/([a-z\d_.-]+)\.git$/i.exec(remote);
      if (!target || target[1] !== login) throw new GithubCliError("github_push_failed");
      const identity = `${login}/${target[2]}`;

      // Proxy reachability check before the first upload attempt.
      // Using `gh api rate_limit` as a lightweight connectivity probe.
      // When a proxy is configured and unreachable, emit a distinct code.
      try {
        // This is a quick check; allow a short timeout so it doesn't block the create dialog.
        const probe = await this.run(["api", "rate_limit", "--hostname", HOST, "--jq", ".rate.remaining"], { timeout: 8_000 });
        if (!probe.ok) throw new Error();
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err instanceof GithubCliError && err.code === "github_cli_missing") throw err;
        // If a proxy is explicitly configured, the failure is likely proxy-related.
        const proxy = this.proxy();
      const isProxyConfigured = !!(proxy.HTTPS_PROXY || proxy.HTTP_PROXY);
        throw new GithubCliError(isProxyConfigured ? "github_proxy_unreachable" : "github_network_failure", String(error));
      }

      // Step 1: repo view — retry once if not found (transient after create).
      let viewed = await this.tryViewRepo(identity);
      if (!viewed) {
        // Brief backoff, then retry.
        await sleep(VIEW_RETRY_BACKOFF);
        viewed = await this.tryViewRepo(identity);
      }
      if (!viewed) throw new GithubCliError("github_view_retry");

      // Step 2: verify the destination URL.
      const destination = await execute("git", ["-C", repository, "remote", "get-url", "--push", "--all", "origin"], {
        env: this.env, encoding: "utf8", timeout: 15_000, maxBuffer: 65_536,
      });
      if (destination.stdout.trim() !== remote) throw new GithubCliError("github_push_failed");

      // Step 3: push — retry once for transient failures.
      const pushTimeout = await this.pushTimeout(repository, refspec);
      try {
        const result = await this.runGitPush(repository, refspec, pushTimeout);
        if (!result) throw new GithubCliError("github_push_failed");
      } catch (error) {
        if (error instanceof GithubCliError) throw error;
        // Transient: retry once.
        await sleep(PUSH_RETRY_BACKOFF);
        const result = await this.runGitPush(repository, refspec, pushTimeout);
        if (!result) throw error;
      }
    });
  }

  /** Check whether the remote is visible and private. Returns null on transient not-found. */
  private async tryViewRepo(identity: string): Promise<boolean | null> {
    try {
      const result = await execute(this.resolvedExecutable(), [...this.execArgv, "repo", "view", identity,
        "--json", "nameWithOwner,isPrivate", "--hostname", HOST],
        { env: this.env, encoding: "utf8", timeout: STAGED_VIEW_TIMEOUT, maxBuffer: 65_536 });
      const value = JSON.parse(result.stdout);
      return value.isPrivate === true && String(value.nameWithOwner).toLowerCase() === identity.toLowerCase();
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      // "Not found" (gh exit 1 after repo create) is transient; other failures are permanent.
      if (Number.isSafeInteger(Number(failure.code)) && Number(failure.code) === 1
        && /not found|does not exist|could not read|HTTP 404/i.test(failure.stderr ?? "")) return null;
      return null;
    }
  }

  /** Run `git push` with credential helper and return success. Throws on permanent failures. */
  private async runGitPush(repository: string, refspec: string, timeout: number): Promise<boolean> {
    const gitEnv: Record<string, string> = { ...this.env, GIT_TERMINAL_PROMPT: "0" };
    const proxy = this.proxy();
    if (proxy.HTTPS_PROXY) gitEnv.HTTPS_PROXY = proxy.HTTPS_PROXY;
    if (proxy.HTTP_PROXY) gitEnv.HTTP_PROXY = proxy.HTTP_PROXY;
    if (proxy.NO_PROXY) gitEnv.NO_PROXY = proxy.NO_PROXY;
    try {
      await execute("git", ["-C", repository, ...this.gitCredentialArgs(), "-c", "remote.origin.mirror=false",
        "push", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", refspec], {
        env: gitEnv as NodeJS.ProcessEnv, encoding: "utf8", timeout, maxBuffer: 65_536,
      });
      return true;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
      const stderr = (failure.stderr ?? "").slice(0, MAX_STDERR_BYTES);
      const redacted = redactCredentials(stderr);
      if (isLargeFileRejection(stderr)) throw new GithubCliError("github_large_file_rejected", redacted);
      if (isAuthFailure(stderr)) throw new GithubCliError("github_auth_failure", redacted);
      if (isNetworkFailure(failure)) throw new GithubCliError("github_network_failure", redacted);
      if (failure.code === "ETIMEDOUT" || failure.killed) throw new GithubCliError("github_push_timeout", redacted);
      // Non-zero exit: for transient classification, the caller retries.
      return false;
    }
  }

  /**
   * A push timeout that scales with the upload: larger repositories get more time.
   * Base 120 s plus up to 60 s for very large refspecs.
   */
  private async pushTimeout(repository: string, refspec: string): Promise<number> {
    try {
      const count = await execute("git", ["-C", repository, "rev-list", "--count", refspec], {
        env: this.env, encoding: "utf8", timeout: 15_000, maxBuffer: 65_536,
      });
      const n = Number(count.stdout.trim());
      return PUSH_TIMEOUT_BASE + Math.min(Number.isFinite(n) ? n : 0, 60) * 1000;
    } catch { return PUSH_TIMEOUT_BASE; }
  }

  private mutateLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = (this.lifecycle ?? Promise.resolve()).then(operation);
    const settled = result.then(() => {}, () => {});
    this.lifecycle = settled;
    void settled.then(() => { if (this.lifecycle === settled) this.lifecycle = null; });
    return result;
  }

  loginState(): GithubLoginState {
    this.resolvedExecutable();
    return { ...this.state };
  }

  startLogin(): Promise<GithubLoginState> {
    this.resolvedExecutable();
    if (this.lifecycle) return this.lifecycle.then(() => this.startLogin());
    if (this.flow) return this.flow.ready;
    this.state = { state: "pending" };
    let ready!: (value: GithubLoginState) => void;
    let closed!: () => void;
    const { executable, args, env } = this.ghArgv(["auth", "login", "--hostname", HOST, "--web", "--git-protocol", "https"]);
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
    const timeout = setTimeout(() => this.killLoginChild(flow), 15 * 60_000);
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

  /**
   * Kill the login child using the platform's tree-kill (taskkill on Windows).
   * This ensures that `gh auth login` and any grandchildren are ended together.
   * On POSIX, send SIGTERM to the process group. On Windows, run `taskkill /T /F`
   * first: Node's `child.kill("SIGTERM")` calls TerminateProcess, which kills the
   * direct child immediately and orphans grandchildren, so the tree kill must run
   * first while the direct child is still alive to own the tree.
   */
  private async killLoginChild(flow: LoginFlow): Promise<void> {
    flow.stopping = true;
    const pid = flow.child.pid;
    if (pid === undefined || pid === null) { flow.child.kill("SIGTERM"); return; }
    if (isWindows()) {
      // Run taskkill /T /F first, while the direct child still owns the tree.
      // Then kill the direct child handle. Order matters: taskkill must see the
      // parent process alive or it cannot walk the tree and grandchildren orphan.
      const argv = treeKillArgv(pid);
      try { await execute(argv.command, argv.args, { timeout: 5_000, windowsHide: true }); } catch { /* best-effort */ }
      flow.child.kill("SIGTERM");
    } else {
      flow.child.kill("SIGTERM");
    }
  }

  private async stopFlow(): Promise<void> {
    const flow = this.flow;
    if (flow) {
      flow.stopping = true;
      await this.killLoginChild(flow);
      await flow.closed;
    }
    this.state = { state: "idle" };
  }

  stop(): Promise<void> {
    return this.mutateLifecycle(() => this.stopFlow());
  }

  async logout(): Promise<GithubStatus> {
    this.resolvedExecutable();
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
    const fullCommand = this.command === "gh" && this.execArgv.length === 0
      ? "'" + this.resolvedExecutable().replaceAll("'", "'\\''") + "'"
      : this.compositeCredentialHelper();
    return ["-c", "credential.helper=", "-c", "credential.helper=!" + fullCommand + " auth git-credential"];
  }

  /**
   * When the gh executable is a composite (process.execPath + a script argument),
   * produce a credential helper string that git can invoke.
   */
  private compositeCredentialHelper(): string {
    const parts = [this.resolvedExecutable(), ...this.execArgv];
    return parts.map(part => "'" + part.replaceAll("'", "'\\''") + "'").join(" ");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readProxy(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const upper = env[key];
  const lower = env[key.toLowerCase()];
  return (upper?.trim() || lower?.trim() || undefined);
}
