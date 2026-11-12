import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { GithubCli, GithubCliError } from "../src/domain/github-cli.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { setHostPlatformForTests } from "../src/domain/platform.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { createTestApp } from "./helpers/test-app.js";
import { MAX_UPLOAD_BYTES, previewProject } from "../src/domain/project-bootstrap.js";

/**
 * U8 / R17 — project bootstrap is bounded and correct on NTFS.
 *
 * These cases are about the local snapshot, so the GitHub half of setup is a value here rather
 * than a fixture process: `gh` is U9's surface, and the POSIX `stub-gh.mjs` script cannot be
 * launched on Windows at all. Everything below therefore runs on both hosts, and the two places
 * that need a real link (which NTFS makes only with developer mode) are pinned.
 */

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("project bootstrap size, mode, and responsiveness", () => {
  let directory: string, repository: string, db: Database.Database, github: GithubCli, settings: SettingsStore;
  let app: ReturnType<typeof createTestApp>["app"];
  const create = (body: Record<string, unknown> = {}) => app.request("/api/team-control/teams", {
    method: "POST", headers: { Authorization: "Bearer owner-bootstrap-fixture", "Content-Type": "application/json" },
    body: JSON.stringify({ repository, name: "project", ...body }),
  }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const openApp = () => {
    db = createDb(join(directory, "bootstrap.db"));
    initializeDatabase(db);
    fixDaemonMode(db, true);
    app = createTestApp(db, { appDeps: { github, settingsStore: settings,
      teamControl: { credentials: { ownerToken: "owner-bootstrap-fixture" } } } }).app;
  };
  const account = { login: "octocat", name: "Fixture Owner", email: "123+octocat@users.noreply.github.com" };

  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "project-limits-")));
    repository = join(directory, "project");
    mkdirSync(repository);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(directory, "gitconfig"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("MULTI_AGENT_TEAM_LEAD_CLIENT", "");
    github = Object.assign(Object.create(GithubCli.prototype), {
      account: async () => account,
      createPrivateRepository: async (name: string, source: string, login: string) => {
        const url = `https://github.com/${login}/${name}.git`;
        git(source, "remote", "add", "origin", url);
        return url;
      },
      push: async () => {},
      stop: async () => {},
    }) as GithubCli;
    settings = new SettingsStore(join(directory, "settings.json"));
    openApp();
  });
  afterEach(() => {
    if (db.open) db.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses a file over 100 MiB at preview, names it, and never reads its bytes", async () => {
    // A sparse file of the limit plus one byte: the refusal must come from the directory entry, so
    // the run's own peak memory never grows by the file's size.
    writeFileSync(join(repository, "small.txt"), "small\n");
    const huge = join(repository, "huge.bin");
    writeFileSync(huge, "");
    truncateSync(huge, MAX_UPLOAD_BYTES + 1);
    const before = process.memoryUsage().rss;
    const response = await create({ dryRun: true });
    const peak = process.memoryUsage().rss - before;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "team_file_too_large", oversizedPaths: ["huge.bin"] });
    expect(peak).toBeLessThan(MAX_UPLOAD_BYTES / 2);
    expect(existsSync(join(repository, ".gitignore"))).toBe(false);
  });

  it("accepts a file of exactly 100 MiB", async () => {
    const boundary = join(repository, "boundary.bin");
    writeFileSync(boundary, "");
    truncateSync(boundary, MAX_UPLOAD_BYTES);
    // The default ignore file is added because the folder has none.
    expect(await previewProject({ repository, name: "project" }, undefined)).toMatchObject({ action: "create", fileCount: 2 });
  });

  it("records every Windows regular file as 100644 even with core.fileMode=false", async () => {
    writeFileSync(join(repository, "plain.txt"), "plain\n");
    writeFileSync(join(repository, "executable.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(repository, "executable.sh"), 0o755);
    git(repository, "init", "--quiet", "--initial-branch=main");
    git(repository, "config", "core.fileMode", "false");
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    // Git's own `ls-tree` is the assertion, so a mode Git rewrote would show up here. The owner's
    // `core.fileMode=false` is left as it was.
    expect(git(repository, "ls-tree", "-r", "HEAD").split("\n")).toEqual([
      "100644 blob " + git(repository, "rev-parse", "HEAD:.gitignore") + "\t.gitignore",
      "100644 blob " + git(repository, "rev-parse", "HEAD:executable.sh") + "\texecutable.sh",
      "100644 blob " + git(repository, "rev-parse", "HEAD:plain.txt") + "\tplain.txt",
    ]);
    expect(git(repository, "config", "--get", "core.fileMode")).toBe("false");
  });

  it("ignores an executable bit the host reports when the snapshot is built as Windows", async () => {
    // NTFS cannot carry the bit, so a Windows host never proves this branch: `chmod +x` is a no-op
    // there and the old `stat.mode & 0o111` test happened to answer 100644 anyway. Forcing the
    // Windows answer on a host that does keep the bit exercises the decision itself.
    writeFileSync(join(repository, "executable.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(repository, "executable.sh"), 0o755);
    git(repository, "init", "--quiet", "--initial-branch=main");
    setHostPlatformForTests("win32");
    try {
      const response = await create();
      expect(response.status, await response.clone().text()).toBe(201);
    } finally { setHostPlatformForTests(null); }
    expect(git(repository, "ls-tree", "-r", "HEAD", "--", "executable.sh")).toMatch(/^100644 /);
  });

  it("keeps a supported link as 120000 and refuses one that leaves the project", async () => {
    writeFileSync(join(repository, "target.txt"), "target\n");
    mkdirSync(join(directory, "outside"));
    writeFileSync(join(directory, "outside", "secret.txt"), "outside\n");
    // POSIX always has file symlinks. Windows only has them with developer mode; a junction needs
    // no elevation, but Git stores a junction as a real directory rather than as a link, so the
    // 120000 half of this case is POSIX-only and the escape half runs on both.
    const windows = process.platform === "win32";
    let supported = false;
    try {
      symlinkSync("target.txt", join(repository, "inside-link"), windows ? "junction" : "file");
      supported = !windows;
    } catch (error) { if (!windows) throw error; }
    symlinkSync(join(directory, "outside"), join(repository, "escape-link"), windows ? "junction" : "dir");

    const preview = await previewProject({ repository, name: "project" }, undefined);
    expect(preview.excludedPaths).toContain("escape-link");
    if (supported) expect(preview.excludedPaths).not.toContain("inside-link");

    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect(git(repository, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).not.toContain("escape-link/secret.txt");
    if (supported) {
      expect(git(repository, "ls-tree", "-r", "HEAD", "--", "inside-link")).toMatch(/^120000 /);
      expect(git(repository, "cat-file", "-p", "HEAD:inside-link")).toBe("target.txt");
    }
  });

  it("retries a failed push from its checkpoint with the same commit", async () => {
    writeFileSync(join(repository, "source.txt"), "first\n");
    let attempts = 0;
    github.push = async () => { attempts += 1; if (attempts === 1) throw new GithubCliError("github_push_failed"); };
    expect(await (await create()).json()).toMatchObject({ code: "github_push_failed" });
    const receipt = db.prepare("SELECT step, commit_oid, team_id, last_error_code FROM team_bootstraps").get() as
      { step: string; commit_oid: string; team_id: string | null; last_error_code: string };
    expect(receipt).toMatchObject({ step: "repo", last_error_code: "github_push_failed" });
    // U9 (R18/KTD12): team row is created only after push succeeds.
    // After a failed push, team_id must be null so no half-created project shows.
    expect(receipt.team_id).toBeNull();
    // A file written after the first attempt is not part of the recorded snapshot: the retry
    // resumes from the checkpoint instead of rebuilding one.
    writeFileSync(join(repository, "later.txt"), "later\n");
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    const team = (await response.json() as { team: { id: string } }).team;
    // The retry creates the team row since push succeeds this time.
    expect(team.id).toBeTruthy();
    expect(git(repository, "rev-parse", "HEAD")).toBe(receipt.commit_oid);
    expect(git(repository, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([".gitignore", "source.txt"]);
    expect(db.prepare("SELECT step, last_error_code FROM team_bootstraps").get()).toEqual({ step: "push", last_error_code: null });
  });

  it("snapshots a POSIX name a newline-separated batch cannot carry", async () => {
    // `hash-object --stdin-paths` takes one path per line and has no NUL form, so a name holding a
    // newline is hashed on its own. NTFS forbids the character, so only POSIX can build the case.
    if (process.platform === "win32") return;
    writeFileSync(join(repository, "with\nnewline.txt"), "newline name\n");
    writeFileSync(join(repository, "plain.txt"), "plain\n");
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect(git(repository, "ls-tree", "-r", "--name-only", "-z", "HEAD").split("\0").filter(Boolean))
      .toEqual([".gitignore", "plain.txt", "with\nnewline.txt"]);
    expect(git(repository, "cat-file", "-p", "HEAD:with\nnewline.txt")).toBe("newline name");
  });

  it("keeps the event loop responsive while a multi-file snapshot is hashed", async () => {
    for (let index = 0; index < 2000; index += 1) writeFileSync(join(repository, `file-${index}.txt`), `fixture ${index}\n`);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      const started = Date.now();
      const preview = await previewProject({ repository, name: "project" }, undefined);
      const elapsed = Date.now() - started;
      expect(preview.fileCount).toBe(2001);
      // A blocking implementation runs every timer only after the hashing finished, so the count
      // is what proves the loop kept turning. The elapsed bound only keeps a slow runner from
      // turning a regression into a timeout.
      expect(ticks).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(60_000);
    } finally { clearInterval(timer); }
  });
});
