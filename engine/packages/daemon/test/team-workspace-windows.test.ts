import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateManifest, createCandidateWorkspace, readWorkspacePath, resolveWorkspaceBase,
} from "../src/domain/team-workspace.js";

/**
 * U1 — the worker-written-file boundary on Windows.
 *
 * `O_NOFOLLOW` and `O_DIRECTORY` are POSIX-only open flags, and `/proc/self/fd` is how the POSIX
 * walk names a pinned directory. Neither exists on Windows, so the same guarantee is made by
 * checking each entry for a reparse point: a junction or symbolic link below the candidate root is
 * refused (or recorded as a link and never followed) instead of silently redirecting a read. These
 * cases need the real Windows filesystem, because only it can create a junction.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = (prefix: string): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repository = (): string => {
  const root = temporary("u1-workspace-");
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "base");
  return root;
};

describe.skipIf(process.platform !== "win32")("U1 Windows worker-written-file boundary", () => {
  it("reads a workspace path by name on Windows", () => {
    const root = repository();
    expect(readWorkspacePath(root, "src/base.ts", () => false)).toMatchObject({ kind: "file", content: "export const base = 1;\n" });
    expect(readWorkspacePath(root, "src", () => false)).toMatchObject({ kind: "directory" });
    expect(readWorkspacePath(root, "src/missing.ts", () => false)).toEqual({ kind: "missing" });
  });

  it("refuses a junction planted between the root and a file", () => {
    const root = repository();
    const vault = temporary("u1-vault-");
    writeFileSync(join(vault, "secret.txt"), "VAULT SECRET\n");
    // A junction is the Windows shape of a directory symlink; it needs no elevation, unlike a file
    // symlink, and following it would read bytes outside the candidate.
    symlinkSync(vault, join(root, "src", "linked"), "junction");
    expect(() => readWorkspacePath(root, "src/linked/secret.txt", () => false))
      .toThrow("Candidate path became a symlink while it was read: src/linked/secret.txt");
  });

  it("refuses a junction in the candidate instead of staging what it points at", () => {
    const root = repository();
    const vault = temporary("u1-vault-");
    writeFileSync(join(vault, "secret.txt"), "VAULT SECRET\n");
    const workspace = createCandidateWorkspace({ root, base: resolveWorkspaceBase(root),
      workspaceRoot: temporary("u1-candidate-"), label: "windows-links" });
    // The worker writes into its own candidate; a junction there is what the copy must not follow.
    symlinkSync(vault, join(workspace.root, "src", "linked"), "junction");
    // A junction cannot be recreated as a link without elevation and Git would descend it, so the
    // boundary refuses it by name rather than putting the vault's bytes in the manifest.
    expect(() => candidateManifest(workspace)).toThrow("Candidate path is a link this host cannot stage without following it: src/linked");
  });
});
