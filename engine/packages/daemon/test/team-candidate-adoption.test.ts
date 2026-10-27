import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { candidateManifest, removeCandidateWorkspace } from "../src/domain/team-workspace.js";

// T048 — a resumed candidate is adopted only when a control-owned record accounts for it, and a
// candidate is released without any git process receiving its path.
//
// The records this reads are the source repository's worktree registry (git's own, in a directory
// no worker can write) and, for the snapshot lane, a creation record under the control state
// directory. Nothing inside the candidate is consulted for either decision, so a worker-planted
// `.git` or config can neither win adoption nor run during removal.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repository with one commit, which is what puts the commit lane in force. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "t048-repo-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** A repository with no commit, which is the snapshot lane. */
function unbornRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "t048-unborn-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  return root;
}

describe("candidate adoption and release use control-owned provenance", () => {
  let directory: string;
  let assignmentRoot: string;
  let recordsRoot: string;
  let db: Database.Database;
  let bus: EventBus;
  let queue: QueueRepository;

  const candidateDir = (runId = "run-1", taskId = "T048", worker = "ma-worker1"): string =>
    join(assignmentRoot, worker, `${runId}-${taskId}`);

  const bindingFor = (repositoryRoot: string) => ({
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "plan.md", planDigest: hashBytes("approved plan"),
    repository: { root: repositoryRoot, identity: "git:" + "a".repeat(40) },
    readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
    policyRevision: 4, policyFingerprint: hashBytes("policy"),
    limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
  });

  const insertRun = (runId: string, repositoryRoot: string): void => {
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
      VALUES (?, 'rig-1', ?, ?, 'approved', '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z')`)
      .run(runId, JSON.stringify(bindingFor(repositoryRoot)), hashBinding(bindingFor(repositoryRoot)));
  };

  /** A runtime over the same database: the shape a restarted daemon has. */
  const runtimeFor = (options: { records?: boolean } = {}): WorkflowRuntime => {
    return new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (id, taskId, worker) => candidateDir(id, taskId, worker),
      assignmentRoot: () => assignmentRoot,
      defaultWorker: () => "ma-worker1",
      ...(options.records === false ? {} : { candidateRecordsRoot: () => recordsRoot }) });
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "t048-"));
    assignmentRoot = join(directory, "assignments");
    recordsRoot = join(directory, "control", "candidates");
    mkdirSync(join(assignmentRoot, "ma-worker1"), { recursive: true });
    db = createDb(join(directory, "t048.db"));
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { now: () => new Date("2026-10-27T00:00:00.000Z") } as never);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'test')").run();
  });

  afterEach(() => {
    if (db?.open) db.close();
    const writable = (path: string): void => {
      chmodSync(path, 0o755);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644);
      }
    };
    if (existsSync(directory)) { try { writable(directory); } catch { /* already gone */ } }
    rmSync(directory, { recursive: true, force: true });
  });

  it("adopts a commit-lane candidate that has work in it after a restart", () => {
    const repo = repository();
    insertRun("run-1", repo);
    const created = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    writeFileSync(join(created.root, "src", "work.ts"), "export const work = 1;\n");
    // The registry entry the source holds is what makes the tree adoptable; it was written by
    // `git worktree add` against the source, not by anything in the candidate.
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(created.root);

    const adopted = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(adopted.root).toBe(created.root);
    expect(candidateManifest(adopted).files.map(file => file.path)).toContain("src/work.ts");
  });

  it("refuses a plain directory at the candidate path and leaves the task launchable", () => {
    const repo = repository();
    insertRun("run-1", repo);
    const occupied = candidateDir("run-1");
    mkdirSync(join(occupied, "chosen"), { recursive: true });
    writeFileSync(join(occupied, "chosen", "chosen.ts"), "export const chosen = 1;\n");
    // No registry entry names this path, so nothing on disk can make it the task's candidate.
    // The task still launches: the unaccounted directory is moved aside, not left blocking.
    const created = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(created.root).toBe(occupied);
    expect(existsSync(join(created.root, "src", "base.ts"))).toBe(true);
    expect(existsSync(join(created.root, "chosen", "chosen.ts")), "the candidate is the task's own").toBe(false);
    // Whatever the worker had put there is preserved for the owner, under a control-chosen name.
    const quarantined = readdirSync(dirname(occupied)).filter(name => name.startsWith(`${basename(occupied)}.rejected-`));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dirname(occupied), quarantined[0], "chosen", "chosen.ts"), "utf8"))
      .toBe("export const chosen = 1;\n");
  });

  it("refuses a plain directory carrying a copied .git file", () => {
    const repo = repository();
    insertRun("run-1", repo);
    // A real worktree elsewhere in the same repository, so the `.git` file copied from it is a
    // genuine pointer — and still proves nothing about the path a candidate would occupy.
    const elsewhere = join(directory, "elsewhere");
    git(repo, "worktree", "add", "--detach", "--force", elsewhere, "HEAD");
    const occupied = candidateDir("run-1");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, ".git"), readFileSync(join(elsewhere, ".git"), "utf8"));
    writeFileSync(join(occupied, "chosen.ts"), "export const chosen = 1;\n");
    const created = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(created.root).toBe(occupied);
    expect(existsSync(join(created.root, "chosen.ts")), "the planted tree was not adopted").toBe(false);
  });

  it("refuses another repository's worktree at the candidate path", () => {
    const repo = repository();
    const other = repository();
    insertRun("run-1", repo);
    const occupied = candidateDir("run-1");
    git(other, "worktree", "add", "--detach", "--force", occupied, "HEAD");
    const created = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(created.root).toBe(occupied);
    expect(git(repo, "worktree", "list", "--porcelain"), "the task now owns a worktree of its own").toContain(occupied);
    expect(git(other, "worktree", "list", "--porcelain"), "the other repository keeps its tree").toContain(occupied);
  });

  it("adopts a candidate holding work whose .git the worker removed", () => {
    // R1-1/P0: git reports a registration prunable once its gitfile is missing, and that is a byte
    // the worker can delete. Liveness comes from the control-owned registration instead, so real
    // work is still adopted — and one task's release still cannot erase another's registration.
    const repo = repository();
    insertRun("run-1", repo);
    insertRun("run-2", repo);
    const runtime = runtimeFor();
    const first = runtime.candidateFor("run-1", "T048", "ma-worker1");
    const second = runtime.candidateFor("run-2", "T048", "ma-worker1");
    writeFileSync(join(first.root, "src", "work.ts"), "export const work = 1;\n");
    rmSync(join(first.root, ".git"));

    const adopted = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(adopted.root).toBe(first.root);
    expect(candidateManifest(adopted).files.map(file => file.path)).toContain("src/work.ts");

    // Releasing the other candidate leaves this one's registration alone.
    removeCandidateWorkspace(second);
    expect(runtimeFor().candidateFor("run-1", "T048", "ma-worker1").root).toBe(first.root);
  });

  it("drops only its own registration when it removes a candidate", () => {
    const repo = repository();
    insertRun("run-1", repo);
    // An unrelated registration in the same repository, whose worktree is missing. Gone after the
    // release of the candidate, it could only have been a repository-wide prune.
    const unrelated = join(directory, "owner-elsewhere");
    git(repo, "worktree", "add", "--detach", "--force", unrelated, "HEAD");
    rmSync(unrelated, { recursive: true, force: true });

    const workspace = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    removeCandidateWorkspace(workspace);
    expect(git(repo, "worktree", "list", "--porcelain"), "another registration survives the release")
      .toContain(unrelated);
  });

  it("adopts and releases a candidate registered with relative pointers", () => {
    // R2-1: `worktree.useRelativePaths` writes the admin pointer relative to the registration's own
    // directory. Reading it as a path relative to ours names nothing, which quarantined a genuine
    // candidate and left its registration behind on release.
    const repo = repository();
    git(repo, "config", "worktree.useRelativePaths", "true");
    insertRun("run-1", repo);
    const created = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    // The fixture is only meaningful if git really wrote a relative pointer.
    const pointer = readFileSync(join(
      execFileSync("git", ["-C", repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(),
      "worktrees", "run-1-T048", "gitdir"), "utf8").trim();
    expect(pointer.startsWith("/"), "the pointer is relative, which is the case under test").toBe(false);

    writeFileSync(join(created.root, "src", "work.ts"), "export const work = 1;\n");
    const adopted = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(adopted.root).toBe(created.root);
    expect(candidateManifest(adopted).files.map(file => file.path)).toContain("src/work.ts");

    removeCandidateWorkspace(adopted);
    expect(existsSync(adopted.root)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain"), "the relative registration was dropped")
      .not.toContain(adopted.root);
  });

  it("adopts a genuine candidate when the source is itself a linked worktree", () => {
    const main = repository();
    const linked = join(directory, "linked-source");
    git(main, "worktree", "add", "--detach", "--force", linked, "HEAD");
    insertRun("run-1", linked);
    const created = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    writeFileSync(join(created.root, "src", "work.ts"), "export const work = 1;\n");
    const adopted = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(adopted.root).toBe(created.root);
    expect(candidateManifest(adopted).files.map(file => file.path)).toContain("src/work.ts");
  });

  it("adopts a genuine candidate when the source is reached through a symlink", () => {
    const repo = repository();
    const throughLink = join(directory, "repo-link");
    symlinkSync(repo, throughLink);
    insertRun("run-1", throughLink);
    const created = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    writeFileSync(join(created.root, "src", "work.ts"), "export const work = 1;\n");
    const adopted = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(adopted.root).toBe(created.root);
    expect(candidateManifest(adopted).files.map(file => file.path)).toContain("src/work.ts");
  });

  it("adopts a snapshot-lane candidate that has work in it, by its control-owned record", () => {
    const repo = unbornRepository();
    insertRun("run-1", repo);
    const created = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    const recordPath = join(recordsRoot, "run-1-T048.json");
    expect(existsSync(recordPath), "creation writes the record the restart will read").toBe(true);
    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toMatchObject({ version: 1, runId: "run-1", taskId: "T048" });
    writeFileSync(join(created.root, "src", "work.ts"), "export const work = 1;\n");

    const adopted = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(adopted.root).toBe(created.root);
    expect(candidateManifest(adopted).files.map(file => file.path)).toContain("src/work.ts");
  });

  it("refuses a snapshot-lane directory the control never recorded, and still launches", () => {
    const repo = unbornRepository();
    insertRun("run-1", repo);
    const occupied = candidateDir("run-1");
    mkdirSync(join(occupied, "src"), { recursive: true });
    writeFileSync(join(occupied, "src", "chosen.ts"), "export const chosen = 1;\n");

    // Even with a record root, no record names this directory, so it is not adopted.
    const created = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    expect(created.root).toBe(occupied);
    expect(readFileSync(join(created.root, "src", "base.ts"), "utf8")).toContain("base");
    expect(existsSync(join(created.root, "src", "chosen.ts")), "the planted tree was not adopted").toBe(false);
  });

  it("refuses snapshot provenance it cannot record at all", () => {
    const repo = unbornRepository();
    insertRun("run-1", repo);
    mkdirSync(candidateDir("run-1"), { recursive: true });
    // Without a record root the control cannot account for a snapshot candidate, so it refuses
    // rather than adopting a directory it could never prove was its own.
    expect(() => runtimeFor({ records: false }).candidateFor("run-1", "T048", "ma-worker1"))
      .toThrow(/Snapshot candidate provenance is not configured/);
  });

  it("releases the tree and drops only its own registration", () => {
    const repo = repository();
    insertRun("run-1", repo);
    const workspace = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    removeCandidateWorkspace(workspace);
    expect(existsSync(workspace.root), "the tree is deleted directly").toBe(false);
    // The registration is gone, so a later `worktree add` can reuse the path.
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(workspace.root);
  });

  it("hands no git process a candidate path while adopting or removing", () => {
    // R1-2: the previous version of this test could not fail — it planted an invalid gitdir, so
    // git would have rejected it before the marker mattered, and no assertion ever looked at what
    // git was given. This observes the invocation itself: every git call made while a candidate is
    // adopted and released is recorded, and none may name the candidate directory.
    const repo = repository();
    insertRun("run-1", repo);
    const workspace = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");

    const shim = join(directory, "shim");
    const log = join(directory, "git-argv.log");
    mkdirSync(shim, { recursive: true });
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(shim, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
    chmodSync(join(shim, "git"), 0o755);

    const savedPath = process.env.PATH;
    process.env.PATH = `${shim}:${savedPath}`;
    try {
      // Adoption of the same tree, then its release: both run through the shimmed git.
      const adopted = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
      expect(adopted.root).toBe(workspace.root);
      removeCandidateWorkspace(adopted);
      expect(existsSync(workspace.root)).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }

    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.length, "git ran, so the log is meaningful").toBeGreaterThan(0);
    expect(calls.filter(call => call.includes(workspace.root)), "no git argument names the candidate").toEqual([]);
  });

  it("removes a snapshot candidate's creation record with the tree", () => {
    const repo = unbornRepository();
    insertRun("run-1", repo);
    const workspace = runtimeFor().candidateFor("run-1", "T048", "ma-worker1");
    const recordPath = join(recordsRoot, "run-1-T048.json");
    expect(existsSync(recordPath)).toBe(true);
    removeCandidateWorkspace(workspace);
    expect(existsSync(workspace.root)).toBe(false);
    expect(existsSync(recordPath)).toBe(false);
  });
});