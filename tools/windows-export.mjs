// One-way export of the authoritative WSL checkout to a Windows directory (KTD7).
//
//   node tools/windows-export.mjs --dest /mnt/d/Multi-Agent            dry run
//   node tools/windows-export.mjs --dest /mnt/d/Multi-Agent --apply    write
//   ... --delete                                                       also remove files dropped since the last export
//
// Windows is never a second source. Every destination path is in one of three states:
//   owned     - written by a previous export; may be replaced or (with --delete) removed
//               while it still matches what was exported
//   baseline  - present at cutover (cutover manifest); may be replaced while it still
//               matches the cutover bytes, but is never deleted
//   unknown   - anything else; never touched, and a source path landing on it is a conflict
// Any conflict stops the whole export before a byte is written.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPORT_SCHEMA = 'multi-agent-windows-export/v2';
const STATE = path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state'), 'multi-agent');
const CUTOVER_MANIFEST = path.join(STATE, 'cutover', 'windows-manifest.json');

export class ExportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// NTFS and the default Windows view of drvfs compare names case-insensitively.
const fold = (rel) => rel.toLowerCase();

function assertRelative(rel) {
  if (typeof rel !== 'string' || rel === '' || path.posix.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new ExportError('path-escape', `invalid export path ${JSON.stringify(rel)}`);
  }
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

// Walks every component without following links. Returns { hash } for the leaf
// (null when absent) or { conflict } when the path cannot be written safely.
function inspectDestination(destRoot, rel) {
  const segments = rel.split('/');
  let current = destRoot;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    const st = lstatOrNull(current);
    if (!st) return { hash: null };
    if (st.isSymbolicLink()) return { conflict: 'path-escape' };
    const leaf = i === segments.length - 1;
    if (!leaf && !st.isDirectory()) return { conflict: 'parent-not-directory' };
    if (leaf && !st.isFile()) return { conflict: 'destination-not-file' };
  }
  return { hash: sha256(readFileSync(current)) };
}

// source: Map<path, Buffer>
// previous: Map<path, { hash, owned }> (owned=false for cutover-baseline entries)
export function planExport({ source, destRoot, previous, allowDelete = false }) {
  const plan = { root: realpathSync(destRoot), write: [], unchanged: [], delete: [], conflicts: [], keptDeletions: [], expect: new Map() };
  const folded = new Map();
  for (const rel of source.keys()) {
    assertRelative(rel);
    if (folded.has(fold(rel))) plan.conflicts.push({ path: rel, reason: 'case-collision', with: folded.get(fold(rel)) });
    else folded.set(fold(rel), rel);
  }
  for (const [rel, data] of source) {
    if (plan.conflicts.some((c) => c.path === rel)) continue;
    const dest = inspectDestination(destRoot, rel);
    if (dest.conflict) {
      plan.conflicts.push({ path: rel, reason: dest.conflict });
      continue;
    }
    const prev = previous.get(rel);
    const next = sha256(data);
    plan.expect.set(rel, dest.hash);
    if (dest.hash === null) {
      if (prev) plan.conflicts.push({ path: rel, reason: 'destination-deleted' });
      else plan.write.push(rel);
    } else if (!prev) {
      plan.conflicts.push({ path: rel, reason: 'destination-unknown' });
    } else if (prev.hash !== dest.hash) {
      plan.conflicts.push({ path: rel, reason: 'destination-changed' });
    } else if (dest.hash === next) {
      plan.unchanged.push(rel);
    } else {
      plan.write.push(rel);
    }
  }
  for (const [rel, prev] of previous) {
    // Only files this tool exported may be removed; a case alias of a kept source path is the same file.
    if (!prev.owned || source.has(rel) || folded.has(fold(rel))) continue;
    assertRelative(rel);
    const dest = inspectDestination(destRoot, rel);
    if (dest.conflict) {
      plan.conflicts.push({ path: rel, reason: dest.conflict });
      continue;
    }
    if (dest.hash === null) continue;
    plan.expect.set(rel, dest.hash);
    if (!allowDelete) plan.keptDeletions.push(rel);
    else if (dest.hash === prev.hash) plan.delete.push(rel);
    else plan.conflicts.push({ path: rel, reason: 'deletion-changed' });
  }
  return plan;
}

// Stage every write under a private temp name, revalidate the whole plan against
// the destination, then commit. Returns the paths actually changed; on a failure
// after commit started, the thrown error carries them so the record stays truthful.
export function applyExport(plan, { source, destRoot }) {
  if (plan.conflicts.length) throw new ExportError('export-conflict', `${plan.conflicts.length} conflicting paths; nothing was written`);
  const staged = [];
  // Best effort: a cleanup failure must never replace the error that reports progress.
  const discard = () => {
    for (const { tmp } of staged) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // A leftover private temp file is harmless and visible by its .ma-export- name.
      }
    }
  };
  const revalidate = () => {
    if (realpathSync(destRoot) !== plan.root || lstatSync(destRoot).isSymbolicLink()) {
      throw new ExportError('destination-changed-during-apply', 'the destination root moved after planning; nothing was written');
    }
    for (const [rel, expected] of plan.expect) {
      const dest = inspectDestination(destRoot, rel);
      if (dest.conflict || dest.hash !== expected) throw new ExportError('destination-changed-during-apply', `${rel} changed after planning; nothing was written`);
    }
  };
  try {
    // Before staging creates any directory, and again right before commit.
    revalidate();
    for (const rel of plan.write) {
      const target = path.join(destRoot, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.ma-export-${randomBytes(6).toString('hex')}`;
      writeFileSync(tmp, source.get(rel), { flag: 'wx' });
      staged.push({ rel, target, tmp });
    }
    revalidate();
  } catch (err) {
    discard();
    throw err;
  }
  const written = [];
  const deleted = [];
  try {
    for (const { rel, target, tmp } of staged) {
      renameSync(tmp, target);
      written.push(rel);
    }
    for (const rel of plan.delete) {
      rmSync(path.join(destRoot, rel));
      deleted.push(rel);
    }
  } catch (err) {
    discard();
    throw new ExportError('export-partially-applied', `${err.message}; ${written.length} written, ${deleted.length} deleted`, { written, deleted });
  }
  return { written, deleted };
}

// The record describes the destination as it now is: exported paths are owned,
// cutover paths not yet replaced stay baseline-only.
export function exportRecord({ source, plan, previous, applied, sourceCommit }) {
  const written = new Set(applied.written);
  const deleted = new Set(applied.deleted);
  // Prototype-free so any tracked file name, including __proto__, is an ordinary key.
  const owned = Object.create(null);
  const baseline = Object.create(null);
  for (const [rel, prev] of previous) {
    if (deleted.has(rel) || written.has(rel)) continue;
    if (prev.owned) owned[rel] = prev.hash;
    else baseline[rel] = prev.hash;
  }
  for (const rel of [...written, ...plan.unchanged]) {
    owned[rel] = sha256(source.get(rel));
    delete baseline[rel];
  }
  return { schema: EXPORT_SCHEMA, source_commit: sourceCommit, owned, baseline };
}

export function exportRecordPath(destRoot) {
  return path.join(STATE, 'exports', `${sha256(Buffer.from(realpathSync(destRoot))).slice(0, 16)}.json`);
}

export function loadPrevious(destRoot, { recordPath = exportRecordPath(destRoot), cutoverManifest = CUTOVER_MANIFEST } = {}) {
  const previous = new Map();
  if (existsSync(recordPath)) {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (record.schema !== EXPORT_SCHEMA) throw new ExportError('record-schema', `unsupported export record ${record.schema}`);
    for (const [rel, hash] of Object.entries(record.baseline)) previous.set(rel, { hash, owned: false });
    for (const [rel, hash] of Object.entries(record.owned)) previous.set(rel, { hash, owned: true });
    return previous;
  }
  // Before the first export, the cutover manifest records what Windows held.
  if (existsSync(cutoverManifest)) {
    const m = JSON.parse(readFileSync(cutoverManifest, 'utf8'));
    if (realpathSync(m.root) === realpathSync(destRoot)) for (const [rel, hash] of Object.entries(m.files)) previous.set(rel, { hash, owned: false });
  }
  return previous;
}

function trackedSource(repoRoot) {
  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (git('status', '--porcelain', '--untracked-files=no').trim()) throw new ExportError('source-dirty', 'commit or stash tracked changes before exporting');
  const source = new Map();
  for (const line of git('ls-files', '-s', '-z').split('\u0000').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const mode = line.slice(0, 6);
    const rel = line.slice(tab + 1);
    // Regular files only: Windows checkouts do not materialize symlinks (120000) or gitlinks (160000).
    if (mode !== '100644' && mode !== '100755') continue;
    source.set(rel, readFileSync(path.join(repoRoot, rel)));
  }
  return { source, commit: git('rev-parse', 'HEAD').trim() };
}

function main(argv) {
  const destIndex = argv.indexOf('--dest');
  if (destIndex === -1 || !argv[destIndex + 1]) throw new ExportError('usage', 'usage: windows-export.mjs --dest <dir> [--apply] [--delete]');
  const destRoot = argv[destIndex + 1];
  if (!lstatOrNull(destRoot)?.isDirectory()) throw new ExportError('usage', `${destRoot} is not a directory`);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { source, commit } = trackedSource(repoRoot);
  const previous = loadPrevious(destRoot);
  const plan = planExport({ source, destRoot, previous, allowDelete: argv.includes('--delete') });
  const summary = { commit, write: plan.write.length, unchanged: plan.unchanged.length, delete: plan.delete, keptDeletions: plan.keptDeletions, conflicts: plan.conflicts };
  if (argv.includes('--apply') && plan.conflicts.length === 0) {
    const save = (applied) => {
      const recordPath = exportRecordPath(destRoot);
      mkdirSync(path.dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, `${JSON.stringify(exportRecord({ source, plan, previous, applied, sourceCommit: commit }), null, 2)}\n`);
    };
    try {
      save(applyExport(plan, { source, destRoot }));
      summary.applied = true;
    } catch (err) {
      if (err.code === 'export-partially-applied') save(err);
      throw err;
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  if (plan.conflicts.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(JSON.stringify({ windows_export_error: err.code ?? 'internal', message: err.message }));
    process.exit(1);
  }
}
