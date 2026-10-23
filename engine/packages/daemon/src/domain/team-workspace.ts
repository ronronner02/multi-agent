import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CandidateIdentity } from "./review-evidence.js";

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

/** The empty side of a `git diff --no-index` addition, on every platform git runs on. */
const emptyFilePath = (): string => (process.platform === "win32" ? "NUL" : "/dev/null");

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
  // Compare against the physical root: `resolved` comes from realpath, so a
  // root reached through a symlink would otherwise report every path as
  // escaping its own repository.
  const physicalRoot = realpathSync(root);
  // Realpath the deepest existing ancestor: a symlinked parent is followed
  // through the same containment rule as a symlinked leaf.
  let existing = resolve(physicalRoot, path);
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
  const escapes = relative(physicalRoot, resolved) === ".." || relative(physicalRoot, resolved).startsWith(`..${sep}`);
  if (escapes) throw new Error(`Candidate path escapes the repository through a symlink: ${path}`);
  if (suffix.length > 0) throw new Error(`Candidate path is missing: ${path}`);
  return resolved;
}

/**
 * Every file a candidate owns: tracked files from the index plus untracked,
 * non-ignored files. A manifest that omitted the untracked half would describe a
 * different candidate than the one a reviewer or an integration step receives.
 *
 * `root` need not itself be a repository: the snapshot lane copies the baseline
 * into a plain directory, where `git ls-files` exits 128. Git is therefore asked
 * only when asked to, and `tracked: false` says the caller is reading a copy whose
 * baseline already recorded provenance.
 */
/**
 * T044 — the tracked set of a candidate, taken from the repository the control trusts.
 *
 * A candidate is worker-writable by design, so `git` run *inside* it executes whatever
 * the worker put there: replacing the candidate's `.git` gitdir file with a repository
 * of its own and planting `core.fsmonitor` makes `git ls-files` run a worker-chosen
 * program as the control. That was reproduced before this was written.
 *
 * `git worktree add` writes a candidate's index as a copy of the base commit's, so the
 * source repository's own answer at that commit is the candidate's tracked set. Nothing
 * is executed from the candidate to obtain it.
 */
function trackedInCandidate(workspace: CandidateWorkspace): string[] {
  if (workspace.base.kind !== "commit") return [];
  return git(workspace.sourceRoot, ["ls-tree", "-r", "--name-only", "-z", workspace.base.commit])
    .split("\0").filter(Boolean);
}

/** Environment that keeps git from consulting configuration a caller could have written. */
function gitReadOnlyEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/**
 * T044 — the candidate's patch, rendered with the owner's gitdir and the candidate as a
 * plain work tree.
 *
 * `--git-dir <source>/.git --work-tree <candidate>` is what makes this safe: git reads
 * configuration, hooks and objects from the owner's repository and treats the candidate
 * as bytes. Pointing `-C` at the candidate instead would let a replaced `.git` gitdir
 * file or a planted `core.fsmonitor` run a worker-chosen program as the control.
 */
function gitWorkTreeDiff(workspace: CandidateWorkspace, commit: string): string {
  return execFileSync("git", ["-c", "core.fsmonitor=", "-c", "core.pager=cat",
    `--git-dir=${join(workspace.sourceRoot, ".git")}`, `--work-tree=${workspace.root}`,
    "diff", "--binary", commit, "--"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: gitReadOnlyEnv() });
}

/**
 * T044 — list a candidate's files from a tracked set supplied by the caller.
 *
 * Same contract as `listFiles`, but the tracked half is an input rather than a `git`
 * answer, so the candidate itself is only ever read. `.git` is excluded the way
 * `ls-files --others` excludes it: it is repository metadata, not a candidate file.
 */
function listCandidateFiles(root: string, trackedSet: ReadonlySet<string>): CandidateFile[] {
  const untracked = walkFiles(root).filter(path => path !== ".git" && !path.startsWith(".git/"));
  return [...new Set([...trackedSet, ...untracked])].sort().flatMap(path => {
    try {
      return [{ path, hash: sha256(readFileSync(candidatePath(root, path))), tracked: trackedSet.has(path) }];
    } catch (error) {
      if ((error as Error).message.startsWith("Candidate path is missing")) return [];
      throw error;
    }
  });
}

/**
 * T044 — is this directory a work tree of `sourceRoot`, and not something that merely
 * occupies the path?
 *
 * A candidate that `git worktree add` created holds a `.git` *file* naming its gitdir
 * under the source's `.git/worktrees/<name>`. That is read here as text and compared,
 * so no program is executed and nothing inside the directory is trusted beyond the one
 * path it names. A plain directory, a directory with no `.git`, or one naming somebody
 * else's gitdir is not this task's candidate.
 */
export function isCandidateWorkTree(candidateRoot: string, sourceRoot: string): boolean {
  try {
    const dotGit = join(candidateRoot, ".git");
    const stat = lstatSync(dotGit);
    // A real `.git` directory would be a repository of the candidate's own, which a
    // candidate never is.
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return false;
    const recorded = resolve(candidateRoot, match[1]!.trim());
    const worktrees = resolve(sourceRoot, ".git", "worktrees");
    const inside = relative(worktrees, recorded);
    return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
      && realpathSync(recorded) === recorded;
  } catch { return false; }
}

export function listFiles(root: string, options: { index: boolean }): CandidateFile[] {
  const tracked = options.index ? git(root, ["ls-files", "-z"]).split("\0").filter(Boolean) : [];
  const trackedSet = new Set(tracked);
  const untracked = options.index ? git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean) : walkFiles(root);
  return [...new Set([...tracked, ...untracked])].sort().flatMap(path => {
    // A candidate that deletes a tracked file keeps it in the index until it is
    // staged. The deletion is part of the patch; it is not a manifest entry, so
    // a missing file is dropped rather than failing the whole manifest.
    try {
      return [{ path, hash: sha256(readFileSync(candidatePath(root, path))), tracked: trackedSet.has(path) }];
    } catch (error) {
      if ((error as Error).message.startsWith("Candidate path is missing")) return [];
      throw error;
    }
  });
}

/**
 * Enumerate every entry under a packet root, separating regular files from
 * anything else. Symlinks and special files are reported rather than skipped:
 * silently omitting them would make a tampered packet verify as unchanged.
 */
function listAllEntries(root: string, prefix = ""): { files: string[]; nonRegular: string[] } {
  const files: string[] = [];
  const nonRegular: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // `Dirent` never needs a stat call: a symlink is reported as a symlink, not
    // as whatever it points at, which is exactly the distinction that matters.
    if (entry.isDirectory()) {
      const nested = listAllEntries(root, path);
      files.push(...nested.files);
      nonRegular.push(...nested.nonRegular);
    } else if (entry.isFile()) files.push(path);
    else nonRegular.push(path);
  }
  return { files, nonRegular };
}

/** Plain-directory enumeration for the snapshot lane, which has no index to ask. */
function walkFiles(root: string, prefix = ""): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) entries.push(...walkFiles(root, path));
    else if (entry.isFile()) entries.push(path);
  }
  return entries;
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
  // The index holds staged files even before the first commit, and a staged file
  // is part of the baseline whether or not history exists yet.
  if (head !== null) return { kind: "commit", commit: head, files: listFiles(repositoryRoot, { index: true }) };
  // No commit exists. KTD8 forbids manufacturing one to make the worktree lane
  // available, so the baseline is the hash of what the working tree holds now.
  const files = listFiles(repositoryRoot, { index: true });
  return { kind: "snapshot", baselineDigest: digestManifest(files), files };
}

/** HEAD, every ref, and the exact bytes of each dirty or untracked file a change would move. */
export function sourceFingerprint(root: string): SourceFingerprint {
  const head = gitOrNull(root, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim() ?? null;
  const refs = gitOrNull(root, ["for-each-ref", "--format=%(refname) %(objectname)"])?.trim() ?? "";
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
  const dirty = new Map<string, string>();
  for (const entry of status) {
    // Porcelain v1 spends two status columns before the path.
    const path = entry.slice(3);
    if (!path) continue;
    // Untracked files are fingerprinted too: an owner draft that changes while a
    // candidate is staged is exactly the mutation this proof exists to catch.
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
  if (input.base.kind === "snapshot") {
    // The snapshot is copied from the working tree, so the tree must still be the
    // baseline that was resolved. Otherwise the candidate would carry new bytes
    // while advertising the old baseline digest.
    const current = digestManifest(listFiles(sourceRoot, { index: true }));
    if (current !== input.base.baselineDigest) throw new Error("Snapshot baseline changed since it was resolved");
  }
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
  // T044: `--no-index` needs no repository, so it runs from a fixed directory with no
  // repository discovery and no configuration lookup — the candidate's `.git` is never
  // consulted, and only the one file's bytes are read.
  //
  // `--no-index` reports a difference by exiting 1, which is the normal case here, so the
  // exit status cannot stand in for "failed": read stdout directly.
  const result = spawnSync("git", ["-c", "core.fsmonitor=", "diff", "--binary", "--no-index", "--",
    emptyFilePath(), join(root, path)],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, cwd: dirname(root), env: gitReadOnlyEnv() });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git diff failed for ${path}: ${result.stderr}`);
  return (result.stdout ?? "").replace(/\n+$/, "");
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
    // T044: the tracked set comes from the source repository at the base commit, never
    // from `git ls-files` inside the candidate, and the patch is rendered with the
    // owner's gitdir and the candidate as a plain work tree.
    const tracked = trackedInCandidate(workspace);
    const files = listCandidateFiles(workspace.root, new Set(tracked));
    const trackedPatch = gitWorkTreeDiff(workspace, workspace.base.commit).replace(/\n+$/, "");
    const additions = files.filter(file => !file.tracked).map(file => untrackedPatch(workspace.root, file.path)).filter(Boolean);
    return {
      base: "commit",
      baseIdentifier: workspace.base.commit,
      files,
      manifestDigest: digestManifest(files),
      patch: [trackedPatch, ...additions].filter(Boolean).join("\n"),
    };
  }
  // The snapshot lane has no history to diff against; the hashed manifest IS its
  // identity, which is exactly what KTD8's "complete file manifest" allows. The
  // copy is a plain directory with no Git metadata, so it is walked directly.
  const files = listFiles(workspace.root, { index: false });
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
    unchanged: current.head === workspace.source.head && current.refsDigest === workspace.source.refsDigest
      && current.statusDigest === workspace.source.statusDigest && sameDirty,
    current,
  };
}

/**
 * T012 / KTD8 — the read-only review packet.
 *
 * A reviewer must see the exact candidate — every tracked and untracked file
 * with its bytes — and must not be able to change it (R17). The packet is
 * therefore a *copy*, written read-only, beside an identity that binds it to the
 * manifest digest the daemon holds. A reviewer reading a different tree than the
 * one the manifest names is exactly the false-independence case T012 exists to
 * prevent, so the two travel together.
 */
export interface ReviewPacket {
  root: string;
  identity: CandidateIdentity;
  /** The complete manifest, hashes included, that the packet must still match. */
  manifest: readonly CandidateFile[];
}

export function candidateIdentity(manifest: ReturnType<typeof candidateManifest>): CandidateIdentity {
  return { manifestDigest: manifest.manifestDigest, base: manifest.base, baseIdentifier: manifest.baseIdentifier,
    fileCount: manifest.files.length };
}

/**
 * Materialize the packet for a reviewer.
 *
 * The copy is made file by file rather than by copying the candidate directory,
 * because a candidate may carry `.git` metadata and a reviewer has no business
 * reading repository internals. `.git` is excluded explicitly rather than relied
 * on to be absent: the commit lane's `git ls-files` omits it, but the snapshot
 * lane walks a plain directory where nothing would have excluded it.
 *
 * Directories are sealed `0o555` after their contents land. That blocks unlinking
 * from inside them too, which is why `removeReviewPacket` restores write bits
 * before removal. Mode bits are a second layer, not the independence guarantee:
 * the real boundary is the reviewer running under a different OS identity with
 * the packet mounted read-only (KTD24's worker policy).
 */
export function createReviewPacket(workspace: CandidateWorkspace, destination: string): ReviewPacket {
  // One normalized path is used for the guard, the removal and every join below.
  // Mixing the caller's string with `join`/`dirname` output leaves the ancestor
  // walk unable to reach its own terminator (`./packet` never equals `packet`).
  const root = resolve(destination);
  // `rmSync` must never reach the tree the candidate or the source lives in. The
  // comparison resolves through the deepest existing ancestor, because an alias
  // directory or symlink pointing into either tree would otherwise pass a purely
  // lexical check and then be deleted.
  const physicalDest = physicalOfDeepest(root);
  for (const protectedRoot of [workspace.root, workspace.sourceRoot]) {
    const physical = realpathSync(protectedRoot);
    if (contains(physical, physicalDest) || contains(physicalDest, physical)) {
      throw new Error("Review packet destination overlaps the candidate or source tree");
    }
  }
  const manifest = candidateManifest(workspace);
  // Repository metadata is not part of a candidate. The commit lane's `git
  // ls-files` already omits it, but the snapshot lane walks a plain directory, so
  // a `.git` that appeared there would otherwise be copied and hashed into the
  // packet. Refusing keeps the packet identity equal to the durable candidate.
  const hidden = manifest.files.filter(file => file.path.split("/").includes(".git"));
  if (hidden.length) throw new Error(`Candidate contains repository metadata: ${hidden.map(file => file.path).join(", ")}`);
  const files = manifest.files;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const directories = new Set<string>([root]);
  for (const file of files) {
    const target = join(root, file.path);
    const parent = dirname(target);
    if (!directories.has(parent)) {
      mkdirSync(parent, { recursive: true });
      // Record each ancestor once so the final read-only pass reaches all of them.
      for (let current = parent; current !== root; current = dirname(current)) directories.add(current);
    }
    copyFileSync(candidatePath(workspace.root, file.path), target);
    // 0o444: the reviewer may read the bytes and nothing else.
    chmodSync(target, 0o444);
  }
  // The identity the packet claims is the candidate's own digest, so a packet and
  // the manifest it came from can be compared without trusting the caller.
  const identity = candidateIdentity(manifest);
  // Deepest first, so a parent is sealed only after its children exist.
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    chmodSync(directory, 0o555);
  }
  return { root, identity, manifest: files };
}

/** Resolve a path through its deepest existing ancestor, so an alias cannot hide a real target. */
function physicalOfDeepest(path: string): string {
  let existing = path;
  const suffix: string[] = [];
  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) return path;
      suffix.unshift(existing.slice(existing.lastIndexOf(sep) + 1));
      existing = parent;
    }
  }
  return resolve(realpathSync(existing), ...suffix);
}

/** Separator-aware containment; a bare prefix test would treat `/a/bc` as inside `/a/b`. */
function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * Re-read the packet and prove it still describes the claimed candidate.
 *
 * A packet that was edited after the fact (or a candidate that moved on) is not
 * evidence about the candidate, so the check is a hash of the packet's own bytes
 * against the manifest, not a trust in the directory's existence.
 */
export function verifyReviewPacket(packet: ReviewPacket): { unchanged: boolean; identity: CandidateIdentity; reason: string | null } {
  // Every entry type, not just directories and regular files: a symlink added to
  // the packet would otherwise contribute no path and no bytes, and so read as
  // "unchanged" while the reviewer's tree differs from the manifest.
  let present: string[];
  let nonRegular: string[];
  try {
    const listed = listAllEntries(packet.root);
    present = listed.files;
    nonRegular = listed.nonRegular;
  } catch (error) {
    return { unchanged: false, identity: packet.identity, reason: `Packet is unreadable: ${(error as Error).message}` };
  }
  if (nonRegular.length) {
    return { unchanged: false, identity: packet.identity,
      reason: `Packet holds non-regular entries: ${nonRegular.join(", ")}` };
  }
  const expected = packet.manifest.map(file => file.path);
  const missing = expected.filter(path => !present.includes(path));
  const extra = present.filter(path => !expected.includes(path));
  if (missing.length || extra.length) {
    return { unchanged: false, identity: packet.identity,
      reason: `Packet contents differ from its manifest (missing ${missing.length}, extra ${extra.length})` };
  }
  // The packet is a flat copy, so the manifest's `tracked` flag says where the
  // bytes came from, not whether this copy is a repository. Hash the actual bytes
  // and keep the flag: that reconstructs the digest the candidate had.
  try {
    const actual: CandidateFile[] = packet.manifest.map((file: CandidateFile) => ({
      path: file.path, tracked: file.tracked,
      hash: sha256(readFileSync(candidatePath(packet.root, file.path))),
    }));
    const unchanged = digestManifest(actual) === packet.identity.manifestDigest;
    return { unchanged, identity: { ...packet.identity, fileCount: actual.length },
      reason: unchanged ? null : "Packet bytes differ from the manifest digest" };
  } catch (error) {
    // A vanished or unreadable file is a mismatch, not an exception to swallow.
    return { unchanged: false, identity: packet.identity, reason: `Packet file is unreadable: ${(error as Error).message}` };
  }
}

/** Remove a packet, restoring write permission first so the tree can be unlinked. */
export function removeReviewPacket(packet: ReviewPacket): void {
  const restore = (root: string): void => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) { chmodSync(path, 0o755); restore(path); } else chmodSync(path, 0o644);
    }
  };
  if (lstatSync(packet.root, { throwIfNoEntry: false })) { chmodSync(packet.root, 0o755); restore(packet.root); }
  rmSync(packet.root, { recursive: true, force: true });
}

/** Release the candidate tree. The source worktree was never written, so nothing restores it. */
export function removeCandidateWorkspace(workspace: CandidateWorkspace): void {
  if (workspace.base.kind === "commit") {
    // Removal is a repository operation, so it runs against the source worktree.
    if (gitOrNull(workspace.sourceRoot, ["worktree", "remove", "--force", workspace.root]) !== null) return;
  }
  rmSync(workspace.root, { recursive: true, force: true });
}