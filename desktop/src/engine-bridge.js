'use strict';
/**
 * Electron main-process bridge for the native utility-process daemon.
 *
 * Responsibilities:
 * - Fork the built daemon entry (engine-host.js) as an Electron utility process.
 * - Pass the data directory, the loopback bind host, and the daemon's environment.
 * - Receive the bound port, the health identity, dependency status, and pairing codes over
 *   `parentPort` IPC.
 * - Expose readiness, exit, and shutdown lifecycle to `main.js`.
 * - On quit: send shutdown to the child, wait for the bounded receipt, then end the child.
 *
 * The `require('electron')` call is lazy so tests that mock it via `vm.runInContext` can load
 * this module without an actual Electron binary.
 */

const path = require('node:path');

/** The forked utility process, or null before and after. */
let child = null;
/** True once the child has exited or been killed. */
let childGone = true;
/** True from the moment this app asked the child to stop, so that exit is expected. */
let stopping = false;
/** The resolved origin port, or null. */
let boundPort = null;
/** Resolver for the readiness promise. */
let resolveReady = null;
let rejectReady = null;
/** U6 — the one in-flight `mint-pairing` request, if any. */
let pendingMint = null;
/** U12 — the one in-flight dependency-status request, if any. */
let pendingDependencies = null;

/** Settle a pending mint request once and clear it. */
function settleMint(error, code) {
  const pending = pendingMint;
  pendingMint = null;
  if (!pending) return;
  clearTimeout(pending.timer);
  if (error) pending.reject(error);
  else pending.resolve(code);
}

/** Settle a pending dependency request once and clear it. */
function settleDependencies(error, resolutions) {
  const pending = pendingDependencies;
  pendingDependencies = null;
  if (!pending) return;
  clearTimeout(pending.timer);
  if (error) pending.reject(error);
  else pending.resolve(resolutions);
}

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
 * @param {object} opts.env      – the daemon's environment (the owner's own, plus managed overrides)
 * @param {(exit: { code: number|null, reason: string }) => void} [opts.onExit]
 *   called for every child exit; `main.js` decides which exits were unexpected
 * @returns {{ ready: Promise<{ port: number, pid: number }>, shutdown: () => Promise<void>,
 *             mintPairing: () => Promise<string>, dependencies: () => Promise<unknown[]> }}
 */
function startEngine(opts) {
  const { dataDir, env, onExit } = opts;

  // Lazy require so tests can mock electron.
  const electron = require('electron');

  // The entry that runs inside the utility child.
  const entry = path.resolve(__dirname, 'engine-host.js');

  childGone = false;
  stopping = false;
  child = electron.utilityProcess.fork(entry, [], {
    env,
    execArgv: [],
    serviceName: 'multi-agent-daemon',
    stdio: 'pipe',
  });

  // Forward the daemon's own output so a startup failure is visible in the desktop log rather
  // than silent.
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
    // U6 — the daemon's answer to a `mint-pairing` request. The code is handed straight back to
    // the caller and never logged; on failure only the error name is reported.
    if (message.type === 'pairing-code') settleMint(null, message.code);
    if (message.type === 'pairing-error') settleMint(new Error(message.error || 'pairing_mint_failed'));
    // U12 — first-run dependency status, resolved by the daemon's own resolver.
    if (message.type === 'dependencies') settleDependencies(null, message.resolutions);
    if (message.type === 'dependencies-error') settleDependencies(new Error(message.error || 'dependency_probe_failed'));
  });

  child.on('exit', (code) => {
    const expected = stopping;
    childGone = true;
    child = null;
    boundPort = null;
    settleReady(new Error(`Daemon exited with code ${code} before ready`));
    settleMint(new Error('Daemon exited during pairing mint'));
    settleDependencies(new Error('Daemon exited during the dependency probe'));
    if (!expected && typeof onExit === 'function') onExit({ code, reason: `exit code ${code}` });
  });

  const shutdown = async () => {
    if (childGone || !child) return;
    stopping = true;
    const current = child;
    // Ask the daemon to run its own bounded shutdown (receipt included).
    try { current.postMessage({ type: 'shutdown' }); } catch { /* child already gone */ }
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 12_000);
      current.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    // End the child if the bounded wait did not.
    if (!childGone && current) {
      try { current.kill(); } catch { /* already gone */ }
    }
    childGone = true;
    child = null;
    boundPort = null;
    settleMint(new Error('Daemon stopped during pairing mint'));
    settleDependencies(new Error('Daemon stopped during the dependency probe'));
  };

  /**
   * Mint one one-time pairing code over the private parent channel.
   *
   * Only the daemon's own parent process can reach this port, so the code never has to travel
   * over HTTP or sit in an environment variable. The returned value is the raw code; the caller
   * exchanges it and must never log it or put it in a URL.
   */
  const mintPairing = () => {
    if (childGone || !child) return Promise.reject(new Error('Daemon is not running'));
    if (pendingMint) return Promise.reject(new Error('A pairing mint is already in flight'));
    const current = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settleMint(new Error('Pairing mint timed out')), 10_000);
      pendingMint = { resolve, reject, timer };
      try { current.postMessage({ type: 'mint-pairing' }); } catch (error) { settleMint(error); }
    });
  };

  /**
   * Ask the daemon what it resolved for `git`, `gh`, `claude` and `codex`.
   *
   * The daemon answers with its own resolver's output (U1), so the first-run page shows the same
   * paths a worker launch will use. Nothing is resolved a second time in Electron.
   */
  const dependencies = () => {
    if (childGone || !child) return Promise.reject(new Error('Daemon is not running'));
    if (pendingDependencies) return Promise.reject(new Error('A dependency probe is already in flight'));
    const current = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settleDependencies(new Error('Dependency probe timed out')), 10_000);
      pendingDependencies = { resolve, reject, timer };
      try { current.postMessage({ type: 'dependencies' }); } catch (error) { settleDependencies(error); }
    });
  };

  return { ready, shutdown, mintPairing, dependencies };
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
  settleMint(new Error('Daemon killed during pairing mint'));
  settleDependencies(new Error('Daemon killed during the dependency probe'));
}

module.exports = { startEngine, isRunning, port, killEngine };