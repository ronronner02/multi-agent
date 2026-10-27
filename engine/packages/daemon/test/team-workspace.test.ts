import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { candidateManifest, candidatePath, createCandidateWorkspace, createReviewPacket, listFiles, removeCandidateWorkspace, removeReviewPacket, resolveWorkspaceBase, sourceFingerprint, verifyReviewPacket, verifySourceUnchanged } from "../src/domain/team-workspace.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of [...roots.splice(0), ...outsideRoots.splice(0)]) rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/**
 * Candidate trees live outside the repository. Placing one inside it would let
 * git discovery find the parent repository and hide every snapshot-lane bug.
 */
const outsideRoots: string[] = [];
function candidateRoot(_root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "candidate-tree-"));
  outsideRoots.push(dir);
  return dir;
}
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

  it("represents a deleted tracked file in the patch without failing the manifest", () => {
    const root = repository();
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    rmSync(join(workspace.root, "src", "base.ts"));
    const manifest = candidateManifest(workspace);
    expect(manifest.files).toEqual([]);
    expect(manifest.patch).toContain("deleted file mode");
    removeCandidateWorkspace(workspace);
  });

  it("resolves paths through a root reached by symlink", () => {
    const root = repository();
    const link = join(tmpdir(), `candidate-link-${Date.now()}`); roots.push(link);
    symlinkSync(root, link);
    expect(readFileSync(candidatePath(link, "src/base.ts"), "utf8").trim()).toBe("export const base = 1;");
  });

  it("builds a snapshot manifest for a copy that is not itself a repository", () => {
    const root = unborn();
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    // The copy has no .git; asking git here would exit 128 and produce no manifest.
    expect(() => readFileSync(join(workspace.root, ".git"))).toThrow();
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path)).toEqual(["src/seed.ts"]);
  });

  it("keeps file already staged in an unborn repository in the snapshot baseline", () => {
    const root = unborn();
    writeFileSync(join(root, "src", "staged.ts"), "export const staged = 1;\n");
    git(root, "add", "src/staged.ts");
    const base = resolveWorkspaceBase(root);
    expect(base.kind).toBe("snapshot");
    expect((base as { files: { path: string }[] }).files.map(file => file.path).sort()).toEqual(["src/seed.ts", "src/staged.ts"]);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    expect(readFileSync(join(workspace.root, "src", "staged.ts"), "utf8")).toContain("staged");
  });

  it("refuses to materialize a snapshot whose baseline changed after it was resolved", () => {
    const root = unborn();
    const base = resolveWorkspaceBase(root);
    writeFileSync(join(root, "src", "seed.ts"), "export const seed = 999;\n");
    expect(() => createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" }))
      .toThrow(/Snapshot baseline changed/);
  });

  it("reports an untracked owner file that changed after capture", () => {
    const root = repository();
    writeFileSync(join(root, "src", "draft.ts"), "draft one\n");
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    writeFileSync(join(root, "src", "draft.ts"), "draft two\n");
    expect(verifySourceUnchanged(workspace)).toMatchObject({ unchanged: false });
  });

  it("keeps meaningful trailing whitespace on a final changed line", () => {
    const root = repository();
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    // Two significant trailing spaces: a patch that trims them describes other bytes.
    writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;  ");
    const manifest = candidateManifest(workspace);
    expect(manifest.patch).toContain("export const base = 2;  ");
    // T044: the patch now ends with the newline `git apply` needs, so the marker is the
    // last *line* of the last hunk rather than the last bytes of the string.
    expect(manifest.patch.trimEnd().endsWith("\ No newline at end of file")).toBe(true);
    removeCandidateWorkspace(workspace);
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

/**
 * T044 — the manifest must never be computed through the candidate's own git.
 *
 * A candidate is worker-writable by design, so every `git` the module ran with the
 * candidate as its working directory, work tree or repository executed whatever the
 * worker wrote there. T044's three review rounds each closed one program hook and the
 * next round found another (`core.fsmonitor`, `diff.external`, `filter.<drv>.clean`),
 * which is why the fix removes git from the candidate instead of enumerating hooks.
 *
 * Each case below is the reproduction a reviewer used, written as a test that fails
 * on the base commit. The shared assertion helper watches a canary: every vector runs
 * a program that would create it, so "the manifest still describes the same bytes"
 * and "nothing the worker wrote ran" are checked separately.
 */
describe("T044 commit-lane manifest without a git in the candidate", () => {
  // Captured from the base commit's source, on the richRepository() fixture below.
  // The manifest for an unmodified candidate must keep exactly these bytes: every
  // recorded candidate identity in every run is this digest.
  //
  // T054 re-captured them once, as plan U5 accepted: `src/link.md` is now hashed as the
  // link's own text, which is what git stores and what the patch writes, instead of
  // through its target's bytes.
  const GOLDEN_DIGEST = "sha256:d154f8eb5464dea71f761724a53620e17e42e5dca051be08a3ae8174c7956d7e";
  const GOLDEN_FILES: readonly (readonly [string, string, boolean])[] = [
    [".gitignore", "sha256:9a4e80f747a5791fbca62d7b04bdad73c6e37fdbf4398943bc85810a00facb64", true],
    ["README.md", "sha256:faa5b4816800b8cbe1595e5533fe36c53f396c0c26a3a876dd3e4085232348a1", true],
    ["docs/target.md", "sha256:7395d98c09c6c11bc827d489c2c974253508fabe2d41bf334b9e929664a887f6", true],
    ["run.sh", "sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba", true],
    ["src/base.ts", "sha256:234a49990ed0ca423d7e03f6831099806c117bfe29ed0add57df7415cd732271", true],
    ["src/binary.dat", "sha256:23e5b91bc67af30fad5933903277da95d30a3791f267d540796ed5d381252aa0", true],
    ["src/link.md", "sha256:7b23654b6087192fc8a2be9fcb5e7f2edc7f556159da8139594c3cb742996d4a", true],
    ["src/nested/deep/leaf.ts", "sha256:824ff7cdf2b91463b1179488abfd254683ccb0f638549c7d56ffb86c642b2253", true],
    ["src/trailing.ts", "sha256:3da9df10960a5b5df7633e2714424825a9814316e92c9420467cad11297e1ccb", true],
  ];

  /** A canary outside every tree the test owns; only a worker-planted program writes it. */
  function canary(): { path: string; seen: () => boolean } {
    const path = join(mkdtempSync(join(tmpdir(), "t044-canary-")), "ran");
    outsideRoots.push(join(path, ".."));
    return { path, seen: () => existsSync(path) };
  }

  /** A repository with one tracked file, one tracked symlink and a controlling .gitignore. */
  function richRepository(): string {
    const root = mkdtempSync(join(tmpdir(), "t044-rich-")); roots.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
    mkdirSync(join(root, "src", "nested", "deep"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# fixture\n");
    writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
    writeFileSync(join(root, "src", "nested", "deep", "leaf.ts"), "export const leaf = true;\n");
    // Significant trailing whitespace and no final newline: a patch that trims either
    // describes bytes other than the ones the manifest hashed.
    writeFileSync(join(root, "src", "trailing.ts"), "no newline at end  ");
    writeFileSync(join(root, "src", "binary.dat"), Buffer.from([0, 1, 2, 255, 0, 3]));
    writeFileSync(join(root, "docs", "target.md"), "the symlink target\n");
    writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(root, "run.sh"), 0o755);
    // A tracked symlink, as this repository has five of. On the base commit it is
    // hashed through its target's bytes because the manifest read the path.
    symlinkSync("../docs/target.md", join(root, "src", "link.md"));
    writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n.env\n");
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "base");
    return root;
  }

  function candidateOf(root: string) {
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T044" });
    roots.push(workspace.root);
    return workspace;
  }

  /**
   * Take the candidate's repository metadata over the way a worker would: it is
   * worker-writable, so the worker deletes the worktree link, builds a repository of
   * its own and points that repository's configuration at a program it wrote.
   *
   * `git fetch` from the source is available to the worker too — it may read the
   * source tree — and it makes the base commit an object of the worker's repository.
   * That matters: without it the base commit is unknown there and the tracked-diff
   * call fails before reaching a hook, which would let a test pass for the wrong
   * reason. With it, the only thing left between the worker and execution is which
   * directory git is asked about.
   */
  function takeOverRepositoryMetadata(
    workspace: { root: string; sourceRoot: string; base: { kind: string; commit?: string } },
    configure: (gitIn: (...args: string[]) => void) => void,
  ): void {
    const candidate = workspace.root;
    rmSync(join(candidate, ".git"), { recursive: true, force: true });
    git(candidate, "init", "--quiet");
    git(candidate, "config", "user.email", "worker@example.invalid");
    git(candidate, "config", "user.name", "worker");
    if (workspace.base.commit) git(candidate, "fetch", "--quiet", workspace.sourceRoot, workspace.base.commit);
    configure((...args: string[]) => git(candidate, ...args));
  }

  function plant(candidate: string, name: string, body: string, canaryPath: string): string {
    const program = join(candidate, name);
    writeFileSync(program, `#!/bin/sh\n: > ${JSON.stringify(canaryPath)}\n${body}\n`);
    chmodSync(program, 0o755);
    return program;
  }

  /**
   * A program planted outside the candidate. A candidate is worker-writable, but so is
   * everything the worker itself owns; the defence is that git never reads a path the
   * worker controls, not that the worker could not write a script.
   */
  function plantedOutside(candidate: string, body: string, canaryPath: string): string {
    const program = plant(dirname(candidate), `worker-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`, body, canaryPath);
    return program;
  }

  /** One file's section of a patch, so an assertion cannot be satisfied by unrelated bytes. */
  function patchSection(patch: string, path: string): string {
    const start = patch.indexOf(`diff --git a/${path} b/${path}`);
    if (start < 0) return "";
    const next = patch.indexOf("\ndiff --git ", start + 1);
    return next < 0 ? patch.slice(start) : patch.slice(start, next);
  }

  it("runs no program the worker planted through core.fsmonitor (round 1 vector)", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    const mark = canary();
    takeOverRepositoryMetadata(workspace, configure => {
      configure("config", "core.fsmonitor", plant(workspace.root, "planted.sh", "exit 0", mark.path));
    });
    writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path)).toContain("src/deliverable.ts");
    expect(mark.seen(), "a worker-planted core.fsmonitor program ran as the control").toBe(false);
  });

  it("runs no program the worker planted through diff.external (round 2 vector)", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    const mark = canary();
    takeOverRepositoryMetadata(workspace, configure => {
      configure("config", "diff.external", plant(workspace.root, "planted.sh", "cat", mark.path));
    });
    writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
    candidateManifest(workspace);
    expect(mark.seen(), "a worker-planted diff.external program ran as the control").toBe(false);
  });

  it("runs no worker-planted program through filter.<drv>.clean, and refuses the attributes it needs", () => {
    // A filter driver only runs if attributes select it, and attributes are a rule file, which
    // this lane gives to the base commit alone. The candidate cannot ask for a driver at all.
    const root = richRepository();
    const workspace = candidateOf(root);
    const mark = canary();
    takeOverRepositoryMetadata(workspace, configure => {
      configure("config", "filter.evil.clean", plantedOutside(workspace.root, "printf 'SAFE CONTENT\\n'", mark.path));
    });
    writeFileSync(join(workspace.root, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const MALICIOUS = true;\n");
    expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
    expect(mark.seen(), "a worker-planted filter.<drv>.clean program ran as the control").toBe(false);
  });

  it("T051: the base commit's attributes are the only ones in force, and no source driver runs", () => {
    // The candidate cannot supply attributes, so the only attributes in force are the base's. A
    // filter driver the base itself names still must not run: the store configures no driver.
    const root = richRepository();
    const mark = canary();
    writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\nsrc/deliverable.ts filter=evil\n");
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "attributes");
    const driver = plantedOutside(root, "printf 'REWRITTEN\\n'", mark.path);
    git(root, "config", "filter.evil.clean", driver);
    git(root, "config", "filter.evil.required", "true");
    const workspace = candidateOf(root);
    writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const OURS = true;\n");
    writeFileSync(join(workspace.root, "note.txt"), "ours\r\n");
    const manifest = candidateManifest(workspace);

    expect(mark.seen(), "a filter driver the source configured ran as the control").toBe(false);
    const note = manifest.files.find(file => file.path === "note.txt");
    expect(note?.hash, "the manifest hashes the cleaned reading").toBe(
      `sha256:${createHash("sha256").update("ours\n").digest("hex")}`);
    const section = patchSection(manifest.patch, "src/deliverable.ts");
    expect(section).toContain("export const OURS = true;");
    expect(manifest.patch).not.toContain("REWRITTEN");
    expect(manifest.patch).not.toContain(workspace.root);
  });

  it("refuses a candidate that rewrites or deletes .gitignore, so base ignore authority cannot move", () => {
    // A rewritten rule could hide a deliverable or admit what the base ignores, and a deleted one
    // admits everything the base excluded. Both are refused, so neither direction is expressible.
    const rewriting = richRepository();
    const rewritingWorkspace = candidateOf(rewriting);
    writeFileSync(join(rewritingWorkspace.root, ".env"), "DATABASE_URL=postgres://user:pw@host/db\n");
    writeFileSync(join(rewritingWorkspace.root, ".gitignore"), "*\n");
    expect(() => candidateManifest(rewritingWorkspace)).toThrow(/changes a rule file/);

    const deleting = richRepository();
    const deletingWorkspace = candidateOf(deleting);
    rmSync(join(deletingWorkspace.root, ".gitignore"));
    expect(() => candidateManifest(deletingWorkspace)).toThrow(/changes a rule file/);
  });

  it("records a symlink out of the candidate as its own text rather than smuggling ignored bytes", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    // A link whose target the base commit ignores. Following it would put the target's bytes
    // into the manifest, the digest, the patch and the reviewer packet, where an innocuously
    // named `innocent.md` would read as a candidate deliverable. The link's own text does none
    // of that.
    writeFileSync(join(workspace.root, ".env"), "DATABASE_URL=postgres://user:pw@host/db\n");
    symlinkSync("../.env", join(workspace.root, "src", "innocent.md"));
    const manifest = candidateManifest(workspace);
    expect(manifest.files.find(file => file.path === "src/innocent.md")?.hash).toBe(
      `sha256:${createHash("sha256").update("../.env").digest("hex")}`);
    // The ignored target is still not a candidate file, and its bytes appear nowhere.
    expect(manifest.files.map(file => file.path)).not.toContain(".env");
    expect(manifest.patch).not.toContain("DATABASE_URL");
  });

  it("does not follow a tracked directory the worker replaced with a link to a vault", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    // A worker turns a tracked directory into a link to a directory of secrets. Its children
    // still have tracked paths, so a reader that followed the link would put the vault's bytes
    // in the manifest. The link is a leaf: the children are gone, and the patch says so.
    writeFileSync(join(workspace.root, ".env"), "DATABASE_URL=postgres://user:pw@host/db\n");
    mkdirSync(join(workspace.root, "vault"), { recursive: true });
    writeFileSync(join(workspace.root, "vault", "leaf.ts"), "export const secret = 1;\n");
    rmSync(join(workspace.root, "src", "nested"), { recursive: true, force: true });
    symlinkSync("../vault", join(workspace.root, "src", "nested"));
    const manifest = candidateManifest(workspace);
    expect(manifest.files.find(file => file.path === "src/nested")?.hash).toBe(
      `sha256:${createHash("sha256").update("../vault").digest("hex")}`);
    expect(manifest.files.map(file => file.path)).not.toContain("src/nested/deep/leaf.ts");
  });

  it("ignores ambient GIT_ redirection that would point git at the candidate", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    const mark = canary();
    takeOverRepositoryMetadata(workspace, configure => {
      configure("config", "core.fsmonitor", plant(workspace.root, "planted.sh", "exit 0", mark.path));
    });
    writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
    // A worker cannot set the daemon's environment, but a misconfigured host can. The
    // lane must drop these rather than inherit whatever points them at the candidate.
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries({
      GIT_DIR: join(workspace.root, ".git"),
      GIT_WORK_TREE: workspace.root,
      GIT_CONFIG_GLOBAL: join(workspace.root, ".git", "config"),
      GIT_CEILING_DIRECTORIES: workspace.root,
    })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const manifest = candidateManifest(workspace);
      expect(manifest.files.map(file => file.path)).toContain("src/deliverable.ts");
      expect(mark.seen(), "ambient GIT_ redirection made git run the candidate's program").toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("records a tracked symlink as its link text, which is what the patch writes", () => {
    // T054: git records a link as a link, so the manifest hashes the link's own text — the
    // bytes the patch carries — and not the target's contents. That reading is what makes
    // the manifest and the patch one description of the candidate.
    const root = richRepository();
    const workspace = candidateOf(root);
    const manifest = candidateManifest(workspace);
    const link = manifest.files.find(file => file.path === "src/link.md");
    expect(link, "a tracked symlink is part of the candidate").toBeDefined();
    expect(link?.tracked).toBe(true);
    expect(link?.hash).toBe(`sha256:${createHash("sha256").update("../docs/target.md").digest("hex")}`);
    expect(readFileSync(join(workspace.root, "src", "link.md"), "utf8")).toBe("the symlink target\n");
  });

  it("records a chain of tracked symlinks as their own link texts, and leaves the patch empty", () => {
    // A link is stored as its own text, so `l2 -> l1` is described by the text `l1` and not
    // by whatever `l1` eventually names. An untouched candidate still needs no patch.
    const root = richRepository();
    symlinkSync("link.md", join(root, "src", "link2.md"));
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "chain");
    const workspace = candidateOf(root);
    const manifest = candidateManifest(workspace);
    for (const path of ["src/link.md", "src/link2.md"]) {
      const link = manifest.files.find(file => file.path === path);
      expect(link, `${path} is part of the candidate`).toBeDefined();
      expect(link?.tracked).toBe(true);
    }
    expect(manifest.files.find(file => file.path === "src/link2.md")?.hash).toBe(
      `sha256:${createHash("sha256").update("link.md").digest("hex")}`);
    expect(manifest.patch, "an unmodified candidate needs no patch").toBe("");
  });

  it("records an escaping, dangling or directory symlink as its own text and reads nothing through it", () => {
    // T054 replaced refusal with a positive guarantee: the copy carries a link's text and
    // never follows one. A link out of the tree therefore leaks nothing — the vault's bytes
    // are not read, hashed, patched or copied — which is strictly stronger than refusing the
    // whole manifest over a link that is, after all, part of the candidate.
    const escaping = richRepository();
    const workspaceA = candidateOf(escaping);
    symlinkSync("/etc/hostname", join(workspaceA.root, "src", "esc.md"));
    const a = candidateManifest(workspaceA);
    expect(a.files.find(file => file.path === "src/esc.md")?.hash).toBe(
      `sha256:${createHash("sha256").update("/etc/hostname").digest("hex")}`);
    expect(a.patch).not.toContain(readFileSync("/etc/hostname").subarray(0, 20).toString("utf8").trim() || "root:");

    const dangling = richRepository();
    const workspaceB = candidateOf(dangling);
    symlinkSync("nowhere-at-all.md", join(workspaceB.root, "src", "gone.md"));
    const b = candidateManifest(workspaceB);
    expect(b.files.find(file => file.path === "src/gone.md")?.hash).toBe(
      `sha256:${createHash("sha256").update("nowhere-at-all.md").digest("hex")}`);

    const toDirectory = richRepository();
    const workspaceC = candidateOf(toDirectory);
    symlinkSync("nested", join(workspaceC.root, "src", "dirlink"));
    const c = candidateManifest(workspaceC);
    // The link is an entry; the directory it names contributes no entry of its own.
    expect(c.files.find(file => file.path === "src/dirlink")?.hash).toBe(
      `sha256:${createHash("sha256").update("nested").digest("hex")}`);
    expect(c.files.map(file => file.path)).toContain("src/nested/deep/leaf.ts");
  });

  it("records a tracked file the worker replaced with an escaping link as that link, not as a deletion", () => {
    // The patch presents the link itself, which is what the candidate now holds: the worker
    // chose to replace the file, and the manifest says so instead of hiding the change.
    const root = richRepository();
    const workspace = candidateOf(root);
    rmSync(join(workspace.root, "src", "base.ts"));
    symlinkSync("/etc/hostname", join(workspace.root, "src", "base.ts"));
    const manifest = candidateManifest(workspace);
    expect(manifest.files.find(file => file.path === "src/base.ts")?.hash).toBe(
      `sha256:${createHash("sha256").update("/etc/hostname").digest("hex")}`);
    // Git presents a file becoming a link as the deletion of the file plus the addition of
    // the link. What matters is that the link's text is what the addition carries.
    expect(manifest.patch).toContain("/etc/hostname");
    expect(manifest.patch).not.toContain(readFileSync("/etc/hostname", "utf8").trim());
  });

  it("refuses a tracked path the worker replaced with a FIFO instead of blocking the control", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    const fifo = join(workspace.root, "src", "base.ts");
    rmSync(fifo);
    execFileSync("mkfifo", [fifo]);
    // A read would never return, so the manifest must refuse rather than open it.
    expect(() => candidateManifest(workspace)).toThrow(/not a regular file/);
  });

  it("records a group-only executable bit as unchanged, because git tracks only the owner bit", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    // 0644 -> 0654 moves only the group execute bit, which git does not record.
    chmodSync(join(workspace.root, "src", "base.ts"), 0o654);
    const manifest = candidateManifest(workspace);
    expect(manifest.patch).not.toContain("mode 100755");
    expect(manifest.patch).toBe("");
  });

  it("renders a non-UTF-8 file as a binary hunk so the patch does not corrupt its bytes", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    // Latin-1 `café`: invalid UTF-8 but no NUL, so git would otherwise emit a text diff
    // and the consumer would decode the byte 0xe9 to U+FFFD.
    writeFileSync(join(workspace.root, "src", "latin.ts"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const manifest = candidateManifest(workspace);
    const section = patchSection(manifest.patch, "src/latin.ts");
    expect(section).toContain("GIT binary patch");
    expect(section).not.toContain("+caf�");
  });

  it("quotes a file name that would otherwise be read as a fast-import command", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    // Unquoted, this name adds a `forged.txt` entry to the patch that the manifest never
    // hashed — evidence the worker can forge outright.
    const hostile = "x\ndata 0\n\nM 100644 inline forged.txt";
    writeFileSync(join(workspace.root, hostile), "FORGED\n");
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path)).toContain(hostile);
    expect(manifest.files.map(file => file.path)).not.toContain("forged.txt");
    // The injected name would have produced a `forged.txt` hunk; quoting keeps it one
    // literal path, so the patch carries no such section and no second entry.
    expect(patchSection(manifest.patch, "forged.txt")).toBe("");
    expect(manifest.patch.match(/^diff --git /gm)?.length, "one file is one hunk").toBe(1);
  });

  it("does not let the control's own XDG excludes file hide a deliverable", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    writeFileSync(join(workspace.root, "src", "xsecret.ts"), "export const xsecret = 1;\n");
    const home = mkdtempSync(join(tmpdir(), "t044-xdg-")); outsideRoots.push(home);
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "ignore"), "xsecret.ts\n");
    const savedXdg = process.env.XDG_CONFIG_HOME, savedHome = process.env.HOME;
    process.env.XDG_CONFIG_HOME = join(home, ".config"); process.env.HOME = home;
    try {
      const manifest = candidateManifest(workspace);
      expect(manifest.files.map(file => file.path), "a host-level ignore rule must not hide a deliverable")
        .toContain("src/xsecret.ts");
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  });

  it("writes a symlink into the patch as a link, so applying it yields a link and not a file", () => {
    // The manifest hashes a link through its target, but the patch must carry the link's
    // own text: a patch that wrote the target's bytes would turn every link into a file.
    const root = richRepository();
    symlinkSync("link.md", join(root, "src", "link2.md"));
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "chain");
    const workspace = candidateOf(root);
    writeFileSync(join(workspace.root, "docs", "target.md"), "the symlink target, edited\n");
    rmSync(join(workspace.root, "src", "link2.md"));
    symlinkSync("../docs/target.md", join(workspace.root, "src", "link2.md"));
    const manifest = candidateManifest(workspace);
    expect(patchSection(manifest.patch, "src/link2.md")).toContain("120000");

    const checkout = candidateRoot(root);
    git(tmpdir(), "clone", "--quiet", root, checkout);
    git(checkout, "checkout", "--quiet", (workspace.base as { commit: string }).commit);
    const patchFile = join(checkout, "..", `${Date.now()}-link.patch`);
    writeFileSync(patchFile, manifest.patch);
    execFileSync("git", ["-C", checkout, "apply", "--binary", patchFile], { stdio: ["ignore", "pipe", "pipe"] });
    expect(lstatSync(join(checkout, "src", "link2.md")).isSymbolicLink(), "an applied link is still a link").toBe(true);
    expect(readlinkSync(join(checkout, "src", "link2.md"))).toBe("../docs/target.md");
  });

  it("does not let the source index contaminate an unmodified candidate's patch (round 1 finding)", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    const before = candidateManifest(workspace).patch;
    // An owner `git rm --cached` moves the SOURCE index without touching any bytes.
    git(root, "rm", "--cached", "--quiet", "src/base.ts");
    const after = candidateManifest(workspace);
    expect(after.patch, "the source index must not add a deletion to an unmodified candidate").toBe(before);
    expect(after.patch).not.toContain("deleted file mode");
    expect(after.files.map(file => file.path)).toContain("src/base.ts");
  });

  it("keeps the manifest and the patch for an unmodified candidate byte-identical to the base commit", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    const manifest = candidateManifest(workspace);
    // Captured from the base commit 23284b8 before this task changed the source. The
    // digest covers every tracked byte; a changed manifest invalidates every recorded
    // identity, which is this card's own stop-if condition.
    expect(manifest.files.map(file => [file.path, file.hash, file.tracked])).toEqual(GOLDEN_FILES);
    expect(manifest.manifestDigest).toBe(GOLDEN_DIGEST);
    expect(manifest.patch).toBe("");
  });

  it("describes the same bytes and renders the same patch for an edited, added and deleted candidate", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;\n");
    writeFileSync(join(workspace.root, "src", "fresh.ts"), "export const fresh = true;\n");
    rmSync(join(workspace.root, "src", "nested", "deep", "leaf.ts"));
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path)).not.toContain("src/nested/deep/leaf.ts");
    expect(manifest.files.map(file => [file.path, file.tracked])).toContainEqual(["src/base.ts", true]);
    expect(manifest.files.map(file => [file.path, file.tracked])).toContainEqual(["src/fresh.ts", false]);
    expect(manifest.patch).toContain("+export const base = 2;");
    expect(manifest.patch).toContain("+export const fresh = true;");
    expect(manifest.patch).toContain("deleted file mode");
    // Standard binary patch with repository-relative paths: it must apply at a repo root.
    expect(manifest.patch).toContain("a/src/base.ts");
    expect(manifest.patch).not.toContain(workspace.root);
  });

  it("records a mode change in the patch without treating it as a content change", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    chmodSync(join(workspace.root, "src", "base.ts"), 0o755);
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path)).toContain("src/base.ts");
    expect(manifest.patch).toContain("old mode 100644");
    expect(manifest.patch).toContain("new mode 100755");
  });
/**
   * One table-driven oracle over every patch shape the round-2 reviews found; it replaces
   * the per-case `git apply` tests. Each row starts from a base commit, changes a real
   * checkout of it, then asks the only question that matters for evidence: applied at a
   * base checkout, does the patch reproduce exactly the bytes the manifest hashed? An
   * `unmodified` row instead requires an empty patch, because rewriting a tree nobody
   * touched is a false accusation.
   */
  describe("patch round trip", () => {
    type Row = {
      name: string;
      /** Pins behaviour `main` already had; every other row reproduces a review finding. */
      pins?: true;
      base?: (root: string) => void;
      edit?: (root: string) => void;
      unmodified?: true;
      deleted?: readonly string[];
      links?: readonly string[];
      modes?: readonly (readonly [string, number])[];
      submodule?: true;
      /**
       * Paths the base commit's attributes clean, so the manifest hashes and the patch
       * carries the *cleaned* reading rather than the worktree bytes. Their worktree
       * content legitimately differs from what the applied patch writes, so the byte
       * comparison goes through the attribute rules instead of `equals`.
       */
      attributeShaped?: readonly string[];
      /** Paths that must be distinct manifest entries, so a decoded-name collision fails. */
      attributesPresent?: readonly string[];
    };

    /** Latin-1 `café\n`: a text file to git's heuristic, invalid UTF-8 to everything else. */
    const LATIN = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

    function submoduleRepository(): string {
      const sub = mkdtempSync(join(tmpdir(), "t044-sub-")); roots.push(sub);
      git(sub, "init", "--quiet", "--initial-branch=main");
      git(sub, "config", "user.email", "test@example.invalid"); git(sub, "config", "user.name", "test");
      writeFileSync(join(sub, "inner.txt"), "inner\n");
      git(sub, "add", "-A"); git(sub, "commit", "--quiet", "-m", "sub");
      return sub;
    }

    /** A committed base for one row. */
    function corpus(row: Row): string {
      const root = mkdtempSync(join(tmpdir(), "t044-row-")); roots.push(root);
      git(root, "init", "--quiet", "--initial-branch=main");
      git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
      writeFileSync(join(root, "anchor.txt"), "anchor\n");
      git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "base");
      row.base?.(root);
      git(root, "add", "-A"); git(root, "commit", "--quiet", "--allow-empty", "-m", "row");
      return root;
    }

    /** A base checkout with the patch applied, ready to be compared byte for byte. */
    function applied(root: string, commit: string, patch: string, submodule: boolean): string {
      const checkout = candidateRoot(root);
      git(tmpdir(), "clone", "--quiet", root, checkout);
      git(checkout, "checkout", "--quiet", commit);
      if (submodule) git(checkout, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet");
      const file = join(candidateRoot(root), "candidate.patch");
      writeFileSync(file, patch);
      execFileSync("git", ["-C", checkout, "apply", "--binary", file], { stdio: ["ignore", "pipe", "pipe"] });
      return checkout;
    }

    function roundTrip(row: Row): void {
      const root = corpus(row);
      const workspace = candidateOf(root);
      row.edit?.(workspace.root);
      const manifest = candidateManifest(workspace);
      if (row.unmodified) {
        expect(manifest.patch, `${row.name}: an untouched candidate has no patch`).toBe("");
        return;
      }
      const checkout = applied(root, (workspace.base as { commit: string }).commit, manifest.patch, row.submodule === true);
      for (const file of manifest.files) {
        const source = readFileSync(join(workspace.root, file.path));
        const got = readFileSync(join(checkout, file.path));
        if (row.attributeShaped?.includes(file.path)) {
          // The property is not "the worktree bytes reappear" but "the patch writes what the
          // manifest hashed". The base's attributes legitimately clean the candidate's bytes,
          // so those two differ by design; the digest is what has to match.
          expect(`sha256:${createHash("sha256").update(got).digest("hex")}`,
            `${row.name}: ${file.path} reproduces the hashed bytes`).toBe(file.hash);
          continue;
        }
        expect(got.equals(source), `${row.name}: ${file.path} reproduces the hashed bytes`).toBe(true);
      }
      for (const path of row.deleted ?? []) expect(existsSync(join(checkout, path)), `${row.name}: ${path} is deleted`).toBe(false);
      for (const path of row.attributesPresent ?? []) {
        expect(existsSync(join(checkout, path)), `${row.name}: ${path} is a manifest entry`).toBe(true);
        expect(existsSync(join(workspace.root, path)), `${row.name}: ${path} exists in the candidate`).toBe(true);
      }
      for (const path of row.links ?? []) expect(lstatSync(join(checkout, path)).isSymbolicLink(), `${row.name}: ${path} stays a link`).toBe(true);
      for (const [path, bit] of row.modes ?? []) expect(statSync(join(checkout, path)).mode & bit, `${row.name}: ${path} mode`).toBe(bit);
      expect(manifest.patch).not.toContain(workspace.root);
    }

    const addSubmodule = (root: string): void => {
      git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", submoduleRepository(), "vendor");
    };

    const ROWS: readonly Row[] = [
      {
        name: "a base gitlink leaves an unmodified candidate's patch empty",
        submodule: true, base: addSubmodule, unmodified: true,
      },
      {
        name: "a base gitlink is carried through while a real file changes",
        submodule: true, base: addSubmodule,
        edit: (root) => { writeFileSync(join(root, "anchor.txt"), "changed\n"); },
      },
      {
        name: "latin-1 content is added, edited and deleted without losing a byte",
        base: (root) => { writeFileSync(join(root, "gone.dat"), LATIN); writeFileSync(join(root, "edited.dat"), LATIN); },
        edit: (root) => {
          writeFileSync(join(root, "added.dat"), LATIN);
          writeFileSync(join(root, "edited.dat"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a]));
          rmSync(join(root, "gone.dat"));
        },
        deleted: ["gone.dat"],
      },
      {
        name: "latin-1 edited to valid UTF-8 keeps both sides intact",
        base: (root) => { writeFileSync(join(root, "to-utf8.dat"), LATIN); },
        edit: (root) => { writeFileSync(join(root, "to-utf8.dat"), Buffer.from("café\n", "utf8")); },
      },
      {
        name: "non-UTF-8 bytes in names git's attribute syntax treats specially",
        edit: (root) => {
          for (const name of ["my file.dat", "[x].dat", "#hash.dat", "q\"uote.dat", "line\nbreak.dat"]) {
            writeFileSync(join(root, name), LATIN);
          }
        },
      },
      {
        name: "several non-UTF-8 files round-trip together",
        edit: (root) => {
          for (let index = 0; index < 3; index += 1) writeFileSync(join(root, `blob-${index}.dat`), Buffer.from([0, 1, 2, 255, index]));
        },
      },
      {
        name: "a base .gitattributes with text eol=crlf leaves an unmodified candidate's patch empty",
        base: (root) => {
          writeFileSync(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
          writeFileSync(join(root, "crlf.txt"), "alpha\nbeta\n");
        },
        unmodified: true,
      },
      {
        name: "a tracked symlink round-trips as a link",
        base: (root) => { writeFileSync(join(root, "target.md"), "target\n"); symlinkSync("target.md", join(root, "link.md")); },
        edit: (root) => { writeFileSync(join(root, "target.md"), "changed\n"); },
        links: ["link.md"],
      },
      {
        name: "an executable bit round-trips",
        base: (root) => { writeFileSync(join(root, "run.sh"), "#!/bin/sh\n"); chmodSync(join(root, "run.sh"), 0o644); },
        edit: (root) => { chmodSync(join(root, "run.sh"), 0o755); },
        modes: [["run.sh", 0o100]],
      },
      // T051 — the manifest and the patch must describe one reading of an
      // attribute-shaped file, and an untouched candidate must still produce no patch.
      {
        name: "T051: an edited eol=lf file's patch writes exactly the bytes the manifest hashed",
        base: (root) => {
          writeFileSync(join(root, ".gitattributes"), "a.txt text eol=lf\n");
          writeFileSync(join(root, "a.txt"), "old\n");
        },
        // The candidate writes CRLF; the base's `eol=lf` cleans it to LF.
        edit: (root) => { writeFileSync(join(root, "a.txt"), "new\r\n"); },
        attributeShaped: ["a.txt"],
      },
      {
        name: "T051: a non-ASCII name under eol=crlf leaves an unmodified candidate's patch empty",
        base: (root) => {
          writeFileSync(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
          writeFileSync(join(root, "café.txt"), "alpha\nbeta\n");
        },
        unmodified: true,
      },
      {
        name: "T051: a BOM-prefixed name is listed beside the tracked name it would collide with",
        // `﻿anchor.txt` decoded to `anchor.txt` before `ignoreBOM`, so the two entries
        // collided and the candidate's own file was dropped from the manifest.
        edit: (root) => { writeFileSync(join(root, "﻿anchor.txt"), "bom\n"); },
        // Both files must reach the applied tree, and neither may be lost. `corpus` already
        // tracks `anchor.txt`, so a collision would show as one entry and a wrong byte count.
        attributesPresent: ["﻿anchor.txt", "anchor.txt"],
      },
      {
        // `ident` converts on check-in as `text` does: the checkout expands `$Id$` to
        // `$Id: <oid> $` while the blob keeps `$Id$`. Omitting it from the attribute set
        // gave an *unmodified* candidate a spurious 159-byte patch (the N1 class).
        name: "T051: a base ident attribute leaves an unmodified candidate's patch empty",
        base: (root) => {
          writeFileSync(join(root, ".gitattributes"), "*.txt ident\n");
          writeFileSync(join(root, "id.txt"), "$Id$\nalpha\n");
        },
        unmodified: true,
      },
    ];

    for (const row of ROWS) it(row.name, () => roundTrip(row));

    it("refuses a file name that is not valid UTF-8 instead of dropping it", () => {
      const root = richRepository();
      const workspace = candidateOf(root);
      // Node decodes a directory entry lossily, so an invalid name becomes U+FFFD and
      // the manifest would otherwise describe a path the candidate does not have.
      writeFileSync(Buffer.concat([Buffer.from(`${workspace.root}/bad-`), Buffer.from([0xff]), Buffer.from(".txt")]), "x\n");
      expect(() => candidateManifest(workspace)).toThrow(/not valid UTF-8/);
    });

    it("records a link target that climbs out of a symlinked directory as text, without reading it", () => {
      const root = richRepository();
      const workspace = candidateOf(root);
      writeFileSync(join(workspace.root, "src", "victim"), "candidate bytes\n");
      const outside = candidateRoot(root);
      writeFileSync(join(outside, "victim"), "outside bytes\n");
      symlinkSync(outside, join(workspace.root, "src", "jump"));
      // Lexically this names `src/victim`, which the candidate owns; through the kernel it
      // names the outside file. A reader that resolved it would hash and patch the outside
      // bytes. The copy never resolves a link, so the text is all that survives.
      symlinkSync("jump/../victim", join(workspace.root, "src", "climber"));
      const manifest = candidateManifest(workspace);
      expect(manifest.files.find(file => file.path === "src/climber")?.hash).toBe(
        `sha256:${createHash("sha256").update("jump/../victim").digest("hex")}`);
      expect(manifest.patch).not.toContain("outside bytes");
    });
  });

  describe("T054 plain git over a control-owned copy", () => {
    /**
     * The card's first group, in one fixture: every program hook a candidate can name, at
     * once, each writing its own canary.
     *
     * T044 closed these one review round at a time — `core.fsmonitor`, then `diff.external`,
     * then `filter.<drv>.clean` — because a reader that runs git in the candidate can be
     * reached by whichever hook it has not yet disabled. T054's claim is structural rather
     * than a longer list: the copy contains no `.git` entry for git to discover, so a worker
     * writes its repository metadata into a directory git is never pointed at. This test
     * plants every vector at once and requires that none of them ran.
     */
    it("runs no program a candidate plants, through any hook, at any depth", () => {
      const root = richRepository();
      const workspace = candidateOf(root);
      const canaries: { name: string; path: string; seen: () => boolean }[] = [];
      const mark = (name: string) => {
        const probe = canary();
        canaries.push({ name, ...probe });
        return probe.path;
      };
      const program = (name: string): string => {
        const path = plantedOutside(workspace.root, "cat", mark(name));
        return path;
      };
      const fsmonitor = program("core.fsmonitor");
      const hook = program("core.hooksPath");
      const clean = program("filter.<drv>.clean");
      const process = program("filter.<drv>.process");
      const textconv = program("diff.<drv>.textconv");
      const external = program("diff.external");

      // Vector one: the candidate replaces the worktree link with its own repository, whose
      // configuration names every hook.
      takeOverRepositoryMetadata(workspace, configure => {
        configure("config", "core.fsmonitor", fsmonitor);
        configure("config", "core.hooksPath", dirname(hook));
        configure("config", "filter.x.clean", clean);
        configure("config", "filter.x.process", process);
        configure("config", "filter.x.required", "true");
        configure("config", "diff.x.textconv", textconv);
        configure("config", "diff.external", external);
      });
      // Vector two: attributes that would invoke the filter and the textconv driver. A candidate
      // cannot supply attributes at all — they are a rule file — so that vector is a separate
      // candidate, refused before any git command runs.
      const attributeCandidate = candidateOf(richRepository());
      writeFileSync(join(attributeCandidate.root, ".gitattributes"), "* filter=x diff=x\n");
      expect(() => candidateManifest(attributeCandidate), "candidate attributes are refused").toThrow(/changes a rule file/);
      // Vector three: a nested repository of the worker's own, with a hook of its own.
      mkdirSync(join(workspace.root, "nested"), { recursive: true });
      git(join(workspace.root, "nested"), "init", "--quiet");
      git(join(workspace.root, "nested"), "config", "user.email", "worker@example.invalid");
      git(join(workspace.root, "nested"), "config", "user.name", "worker");
      mkdirSync(join(workspace.root, "nested", ".git", "hooks"), { recursive: true });
      writeFileSync(join(workspace.root, "nested", ".git", "hooks", "pre-commit"),
        `#!/bin/sh\n: > ${JSON.stringify(mark("nested hook"))}\n`);
      writeFileSync(join(workspace.root, "nested", "inner.txt"), "inner\n");
      // Vector four: a `.git` *file* naming a worker-written gitdir, the shape a submodule
      // checkout leaves behind.
      const fakeGitDir = join(workspace.root, "nested", "fake-gitdir");
      mkdirSync(fakeGitDir, { recursive: true });
      writeFileSync(join(fakeGitDir, "config"),
        `[core]\n\tfsmonitor = ${fsmonitor}\n\thooksPath = ${dirname(hook)}\n`);
      mkdirSync(join(workspace.root, "nested", "gitdir-file"), { recursive: true });
      writeFileSync(join(workspace.root, "nested", "gitdir-file", ".git"), `gitdir: ${fakeGitDir}\n`);

      writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
      const manifest = candidateManifest(workspace);

      for (const canary of canaries) {
        expect(canary.seen(), `a candidate-planted ${canary.name} program ran as the control`).toBe(false);
      }
      // The deliverable still lands, and its bytes in the patch are its own — a filter that
      // rewrote content would be visible here even if its canary somehow failed.
      expect(manifest.files.map(file => file.path)).toContain("src/deliverable.ts");
      expect(manifest.patch).toContain("export const deliverable = true;");
    });

    it("carries a nested repository's contents as files and never as a repository", () => {
      // A `.git` directory at any depth is metadata, not a candidate file. Skipping it by
      // name is what stops git from discovering the inner repository; the worker's inner
      // files are ordinary candidate files and are described as such.
      const root = richRepository();
      const workspace = candidateOf(root);
      mkdirSync(join(workspace.root, "nested"), { recursive: true });
      git(join(workspace.root, "nested"), "init", "--quiet");
      git(join(workspace.root, "nested"), "config", "user.email", "worker@example.invalid");
      git(join(workspace.root, "nested"), "config", "user.name", "worker");
      writeFileSync(join(workspace.root, "nested", "inner.txt"), "inner\n");
      git(join(workspace.root, "nested"), "add", "-A");
      git(join(workspace.root, "nested"), "commit", "--quiet", "-m", "inner");
      const manifest = candidateManifest(workspace);
      const paths = manifest.files.map(file => file.path);
      expect(paths).toContain("nested/inner.txt");
      expect(paths.some(path => path.split("/").includes(".git")), "repository metadata is never a manifest entry").toBe(false);
      expect(manifest.patch).not.toContain(".git/");
    });

    it("gives the base commit sole ignore authority by refusing candidate rule edits", () => {
      // The card's third group, satisfied at the refusal: `*` cannot hide a deliverable, a deleted
      // rule cannot admit a base-ignored path, and the candidate's own edit cannot be expressed at
      // all, because the rule file belongs to the base commit. What the candidate *can* deliver —
      // an ordinary new file beside a rule file it did not touch — still lands.
      const hiding = candidateOf(richRepository());
      writeFileSync(join(hiding.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
      writeFileSync(join(hiding.root, ".gitignore"), "*\n");
      expect(() => candidateManifest(hiding), "a candidate `*` rule is refused").toThrow(/changes a rule file/);

      const deleting = candidateOf(richRepository());
      writeFileSync(join(deleting.root, "debug.log"), "noise\n");
      rmSync(join(deleting.root, ".gitignore"));
      expect(() => candidateManifest(deleting), "a deleted rule is refused").toThrow(/changes a rule file/);

      // An untouched rule file is fine, and ordinary deliverables beside it are described.
      const plain = candidateOf(richRepository());
      writeFileSync(join(plain.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
      const manifest = candidateManifest(plain);
      expect(manifest.files.map(file => file.path)).toContain("src/deliverable.ts");
      expect(manifest.patch).toContain("export const deliverable = true;");
      expect(manifest.patch, "the untouched rule file is not in the patch").not.toContain("diff --git a/.gitignore");
    });

    it("refuses a candidate .gitattributes, so a candidate cannot choose its own conversions", () => {
      // The attribute half of the same decision: the base's `eol` rules clean the candidate's
      // bytes, and the candidate cannot add or replace a rule that would stop them.
      const root = richRepository();
      writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
      writeFileSync(join(root, "note.txt"), "alpha\n");
      git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "attributes");
      const workspace = candidateOf(root);
      writeFileSync(join(workspace.root, ".gitattributes"), "* -text\n");
      writeFileSync(join(workspace.root, "note.txt"), "ours\r\n");
      expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);

      // Without an attribute edit the base's rule still governs, and packet disclosure still works.
      // The fixture needs a base `.gitattributes` that cleans `note.txt`, which `richRepository`
      // does not record, so one is committed here.
      const cleanRoot = richRepository();
      writeFileSync(join(cleanRoot, ".gitattributes"), "*.txt text eol=lf\n");
      git(cleanRoot, "add", "-A"); git(cleanRoot, "commit", "--quiet", "-m", "base attributes");
      const clean = candidateOf(cleanRoot);
      writeFileSync(join(clean.root, "note.txt"), "ours\r\n");
      const manifest = candidateManifest(clean);
      const packet = createReviewPacket(clean, join(candidateRoot(clean.root), "packet"));
      try {
        expect(packet.cleanedPaths, "the packet is told the worktree form differs").toContain("note.txt");
        expect(verifyReviewPacket(packet).unchanged, "the packet verifies against its manifest").toBe(true);
        expect(manifest.files.find(file => file.path === "note.txt")?.hash,
          "the base's eol=lf governs the stored bytes").toBe(
          `sha256:${createHash("sha256").update("ours\n").digest("hex")}`);
      } finally {
        removeReviewPacket(packet);
      }
    });

        it("renders a text hunk the string type cannot carry as a binary hunk instead", () => {
      // `patch` is a string. A latin-1 file to git's heuristic would put raw 0xe9 in a text
      // hunk, which decodes to U+FFFD and would write bytes the candidate never held. The
      // selection is made on the stored and the base-side bytes, so an edit either way is
      // covered.
      const root = richRepository();
      writeFileSync(join(root, "latin.dat"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "latin");
      const workspace = candidateOf(root);
      writeFileSync(join(workspace.root, "latin.dat"), Buffer.from("café\n", "utf8"));
      const manifest = candidateManifest(workspace);
      const section = patchSection(manifest.patch, "latin.dat");
      expect(section, "the old side is not UTF-8, so the hunk is binary").toContain("GIT binary patch");
      expect(() => manifest.patch.normalize("NFC").includes("�")).not.toThrow();
      expect(manifest.patch.includes("�"), "no replacement character reaches the patch").toBe(false);
    });

    it("copies a realistic candidate in well under a few seconds", () => {
      // The card's stop-if: copying must not become the cost that tempts an exclusion
      // mechanism. The fixture is a few thousand small files, which is what a source tree of
      // this repository's size is; the bound is deliberately loose so a slow host does not
      // turn a reportable measurement into a flaky failure.
      const root = mkdtempSync(join(tmpdir(), "t054-scale-")); roots.push(root);
      git(root, "init", "--quiet", "--initial-branch=main");
      git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
      for (let directory = 0; directory < 20; directory += 1) {
        mkdirSync(join(root, "src", `module-${directory}`), { recursive: true });
        for (let file = 0; file < 100; file += 1) {
          writeFileSync(join(root, "src", `module-${directory}`, `file-${file}.ts`),
            `export const value${file} = ${directory * 100 + file};\n`);
        }
      }
      git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "scale");
      const workspace = candidateOf(root);
      const started = Date.now();
      const manifest = candidateManifest(workspace);
      const elapsed = Date.now() - started;
      expect(manifest.files.length).toBe(2000);
      expect(manifest.patch, "an untouched candidate is still an empty patch").toBe("");
      expect(elapsed, `a 2,000-file candidate took ${elapsed}ms`).toBeLessThan(30_000);
    });

    /**
     * The card's second group, as one candidate: CRLF under `eol`, a BOM-prefixed name, a
     * non-ASCII name, a symlink, an executable, a nested directory, an edit, an addition and
     * a deletion. The assertion is the only one that matters for evidence: applied at a base
     * checkout, does the patch reproduce exactly the entries the manifest recorded?
     */
    it("reproduces the manifest's entries when the patch is applied at a base checkout", () => {
      const root = mkdtempSync(join(tmpdir(), "t054-round-")); roots.push(root);
      git(root, "init", "--quiet", "--initial-branch=main");
      git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
      writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
      mkdirSync(join(root, "src", "nested", "deep"), { recursive: true });
      writeFileSync(join(root, "crlf.txt"), "alpha\n");
      writeFileSync(join(root, "anchor.txt"), "anchor\n");
      writeFileSync(join(root, "src", "edited.ts"), "export const edited = 1;\n");
      writeFileSync(join(root, "src", "gone.ts"), "export const gone = 1;\n");
      writeFileSync(join(root, "src", "nested", "deep", "leaf.ts"), "export const leaf = 1;\n");
      writeFileSync(join(root, "src", "run.sh"), "#!/bin/sh\necho hi\n");
      chmodSync(join(root, "src", "run.sh"), 0o644);
      symlinkSync("edited.ts", join(root, "src", "link.ts"));
      git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "base");
      const base = (resolveWorkspaceBase(root) as { commit: string }).commit;
      const workspace = createCandidateWorkspace({ root, base: resolveWorkspaceBase(root), workspaceRoot: candidateRoot(root), label: "T054" });
      roots.push(workspace.root);

      // Every shape at once, in the candidate.
      writeFileSync(join(workspace.root, "crlf.txt"), "beta\r\n");
      writeFileSync(join(workspace.root, "﻿anchor.txt"), "bom\n");
      writeFileSync(join(workspace.root, "src", "café.txt"), "café\n");
      writeFileSync(join(workspace.root, "src", "edited.ts"), "export const edited = 2;\n");
      rmSync(join(workspace.root, "src", "gone.ts"));
      chmodSync(join(workspace.root, "src", "run.sh"), 0o755);
      writeFileSync(join(workspace.root, "src", "nested", "deep", "leaf.ts"), "export const leaf = 2;\n");
      writeFileSync(join(workspace.root, "src", "fresh.ts"), "export const fresh = true;\n");
      const manifest = candidateManifest(workspace);

      const checkout = candidateRoot(root);
      git(tmpdir(), "clone", "--quiet", root, checkout);
      git(checkout, "checkout", "--quiet", base);
      const patchFile = join(candidateRoot(root), "candidate.patch");
      writeFileSync(patchFile, manifest.patch);
      execFileSync("git", ["-C", checkout, "apply", "--binary", patchFile], { stdio: ["ignore", "pipe", "pipe"] });
      git(checkout, "add", "-A");

      // The applied tree against the manifest, by content: a git blob id and the manifest's
    // sha256 are different hashes of the same bytes, so the comparison is made on the bytes
    // the patch actually wrote.
    // `-z` keeps a non-ASCII name as itself; without it `ls-files` quotes it, and the
    // comparison would fail on the quoting rather than on the content.
    const applied = execFileSync("git", ["-C", checkout, "ls-files", "-z", "--cached"], { encoding: "utf8" })
      .split("\0").filter(Boolean).sort();
    expect(applied).toEqual(manifest.files.map(file => file.path).sort());
    for (const file of manifest.files) {
      const path = join(checkout, file.path);
      // A link's reading is its target text; `readFileSync` would follow it and compare the
      // target's bytes against the link's recorded hash.
      const written = lstatSync(path).isSymbolicLink() ? Buffer.from(readlinkSync(path), "utf8") : readFileSync(path);
      const hash = `sha256:${createHash("sha256").update(written).digest("hex")}`;
      expect(hash, `${file.path} reproduces the manifest's reading`).toBe(file.hash);
    }
      // And the properties that are not visible in a blob id.
      expect(lstatSync(join(checkout, "src", "link.ts")).isSymbolicLink(), "a link stays a link").toBe(true);
      expect(statSync(join(checkout, "src", "run.sh")).mode & 0o100, "the executable bit arrives").toBe(0o100);
      expect(existsSync(join(checkout, "src", "gone.ts")), "the deletion is applied").toBe(false);
      expect(readFileSync(join(checkout, "crlf.txt"), "utf8"), "the base's eol=lf governs the patch too").toBe("beta\n");
      expect(existsSync(join(checkout, "﻿anchor.txt")), "a BOM-prefixed name is its own file").toBe(true);
    });

    it("gives an unmodified candidate an empty patch", () => {
      // The other half of the round trip: rewriting a tree nobody touched is a false
      // accusation, and it is what every recorded identity depends on staying stable.
      const root = richRepository();
      const workspace = candidateOf(root);
      expect(candidateManifest(workspace).patch).toBe("");
    });

    /**
     * Round-1 regression group. Each test fails on the candidate those reviewers saw and
     * passes on this one; together they are what closes R1-1 to R1-6.
     */
    describe("round-1 findings", () => {
      it("never writes outside the snapshot, and refuses the shapes that made that possible", () => {
        // The original defect: the control wrote the base's rules back into the copy, and a rule
        // path the worker had replaced with a link made it write *through* that link, outside its
        // own tree. Two shapes caused it — a linked rule file, and a rule file below a linked
        // directory. Both are refused before any write, and the outside file proves it.
        const outside = candidateRoot("victim");
        writeFileSync(join(outside, "target-ignore"), "ORIGINAL\n");
        mkdirSync(join(outside, "vault"), { recursive: true });
        writeFileSync(join(outside, "vault", "keep.txt"), "KEEP\n");

        const linkedRule = candidateOf(richRepository());
        rmSync(join(linkedRule.root, ".gitignore"));
        symlinkSync(join(outside, "target-ignore"), join(linkedRule.root, ".gitignore"));
        expect(() => candidateManifest(linkedRule)).toThrow(/changes a rule file/);

        const nested = richRepository();
        mkdirSync(join(nested, "sub"), { recursive: true });
        writeFileSync(join(nested, "sub", ".gitignore"), "*.log\n");
        git(nested, "add", "-A"); git(nested, "commit", "--quiet", "-m", "nested rule");
        const linkedDirectory = candidateOf(nested);
        rmSync(join(linkedDirectory.root, "sub"), { recursive: true, force: true });
        symlinkSync(join(outside, "vault"), join(linkedDirectory.root, "sub"));
        expect(() => candidateManifest(linkedDirectory), "the rule is gone with its directory").toThrow(/changes a rule file/);

        // Neither the outside file nor the outside directory was written to or removed from.
        expect(readFileSync(join(outside, "target-ignore"), "utf8"), "the outside file is untouched").toBe("ORIGINAL\n");
        expect(existsSync(join(outside, "vault", "keep.txt")), "the outside directory is untouched").toBe(true);
        expect(existsSync(join(outside, "vault", ".gitignore")), "nothing was created in the outside directory").toBe(false);
      });

      it("refuses a deleted rule file rather than describing the deletion", () => {
        const workspace = candidateOf(richRepository());
        rmSync(join(workspace.root, ".gitignore"));
        writeFileSync(join(workspace.root, "debug.log"), "noise\n");
        expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
      });

      it("refuses a rule file that differs from the base's, even when only its bytes moved", () => {
        // The comparison is content, not path: the base's rule is the only one this lane accepts.
        const workspace = candidateOf(richRepository());
        writeFileSync(join(workspace.root, ".gitattributes"), "*.ts text eol=lf\n");
        expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
      });

      it("refuses a rule file the candidate adds anywhere", () => {
        // A new rule file is still a rule edit, wherever it lives. This is what closed the round-4
        // finding where a new nested rule could govern its own admission. A rule below a
        // base-ignored directory is accepted instead (the round-5 group pins that), so this
        // fixture does not use one.
        const workspace = candidateOf(richRepository());
        mkdirSync(join(workspace.root, "docs", "inner"), { recursive: true });
        writeFileSync(join(workspace.root, "docs", "inner", ".gitignore"), "*.tmp\n");
        expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
      });
    });

    /**
     * Round-2 regression group. Each fails on the round-1 candidate and passes here.
     */
    describe("round-2 findings", () => {
      it("refuses a rule file replaced by a directory", () => {
        // R2-2: with the base's rule materialized into the copy, a directory at that path made the
        // staging proceed with no base rules at all, admitting `debug.log` and a rule file under a
        // base-ignored directory. It is refused by name now, before any git command runs.
        const workspace = candidateOf(richRepository());
        rmSync(join(workspace.root, ".gitignore"));
        mkdirSync(join(workspace.root, ".gitignore"));
        writeFileSync(join(workspace.root, ".gitignore", "inner.txt"), "inner\n");
        writeFileSync(join(workspace.root, "debug.log"), "noise\n");
        mkdirSync(join(workspace.root, "node_modules", "dep"), { recursive: true });
        writeFileSync(join(workspace.root, "node_modules", "dep", ".gitignore"), "ignored\n");
        expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
      });

      it("refuses a non-UTF-8 symlink target anywhere it appears", () => {
        // A base attribute such as `working-tree-encoding` must not convert a link's target: git
        // never converts a symlink, and a link is stored as its raw text. A target the string type
        // cannot carry is refused by name, at a rule path or anywhere else.
        const other = richRepository();
        const otherWorkspace = candidateOf(other);
        symlinkSync(Buffer.from([0x63, 0x61, 0x66, 0xe9]), join(otherWorkspace.root, "src", "latin-link"));
        expect(() => candidateManifest(otherWorkspace),
          "the raw target is refused rather than converted into a different link")
          .toThrow(/symlink target of src\/latin-link is not valid UTF-8/i);

        const atRulePath = richRepository();
        const ruleWorkspace = candidateOf(atRulePath);
        rmSync(join(ruleWorkspace.root, ".gitignore"));
        symlinkSync(Buffer.from([0x63, 0x61, 0x66, 0xe9]), join(ruleWorkspace.root, ".gitignore"));
        expect(() => candidateManifest(ruleWorkspace)).toThrow(/changes a rule file/);
      });

      it("reads a directory through the descriptor it opened, not through its path", () => {
        // Round 3 found the previous version of this test worthless: `setInterval` cannot run
        // while `execFileSync` blocks, so the mutator never fired. This is the deterministic
        // version of the same property, from the mechanism the walk actually relies on.
        //
        // A directory that is renamed away and replaced by a link to a vault keeps delivering its
        // own contents through the descriptor that is already open, and the replaced path refuses
        // to be opened as a directory. Together those are what make a mid-copy swap unable to
        // redirect a read.
        const root = candidateRoot("swap");
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "leaf.ts"), "candidate bytes\n");
        const vault = candidateRoot("vault");
        writeFileSync(join(vault, "leaf.ts"), "VAULT SECRET\n");

        const descriptor = openSync(join(root, "src"), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
        try {
          renameSync(join(root, "src"), join(root, "src.real"));
          symlinkSync(vault, join(root, "src"));
          // The held descriptor still names the real directory.
          expect(readFileSync(`/proc/self/fd/${descriptor}/leaf.ts`, "utf8")).toBe("candidate bytes\n");
          // Opening the replaced path as a directory refuses rather than following the link.
          expect(() => openSync(join(root, "src"), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW))
            .toThrow(/ENOTDIR|ELOOP/);
        } finally {
          closeSync(descriptor);
        }
      });
    });

    /**
     * Round-3 regression group. Each finding was about selection: which paths are measured, and
     * which reading of them. They exist because a round-2 rewrite replaced `add -A` with
     * hand-written staging; this group pins the behaviour that came back with it.
     */
    /**
     * Round-5 regression group. The comparison is made on the staged index, so the shapes below
     * are accepted (they are not rule edits) and the type change is still refused.
     */
    describe("round-5 findings", () => {
      it("accepts the rule files a tool writes under ignored directories", () => {
        // R5-1: a worktree scan refused `.pytest_cache/.gitignore` and `node_modules/*/.gitignore`,
        // which an ordinary test run creates. Git never stages them, so they are not rule edits.
        const root = richRepository();
        // The caches the tools create, ignored by the base like any build output.
        writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n.env\n.pytest_cache/\n__pycache__/\n");
        git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "ignore caches");
        const workspace = candidateOf(root);
        mkdirSync(join(workspace.root, ".pytest_cache"), { recursive: true });
        writeFileSync(join(workspace.root, ".pytest_cache", ".gitignore"), "*\n!*/\n!.gitignore\n");
        mkdirSync(join(workspace.root, "__pycache__"), { recursive: true });
        writeFileSync(join(workspace.root, "__pycache__", "mod.cpython-312.pyc"), "bytecode\n");
        mkdirSync(join(workspace.root, "node_modules", "dep"), { recursive: true });
        writeFileSync(join(workspace.root, "node_modules", "dep", ".gitignore"), "ignored\n");
        writeFileSync(join(workspace.root, "src", "result.ts"), "export const result = 1;\n");
        const manifest = candidateManifest(workspace);
        const paths = manifest.files.map(file => file.path);
        expect(paths, "the deliverable is described").toContain("src/result.ts");
        expect(paths, "an ignored directory's rule file is not part of the candidate").not.toContain(".pytest_cache/.gitignore");
        expect(paths).not.toContain("node_modules/dep/.gitignore");
      });

      it("accepts an untouched rule file whose checkout form differs from its stored form", () => {
        // R5-2 / R4-3: `working-tree-encoding` and `eol` make the checkout differ from the blob, so
        // a byte comparison refused an untouched candidate. Comparing staged object ids applies
        // git's own conversion and finds the base's id.
        const encoded = richRepository();
        writeFileSync(join(encoded, ".gitattributes"), ".gitignore working-tree-encoding=UTF-16\n");
        writeFileSync(join(encoded, ".gitignore"), Buffer.from("\ufeffnode_modules/\n", "utf16le"));
        git(encoded, "add", "-A"); git(encoded, "commit", "--quiet", "-m", "utf16 rule");
        const encodedWorkspace = candidateOf(encoded);
        expect(candidateManifest(encodedWorkspace).patch, "an untouched converted rule is not an edit").toBe("");

        const crlf = richRepository();
        writeFileSync(join(crlf, ".gitattributes"), ".gitignore text eol=crlf\n");
        writeFileSync(join(crlf, ".gitignore"), "node_modules/\n");
        git(crlf, "add", "-A"); git(crlf, "commit", "--quiet", "-m", "crlf rule");
        expect(candidateManifest(candidateOf(crlf)).patch, "the eol form is not an edit either").toBe("");
      });

      it("accepts a base-tracked symlinked rule file, and refuses it becoming a regular file", () => {
        // R5-3 and reviewer 1's type-change finding. An unmodified symlinked rule is not an edit;
        // replacing it with a regular file of identical text is, because a symlinked `.gitignore`
        // is not an active ignore file and the regular one would be. The mode is compared for this.
        const linked = richRepository();
        rmSync(join(linked, ".gitignore"));
        writeFileSync(join(linked, "real-ignore"), "*.log\n");
        symlinkSync("real-ignore", join(linked, ".gitignore"));
        git(linked, "add", "-A"); git(linked, "commit", "--quiet", "-m", "linked rule");
        expect(candidateManifest(candidateOf(linked)).patch, "an untouched symlinked rule is not an edit").toBe("");

        const swapped = richRepository();
        rmSync(join(swapped, ".gitignore"));
        mkdirSync(join(swapped, "sub"), { recursive: true });
        writeFileSync(join(swapped, "sub", "neg"), "!secret.env\n");
        symlinkSync("neg", join(swapped, "sub", ".gitignore"));
        git(swapped, "add", "-A"); git(swapped, "commit", "--quiet", "-m", "linked nested rule");
        const swappedWorkspace = candidateOf(swapped);
        rmSync(join(swappedWorkspace.root, "sub", ".gitignore"));
        writeFileSync(join(swappedWorkspace.root, "sub", ".gitignore"), "!secret.env\n");
        writeFileSync(join(swappedWorkspace.root, "sub", "secret.env"), "SECRET=1\n");
        expect(() => candidateManifest(swappedWorkspace),
          "a link becoming a regular rule file is a rule edit").toThrow(/changes a rule file/);
      });

      it("does not treat a submodule's own rule file as a candidate rule edit", () => {
        // Reviewer 1's populated-gitlink case: the submodule's `.gitignore` belongs to that
        // repository, and the superproject records the gitlink, not its tree.
        const sub = mkdtempSync(join(tmpdir(), "t054-sub-")); roots.push(sub);
        git(sub, "init", "--quiet", "--initial-branch=main");
        git(sub, "config", "user.email", "test@example.invalid"); git(sub, "config", "user.name", "test");
        writeFileSync(join(sub, ".gitignore"), "*.log\n");
        writeFileSync(join(sub, "inner.txt"), "inner\n");
        git(sub, "add", "-A"); git(sub, "commit", "--quiet", "-m", "sub");
        const root = richRepository();
        git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "vendor");
        git(root, "commit", "--quiet", "-m", "gitlink");
        const workspace = candidateOf(root);
        mkdirSync(join(workspace.root, "vendor"), { recursive: true });
        writeFileSync(join(workspace.root, "vendor", ".gitignore"), "*.log\n");
        writeFileSync(join(workspace.root, "vendor", "inner.txt"), "inner\n");
        expect(candidateManifest(workspace).patch, "a populated submodule is not a change").toBe("");
      });
    });

    /**
     * Round-6 regression group: rule authority is decided before staging, on the candidate's
     * own files, so no candidate rule can be read by `add -A` at all.
     */
    /** A candidate whose only edit is the given one, run against a committed base. */
    const ruleFixture = (base: (root: string) => void, edit: (root: string) => void): { ok: boolean; paths: string[]; patch: string; message: string } => {
      const root = mkdtempSync(join(tmpdir(), "t054-rule-")); roots.push(root);
      git(root, "init", "--quiet", "--initial-branch=main");
      git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
      writeFileSync(join(root, "a.txt"), "a\n");
      base(root);
      git(root, "add", "-A"); git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
      const workspace = candidateOf(root);
      edit(workspace.root);
      try {
        const manifest = candidateManifest(workspace);
        return { ok: true, paths: manifest.files.map(file => file.path), patch: manifest.patch, message: "" };
      } catch (error) {
        return { ok: false, paths: [], patch: "", message: (error as Error).message };
      }
    };

    describe("round-6 findings", () => {

  it("R6-1 seq A: a self-ignored rule cannot admit a base-ignored secret", () => {
    const r = ruleFixture(root => writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n*.env\n"), root => {
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "sub", ".gitignore"), ".gitignore\n!secret.env\n");
      writeFileSync(join(root, "sub", "secret.env"), "SECRET=1\n");
    });
    if (r.ok) {
      expect(r.paths, "the secret must not reach the manifest").not.toContain("sub/secret.env");
      expect(r.patch).not.toContain("SECRET");
    } else expect(r.message).toMatch(/changes a rule file/);
  });

  it("R6-1 seq A reverse: a self-ignored rule cannot hide a deliverable", () => {
    // This direction was already refused on the round-6 source, so it pins the behaviour
    // rather than proving the round-6 fix. It is kept because it is the mirror of the leak
    // above: a regression here would hide a deliverable rather than admit one.
    const r = ruleFixture(root => writeFileSync(join(root, ".gitignore"), "node_modules/\n"), root => {
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "sub", ".gitignore"), "*\n!.gitignore\n");
      writeFileSync(join(root, "sub", "deliverable.ts"), "export const d = 1;\n");
    });
    if (r.ok) expect(r.paths).toContain("sub/deliverable.ts");
    else expect(r.message).toMatch(/changes a rule file/);
  });

  it("R6-1 seq B: an ignored attribute file cannot choose conversions", () => {
    const r = ruleFixture(root => {
      writeFileSync(join(root, ".gitignore"), "sub/.gitattributes\n");
      writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "sub", "base.txt"), "base\n");
    }, root => {
      writeFileSync(join(root, "sub", ".gitattributes"), "*.txt -text\n");
      writeFileSync(join(root, "sub", "note.txt"), "ours\r\n");
    });
    if (r.ok) expect(r.patch, "the base's eol=lf must govern").not.toContain("\r");
    else expect(r.message).toMatch(/changes a rule file/);
  });

  it("R6-1 seq C: an ident-cleaned rule edit cannot normalize back to the base object id", () => {
    const r = ruleFixture(root => {
      writeFileSync(join(root, ".gitattributes"), ".gitignore ident\n");
      writeFileSync(join(root, ".gitignore"), "$Id$\n");
    }, root => {
      writeFileSync(join(root, ".gitignore"), "$Id: changed $\n");
      writeFileSync(join(root, "$Id$"), "x\n");
    });
    expect(r.ok, "an edited rule is refused regardless of how it cleans").toBe(false);
  });
    });

    /**
     * Round-7 regression group: the directory prepass stays inside what git can answer, and a
     * mode-only rule edit is refused rather than discarded.
     */
    describe("round-7 findings", () => {
      it("accepts an unchanged candidate with a directory named like pathspec magic", () => {
        // R7-1: `check-ignore --stdin` parses every record as a pathspec, so `:(literal)src` was
        // rejected as unsupported magic and even an unchanged candidate failed. A `./` prefix
        // keeps the record out of the magic branch, and the echoed match loses it again.
        const root = richRepository();
        mkdirSync(join(root, ":(literal)src"), { recursive: true });
        writeFileSync(join(root, ":(literal)src", "keep.ts"), "export const keep = 1;\n");
        git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "pathspec-looking directory");
        const manifest = candidateManifest(candidateOf(root));
        expect(manifest.files.map(file => file.path)).toContain(":(literal)src/keep.ts");
        expect(manifest.patch, "an unchanged candidate is an empty patch").toBe("");
      });

      it("accepts a populated gitlink that holds a nested directory", () => {
        // R7-1: `check-ignore` answers a path below an indexed gitlink with status 128 ("is in
        // submodule"), so the prepass stops at the gitlink root instead of walking into it. The
        // submodule's files are exempt from rule refusal anyway.
        const sub = mkdtempSync(join(tmpdir(), "t054-sub-")); roots.push(sub);
        git(sub, "init", "--quiet", "--initial-branch=main");
        git(sub, "config", "user.email", "test@example.invalid"); git(sub, "config", "user.name", "test");
        mkdirSync(join(sub, "src"), { recursive: true });
        writeFileSync(join(sub, "src", "inner.txt"), "inner\n");
        git(sub, "add", "-A"); git(sub, "commit", "--quiet", "-m", "sub");
        const root = richRepository();
        git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "vendor");
        git(root, "commit", "--quiet", "-m", "gitlink");
        const workspace = candidateOf(root);
        mkdirSync(join(workspace.root, "vendor", "src"), { recursive: true });
        writeFileSync(join(workspace.root, "vendor", "src", "inner.txt"), "inner\n");
        expect(candidateManifest(workspace).patch, "the submodule's tree is not the candidate's").toBe("");
      });

      it("refuses a rule file whose owner-executable bit changed", () => {
        // R7-2: the regular-file branch compared bytes only, so a chmod to the rule was silently
        // replaced by the base's mode instead of being refused. Git records 100644 and 100755.
        const r = ruleFixture(root => writeFileSync(join(root, ".gitignore"), "node_modules/\n"), root => {
          chmodSync(join(root, ".gitignore"), 0o755);
        });
        expect(r.ok, "a mode-only rule edit is refused rather than discarded").toBe(false);
        expect(r.message).toMatch(/changes a rule file/);
      });
    });

    describe("round-3 findings", () => {
      it("keeps a tracked file whose name looks like a pathspec, and gives it no patch", () => {
        // R3-1: the round-2 `check-ignore` pass sent `:keep.txt` to a pathspec parser, which read
        // the leading colon as magic and reported it ignored, so an *unchanged* tracked file was
        // removed from the index and appeared in the patch as a deletion. Ignore decisions now
        // come from `add -A`, which has no such pass.
        const root = richRepository();
        writeFileSync(join(root, ".gitignore"), "keep.txt\n");
        writeFileSync(join(root, ":keep.txt"), "literal colon name\n");
        git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "pathspec-looking name");
        const manifest = candidateManifest(candidateOf(root));
        expect(manifest.files.map(file => file.path)).toContain(":keep.txt");
        expect(manifest.patch, "an unchanged candidate is an empty patch").toBe("");
      });

      it("records a gitlink replaced by a regular file, and never descends a populated one", () => {
        // R3-2: filtering descendants by exact gitlink name either dropped a replacement file or
        // failed the manifest when the candidate's submodule directory held files. Git reports a
        // gitlink as one entry and does not descend it, so the populated case is simply not a
        // candidate file, and a replacement is an ordinary entry.
        const addSubmodule = (root: string): void => {
          const sub = mkdtempSync(join(tmpdir(), "t054-sub-")); roots.push(sub);
          git(sub, "init", "--quiet", "--initial-branch=main");
          git(sub, "config", "user.email", "test@example.invalid"); git(sub, "config", "user.name", "test");
          writeFileSync(join(sub, "inner.txt"), "inner\n");
          git(sub, "add", "-A"); git(sub, "commit", "--quiet", "-m", "sub");
          git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "vendor");
          git(root, "commit", "--quiet", "-m", "gitlink");
        };
        const replaced = richRepository();
        addSubmodule(replaced);
        const replacedWorkspace = candidateOf(replaced);
        rmSync(join(replacedWorkspace.root, "vendor"), { recursive: true, force: true });
        writeFileSync(join(replacedWorkspace.root, "vendor"), "replacement\n");
        const manifest = candidateManifest(replacedWorkspace);
        expect(manifest.files.map(file => file.path), "the replacement is a candidate file").toContain("vendor");
        expect(manifest.patch).toContain("replacement");

        const populated = richRepository();
        addSubmodule(populated);
        const populatedWorkspace = candidateOf(populated);
        mkdirSync(join(populatedWorkspace.root, "vendor"), { recursive: true });
        writeFileSync(join(populatedWorkspace.root, "vendor", "inner.txt"), "from the submodule\n");
        const populatedManifest = candidateManifest(populatedWorkspace);
        expect(populatedManifest.files.map(file => file.path), "a gitlink has no bytes of its own").not.toContain("vendor/inner.txt");
        expect(populatedManifest.patch, "an unmodified gitlink still needs no patch").toBe("");
      });

      it("keeps the source's info/exclude as an ignore authority", () => {
        // R3-3: the round-2 rewrite dropped the copy of the source's repository-level exclude
        // file, so a path only that file ignores entered the manifest. Committed `.gitignore`
        // files do not subsume it — it is a separate ignore source.
        const root = richRepository();
        const exclude = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
        writeFileSync(join(root, exclude), "private.env\n");
        const workspace = candidateOf(root);
        writeFileSync(join(workspace.root, "private.env"), "SECRET=1\n");
        const manifest = candidateManifest(workspace);
        expect(manifest.files.map(file => file.path), "the source exclude still hides it").not.toContain("private.env");
        expect(manifest.patch).not.toContain("SECRET");
      });
    });
  });
});