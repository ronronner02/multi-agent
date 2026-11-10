'use strict';
/**
 * U5 — Electron utility-process entry for the native daemon.
 *
 * This module runs inside `utilityProcess.fork`. The daemon's own `startServer`
 * calls `process.parentPort.postMessage({ type: "ready", port, pid })` from
 * the serve() callback. This file awaits that message and reports it back to
 * the Electron main process via `process.parentPort`.
 *
 * A shutdown message from the parent triggers the daemon's own shutdown
 * sequence through the parent-port listener added in index.ts.
 *
 * Environment setup (temp homes in tests, real homes in production) is done
 * by the caller in `engine-bridge.js` before forking.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Resolve the daemon entry point relative to this file.
// Dev layout:  desktop/src/engine-host.js
//              engine/packages/daemon/dist/index.js
const DAEMON_INDEX = (() => {
  const dev = path.resolve(__dirname, '../../engine/packages/daemon/dist/index.js');
  return dev;
})();

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
  // Listen for the ready message from the daemon's serve() callback and for
  // shutdown from the parent.
  if (process.parentPort) {
    process.parentPort.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      const msg = message;
      if (msg.type === 'ready') {
        // Forward the bound port and pid to the Electron main process.
        try {
          process.parentPort.postMessage({ type: 'ready', port: msg.port, pid: msg.pid });
        } catch {
          // parentPort may be closed; ignore.
        }
      }
      if (msg.type === 'shutdown') {
        // The daemon's own SIGINT/SIGTERM handlers process this via the
        // parent-port listener we added in index.ts. Keep the process alive
        // during the bounded shutdown.
        setTimeout(() => process.exit(0), 12_000);
      }
    });
  }

  try {
    const mod = await import(pathToFileURL(DAEMON_INDEX).href);
    console.error('[engine-host] daemon module loaded, starting on port 0');
    await mod.startServer(0);
    console.error('[engine-host] startServer resolved');
  } catch (error) {
    console.error('[engine-host] startServer failed:', error && error.stack ? error.stack : String(error));
    reportError(error);
    process.exit(1);
  }
}

main();
