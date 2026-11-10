import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { GithubCli } from "../src/domain/github-cli.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { createTestApp } from "./helpers/test-app.js";
import { previewProject, projectFolder } from "../src/domain/project-bootstrap.js";
import { shortPath } from "./helpers/short-path.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("project file preview", () => {
  let directory: string, home: string;
  beforeEach(() => {
    // The long form: a Windows `%TEMP%` may be an 8.3 short name while the code under test
    // canonicalises to the long one, and every assertion here compares the two.
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "project-preview-")));
    home = join(directory, "home");
    mkdirSync(home);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("previews a missing folder and its initial ignore file without creating anything", async () => {
    const repository = join(home, "new-project");
    expect(await previewProject({ repository, name: "new-project" }, home)).toMatchObject({
      repository, name: "new-project", action: "create", fileCount: 1, excludedPaths: [],
    });
    expect(existsSync(repository)).toBe(false);
  });

  it("resolves a folder named through its 8.3 short form to the long spelling", () => {
    // GitHub's Windows runner hands `%TEMP%` as `C:\Users\RUNNER~1\…`, and Git answers in the
    // long form. A project folder must be recorded once, in the spelling every later comparison
    // and every seat's cwd use.
    if (process.platform !== "win32") return;
    const long = join(home, "project-with-a-long-name");
    mkdirSync(long);
    const short = shortPath(long);
    if (short === null) return; // This volume does not generate 8.3 names; the CI runner's does.
    expect(short).not.toBe(long);
    expect(projectFolder(short, home)).toBe(long);
  });

  it("uses the same credential and default-ignore policy before an initial commit", async () => {
    const repository = join(home, "project");
    mkdirSync(join(repository, ".ssh"), { recursive: true });
    mkdirSync(join(repository, ".config"));
    mkdirSync(join(repository, "node_modules"));
    writeFileSync(join(repository, ".env"), "fixture credential\n");
    writeFileSync(join(repository, ".ssh", "id_ed25519"), "fixture key\n");
    writeFileSync(join(repository, ".config", "account"), "fixture account\n");
    writeFileSync(join(repository, "node_modules", "dependency.js"), "generated\n");
    writeFileSync(join(repository, "source with spaces.ts"), "export const value = 1;\n");
    const before = readdirSync(repository).sort();
    const preview = await previewProject({ repository, name: "project" }, home);
    expect(preview.fileCount).toBe(2);
    expect(preview.excludedPaths).toEqual(expect.arrayContaining([".env", ".ssh/", ".config/"]));
    expect(readdirSync(repository).sort()).toEqual(before);
    expect(existsSync(join(repository, ".git"))).toBe(false);
    expect(existsSync(join(repository, ".gitignore"))).toBe(false);
    expect(JSON.stringify(preview)).not.toContain("fixture credential");
  });

  it("respects an existing ignore file and leaves a pre-staged owner index byte-identical", async () => {
    const repository = join(home, "project");
    mkdirSync(repository);
    git(repository, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repository, "ignored.txt"), "not uploaded\n");
    writeFileSync(join(repository, "source.ts"), "staged version\n");
    writeFileSync(join(repository, ".env"), "staged fixture credential\n");
    git(repository, "add", "--", "source.ts", ".env");
    writeFileSync(join(repository, "source.ts"), "working version\n");
    const index = readFileSync(join(repository, ".git", "index"));
    const preview = await previewProject({ repository, name: "project" }, home);
    expect(preview.fileCount).toBe(2);
    expect(preview.excludedPaths).toContain(".env");
    expect(readFileSync(join(repository, ".git", "index"))).toEqual(index);
    expect(readFileSync(join(repository, ".gitignore"), "utf8")).toBe("ignored.txt\n");
    expect(readFileSync(join(repository, "source.ts"), "utf8")).toBe("working version\n");
  });

  it("does not follow a source symlink into an outside directory", async () => {
    const repository = join(home, "project"), outside = join(directory, "outside");
    mkdirSync(repository);
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "outside fixture\n");
    // A file symlink needs a developer-mode Windows host; a junction does not and is the same
    // escape the boundary refuses.
    symlinkSync(outside, join(repository, "linked"), process.platform === "win32" ? "junction" : "dir");
    const preview = await previewProject({ repository, name: "project" }, home);
    expect(preview.fileCount).toBe(1);
    expect(preview.excludedPaths).toContain("linked");
  });

  it("rejects protected roots and aliases before creating a folder", () => {
    const alias = join(directory, "home-alias");
    symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
    // The WSL mount spellings are POSIX path shapes: on Windows `/mnt/c` is the relative-looking
    // `C:\mnt\c` after resolution, which is an ordinary folder there and not a protected root.
    const roots = process.platform === "win32" ? [home, directory, alias] : [home, directory, "/", "/mnt/c", "/mnt/c/Users/FixtureOwner", alias];
    for (const repository of roots) {
      expect(() => projectFolder(repository, home)).toThrow(expect.objectContaining({ code: "team_folder_refused" }));
    }
  });

  it("rejects a selected child of an existing repository rather than uploading the parent", async () => {
    const repository = join(home, "project");
    mkdirSync(join(repository, "child"), { recursive: true });
    git(repository, "init", "--quiet", "--initial-branch=main");
    for (const child of ["child", "missing-child"]) {
      await expect(previewProject({ repository: join(repository, child), name: "child" }, home))
        .rejects.toThrow(expect.objectContaining({ code: "team_folder_refused" }));
    }
    expect(existsSync(join(repository, "missing-child"))).toBe(false);
  });
});

describe("project creation through the owner route", () => {
  let directory: string, repository: string, remote: string, db: Database.Database, github: GithubCli, settings: SettingsStore;
  let app: ReturnType<typeof createTestApp>["app"];
  const calls = (): string[][] => existsSync(join(directory, "calls.jsonl"))
    ? readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const create = (body: Record<string, unknown> = {}) => app.request("/api/team-control/teams", {
    method: "POST", headers: { Authorization: "Bearer owner-bootstrap-fixture", "Content-Type": "application/json" },
    body: JSON.stringify({ repository, name: "project", ...body }),
  }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const openApp = () => {
    db = createDb(join(directory, "bootstrap.db"));
    migrate(db, ALL_MIGRATIONS);
    fixDaemonMode(db, true);
    app = createTestApp(db, { appDeps: { github, settingsStore: settings,
      teamControl: { credentials: { ownerToken: "owner-bootstrap-fixture" } } } }).app;
  };
  const committedRepository = () => {
    mkdirSync(repository);
    git(repository, "init", "--quiet", "--initial-branch=main");
    git(repository, "config", "user.name", "Repository Owner");
    git(repository, "config", "user.email", "owner@example.invalid");
    writeFileSync(join(repository, "source.txt"), "committed\n");
    git(repository, "add", "--", "source.txt");
    git(repository, "commit", "--quiet", "-m", "Existing project");
    return git(repository, "rev-parse", "HEAD");
  };

  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "project-create-")));
    repository = join(directory, "project");
    remote = join(directory, "remote.git");
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(directory, "gitconfig"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("OPENRIG_TEAM_LEAD_CLIENT", "");
    git(directory, "init", "--bare", "--quiet", "--initial-branch=main", remote);
    copyFileSync(fileURLToPath(new URL("./fixtures/stub-gh.mjs", import.meta.url)), join(directory, "gh"));
    chmodSync(join(directory, "gh"), 0o755);
    copyFileSync(fileURLToPath(new URL("./fixtures/stub-project-git.mjs", import.meta.url)), join(directory, "git"));
    chmodSync(join(directory, "git"), 0o755);
    writeFileSync(join(directory, "account"), "octocat");
    github = new GithubCli({ executable: join(directory, "gh"),
      env: { ...process.env, PATH: directory + delimiter + process.env.PATH, GH_STUB_DIR: directory,
        GH_STUB_REMOTE: remote, GH_STUB_REAL_GIT: execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
        GH_TOKEN: "ghp_fixture_INHERITED" } });
    settings = new SettingsStore(join(directory, "settings.json"));
    openApp();
  });
  afterEach(async () => {
    await github.stop();
    if (db.open) db.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns a dry run without creating a folder, bootstrap row, or GitHub process", async () => {
    const response = await create({ dryRun: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ protocolVersion: "1.0", preview: { repository, name: "project", fileCount: 1, action: "create" } });
    expect(existsSync(repository)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM team_bootstraps").get()).toEqual({ n: 0 });
    expect(calls()).toEqual([]);
  });

  it("creates a missing folder, private origin, pushed initial commit, and configured lead only", async () => {
    settings.set("team.leadClient", "codex");
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    const { team } = await response.json();
    expect(team).toMatchObject({ repository, name: "project", seats: [{ role: "lead", client: "codex" }] });
    expect(git(repository, "config", "--get", "remote.origin.url")).toBe("https://github.com/octocat/project.git");
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(git(repository, "rev-parse", "HEAD"));
    expect(git(repository, "show", "-s", "--format=%an <%ae>")).toBe("Fixture Owner <123+octocat@users.noreply.github.com>");
    expect(git(repository, "status", "--porcelain")).toBe("");
    expect(calls()).toContainEqual(["repo", "create", "octocat/project", "--private", "--source", repository, "--remote", "origin"]);
    expect(existsSync(join(directory, "gitconfig"))).toBe(false);
    expect(db.prepare("SELECT step, last_error_code FROM team_bootstraps").get()).toEqual({ step: "push", last_error_code: null });
  });

  it.each([false, true])("excludes credential paths without changing the owner's existing ignore file or index: own ignore %s", async ownIgnore => {
    mkdirSync(join(repository, ".ssh"), { recursive: true });
    mkdirSync(join(repository, ".config"));
    git(repository, "init", "--quiet", "--initial-branch=main");
    git(repository, "config", "user.name", "Repository Owner");
    git(repository, "config", "user.email", "owner@example.invalid");
    if (ownIgnore) writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repository, "source.txt"), "staged\n");
    writeFileSync(join(repository, ".env"), "fixture credential\n");
    writeFileSync(join(repository, ".ssh", "id_ed25519"), "fixture key\n");
    writeFileSync(join(repository, ".config", "account"), "fixture account\n");
    git(repository, "add", "--", "source.txt", ".env");
    const index = readFileSync(join(repository, ".git", "index"));
    writeFileSync(join(repository, "source.txt"), "working\n");
    const preview = await (await create({ dryRun: true })).json();
    expect(preview.preview.excludedPaths).toEqual(ownIgnore
      ? [".config/account", ".env", ".ssh/id_ed25519"] : [".config/", ".env", ".ssh/"]);
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect(git(remote, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual([".gitignore", "source.txt"]);
    expect(git(remote, "show", "main:source.txt")).toBe("working");
    expect(readFileSync(join(repository, ".git", "index"))).toEqual(index);
    expect(git(repository, "show", "-s", "--format=%an <%ae>")).toBe("Repository Owner <owner@example.invalid>");
    if (ownIgnore) expect(readFileSync(join(repository, ".gitignore"), "utf8")).toBe("ignored.txt\n");
    expect(readFileSync(join(repository, ".env"), "utf8")).toBe("fixture credential\n");
  });

  it("leaves a missing folder missing when signed out", async () => {
    unlinkSync(join(directory, "account"));
    const response = await create();
    expect(await response.json()).toMatchObject({ code: "github_not_signed_in" });
    expect(existsSync(repository)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
    expect(calls().some(args => args[1] === "login")).toBe(false);
  });

  it("registers an existing origin without any GitHub call or local history change", async () => {
    committedRepository();
    writeFileSync(join(repository, ".env"), "fixture historical credential stays local\n");
    git(repository, "add", "--", ".env");
    git(repository, "commit", "--quiet", "-m", "Local history");
    const head = git(repository, "rev-parse", "HEAD");
    git(repository, "remote", "add", "origin", remote);
    unlinkSync(join(directory, "account"));
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await response.json()).team.seats).toEqual([{ role: "lead", client: "claude-code" }]);
    expect(calls()).toEqual([]);
    expect(git(repository, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(repository, ".gitignore"))).toBe(false);
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("");
  });

  it("opens an existing local repository without creating an origin or uploading files", async () => {
    committedRepository();
    const head = git(repository, "rev-parse", "HEAD");
    const preview = await (await create({ openExisting: true, dryRun: true })).json();
    expect(preview).toMatchObject({ preview: { repository, name: "project", action: "open", fileCount: 0, excludedPaths: [] } });
    expect(calls()).toEqual([]);
    const response = await create({ openExisting: true });
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await response.json()).team).toMatchObject({ repository, name: "project", seats: [{ role: "lead", client: "claude-code" }] });
    expect(git(repository, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(repository, ".git", "config"), "utf8")).not.toContain("[remote \"origin\"]");
    expect(calls()).toEqual([]);
  });

  it("leaves no team on a name conflict, and allows a new name without another initial commit", async () => {
    writeFileSync(join(directory, "repo-exists"), "");
    const response = await create();
    expect(await response.json()).toMatchObject({ code: "github_repo_exists" });
    for (const table of ["rigs", "nodes", "sessions"]) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    const head = git(repository, "rev-parse", "HEAD");
    unlinkSync(join(directory, "repo-exists"));
    expect((await create({ name: "another-project" })).status).toBe(201);
    expect(git(repository, "rev-parse", "HEAD")).toBe(head);
    expect(git(repository, "config", "--get", "remote.origin.url")).toBe("https://github.com/octocat/another-project.git");
  });

  it("resumes a failed push after database reopen using the same team, remote, branch and commit", async () => {
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await (await create()).json()).toMatchObject({ code: "github_push_failed" });
    const receipt = db.prepare("SELECT team_id, commit_oid, remote_url, branch_ref, last_error_code FROM team_bootstraps").get() as Record<string, string>;
    expect(receipt.last_error_code).toBe("github_push_failed");
    expect(receipt.team_id).toBeTruthy();
    writeFileSync(join(repository, "later.txt"), "keep local\n");
    git(repository, "add", "--", "later.txt");
    git(repository, "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "commit", "--quiet", "-m", "Later owner work");
    const later = git(repository, "rev-parse", "HEAD");
    db.close();
    openApp();
    unlinkSync(hook);
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await response.json()).team.id).toBe(receipt.team_id);
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(receipt.commit_oid);
    expect(git(repository, "rev-parse", "HEAD")).toBe(later);
    expect(calls().filter(args => args[1] === "create")).toHaveLength(1);
    expect(db.prepare("SELECT step, last_error_code FROM team_bootstraps").get()).toEqual({ step: "push", last_error_code: null });
    expect(await (await create()).json()).toMatchObject({ code: "team_exists" });
  });

  it("refuses a changed origin on push retry rather than creating or pushing another repository", async () => {
    writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await (await create()).json()).toMatchObject({ code: "github_push_failed" });
    git(repository, "remote", "set-url", "origin", "https://github.com/octocat/different.git");
    const before = calls().length;
    expect(await (await create()).json()).toMatchObject({ code: "team_origin_changed" });
    expect(calls()).toHaveLength(before);
  });

  it("keeps a push pending if the created repository is now public", async () => {
    writeFileSync(join(directory, "repo-public"), "");
    const response = await create();
    expect(await response.json()).toMatchObject({ code: "github_push_failed" });
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("");
    expect(db.prepare("SELECT step, last_error_code FROM team_bootstraps").get())
      .toEqual({ step: "repo", last_error_code: "github_push_failed" });
    unlinkSync(join(directory, "repo-public"));
    expect((await create()).status).toBe(201);
    expect(calls().filter(args => args[1] === "create")).toHaveLength(1);
  });

  it.each([
    ["local", "insteadOf"], ["local", "pushInsteadOf"], ["global", "insteadOf"], ["global", "pushInsteadOf"],
  ])("keeps an unchecked destination empty for a %s %s rewrite", async (scope, rewrite) => {
    const head = committedRepository(), unchecked = join(directory, "unchecked.git");
    git(directory, "init", "--bare", "--quiet", unchecked);
    const config = scope === "global" ? ["--global"] : [];
    const key = `url.${unchecked}.${rewrite}`, intended = "https://github.com/octocat/project.git";
    git(repository, "config", ...config, key, intended);
    const response = await create();
    expect(git(unchecked, "for-each-ref", "--format=%(refname)")).toBe("");
    expect(await response.json()).toMatchObject({ code: "github_push_failed" });
    expect(db.prepare("SELECT step, last_error_code FROM team_bootstraps").get())
      .toEqual({ step: "repo", last_error_code: "github_push_failed" });
    expect(git(repository, "config", ...config, "--get", key)).toBe(intended);
    expect(git(repository, "rev-parse", "HEAD")).toBe(head);
    git(repository, "config", ...config, "--unset-all", key);
    expect((await create()).status).toBe(201);
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(head);
    expect(git(unchecked, "for-each-ref", "--format=%(refname)")).toBe("");
    expect(calls().filter(args => args[1] === "create")).toHaveLength(1);
  });

  it("refuses explicit and multiple unchecked push URLs on retry", async () => {
    const unchecked = join(directory, "unchecked.git"), intended = "https://github.com/octocat/project.git";
    git(directory, "init", "--bare", "--quiet", unchecked);
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await (await create()).json()).toMatchObject({ code: "github_push_failed" });
    unlinkSync(hook);
    for (const urls of [[unchecked], [intended, unchecked]]) {
      for (const url of urls) git(repository, "config", "--add", "remote.origin.pushurl", url);
      expect(await (await create()).json()).toMatchObject({ code: "github_push_failed" });
      expect(git(unchecked, "for-each-ref", "--format=%(refname)")).toBe("");
      expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("");
      expect(db.prepare("SELECT step FROM team_bootstraps").get()).toEqual({ step: "repo" });
      expect(git(repository, "config", "--get-all", "remote.origin.pushurl").split("\n")).toEqual(urls);
      git(repository, "config", "--unset-all", "remote.origin.pushurl");
    }
    expect((await create()).status).toBe(201);
    expect(calls().filter(args => args[1] === "create")).toHaveLength(1);
  });

  it("serializes overlapping Create requests instead of creating a second remote or team", async () => {
    const responses = await Promise.all([create(), create()]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(calls().filter(args => args[1] === "create")).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 1 });
  });

  it("recovers origin installed before its checkpoint and previews the pending push", async () => {
    writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await (await create()).json()).toMatchObject({ code: "github_push_failed" });
    db.prepare("UPDATE team_bootstraps SET step = 'commit', remote_url = NULL, team_id = NULL").run();
    db.exec("DELETE FROM sessions; DELETE FROM nodes; DELETE FROM rigs");
    const preview = await (await create({ dryRun: true })).json();
    expect(preview.preview).toMatchObject({ action: "push", fileCount: 1 });
    unlinkSync(join(remote, "hooks", "pre-receive"));
    expect((await create()).status).toBe(201);
    expect(calls().filter(args => args[1] === "create")).toHaveLength(1);
  });

  it.each([false, true])("keeps credential-bearing existing history local, including a deleted credential: %s", async deleted => {
    committedRepository();
    writeFileSync(join(repository, ".env"), "fixture historical credential\n");
    git(repository, "add", "--", ".env");
    git(repository, "commit", "--quiet", "-m", "Historical file");
    if (deleted) { git(repository, "rm", "--quiet", "--", ".env"); git(repository, "commit", "--quiet", "-m", "Remove file"); }
    const head = git(repository, "rev-parse", "HEAD"), index = readFileSync(join(repository, ".git", "index"));
    for (const dryRun of [true, false]) {
      const response = await create({ dryRun });
      expect(await response.json()).toMatchObject({ code: "team_history_credentials", excludedPaths: [".env"] });
    }
    expect(git(repository, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(repository, ".git", "index"))).toEqual(index);
    expect(calls()).toEqual([]);
  });

  it("pushes only the selected existing commit while leaving other branches and dirty work local", async () => {
    const head = committedRepository();
    git(repository, "checkout", "--quiet", "-b", "local-only");
    writeFileSync(join(repository, ".env"), "fixture local credential\n");
    git(repository, "add", "--", ".env");
    git(repository, "commit", "--quiet", "-m", "Local-only history");
    git(repository, "checkout", "--quiet", "main");
    writeFileSync(join(repository, "source.txt"), "staged owner edit\n");
    git(repository, "add", "--", "source.txt");
    writeFileSync(join(repository, "source.txt"), "unstaged owner edit\n");
    const index = readFileSync(join(repository, ".git", "index"));
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await (await create()).json()).toMatchObject({ code: "github_push_failed" });
    git(repository, "config", "remote.origin.mirror", "true");
    unlinkSync(hook);
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(head);
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(readFileSync(join(repository, ".git", "index"))).toEqual(index);
    expect(readFileSync(join(repository, "source.txt"), "utf8")).toBe("unstaged owner edit\n");
    expect(existsSync(join(repository, ".gitignore"))).toBe(false);
  });
});
