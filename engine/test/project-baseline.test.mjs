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
import { chmodSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { PIN, ImportError, auditArchive, importInto, verifyTree, fetchArchive, gitListedFiles } from '../../tools/upstream-import.mjs';

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
      assert.deepEqual(verifyTree(result, dir, { local: [], adapted: [] }), { missing: [], changed: [], adapted: [], extra: [] });
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
      assert.deepEqual(verifyTree(result, dir, { local: ['license-copy'], adapted: [] }).changed, ['LICENSE', 'packages/daemon/help.md', 'scripts/run.sh']);
    }));

  test('reports an executable file replaced by a symlink to identical bytes', () =>
    withTempDir((dir) => {
      const result = audit(archive(validEntries()));
      importInto(result, dir);
      // Same bytes and a symlink's 0777 lstat mode: only the file-type check can tell.
      writeFileSync(path.join(dir, 'run-copy.sh'), '#!/bin/sh\n', { mode: 0o755 });
      rmSync(path.join(dir, 'scripts/run.sh'));
      symlinkSync('../run-copy.sh', path.join(dir, 'scripts/run.sh'));
      assert.deepEqual(verifyTree(result, dir, { local: ['run-copy.sh'], adapted: [] }).changed, ['scripts/run.sh']);
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

  test('reports changed, missing and extra files; declared adaptations are separated', () =>
    withTempDir((dir) => {
      const result = audit(archive(validEntries()));
      importInto(result, dir);
      writeFileSync(path.join(dir, 'LICENSE'), 'edited');
      writeFileSync(path.join(dir, 'scripts/run.sh'), 'adapted');
      rmSync(path.join(dir, 'docs/reference/help.md'));
      writeFileSync(path.join(dir, 'stray.txt'), 'x');
      assert.deepEqual(verifyTree(result, dir, { local: [], adapted: ['scripts/run.sh'] }), {
        missing: ['docs/reference/help.md'],
        changed: ['LICENSE'],
        adapted: ['scripts/run.sh'],
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
  });
});
