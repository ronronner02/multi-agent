import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, chmodSync, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readFileSync, readdirSync, readSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";

/** `O_NOFOLLOW` refuses a symlink at the leaf instead of reading through it. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
/** `O_DIRECTORY` refuses anything that is not a directory, which is how a swap is caught. */
const O_DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
/** `O_NONBLOCK` keeps a swapped-in FIFO from blocking the control before `fstat` refuses it. */
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
const OPEN_READ = fsConstants.O_RDONLY;
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { CandidateIdentity } from "./review-evidence.js";
import type { ScopeProjection } from "../contracts/team-control.js";
import type { CandidateScopeEvidence } from "./scope-extension.js";

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
  checkScope?: (evidence: CandidateScopeEvidence) => ScopeProjection;
  root: string;
  sourceRoot: string;
  base: WorkspaceBase;
  /** Source state captured immediately before isolation, for later comparison. */
  source: SourceFingerprint;
  /**
   * T048 — the control-owned creation record of a snapshot-lane candidate. The snapshot lane has
   * no git registry to prove where the tree came from, so this file is its provenance and is
   * deleted with it. Absent for the commit lane, whose provenance is the source's worktree
   * registry.
   */
  recordPath?: string;
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
export function candidatePath(root: string, path: string, allowMissing = false): string {
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
  if (suffix.length > 0 && !allowMissing) throw new Error(`Candidate path is missing: ${path}`);
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
 * T054 — the commit lane reads the candidate through git, on a copy git is allowed to see.
 *
 * A candidate is worker-writable by design, so any git command that treats it as a working
 * directory, a work tree or a repository reads configuration the worker wrote. Git has more
 * program hooks than an argument can enumerate: T044's review rounds closed `core.fsmonitor`,
 * then `diff.external`, then `filter.<drv>.clean`. T044 answered by reimplementing git's
 * reading of a worktree by hand — enumeration, symlink chains, attribute cleaning, binary
 * detection, path quoting and patch rendering — and every review round added another edge
 * case, three of which T051 fixed.
 *
 * T054 copies the candidate instead, and everything after that point runs against bytes the
 * worker can no longer change:
 *
 * - The copy keeps a symlink as a link and never follows one, and it skips every entry named
 *   `.git`, so no candidate repository, gitdir file or nested checkout is ever discovered.
 * - Git runs only with a control-owned `--git-dir` whose objects borrow the source's through
 *   `objects/info/alternates`, and with the copy as `--work-tree`. Its configuration is
 *   cleared and its hooks are disabled, so no worker-written program is reachable.
 * - `read-tree <base>`, then `add -A`, then `diff --cached` read one index: the manifest is
 *   that index's entries and the patch is the same index diffed against the base commit, so
 *   the two cannot describe two readings of one file.
 *
 * The base commit keeps authority over what a path *is*, not only over what is ignored. A
 * candidate that adds, edits, retypes or deletes a `.gitignore` or `.gitattributes`, or changes
 * its executable bit, is refused before staging, so it cannot hide a deliverable with `*` or
 * reshape its own bytes with `-text`. The staging copy then carries the base's rule files in
 * their checkout form and none of the candidate's, so `add -A` reads only rules the base
 * authorized. Two shapes are exempt because git never reads them: a rule below a directory the
 * base rules exclude, and one inside a base gitlink.
 */

/** One entry of a git index: its recorded mode and the object it names. */
interface IndexEntry {
  mode: string;
  objectId: string;
}

/** A submodule's recorded commit: stored in the tree, but with no bytes of its own. */
const GITLINK_MODE = "160000";

/**
 * Environment for every git call the commit lane makes.
 *
 * Ambient `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_*` and the discovery ceilings are
 * dropped rather than inherited: they can redirect git at a worker-writable path just as
 * a repository hook can, and the daemon's own environment is not this module's to trust.
 * `GIT_ATTR_NOSYSTEM` keeps a host attributes file out of the reading for the same reason
 * `core.excludesFile` is pinned away from the host's ignore file.
 */
function controlGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...extra };
}

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

/** Whether bytes survive a UTF-8 round trip unchanged. */
function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
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

/**
 * Run git against the control-owned store and the copied candidate.
 *
 * `-C` is never used: both the git directory and the work tree are named explicitly, so no
 * argument here can resolve to a path the worker wrote. `core.excludesFile` and
 * `core.attributesFile` are pinned away from the host's configuration, and the hook and
 * monitor hooks are disabled even though the store is control-owned — each costs one array
 * entry and closes a class of program execution rather than an instance.
 */
function storeGit(store: string, workTree: string | null, args: readonly string[],
  options: { input?: Buffer; env?: NodeJS.ProcessEnv } = {}): Buffer {
  return execFileSync("git", [
    "-c", "core.excludesFile=/dev/null",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    // Git decides whether to record a mode change from the work tree's bits only when
    // `core.filemode` is on. The copy's bits are set explicitly, so pinning it keeps the
    // executable bit portable instead of inheriting a host that reports no modes.
    "-c", "core.filemode=true",
    "-c", "color.ui=false",
    `--git-dir=${store}`,
    ...(workTree === null ? [] : [`--work-tree=${workTree}`]),
    ...args,
  ], { input: options.input, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000,
    env: controlGitEnv(options.env), maxBuffer: GIT_OUTPUT_LIMIT });
}

/** The store's index as `ls-files -s` records it: mode, object and path per entry. */
function readIndex(store: string): Map<string, IndexEntry> {
  const output = storeGit(store, null, ["ls-files", "-s", "-z"]);
  const entries = new Map<string, IndexEntry>();
  // Raw bytes, because a name that is not UTF-8 must be refused rather than replaced.
  for (const record of strictUtf8(output, "An index entry").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, objectId] = record.slice(0, tab).split(" ");
    if (!mode || !objectId) continue;
    entries.set(record.slice(tab + 1), { mode, objectId });
  }
  return entries;
}

/**
 * Read the exact bytes of each object through the store's own object database.
 *
 * One `cat-file --batch` for the whole set: a per-object call is a process per file, and a
 * 3,600-file candidate would spend most of its time in process startup. The objects resolve
 * through `objects/info/alternates`, so the base commit's blobs are read without copying the
 * source repository.
 */
function readStoreBlobs(store: string, objectIds: readonly string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  const unique = [...new Set(objectIds)];
  if (unique.length === 0) return blobs;
  const output = storeGit(store, null, ["cat-file", "--batch"],
    { input: Buffer.from(`${unique.join("\n")}\n`) });
  let offset = 0;
  for (const objectId of unique) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = output.subarray(offset, newline).toString("latin1").split(" ");
    const size = Number(header[2]);
    // A missing object is reported as `<id> missing`; it contributes no bytes, and the
    // caller reports the path rather than writing an empty reading.
    if (!Number.isFinite(size)) { offset = newline + 1; continue; }
    blobs.set(objectId, output.subarray(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1;
  }
  return blobs;
}

/** Whether a path is one of the two rule files whose authority the base commit keeps. */
function isRulePath(path: string): boolean {
  const name = path.split("/").pop();
  return name === ".gitignore" || name === ".gitattributes";
}

/** What the copy recorded for one candidate path: a regular file's bytes, or a link's text. */
type SnapshotEntry = SnapshotEntryFile | SnapshotEntryLink;
interface SnapshotEntryFile { kind: "file"; mode: number; bytes: Buffer }
interface SnapshotEntryLink { kind: "link"; text: Buffer }

/**
 * Every path the copy holds, read through directory descriptors that cannot be redirected.
 *
 * A live worker can rewrite its own tree at any moment, so a path-based walk is not a reading of
 * the candidate: between listing a directory and opening a file inside it, the worker can rename
 * the directory away and put a symlink to a vault in its place. `O_NOFOLLOW` on the final
 * component does not help there, because the file itself is ordinary and only its *ancestors*
 * moved.
 *
 * Each directory is therefore opened once with `O_DIRECTORY | O_NOFOLLOW` and every descendant is
 * addressed through that descriptor (`/proc/self/fd/<fd>/<name>`). A directory replaced after it
 * was opened stays readable through the descriptor it was opened with, and one replaced before it
 * is opened fails with `ELOOP`/`ENOTDIR` rather than being followed. Files are opened relative to
 * their pinned directory with `O_NOFOLLOW | O_NONBLOCK`, so a swap to a link or a FIFO refuses
 * instead of reading or blocking.
 *
 * Linux-only by construction: `/proc/self/fd` is how Node names a descriptor as a path. The daemon
 * runs under Linux (the isolation policy is Linux accounts and mounts), and the tests run in WSL.
 */

/** Open a directory for traversal, refusing anything that is not a real directory. */
function openDirectory(parentDescriptor: number, name: string, path: string): number {
  const target = parentDescriptor < 0 ? path : `/proc/self/fd/${parentDescriptor}/${name}`;
  try {
    return openSync(target, OPEN_READ | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Error(`Candidate path became a symlink while it was read: ${path}`);
    }
    throw new Error(`Candidate directory is unreadable: ${path} (${code ?? (error as Error).message})`);
  }
}

export type WorkspaceRead =
  | { kind: "missing" }
  | { kind: "directory"; entries: Array<{ name: string; kind: "directory" | "file" }> }
  | { kind: "file"; content: string; hash: string };

/** Read objects from the owner's recorded commit, never from the worker's Git metadata. */
export function readCommittedWorkspacePath(sourceRoot: string, commit: string, path: string): WorkspaceRead {
  const readGit = (args: string[]) => execFileSync("git", ["-C", sourceRoot, "--no-replace-objects",
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 262145,
    env: controlGitEnv({ GIT_NO_LAZY_FETCH: "1" }),
  });
  const entries = (tree: string) => {
    const rows = strictUtf8(readGit(["ls-tree", "-z", tree]), "Commit tree").split("\0").filter(Boolean);
    if (rows.length > 1000) throw new Error("Workspace directory exceeds browse limit");
    return rows.map(row => {
      const match = /^(\d+) (tree|blob|commit) ([a-f0-9]+)\t([\s\S]*)$/.exec(row);
      if (!match) throw new Error("Commit entry not available");
      return { mode: match[1]!, type: match[2]!, object: match[3]!, name: match[4]! };
    });
  };
  let object = commit, type = "tree";
  for (const part of path ? path.split("/") : []) {
    if (type !== "tree") return { kind: "missing" };
    const entry = entries(object).find(entry => entry.name === part);
    if (!entry) return { kind: "missing" };
    object = entry.object; type = entry.type;
  }
  if (type === "tree") return { kind: "directory", entries: entries(object)
    .filter(entry => entry.type === "tree" || entry.mode === "100644" || entry.mode === "100755")
    .map(entry => ({ name: entry.name, kind: entry.type === "tree" ? "directory" : "file" })) };
  if (type !== "blob") return { kind: "missing" };
  const bytes = readGit(["cat-file", "blob", object]);
  if (bytes.length > 262144 || bytes.includes(0)) throw new Error("Workspace baseline not available as text");
  return { kind: "file", content: strictUtf8(bytes, "Commit blob"), hash: sha256(bytes) };
}

/** Bounded reads through pinned directories: no Git, temporary stores, or scope callbacks. */
export function readWorkspacePath(root: string, path: string, excluded: (path: string) => boolean): WorkspaceRead {
  const parts = path === "" ? [] : path.split("/");
  if (!isAbsolute(root) || path.length > 4096 || parts.length > 64
    || parts.some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f]/.test(part)) || excluded(path)) {
    throw new Error("Workspace path not available");
  }
  // Pin the root's ancestors too: replacing an assignment directory must not redirect a read.
  let descriptor = openDirectory(-1, "", sep);
  try {
    for (const part of resolve(root).split(sep).filter(Boolean)) {
      const next = openDirectory(descriptor, part, root);
      closeSync(descriptor);
      descriptor = next;
    }
    for (const part of parts) {
      const next = openSync(`/proc/self/fd/${descriptor}/${part}`, OPEN_READ | O_NOFOLLOW | O_NONBLOCK);
      closeSync(descriptor);
      descriptor = next;
    }
    const stat = fstatSync(descriptor);
    if (stat.isDirectory()) {
      const entries: Array<{ name: string; kind: "directory" | "file" }> = [];
      const directory = opendirSync(`/proc/self/fd/${descriptor}`);
      try {
        let count = 0;
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++count > 1000) throw new Error("Workspace directory exceeds browse limit");
          if (!/[\\\x00-\x1f]/.test(entry.name) && !excluded(path ? `${path}/${entry.name}` : entry.name) && (entry.isDirectory() || entry.isFile())) {
            entries.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" });
          }
        }
      } finally { directory.closeSync(); }
      return { kind: "directory", entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (!stat.isFile() || stat.size > 262144) throw new Error("Workspace file exceeds browse limit");
    const bytes = Buffer.alloc(262145);
    let size = 0, count: number;
    while (size < bytes.length && (count = readSync(descriptor, bytes, size, bytes.length - size, null)) > 0) size += count;
    if (size > 262144 || bytes.subarray(0, size).includes(0)) throw new Error("Workspace file not available as text");
    return { kind: "file", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)), hash: sha256(bytes.subarray(0, size)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  } finally { closeSync(descriptor); }
}

/**
 * Copy the candidate into a control-owned directory, returning what it holds.
 *
 * Three properties decide what the copy may contain:
 *
 * - **A link stays a link.** Its text is copied and its target is never read, so a link to a
 *   vault, to `/etc`, or through a symlinked directory carries no outside bytes into the manifest,
 *   the digest or the packet. It is never descended either, because a link to a directory is
 *   exactly the smuggling case: git records a link as its own text and does not walk through it.
 * - **Repository metadata is skipped by name, at every depth.** A candidate `.git` directory, a
 *   worker-written gitdir *file*, and a nested checkout are all metadata; git must not discover
 *   any of them, and none of them is a candidate file.
 * - **Nothing is silently dropped, and nothing is read through a link.** A FIFO, socket or device
 *   refuses the manifest with its path: a read would block the control, and skipping one would
 *   make a worker's replacement of a deliverable read as an ordinary deletion.
 */
function snapshotCandidate(root: string, destination: string): Map<string, SnapshotEntry> {
  const entries = new Map<string, SnapshotEntry>();
  const rootDescriptor = openDirectory(-1, "", root);
  try {
    const visit = (directoryDescriptor: number, relativeDir: string): void => {
      const prefix = relativeDir ? `${relativeDir}/` : "";
      // Names arrive as raw bytes: a directory entry that is not valid UTF-8 would otherwise be
      // decoded to U+FFFD here and silently dropped from the manifest.
      for (const entry of readdirSync(`/proc/self/fd/${directoryDescriptor}`, { withFileTypes: true, encoding: "buffer" })) {
        const name = strictUtf8(entry.name as unknown as Buffer, "A candidate file name");
        const path = `${prefix}${name}`;
        // Repository metadata is not a candidate file at any depth.
        if (name === ".git") continue;
        const target = join(destination, path);
        if (entry.isSymbolicLink()) {
          mkdirSync(dirname(target), { recursive: true });
          // `readlink` never follows; the text is all this records.
          const text = readlinkSync(`/proc/self/fd/${directoryDescriptor}/${name}`, { encoding: "buffer" });
          symlinkSync(text, target);
          entries.set(path, { kind: "link", text });
          continue;
        }
        if (entry.isDirectory()) {
          mkdirSync(target, { recursive: true });
          const child = openDirectory(directoryDescriptor, name, path);
          try { visit(child, path); } finally { closeSync(child); }
          continue;
        }
        if (!entry.isFile()) throw new Error(`Candidate path is not a regular file: ${path}`);
        const copied = copyRegularFile(directoryDescriptor, name, target, path);
        entries.set(path, { ...copied, bytes: readFileSync(target) });
      }
    };
    visit(rootDescriptor, "");
  } finally {
    closeSync(rootDescriptor);
  }
  return entries;
}

/**
 * Copy one regular file without following a link and without trusting a stale listing.
 *
 * `O_NOFOLLOW` turns a leaf swap-to-symlink into `ELOOP` rather than a read of the link's target,
 * `O_NONBLOCK` stops a swap-to-FIFO from blocking the control, and `fstat` on the open descriptor
 * decides both the mode and the "is a regular file" question from the object the bytes come from.
 */
function copyRegularFile(directoryDescriptor: number, name: string, target: string, path: string):
  { kind: "file"; mode: number } {
  let descriptor: number;
  try {
    descriptor = openSync(`/proc/self/fd/${directoryDescriptor}/${name}`, OPEN_READ | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Error(`Candidate path became a symlink while it was read: ${path}`);
    throw new Error(`Candidate path is unreadable: ${path} (${code ?? (error as Error).message})`);
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`Candidate path is not a regular file: ${path}`);
    writeFileSync(target, readFileSync(descriptor));
    chmodSync(target, stats.mode & 0o777);
    return { kind: "file", mode: stats.mode };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Refuse a candidate that brings rule files of its own.
 *
 * `.gitignore` and `.gitattributes` are the two files whose *content* decides what git measures.
 * A candidate's copy of either would be read by `add -A` — git loads a rule file whenever it
 * traverses that directory, whether or not the rule file itself is tracked, staged or even
 * ignored — so letting one into the copy hands ignore and attribute authority to the worker.
 *
 * The lane therefore refuses them outright, and the refusal is decided on the **candidate's own
 * files**, before staging, so no candidate rule is ever present when git runs. That ordering is
 * what makes the guarantee structural: earlier versions compared the result afterwards, and every
 * comparison had an equivalence hole — a self-ignored rule that never appeared in the index, an
 * `ident` conversion that cleaned an edited rule back to the base's object id, an ignored rule
 * that still converted a sibling's bytes.
 *
 * Two shapes are deliberately *not* refused, because git never reads them:
 *
 * - a rule path below a directory that is itself excluded (`.pytest_cache/.gitignore`, a
 *   dependency's own `.gitignore`), which is what ordinary tools create; and
 * - a rule path below a base gitlink, which belongs to the submodule's repository.
 *
 * A base-tracked rule that the candidate changed by any means — different bytes, a different
 * owner-executable bit, a link where a file was, a deletion — is refused too, by comparing the copy
 * with the base's own checkout form.
 */
function refuseCandidateRules(copied: ReadonlyMap<string, SnapshotEntry>, base: ReadonlyMap<string, IndexEntry>,
  baseRules: ReadonlyMap<string, Buffer>, excludedDirectories: ReadonlySet<string>, gitlinks: ReadonlySet<string>): void {
  const under = (path: string, roots: Iterable<string>): boolean => {
    for (const root of roots) if (path.startsWith(`${root}/`)) return true;
    return false;
  };
  const changed: string[] = [];
  for (const [path, entry] of copied) {
    if (!isRulePath(path)) continue;
    if (under(path, excludedDirectories) || under(path, gitlinks)) continue;
    const original = base.get(path);
    const originalBytes = original ? baseRules.get(path) : undefined;
    // Git records a regular file only as 100644 or 100755, so the owner-executable bit is the whole
    // mode question. Group and other bits are not recorded and cannot be a rule edit.
    const matches = original !== undefined && originalBytes !== undefined
      && ((original.mode === "120000" && entry.kind === "link" && entry.text.equals(originalBytes))
        || (original.mode !== "120000" && entry.kind === "file" && entry.bytes.equals(originalBytes)
          && (entry.mode & 0o100) === (original.mode === "100755" ? 0o100 : 0)));
    if (!matches) changed.push(path);
  }
  for (const [path, entry] of base) {
    if (!isRulePath(path) || entry.mode === GITLINK_MODE) continue;
    if (!copied.has(path)) changed.push(path);
  }
  if (changed.length > 0) {
    throw new Error(`Candidate changes a rule file, which this lane refuses: ${[...new Set(changed)].sort().join(", ")}`);
  }
}

/**
 * Materialize the base commit's rule files into a staging copy, in their checkout form.
 *
 * `checkout-index` writes what a checkout would: a rule under `working-tree-encoding` or `eol`
 * appears converted, and a symlinked rule appears as a link. That form is what is written into the
 * copy, so `add -A` sees exactly the rules the base commit gives a fresh checkout — no more, no
 * less. The copy is otherwise the candidate's, minus the candidate's rule files.
 */
function writeBaseRules(store: string, destination: string, base: ReadonlyMap<string, IndexEntry>): void {
  const paths = [...base.keys()].filter(path => isRulePath(path) && base.get(path)!.mode !== GITLINK_MODE);
  if (paths.length === 0) return;
  mkdirSync(destination, { recursive: true });
  storeGit(store, destination, ["checkout-index", "--force", "--prefix=./", "--", ...paths],
    { env: { GIT_LITERAL_PATHSPECS: "1" } });
}

/**
 * The directories in the copy that the base commit's rules exclude.
 *
 * A rule file inside one of these is never read by git, so it is not a rule edit — that is the
 * shape every tool-created cache directory takes. `check-ignore` is asked about the directories
 * only, which keeps it to one call and avoids the pathspec behaviour that bites on file names.
 *
 * Two inputs are kept out of that call:
 *
 * - A base gitlink, and everything below it. Git refuses a path inside an indexed submodule with
 *   `fatal: Pathspec '<path>' is in submodule '<root>'`, and accepts the gitlink root itself, so
 *   the walk stops at a gitlink. Its files are exempt from refusal anyway.
 * - The pathspec parser. `check-ignore --stdin` runs every record through `parse_pathspec`, so a
 *   directory literally named `:(literal)src` is read as magic and the call dies. `./` cannot
 *   begin a magic signature, so each record carries that prefix and the echoed matches lose it
 *   again. `GIT_LITERAL_PATHSPECS=1` is not the answer: `check-ignore` rejects the `literal`
 *   magic flag it sets, for every path.
 */
function excludedDirectories(store: string, workTree: string, gitlinks: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>();
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(join(workTree, relativeDir), { withFileTypes: true, encoding: "buffer" })) {
      if (!entry.isDirectory()) continue;
      const name = strictUtf8(entry.name as unknown as Buffer, "A candidate directory name");
      const path = relativeDir ? `${relativeDir}/${name}` : name;
      if (name === ".git" || gitlinks.has(path)) continue;
      directories.add(path);
      walk(path);
    }
  };
  walk("");
  if (directories.size === 0) return new Set();
  const candidates = [...directories].sort();
  let output: Buffer;
  try {
    output = storeGit(store, workTree, ["check-ignore", "--stdin", "-z"],
      { input: Buffer.from(candidates.map(path => `./${path}\0`).join("")) });
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer };
    // Exit 1 means "nothing matched", which is an answer rather than a failure.
    if (failure.status !== 1) throw error;
    output = failure.stdout ?? Buffer.alloc(0);
  }
  return new Set(output.toString("utf8").split("\0").filter(Boolean)
    .map(path => path.startsWith("./") ? path.slice(2) : path));
}

/**
 * The commit lane's manifest and patch.
 *
 * The sequence is the one plan U5 records:
 *
 * 1. The candidate is copied into a control-owned tree (descriptor-relative, so a directory
 *    swapped for a link during the read cannot redirect it).
 * 2. `read-tree <base>` puts the base commit's tree in the store's index, so the tracked set and
 *    the base's rules come from the commit rather than from the source's index.
 * 3. A candidate that added, changed, retyped or removed a rule file is refused by name
 *    (`refuseCandidateRules`), decided on the candidate's own files before any git command runs.
 * 4. The staging copy is the candidate's files without their rule files, plus the base's
 *    `.gitignore` and `.gitattributes` in their checkout form (`writeBaseRules`); the source's own
 *    `info/exclude` is carried into the store. Ignore and attribute authority therefore belong to
 *    the base commit alone.
 * 5. `add -A` stages the copy against those rules. Every conversion git performs here (line
 *    endings, `ident`, encodings) is what the patch will write, and the manifest hashes those
 *    same stored bytes, so the two cannot disagree (T051).
 * 6. `diff --cached` renders the patch from that index, so the manifest and the patch are one
 *    reading. A gitlink is carried by object id and is not a manifest entry: it has no bytes of
 *    its own.
 *
 * One selection is made here rather than left to git, and only because `patch` is a string: a
 * text hunk carries raw file bytes, and the first byte sequence that is not valid UTF-8 would
 * decode to U+FFFD and write something the candidate never held. Paths whose base or stored bytes
 * fail that round trip are rendered as binary hunks (base85, therefore ASCII) through one
 * `* -diff` rule. Git still decides *how* each path renders; this only decides which readings the
 * string type can carry as text. A symlink whose target is not UTF-8 refuses by name: git renders
 * a link as a text hunk whatever the attributes say, so a string patch cannot carry it.
 */
function commitLaneManifest(workspace: CandidateWorkspace & { base: { kind: "commit"; commit: string } }):
  { files: CandidateFile[]; patch: string; cleanedPaths: readonly string[]; scope?: ScopeProjection } {
  const commit = workspace.base.commit;
  const scratch = mkdtempSync(join(tmpdir(), "candidate-manifest-"));
  try {
    const snapshot = join(scratch, "candidate");
    mkdirSync(snapshot, { recursive: true });
    const candidateEntries = snapshotCandidate(workspace.root, snapshot);

    // The scratch store the patch is built in. It borrows the source's objects read-only, so the
    // base commit and every blob it quotes resolve without copying a repository.
    const store = join(scratch, "patch.git");
    execFileSync("git", ["init", "--quiet", "--bare", store],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: controlGitEnv() });
    const objectPath = controlGit(["rev-parse", "--git-path", "objects"], workspace.sourceRoot).trim();
    const sourceObjects = realpathSync(isAbsolute(objectPath) ? objectPath : join(workspace.sourceRoot, objectPath));
    mkdirSync(join(store, "objects", "info"), { recursive: true });
    writeFileSync(join(store, "objects", "info", "alternates"), `${sourceObjects}\n`);
    // The source's repository-level exclude file is control-owned configuration: the worker cannot
    // write the source, so it is a legitimate authority the candidate has no say in. Committed
    // `.gitignore` files do not subsume it — it is a separate ignore source.
    const excludePath = controlGit(["rev-parse", "--git-path", "info/exclude"], workspace.sourceRoot).trim();
    const physicalExclude = isAbsolute(excludePath) ? excludePath : join(workspace.sourceRoot, excludePath);
    if (lstatSync(physicalExclude, { throwIfNoEntry: false })?.isFile()) {
      mkdirSync(join(store, "info"), { recursive: true });
      writeFileSync(join(store, "info", "exclude"), readFileSync(physicalExclude));
    }

    storeGit(store, snapshot, ["read-tree", commit]);
    const base = readIndex(store);
    const gitlinks = new Set([...base].filter(([, entry]) => entry.mode === GITLINK_MODE).map(([path]) => path));

    // The base's rule files, in the copy's terms: their checkout form, so a comparison against the
    // candidate's copy is a comparison of like with like.
    const baseRulePaths = [...base.keys()].filter(path => isRulePath(path) && base.get(path)!.mode !== GITLINK_MODE);
    const baseRuleTree = join(scratch, "base-rules");
    writeBaseRules(store, baseRuleTree, base);
    const baseRules = new Map<string, Buffer>();
    for (const path of baseRulePaths) {
      const checkedOut = join(baseRuleTree, path);
      const entry = base.get(path)!;
      baseRules.set(path, entry.mode === "120000"
        ? readlinkSync(checkedOut, { encoding: "buffer" })
        : readFileSync(checkedOut));
    }

    // Refusal happens here, against the candidate's own files, before any git command can read
    // one. `excludedDirectories` is computed from the candidate's own copy under the base's rules,
    // so a rule file a tool wrote inside an ignored directory is not treated as an edit.
    const excluded = excludedDirectories(store, snapshot, gitlinks);
    refuseCandidateRules(candidateEntries, base, baseRules, excluded, gitlinks);

    // The staging copy holds the candidate's files without its rule files, plus the base's rule
    // files. `add -A` therefore reads only rules the base commit authorized, in the form a checkout
    // gives them — the property the comparison-based versions could not establish.
    for (const path of [...candidateEntries.keys()]) {
      if (!isRulePath(path)) continue;
      rmSync(join(snapshot, path), { force: true });
    }
    writeBaseRules(store, snapshot, base);
    storeGit(store, snapshot, ["add", "-A"]);

    const staged = readIndex(store);
    // A gitlink names a submodule directory: it is part of the tree the patch must reproduce, but
    // it holds no candidate bytes, so it is never a manifest entry. Git reports it by object id
    // and never descends it, which is also why a file the worker plants inside a submodule
    // directory cannot enter the manifest.
    const content = [...staged].filter(([, entry]) => entry.mode !== GITLINK_MODE);
    const stored = readStoreBlobs(store, content.map(([, entry]) => entry.objectId));

    const files: CandidateFile[] = [];
    // The paths whose canonical reading is not the candidate's worktree form, because the base
    // commit's attributes clean them. The review packet discloses them because it carries the
    // worktree bytes. Selected is not the same as diverged: `text` on a file whose line endings
    // are already LF cleans to the bytes it was given, and disclosing that would be a false alarm.
    const cleanedPaths: string[] = [];
    for (const [path, entry] of content) {
      const bytes = stored.get(entry.objectId);
      if (bytes === undefined) throw new Error(`Staged object is missing for ${path}`);
      // A link's blob is its raw target text, and git renders a link as a text hunk whatever the
      // attributes say — so a target the string type cannot carry refuses here, by name, rather
      // than becoming a patch that would recreate a different link and report success.
      if (entry.mode === "120000") strictUtf8(bytes, `The symlink target of ${path}`);
      files.push({ path, hash: sha256(bytes), tracked: base.has(path) });
      const copied = candidateEntries.get(path);
      const worktree = entry.mode === "120000"
        ? (copied?.kind === "link" ? copied.text : Buffer.alloc(0))
        : (copied?.kind === "file" ? copied.bytes : Buffer.alloc(0));
      if (!worktree.equals(bytes)) cleanedPaths.push(path);
    }
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    // Every path whose recorded reading differs between the two trees: an entry added, an entry
    // deleted, or one whose object or mode moved. A path git considers identical is left out, so
    // neither pass renders a hunk for a file nobody touched.
    const changed = [...new Set([...staged.keys(), ...base.keys()])].filter(path => {
      const before = base.get(path);
      const after = staged.get(path);
      if (!before || !after) return true;
      return before.objectId !== after.objectId || before.mode !== after.mode;
    }).sort();
    // A path exists on the diff's base side whenever the base commit recorded it, and a text hunk
    // carries that side's bytes as literally as the candidate's. Both sides are therefore checked:
    // a non-UTF-8 deletion or a non-UTF-8 file edited into UTF-8 would otherwise put bytes in a
    // text hunk that the string type cannot carry.
    const baseSide = readStoreBlobs(store, changed
      .map(path => base.get(path)?.objectId)
      .filter((objectId): objectId is string => objectId !== undefined));
    const binaryPaths = new Set<string>();
    for (const path of changed) {
      const after = staged.get(path);
      const before = base.get(path);
      if (after && after.mode !== GITLINK_MODE && !isUtf8(stored.get(after.objectId) ?? Buffer.alloc(0))) binaryPaths.add(path);
      if (before && before.mode !== GITLINK_MODE && !isUtf8(baseSide.get(before.objectId) ?? Buffer.alloc(0))) binaryPaths.add(path);
    }

    const diff = (paths: readonly string[], binary: boolean): Buffer => {
      if (paths.length === 0) return Buffer.alloc(0);
      const attributes = join(store, "info", "attributes");
      if (binary) writeFileSync(attributes, "* -diff\n");
      try {
        // `git diff` has no `--pathspec-from-file`, so the paths are arguments and the argument
        // list is bounded by the kernel. A deliverable that touches thousands of files would hit
        // that limit, so the paths are handed over in batches and the hunks concatenated: each
        // batch is one invocation against the same index, so the result is the same text in a
        // different process count.
        const batches: string[][] = [];
        let batch: string[] = [];
        let size = 0;
        for (const path of paths) {
          // The limit is on bytes, and a path is at least two bytes once quoted.
          const cost = path.length + 2;
          if (size + cost > 32 * 1024 && batch.length > 0) { batches.push(batch); batch = []; size = 0; }
          batch.push(path); size += cost;
        }
        if (batch.length > 0) batches.push(batch);
        return Buffer.concat(batches.map(chunk => storeGit(store, snapshot,
          ["diff", "--cached", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", commit, "--", ...chunk],
          { env: { GIT_LITERAL_PATHSPECS: "1" } })));
      } finally {
        if (binary) rmSync(attributes, { force: true });
      }
    };
    const rendered = Buffer.concat([
      diff(changed.filter(path => !binaryPaths.has(path)), false),
      diff(changed.filter(path => binaryPaths.has(path)), true),
    ]);
    if (!isUtf8(rendered)) {
      throw new Error("Could not render the candidate patch as UTF-8, even with every non-UTF-8 path rendered as binary");
    }
    const scope = workspace.checkScope?.({ root: snapshot, candidateDigest: digestManifest(files), files: files.map(file => file.path),
      changes: changed.map(path => ({ path, before: baseSide.get(base.get(path)?.objectId ?? "") ?? null,
        after: stored.get(staged.get(path)?.objectId ?? "") ?? null })) });
    return { files, patch: rendered.toString("utf8"), cleanedPaths: cleanedPaths.sort(), ...(scope ? { scope } : {}) };
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
 * T048 — the source repository's registered worktrees, as the provenance of a commit-lane
 * candidate.
 *
 * The registry is the source's admin directory, which no worker can write, so an entry there was
 * put there by the control side. Liveness is read from that admin directory and not from git's
 * `worktree list` annotations: git marks a registration `prunable` when the candidate's own `.git`
 * file is missing, which is a byte the worker *can* write. Taking that annotation as authority let
 * a worker turn a candidate holding real work into an unadoptable one, and let one release prune
 * another candidate's registration — both while the control-owned entry was intact. An entry whose
 * `gitdir` names a path is a registration; whether the directory is still there is a separate
 * question, answered by the filesystem when the tree is actually entered.
 *
 * The repository's own worktree is included, because it is registered the same way.
 */
export function sourceWorktrees(sourceRoot: string): Set<string> {
  const repository = realpathSync(sourceRoot);
  const registered = new Set<string>();
  registered.add(repository);
  const adminPath = gitOrNull(repository, ["rev-parse", "--git-path", "worktrees"])?.trim();
  if (!adminPath) return registered;
  const admin = isAbsolute(adminPath) ? adminPath : join(repository, adminPath);
  let entries: string[];
  try { entries = readdirSync(admin); } catch { return registered; }
  for (const entry of entries) {
    const pointer = registrationPointer(admin, entry);
    if (pointer === null) continue;
    const named = dirname(pointer);
    try { registered.add(realpathSync(named)); } catch { /* A registration whose tree is gone still names a path; it is kept. */ }
    // The unresolved parent is kept too: a worktree whose directory was temporarily unmounted is
    // still a registration, and forgetting it would be the same defect in a quieter form.
    registered.add(named);
  }
  return registered;
}

/**
 * T048 — the worktree path one admin registration names.
 *
 * A registration's `gitdir` file holds the path of the worktree's own `.git`. It is usually
 * absolute, but `worktree.useRelativePaths` and `git worktree add --relative-paths` make it
 * relative to the registration's own directory — not to ours, and not to the repository. Resolving
 * it against the daemon's working directory, as a bare `dirname` does, then names a path that does
 * not exist: a genuine candidate would be quarantined and its registration left behind on release.
 */
function registrationPointer(admin: string, entry: string): string | null {
  const directory = join(admin, entry);
  let pointer: string;
  try { pointer = readFileSync(join(directory, "gitdir"), "utf8").trim(); } catch { return null; }
  if (!pointer) return null;
  return isAbsolute(pointer) ? pointer : resolve(directory, pointer);
}

/** Whether the source repository's registry holds a worktree at exactly this path. */
export function isSourceWorktree(sourceRoot: string, workspaceRoot: string): boolean {
  let canonical: string;
  try { canonical = realpathSync(workspaceRoot); } catch { return false; }
  return sourceWorktrees(sourceRoot).has(canonical) || sourceWorktrees(sourceRoot).has(resolve(workspaceRoot));
}

/**
 * T048 — drop this candidate's registration, and only this candidate's.
 *
 * Git's own `worktree prune` is repository-wide: it deletes every administrative entry it judges
 * prunable, which includes the owner's own missing worktrees and any other task's candidate whose
 * `.git` a worker removed. Releasing one task must not destroy registry state it does not own, so
 * the entry is matched here by the `gitdir` pointer that names this exact tree and removed
 * directly. No git process runs, so no candidate path is ever passed to one.
 */
export function forgetSourceWorktree(sourceRoot: string, workspaceRoot: string): void {
  const repository = realpathSync(sourceRoot);
  const adminPath = gitOrNull(repository, ["rev-parse", "--git-path", "worktrees"])?.trim();
  if (!adminPath) return;
  const admin = isAbsolute(adminPath) ? adminPath : join(repository, adminPath);
  let canonical: string;
  try { canonical = realpathSync(workspaceRoot); } catch { canonical = resolve(workspaceRoot); }
  let entries: string[];
  try { entries = readdirSync(admin); } catch { return; }
  for (const entry of entries) {
    const pointer = registrationPointer(admin, entry);
    if (pointer === null) continue;
    const named = dirname(pointer);
    let resolved: string;
    try { resolved = realpathSync(named); } catch { resolved = resolve(named); }
    // The entry belongs to this candidate when its pointer names this tree, whether the pointer
    // was written through a symlink, in relative form or not.
    if (resolved !== canonical && resolve(named) !== resolve(workspaceRoot)) continue;
    rmSync(join(admin, entry), { recursive: true, force: true });
  }
}

/**
 * T048 — record a snapshot-lane candidate in the control state directory.
 *
 * The snapshot lane copies files into a plain directory, so after a restart nothing on disk
 * separates the daemon's candidate from a directory a worker planted at the same path. This
 * record is that separation: it names the run, the task and the candidate's canonical path, and
 * it lives under the control state directory, which the worker sandbox neither mounts nor makes
 * reachable. The path is resolved before writing, so a symlink swapped in later names a different
 * location and does not match.
 */
export function recordSnapshotCandidate(recordPath: string, input: { runId: string; taskId: string; root: string }): void {
  const canonical = realpathSync(input.root);
  mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
  writeFileSync(recordPath,
    `${JSON.stringify({ version: 1, runId: input.runId, taskId: input.taskId, root: canonical })}\n`,
    { mode: 0o600 });
}

/** Whether a control-owned creation record names this exact snapshot candidate. */
export function snapshotCandidateRecorded(recordPath: string, input: { runId: string; taskId: string; root: string }): boolean {
  let record: { version?: unknown; runId?: unknown; taskId?: unknown; root?: unknown };
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8")) as typeof record;
  } catch {
    return false;
  }
  if (record?.version !== 1 || record.runId !== input.runId || record.taskId !== input.taskId) return false;
  let canonical: string;
  try { canonical = realpathSync(input.root); } catch { return false; }
  return record.root === canonical;
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
  scope?: ScopeProjection;
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
      ...(lane.scope ? { scope: lane.scope } : {}),
    };
  }
  // The snapshot lane has no history to diff against; the hashed manifest IS its
  // identity, which is exactly what KTD8's "complete file manifest" allows. The
  // copy is a plain directory with no Git metadata, so it is walked directly.
  // No base commit means no attributes, so nothing is cleaned.
  if (workspace.checkScope) {
    const snapshot = mkdtempSync(join(tmpdir(), "candidate-scope-"));
    try {
      snapshotCandidate(workspace.root, snapshot);
      const files = listFiles(snapshot, { index: false });
      const before = new Map(workspace.base.files.map(file => [file.path, file.hash])), after = new Map(files.map(file => [file.path, file.hash]));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort();
      const scope = workspace.checkScope({ root: snapshot, candidateDigest: digestManifest(files), files: files.map(file => file.path),
        changes: changed.map(path => ({ path,
          before: before.has(path) ? readFileSync(candidatePath(workspace.sourceRoot, path)) : null,
          after: after.has(path) ? readFileSync(candidatePath(snapshot, path)) : null })) });
      return { base: "snapshot", baseIdentifier: workspace.base.baselineDigest, files, manifestDigest: digestManifest(files), patch: "", cleanedPaths: [], scope };
    } finally { rmSync(snapshot, { recursive: true, force: true }); }
  }
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
  scope?: ScopeProjection;
} {
  const { base, baseIdentifier, files, manifestDigest, patch, scope } = candidateArtifact(workspace);
  return { base, baseIdentifier, files, manifestDigest, patch, ...(scope ? { scope } : {}) };
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
  scope?: ScopeProjection;
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
    //
    // A symlink is written as a regular file holding its target text (T054). That is the
    // reading the manifest records and the patch writes, and a link in the packet would be
    // followed by every later read of it. The parent is resolved through the containment
    // rule; the leaf is not, because resolving it is exactly what would read the target.
    const packetParent = candidatePath(workspace.root, dirname(file.path));
    const source = join(packetParent, basename(file.path));
    if (lstatSync(source).isSymbolicLink()) writeFileSync(target, readlinkSync(source, { encoding: "buffer" }));
    else copyFileSync(source, target);
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
  return { root, identity, manifest: files, cleanedPaths: [...manifest.cleanedPaths].sort(), packetDigest, ...(manifest.scope ? { scope: manifest.scope } : {}) };
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

/**
 * Release the candidate tree. The source worktree was never written, so nothing restores it.
 *
 * T048 — the tree is deleted directly, never by handing its path to git. `worktree remove <path>`
 * runs git with the candidate as the repository to operate on, which reopens the configuration
 * class T044 closed: a worker-written `.git` or `config` in the candidate would be read. Its
 * registration is then dropped by `forgetSourceWorktree`, which matches the one admin entry that
 * names this tree — not by a repository-wide `prune`, which would also delete every other
 * registration git happens to judge prunable. The snapshot lane has no registration; its
 * control-owned creation record goes with the tree it names.
 */
export function removeCandidateWorkspace(workspace: CandidateWorkspace): void {
  rmSync(workspace.root, { recursive: true, force: true });
  if (workspace.base.kind === "commit") {
    try { forgetSourceWorktree(workspace.sourceRoot, workspace.root); } catch { /* A vanished source has no registry to update. */ }
  }
  if (workspace.recordPath) rmSync(workspace.recordPath, { force: true });
}