'use strict';
/**
 * U5 — Electron main-process bridge for the native utility-process daemon.
 *
 * Responsibilities:
 * - Fork the built daemon entry (engine-host.js) as an Electron utility process.
 * - Pass temp-home environment and 127.0.0.1:0.
 * - Receive the bound port and health identity over `parentPort` IPC.
 * - Expose readiness, crash, and shutdown lifecycle to `main.js`.
 * - On quit: send shutdown to the child, wait for the bounded receipt,
 *   then tree-kill any survivors.
 *
 * The `require('electron')` call is lazy so tests that mock it via
 * `vm.runInContext` can load this module without an actual Electron binary.
 */

const path = require('node:path');

/** The forked utility process, or null before and after. */
let child = null;
/** True once the child has exited or been killed. */
let childGone = true;
/** The resolved port, or null. */
let boundPort = null;
/** Resolver for the readiness promise. */
let resolveReady = null;
let rejectReady = null;

function readinessFuture() {
  return new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
}

/** Settle a pending readiness promise once and clear the pair. */
function settleReady(error, value) {
  const resolve = resolveReady;
  const reject = rejectReady;
  resolveReady = null;
  rejectReady = null;
  if (error) { if (reject) reject(error); }
  else if (resolve) resolve(value);
}

/**
 * Fork the daemon as a utility process.
 *
 * @param {object} opts
 * @param {string} opts.dataDir  – the daemon's mutable state directory
 * @param {object} opts.env      – env with temp OPENRIG_HOME, CODEX_HOME, etc.
 * @returns {{ ready: Promise<{ port: number, pid: number }>, shutdown: () => Promise<void> }}
 */
function startEngine(opts) {
  const { dataDir, env } = opts;

  // Lazy require so tests can mock electron.
  const electron = require('electron');

  // The entry that runs inside the utility child.
  const entry = path.resolve(__dirname, 'engine-host.js');

  childGone = false;
  child = electron.utilityProcess.fork(entry, [], {
    env,
    execArgv: [],
    serviceName: 'multi-agent-daemon',
    stdio: 'pipe',
  });

  // Forward the daemon's own output so a startup failure is visible in the
  // desktop log rather than silent.
  if (child.stdout) child.stdout.on('data', (chunk) => { try { process.stdout.write(`[daemon] ${chunk}`); } catch { /* ignore */ } });
  if (child.stderr) child.stderr.on('data', (chunk) => { try { process.stderr.write(`[daemon] ${chunk}`); } catch { /* ignore */ } });

  const ready = readinessFuture();

  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      boundPort = message.port;
      settleReady(null, { port: message.port, pid: message.pid });
    }
    if (message.type === 'crash') {
      settleReady(new Error(`Daemon crash: ${message.error}`));
    }
  });

  child.on('exit', (code) => {
    childGone = true;
    child = null;
    boundPort = null;
    settleReady(new Error(`Daemon exited with code ${code} before ready`));
  });

  const shutdown = async () => {
    if (childGone || !child) return;
    const current = child;
    // Ask the daemon to run its own bounded shutdown (receipt included).
    try { current.postMessage({ type: 'shutdown' }); } catch { /* child already gone */ }
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 12_000);
      current.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    // Terminate any survivor tree after the bounded wait.
    if (!childGone && current) {
      try { current.kill(); } catch { /* already gone */ }
    }
    childGone = true;
    child = null;
    boundPort = null;
  };

  return { ready, shutdown };
}

/**
 * Whether the engine is currently running.
 */
function isRunning() {
  return !childGone && child !== null;
}

/**
 * The bound port, or null.
 */
function port() {
  return boundPort;
}

/**
 * Force-kill the utility process immediately.
 */
function killEngine() {
  if (!childGone && child) {
    try { child.kill(); } catch { /* already gone */ }
  }
  childGone = true;
  child = null;
  boundPort = null;
}

module.exports = { startEngine, isRunning, port, killEngine };
