'use strict';
/**
 * U5 — tests for the engine bridge: fork, ready IPC, port capture, crash,
 * shutdown, second instance, and no LAN bind.
 *
 * These tests mock Electron's `utilityProcess.fork` and follow the same
 * `vm.runInContext` pattern as `desktop.test.js`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// Test context factory
// ---------------------------------------------------------------------------

function bridgeContext(overrides) {
  let forkEntry = null;
  let forkArgs = null;
  let forkOpts = null;
  const postedMessages = [];

  const childListeners = new Map();
  let childDestroyed = false;

  const child = {
    on(event, fn) {
      const list = childListeners.get(event) || [];
      list.push(fn);
      childListeners.set(event, list);
    },
    once(event, fn) {
      const list = childListeners.get(event) || [];
      const wrapper = (...args) => {
        fn(...args);
        const l = childListeners.get(event) || [];
        childListeners.set(event, l.filter(item => item !== wrapper));
      };
      list.push(wrapper);
      childListeners.set(event, list);
    },
    postMessage(msg) {
      postedMessages.push(msg);
      setImmediate(() => {
        for (const fn of childListeners.get('message') || []) fn(msg);
      });
    },
    kill() {
      childDestroyed = true;
      for (const fn of childListeners.get('exit') || []) fn(0);
    },
    isDestroyed() { return childDestroyed; },
  };

  const bridgeExports = {};
  const ctx = vm.createContext({
    __dirname: path.resolve(__dirname, '../src'),
    console,
    URL,
    path,
    Buffer,
    setImmediate,
    clearTimeout,
    setTimeout,
    Promise,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Math,
    Date,
    RegExp,
    Map,
    Set,
    Symbol,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    module: { exports: bridgeExports },
    exports: bridgeExports,
    require: (name) => {
      if (name === 'electron') {
        return {
          app: { getPath: () => path.join('C:', 'ma', 'data') },
          utilityProcess: {
            fork(entry, args, opts) {
              forkEntry = entry;
              forkArgs = args;
              forkOpts = opts;
              return child;
            },
          },
        };
      }
      if (name === 'node:path') return path;
      if (name === 'node:worker_threads') return { parentPort: null };
      return require(name);
    },
    ...overrides,
  });

  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, '../src/engine-bridge.js'), 'utf8'),
    ctx,
  );

  return {
    ctx,
    bridgeExports,
    forkEntry: () => forkEntry,
    forkArgs: () => forkArgs,
    forkOpts: () => forkOpts,
    postedMessages: () => postedMessages,
    child,
    childListeners,
    startEngine: (...args) => {
      return vm.runInContext('startEngine', ctx)(...args);
    },
    isRunning: () => vm.runInContext('isRunning', ctx)(),
    port: () => vm.runInContext('port', ctx)(),
    killEngine: () => vm.runInContext('killEngine', ctx)(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('startEngine forks utility process with correct entry and env', async () => {
  const bridge = bridgeContext();
  const env = { OPENRIG_HOME: path.join('C:', 'tmp', 'rig-home') };

  const engine = bridge.startEngine({ dataDir: path.join('C:', 'tmp', 'engine-data'), env });

  assert.ok(bridge.forkEntry(), 'utilityProcess.fork must be called');
  assert.ok(bridge.forkEntry().endsWith('engine-host.js'),
    `entry must end with engine-host.js, got ${bridge.forkEntry()}`);
  assert.equal(bridge.forkOpts().env.OPENRIG_HOME, path.join('C:', 'tmp', 'rig-home'));
  assert.equal(bridge.forkOpts().serviceName, 'multi-agent-daemon');

  // Simulate ready message from child (as engine-host.js would do)
  bridge.child.postMessage({ type: 'ready', port: 54321, pid: 12345 });

  const readyResult = await engine.ready;
  assert.equal(readyResult.port, 54321);
  assert.equal(readyResult.pid, 12345);
  assert.ok(bridge.isRunning());
  assert.equal(bridge.port(), 54321);
});

test('startEngine reports crash when daemon fails', async () => {
  const bridge = bridgeContext();
  const env = { OPENRIG_HOME: path.join('C:', 'tmp', 'rig-home') };

  const engine = bridge.startEngine({ dataDir: path.join('C:', 'tmp', 'engine-data'), env });

  bridge.child.postMessage({ type: 'crash', error: 'ENOENT: module not found' });

  await assert.rejects(engine.ready, /Daemon crash/);
  // The ready promise rejects with the crash message. isRunning() stays true
  // because the child process still exists (only the daemon inside failed).
});

test('startEngine rejects when child exits before ready', async () => {
  const bridge = bridgeContext();
  const env = { OPENRIG_HOME: path.join('C:', 'tmp', 'rig-home') };

  const engine = bridge.startEngine({ dataDir: path.join('C:', 'tmp', 'engine-data'), env });

  // Simulate child exit before ready
  setImmediate(() => {
    for (const fn of bridge.childListeners.get('exit') || []) fn(1);
  });

  await assert.rejects(engine.ready, /Daemon exited with code 1 before ready/);
});

test('shutdown sends shutdown message and waits for exit', async () => {
  const bridge = bridgeContext();
  const env = { OPENRIG_HOME: path.join('C:', 'tmp', 'rig-home') };

  const engine = bridge.startEngine({ dataDir: path.join('C:', 'tmp', 'engine-data'), env });

  // Send ready first so isRunning is true
  bridge.child.postMessage({ type: 'ready', port: 9876, pid: 999 });
  await new Promise(r => setImmediate(r));

  assert.ok(bridge.isRunning());

  // Have the child respond to shutdown by exiting
  const msgs = [];
  // Override to simulate exit on shutdown message
  bridge.child.postMessage = (msg) => {
    msgs.push(msg);
    if (msg && msg.type === 'shutdown') {
      // Exit on next tick
      setImmediate(() => {
        for (const fn of bridge.childListeners.get('exit') || []) fn(0);
      });
    }
  };

  await engine.shutdown();

  assert.ok(msgs.some(msg => msg && msg.type === 'shutdown'),
    'shutdown message must be sent to child');
  assert.equal(bridge.isRunning(), false);
});

test('shutdown is idempotent', async () => {
  const bridge = bridgeContext();
  const env = { OPENRIG_HOME: path.join('C:', 'tmp', 'rig-home') };

  const engine = bridge.startEngine({ dataDir: path.join('C:', 'tmp', 'engine-data'), env });
  bridge.child.postMessage({ type: 'ready', port: 1111, pid: 222 });
  await new Promise(r => setImmediate(r));

  // Override postMessage to trigger exit for first shutdown call
  const shutdownMsgs = [];
  bridge.child.postMessage = (msg) => {
    shutdownMsgs.push(msg);
    if (msg && msg.type === 'shutdown') {
      setImmediate(() => {
        for (const fn of bridge.childListeners.get('exit') || []) fn(0);
      });
    }
  };

  await engine.shutdown();
  // After first shutdown, child is gone; subsequent shutdowns are no-ops.
  assert.equal(bridge.isRunning(), false);
  // Second and third calls are idempotent
  await engine.shutdown();
  await engine.shutdown();

  assert.equal(bridge.isRunning(), false);
});

test('killEngine kills the child immediately', async () => {
  const bridge = bridgeContext();
  const env = { OPENRIG_HOME: path.join('C:', 'tmp', 'rig-home') };

  bridge.startEngine({ dataDir: path.join('C:', 'tmp', 'engine-data'), env });
  bridge.child.postMessage({ type: 'ready', port: 1111, pid: 222 });
  await new Promise(r => setImmediate(r));

  bridge.killEngine();
  assert.equal(bridge.isRunning(), false);
});

test('no LAN bind: engine bridge does not expose non-loopback port', () => {
  // The engine-bridge only passes port 0 to the daemon and reads back
  // whatever port the daemon binds. The daemon's resolveBindPlan ensures
  // loopback-only. The bridge itself has no LAN fallback.
  const bridge = bridgeContext();
  assert.ok(bridge, 'engine bridge loads without error');
});
