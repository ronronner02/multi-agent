import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
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

/**
 * T044 — the commit lane computes the manifest without running git in the candidate.
 *
 * A candidate is worker-writable by design, so any git command that treats it as a
 * working directory, a work tree or a repository reads configuration the worker wrote.
 * Git has more program hooks than an argument can enumerate: T044's review rounds
 * closed `core.fsmonitor`, then `diff.external`, then `filter.<drv>.clean`, and each
 * one ran a worker-chosen program as the control. The same filter could also rewrite
 * content between hashing and diffing, so the patch a reviewer read could disagree
 * with the bytes the manifest recorded.
 *
 * The commit lane therefore stops asking git anything about the candidate:
 *
 * - the candidate's bytes are enumerated and read directly;
 * - the tracked set comes from the base commit in the source repository;
 * - the ignore rules are the ones the base commit recorded, plus the source's
 *   `info/exclude`, applied by git to a control-owned rules tree;
 * - the patch is rendered in a control-owned scratch object store, from the exact
 *   bytes the manifest hashed.
 *
 * Git still runs, but only against the source repository, the rules tree and the
 * scratch store. None of those is writable by the worker, so no hook is reachable.
 */

/** One entry of the base commit's tree: its git mode and the blob it names. */
interface BaseEntry {
  mode: string;
  objectId: string;
}

/**
 * Environment for every git call the commit lane makes.
 *
 * Ambient `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_*` and the discovery ceilings are
 * dropped rather than inherited: they can redirect git at a worker-writable path just as
 * a repository hook can, and the daemon's own environment is not this module's to trust.
 * Each caller then supplies only the location it means to use.
 */
function controlGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...extra };
}

/** The base commit's tree, as the source repository records it. */
function readBaseTree(sourceRoot: string, commit: string): Map<string, BaseEntry> {
  const output = controlGit(["ls-tree", "-r", "-z", "--full-tree", commit], sourceRoot);
  const entries = new Map<string, BaseEntry>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    // Only blobs are files. A gitlink (`160000`) names another repository's commit and
    // has no bytes here, so it is not a manifest entry — the same answer `ls-files`
    // gave, which also does not descend into a submodule.
    if (type !== "blob" || !mode || !objectId) continue;
    entries.set(record.slice(tab + 1), { mode, objectId });
  }
  return entries;
}

/**
 * Run git against the source repository with configuration the worker cannot write.
 * `-C` is fixed here so no caller can point it at a candidate by accident.
 */
function controlGit(args: readonly string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: controlGitEnv(extraEnv) });
}

/** Read one object's exact bytes from the source repository. */
function readBaseObject(sourceRoot: string, objectId: string): Buffer {
  return execFileSync("git", ["-C", sourceRoot, "cat-file", "blob", objectId],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: controlGitEnv() });
}

/**
 * A git directory whose ignore rules are the control's, not the candidate's.
 *
 * `check-ignore` resolves ignore rules against the work tree it is given and the
 * repository it is given, so pointing both at control-owned trees is what makes the
 * answer independent of the candidate. The base commit's `.gitignore` files are
 * materialized at their own paths; the source's `info/exclude` is copied as the
 * repository-level rules. A candidate that deletes its `.gitignore` therefore cannot
 * admit ignored owner files, and one that writes `*` cannot hide its deliverable.
 *
 * `--no-index` is required: the rules tree is not a checkout, so no rule can be
 * decided by the index. Without it git reports nothing for a path that is not staged.
 */
function controlIgnoreStore(sourceRoot: string, commit: string, base: Map<string, BaseEntry>, scratch: string):
  { gitDir: string; rulesRoot: string } {
  const gitDir = join(scratch, "ignore.git");
  const rulesRoot = join(scratch, "ignore-tree");
  mkdirSync(rulesRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", gitDir],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: controlGitEnv() });
  for (const [path, entry] of base) {
    if (path.split("/").pop() !== ".gitignore") continue;
    const destination = join(rulesRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readBaseObject(sourceRoot, entry.objectId));
  }
  // The source's repository-level exclude file is control-owned configuration: the
  // worker cannot write the source, so it is a legitimate authority the candidate has
  // no say in. A missing file simply contributes no rules.
  const excludePath = controlGit(["rev-parse", "--git-path", "info/exclude"], sourceRoot).trim();
  const physical = isAbsolute(excludePath) ? excludePath : join(sourceRoot, excludePath);
  if (lstatSync(physical, { throwIfNoEntry: false })?.isFile()) {
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), readFileSync(physical));
  }
  return { gitDir, rulesRoot };
}

/** The subset of `paths` the control's ignore rules exclude. */
function ignoredByControl(gitDir: string, rulesRoot: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  // `check-ignore --stdin -z` reports only the matches. It exits 1 when nothing
  // matched, which is an answer rather than a failure, so the status is read rather
  // than raised. A non-zero status with no output means no path was ignored.
  let output: string;
  try {
    output = execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${rulesRoot}`,
      "check-ignore", "--stdin", "-z", "--no-index"],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000, env: controlGitEnv(),
      input: paths.map(path => `${path}\0`).join("") });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (failure.status !== 1) throw error;
    output = failure.stdout ?? "";
  }
  return new Set(output.split("\0").filter(Boolean));
}

/**
 * Every path under `root` that the candidate holds and the base commit does not, as the
 * `ls-files --others` answer described it: repository metadata and directories reached
 * through a symlink are not descended, and a symlink is a leaf.
 *
 * `walkFiles` cannot be used here. It descends a symlinked directory and follows it out
 * of the tree, and it lists `.git`, so it would both leak bytes and enumerate metadata.
 */
function untrackedCandidates(root: string, tracked: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (relativeDir: string): void => {
    for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true })) {
      const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      // Repository metadata is not a candidate file at any depth.
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink()) {
        // A link is a leaf. A link to a directory is exactly the smuggling case: walking
        // through it would read bytes from outside the candidate.
        if (!tracked.has(path)) found.push(path);
        continue;
      }
      if (entry.isDirectory()) { visit(path); continue; }
      if (entry.isFile() && !tracked.has(path)) found.push(path);
    }
  };
  visit("");
  return found.sort();
}

/**
 * The bytes and git mode of one candidate path, without leaving the candidate.
 *
 * A symlink is never followed to read bytes from outside the tree. Its *link text* is
 * what git stores and what the patch must carry, so that is what this returns; the
 * manifest decides separately whether the link counts as an entry (`resolveLinkTarget`).
 * A path reached through a symlinked ancestor is refused rather than resolved: the walk
 * skips symlinked directories, so such a path can only be a tracked one the worker
 * replaced with a link, which would otherwise read an ignored vault's bytes.
 */
function readCandidateEntry(root: string, path: string): { mode: string; bytes: Buffer; linkText: string | null } {
  const segments = path.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Candidate path is reached through a symlink: ${path}`);
  }
  const full = join(root, path);
  if (lstatSync(full).isSymbolicLink()) return { mode: "120000", bytes: Buffer.alloc(0), linkText: readlinkSync(full) };
  const stats = lstatSync(full);
  return { mode: stats.mode & 0o111 ? "100755" : "100644", bytes: readFileSync(full), linkText: null };
}

/**
 * The in-root regular file a candidate symlink names, or `null`.
 *
 * A link counts only when its target stays inside the candidate and is a regular file.
 * Following one that leaves the tree is exactly how an ignored owner secret would reach
 * the manifest, the digest and the reviewer packet under an innocuous name.
 */
function resolveLinkTarget(root: string, path: string, linkText: string): string | null {
  if (isAbsolute(linkText)) return null;
  const target = relative(resolve(root), resolve(root, dirname(path), linkText));
  if (target === "" || target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) return null;
  return target.split(sep).join("/");
}

/**
 * Render the patch between the base commit and a tree built from the manifest's bytes.
 *
 * The tree is written to a control-owned scratch object store that borrows the source's
 * objects read-only. The bytes written are the ones `candidateManifest` already hashed,
 * so a filter cannot make the patch disagree with the manifest, and git never reads a
 * candidate path — only the scratch store and the source repository.
 */
function renderPatch(
  sourceRoot: string,
  commit: string,
  entries: readonly { path: string; mode: string; bytes: Buffer }[],
  scratch: string,
): string {
  const store = join(scratch, "patch.git");
  execFileSync("git", ["init", "--quiet", "--bare", store],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: controlGitEnv() });
  // The scratch store borrows the source's objects read-only, so the base commit and
  // every blob the patch quotes resolve without copying a repository.
  const objectPath = controlGit(["rev-parse", "--git-path", "objects"], sourceRoot).trim();
  const sourceObjects = realpathSync(isAbsolute(objectPath) ? objectPath : join(sourceRoot, objectPath));
  const env = controlGitEnv({
    GIT_DIR: store,
    GIT_OBJECT_DIRECTORY: join(realpathSync(store), "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects,
  });
  // A single commit carrying the whole candidate: `deleteall` means the tree is exactly
  // the entries listed, so a deleted tracked file needs no separate instruction.
  const stream: Buffer[] = [];
  stream.push(Buffer.from("commit refs/t044-manifest\ncommitter manifest <manifest@invalid> 0 +0000\ndata 2\nx\ndeleteall\n"));
  for (const entry of entries) {
    stream.push(Buffer.from(`M ${entry.mode} inline ${entry.path}\n`));
    stream.push(Buffer.from(`data ${entry.bytes.byteLength}\n`));
    // `inline` data is length-delimited, so the newline git consumes before the next
    // command is not part of the file it writes. A trailing LF is required.
    stream.push(entry.bytes);
    stream.push(Buffer.from("\n"));
  }
  stream.push(Buffer.from("\n"));
  try {
    execFileSync("git", ["fast-import", "--quiet"], {
      input: Buffer.concat(stream), stdio: ["pipe", "pipe", "pipe"], timeout: 120_000, env,
    });
    const patch = execFileSync("git", ["diff", "--binary", commit, "refs/t044-manifest"], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, env,
    });
    return patch.toString("utf8").replace(/\n+$/, "");
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr;
    throw new Error(`Could not render the candidate patch: ${stderr?.toString("utf8") ?? (error as Error).message}`);
  }
}

/**
 * The commit lane's manifest and patch.
 *
 * Each candidate file is read exactly once; those same bytes are hashed into the
 * manifest and written into the tree the patch is diffed from. There is therefore no
 * second reading in which a filter could change what the patch says, which is what the
 * round-3 reproduction exploited.
 */
function commitLaneManifest(workspace: CandidateWorkspace & { base: { kind: "commit"; commit: string } }):
  { files: CandidateFile[]; patch: string } {
  const base = readBaseTree(workspace.sourceRoot, workspace.base.commit);
  const tracked = new Set(base.keys());
  const scratch = mkdtempSync(join(tmpdir(), "candidate-manifest-"));
  try {
    const ignore = controlIgnoreStore(workspace.sourceRoot, workspace.base.commit, base, scratch);
    const untracked = untrackedCandidates(workspace.root, tracked);
    const ignored = ignoredByControl(ignore.gitDir, ignore.rulesRoot, untracked);
    const paths = [...tracked, ...untracked.filter(path => !ignored.has(path))].sort();
    const files: CandidateFile[] = [];
    const staged: { path: string; mode: string; bytes: Buffer }[] = [];
    // Links whose in-root target is a manifest entry are hashed through that target, so
    // an unmodified candidate's manifest keeps the bytes the base commit recorded. The
    // patch still carries the link text, because that is what git stores.
    const pending: { path: string; entry: ReturnType<typeof readCandidateEntry>; target: string | null }[] = [];
    for (const path of paths) {
      // A tracked file the candidate deleted is part of the patch, not of the manifest.
      // The deletion is expressed by its absence from the staged tree.
      try {
        const entry = readCandidateEntry(workspace.root, path);
        pending.push({ path, entry, target: entry.linkText === null ? null : resolveLinkTarget(workspace.root, path, entry.linkText) });
      } catch (error) {
        if (tracked.has(path) && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    const readable = new Set(pending.map(item => item.path));
    const hashed = new Map<string, string>();
    for (const item of pending) {
      if (item.entry.linkText === null) { hashed.set(item.path, sha256(item.entry.bytes)); continue; }
      // A link is an entry only when it names a regular file that is itself an entry.
      const target = item.target !== null && readable.has(item.target) ? pending.find(candidate => candidate.path === item.target) : undefined;
      if (!target || target.entry.linkText !== null) continue;
      hashed.set(item.path, sha256(target.entry.bytes));
    }
    for (const path of paths) {
      const digest = hashed.get(path);
      if (digest === undefined) continue;
      const item = pending.find(candidate => candidate.path === path)!;
      files.push({ path, hash: digest, tracked: tracked.has(path) });
      staged.push({ path, mode: item.entry.mode, bytes: item.entry.linkText === null ? item.entry.bytes : Buffer.from(item.entry.linkText, "utf8") });
    }
    return { files, patch: renderPatch(workspace.sourceRoot, workspace.base.commit, staged, scratch) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
    const lane = commitLaneManifest(workspace as CandidateWorkspace & { base: { kind: "commit"; commit: string } });
    return {
      base: "commit",
      baseIdentifier: workspace.base.commit,
      files: lane.files,
      manifestDigest: digestManifest(lane.files),
      patch: lane.patch,
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