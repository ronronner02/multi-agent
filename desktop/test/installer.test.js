'use strict';
/**
 * U18 — installer lifecycle: install over an earlier version, then uninstall.
 *
 * This test runs the NSIS artifact, so it is opt-in: it writes an HKCU uninstall entry, creates
 * Start Menu shortcuts and needs a built installer, and the owner's machine already has a
 * Multi-Agent install that must not be disturbed. Run it only in the isolated profile the plan's
 * installer smoke owns:
 *
 *   MULTI_AGENT_INSTALLER_SMOKE=1 \
 *   MULTI_AGENT_INSTALLER_N=<path to nsis artifact> \
 *   MULTI_AGENT_INSTALLER_N_PLUS_ONE=<path to the next artifact> \
 *   node --test test/installer.test.js
 *
 * Both installers are silent-installed into a scratch directory under the run temp root, with
 * LOCALAPPDATA and APPDATA redirected there too, so no user data or product install outside that
 * root is touched. The assertions are the plan's: binaries are replaced on upgrade, the two data
 * roots and their recovery records survive both upgrade and uninstall, and uninstall removes the
 * program directory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const versionN = process.env.MULTI_AGENT_INSTALLER_N;
const versionNPlusOne = process.env.MULTI_AGENT_INSTALLER_N_PLUS_ONE;
const enabled = process.env.MULTI_AGENT_INSTALLER_SMOKE === '1' && versionN && versionNPlusOne;

const skipReason = !enabled
  ? 'installer smoke is opt-in: it installs an artifact and writes an HKCU uninstall entry'
  : false;

/** The scratch profile the installers and their data roots share. */
function scratchProfile() {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'u18-installer-'));
  const profile = {
    root,
    program: path.join(root, 'program'),
    localAppData: path.join(root, 'LocalAppData'),
    appData: path.join(root, 'AppData'),
  };
  for (const directory of [profile.program, profile.localAppData, profile.appData]) fs.mkdirSync(directory, { recursive: true });
  return profile;
}

/** The environment the installer and the product's own paths see. */
function installerEnv(profile) {
  return {
    ...process.env,
    LOCALAPPDATA: profile.localAppData,
    APPDATA: profile.appData,
    // NSIS writes its HKCU uninstall entry under the current user; the scratch roots above keep
    // the product's data and program files away from the owner's own install.
  };
}

/** Run one NSIS artifact silently into the scratch program directory. */
function install(artifact, profile) {
  assert.ok(fs.existsSync(artifact), `installer exists: ${artifact}`);
  execFileSync(artifact, ['/S', `/D=${profile.program}`], { env: installerEnv(profile), windowsHide: true, stdio: 'ignore' });
}

/** Write the two data roots and a recovery record the way a stopped run leaves them. */
function seedUserData(profile) {
  const state = path.join(profile.localAppData, 'Multi-Agent');
  const config = path.join(profile.appData, 'Multi-Agent');
  fs.mkdirSync(path.join(state, 'engine', 'state'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(state, 'engine', 'state', 'marker.json'), JSON.stringify({ projects: 1 }));
  fs.writeFileSync(path.join(state, 'engine', 'state', 'recovery-record.json'), JSON.stringify({ interrupted: 1 }));
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ ui: { enabled: true } }));
  return { state, config };
}

const requiredBinaries = [
  'Multi-Agent.exe',
  path.join('resources', 'engine', 'packages', 'daemon', 'dist', 'index.js'),
  path.join('resources', 'engine', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node'),
  path.join('resources', 'engine', 'plugins', 'github-cli', 'gh.exe'),
];

test('install N, upgrade to N+1, then uninstall: binaries are replaced and user data survives', { skip: skipReason, timeout: 600_000 }, () => {
  const profile = scratchProfile();
  try {
    install(versionN, profile);
    for (const relative of requiredBinaries) {
      assert.ok(fs.existsSync(path.join(profile.program, relative)), `version N ships ${relative}`);
    }
    const previousBinary = fs.statSync(path.join(profile.program, 'Multi-Agent.exe')).mtimeMs;

    const data = seedUserData(profile);

    // A quieter future: the N+1 binary must replace the installed one, not coexist with it.
    install(versionNPlusOne, profile);
    for (const relative of requiredBinaries) {
      assert.ok(fs.existsSync(path.join(profile.program, relative)), `version N+1 ships ${relative}`);
    }
    assert.notEqual(fs.statSync(path.join(profile.program, 'Multi-Agent.exe')).mtimeMs, previousBinary,
      'the upgrade replaced the executable');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data.state, 'engine', 'state', 'marker.json'), 'utf8')), { projects: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data.state, 'engine', 'state', 'recovery-record.json'), 'utf8')), { interrupted: 1 },
      'the interrupted attempt record survives the upgrade');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data.config, 'config.json'), 'utf8')), { ui: { enabled: true } });

    // Uninstall. The generated uninstaller's name is product-version dependent, so find it.
    const uninstaller = fs.readdirSync(profile.program).find(name => /^Uninstall .*\.exe$/i.test(name));
    assert.ok(uninstaller, 'the installer writes an uninstaller');
    execFileSync(path.join(profile.program, uninstaller), ['/S'], { env: installerEnv(profile), windowsHide: true, stdio: 'ignore' });

    assert.equal(fs.existsSync(path.join(profile.program, 'Multi-Agent.exe')), false, 'uninstall removed the program files');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data.state, 'engine', 'state', 'recovery-record.json'), 'utf8')), { interrupted: 1 },
      'the recovery record survives the uninstall');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data.config, 'config.json'), 'utf8')), { ui: { enabled: true } },
      'the configuration survives the uninstall');
  } finally {
    fs.rmSync(profile.root, { recursive: true, force: true });
  }
});

test('the NSIS artifact is per-user and keeps app data on uninstall', { timeout: 30_000 }, () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.match(config, /oneClick: false/, 'the installer is assisted, not one-click');
  assert.match(config, /perMachine: false/, 'the install is per user');
  assert.match(config, /deleteAppDataOnUninstall: false/, 'uninstall keeps %LOCALAPPDATA% and %APPDATA% data');
  assert.match(config, /publish: null/, 'publishing is disabled');
  // The bundled executable is a real file under the extraResources tree, not an asar entry.
  assert.match(config, /from: resources\/engine\n\s+to: engine/);
  assert.match(config, /github-cli/, 'the bundled gh.exe stays a real shipped file');
  assert.match(config, /- x64/, 'the shipped architecture is x64 only');
});