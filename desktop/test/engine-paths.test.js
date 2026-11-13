'use strict';
/**
 * U18 — where the packaged app finds its engine, and what the installer ships.
 *
 * The resolver is proved against both layouts without an install: a fake `resourcesPath` that
 * contains a staged daemon, and the development checkout this test runs in. The staging rules are
 * proved against the real staged tree when it exists (`npm run stage`), because that tree is the
 * one the installer copies.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(DESKTOP_ROOT, '..');
const RESOURCES_ENGINE = path.join(DESKTOP_ROOT, 'resources', 'engine');
const DAEMON_ENTRY_PATH = path.join('packages', 'daemon', 'dist', 'index.js');

/** Load engine-paths.js with a chosen `resourcesPath`, the way Electron sets it. */
function loadEnginePaths(resourcesPath) {
  const modulePath = path.join(DESKTOP_ROOT, 'src', 'engine-paths.js');
  const source = fs.readFileSync(modulePath, 'utf8');
  // The module reads `process.resourcesPath` and `__dirname`; give it a private process object so
  // the test never touches the real one.
  const sandbox = { process: { resourcesPath }, __dirname: path.join(DESKTOP_ROOT, 'src'), require, module: { exports: {} }, exports: {} };
  sandbox.module.exports = sandbox.exports;
  const vm = require('node:vm');
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  return sandbox.module.exports;
}

/** A disposable resources tree with only the daemon entry the resolver looks for. */
function fakePackagedResources() {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'u18-resources-'));
  const engine = path.join(root, 'engine');
  fs.mkdirSync(path.join(engine, path.dirname(DAEMON_ENTRY_PATH)), { recursive: true });
  fs.writeFileSync(path.join(engine, DAEMON_ENTRY_PATH), 'export {};\n');
  return { root, engine };
}

test('a packaged app resolves the daemon from resourcesPath/engine', () => {
  const packaged = fakePackagedResources();
  try {
    const enginePaths = loadEnginePaths(packaged.root);
    assert.equal(enginePaths.engineRoot(), packaged.engine);
    assert.equal(enginePaths.daemonEntry(), path.join(packaged.engine, DAEMON_ENTRY_PATH));
  } finally {
    fs.rmSync(packaged.root, { recursive: true, force: true });
  }
});

test('a development run resolves the daemon from the checkout', () => {
  // No staged resources, so the packaged branch is not taken even though Electron sets a path.
  const empty = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'u18-empty-'));
  try {
    const enginePaths = loadEnginePaths(empty);
    assert.equal(enginePaths.engineRoot(), path.join(REPOSITORY_ROOT, 'engine'));
    assert.equal(enginePaths.daemonEntry(), path.join(REPOSITORY_ROOT, 'engine', DAEMON_ENTRY_PATH));
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('the packaged tree wins over the checkout when both exist', () => {
  const packaged = fakePackagedResources();
  try {
    // `engine/packages/daemon/dist/index.js` exists in this checkout too, so this is the case a
    // development machine with a staged tree actually runs.
    assert.ok(fs.existsSync(path.join(REPOSITORY_ROOT, 'engine', DAEMON_ENTRY_PATH)));
    const enginePaths = loadEnginePaths(packaged.root);
    assert.notEqual(enginePaths.engineRoot(), path.join(REPOSITORY_ROOT, 'engine'));
  } finally {
    fs.rmSync(packaged.root, { recursive: true, force: true });
  }
});

const staged = fs.existsSync(path.join(RESOURCES_ENGINE, DAEMON_ENTRY_PATH));

test('the staged tree is current with the engine build it was copied from', { skip: !staged && 'resources/engine is not staged; run npm run stage' }, () => {
  // `--check` proves the staged tree is newer than its inputs without rewriting it, so an engine
  // rebuilt after a stale staging fails here instead of shipping an older daemon.
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [path.join(DESKTOP_ROOT, 'scripts', 'stage-engine.mjs'), '--check'],
    { cwd: DESKTOP_ROOT, encoding: 'utf8', stdio: 'pipe' });
  execFileSync(process.execPath, [path.join(DESKTOP_ROOT, 'scripts', 'stage-gh.mjs'), '--check'],
    { cwd: DESKTOP_ROOT, encoding: 'utf8', stdio: 'pipe' });
});

test('the staged engine keeps the relative layout the daemon reads at runtime', { skip: !staged && 'resources/engine is not staged; run npm run stage' }, () => {
  for (const entry of [
    path.join('packages', 'daemon', 'dist', 'index.js'),
    path.join('packages', 'daemon', 'assets', 'claude-team-permissions.cjs'),
    path.join('packages', 'daemon', 'dist', 'builtins', 'workflow-specs', 'basic-loop.yaml'),
    path.join('packages', 'ui', 'dist', 'index.html'),
    path.join('config', 'team', 'lead-protocol.md'),
    path.join('config', 'team', 'roles', 'implementer.md'),
    path.join('config', 'team', 'sections', 'communication.md'),
  ]) {
    assert.ok(fs.existsSync(path.join(RESOURCES_ENGINE, entry)), `resources/engine/${entry} ships`);
  }
});

test('the staged gh is the pinned release and sits where the resolver looks', { skip: !staged && 'resources/engine is not staged; run npm run stage' }, () => {
  const lock = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'engine', 'config', 'toolchain', 'gh-lock.json'), 'utf8'));
  assert.match(lock.windows.amd64, /^[a-f0-9]{64}$/, 'the Windows release is pinned by SHA-256');
  const record = JSON.parse(fs.readFileSync(path.join(RESOURCES_ENGINE, 'plugins', 'github-cli', '.gh-manifest.json'), 'utf8'));
  assert.equal(record.version, lock.version);
  assert.equal(record.archiveSha256, lock.windows.amd64);
  assert.ok(fs.existsSync(path.join(RESOURCES_ENGINE, 'plugins', 'github-cli', 'gh.exe')));
});

test('NOTICE carries the GitHub CLI MIT license', () => {
  const notice = fs.readFileSync(path.join(REPOSITORY_ROOT, 'NOTICE'), 'utf8');
  assert.match(notice, /GitHub CLI/);
  assert.match(notice, /MIT License, Copyright \(c\) 2019 GitHub Inc\./);
  assert.match(notice, /2\.103\.3/);
});