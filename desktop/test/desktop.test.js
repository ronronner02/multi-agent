'use strict';
/**
 * U12 — the desktop window's own boundary: the native folder dialog, the preload surface, the
 * origin rules, and a source scan that proves the WSL path is gone.
 *
 * These drive `src/main.js` in a `vm` context with a mocked Electron, so they run under
 * `node --test` without an Electron binary and without starting anything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const originRules = require('../src/origin.js');
const { dependencyRows } = require('../src/dependencies.js');
const enginePaths = require('../src/engine-paths.js');

const ORIGIN = 'http://127.0.0.1:58123';

/**
 * Build a main.js fixture.
 *
 * @param {object} [options]
 * @param {object} [options.selected] – the folder dialog's answer
 */
function desktop(options = {}) {
  const selected = options.selected ?? { canceled: false, filePaths: [String.raw`D:\Client Work\fixture`] };
  const dialogs = [];
  const loaded = [];
  const ipcHandlers = new Map();
  let options2;
  const contents = {
    mainFrame: { url: `${ORIGIN}/team` }, on() {}, send() {}, setWindowOpenHandler() {}, reload() {},
  };
  class Window {
    constructor(value) { options2 = value; this.webContents = contents; this.destroyed = false; }
    once() {}
    on() {}
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    focus() {}
    loadURL(url) { loaded.push(url); return Promise.resolve(); }
  }
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }),
      getPath: name => name === 'appData' ? path.join('D:', 'ma', 'tmp', 'appData') : path.join('D:', 'ma', 'tmp', 'userData'),
    },
    BrowserWindow: Window,
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
    session: { defaultSession: { cookies: { set: async () => {} }, setPermissionRequestHandler() {} } },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 940 } }) },
    dialog: { showOpenDialog: async (parent, settings) => { dialogs.push({ parent, settings }); return selected; }, showMessageBox: async () => ({ response: 1 }) },
    ipcMain: { handle(channel, fn) { ipcHandlers.set(channel, fn); }, on(channel, fn) { ipcHandlers.set(channel, fn); } },
    shell: { openExternal: async () => {} },
    clipboard: { writeText: () => {} },
  };
  const bridge = {
    startEngine() { throw new Error('these tests do not start the engine'); },
    isRunning: () => false, port: () => null, killEngine: () => {},
  };
  const context = vm.createContext({
    __dirname: path.resolve(__dirname, '../src'),
    URL, console,
    process: { env: {} },
    fetch: async () => ({ ok: false, status: 404, text: async () => '' }),
    AbortSignal: { timeout: () => undefined },
    require: name => {
      if (name === 'electron') return electron;
      if (name === './engine-bridge.js') return bridge;
      if (name === './engine-paths.js') return enginePaths;
      if (name === './origin.js') return originRules;
      if (name === './dependencies.js') return { dependencyRows };
      if (name === 'node:child_process' || name === 'node:worker_threads') throw new Error(`Folder selection must not load ${name}`);
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8'), context);
  vm.runInContext('createWindow(); allowedOrigin = "http://127.0.0.1:58123";', context);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { context, contents, event, dialogs, loaded, ipcHandlers, options: options2,
    pick: (sender = event) => vm.runInContext('pickFolder', context)(sender),
  };
}

function preload(pick = async () => String.raw`D:\Client Work\fixture`) {
  const listeners = new Map(), domListeners = new Map(), storage = new Map(), events = [], writes = [];
  let bridge;
  const status = { phase: 'ready', connected: true, dependencies: [] };
  const document = {
    readyState: 'loading', documentElement: { dataset: {} },
    body: { appendChild: element => writes.push(element) }, head: { appendChild: element => writes.push(element) },
    getElementById: () => null, createElement: () => ({}),
    addEventListener: (name, callback) => domListeners.set(name, callback), dispatchEvent: event => events.push(event),
  };
  const context = vm.createContext({
    document, window: { sessionStorage: { setItem: (key, value) => storage.set(key, value) } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    require: name => {
      assert.equal(name, 'electron'); return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'multiAgentDesktop'); bridge = value; } },
        ipcRenderer: {
          sendSync: channel => { assert.equal(channel, 'desktop:csrf-token'); return 'fixture-session-handoff'; },
          invoke: channel => channel === 'desktop:engine-status' ? Promise.resolve({ running: true, pid: 4321, exit: null })
            : channel === 'desktop:pick-folder' ? pick() : Promise.resolve(status),
          on: (channel, listener) => { const list = listeners.get(channel) ?? []; list.push(listener); listeners.set(channel, list); },
          removeListener: (channel, listener) => listeners.set(channel, listeners.get(channel).filter(item => item !== listener)),
        },
      };
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/preload.js'), 'utf8'), context);
  return { bridge, status, document, storage, events, writes,
    loaded: () => { document.readyState = 'complete'; domListeners.get('DOMContentLoaded')?.(); },
    publish: next => { for (const listener of listeners.get('desktop:state') ?? []) listener({}, next); },
  };
}

test('keeps the native caption overlay aligned with the shared 48px strip and the window sandboxed', () => {
  const fixture = desktop();
  assert.equal(fixture.options.titleBarStyle, 'hidden');
  assert.equal(fixture.options.titleBarOverlay.height, 48);
  assert.equal(fixture.options.titleBarOverlay.color, '#151619');
  assert.equal(fixture.options.webPreferences.contextIsolation, true);
  assert.equal(fixture.options.webPreferences.nodeIntegration, false);
  assert.equal(fixture.options.webPreferences.sandbox, true);
  assert.equal(fixture.options.webPreferences.webSecurity, true);
});

test('the native folder dialog hands the Windows path to the UI unchanged', async () => {
  const fixture = desktop();
  const page = preload(() => fixture.pick());
  assert.equal(await page.bridge.pickFolder(), String.raw`D:\Client Work\fixture`);
  assert.equal(fixture.dialogs.length, 1);
  assert.equal(fixture.dialogs[0].parent.webContents, fixture.contents);
  assert.deepEqual(Array.from(fixture.dialogs[0].settings.properties), ['openDirectory', 'createDirectory']);
});

test('a UNC folder comes back unchanged and cancelling returns null', async () => {
  assert.equal(await desktop({ selected: { canceled: false, filePaths: [String.raw`\\server\share\app`] } }).pick(), String.raw`\\server\share\app`);
  assert.equal(await desktop({ selected: { canceled: true, filePaths: [] } }).pick(), null);
});

test('the picker refuses a different window, a subframe, or another origin before opening', async () => {
  const fixture = desktop();
  await assert.rejects(fixture.pick({ ...fixture.event, sender: {} }));
  await assert.rejects(fixture.pick({ ...fixture.event, senderFrame: { url: `${ORIGIN}/team` } }));
  fixture.contents.mainFrame.url = 'https://example.com/';
  await assert.rejects(fixture.pick());
  fixture.contents.mainFrame.url = 'http://127.0.0.1:7433/team';
  await assert.rejects(fixture.pick());
  assert.equal(fixture.dialogs.length, 0);
});

test('the window may navigate only to the current dynamic origin', () => {
  const allowed = originRules;
  assert.equal(allowed.isAllowedNavigation(`${ORIGIN}/team`, ORIGIN), true);
  assert.equal(allowed.isAllowedNavigation(`${ORIGIN}/team/tasks`, ORIGIN), true);
  assert.equal(allowed.isAllowedNavigation('http://127.0.0.1:7433/team', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('http://127.0.0.1:9999/team', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('http://localhost:58123/team', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('https://example.com/', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('file:///C:/Windows/System32/calc.exe', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('javascript:alert(1)', ORIGIN), false);
  // Before the engine reports an origin there is nothing the window may show.
  assert.equal(allowed.isAllowedNavigation(`${ORIGIN}/team`, null), false);
  assert.equal(allowed.isAllowedNavigation('', ORIGIN), false);
});

test('only the engine this app forked is trusted, not any 200', () => {
  // The daemon's real /healthz shape: no host identity, only its own pid.
  const body = JSON.stringify({
    status: 'ok', pid: 42, eventLoop: { healthy: true }, routeTimings: {}, slowOperations: { healthy: true },
    bind: { mode: 'explicit', hosts: ['127.0.0.1'], tailscaleDetected: false },
  });
  assert.equal(originRules.isDaemonHealth(body, 42), true);
  assert.equal(originRules.isDaemonHealth(body, 43), false, 'another daemon on the port is refused');
  assert.equal(originRules.isDaemonHealth(body), false, 'no reported pid means nothing to match');
  assert.equal(originRules.isDaemonHealth('{"status":"ok"}', 42), false);
  assert.equal(originRules.isDaemonHealth('{"status":"starting","pid":42}', 42), false);
  assert.equal(originRules.isDaemonHealth('<html>hello</html>', 42), false);
  assert.equal(originRules.isDaemonHealth('', 42), false);
});

test('dependency rows carry the resolved Windows path or one install line', () => {
  const rows = dependencyRows([
    { ok: true, client: 'claude', path: String.raw`D:\dev\npm-global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`, source: 'shim' },
    { ok: true, client: 'codex', path: String.raw`D:\dev\codex.exe`, source: 'shim' },
    { ok: true, client: 'git', path: String.raw`D:\git\Git\cmd\git.exe`, source: 'path' },
    { ok: false, client: 'gh', reason: 'not-found', tried: [] },
  ]);
  assert.deepEqual(rows.map(row => row.client), ['git', 'gh', 'claude', 'codex']);
  assert.deepEqual(rows.find(row => row.client === 'git'), { client: 'git', label: 'Git', ok: true, path: String.raw`D:\git\Git\cmd\git.exe` });
  assert.equal(rows.find(row => row.client === 'claude').path, String.raw`D:\dev\npm-global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`);
  const missing = rows.find(row => row.client === 'gh');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-found');
  assert.match(missing.hint, /gh\.exe|cli\.github\.com/);
  assert.equal(missing.path, undefined);
});

test('a client the resolver never reported reads as missing', () => {
  const rows = dependencyRows([]);
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.ok, false);
});

test('preload hands over the anti-forgery token and adds no title bar, footer or padding', async () => {
  const page = preload();
  assert.equal(page.storage.get('multi-agent.desktop.csrf'), 'fixture-session-handoff');
  assert.equal(await page.bridge.status(), page.status);
  const engineStatus = await page.bridge.engineStatus();
  assert.equal(engineStatus.running, true);
  assert.equal(engineStatus.pid, 4321);
  assert.equal(engineStatus.exit, null);
  page.loaded();
  assert.equal(page.document.documentElement.dataset.desktop, 'true');
  const received = [];
  const unsubscribe = page.bridge.onStatus(value => received.push(value));
  page.publish(page.status);
  unsubscribe();
  page.publish({ ...page.status, connected: false });
  assert.equal(received.length, 1);
  assert.equal(page.events[0].type, 'desktop-status');
  assert.equal(page.writes.length, 0);
});

test('preload exposes only the native reconnect action, never the cookie', async () => {
  const page = preload();
  assert.equal(typeof page.bridge.reconnect, 'function');
  assert.equal(await page.bridge.reconnect(), page.status);
  assert.equal(page.bridge.cookie, undefined);
});

test('the engine host adds no listener on the daemon port, so its own answers reach the parent', () => {
  // The daemon owns `parentPort`: it posts readiness and answers mint/dependency requests there,
  // and the Electron main process listens on that same channel. A listener in engine-host.js
  // would consume those answers first, which is exactly how a first-run dependency probe once
  // reported every client as missing while the resolver answered correctly.
  const text = fs.readFileSync(path.resolve(__dirname, '../src/engine-host.js'), 'utf8');
  assert.equal(/parentPort\.on\(/.test(text), false, 'engine-host.js must not listen on the daemon port');
  assert.match(text, /mod\.startServer\(0\)/, 'the daemon still binds an OS-assigned port');
});

test('the desktop source carries no WSL path and no fixed daemon port', () => {
  const source = path.resolve(__dirname, '../src');
  for (const file of fs.readdirSync(source)) {
    const text = fs.readFileSync(path.join(source, file), 'utf8');
    assert.equal(/wsl/i.test(text), false, `${file} must not mention WSL`);
    assert.equal(/\b7433\b/.test(text), false, `${file} must not carry a fixed daemon port`);
  }
  assert.equal(fs.existsSync(path.join(source, 'wsl.js')), false, 'wsl.js is deleted');
});

test('the desktop never starts a process by name, so no wsl.exe can be spawned', () => {
  const source = path.resolve(__dirname, '../src');
  for (const file of fs.readdirSync(source)) {
    const text = fs.readFileSync(path.join(source, file), 'utf8');
    assert.equal(/node:child_process/.test(text), false, `${file} must not spawn a child process directly`);
    assert.equal(/spawn\s*\(/.test(text), false, `${file} must not spawn a child process directly`);
  }
});