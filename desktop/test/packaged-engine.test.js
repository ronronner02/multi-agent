'use strict';
/**
 * U18 — the packaged engine, proved from the staged resource tree.
 *
 * The test runs the staged `resources/engine` tree through the packaged Electron binary with
 * `ELECTRON_RUN_AS_NODE=1`, so it loads the exact Node ABI the daemon's utility process uses and
 * never opens a window. The probe (see `fixtures/packaged-engine-probe.mjs`) resolves
 * better-sqlite3 from that tree, opens a real database, and imports the daemon module; this file
 * asserts the answer and skips with a named reason when the tree has not been staged.
 *
 * The staging step is `npm run stage` (`scripts/stage-engine.mjs`), which needs a built engine.
 * Skipping rather than failing keeps `npm test` usable in a checkout that only wants the
 * boundary tests; `npm run dist` always stages first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const RESOURCES_ROOT = path.join(DESKTOP_ROOT, 'resources');
const ENGINE_ROOT = path.join(RESOURCES_ROOT, 'engine');
const ELECTRON_BINARY = path.join(DESKTOP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE = path.join(__dirname, 'fixtures', 'packaged-engine-probe.mjs');
const GH_PROBE = path.join(__dirname, 'fixtures', 'packaged-gh-probe.mjs');

/** The staged tree exists only after `npm run stage`; the engine checkout is not a substitute. */
function staged() {
  return fs.existsSync(path.join(ENGINE_ROOT, 'packages', 'daemon', 'dist', 'index.js'))
    && fs.existsSync(path.join(ENGINE_ROOT, 'node_modules', 'better-sqlite3', 'package.json'));
}

const skipReason = !staged() ? 'resources/engine is not staged; run npm run stage first'
  : !fs.existsSync(ELECTRON_BINARY) ? 'the Electron binary is not installed; run npm ci in desktop'
    : false;

/** A scratch directory under the run's own temp root, removed when the probe returns. */
function scratch() {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'u18-packaged-'));
  return root;
}

test('the packaged engine loads better-sqlite3 and the daemon from resources/engine', { skip: skipReason, timeout: 180_000 }, () => {
  const databaseRoot = scratch();
  let stdout;
  try {
    stdout = execFileSync(ELECTRON_BINARY, [PROBE, ENGINE_ROOT, databaseRoot], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 150_000,
      windowsHide: true,
      // The probe is the only writer, and its stdout is one JSON line.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // A non-zero exit still carries the probe's JSON line, which names the failure.
    stdout = error.stdout || '';
    if (!stdout.trim()) throw error;
  }
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  const result = JSON.parse(line);

  assert.equal(result.ok, true, `probe failed: ${result.error || line}`);
  // The utility process runs Electron's Node ABI, not this checkout's Node.
  assert.ok(result.electron, 'the probe ran inside Electron, not plain Node');
  assert.match(String(result.modules), /^\d+$/, 'the probe reported the Electron module ABI');
  // Modules resolved from the staged tree, not from the engine checkout.
  assert.ok(result.sqliteResolvedFrom.startsWith(ENGINE_ROOT), `better-sqlite3 came from ${result.sqliteResolvedFrom}`);
  assert.ok(result.bindingPath.startsWith(ENGINE_ROOT), `the native binding is ${result.bindingPath}`);
  assert.ok(fs.existsSync(result.bindingPath), 'the win32-x64 prebuild is a real file in the tree');
  // A real database, written and read back.
  assert.deepEqual(result.rows, [{ value: 'packaged' }]);
  assert.ok(result.databasePath.startsWith(databaseRoot), 'the database lives in the run scratch');
  // The daemon module imported from this tree and exposes the entry the utility process calls.
  assert.equal(result.startServer, 'function');
  assert.ok(result.daemonExports.includes('startServer'));
  assert.ok(result.daemonResolvedFrom.startsWith(ENGINE_ROOT), `the daemon came from ${result.daemonResolvedFrom}`);

  fs.rmSync(databaseRoot, { recursive: true, force: true });
});

test('the staged tree carries the files the daemon resolves from its own module URL', () => {
  if (skipReason) return;
  const required = [
    'packages/daemon/dist/index.js',
    'packages/daemon/dist/builtins/workflow-specs/basic-loop.yaml',
    'packages/daemon/assets/claude-team-permissions.cjs',
    'packages/daemon/specs/agents',
    'packages/ui/dist/index.html',
    'config/team/core.md',
    'config/team/lead-protocol.md',
    'config/team/roles.json',
    'config/team/sections/scope.md',
    'config/governance/credential-exclusions.json',
    'config/governance/low-risk-dev-dependencies.json',
    'plugins/github-cli/gh.exe',
  ];
  for (const entry of required) assert.ok(fs.existsSync(path.join(ENGINE_ROOT, entry)), `resources/engine/${entry} ships`);
});

test('the staged tree carries no checkout-only weight', () => {
  if (skipReason) return;
  const sqlite = path.join(ENGINE_ROOT, 'node_modules', 'better-sqlite3');
  // node-gyp build output and the C sources that produce it never load at runtime, and this box
  // has no compiler to produce them.
  for (const absent of ['build', 'src', 'deps']) {
    assert.equal(fs.existsSync(path.join(sqlite, absent)), false, `better-sqlite3/${absent} is not shipped`);
  }
  const prebuilds = fs.readdirSync(path.join(sqlite, 'prebuilds'));
  assert.deepEqual(prebuilds, ['win32-x64.node'], 'only the shipped target prebuild is staged');
});

test('the packaged daemon resolves the bundled gh.exe from its own module location', { skip: skipReason, timeout: 120_000 }, () => {
  const stdout = execFileSync(ELECTRON_BINARY, [GH_PROBE, ENGINE_ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 100_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop());
  assert.equal(result.ok, true, `probe failed: ${result.error || result.source}`);
  assert.equal(result.source, 'bundled', 'the bundled copy is what the resolver finds');
  // An empty PATH was given, so the resolved file can only be the installer's own copy.
  assert.equal(result.resolvedPath, path.join(ENGINE_ROOT, 'plugins', 'github-cli', 'gh.exe'));
});