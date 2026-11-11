'use strict';
/**
 * Electron utility-process entry for the native daemon.
 *
 * This module runs inside `utilityProcess.fork`. The daemon's own `startServer` reads
 * `process.parentPort` directly: it posts `{type: "ready"}` from its serve() callback, answers
 * `mint-pairing` and `dependencies` requests, and runs its bounded shutdown on `{type: "shutdown"}`.
 * Electron's main process therefore addresses the daemon on this port with exactly those
 * messages, and nothing is relayed in between — a listener here would consume the daemon's
 * answers before the parent could read them.
 *
 * Environment setup (temp homes in tests, the owner's own homes in production) is done by the
 * caller in `engine-bridge.js` before forking.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Resolve the daemon entry point relative to this file.
// Dev layout:  desktop/src/engine-host.js
//              engine/packages/daemon/dist/index.js
const DAEMON_INDEX = path.resolve(__dirname, '../../engine/packages/daemon/dist/index.js');

/** Report a fatal error to the parent before exit. */
function reportError(error) {
  if (!process.parentPort) return;
  try {
    process.parentPort.postMessage({ type: 'crash', error: String(error) });
  } catch {
    // parentPort may be closed; ignore.
  }
}

async function main() {
  try {
    const mod = await import(pathToFileURL(DAEMON_INDEX).href);
    console.error('[engine-host] daemon module loaded, starting on an OS-assigned port');
    await mod.startServer(0);
    console.error('[engine-host] startServer resolved');
  } catch (error) {
    console.error('[engine-host] startServer failed:', error && error.stack ? error.stack : String(error));
    reportError(error);
    process.exit(1);
  }
}

main();