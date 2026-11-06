import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { GithubCli } from "../src/domain/github-cli.js";
import { parseProtocolVersion } from "../src/contracts/team-control.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { createTestApp } from "./helpers/test-app.js";

const ownerToken = "owner-github-fixture";
const workerToken = "worker-github-fixture";
const legacyToken = "legacy-github-fixture";
const endpoints = [
  ["GET", "/status"], ["POST", "/login"], ["GET", "/login"], ["POST", "/logout"],
] as const;

describe("owner GitHub sign-in", () => {
  let directory: string, db: Database.Database, github: GithubCli;
  let app: ReturnType<typeof createTestApp>["app"];
  const calls = (): string[][] => existsSync(join(directory, "calls.jsonl"))
    ? readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const call = (method: string, path: string, token: string | null = ownerToken, peer = "127.0.0.1") =>
    app.request("/api/team-control/github" + path, { method,
      headers: token ? { Authorization: "Bearer " + token } : {} },
    { incoming: { socket: { remoteAddress: peer } } });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "team-github-"));
    copyFileSync(fileURLToPath(new URL("./fixtures/stub-gh.mjs", import.meta.url)), join(directory, "gh"));
    chmodSync(join(directory, "gh"), 0o755);
    github = new GithubCli({ executable: join(directory, "gh"),
      env: { ...process.env, GH_STUB_DIR: directory, GH_TOKEN: "ghp_fixture_INHERITED" } });
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    fixDaemonMode(db, true);
    app = createTestApp(db, { appDeps: { github, missionControlBearerToken: legacyToken,
      teamControl: { credentials: { ownerToken, workers: [
        { token: workerToken, sessionId: "dev@fixture", runId: "other" },
      ] } },
    } }).app;
  });

  afterEach(async () => {
    await github?.stop();
    if (db?.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns only the signed-in account, never gh's token or raw output", async () => {
    writeFileSync(join(directory, "account"), "octocat");
    const response = await call("GET", "/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ protocolVersion: "1.0", signedIn: true, login: "octocat", host: "github.com" });
    expect(JSON.parse(readFileSync(join(directory, "token-vars.json"), "utf8"))).toEqual([]);
  });

  it("returns the protocol envelope required by the shared owner browser client", async () => {
    for (const path of ["/status", "/login"]) {
      const response = await call("GET", path);
      const body = await response.json();
      expect(parseProtocolVersion(body.protocolVersion)).toBe("1.0");
    }
  });

  it("reports signed out without treating the empty gh account list as an error", async () => {
    expect(await (await call("GET", "/status")).json()).toEqual({
      protocolVersion: "1.0", signedIn: false, login: null, host: "github.com",
    });
  });

  it("reads only the account identity needed for a scoped initial commit", async () => {
    writeFileSync(join(directory, "account"), "octocat");
    expect(await github.account()).toEqual({ login: "octocat", name: "Fixture Owner", email: "123+octocat@users.noreply.github.com" });
    expect(JSON.parse(readFileSync(join(directory, "token-vars.json"), "utf8"))).toEqual([]);
  });

  it("rejects project operations when signed out without starting a device flow", async () => {
    await expect(github.account()).rejects.toMatchObject({ code: "github_not_signed_in" });
    expect(calls().some(args => args[1] === "login")).toBe(false);
  });

  it.each([["repo-exists", "github_repo_exists"], ["repo-failure", "github_repo_create_failed"]])(
    "sanitizes a %s failure without returning process output", async (marker, code) => {
      writeFileSync(join(directory, "account"), "octocat");
      writeFileSync(join(directory, marker), "");
      let error: unknown;
      try { await github.createPrivateRepository("project", directory, "octocat"); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain("ghp_fixture");
      expect(calls()).toContainEqual(["repo", "create", "octocat/project", "--private", "--source", directory, "--remote", "origin"]);
    });

  it("coalesces overlapping starts, parses split output, and settles when gh completes", async () => {
    const [first, second] = await Promise.all([call("POST", "/login"), call("POST", "/login")]);
    const pending = { protocolVersion: "1.0", state: "pending", code: "ABCD-1234", url: "https://github.com/login/device" };
    expect(await first.json()).toEqual(pending);
    expect(await second.json()).toEqual(pending);
    expect(await (await call("GET", "/login")).json()).toEqual(pending);
    expect(calls().filter(args => args[1] === "login")).toHaveLength(1);
    writeFileSync(join(directory, "finish"), "done");
    await expect.poll(() => github.loginState()).toEqual({ state: "done" });
    expect(await (await call("GET", "/status")).json()).toMatchObject({ signedIn: true, login: "octocat" });
    expect(calls().some(args => args.includes("setup-git"))).toBe(false);
  });

  it.each(["failed", "expired", "denied"])("reports a %s device flow without exposing stderr", async mode => {
    expect((await call("POST", "/login")).status).toBe(200);
    writeFileSync(join(directory, "finish"), mode);
    await expect.poll(() => github.loginState()).toEqual({ state: "failed", code: "github_login_failed" });
    const response = await call("GET", "/login");
    expect(await response.json()).toEqual({ protocolVersion: "1.0", state: "failed", code: "github_login_failed" });
  });

  it("reports a child that exits before issuing a device code", async () => {
    writeFileSync(join(directory, "early-failure"), "");
    const response = await call("POST", "/login");
    expect(await response.json()).toEqual({ protocolVersion: "1.0", state: "failed", code: "github_login_failed" });
  });

  it("logs out the account after stopping an in-flight login and permits a new flow", async () => {
    writeFileSync(join(directory, "account"), "octocat");
    await call("POST", "/login");
    const response = await call("POST", "/logout");
    expect(await response.json()).toEqual({ protocolVersion: "1.0", signedIn: false, login: null, host: "github.com" });
    expect(existsSync(join(directory, "login-stopped"))).toBe(true);
    expect(github.loginState()).toEqual({ state: "idle" });
    expect(calls()).toContainEqual(["auth", "logout", "--hostname", "github.com", "--user", "octocat"]);
    expect(await (await call("POST", "/login")).json()).toMatchObject({ state: "pending", code: "ABCD-1234" });
  });

  it.each([0, 1])("removes configured credentials when validation fails with exit %s", async exitCode => {
    writeFileSync(join(directory, "account"), "octocat");
    writeFileSync(join(directory, "validation-error"), String(exitCode));
    expect(await (await call("GET", "/status")).json()).toMatchObject({ signedIn: false, login: null });
    const response = await call("POST", "/logout");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signedIn: false, login: null });
    expect(calls()).toContainEqual(["auth", "logout", "--hostname", "github.com", "--user", "octocat"]);
    expect(existsSync(join(directory, "account"))).toBe(false);
  });

  it.each(["login-close", "logout"])("holds a new login until sign-out completes while waiting for %s", async stage => {
    writeFileSync(join(directory, "account"), "octocat");
    writeFileSync(join(directory, "hold-" + stage), "");
    await call("POST", "/login");
    const signingOut = call("POST", "/logout");
    let restarting: Promise<Response> | undefined;
    let restartReturned = false;
    try {
      const marker = stage === "login-close" ? "login-stopped" : "logout-started";
      await expect.poll(() => existsSync(join(directory, marker))).toBe(true);
      restarting = call("POST", "/login").then(response => { restartReturned = true; return response; });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(calls().filter(args => args[1] === "login")).toHaveLength(1);
      expect(restartReturned).toBe(false);
    } finally {
      writeFileSync(join(directory, "release-" + stage), "");
      expect(await (await signingOut).json()).toMatchObject({ signedIn: false });
      if (restarting) expect(await (await restarting).json()).toMatchObject({ state: "pending", code: "ABCD-1234" });
    }
    const commands = calls().map(args => args[1]);
    expect(commands).toEqual(["login", "status", "logout", "status", "login"]);
    expect(existsSync(join(directory, "account"))).toBe(false);
  });

  it("stops the login child on daemon cleanup", async () => {
    await call("POST", "/login");
    const pid = Number(readFileSync(join(directory, "login.pid"), "utf8"));
    await github.stop();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(github.loginState()).toEqual({ state: "idle" });
  });

  it("returns github_cli_missing from every route when the executable is absent", async () => {
    rmSync(join(directory, "gh"));
    for (const [method, path] of endpoints) {
      const response = await call(method, path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "github_cli_missing" });
    }
  });

  it("denies workers, unpaired clients, legacy tokens and non-loopback owners before invoking gh", async () => {
    for (const [method, path] of endpoints) {
      expect((await call(method, path, workerToken)).status).toBe(403);
      expect((await call(method, path, null)).status).toBe(401);
      expect((await call(method, path, legacyToken)).status).toBe(401);
      expect((await call(method, path, ownerToken, "203.0.113.9")).status).toBe(403);
    }
    expect(calls()).toEqual([]);
  });

  it("scopes the credential helper to the daemon's git invocation", () => {
    const args = github.gitCredentialArgs();
    expect(args.slice(0, 3)).toEqual(["-c", "credential.helper=", "-c"]);
    expect(args[3]).toBe("credential.helper=!'" + join(directory, "gh") + "' auth git-credential");
    expect(calls()).toEqual([]);
  });
});
