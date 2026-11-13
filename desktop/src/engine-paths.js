'use strict';
/**
 * Where the engine lives, packaged and in a checkout (U18).
 *
 * The installer ships the engine tree at `resources/engine` next to `app.asar`, so a packaged
 * app resolves the daemon from `process.resourcesPath`. A development run resolves the same
 * relative layout from this file: `desktop/src/` is two levels below the repository root, and
 * `engine/packages/daemon/dist/index.js` sits under it. Both are the same build output; only the
 * root differs.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The daemon entry inside a staged or packaged engine tree, relative to its root. */
const DAEMON_ENTRY_PATH = path.join('packages', 'daemon', 'dist', 'index.js');

/**
 * The engine root this process can actually run.
 *
 * The packaged tree wins whenever it is present, because that is the build the installer shipped.
 * A development checkout only applies when `resources/engine` has not been staged, which is the
 * case for the plain `electron .` loop.
 */
function engineRoot() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'engine');
    if (fs.existsSync(path.join(packaged, DAEMON_ENTRY_PATH))) return packaged;
  }
  return path.resolve(__dirname, '..', '..', 'engine');
}

/** The daemon module the utility process imports. */
function daemonEntry() {
  return path.join(engineRoot(), DAEMON_ENTRY_PATH);
}

module.exports = { engineRoot, daemonEntry };