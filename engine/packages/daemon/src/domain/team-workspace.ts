import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * T011 / KTD8 — isolated candidate ownership.
 *
 * A task's changes live in its own candidate tree, never in the owner's
 * worktree. Where the repository has an owner-established base commit the
 * candidate is a detached worktree at that exact commit; where it is unborn the
 * candidate is a declared snapshot copy with a hashed baseline.
 *
 * Nothing here creates history. No commit, no merge, no branch, and no write to
 * the source worktree: integration is a later assembly step over a manifest this
 * module produces, so the owner's dirty files keep the hashes they had.
 */

export interface CandidateFile {
  /** Repository-relative path with forward separators. */
  path: string;
  /** sha256 of the file bytes. */
  hash: string;
  tracked: boolean;
}

export type WorkspaceBase =
  | { kind: "commit"; commit: string; files: readonly CandidateFile[] }
  | { kind: "snapshot"; baselineDigest: string; files: readonly CandidateFile[] };

export interface SourceFingerprint {
  /** `null` while the repository is unborn. */
  head: string | null;
  /** Digest of every ref the repository advertises; a commit or merge moves it. */
  refsDigest: string;
  /** sha256 of each dirty tracked file's current bytes. */
  dirtyHashes: Readonly<Record<string, string>>;
  statusDigest: string;
}

export interface CandidateWorkspace {
  root: string;
  sourceRoot: string;
  base: WorkspaceBase;
  /** Source state captured immediately before isolation, for later comparison. */
  source: SourceFingerprint;
}

const sha256 = (bytes: Buffer | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}

function gitOrNull(cwd: string, args: readonly string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * Resolve one repository-relative path to the file whose bytes a manifest
 * describes, refusing anything that leaves the repository.
 *
 * `..` segments are rejected before resolution, and a symlink is followed only
 * when its target stays inside the root: an escaping link would make an
 * "isolated" candidate depend on bytes the candidate does not own.
 */
export function candidatePath(root: string, path: string): string {
  if (isAbsolute(path) || path.split("/").includes("..")) throw new Error(`Candidate path escapes the repository: ${path}`);
  // Realpath the deepest existing ancestor: a symlinked parent is followed
  // through the same containment rule as a symlinked leaf.
  let existing = resolve(root, path);
  const suffix: string[] = [];
  let stats;
  while (true) {
    try {
      stats = lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      suffix.unshift(existing.slice(existing.lastIndexOf(sep) + 1));
      existing = dirname(existing);
    }
  }
  const resolved = resolve(realpathSync(existing), ...suffix);
  const escapes = relative(root, resolved) === ".." || relative(root, resolved).startsWith(`..${sep}`);
  if (escapes) throw new Error(`Candidate path escapes the repository through a symlink: ${path}`);
  if (suffix.length > 0) throw new Error(`Candidate path is missing: ${path}`);
  return resolved;
}

/**
 * Every file a candidate owns: tracked files from the index plus untracked,
 * non-ignored files. A manifest that omitted the untracked half would describe a
 * different candidate than the one a reviewer or an integration step receives.
 */
export function listFiles(root: string, trackedFromIndex: boolean): CandidateFile[] {
  const tracked = trackedFromIndex ? git(root, ["ls-files", "-z"]).split("\0").filter(Boolean) : [];
  const trackedSet = new Set(tracked);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort().map(path => ({
    path,
    hash: sha256(readFileSync(candidatePath(root, path))),
    tracked: trackedSet.has(path),
  }));
}

export function digestManifest(files: readonly CandidateFile[]): string {
  return sha256([...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(file => `${file.tracked ? "t" : "u"}:${file.path}:${file.hash}`)
    .join("\n"));
}

/** The owner-established base: a commit when one exists, otherwise the declared snapshot lane. */
export function resolveWorkspaceBase(root: string): WorkspaceBase {
  const repositoryRoot = realpathSync(root);
  const head = gitOrNull(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim() ?? null;
  if (head !== null) return { kind: "commit", commit: head, files: listFiles(repositoryRoot, true) };
  // No commit exists. KTD8 forbids manufacturing one to make the worktree lane
  // available, so the baseline is the hash of what the working tree holds now.
  const files = listFiles(repositoryRoot, false);
  return { kind: "snapshot", baselineDigest: digestManifest(files), files };
}

/** HEAD, every ref, and the exact bytes of each dirty file. Any commit or merge changes it. */
export function sourceFingerprint(root: string): SourceFingerprint {
  const head = gitOrNull(root, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim() ?? null;
  const refs = gitOrNull(root, ["for-each-ref", "--format=%(refname) %(objectname)"])?.trim() ?? "";
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
  const dirty = new Map<string, string>();
  for (const entry of status) {
    // Porcelain v1 spends two status columns before the path.
    const path = entry.slice(3);
    if (!path || entry.startsWith("??")) continue;
    try {
      const target = join(root, path);
      if (statSync(target).isFile()) dirty.set(path, sha256(readFileSync(target)));
    } catch {
      // A deleted or unreadable path has no bytes to preserve; the status entry
      // still contributes to statusDigest.
    }
  }
  return {
    head,
    refsDigest: sha256(refs),
    dirtyHashes: Object.fromEntries([...dirty].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
    statusDigest: sha256(status.join("\0")),
  };
}

/**
 * Materialize a candidate tree for one task.
 *
 * Commit-backed: a detached worktree at the base commit, so the task starts from
 * exactly the owner-approved revision and cannot move any ref.
 * Snapshot lane: a copy of the recorded baseline under the caller's tree.
 *
 * Either way the source worktree is read for the fingerprint and never written.
 */
export function createCandidateWorkspace(input: {
  root: string;
  base: WorkspaceBase;
  workspaceRoot: string;
  label: string;
}): CandidateWorkspace {
  const sourceRoot = realpathSync(input.root);
  const source = sourceFingerprint(sourceRoot);
  const baseHead = input.base.kind === "commit" ? input.base.commit : null;
  if (source.head !== baseHead) throw new Error("Workspace base does not match the repository's current state");
  mkdirSync(dirname(input.workspaceRoot), { recursive: true });
  if (input.base.kind === "commit") {
    git(sourceRoot, ["worktree", "add", "--detach", "--force", input.workspaceRoot, input.base.commit]);
    return { root: input.workspaceRoot, sourceRoot, base: input.base, source };
  }
  for (const file of input.base.files) {
    const destination = join(input.workspaceRoot, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(candidatePath(sourceRoot, file.path), destination, 1);
  }
  return { root: input.workspaceRoot, sourceRoot, base: input.base, source };
}

/** A patch that adds one untracked file, as `git diff` would render it once tracked. */
function untrackedPatch(root: string, path: string): string {
  // `--no-index` reports a difference by exiting 1, which is the normal case
  // here, so the exit status cannot stand in for "failed": read stdout directly.
  const result = spawnSync("git", ["-C", root, "diff", "--binary", "--no-index", "--", "/dev/null", path],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git diff failed for ${path}: ${result.stderr}`);
  return (result.stdout ?? "").replace(/\s+$/, "");
}

/**
 * The exact candidate: base identifier, every file it owns with its hash, a
 * complete manifest digest, and a patch against the base.
 *
 * Untracked files are listed in the manifest because they are part of the
 * candidate, and their additions are carried in the patch as well so a reader
 * that applies only diffs still lands on the same tree.
 */
export function candidateManifest(workspace: CandidateWorkspace): {
  base: WorkspaceBase["kind"];
  baseIdentifier: string;
  files: CandidateFile[];
  manifestDigest: string;
  patch: string;
} {
  if (workspace.base.kind === "commit") {
    const files = listFiles(workspace.root, true);
    const trackedPatch = git(workspace.root, ["diff", "--binary", workspace.base.commit, "--"]).replace(/\s+$/, "");
    const additions = files.filter(file => !file.tracked).map(file => untrackedPatch(workspace.root, file.path).replace(/\s+$/, "")).filter(Boolean);
    return {
      base: "commit",
      baseIdentifier: workspace.base.commit,
      files,
      manifestDigest: digestManifest(files),
      patch: [trackedPatch, ...additions].filter(Boolean).join("\n"),
    };
  }
  // The snapshot lane has no history to diff against; the hashed manifest IS its
  // identity, which is exactly what KTD8's "complete file manifest" allows.
  const files = listFiles(workspace.root, false);
  return { base: "snapshot", baseIdentifier: workspace.base.baselineDigest, files, manifestDigest: digestManifest(files), patch: "" };
}

/**
 * Proof that isolation had no side effect on the owner's tree: the source HEAD
 * and refs are where they were and every dirty file still hashes the same, so
 * no commit or merge was manufactured by staging a candidate.
 */
export function verifySourceUnchanged(workspace: CandidateWorkspace): { unchanged: boolean; current: SourceFingerprint } {
  const current = sourceFingerprint(workspace.sourceRoot);
  const sameDirty = Object.keys(workspace.source.dirtyHashes).length === Object.keys(current.dirtyHashes).length
    && Object.entries(workspace.source.dirtyHashes).every(([path, hash]) => current.dirtyHashes[path] === hash);
  return {
    unchanged: current.head === workspace.source.head && current.refsDigest === workspace.source.refsDigest && sameDirty,
    current,
  };
}

/** Release the candidate tree. The source worktree was never written, so nothing restores it. */
export function removeCandidateWorkspace(workspace: CandidateWorkspace): void {
  if (workspace.base.kind === "commit") {
    // Removal is a repository operation, so it runs against the source worktree.
    if (gitOrNull(workspace.sourceRoot, ["worktree", "remove", "--force", workspace.root]) !== null) return;
  }
  rmSync(workspace.root, { recursive: true, force: true });
}