// Project baseline (U1 / T002): pinned upstream import provenance.
//
//   node --test engine/test/project-baseline.test.mjs
//
// Synthetic archives exercise every importer rejection path offline. The
// pinned check re-audits the cached upstream archive (downloading it once if
// absent) and requires engine/ to match it except for declared adaptations.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { PIN, ImportError, auditArchive, importInto, verifyTree, fetchArchive, gitListedFiles } from '../../tools/upstream-import.mjs';
import { ExportError, applyExport, exportRecord, exportRecordPath, loadPrevious, planExport } from '../../tools/windows-export.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.join(here, '..');
const COMMIT = 'c0ffee0000000000000000000000000000000000';
const ROOT = `fixture-${COMMIT}/`;

function header(name, { type = '0', size = 0, mode = 0o644, link = '', prefix = '' } = {}) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(prefix, 345, 155, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write(link, 157, 100, 'utf8');
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const b of block) sum += b;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function pax(records) {
  return Buffer.from(
    Object.entries(records)
      .map(([k, v]) => {
        const body = ` ${k}=${v}\n`;
        let len = body.length + 1;
        while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
        return `${len}${body}`;
      })
      .join(''),
  );
}

function entry(name, opts = {}) {
  const data = Buffer.from(opts.data ?? '');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header(name, { ...opts, size: data.length }), data, pad]);
}

function archive(entries, { commit = COMMIT } = {}) {
  const global = pax({ comment: commit });
  return gzipSync(Buffer.concat([entry('pax_global_header', { type: 'g', data: global }), ...entries, Buffer.alloc(1024)]));
}

const validEntries = () => [
  entry(ROOT, { type: '5', mode: 0o755 }),
  entry(`${ROOT}LICENSE`, { data: 'Apache License' }),
  entry(`${ROOT}docs/reference/help.md`, { data: 'help' }),
  entry(`${ROOT}packages/daemon/help.md`, { type: '2', link: '../../docs/reference/help.md' }),
  entry(`${ROOT}scripts/run.sh`, { data: '#!/bin/sh\n', mode: 0o755 }),
  entry(`${ROOT}.claude/skills/x/SKILL.md`, { data: 'upstream instructions' }),
  entry(`${ROOT}.github/workflows/ci.yml`, { data: 'on: push' }),
];

const audit = (gz, opts = {}) => auditArchive(gz, { expectedSha256: null, commit: COMMIT, ...opts });

function expectImportError(fn, code, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ImportError, `expected ImportError, got ${err}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ma-baseline-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('offline: upstream archive audit', () => {
  test('accepts a well-formed archive and applies the approved exclusions', () => {
    const result = audit(archive(validEntries()));
    assert.deepEqual(result.manifest.map((m) => m.path), ['LICENSE', 'docs/reference/help.md', 'packages/daemon/help.md', 'scripts/run.sh']);
    assert.deepEqual(result.counts, { files: 3, symlinks: 1, excluded: 2 });
    assert.equal(result.manifest.find((m) => m.path === 'scripts/run.sh').mode, 0o755);
    assert.match(result.manifestDigest, /^[0-9a-f]{64}$/);
  });

  test('rejects an archive for a different commit or with a different checksum', () => {
    expectImportError(() => audit(archive(validEntries(), { commit: 'f'.repeat(40) })), 'archive-commit-mismatch');
    expectImportError(() => auditArchive(archive(validEntries()), { expectedSha256: '0'.repeat(64), commit: COMMIT }), 'archive-checksum-mismatch');
  });

  test('rejects entries that escape the import root', () => {
    expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}../outside.txt`, { data: 'x' })])), 'archive-path-escape');
    expectImportError(() => audit(archive([...validEntries(), entry('other-root/file.txt', { data: 'x' })])), 'archive-path-escape');
    expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}a/./b.txt`, { data: 'x' })])), 'archive-path-escape');
    expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}a//b.txt`, { data: 'x' })])), 'archive-path-escape');
  });

  test('rejects symlinks that leave the root or point at something not imported', () => {
    expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}evil`, { type: '2', link: '../../etc/passwd' })])), 'archive-symlink-escape');
    expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}abs`, { type: '2', link: '/etc/passwd' })])), 'archive-symlink-escape');
    expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}hidden`, { type: '2', link: '.claude/skills/x/SKILL.md' })])), 'archive-symlink-escape');
  });

  test('resolves names from pax records, GNU long names and the ustar prefix', () => {
    const longName = `${ROOT}${'deep/'.repeat(30)}file.txt`;
    const result = audit(
      archive([
        ...validEntries(),
        entry('PaxHeaders/x', { type: 'x', data: pax({ path: `${ROOT}pax/named.txt` }) }),
        entry('truncated-ustar-name', { data: 'via pax' }),
        entry('././@LongLink', { type: 'L', data: `${longName}\0` }),
        entry('truncated', { data: 'via gnu' }),
        entry('prefixed.txt', { data: 'via prefix', prefix: `${ROOT}ustar` }),
        entry('PaxHeaders/y', { type: 'x', data: pax({ linkpath: '../LICENSE' }) }),
        entry(`${ROOT}pax/license-link`, { type: '2', link: 'ignored' }),
      ]),
    );
    const byPath = Object.fromEntries(result.manifest.map((m) => [m.path, m]));
    assert.equal(byPath['pax/named.txt'].data.toString(), 'via pax');
    assert.equal(byPath[longName.slice(ROOT.length)].data.toString(), 'via gnu');
    assert.equal(byPath['ustar/prefixed.txt'].data.toString(), 'via prefix');
    assert.equal(byPath['pax/license-link'].link, '../LICENSE');
    // A pax record applies only to the next entry.
    assert.ok(!('truncated-ustar-name' in byPath) && !result.manifest.some((m) => m.path.endsWith('truncated')));
  });

  test('rejects malformed archives instead of auditing a partial manifest', () => {
    const good = Buffer.concat([entry('pax_global_header', { type: 'g', data: pax({ comment: COMMIT }) }), ...validEntries()]);
    expectImportError(() => audit(gzipSync(good)), 'archive-malformed', /no end-of-archive marker/);
    const corrupt = Buffer.concat([good, Buffer.alloc(1024)]);
    corrupt[512 * 3 + 10] ^= 0xff; // a byte inside a later header breaks its checksum
    expectImportError(() => audit(gzipSync(corrupt)), 'archive-malformed', /bad header checksum/);
    const truncated = Buffer.concat([entry('pax_global_header', { type: 'g', data: pax({ comment: COMMIT }) }), header(`${ROOT}big.bin`, { size: 4096 }), Buffer.alloc(512)]);
    expectImportError(() => audit(gzipSync(truncated)), 'archive-malformed', /truncated entry/);
    expectImportError(() => audit(archive([...validEntries(), entry('PaxHeaders/z', { type: 'x', data: pax({ size: '10' }) }), entry(`${ROOT}sized`, { data: 'x' })])), 'archive-malformed', /pax size/);
  });

  test('rejects duplicate paths and entries nested under a file or symlink', () => {
    expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}LICENSE`, { data: 'again' })])), 'archive-duplicate-path');
    expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}LICENSE/inner.txt`, { data: 'x' })])), 'archive-duplicate-path');
    expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}packages/daemon/help.md/through-link.txt`, { data: 'x' })])), 'archive-duplicate-path');
  });

  test('rejects hardlinks, devices and FIFOs', () => {
    for (const type of ['1', '3', '4', '6']) {
      expectImportError(() => audit(archive([...validEntries(), entry(`${ROOT}special`, { type, link: 'LICENSE' })])), 'archive-entry-type-denied');
    }
  });
});

describe('offline: import and verification', () => {
  test('imports exactly the manifest, preserving modes and symlinks', () =>
    withTempDir((dir) => {
      const result = audit(archive(validEntries()));
      importInto(result, dir);
      assert.equal(readFileSync(path.join(dir, 'LICENSE'), 'utf8'), 'Apache License');
      assert.equal(readlinkSync(path.join(dir, 'packages/daemon/help.md')), '../../docs/reference/help.md');
      assert.deepEqual(verifyTree(result, dir, { local: [], adapted: [], removed: [] }), { missing: [], changed: [], adapted: [], removed: [], extra: [] });
    }));

  test('refuses to overwrite any existing file', () =>
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'LICENSE'), 'local');
      expectImportError(() => importInto(audit(archive(validEntries())), dir), 'import-would-overwrite');
      assert.equal(readFileSync(path.join(dir, 'LICENSE'), 'utf8'), 'local');
    }));

  test('reports executable-bit drift and a symlink replaced by a same-content file', () =>
    withTempDir((dir) => {
      const result = audit(archive(validEntries()));
      importInto(result, dir);
      assert.equal(statSync(path.join(dir, 'scripts/run.sh')).mode & 0o777, 0o755);
      chmodSync(path.join(dir, 'scripts/run.sh'), 0o644);
      rmSync(path.join(dir, 'packages/daemon/help.md'));
      writeFileSync(path.join(dir, 'packages/daemon/help.md'), 'help');
      // An expected regular file replaced by a symlink to identical bytes is still a change.
      writeFileSync(path.join(dir, 'license-copy'), 'Apache License');
      rmSync(path.join(dir, 'LICENSE'));
      symlinkSync('license-copy', path.join(dir, 'LICENSE'));
      assert.deepEqual(verifyTree(result, dir, { local: ['license-copy'], adapted: [], removed: [] }).changed, ['LICENSE', 'packages/daemon/help.md', 'scripts/run.sh']);
    }));

  test('reports an executable file replaced by a symlink to identical bytes', () =>
    withTempDir((dir) => {
      const result = audit(archive(validEntries()));
      importInto(result, dir);
      // Same bytes and a symlink's 0777 lstat mode: only the file-type check can tell.
      writeFileSync(path.join(dir, 'run-copy.sh'), '#!/bin/sh\n', { mode: 0o755 });
      rmSync(path.join(dir, 'scripts/run.sh'));
      symlinkSync('../run-copy.sh', path.join(dir, 'scripts/run.sh'));
      assert.deepEqual(verifyTree(result, dir, { local: ['run-copy.sh'], adapted: [], removed: [] }).changed, ['scripts/run.sh']);
    }));

  test('sets recorded modes even under a restrictive umask', () =>
    withTempDir((dir) => {
      const previous = process.umask(0o077);
      try {
        importInto(audit(archive(validEntries())), dir);
      } finally {
        process.umask(previous);
      }
      assert.equal(statSync(path.join(dir, 'scripts/run.sh')).mode & 0o777, 0o755);
      assert.equal(statSync(path.join(dir, 'LICENSE')).mode & 0o777, 0o644);
    }));

  test('local files match exactly while slash-terminated directories admit only descendants', () =>
    withTempDir((dir) => {
      const result = audit(archive(validEntries()));
      importInto(result, dir);
      const localFiles = [
        'local/owned.ts', 'local/owned.ts.extra', 'local/adjacent.ts',
        'config/isolation/policy.json', 'config/isolation-extra/policy.json',
      ];
      for (const rel of localFiles) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), 'local fixture');
      }
      const tree = verifyTree(result, dir, { local: ['local/owned.ts', 'config/isolation/'], adapted: [], removed: [] });
      assert.deepEqual(tree.missing, []);
      assert.deepEqual(tree.changed, []);
      assert.deepEqual(tree.extra.sort(), [
        'config/isolation-extra/policy.json', 'local/adjacent.ts', 'local/owned.ts.extra',
      ]);
    }));

  test('reports changed, missing and extra files; declared adaptations are separated', () =>
    withTempDir((dir) => {
      const result = audit(archive(validEntries()));
      importInto(result, dir);
      writeFileSync(path.join(dir, 'LICENSE'), 'edited');
      writeFileSync(path.join(dir, 'scripts/run.sh'), 'adapted');
      rmSync(path.join(dir, 'docs/reference/help.md'));
      writeFileSync(path.join(dir, 'stray.txt'), 'x');
      assert.deepEqual(verifyTree(result, dir, { local: [], adapted: ['scripts/run.sh'], removed: [] }), {
        missing: ['docs/reference/help.md'],
        changed: ['LICENSE'],
        adapted: ['scripts/run.sh'],
        removed: [],
        extra: ['stray.txt'],
      });
    }));
});

describe('pinned: engine/ matches the audited upstream archive', () => {
  test('every imported file matches; only declared adaptations differ', async () => {
    const result = auditArchive(await fetchArchive());
    assert.equal(result.commit, PIN.commit);
    assert.equal(result.manifestDigest, PIN.manifestDigest, 'the audited import set must be the approved one');
    assert.deepEqual(result.counts, PIN.counts);
    // Every manifest path must be tracked, so ignore rules cannot silently drop an imported file.
    const tracked = new Set(execFileSync('git', ['-C', engineRoot, 'ls-files', '-z', '--cached', '--', '.'], { encoding: 'utf8' }).split('\u0000'));
    assert.deepEqual(result.manifest.filter((m) => !tracked.has(m.path)).map((m) => m.path), []);
    const tree = verifyTree(result, engineRoot, { files: gitListedFiles(engineRoot) });
    assert.deepEqual({ missing: tree.missing, changed: tree.changed, extra: tree.extra }, { missing: [], changed: [], extra: [] });
    assert.deepEqual(tree.adapted.sort(), [...PIN.adapted].sort(), 'every declared adaptation must still differ from upstream');
    // Every path the import once carried and we deleted is still gone: a re-appearing
    // file would silently re-enter the tree outside the approved import set.
    assert.deepEqual(tree.removed.sort(), result.manifest.filter((m) => PIN.removed.some((entry) => (entry.endsWith('/') ? m.path.startsWith(entry) : m.path === entry))).map((m) => m.path).sort(), 'every declared removal must still be absent');
  });
});

describe('offline: one-way Windows export', () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const src = (entries) => new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]));
  const baseline = (entries) => new Map(Object.entries(entries).map(([k, v]) => [k, { hash: sha(v), owned: false }]));
  const toPrevious = (record) =>
    new Map([
      ...Object.entries(record.baseline).map(([k, hash]) => [k, { hash, owned: false }]),
      ...Object.entries(record.owned).map(([k, hash]) => [k, { hash, owned: true }]),
    ]);
  const exportOnce = (dir, source, previous, opts = {}) => {
    const plan = planExport({ source, destRoot: dir, previous, ...opts });
    const applied = applyExport(plan, { source, destRoot: dir });
    return { plan, applied, previous: toPrevious(exportRecord({ source, plan, previous, applied, sourceCommit: 'c0ffee' })) };
  };
  const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');

  test('first export replaces cutover-baseline files, adds new ones, and never touches other Windows files', () =>
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'README.md'), 'old');
      writeFileSync(path.join(dir, 'personal.txt'), 'mine');
      const { plan } = exportOnce(dir, src({ 'README.md': 'new', 'docs/a.md': 'a' }), baseline({ 'README.md': 'old', 'personal.txt': 'mine' }));
      assert.deepEqual(plan.write.sort(), ['README.md', 'docs/a.md']);
      assert.equal(read(dir, 'README.md'), 'new');
      assert.equal(read(dir, 'personal.txt'), 'mine');
    }));

  test('a cutover-only Windows file is never deleted or adopted, even with --delete', () =>
    withTempDir((dir) => {
      mkdirSync(path.join(dir, '.claude'));
      writeFileSync(path.join(dir, '.claude/skill.md'), 'host mirror');
      const first = exportOnce(dir, src({ 'a.md': 'a' }), baseline({ '.claude/skill.md': 'host mirror' }), { allowDelete: true });
      assert.deepEqual([first.plan.delete, first.plan.keptDeletions], [[], []]);
      assert.equal(first.previous.get('.claude/skill.md').owned, false, 'stays baseline-only after an export');
      const second = planExport({ source: src({ 'a.md': 'a2' }), destRoot: dir, previous: first.previous, allowDelete: true });
      assert.deepEqual(second.delete, []);
      assert.equal(read(dir, '.claude/skill.md'), 'host mirror');
    }));

  test('re-exporting the same source is a no-op', () =>
    withTempDir((dir) => {
      const source = src({ 'a.md': 'a' });
      const { previous } = exportOnce(dir, source, new Map());
      const plan = planExport({ source, destRoot: dir, previous });
      assert.deepEqual([plan.write, plan.unchanged, plan.conflicts], [[], ['a.md'], []]);
    }));

  test('an external edit, deletion or unknown file (even with identical bytes) stops the export with nothing written', () =>
    withTempDir((dir) => {
      const { previous } = exportOnce(dir, src({ 'a.md': 'a', 'b.md': 'b' }), new Map());
      writeFileSync(path.join(dir, 'a.md'), 'edited on Windows');
      rmSync(path.join(dir, 'b.md'));
      writeFileSync(path.join(dir, 'c.md'), 'c');
      const next = src({ 'a.md': 'a2', 'b.md': 'b2', 'c.md': 'c', 'd.md': 'd' });
      const plan = planExport({ source: next, destRoot: dir, previous });
      assert.deepEqual(plan.conflicts, [
        { path: 'a.md', reason: 'destination-changed' },
        { path: 'b.md', reason: 'destination-deleted' },
        { path: 'c.md', reason: 'destination-unknown' },
      ]);
      assert.throws(() => applyExport(plan, { source: next, destRoot: dir }), (err) => err instanceof ExportError && err.code === 'export-conflict');
      assert.equal(read(dir, 'a.md'), 'edited on Windows');
      assert.equal(existsSync(path.join(dir, 'd.md')), false);
    }));

  test('dropped exported files are kept without --delete, removed with it, and never removed once changed', () =>
    withTempDir((dir) => {
      const first = exportOnce(dir, src({ 'keep.md': 'k', 'gone.md': 'g', 'edited.md': 'e' }), new Map());
      writeFileSync(path.join(dir, 'edited.md'), 'edited on Windows');
      const second = planExport({ source: src({ 'keep.md': 'k' }), destRoot: dir, previous: first.previous });
      assert.deepEqual(second.keptDeletions.sort(), ['edited.md', 'gone.md']);
      const kept = exportOnce(dir, src({ 'keep.md': 'k' }), first.previous);
      assert.equal(existsSync(path.join(dir, 'gone.md')), true);
      const plan = planExport({ source: src({ 'keep.md': 'k' }), destRoot: dir, previous: kept.previous, allowDelete: true });
      assert.deepEqual([plan.delete, plan.conflicts], [['gone.md'], [{ path: 'edited.md', reason: 'deletion-changed' }]]);
      writeFileSync(path.join(dir, 'edited.md'), 'e');
      const deleted = exportOnce(dir, src({ 'keep.md': 'k' }), kept.previous, { allowDelete: true });
      assert.deepEqual(deleted.applied.deleted.sort(), ['edited.md', 'gone.md']);
      assert.equal(existsSync(path.join(dir, 'gone.md')), false, 'deletion is actually applied');
      assert.equal(deleted.previous.has('gone.md'), false);
    }));

  test('rejects case collisions and never deletes a case alias of a kept file', () =>
    withTempDir((dir) => {
      const collide = planExport({ source: src({ 'README.md': 'a', 'readme.md': 'b' }), destRoot: dir, previous: new Map() });
      assert.deepEqual(collide.conflicts.map((c) => c.reason), ['case-collision']);
      const { previous } = exportOnce(dir, src({ 'README.md': 'same' }), new Map());
      const renamed = planExport({ source: src({ 'readme.md': 'same' }), destRoot: dir, previous, allowDelete: true });
      assert.deepEqual(renamed.delete, []);
    }));

  test('rejects path escapes, symlinked or dangling components and files in place of directories', () =>
    withTempDir((dir) =>
      withTempDir((outside) => {
        symlinkSync(outside, path.join(dir, 'linked'));
        symlinkSync(path.join(outside, 'missing-dir'), path.join(dir, 'dangling'));
        writeFileSync(path.join(dir, 'plain'), 'a file');
        const plan = planExport({ source: src({ 'linked/new.md': 'x', 'dangling/new.md': 'y', 'plain/child.md': 'z' }), destRoot: dir, previous: new Map() });
        assert.deepEqual(plan.conflicts.map((c) => c.reason), ['path-escape', 'path-escape', 'parent-not-directory']);
        for (const bad of ['../up.md', '/abs.md', 'a//b.md', 'a/./b.md']) {
          assert.throws(() => planExport({ source: src({ [bad]: 'x' }), destRoot: dir, previous: new Map() }), (err) => err.code === 'path-escape');
        }
        assert.equal(existsSync(path.join(outside, 'missing-dir')), false);
      }),
    ));

  test('a destination change between planning and applying aborts with nothing written and no temp files left', () =>
    withTempDir((dir) => {
      const { previous } = exportOnce(dir, src({ 'a.md': 'a', 'b.md': 'b' }), new Map());
      const next = src({ 'a.md': 'a2', 'b.md': 'b2' });
      const plan = planExport({ source: next, destRoot: dir, previous });
      writeFileSync(path.join(dir, 'b.md'), 'edited during export');
      assert.throws(() => applyExport(plan, { source: next, destRoot: dir }), (err) => err.code === 'destination-changed-during-apply');
      assert.equal(read(dir, 'a.md'), 'a');
      assert.deepEqual(readdirSync(dir).sort(), ['a.md', 'b.md']);
    }));

  test('an edit to an unchanged file or a swapped destination root also aborts before any write', () =>
    withTempDir((dir) =>
      withTempDir((elsewhere) => {
        const root = path.join(dir, 'dest');
        mkdirSync(root);
        const { previous } = exportOnce(root, src({ 'same.md': 's', 'b.md': 'b' }), new Map());
        const next = src({ 'same.md': 's', 'b.md': 'b2', 'new/c.md': 'c' });
        const plan = planExport({ source: next, destRoot: root, previous });
        writeFileSync(path.join(root, 'same.md'), 'edited during export');
        assert.throws(() => applyExport(plan, { source: next, destRoot: root }), (err) => err.code === 'destination-changed-during-apply');
        assert.equal(existsSync(path.join(root, 'new')), false, 'no directory is created before revalidation');
        writeFileSync(path.join(root, 'same.md'), 's');
        const replan = planExport({ source: next, destRoot: root, previous });
        // The look-alike holds identical files, so only the pinned root can tell them apart.
        writeFileSync(path.join(elsewhere, 'same.md'), 's');
        writeFileSync(path.join(elsewhere, 'b.md'), 'b');
        rmSync(root, { recursive: true });
        symlinkSync(elsewhere, root);
        assert.throws(() => applyExport(replan, { source: next, destRoot: root }), (err) => err.code === 'destination-changed-during-apply');
        assert.deepEqual(readdirSync(elsewhere).sort(), ['b.md', 'same.md']);
        assert.equal(readFileSync(path.join(elsewhere, 'b.md'), 'utf8'), 'b');
      }),
    ));

  test('path-keyed state survives a file named __proto__', () =>
    withTempDir((dir) => {
      const { applied, previous } = exportOnce(dir, src({ ['__proto__']: 'p', 'a.md': 'a' }), new Map());
      assert.deepEqual(applied.written.sort(), ['__proto__', 'a.md']);
      assert.equal(previous.get('__proto__').owned, true);
    }));

  test('loadPrevious prefers the export record over the cutover manifest', () =>
    withTempDir((dir) => {
      const manifest = path.join(dir, 'cutover.json');
      const record = path.join(dir, 'record.json');
      writeFileSync(manifest, JSON.stringify({ root: dir, files: { 'a.md': sha('a') } }));
      assert.deepEqual([...loadPrevious(dir, { recordPath: record, cutoverManifest: manifest })], [['a.md', { hash: sha('a'), owned: false }]]);
      writeFileSync(record, JSON.stringify({ schema: 'multi-agent-windows-export/v2', owned: { 'b.md': sha('b') }, baseline: { 'a.md': sha('a') } }));
      assert.deepEqual(
        [...loadPrevious(dir, { recordPath: record, cutoverManifest: manifest })].sort(),
        [['a.md', { hash: sha('a'), owned: false }], ['b.md', { hash: sha('b'), owned: true }]],
      );
    }));
});

// Host checks for the KTD7 cutover; they run where the cutover was recorded.
const CUTOVER_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? '', '.local', 'state'), 'multi-agent', 'cutover');
const cutoverSkip = existsSync(path.join(CUTOVER_DIR, 'cutover.json')) ? false : 'no cutover record on this host';

describe('host: WSL source-authority cutover', { skip: cutoverSkip }, () => {
  const record = cutoverSkip ? null : JSON.parse(readFileSync(path.join(CUTOVER_DIR, 'cutover.json'), 'utf8'));
  const repoRoot = path.join(engineRoot, '..');
  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();

  test('this checkout is the recorded authority and descends from the verified bootstrap', () => {
    assert.equal(realpathSync(repoRoot), realpathSync(record.authority));
    assert.equal(git('rev-parse', `${record.bootstrap_commit}^{tree}`), record.bootstrap_tree);
    assert.doesNotThrow(() => git('merge-base', '--is-ancestor', record.bootstrap_commit, 'HEAD'));
  });

  test('preserved Windows workspace files are unchanged except through recorded exports', () => {
    const manifest = JSON.parse(readFileSync(path.join(CUTOVER_DIR, record.windows_manifest), 'utf8'));
    const exportPath = exportRecordPath(manifest.root);
    const exported = existsSync(exportPath) ? JSON.parse(readFileSync(exportPath, 'utf8')).owned : {};
    const expected = { ...manifest.files, ...exported };
    const drift = Object.entries(expected).filter(([rel, hash]) => {
      const file = path.join(manifest.root, rel);
      return !existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== hash;
    });
    assert.deepEqual(drift.map(([rel]) => rel), []);
  });
});
