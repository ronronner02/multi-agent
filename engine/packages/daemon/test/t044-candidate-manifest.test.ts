import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateManifest, createCandidateWorkspace, resolveWorkspaceBase } from "../src/domain/team-workspace.js";

// T044: a candidate's manifest must never run git inside the candidate.
//
// A candidate is worker-writable by design, so `git -C <candidate>` executes whatever
// the worker put there: replacing the candidate's `.git` gitdir file with a repository
// of its own and planting `core.fsmonitor` runs a worker-chosen program as the control.
// This was reproduced end to end before the fix; these cases keep it reproduced.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "t044-source-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** A candidate worktree, and the marker a planted program would leave behind. */
function candidate(): { source: string; workspace: ReturnType<typeof createCandidateWorkspace>; marker: string; outside: string } {
  const source = repository();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "t044-candidate-"));
  roots.push(workspaceRoot);
  const base = resolveWorkspaceBase(source);
  const workspace = createCandidateWorkspace({ root: source, base, workspaceRoot, label: "t044" });
  // The worker's own gitdir and planted program live OUTSIDE the candidate: inside it
  // they would be candidate files and would change the manifest being compared.
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

describe("candidate manifests never run git inside the candidate", () => {
  it("renders an unchanged candidate's manifest the same way it always did", () => {
    const { workspace } = candidate();
    const manifest = candidateManifest(workspace);
    // The tracked set is the base commit's, and the digest covers it.
    expect(manifest.files.map(file => file.path)).toContain("src/base.ts");
    expect(manifest.files.every(file => file.tracked)).toBe(true);
    expect(manifest.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // An unmodified candidate has no tracked diff, so the patch is empty.
    expect(manifest.patch).toBe("");
  });

  it("still describes the same bytes after the worker replaces the candidate's git metadata", () => {
    const { workspace, marker, outside } = candidate();
    const before = candidateManifest(workspace).manifestDigest;
    writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;\n");
    const after = candidateManifest(workspace).manifestDigest;
    // The bytes changed, so the digest must change; that is the manifest working.
    expect(after).not.toBe(before);
  });

  it("executes nothing the worker wrote, even with a planted core.fsmonitor", () => {
    const { workspace, marker, outside } = candidate();
    plant(workspace.root, outside, marker);
    // The manifest is computed over the tampered candidate.
    const manifest = candidateManifest(workspace);
    expect(manifest.manifestDigest).toMatch(/^sha256:/);
    // The planted program would have appended to the marker on any git invocation that
    // ran inside the candidate. It must not have run at all.
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("describes the same bytes whether or not the git metadata was tampered with", () => {
    // Two candidates over the same base with identical file bytes: one honest, one with
    // its `.git` replaced. The manifest describes bytes, so the digests must match.
    const honest = candidate();
    writeFileSync(join(honest.workspace.root, "src", "base.ts"), "export const base = 3;\n");
    const honestManifest = candidateManifest(honest.workspace);

    const tampered = candidate();
    // Plant first, then give it the same bytes as the honest candidate: the two trees
    // must differ only in their git metadata for this comparison to mean anything.
    plant(tampered.workspace.root, tampered.outside, tampered.marker);
    writeFileSync(join(tampered.workspace.root, "src", "base.ts"), "export const base = 3;\n");
    const tamperedManifest = candidateManifest(tampered.workspace);

    expect(tamperedManifest.manifestDigest).toBe(honestManifest.manifestDigest);
    expect(tamperedManifest.files.map(f => f.path)).toEqual(honestManifest.files.map(f => f.path));
    expect(existsSync(tampered.marker)).toBe(false);
  }, 30_000);
});