import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { candidateManifest, createCandidateWorkspace, isCandidateWorkTree, resolveWorkspaceBase } from "../src/domain/team-workspace.js";

// T044: a candidate's manifest must never run git inside the candidate, and must describe
// the candidate the repository defines.
//
// A candidate is worker-writable by design, so `git -C <candidate>` executes whatever the
// worker put there: replacing the candidate's `.git` gitdir file with a repository of its
// own and planting `core.fsmonitor` runs a worker-chosen program as the control. Two of
// the cases below were written from the round-1 review's reproductions and failed before
// the current fix; the rest cover inputs that fix originally missed.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(files: Record<string, string> = { "src/base.ts": "export const base = 1;\n" }): string {
  const root = mkdtempSync(join(tmpdir(), "t044-source-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** A candidate worktree, plus scratch space for a planted program that must never run. */
function candidate(source = repository()) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "t044-candidate-"));
  roots.push(workspaceRoot);
  const workspace = createCandidateWorkspace({ root: source, base: resolveWorkspaceBase(source), workspaceRoot, label: "t044" });
  const outside = mkdtempSync(join(tmpdir(), "t044-outside-"));
  roots.push(outside);
  return { source, workspace, marker: join(outside, "EXECUTED"), outside };
}

/** Replace the candidate's `.git` file with a repository of the worker's own. */
function plant(candidateRoot: string, outside: string, marker: string): void {
  rmSync(join(candidateRoot, ".git"));
  const workerGit = join(outside, "worker-git");
  git(candidateRoot, "init", "--quiet", "--separate-git-dir", workerGit, candidateRoot);
  git(candidateRoot, "config", "user.email", "worker@example.invalid");
  git(candidateRoot, "config", "user.name", "worker");
  git(candidateRoot, "add", ".");
  git(candidateRoot, "commit", "--quiet", "-m", "worker");
  writeFileSync(join(outside, "planted.sh"), `#!/bin/sh\necho ran >> ${marker}\nexit 1\n`);
  chmodSync(join(outside, "planted.sh"), 0o755);
  git(candidateRoot, "config", "core.fsmonitor", join(outside, "planted.sh"));
}

/** A repository planted one level above a directory, with every program hook armed. */
function plantedAncestor(parent: string, marker: string): void {
  const program = join(parent, "planted.sh");
  writeFileSync(program, `#!/bin/sh\necho ran >> ${marker}\nexit 1\n`);
  chmodSync(program, 0o755);
  mkdirSync(parent, { recursive: true });
  git(parent, "init", "--quiet", "--initial-branch=main");
  git(parent, "config", "user.email", "worker@example.invalid");
  git(parent, "config", "user.name", "worker");
  // Every configuration key that makes git invoke a program.
  for (const key of ["core.fsmonitor", "core.pager", "diff.external"]) git(parent, "config", key, program);
  writeFileSync(join(parent, ".gitattributes"), "* diff=planted\n");
  git(parent, "config", "diff.planted.command", program);
  return program;
}

describe("a candidate's manifest never executes what the worker wrote", () => {
  it("renders an unchanged candidate's manifest the way it always did", () => {
    const { workspace } = candidate();
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path)).toContain("src/base.ts");
    expect(manifest.files.every(file => file.tracked)).toBe(true);
    expect(manifest.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.patch).toBe("");
  });

  it("executes nothing the worker wrote, even with a planted core.fsmonitor", () => {
    const { workspace, marker, outside } = candidate();
    plant(workspace.root, outside, marker);
    expect(candidateManifest(workspace).manifestDigest).toMatch(/^sha256:/);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("does not let a repository planted in the candidate's parent capture the untracked patch", () => {
    // The production layout puts a candidate at `<assignment_root>/<worker>/<run>-<task>`,
    // and that parent is worker-owned. If the untracked patch runs from the parent, a
    // repository planted there answers for the call.
    const parent = mkdtempSync(join(tmpdir(), "t044-parent-"));
    roots.push(parent);
    const marker = join(parent, "EXECUTED");
    const source = repository();
    const workspaceRoot = join(parent, "ma-worker1", "run-1-T044");
    mkdirSync(join(parent, "ma-worker1"), { recursive: true });
    const workspace = createCandidateWorkspace({ root: source, base: resolveWorkspaceBase(source), workspaceRoot, label: "t044" });
    writeFileSync(join(workspace.root, "src", "new.ts"), "export const n = 1;\n");
    plantedAncestor(join(parent, "ma-worker1"), marker);
    const manifest = candidateManifest(workspace);
    // The planted program must not run, and the real deliverable must still be described.
    expect(existsSync(marker)).toBe(false);
    expect(manifest.patch).toContain("src/new.ts");
  }, 30_000);

  it("describes the same bytes whether or not the git metadata was tampered with", () => {
    const honest = candidate();
    writeFileSync(join(honest.workspace.root, "src", "base.ts"), "export const base = 3;\n");
    const honestManifest = candidateManifest(honest.workspace);

    const tampered = candidate();
    plant(tampered.workspace.root, tampered.outside, tampered.marker);
    writeFileSync(join(tampered.workspace.root, "src", "base.ts"), "export const base = 3;\n");
    const tamperedManifest = candidateManifest(tampered.workspace);

    expect(tamperedManifest.manifestDigest).toBe(honestManifest.manifestDigest);
    expect(tamperedManifest.files.map(f => f.path)).toEqual(honestManifest.files.map(f => f.path));
    expect(existsSync(tampered.marker)).toBe(false);
  }, 30_000);
});

describe("a candidate's manifest describes the candidate the repository defines", () => {
  it("keeps ignored files out of the manifest, the digest and the patch", () => {
    // `ls-files --others --exclude-standard` honoured .gitignore. A blind walk does not,
    // and would put a worker's .env into the reviewer packet.
    const source = repository({ "src/base.ts": "one\n", ".gitignore": ".env\nnode_modules/\ndebug.log\n" });
    const { workspace } = candidate(source);
    writeFileSync(join(workspace.root, ".env"), "DATABASE_URL=postgres://u:p@h/db\n");
    writeFileSync(join(workspace.root, "debug.log"), "noise\n");
    mkdirSync(join(workspace.root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(workspace.root, "node_modules", "dep", "index.js"), "x\n");
    writeFileSync(join(workspace.root, "src", "new.ts"), "export const n = 1;\n");

    const manifest = candidateManifest(workspace);
    const paths = manifest.files.map(file => file.path);
    expect(paths).not.toContain(".env");
    expect(paths.some(path => path.startsWith("node_modules/"))).toBe(false);
    expect(paths).not.toContain("debug.log");
    expect(paths).toContain("src/new.ts");
    // The secret must not reach the patch, which is review evidence.
    expect(manifest.patch).not.toContain("DATABASE_URL");
  }, 30_000);

  it("renders untracked additions relative to the repository, so the patch applies at its root", () => {
    const { workspace } = candidate();
    writeFileSync(join(workspace.root, "src", "new.ts"), "export const n = 1;\n");
    const manifest = candidateManifest(workspace);
    const header = manifest.patch.split("\n").find(line => line.startsWith("diff --git"));
    expect(header).toBeDefined();
    // Repo-relative, and never the host path the candidate happens to live under.
    expect(header).toContain("a/src/new.ts");
    expect(manifest.patch).not.toContain(workspace.root);
  }, 30_000);

  it("is not influenced by the source repository's index", () => {
    // `git diff <commit> --work-tree=…` also compares against the SOURCE index. An owner
    // `git rm --cached` would then add a deletion to an unmodified candidate's patch.
    const source = repository({ "src/base.ts": "one\n", "src/other.ts": "two\n" });
    const { workspace } = candidate(source);
    const before = candidateManifest(workspace).patch;
    expect(before).toBe("");
    git(source, "rm", "--cached", "src/other.ts");
    const after = candidateManifest(workspace).patch;
    expect(after).toBe(before);
    expect(after).not.toContain("deleted file mode");
  }, 30_000);

  it("keeps a worker's git add from changing the identity of identical bytes", () => {
    // The digest encodes the tracked flag. If that flag means "in the base commit" rather
    // than "in the index", one worker `git add` shifts every recorded identity.
    const { workspace } = candidate();
    writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;\n");
    const before = candidateManifest(workspace);
    git(workspace.root, "add", "src/base.ts");
    const after = candidateManifest(workspace);
    expect(after.manifestDigest).toBe(before.manifestDigest);
  }, 30_000);
});

describe("adopting a candidate that survived a restart", () => {
  it("recognizes a real work tree of the source", () => {
    const { workspace, source } = candidate();
    expect(isCandidateWorkTree(workspace.root, source)).toBe(true);
  });

  it("rejects a directory that merely copies another worktree's .git file", () => {
    const { workspace, source, outside } = candidate();
    // A copy carries the same `gitdir:` line but is not the worktree that gitdir names.
    const impostor = join(outside, "impostor");
    mkdirSync(impostor, { recursive: true });
    writeFileSync(join(impostor, ".git"), readFileSync(join(workspace.root, ".git")));
    writeFileSync(join(impostor, "evil.ts"), "x\n");
    expect(isCandidateWorkTree(impostor, source)).toBe(false);
  });

  it("rejects a plain directory with no git metadata", () => {
    const { source, outside } = candidate();
    const plain = join(outside, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "notes.txt"), "x\n");
    expect(isCandidateWorkTree(plain, source)).toBe(false);
  });
});