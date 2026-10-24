import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { candidateManifest, candidatePath, createCandidateWorkspace, listFiles, removeCandidateWorkspace, resolveWorkspaceBase, sourceFingerprint, verifySourceUnchanged } from "../src/domain/team-workspace.js";

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
  const GOLDEN_DIGEST = "sha256:10c41a9d50b93449b6924184af35f5fe6a4d0b30edb9572c00ddac18ecfc1cd3";
  const GOLDEN_FILES: readonly (readonly [string, string, boolean])[] = [
    [".gitignore", "sha256:9a4e80f747a5791fbca62d7b04bdad73c6e37fdbf4398943bc85810a00facb64", true],
    ["README.md", "sha256:faa5b4816800b8cbe1595e5533fe36c53f396c0c26a3a876dd3e4085232348a1", true],
    ["docs/target.md", "sha256:7395d98c09c6c11bc827d489c2c974253508fabe2d41bf334b9e929664a887f6", true],
    ["run.sh", "sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba", true],
    ["src/base.ts", "sha256:234a49990ed0ca423d7e03f6831099806c117bfe29ed0add57df7415cd732271", true],
    ["src/binary.dat", "sha256:23e5b91bc67af30fad5933903277da95d30a3791f267d540796ed5d381252aa0", true],
    ["src/link.md", "sha256:7395d98c09c6c11bc827d489c2c974253508fabe2d41bf334b9e929664a887f6", true],
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

  it("runs no program the worker planted through filter.<drv>.clean, and the patch still matches the manifest (round 3 vector)", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    const mark = canary();
    takeOverRepositoryMetadata(workspace, configure => {
      // The round-3 reproduction: a filter that runs a program AND rewrites the content,
      // so the patch a reviewer reads would disagree with the bytes the manifest hashed.
      // The program is planted OUTSIDE the candidate on purpose: a script written inside
      // the tree is legitimately part of the candidate, and its own text would then also
      // appear in the patch, masking what this case is about.
      configure("config", "filter.evil.clean", plantedOutside(workspace.root, "printf 'SAFE CONTENT\\n'", mark.path));
    });
    writeFileSync(join(workspace.root, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const MALICIOUS = true;\n");
    const manifest = candidateManifest(workspace);
    expect(mark.seen(), "a worker-planted filter.<drv>.clean program ran as the control").toBe(false);
    // Evidence the worker cannot forge: the patch section for the deliverable is the
    // bytes the manifest hashed, not the filter's rewrite.
    const section = patchSection(manifest.patch, "src/deliverable.ts");
    expect(section).toContain("export const MALICIOUS = true;");
    expect(section).not.toContain("SAFE CONTENT");
    const deliverable = manifest.files.find(file => file.path === "src/deliverable.ts");
    expect(deliverable).toBeDefined();
  });

  it("keeps the base commit's ignore authority when the worker rewrites or deletes .gitignore (round 2 finding)", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    // A worker-owned secret and log that the base commit ignores, plus a real deliverable.
    writeFileSync(join(workspace.root, ".env"), "DATABASE_URL=postgres://user:pw@host/db\n");
    writeFileSync(join(workspace.root, "debug.log"), "noise\n");
    mkdirSync(join(workspace.root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(workspace.root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const deliverable = true;\n");

    // Direction one: deleting the candidate's .gitignore must not admit ignored files.
    rmSync(join(workspace.root, ".gitignore"));
    const deleting = candidateManifest(workspace);
    const deleted = deleting.files.map(file => file.path);
    expect(deleted).not.toContain(".env");
    expect(deleted).not.toContain("debug.log");
    expect(deleted).not.toContain("node_modules/dep/index.js");
    expect(deleting.patch).not.toContain("DATABASE_URL");
    expect(deleted).toContain("src/deliverable.ts");

    // Direction two: writing `*` must not hide the deliverable from the manifest.
    writeFileSync(join(workspace.root, ".gitignore"), "*\n");
    const hiding = candidateManifest(workspace);
    expect(hiding.files.map(file => file.path)).toContain("src/deliverable.ts");
    expect(hiding.patch).toContain("export const deliverable = true;");
  });

  it("refuses a symlink out of the candidate rather than smuggling ignored bytes (round 2 finding)", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    // A link whose target the base commit ignores. Following it would put the target's
    // bytes into the manifest, the digest, the patch and the reviewer packet, where an
    // innocuously named `innocent.md` would read as a candidate deliverable.
    writeFileSync(join(workspace.root, ".env"), "DATABASE_URL=postgres://user:pw@host/db\n");
    symlinkSync("../.env", join(workspace.root, "src", "innocent.md"));
    // The card requires a refusal here: the link's chain does not end at a manifest entry,
    // so nothing may describe it as a candidate file.
    expect(() => candidateManifest(workspace)).toThrow(/symlink does not name a manifest entry/);
  });

  it("refuses a tracked path whose ancestor the worker replaced with a link to a vault", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    // A worker turns a tracked directory into a link to a directory of secrets. Its
    // children still have tracked paths, so the manifest would read them if the link
    // were followed — and the base commit's fail-closed answer was an error here.
    writeFileSync(join(workspace.root, ".env"), "DATABASE_URL=postgres://user:pw@host/db\n");
    mkdirSync(join(workspace.root, "vault"), { recursive: true });
    writeFileSync(join(workspace.root, "vault", "leaf.ts"), "export const secret = 1;\n");
    rmSync(join(workspace.root, "src", "nested"), { recursive: true, force: true });
    symlinkSync("../vault", join(workspace.root, "src", "nested"));
    expect(() => candidateManifest(workspace)).toThrow(/reached through a symlink/);
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

  it("hashes a canonical tracked symlink through its in-root target, as the base commit does", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    const manifest = candidateManifest(workspace);
    const link = manifest.files.find(file => file.path === "src/link.md");
    const target = manifest.files.find(file => file.path === "docs/target.md");
    expect(link, "a tracked symlink is part of the candidate").toBeDefined();
    expect(link?.tracked).toBe(true);
    expect(link?.hash).toBe(target?.hash);
    expect(readFileSync(join(workspace.root, "src", "link.md"), "utf8")).toBe("the symlink target\n");
  });

  it("hashes a chain of tracked symlinks through its final target, and leaves the patch empty", () => {
    // `main` followed the whole chain, so `l2 -> l1 -> docs/target.md` contributed the
    // target's bytes under all three names. Dropping the link instead would change the
    // digest of an untouched candidate and make the patch delete the owner's link.
    const root = richRepository();
    symlinkSync("link.md", join(root, "src", "link2.md"));
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "chain");
    const workspace = candidateOf(root);
    const manifest = candidateManifest(workspace);
    const target = manifest.files.find(file => file.path === "docs/target.md");
    for (const path of ["src/link.md", "src/link2.md"]) {
      const link = manifest.files.find(file => file.path === path);
      expect(link, `${path} is part of the candidate`).toBeDefined();
      expect(link?.hash, `${path} hashes through the chain`).toBe(target?.hash);
    }
    expect(manifest.patch, "an unmodified candidate needs no patch").toBe("");
  });

  it("refuses a symlink that escapes, dangles, names a directory or names an ignored file", () => {
    const escaping = richRepository();
    const workspaceA = candidateOf(escaping);
    symlinkSync("/etc/hostname", join(workspaceA.root, "src", "esc.md"));
    expect(() => candidateManifest(workspaceA)).toThrow(/symlink does not name a manifest entry/);

    const dangling = richRepository();
    const workspaceB = candidateOf(dangling);
    symlinkSync("nowhere-at-all.md", join(workspaceB.root, "src", "gone.md"));
    expect(() => candidateManifest(workspaceB)).toThrow(/symlink does not name a manifest entry/);

    const toDirectory = richRepository();
    const workspaceC = candidateOf(toDirectory);
    symlinkSync("nested", join(workspaceC.root, "src", "dirlink"));
    expect(() => candidateManifest(workspaceC)).toThrow(/symlink does not name a manifest entry/);
  });

  it("refuses a tracked file the worker replaced with an escaping link instead of reporting a deletion", () => {
    // Without the refusal this shape is worse than a leak: the manifest drops the entry
    // and the patch presents the worker's own link as an ordinary deletion.
    const root = richRepository();
    const workspace = candidateOf(root);
    rmSync(join(workspace.root, "src", "base.ts"));
    symlinkSync("/etc/hostname", join(workspace.root, "src", "base.ts"));
    expect(() => candidateManifest(workspace)).toThrow(/symlink does not name a manifest entry/);
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

  it("applies the patch at a base checkout and reproduces the hashed bytes", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;\n");
    writeFileSync(join(workspace.root, "src", "fresh.ts"), "export const fresh = true;\n");
    writeFileSync(join(workspace.root, "src", "latin.ts"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    rmSync(join(workspace.root, "src", "nested", "deep", "leaf.ts"));
    chmodSync(join(workspace.root, "run.sh"), 0o644);
    const manifest = candidateManifest(workspace);

    const checkout = candidateRoot(root);
    git(tmpdir(), "clone", "--quiet", root, checkout);
    git(checkout, "checkout", "--quiet", (workspace.base as { commit: string }).commit);
    const patchFile = join(checkout, "..", `${Date.now()}-candidate.patch`);
    writeFileSync(patchFile, manifest.patch);
    execFileSync("git", ["-C", checkout, "apply", "--binary", patchFile], { stdio: ["ignore", "pipe", "pipe"] });

    // Every manifest entry is byte-identical to what the patch produced.
    for (const file of manifest.files) {
      const source = readFileSync(join(workspace.root, file.path));
      const applied = readFileSync(join(checkout, file.path));
      expect(applied.equals(source), `${file.path} survives the round trip`).toBe(true);
    }
    expect(existsSync(join(checkout, "src", "nested", "deep", "leaf.ts"))).toBe(false);
    // Repository-relative paths: the patch never names the host directory.
    expect(manifest.patch).not.toContain(workspace.root);
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
});