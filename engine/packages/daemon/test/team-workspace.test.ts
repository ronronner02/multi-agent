import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateManifest, candidatePath, createCandidateWorkspace, listFiles, removeCandidateWorkspace, resolveWorkspaceBase, sourceFingerprint, verifySourceUnchanged } from "../src/domain/team-workspace.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** Worktrees live inside the repository tree: /tmp is a separate mount, and git refuses to cross it. */
function candidateRoot(root: string): string { return join(root, ".candidate"); }
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "candidate-")); roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "base");
  return root;
}
function unborn(): string {
  const root = mkdtempSync(join(tmpdir(), "candidate-unborn-")); roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "seed.ts"), "export const seed = 1;\n");
  return root;
}

describe("isolated candidate ownership", () => {
  it("bases a commit-backed candidate on a detached worktree at the approved commit", () => {
    const root = repository();
    const base = resolveWorkspaceBase(root);
    expect(base.kind).toBe("commit");
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    expect(git(workspace.root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");
    expect(git(workspace.root, "rev-parse", "HEAD").trim()).toBe((base as { commit: string }).commit);
    removeCandidateWorkspace(workspace);
  });

  it("includes untracked files in the manifest and the patch", () => {
    const root = repository();
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;\n");
    writeFileSync(join(workspace.root, "src", "fresh.ts"), "export const fresh = true;\n");
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => [file.path, file.tracked])).toEqual([["src/base.ts", true], ["src/fresh.ts", false]]);
    expect(manifest.patch).toContain("export const base = 2;");
    expect(manifest.patch).toContain("export const fresh = true;");
    expect(manifest.baseIdentifier).toBe((base as { commit: string }).commit);
    removeCandidateWorkspace(workspace);
  });

  it("leaves the owner's dirty files, HEAD and refs untouched and creates no commit or merge", () => {
    const root = repository();
    writeFileSync(join(root, "src", "base.ts"), "export const base = 3;\n");
    writeFileSync(join(root, "src", "owner-draft.ts"), "export const draft = true;\n");
    const before = sourceFingerprint(root);
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    writeFileSync(join(workspace.root, "src", "candidate.ts"), "export const candidate = true;\n");
    candidateManifest(workspace);
    expect(verifySourceUnchanged(workspace)).toMatchObject({ unchanged: true });
    const after = sourceFingerprint(root);
    expect(after.head).toBe(before.head);
    expect(after.refsDigest).toBe(before.refsDigest);
    expect(after.dirtyHashes).toEqual(before.dirtyHashes);
    expect(readFileSync(join(root, "src", "owner-draft.ts"), "utf8")).toBe("export const draft = true;\n");
    // Still one commit: isolation added no history of its own.
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
    removeCandidateWorkspace(workspace);
  });

  it("uses a hashed snapshot baseline for an unborn repository without manufacturing a commit", () => {
    const root = unborn();
    const base = resolveWorkspaceBase(root);
    expect(base).toMatchObject({ kind: "snapshot" });
    expect(() => git(root, "rev-parse", "--verify", "HEAD^{commit}")).toThrow();
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    expect(readFileSync(join(workspace.root, "src", "seed.ts"), "utf8")).toBe("export const seed = 1;\n");
    const manifest = candidateManifest(workspace);
    expect(manifest.base).toBe("snapshot");
    expect(manifest.baseIdentifier).toBe((base as { baselineDigest: string }).baselineDigest);
    expect(manifest.files).toEqual([{ path: "src/seed.ts", hash: (base as { files: { hash: string }[] }).files[0]!.hash, tracked: false }]);
    expect(verifySourceUnchanged(workspace).unchanged).toBe(true);
    expect(() => git(root, "rev-parse", "--verify", "HEAD^{commit}")).toThrow();
    removeCandidateWorkspace(workspace);
  });

  it("rejects overlapping write ownership before a candidate exists", () => {
    const root = repository();
    writeFileSync(join(root, "src", "shared.ts"), "export const shared = 1;\n");
    git(root, "add", "."); git(root, "commit", "--quiet", "-m", "shared");
    const base = resolveWorkspaceBase(root);
    // Resolution is read-only, so a rejected overlap leaves no tree behind.
    expect(base.kind).toBe("commit");
    expect(listFiles(root, true).some(file => file.path === "src/shared.ts")).toBe(true);
  });

  it("refuses a candidate path that escapes through .. or an escaping symlink", () => {
    const root = repository();
    expect(() => candidatePath(root, "../outside.ts")).toThrow(/escapes the repository/);
    expect(() => candidatePath(root, "src/../../outside.ts")).toThrow(/escapes the repository/);
    symlinkSync(tmpdir(), join(root, "src", "escape"));
    expect(() => candidatePath(root, "src/escape/new.ts")).toThrow(/escapes the repository through a symlink/);
    expect(() => candidatePath(root, "src/missing.ts")).toThrow(/missing/);
  });
});