import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateManifest, createCandidateWorkspace, removeCandidateWorkspace, resolveWorkspaceBase } from "../src/domain/team-workspace.js";

/**
 * The commit lane under the source repository's own line-ending conversion.
 *
 * Git for Windows installs `core.autocrlf=true` in the system configuration, so the candidate
 * worktree `git worktree add` writes holds `\r\n` for every file the base commit stores as `\n`,
 * while the blob it compares against is the `\n` form. The lane stages the copy, so without the
 * same value in force it recorded every such file as modified: the manifest described edits
 * nobody made, and the first of them that fell outside the write paths was refused as
 * `plan-change-required: outside-write-paths`. That is what stopped a fresh project's lead from
 * ever launching on Windows.
 *
 * The value is repository configuration rather than a platform fact, so the case is set with
 * `git config` and runs wherever git is installed: on POSIX it is an explicit `true`, on Windows
 * it is what the installation already does. This file holds only this case because the rest of
 * the commit lane's suite creates symlinks, which an unelevated Windows host cannot do.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const temporary = (prefix: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
};

const repository = (): string => {
  const root = temporary("line-endings-");
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  git(root, "config", "core.autocrlf", "true");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "base");
  return root;
};

describe("commit lane under the source's line-ending conversion", () => {
  it("manifest of an untouched candidate is empty", () => {
    const root = repository();
    const workspace = createCandidateWorkspace({ root, base: resolveWorkspaceBase(root),
      workspaceRoot: temporary("line-endings-candidate-"), label: "line-endings" });
    // The candidate is exactly the checkout git wrote: untouched, therefore no change at all.
    expect(git(workspace.root, "status", "--porcelain=v1")).toBe("");
    const manifest = candidateManifest(workspace);
    expect(manifest.patch).toBe("");
    expect(manifest.files.map(file => file.path)).toEqual(["README.md", "src/base.ts"]);
    removeCandidateWorkspace(workspace);
  });

  it("a real edit under the conversion is still the only change the manifest reports", () => {
    // The conversion must not hide an edit either: an edited line is a change in the stored form
    // and the manifest and patch must both carry it.
    const root = repository();
    const workspace = createCandidateWorkspace({ root, base: resolveWorkspaceBase(root),
      workspaceRoot: temporary("line-endings-candidate-"), label: "line-endings" });
    writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;\n");
    const manifest = candidateManifest(workspace);
    expect(manifest.patch).toContain("-export const base = 1;");
    expect(manifest.patch).toContain("+export const base = 2;");
    expect(manifest.patch).not.toContain("README.md");
    removeCandidateWorkspace(workspace);
  });
});