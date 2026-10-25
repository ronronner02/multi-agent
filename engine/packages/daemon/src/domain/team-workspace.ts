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

/**
 * Ceiling for git's stdout. The default 1 MB is smaller than a large repository's
 * `ls-tree` output and far smaller than a patch for a big deliverable, and hitting it
 * fails the whole manifest with an unrelated error, so the limit is set well past what
 * one candidate can reasonably hold.
 */
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;

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
  // A submodule is a directory in the worktree and a `160000` entry in the index. It has
  // no bytes of its own, so reading it is an EISDIR rather than a manifest entry, and a
  // base that tracks one must not fail the baseline.
  const gitlinks = new Set(options.index
    ? git(root, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean)
      .filter(entry => entry.startsWith(`${GITLINK_MODE} `))
      .map(entry => entry.slice(entry.indexOf("\t") + 1))
    : []);
  return [...new Set([...tracked, ...untracked])].sort().flatMap(path => {
    if (gitlinks.has(path)) return [];
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

/** A submodule's recorded commit: stored in the tree, but with no bytes of its own. */
const GITLINK_MODE = "160000";

/**
 * Decode bytes that must be UTF-8, refusing instead of substituting U+FFFD.
 *
 * Every name this module handles becomes a path in the patch and in the manifest, so a
 * lossy decode would describe a path the candidate does not have — and, worse, a patch
 * that deletes the real one. Refusing keeps the manifest honest about what it could not
 * represent.
 *
 * `ignoreBOM` keeps a name that begins with U+FEFF as that name. `TextDecoder` strips a
 * leading BOM by default, so `﻿anchor.txt` decoded to `anchor.txt`, collided with
 * the real one and the second path was dropped from the manifest — a completeness failure
 * on the candidate's own file (T051, R3-2).
 */
function strictUtf8(bytes: Buffer, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${what} is not valid UTF-8`);
  }
}

/** The base commit's tree, as the source repository records it. */
function readBaseTree(sourceRoot: string, commit: string): Map<string, BaseEntry> {
  // Raw bytes, because a name that is not UTF-8 must be refused rather than replaced.
  const output = execFileSync("git", ["-C", sourceRoot, "ls-tree", "-r", "-z", "--full-tree", commit],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: controlGitEnv(), maxBuffer: GIT_OUTPUT_LIMIT });
  const entries = new Map<string, BaseEntry>();
  for (const record of strictUtf8(output, "A base tree entry").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    if (!mode || !objectId || (type !== "blob" && mode !== GITLINK_MODE)) continue;
    // A gitlink is kept. `ls-tree` types it `commit`, so filtering on `blob` alone
    // dropped it and made an unmodified candidate's patch delete the owner's submodule.
    // It carries no bytes here: it travels by object id.
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
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: controlGitEnv(extraEnv),
      maxBuffer: GIT_OUTPUT_LIMIT });
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
  //
  // `core.excludesFile` is pinned to /dev/null because `GIT_CONFIG_GLOBAL` alone does
  // not disable the control user's `$XDG_CONFIG_HOME/git/ignore`: without this, one
  // host-level rule could hide a candidate's deliverable from the manifest. The
  // base commit's rules and the source's `info/exclude` are then the only authority.
  let output: string;
  try {
    output = execFileSync("git", ["-c", "core.excludesFile=/dev/null",
      `--git-dir=${gitDir}`, `--work-tree=${rulesRoot}`,
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
function untrackedCandidates(root: string, tracked: ReadonlySet<string>, skip: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (relativeDir: string): void => {
    // Names arrive as raw bytes: a directory entry that is not valid UTF-8 would
    // otherwise be decoded to U+FFFD here and silently dropped from the manifest.
    for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true, encoding: "buffer" })) {
      const name = strictUtf8(entry.name as unknown as Buffer, "A candidate file name");
      const path = relativeDir ? `${relativeDir}/${name}` : name;
      // Repository metadata is not a candidate file at any depth.
      if (name === ".git") continue;
      // A submodule's own files belong to its repository, not to this candidate. Git
      // reports a gitlink as one entry and does not descend it; walking in would put the
      // submodule's bytes in the manifest and its paths in the patch.
      if (skip.has(path)) continue;
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
 * manifest decides separately whether the link counts as an entry (`resolveLinkChain`).
 *
 * A path reached through a symlinked ancestor refuses the manifest: the walk skips
 * symlinked directories, so such a path can only be a tracked one the worker replaced
 * with a link, which would otherwise read an ignored vault's bytes. A path that is not
 * a regular file (a FIFO, socket or device the worker created) refuses too — reading it
 * would block the control or consume an unbounded stream.
 */
function readCandidateEntry(root: string, path: string): { mode: string; bytes: Buffer; linkText: string | null } {
  const segments = path.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Candidate path is missing: ${path}`);
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`Candidate path is reached through a symlink: ${path}`);
    // A tracked path whose ancestor became a file cannot be read as a path at all.
    if (!stats.isDirectory()) throw new Error(`Candidate path has a non-directory ancestor: ${path}`);
  }
  const full = join(root, path);
  let stats;
  try {
    stats = lstatSync(full);
  } catch (error) {
    // A path that is gone is reported with the same message the manifest already
    // treats as "deleted in the candidate", so the caller does not need a second check.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Candidate path is missing: ${path}`);
    throw error;
  }
  if (stats.isSymbolicLink()) return { mode: "120000", bytes: Buffer.alloc(0), linkText: readlinkSync(full) };
  if (!stats.isFile()) throw new Error(`Candidate path is not a regular file: ${path}`);
  // Git records only the owner execute bit; a group- or other-executable file is still
  // mode 100644, so testing all three bits would invent a mode change that never happened.
  return { mode: stats.mode & 0o100 ? "100755" : "100644", bytes: readFileSync(full), linkText: null };
}

/** How many links a chain may pass through before the manifest refuses it. */
const MAX_LINK_HOPS = 40;

/**
 * Whether a link target climbs out of the candidate through a symlinked directory.
 *
 * `jump/../victim` is the shape: resolved lexically it names `victim` beside the link,
 * but the kernel resolves `jump` first, so `..` is that link's *parent directory* and the
 * path names a file outside the candidate. Hashing one file while the applied link names
 * another is exactly the disagreement this module exists to prevent. A `..` with no
 * symlinked component before it is ordinary `../sibling` and stays allowed.
 */
function climbsThroughLink(current: string, text: string): boolean {
  let prefix = current;
  let passedLink = false;
  for (const segment of text.split("/")) {
    if (segment === "..") {
      // Only a `..` that follows a symlinked component can leave the tree this way.
      if (passedLink) return true;
      prefix = dirname(prefix);
      continue;
    }
    if (segment === "" || segment === ".") continue;
    prefix = prefix ? `${prefix}/${segment}` : segment;
    try {
      if (lstatSync(prefix).isSymbolicLink()) passedLink = true;
    } catch {
      // A missing component decides nothing here; the caller reports it as dangling.
      return false;
    }
  }
  return false;
}

/**
 * The regular file a candidate symlink finally names, or `null` when it names none.
 *
 * A chain is followed to its end, as `git ls-tree` and `readFile` through the path always
 * did: `l2 -> l1 -> docs/t.md` describes `docs/t.md`'s bytes under all three names, and on
 * an unmodified candidate those bytes are exactly what the base commit recorded.
 *
 * Every hop must stay inside the candidate. An escaping, absolute or looping chain, and
 * a chain that ends at something other than a regular file, return `null` so the caller
 * can refuse the manifest — following one is how an ignored owner secret reaches the
 * digest and the reviewer packet under an innocuous name.
 */
function resolveLinkChain(root: string, path: string, linkText: string): string | null {
  const physical = resolve(root);
  let current = dirname(path);
  let text = linkText;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop += 1) {
    if (isAbsolute(text)) return null;
    // `current` is already repository-relative, so the check runs against the physical root.
    if (climbsThroughLink(join(physical, current), text)) return null;
    const target = relative(physical, resolve(physical, current, text));
    if (target === "" || target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) return null;
    const targetPath = target.split(sep).join("/");
    let stats;
    try {
      stats = lstatSync(join(physical, targetPath));
    } catch {
      return null; // Dangling.
    }
    if (!stats.isSymbolicLink()) return stats.isFile() ? targetPath : null;
    current = dirname(targetPath);
    text = readlinkSync(join(physical, targetPath));
  }
  return null; // A cycle.
}

/**
 * Quote a path for a `git fast-import` command line.
 *
 * The stream is newline-delimited, so an unquoted path containing a newline would be read
 * as the start of the next command: a file named `x\ndata 0\n\nM 100644 inline forged.txt`
 * would put a `forged.txt` entry into the patch that the manifest never hashed. Git's own
 * C-style quoting (the form `ls-tree` emits) makes the path a single token.
 */
function quoteStreamPath(path: string): string {
  const out: string[] = ['"'];
  for (const byte of Buffer.from(path, "utf8")) {
    if (byte === 0x22) out.push('\\"');
    else if (byte === 0x5c) out.push("\\\\");
    else if (byte === 0x07) out.push("\\a");
    else if (byte === 0x08) out.push("\\b");
    else if (byte === 0x09) out.push("\\t");
    else if (byte === 0x0a) out.push("\\n");
    else if (byte === 0x0b) out.push("\\v");
    else if (byte === 0x0c) out.push("\\f");
    else if (byte === 0x0d) out.push("\\r");
    else if (byte >= 0x20 && byte < 0x7f) out.push(String.fromCharCode(byte));
    else out.push(`\\${byte.toString(8).padStart(3, "0")}`);
  }
  out.push('"');
  return out.join("");
}

/**
 * Whether bytes need git's binary rendering. Anything that is not plain UTF-8 text — a
 * NUL, or a sequence no UTF-8 decoder accepts — is rendered as a binary hunk.
 */
function isBinaryContent(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** A base blob's bytes, by object id, for paths the candidate changed or deleted. */
function readBaseBlobs(sourceRoot: string, objectIds: readonly string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (objectIds.length === 0) return blobs;
  // One `cat-file --batch` for the whole set: a per-object call is a process per file.
  const output = execFileSync("git", ["-C", sourceRoot, "cat-file", "--batch"],
    { input: `${objectIds.join("\n")}\n`, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000, env: controlGitEnv(),
      maxBuffer: GIT_OUTPUT_LIMIT });
  let offset = 0;
  for (const objectId of objectIds) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = output.slice(offset, newline).toString("latin1").split(" ");
    const size = Number(header[2]);
    // A missing object is reported as `<id> missing`: it contributes no bytes, and the
    // caller treats the path as having no base side.
    if (!Number.isFinite(size)) { offset = newline + 1; continue; }
    blobs.set(objectId, output.slice(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1;
  }
  return blobs;
}

/**
 * The paths the base commit's attributes give a *cleaning* behaviour, so the bytes a
 * checkout shows are not the bytes the repository stores.
 *
 * A candidate's worktree bytes are what the owner's checkout would show, and the patch
 * must write them back. Git records the *cleaned* form: `text`, `eol` and `crlf` convert
 * line endings on the way in, and `filter` runs the driver's clean command. A manifest
 * hashed from the worktree bytes would therefore record one reading while the patch
 * carried another, which is the disagreement T051 exists to close.
 *
 * The values that mean "convert" are the closed set git documents, not an open-ended hook
 * list: `text` is `set`, `auto` (git decides by content) or `-text` (never convert);
 * `eol` is `crlf` or `lf`; legacy `crlf` is set or unset; `filter` names a driver or is
 * unset. Two more convert on check-in and are easy to forget: `ident` expands `$Id$` to
 * `$Id: <oid> $`, and `working-tree-encoding` transcodes the worktree's encoding to UTF-8.
 * Both were missing from the first version of this list, and a base `*.txt ident` gave an
 * *unmodified* candidate a spurious 159-byte patch — the same failure class as the
 * non-ASCII name. `unset` on any of these disables its conversion, so it is not shaped.
 *
 * Making this a *selection* means a value this list misjudged is harmless in one
 * direction only: a path wrongly selected is cleaned by git to the bytes it already had,
 * while a path wrongly skipped keeps the old bug. `auto` is therefore selected
 * unconditionally, because git converts only text-looking content and returns the input
 * unchanged otherwise.
 *
 * The `check-attr` output is NUL-separated raw bytes. It is split on those bytes and each
 * field decoded strictly as UTF-8, because the paths on the input side were already
 * accepted as UTF-8: decoding the whole buffer as latin1 kept a non-ASCII name from ever
 * matching its own entry, so an unmodified `café.txt` under `eol=crlf` got a spurious
 * patch (T051, N1).
 */
function attributeShapedPaths(sourceRoot: string, commit: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  // `GIT_ATTR_SOURCE` pins the rules to the base commit, so a candidate cannot author the
  // attributes that decide what its own bytes are.
  const output = execFileSync("git", ["-C", sourceRoot, "check-attr", "-z", "--stdin",
    "text", "eol", "crlf", "filter", "ident", "working-tree-encoding"],
    { input: paths.map(path => `${path}\0`).join(""), stdio: ["pipe", "pipe", "pipe"], timeout: 60_000,
      env: controlGitEnv({ GIT_ATTR_SOURCE: commit, GIT_LITERAL_PATHSPECS: "1" }), maxBuffer: GIT_OUTPUT_LIMIT });
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    fields.push(strictUtf8(output.subarray(start, index), "An attribute source path"));
    start = index + 1;
  }
  const shaped = new Set<string>();
  // `<path>\0<attribute>\0<value>\0`, one triple per requested attribute. Only the
  // conversion attributes are requested — `text`, `eol`, `crlf`, `filter`, `ident` and
  // `working-tree-encoding` — so any value other than `unspecified` (the base says
  // nothing) or `unset` (`-text`, `-filter`: the behaviour is switched off) selects the
  // path. The triples stay aligned however many attributes are asked for.
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index];
    const value = fields[index + 2];
    if (!path || value === undefined || value === "unspecified" || value === "unset") continue;
    shaped.add(path);
  }
  return shaped;
}

/**
 * The bytes git would store for each path whose base-commit attributes clean it.
 *
 * `hash-object --path` runs the base commit's own rules over the candidate's bytes, and
 * the blob it writes *is* what the patch carries, so the manifest hashes that reading
 * rather than a second one. The scratch store configures no filter driver, so a base that
 * declares one cleans to the bytes it was given — a program the base names can never run
 * on the candidate's behalf (the card's attribute-authority clause, pinned by test).
 *
 * Only the selected paths are hashed: a repository with no attributes runs no git call
 * beyond the one `check-attr`, so every recorded identity in such a repository is
 * unchanged.
 */
function cleanedReadings(store: string, env: NodeJS.ProcessEnv, commit: string,
  entries: readonly { path: string; bytes: Buffer }[]): Map<string, Buffer> {
  const readings = new Map<string, Buffer>();
  if (entries.length === 0) return readings;
  const objectIds = entries.map(entry => execFileSync("git", ["-C", store, "hash-object", "-w", "--stdin", `--path=${entry.path}`],
    { input: entry.bytes, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000,
      env: controlGitEnv({ ...env, GIT_ATTR_SOURCE: commit }) }).toString("utf8").trim());
  // One `cat-file --batch` for the whole set, so cleaning costs one process per shaped
  // file plus one for the read-back rather than two each.
  const output = execFileSync("git", ["-C", store, "cat-file", "--batch"],
    { input: `${objectIds.join("\n")}\n`, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000,
      env: controlGitEnv(env), maxBuffer: GIT_OUTPUT_LIMIT });
  let offset = 0;
  for (const [index, objectId] of objectIds.entries()) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`Could not read the cleaned bytes of ${entries[index]!.path}`);
    const header = output.subarray(offset, newline).toString("latin1").split(" ");
    const size = Number(header[2]);
    if (!Number.isFinite(size)) throw new Error(`Cleaned object ${objectId} is missing from the scratch store`);
    readings.set(entries[index]!.path, output.subarray(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1;
  }
  return readings;
}

/**
 * Render the patch between the base commit and a tree built from the manifest's bytes.
 *
 * The tree is written to a control-owned scratch object store that borrows the source's
 * objects read-only, so git never reads a candidate path — only the scratch store and
 * the source repository.
 *
 * Two properties are decided per entry from the bytes rather than from a path pattern:
 *
 * - **Binary rendering.** A path pattern has to survive git's attribute syntax, which
 *   splits on whitespace and treats `*`, `?`, `[` and a leading `#` as significant, so
 *   a file named `my file.dat` or `[x].dat` silently lost its `-diff` rule. The diff is
 *   therefore rendered in two passes over the same store: text paths with no attributes
 *   at all, then binary paths under a single `* -diff` rule that names no path.
 * - **Lossless output.** A `GIT binary patch` section is base85 over the raw bytes, so
 *   the concatenated patch is pure ASCII and no decode can rewrite it.
 *
 * `staged` holds the bytes the patch must carry, already cleaned for the paths the base
 * commit gives attributes — the same bytes `candidateManifest` hashed. Nothing here
 * consults attributes again, so the manifest and the patch cannot describe two readings
 * (T051, R3-1). The guarantee this function owns is unchanged: git never runs against a
 * candidate path.
 */
function renderPatch(
  sourceRoot: string,
  commit: string,
  base: ReadonlyMap<string, BaseEntry>,
  entries: readonly { path: string; mode: string; bytes: Buffer; linkText: string | null }[],
  store: string,
  env: NodeJS.ProcessEnv,
): string {
  const stream: Buffer[] = [];
  stream.push(Buffer.from("commit refs/t044-manifest\ncommitter manifest <manifest@invalid> 0 +0000\ndata 2\nx\ndeleteall\n"));
  for (const [path, entry] of base) {
    if (entry.mode === GITLINK_MODE) stream.push(Buffer.from(`M ${GITLINK_MODE} ${entry.objectId} ${quoteStreamPath(path)}\n`));
  }
  for (const entry of entries) {
    if (entry.linkText !== null) {
      // A link is stored as its own text, so applying the patch yields a link.
      const text = Buffer.from(entry.linkText, "utf8");
      stream.push(Buffer.from(`M ${entry.mode} inline ${quoteStreamPath(entry.path)}\ndata ${text.byteLength}\n`));
      stream.push(text, Buffer.from("\n"));
      continue;
    }
    // `entry.bytes` is the reading the manifest hashed: the base commit's cleaning has
    // already been applied by the caller, so this byte string is the patch's content and
    // the manifest's hash at once.
    stream.push(Buffer.from(`M ${entry.mode} inline ${quoteStreamPath(entry.path)}\ndata ${entry.bytes.byteLength}\n`));
    // `inline` data is length-delimited, so the newline git consumes before the next
    // command is not part of the file it writes. A trailing LF is required.
    stream.push(entry.bytes, Buffer.from("\n"));
  }
  stream.push(Buffer.from("\n"));

  // A base side that is not UTF-8 needs binary rendering too, or `git diff` writes the
  // old bytes into a text hunk and the patch cannot be applied at all.
  const baseBlobs = readBaseBlobs(sourceRoot, [...base]
    .filter(([, entry]) => entry.mode !== GITLINK_MODE)
    .map(([, entry]) => entry.objectId));
  const binary: string[] = [];
  const text: string[] = [];
  for (const [path, entry] of base) {
    const candidate = entries.find(candidate => candidate.path === path);
    if (entry.mode === GITLINK_MODE) { text.push(path); continue; }
    if (!candidate) {
      // Deleted in the candidate: only the base side exists, so its bytes decide.
      (isBinaryContent(baseBlobs.get(entry.objectId) ?? Buffer.alloc(0)) ? binary : text).push(path);
      continue;
    }
    if (candidate.linkText !== null) { text.push(path); continue; }
    const baseBytes = baseBlobs.get(entry.objectId);
    ((isBinaryContent(candidate.bytes) || (baseBytes !== undefined && isBinaryContent(baseBytes))) ? binary : text).push(path);
  }
  for (const entry of entries) {
    if (base.has(entry.path)) continue;
    // Added in the candidate: there is no base side, so its own bytes decide.
    (entry.linkText === null && isBinaryContent(entry.bytes) ? binary : text).push(entry.path);
  }

  const attributesPath = join(store, "info", "attributes");
  try {
    execFileSync("git", ["fast-import", "--quiet", "--force"], {
      input: Buffer.concat(stream), stdio: ["pipe", "pipe", "pipe"], timeout: 120_000, env, maxBuffer: GIT_OUTPUT_LIMIT,
    });
    const diff = (paths: readonly string[]): Buffer => {
      if (paths.length === 0) return Buffer.alloc(0);
      // `GIT_LITERAL_PATHSPECS` matters: a name containing `*`, `?` or `[` is a literal
      // path here, and a leading `:` must not be read as a pathspec magic prefix.
      return execFileSync("git", ["-C", store, "diff", "--binary", "--no-renames", commit, "refs/t044-manifest", "--", ...paths],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
          env: controlGitEnv({ ...env, GIT_LITERAL_PATHSPECS: "1" }), maxBuffer: GIT_OUTPUT_LIMIT });
    };
    const textPart = diff(text);
    // One `* -diff` rule, in a store file that is removed afterwards, so no path pattern
    // is ever parsed and no name can lose its rule.
    mkdirSync(join(store, "info"), { recursive: true });
    writeFileSync(attributesPath, "* -diff\n");
    const binaryPart = diff(binary);
    rmSync(attributesPath, { force: true });
    // Git's own bytes are kept exactly. A binary hunk ends with a blank line, and
    // collapsing trailing newlines there makes `git apply` drop the last binary section
    // without reporting an error — a silently incomplete patch. Both sections are ASCII
    // by construction: base85 for binary, UTF-8 text for the rest.
    return Buffer.concat([textPart, binaryPart]).toString("utf8");
  } catch (error) {
    rmSync(attributesPath, { force: true });
    const stderr = (error as { stderr?: Buffer }).stderr;
    throw new Error(`Could not render the candidate patch: ${stderr?.toString("utf8") ?? (error as Error).message}`);
  }
}

/**
 * The commit lane's manifest and patch.
 *
 * Each candidate file is read exactly once. For a path the base commit cleans through its
 * attributes, the bytes the patch carries are the *cleaned* bytes, and the manifest hashes
 * that same reading — so the digest a reviewer is told to expect is the content the patch
 * writes (T051). Every other path is hashed from the worktree bytes as before.
 *
 * `readings` returns those same bytes per path. The review packet copies them rather than
 * re-reading the candidate, because a packet built from the raw worktree bytes would hash
 * differently from the manifest it claims to describe.
 */
function commitLaneManifest(workspace: CandidateWorkspace & { base: { kind: "commit"; commit: string } }):
  { files: CandidateFile[]; patch: string; cleanedPaths: readonly string[] } {
  const base = readBaseTree(workspace.sourceRoot, workspace.base.commit);
  // A gitlink names a submodule directory: it is part of the tree the patch must
  // reproduce, but it holds no candidate bytes, so it is never a manifest path and the
  // candidate walk must not descend it.
  const gitlinks = new Set([...base].filter(([, entry]) => entry.mode === GITLINK_MODE).map(([path]) => path));
  const tracked = new Set([...base.keys()].filter(path => !gitlinks.has(path)));
  const scratch = mkdtempSync(join(tmpdir(), "candidate-manifest-"));
  try {
    const ignore = controlIgnoreStore(workspace.sourceRoot, workspace.base.commit, base, scratch);
    const untracked = untrackedCandidates(workspace.root, tracked, gitlinks);
    const ignored = ignoredByControl(ignore.gitDir, ignore.rulesRoot, untracked);
    const paths = [...tracked, ...untracked.filter(path => !ignored.has(path))].sort();

    // Every path is classified before anything is hashed, because a link's hash depends
    // on a target that may itself be a link.
    const entries = new Map<string, { mode: string; bytes: Buffer; linkText: string | null; linkTarget: string | null }>();
    for (const path of paths) {
      let entry;
      try {
        entry = readCandidateEntry(workspace.root, path);
      } catch (error) {
        // A tracked file the candidate deleted is part of the patch, not of the manifest:
        // the deletion is expressed by its absence from the staged tree.
        if ((error as Error).message.startsWith("Candidate path is missing") && tracked.has(path)) continue;
        throw error;
      }
      const linkTarget = entry.linkText === null ? null : resolveLinkChain(workspace.root, path, entry.linkText);
      entries.set(path, { ...entry, linkTarget });
    }

    // The scratch object store the patch is built in. It borrows the source's objects
    // read-only, so the base commit and every blob the patch quotes resolve without
    // copying a repository.
    const store = join(scratch, "patch.git");
    execFileSync("git", ["init", "--quiet", "--bare", store],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: controlGitEnv() });
    const objectPath = controlGit(["rev-parse", "--git-path", "objects"], workspace.sourceRoot).trim();
    const sourceObjects = realpathSync(isAbsolute(objectPath) ? objectPath : join(workspace.sourceRoot, objectPath));
    const storeEnv = controlGitEnv({
      GIT_DIR: store,
      GIT_OBJECT_DIRECTORY: join(realpathSync(store), "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects,
    });

    // The reading each regular path contributes: its worktree bytes, or the bytes the base
    // commit's attributes clean them to. The selection is the closed attribute set above;
    // a repository whose base records no attributes selects nothing, so no recorded
    // identity moves.
    const regular = [...entries].filter(([, entry]) => entry.linkText === null);
    const shaped = attributeShapedPaths(workspace.sourceRoot, workspace.base.commit, regular.map(([path]) => path));
    const cleaned = cleanedReadings(store, storeEnv, workspace.base.commit,
      regular.filter(([path]) => shaped.has(path)).map(([path, entry]) => ({ path, bytes: entry.bytes })));

    // A symlink is an entry only when its chain ends at a regular file that is itself an
    // entry. Everything else refuses: a link that escapes the candidate, dangles, cycles,
    // or names a directory (or an ignored file) is a way to describe bytes the candidate
    // does not own, and the reader would otherwise copy them into the packet.
    const regularPaths = new Set(regular.map(([path]) => path));
    const files: CandidateFile[] = [];
    const staged: { path: string; mode: string; bytes: Buffer; linkText: string | null }[] = [];
    // The paths whose canonical reading is not the candidate's worktree form. The review
    // packet discloses them because it carries the worktree bytes. Selected is not the
    // same as diverged: `text` on a file whose line endings are already LF cleans to the
    // bytes it was given, and disclosing that would be a false alarm.
    const cleanedPaths = new Set<string>();
    for (const path of paths) {
      const entry = entries.get(path);
      if (!entry) continue;
      if (entry.linkText === null) {
        const stored = cleaned.get(path);
        const bytes = stored ?? entry.bytes;
        if (stored !== undefined && !stored.equals(entry.bytes)) cleanedPaths.add(path);
        files.push({ path, hash: sha256(bytes), tracked: tracked.has(path) });
        staged.push({ path, mode: entry.mode, bytes, linkText: null });
        continue;
      }
      if (entry.linkTarget === null || !regularPaths.has(entry.linkTarget)) {
        throw new Error(`Candidate symlink does not name a manifest entry: ${path}`);
      }
      // Hashed through the chain's final file, which is what the base commit recorded.
      // A link carries its target's bytes as the base stored them, so the same cleaned
      // reading is used here as for the target itself.
      const target = entries.get(entry.linkTarget)!;
      const storedTarget = cleaned.get(entry.linkTarget);
      const targetBytes = storedTarget ?? target.bytes;
      // Same rule as a regular file: selected is not diverged. A target whose cleaned
      // bytes are identical is not disclosed, and neither is a link to it (R2-2).
      if (storedTarget !== undefined && !storedTarget.equals(target.bytes)) cleanedPaths.add(path);
      files.push({ path, hash: sha256(targetBytes), tracked: tracked.has(path) });
      // Staged as the link's own text, because that is what the repository stores.
      staged.push({ path, mode: entry.mode, bytes: Buffer.alloc(0), linkText: entry.linkText });
    }

    return { files, patch: renderPatch(workspace.sourceRoot, workspace.base.commit, base, staged, store, storeEnv),
      cleanedPaths: [...cleanedPaths].sort() };
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
 * The candidate's canonical reading: base identifier, every file it owns with the hash of
 * the bytes the patch carries, a complete manifest digest, and a patch against the base.
 *
 * Untracked files are listed in the manifest because they are part of the
 * candidate, and their additions are carried in the patch as well so a reader
 * that applies only diffs still lands on the same tree.
 *
 * `cleanedPaths` names the paths where the base commit's attributes make the stored form
 * differ from the worktree form. The review packet discloses them, because the packet
 * carries the worktree bytes while this manifest records the stored ones.
 */
function candidateArtifact(workspace: CandidateWorkspace): {
  base: WorkspaceBase["kind"];
  baseIdentifier: string;
  files: CandidateFile[];
  manifestDigest: string;
  patch: string;
  cleanedPaths: readonly string[];
} {
  if (workspace.base.kind === "commit") {
    const lane = commitLaneManifest(workspace as CandidateWorkspace & { base: { kind: "commit"; commit: string } });
    return {
      base: "commit",
      baseIdentifier: workspace.base.commit,
      files: lane.files,
      manifestDigest: digestManifest(lane.files),
      patch: lane.patch,
      cleanedPaths: lane.cleanedPaths,
    };
  }
  // The snapshot lane has no history to diff against; the hashed manifest IS its
  // identity, which is exactly what KTD8's "complete file manifest" allows. The
  // copy is a plain directory with no Git metadata, so it is walked directly.
  // No base commit means no attributes, so nothing is cleaned.
  const files = listFiles(workspace.root, { index: false });
  return { base: "snapshot", baseIdentifier: workspace.base.baselineDigest, files, manifestDigest: digestManifest(files), patch: "",
    cleanedPaths: [] };
}

/**
 * The exact candidate: base identifier, every file it owns with its hash, a
 * complete manifest digest, and a patch against the base.
 */
export function candidateManifest(workspace: CandidateWorkspace): {
  base: WorkspaceBase["kind"];
  baseIdentifier: string;
  files: CandidateFile[];
  manifestDigest: string;
  patch: string;
} {
  const { base, baseIdentifier, files, manifestDigest, patch } = candidateArtifact(workspace);
  return { base, baseIdentifier, files, manifestDigest, patch };
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
 *
 * Two readings meet here and are deliberately kept apart:
 *
 * - `root` and the files under it are the candidate's **own worktree bytes**, because
 *   "the reviewer sees the exact candidate" is what T012 asks for.
 * - `identity.manifestDigest` and `manifest` describe the **canonical reading** the patch
 *   carries. For a path the base commit's attributes clean, that reading is the stored
 *   form: an edited `eol=lf` file's worktree holds CRLF while the patch writes LF.
 *
 * `cleanedPaths` names every path where the two readings differ, so the divergence is
 * disclosed rather than silent. `packetDigest` records the hash of the packet's own bytes,
 * which is what `verifyReviewPacket` compares against — the packet's content is proved to
 * be the candidate the reviewer was given, and the manifest digest independently proves
 * what the patch will write. Neither is inferred from the other.
 */
export interface ReviewPacket {
  root: string;
  identity: CandidateIdentity;
  /** The complete manifest, hashes included, that the patch and the candidate agree on. */
  manifest: readonly CandidateFile[];
  /**
   * Paths whose packet bytes are the candidate's worktree form while `manifest` records
   * the cleaned form the patch writes. Empty for a repository with no git attributes.
   */
  cleanedPaths: readonly string[];
  /** sha256 of the packet's own file contents, so the copy can be proved unaltered. */
  packetDigest: string;
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
  const manifest = candidateArtifact(workspace);
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
    // The reviewer gets the candidate's own bytes (T012). Where the base commit's
    // attributes clean a path, those bytes differ from the canonical reading the patch
    // writes, and `cleanedPaths` is what discloses the difference — the packet never
    // silently substitutes one reading for the other.
    copyFileSync(candidatePath(workspace.root, file.path), target);
    // 0o444: the reviewer may read the bytes and nothing else.
    chmodSync(target, 0o444);
  }
  // The identity the packet claims is the candidate's own digest, so a packet and
  // the manifest it came from can be compared without trusting the caller.
  const identity = candidateIdentity(manifest);
  // The packet's own content hash: computed from the bytes now on disk, so
  // `verifyReviewPacket` can prove the copy the reviewer holds is unaltered without
  // conflating that proof with the canonical reading the patch writes.
  const packetDigest = digestManifest(files.map(file => ({
    path: file.path, tracked: file.tracked,
    hash: sha256(readFileSync(join(root, file.path))),
  })));
  // Deepest first, so a parent is sealed only after its children exist.
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    chmodSync(directory, 0o555);
  }
  return { root, identity, manifest: files, cleanedPaths: [...manifest.cleanedPaths].sort(), packetDigest };
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
  // bytes came from, not whether this copy is a repository.
  //
  // Three bindings are checked, and each catches something the others cannot:
  //
  // - the packet's bytes against `packetDigest`, which catches an edit to a file;
  // - the manifest's own hashes against `identity.manifestDigest`, which catches a
  //   tampered manifest entry — a packet whose recorded hashes no longer describe the
  //   candidate is not evidence about it, and R2-1 showed this case slipping through
  //   when only the first check ran;
  // - each path outside `cleanedPaths` against its recorded hash, which catches a
  //   non-shaped file that changed between being hashed and being copied, so the packet
  //   and the manifest cannot disagree without one of the first two noticing a moment
  //   later.
  //
  // A shaped path is excluded from the third check by construction: its packet bytes are
  // the worktree form while its recorded hash is the cleaned form, and `cleanedPaths` is
  // what tells the reviewer the two differ.
  try {
    const actual: CandidateFile[] = packet.manifest.map((file: CandidateFile) => ({
      path: file.path, tracked: file.tracked,
      hash: sha256(readFileSync(candidatePath(packet.root, file.path))),
    }));
    if (digestManifest(packet.manifest) !== packet.identity.manifestDigest) {
      return { unchanged: false, identity: packet.identity,
        reason: "Packet manifest does not match its own identity digest" };
    }
    const cleaned = new Set(packet.cleanedPaths);
    const recorded = new Map(packet.manifest.map(file => [file.path, file.hash]));
    const mismatched = actual
      .filter(file => !cleaned.has(file.path) && file.hash !== recorded.get(file.path))
      .map(file => file.path);
    if (mismatched.length) {
      return { unchanged: false, identity: packet.identity,
        reason: `Packet bytes differ from the manifest for ${mismatched.join(", ")}` };
    }
    const unchanged = digestManifest(actual) === packet.packetDigest;
    return { unchanged, identity: { ...packet.identity, fileCount: actual.length },
      reason: unchanged ? null : "Packet bytes differ from the packet digest" };
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