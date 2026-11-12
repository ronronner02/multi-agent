import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  WORKTREE_ADMIN_CEILING, WORKTREE_PATH_CEILING, WorktreePathError, addWorktree, assertWorktreePathFits,
  defaultWorktreeRoot, isWorktreeOf,
} from "../src/domain/worktree-policy.js";
import { pathWithin, samePath } from "../src/domain/platform.js";
import { commitPlan, ensurePlanWorktree, planWorktreePath, runSlug } from "../src/domain/plan-branch.js";
import { createCandidateWorkspace, resolveWorkspaceBase } from "../src/domain/team-workspace.js";
import { createTeam } from "../src/domain/team-setup.js";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, fixDaemonMode } from "../src/domain/plan-governance.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { createTestApp } from "./helpers/test-app.js";
import { shortPath } from "./helpers/short-path.js";

/**
 * U7 / KTD10 — one policy for every worktree the daemon creates.
 *
 * The measured facts this file pins were taken on this machine (Windows 11, Git
 * 2.55.0.windows.5): `git worktree add` succeeds at an absolute worktree path of 215 characters
 * and fails at 216 with `'$GIT_DIR' too big`, and the administrative path
 * `<repository>/.git/worktrees/<leaf>` succeeds at 249 and fails at 250. The long-path test below
 * is the real refusal; the constant tests state the same ceiling the preflight enforces.
 */

const windows = process.platform === "win32";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A run id shaped like the daemon's own, long enough that NTFS gives its directory a short name. */
const RUN_ID = "3f2a9c1e-7b4d-4e2a-9f6c-1d8b5a0e4c37";

function repository(parent: string, name = "project"): string {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "# Plan\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  // The long form: a Windows `%TEMP%` may be an 8.3 short name, and the code under test records
  // the long spelling Git reports. Both sides of every comparison start from this one.
  return realpathSync.native(root);
}

const created: string[] = [];
function scratch(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "u7-wt-")));
  created.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe("worktree policy constants", () => {
  it("records the measured Windows ceiling and leaves POSIX unbounded here", () => {
    if (windows) {
      // Measured: 215 ok, 216 `fatal: '$GIT_DIR' too big`; admin 249 ok, 250 refused.
      expect(WORKTREE_PATH_CEILING).toBe(215);
      expect(WORKTREE_ADMIN_CEILING).toBe(249);
    } else {
      expect(WORKTREE_PATH_CEILING).toBeNull();
      expect(WORKTREE_ADMIN_CEILING).toBeNull();
    }
  });

  it("defaults the Windows root to %LOCALAPPDATA%\\Multi-Agent\\wt and POSIX to ~/.multi-agent/wt", () => {
    const environment = windows ? { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" } : { HOME: "/home/owner" };
    expect(defaultWorktreeRoot(environment)).toBe(windows
      ? join("C:\\Users\\owner\\AppData\\Local", "Multi-Agent", "wt")
      : join("/home/owner", ".multi-agent", "wt"));
  });

  it("lets an explicit override win on both hosts", () => {
    expect(defaultWorktreeRoot({ MULTI_AGENT_WORKTREE_ROOT: windows ? "D:\\short\\wt" : "/short/wt" }))
      .toBe(windows ? "D:\\short\\wt" : "/short/wt");
  });

  it("folds case in a root comparison only on Windows", () => {
    const root = windows ? "C:\\Repo" : "/repo";
    const child = windows ? "c:\\repo\\src" : "/repo/src";
    expect(pathWithin(root, child)).toBe(true);
    expect(pathWithin(root, windows ? "C:\\other" : "/other")).toBe(false);
    expect(samePath(windows ? "C:\\Repo" : "/repo", child.split(windows ? "\\src" : "/src")[0]!)).toBe(true);
  });
});

describe("worktree path preflight", () => {
  it("refuses a candidate above the measured worktree ceiling by name, before git runs", () => {
    if (!windows) return;
    const directory = scratch();
    const repo = repository(directory);
    const tooLong = join(directory, "w".repeat(WORKTREE_PATH_CEILING! + 1 - directory.length - 1));
    expect(() => assertWorktreePathFits({ repository: repo, worktree: tooLong }))
      .toThrow(expect.objectContaining({ code: "worktree_path_too_long", kind: "worktree" }));
    // The refusal is the preflight's: no directory was created and no registration exists.
    expect(existsSync(tooLong)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(tooLong.slice(-20));
    // The same path through raw Git is the failure the preflight replaces, so the refusal is not
    // merely the policy agreeing with itself.
    expect(() => git(repo, "-c", "core.longpaths=true", "worktree", "add", "--detach", tooLong, "HEAD"))
      .toThrow(/'\$GIT_DIR' too big/);
  });

  it("refuses a short worktree whose administrative path is too long", () => {
    if (!windows) return;
    // A repository deep enough that `<repo>/.git/worktrees/<leaf>` crosses the admin ceiling while
    // the worktree itself stays well under the worktree ceiling.
    const directory = scratch();
    const deepParent = join(directory, "d".repeat(60));
    mkdirSync(deepParent, { recursive: true });
    const repo = repository(deepParent);
    const leaf = "t".repeat(Math.max(1, WORKTREE_ADMIN_CEILING! + 1 - join(repo, ".git", "worktrees").length - 1));
    const worktree = join(directory, "wt", leaf);
    expect(worktree.length).toBeLessThan(WORKTREE_PATH_CEILING!);
    expect(() => assertWorktreePathFits({ repository: repo, worktree }))
      .toThrow(expect.objectContaining({ code: "worktree_path_too_long", kind: "admin" }));
  });

  it("accepts a short path and creates a real worktree on NTFS", () => {
    const directory = scratch();
    const repo = repository(directory);
    const worktree = join(directory, "wt", "run-1");
    addWorktree({ repository: repo, worktree, args: ["--detach", worktree, "HEAD"] });
    expect(existsSync(join(worktree, "plan.md"))).toBe(true);
    // Git reports its own spelling (`C:/…` on Windows); canonicalising both sides is what makes
    // the comparison the same one `isWorktreeOf` makes when a replay reuses the directory.
    expect(samePath(realpathSync.native(git(worktree, "rev-parse", "--show-toplevel")), realpathSync.native(worktree))).toBe(true);
  });

  it("recognises a worktree named through its 8.3 short form", () => {
    // GitHub's Windows runner hands `%TEMP%` as `C:\Users\RUNNER~1\…`. The same directory then
    // has two spellings, and a replay asking "is this already my worktree?" must not answer
    // "occupied by something else" because the strings differ.
    if (!windows) return;
    const directory = scratch();
    const repo = repository(directory);
    const worktrees = join(directory, "wt");
    const worktree = planWorktreePath(worktrees, RUN_ID);
    addWorktree({ repository: repo, worktree, args: ["--detach", worktree, "HEAD"] });
    const short = shortPath(worktree);
    if (short === null) return; // This volume does not generate 8.3 names; the CI runner's does.
    expect(short).not.toBe(worktree);
    // A replay through either spelling finds the same tree rather than reporting it occupied.
    expect(isWorktreeOf(repo, short)).toBe(true);
    expect(ensurePlanWorktree({ repositoryRoot: repo, worktreeRoot: worktrees, runId: RUN_ID })).toEqual({ path: worktree, branch: runSlug({ runId: RUN_ID }) });
  });
});

describe("plan and integration worktrees", () => {
  it("creates the run's plan worktree through the policy and reuses it on replay", () => {
    const directory = scratch();
    const repo = repository(directory);
    const worktrees = join(directory, "wt");
    const created = ensurePlanWorktree({ repositoryRoot: repo, worktreeRoot: worktrees, runId: "run-1", name: "Add health" });
    expect(created).toEqual({ path: planWorktreePath(worktrees, "run-1"), branch: runSlug({ runId: "run-1", name: "Add health" }) });
    commitPlan({ worktree: created.path, planRef: "plan.md", plan: "# Plan\n\nAdd it.\n", message: "plan: add health" });
    expect(existsSync(join(created.path, "plan.md"))).toBe(true);
    // A replay reuses the same directory rather than creating a second one.
    expect(ensurePlanWorktree({ repositoryRoot: repo, worktreeRoot: worktrees, runId: "run-1", name: "Add health" })).toEqual(created);
  });

  it("refuses a plan worktree root that cannot fit, and creates nothing", () => {
    if (!windows) return;
    const directory = scratch();
    const repo = repository(directory);
    const deepRoot = join(directory, "r".repeat(Math.max(1, WORKTREE_PATH_CEILING! - directory.length)));
    expect(() => ensurePlanWorktree({ repositoryRoot: repo, worktreeRoot: deepRoot, runId: "run-1" }))
      .toThrow(WorktreePathError);
    expect(existsSync(join(deepRoot, "run-1"))).toBe(false);
  });

  it("creates a task candidate through the policy, with the task id as its leaf", () => {
    const directory = scratch();
    const repo = repository(directory);
    const base = resolveWorkspaceBase(repo);
    const workspace = createCandidateWorkspace({ root: repo, base, workspaceRoot: join(directory, "candidate"), label: "T012" });
    expect(workspace.base.kind).toBe("commit");
    expect(existsSync(join(workspace.root, "src", "base.ts"))).toBe(true);
  });

  it("refuses a candidate whose leaf pushes it past the ceiling", () => {
    if (!windows) return;
    const directory = scratch();
    const repo = repository(directory);
    const base = resolveWorkspaceBase(repo);
    const workspaceRoot = join(directory, "c".repeat(Math.max(1, WORKTREE_PATH_CEILING! - directory.length)));
    expect(() => createCandidateWorkspace({ root: repo, base, workspaceRoot, label: "T012" })).toThrow(WorktreePathError);
    expect(existsSync(workspaceRoot)).toBe(false);
  });

  it("refuses the integration worktree through the same policy, at the base commit it lands on", () => {
    if (!windows) return;
    // `integration-branch.ts` reaches the helper through `ensurePlanWorktree` with a `base`; the
    // ceiling applies there exactly as it does to the plan worktree, so a run whose plan root was
    // short enough for planning cannot fail later at the first landing.
    const directory = scratch();
    const repo = repository(directory);
    const base = git(repo, "rev-parse", "HEAD");
    const deepRoot = join(directory, "i".repeat(Math.max(1, WORKTREE_PATH_CEILING! - directory.length)));
    expect(() => ensurePlanWorktree({ repositoryRoot: repo, worktreeRoot: deepRoot, runId: "run-1", base }))
      .toThrow(expect.objectContaining({ code: "worktree_path_too_long" }));
    expect(existsSync(join(deepRoot, "run-1"))).toBe(false);
  });

  it("creates a worktree under a root reached through a link", () => {
    // A root that is a junction (the Windows link a non-elevated user can create) is a directory
    // Git accepts; the policy resolves the path it writes and does not refuse the alias.
    const directory = scratch();
    const repo = repository(directory);
    const real = join(directory, "real-root");
    mkdirSync(real, { recursive: true });
    const alias = join(directory, "root-alias");
    symlinkSync(real, alias, "junction");
    const worktree = join(alias, "run-1");
    addWorktree({ repository: repo, worktree, args: ["--detach", worktree, "HEAD"] });
    expect(existsSync(join(real, "run-1", "plan.md"))).toBe(true);
  });
});

describe("the start route refuses a worktree that cannot fit", () => {
  it("names the refusal instead of reporting a persistence failure", async () => {
    if (!windows) return;
    const directory = scratch();
    const repo = repository(directory);
    const db: Database.Database = createDb();
    try {
      initializeDatabase(db);
      fixDaemonMode(db, true);
      const bus = new EventBus(db), queue = new QueueRepository(db, bus);
      const governance = new PlanGovernance(db, bus, queue, undefined, () => unisolatedPolicyCapability(4));
      const team = createTeam(db, { repository: repo, seats: [{ role: "lead", client: "claude-code" }] });
      // A root with just enough room for the id would still be under the ceiling; this one is not.
      const deepRoot = join(directory, "r".repeat(Math.max(1, WORKTREE_PATH_CEILING! - directory.length)));
      const app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
        teamControl: { credentials: { ownerToken: "owner-wt-fixture" }, readPolicyCapability: () => unisolatedPolicyCapability(4),
          planWorktreeRoot: () => deepRoot } } }).app;
      const response = await app.request("/api/team-control/runs", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer owner-wt-fixture" },
        body: JSON.stringify({ rig: team.id, goal: "Plan the next change", planning: true }) },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "worktree_path_too_long" });
    } finally { if (db.open) db.close(); }
  });
});
