'use strict';
/**
 * U12 — the native desktop startup path at the desktop level: the engine starts after app
 * readiness, the window loads the dynamic origin already paired, the first-run dependency list
 * reaches the page, second-instance focuses the existing window, an unexpected engine exit shows
 * a reconnect action, Stop engine leaves no child, and quitting runs the bounded shutdown.
 *
 * These drive `src/main.js` in a `vm` context with a mocked Electron and a mocked
 * `engine-bridge.js`, so they run under `node --test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const originRules = require('../src/origin.js');
const { dependencyRows } = require('../src/dependencies.js');

const PORT = 58123;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function nativeDesktop(opts = {}) {
  const ready = opts.ready ?? { port: PORT, pid: 4321 };
  const runningAttempts = opts.runningAttempts ?? 0;
  const loaded = [];
  const messageBoxes = [];
  const lifecycle = new Map();
  const contentsHandlers = new Map();
  const windowHandlers = new Map();
  const ipcHandlers = new Map();
  const cookies = [];
  const clipboardWrites = [];
  const externalUrls = [];
  const mints = [];
  let capturedMenu = null;
  let windowOptions = null;
  let bridgeShutdowns = 0;
  let started = 0;
  let exitListener = null;
  let mintIndex = 0;
  const mintCode = opts.mintCode || (() => 'M'.repeat(40) + String(++mintIndex).padStart(3, '0'));

  const mainFrame = { url: 'file:///first-run.html' };
  const contents = {
    mainFrame,
    on(event, fn) { contentsHandlers.set(event, fn); },
    send() {},
    setWindowOpenHandler() {},
    reload() {},
    getURL() { return mainFrame.url; },
  };

  class Window {
    constructor(value) { windowOptions = value; this.webContents = contents; this.destroyed = false; }
    once() {}
    on(event, fn) { windowHandlers.set(event, fn); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    focus() { this.focused = true; }
    show() {}
    close() { this.destroyed = true; }
    loadURL(url) { loaded.push(url); return Promise.resolve(); }
  }

  const app = {
    requestSingleInstanceLock: () => true,
    on(event, fn) { lifecycle.set(event, fn); },
    whenReady: () => Promise.resolve(),
    quit() {},
    getPath: name => name === 'appData' ? path.join('D:', 'ma', 'tmp', 'appData') : path.join('D:', 'ma', 'tmp', 'userData'),
  };

  const electron = {
    app,
    BrowserWindow: Window,
    session: { defaultSession: { cookies: { set: async (cookie) => { cookies.push(cookie); } }, setPermissionRequestHandler() {} } },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 940 } }) },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async (...args) => { const box = args.length === 2 ? args[1] : args[0]; messageBoxes.push(box); return { response: opts.closeResponse ?? 1 }; },
    },
    ipcMain: {
      handle(channel, fn) { ipcHandlers.set(channel, fn); },
      on(channel, fn) { ipcHandlers.set(channel, fn); },
    },
    Menu: { buildFromTemplate: (template) => { capturedMenu = template; return {}; }, setApplicationMenu() {} },
    shell: { openExternal: async (url) => { externalUrls.push(url); } },
    clipboard: { writeText: (text) => { clipboardWrites.push(text); } },
  };

  const resolutions = opts.resolutions ?? [
    { ok: true, client: 'claude', path: String.raw`D:\claude.exe`, source: 'shim' },
    { ok: true, client: 'codex', path: String.raw`D:\codex.exe`, source: 'shim' },
    { ok: true, client: 'git', path: String.raw`D:\git.exe`, source: 'path' },
    { ok: false, client: 'gh', reason: 'not-found', tried: [] },
  ];
  const bridge = {
    startEngine(args) {
      started += 1;
      bridge.lastStartArgs = args;
      exitListener = args.onExit;
      return {
        ready: opts.readyError ? Promise.reject(opts.readyError) : Promise.resolve(ready),
        shutdown: async () => { bridgeShutdowns += 1; },
        mintPairing: async () => { const code = mintCode(); mints.push(code); return code; },
        dependencies: async () => { if (opts.dependenciesError) throw opts.dependenciesError; return resolutions; },
      };
    },
    isRunning: () => true,
    port: () => (ready ? ready.port : null),
    killEngine: () => {},
  };

  const defaultText = JSON.stringify({ status: 'ok', pid: 4321, runningAttempts });
  const exchangeRequests = [];
  const defaultFetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/healthz')) return { ok: true, status: 200, text: async () => defaultText };
    if (href.includes('/api/team-control/owner-session/exchange')) {
      exchangeRequests.push({ url: href, init });
      return {
        ok: true, status: 200,
        headers: { get: (name) => String(name).toLowerCase() === 'set-cookie'
          ? 'multi_agent_owner=COOKIE_' + 'X'.repeat(36) + '; HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200' : null },
        json: async () => ({ antiForgeryToken: 'C'.repeat(43) }),
      };
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };

  const context = vm.createContext({
    __dirname: path.resolve(__dirname, '../src'),
    URL, console,
    process: { env: { HOME: 'D:\\Users\\testuser', USERPROFILE: 'D:\\Users\\testuser', CODEX_HOME: 'D:\\Users\\testuser\\.codex', CLAUDE_CONFIG_DIR: 'D:\\Users\\testuser\\.claude' } },
    fetch: opts.fetch || defaultFetch,
    AbortSignal: { timeout: () => undefined },
    setTimeout, clearTimeout,
    require: name => {
      if (name === 'electron') return electron;
      if (name === './engine-bridge.js') return bridge;
      if (name === './origin.js') return originRules;
      if (name === './dependencies.js') return { dependencyRows };
      if (name === 'node:child_process') throw new Error('No process in these tests');
      if (name === 'node:fs') {
        return { existsSync: () => opts.engineEntryExists !== false, mkdirSync() {}, writeFileSync() {}, readFileSync: fs.readFileSync };
      }
      return require(name);
    },
  });

  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8'), context);

  return {
    context, electron, bridge, loaded, messageBoxes, lifecycle, contentsHandlers, windowHandlers, ipcHandlers, contents, mainFrame,
    cookies, clipboardWrites, externalUrls, mints, exchangeRequests,
    options: () => windowOptions,
    started: () => started,
    bridgeShutdowns: () => bridgeShutdowns,
    state: () => vm.runInContext('state', context),
    nativeEngine: () => vm.runInContext('engine', context),
    engineExit: () => vm.runInContext('engineExit', context),
    allowedOrigin: () => vm.runInContext('allowedOrigin', context),
    window: () => vm.runInContext('window', context),
    exit: () => exitListener,
    close: () => windowHandlers.get('close'),
    lastEnv: () => bridge.lastStartArgs ? bridge.lastStartArgs.env : null,
    menuItem: (label) => (capturedMenu || []).flatMap(item => item.submenu || []).find(item => item.label === label),
  };
}

// Let the async startup chain (fork → ready → health → probe → mint → exchange → load) settle.
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); };

test('the engine starts after app readiness and the window loads the dynamic origin', async () => {
  const fixture = nativeDesktop();
  await settle();
  assert.equal(fixture.started(), 1, 'the bridge must fork exactly one daemon');
  assert.ok(fixture.loaded.some(url => url === `${ORIGIN}/team`),
    `the window must load the dynamic origin, got ${JSON.stringify(fixture.loaded)}`);
  assert.equal(fixture.allowedOrigin(), ORIGIN);
  assert.equal(fixture.state().phase, 'ready');
});

test('the dynamic origin is the only origin the window may navigate to', async () => {
  const fixture = nativeDesktop();
  await settle();
  const navigate = fixture.contentsHandlers.get('will-navigate');
  let prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, `${ORIGIN}/team`);
  assert.equal(prevented, false, 'the dynamic origin must be allowed');
  navigate({ preventDefault: () => { prevented = true; } }, 'http://127.0.0.1:7433/team');
  assert.equal(prevented, true, 'a fixed origin must not be trusted');
});

test('the window pairs over the private parent channel and only the anti-forgery token reaches it', async () => {
  const fixture = nativeDesktop();
  await settle();
  const [code] = fixture.mints;
  assert.equal(fixture.mints.length, 1, 'the desktop mints exactly one code for the window');
  assert.ok(code, 'a one-time code was minted');

  const [exchange] = fixture.exchangeRequests;
  assert.ok(exchange, 'the code is exchanged over HTTP');
  assert.equal(exchange.url, `${ORIGIN}/api/team-control/owner-session/exchange`);
  assert.ok(!exchange.url.includes(code), 'the code never appears in the exchange URL');
  assert.equal(exchange.init.headers.Origin, ORIGIN);
  assert.equal(exchange.init.headers['Sec-Fetch-Site'], 'same-origin');
  assert.deepEqual(JSON.parse(exchange.init.body), { code });

  assert.equal(fixture.cookies.length, 1, 'the HttpOnly cookie goes into the window jar');
  const [cookie] = fixture.cookies;
  assert.equal(cookie.name, 'multi_agent_owner');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'strict');
  assert.equal(cookie.path, '/api');
  assert.equal(cookie.url, ORIGIN);

  assert.ok(fixture.loaded.some(url => url === `${ORIGIN}/team`));
  assert.equal(fixture.state().phase, 'ready');
  assert.ok(!JSON.stringify(fixture.state()).includes(code), 'the code never reaches the renderer state');
});

test('the first-run page receives the dependency list with resolved paths and a missing hint', async () => {
  const fixture = nativeDesktop();
  await settle();
  const dependencies = fixture.state().dependencies;
  assert.ok(Array.isArray(dependencies) && dependencies.length === 4, `the page must receive the dependency list, got ${JSON.stringify(dependencies)}`);
  assert.deepEqual(dependencies.map(row => row.client), ['git', 'gh', 'claude', 'codex']);
  assert.equal(dependencies.find(row => row.client === 'claude').path, String.raw`D:\claude.exe`);
  assert.equal(dependencies.find(row => row.client === 'gh').ok, false);
  assert.match(dependencies.find(row => row.client === 'gh').hint, /gh\.exe|cli\.github\.com/);
});

test('a dependency probe failure still lets the window connect', async () => {
  const fixture = nativeDesktop({ dependenciesError: new Error('dependency probe failed') });
  await settle();
  assert.deepEqual(fixture.state().dependencies.map(row => row.ok), [false, false, false, false]);
  assert.equal(fixture.state().phase, 'ready');
});

test('the engine env keeps the parent HOME, USERPROFILE, CODEX_HOME and CLAUDE_CONFIG_DIR', async () => {
  const fixture = nativeDesktop();
  await settle();
  const env = fixture.lastEnv();
  assert.ok(env, 'startEngine must have been called');
  assert.equal(env.HOME, 'D:\\Users\\testuser', 'HOME must pass through from the parent');
  assert.equal(env.USERPROFILE, 'D:\\Users\\testuser', 'USERPROFILE must pass through from the parent');
  assert.equal(env.CODEX_HOME, 'D:\\Users\\testuser\\.codex', 'CODEX_HOME must pass through from the parent');
  assert.equal(env.CLAUDE_CONFIG_DIR, 'D:\\Users\\testuser\\.claude', 'CLAUDE_CONFIG_DIR must pass through from the parent');
  assert.equal(env.MULTI_AGENT_MODE, 'managed', 'MULTI_AGENT_MODE must be set');
  assert.equal(env.MULTI_AGENT_BIND_HOST, '127.0.0.1', 'MULTI_AGENT_BIND_HOST must be loopback');
  assert.equal(env.MULTI_AGENT_UI_ENABLED, 'true', 'MULTI_AGENT_UI_ENABLED must be set');
  assert.equal(env.MULTI_AGENT_OWNER_TOKEN, undefined, 'owner token must be cleared');
});

test('MULTI_AGENT_HOME is identical across two launches', async () => {
  const f1 = nativeDesktop();
  await settle();
  const home1 = f1.lastEnv().MULTI_AGENT_HOME;
  const f2 = nativeDesktop();
  await settle();
  assert.ok(home1 && f2.lastEnv().MULTI_AGENT_HOME, 'MULTI_AGENT_HOME must be set in both launches');
  assert.equal(home1, f2.lastEnv().MULTI_AGENT_HOME, 'MULTI_AGENT_HOME must be identical across launches');
});

test('a missing engine build says so instead of forking', async () => {
  const fixture = nativeDesktop({ engineEntryExists: false });
  await settle();
  assert.equal(fixture.started(), 0);
  assert.equal(fixture.state().phase, 'engine-missing');
});

test('an engine that fails before ready reports the failure and stays on the first-run page', async () => {
  const fixture = nativeDesktop({ readyError: new Error('Daemon crash: ENOENT') });
  await settle();
  assert.equal(fixture.state().phase, 'start-failed');
  assert.match(fixture.state().message, /Daemon crash/);
  assert.ok(!fixture.loaded.some(url => url.includes('/team')));
  assert.equal(fixture.nativeEngine(), null, 'a failed engine is not held as running');
  assert.ok(fixture.options(), 'the window still exists after a daemon crash');
});

test('an unexpected engine exit shows a reconnect action instead of a dead page', async () => {
  const fixture = nativeDesktop();
  await settle();
  assert.equal(fixture.state().phase, 'ready');
  fixture.exit()({ code: 1, reason: 'exit code 1' });
  assert.equal(fixture.state().phase, 'engine-exited');
  assert.match(fixture.state().message, /exit code 1/);
  assert.equal(fixture.allowedOrigin(), null, 'a stopped engine has no origin to trust');
  assert.deepEqual(fixture.engineExit(), { code: 1, reason: 'exit code 1' });
  assert.match(fixture.loaded.at(-1), /first-run\.html$/, 'the dead team page is replaced by the reconnect page');

  // Reconnect starts a fresh engine and connects the window again.
  const before = fixture.loaded.length;
  await fixture.ipcHandlers.get('desktop:reconnect-engine')();
  await settle();
  assert.equal(fixture.started(), 2, 'Reconnect forks the engine again');
  assert.ok(fixture.loaded.length > before, 'Reconnect loads the new origin');
  assert.equal(fixture.state().phase, 'ready');
});

test('Stop engine asks the bridge for the bounded shutdown and clears the origin', async () => {
  const fixture = nativeDesktop();
  await settle();
  await fixture.menuItem('Stop engine').click();
  await settle();
  assert.equal(fixture.bridgeShutdowns(), 1, 'the daemon shutdown runs exactly once');
  assert.equal(fixture.nativeEngine(), null, 'the engine handle is cleared so no child is left behind');
  assert.equal(fixture.allowedOrigin(), null);
  assert.equal(fixture.state().phase, 'stopped');
});

test('an exit the app asked for is not reported as a crash', async () => {
  const fixture = nativeDesktop();
  await settle();
  await fixture.menuItem('Stop engine').click();
  await settle();
  fixture.exit()({ code: 0, reason: 'exit code 0' });
  assert.equal(fixture.state().phase, 'stopped', 'the stop the app asked for is not a crash');
  assert.equal(fixture.engineExit(), null);
});

test('no child is left when the shutdown runs before quit', async () => {
  const fixture = nativeDesktop();
  await settle();
  const beforeQuit = fixture.lifecycle.get('before-quit');
  assert.equal(typeof beforeQuit, 'function');
  let prevented = false;
  beforeQuit({ preventDefault: () => { prevented = true; } });
  await settle();
  assert.equal(prevented, true, 'quit waits for the daemon shutdown');
  assert.equal(fixture.bridgeShutdowns(), 1, 'the daemon shutdown runs exactly once');
  assert.equal(fixture.nativeEngine(), null);
});

test('quitting with no engine running does not prevent the quit', async () => {
  const fixture = nativeDesktop({ engineEntryExists: false });
  await settle();
  const beforeQuit = fixture.lifecycle.get('before-quit');
  let prevented = false;
  beforeQuit({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(fixture.bridgeShutdowns(), 0);
});

test('closing while attempts run asks for confirmation and cancel keeps the app open', async () => {
  const fixture = nativeDesktop({ closeResponse: 1, runningAttempts: 2 });
  await settle();
  const close = fixture.close();
  let prevented = false;
  await close({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'the close must be held for confirmation');
  assert.equal(fixture.messageBoxes.length, 1);
  assert.match(fixture.messageBoxes[0].message, /Resume continues/);
  assert.equal(fixture.window().destroyed, false, 'cancelling keeps the window open');
});

test('confirming the close stops the agents and proceeds', async () => {
  const fixture = nativeDesktop({ closeResponse: 0, runningAttempts: 1 });
  await settle();
  const close = fixture.close();
  await close({ preventDefault: () => {} });
  assert.equal(fixture.messageBoxes.length, 1);
  assert.equal(fixture.window().destroyed, true, 'approving closes the window');
});

test('no close confirmation is shown when no attempt is running', async () => {
  const fixture = nativeDesktop({ closeResponse: 0, runningAttempts: 0 });
  await settle();
  const close = fixture.close();
  let prevented = false;
  await close({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(fixture.messageBoxes.length, 0);
});

test('second-instance focuses the existing window', async () => {
  const fixture = nativeDesktop();
  await settle();
  const secondInstance = fixture.lifecycle.get('second-instance');
  assert.equal(typeof secondInstance, 'function');
  secondInstance();
  assert.equal(fixture.window().focused, true);
});

test('a non-loopback health answer is refused before the window loads it', async () => {
  const fixture = nativeDesktop({
    fetch: async (url) => String(url).endsWith('/healthz')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok' }) }
      : { ok: false, status: 404, text: async () => '', json: async () => ({}) },
  });
  await settle();
  assert.equal(fixture.state().phase, 'connection-failed');
  assert.ok(!fixture.loaded.some(url => url.includes('/team')));
});

test('renewal mints and exchanges again without navigating the window', async () => {
  const fixture = nativeDesktop();
  await settle();
  const before = fixture.loaded.length;
  const exchangedBefore = fixture.exchangeRequests.length;
  fixture.mainFrame.url = `${ORIGIN}/team`;

  const event = { sender: fixture.contents, senderFrame: fixture.mainFrame };
  const token = await fixture.ipcHandlers.get('desktop:reconnect')(event);

  assert.equal(token, 'C'.repeat(43), 'renewal returns a fresh anti-forgery token');
  assert.equal(fixture.mints.length, 2, 'renewal mints a new one-time code');
  assert.equal(fixture.exchangeRequests.length, exchangedBefore + 1, 'renewal exchanges the new code');
  assert.equal(fixture.loaded.length, before, 'renewal does not navigate the window');
});

test('Open in browser mints a fresh code, copies it, and never puts it in the opened URL', async () => {
  const fixture = nativeDesktop();
  await settle();
  const item = fixture.menuItem('Open in browser');
  assert.ok(item && typeof item.click === 'function', 'the Engine menu offers Open in browser');

  await item.click();
  await settle();

  assert.equal(fixture.mints.length, 2, 'Open in browser mints a fresh code, separate from the window pairing');
  const code = fixture.mints[fixture.mints.length - 1];
  assert.deepEqual(fixture.clipboardWrites, [code], 'the code is copied to the clipboard');
  assert.equal(fixture.externalUrls.length, 1, 'exactly one browser page is opened');
  const [url] = fixture.externalUrls;
  assert.equal(url, `${ORIGIN}/team`);
  assert.ok(!url.includes(code), 'the code never appears in the opened URL');
  assert.ok(fixture.messageBoxes.find(box => String(box.detail || '').includes(code)), 'the code is shown to the owner in a dialog');
});

test('the Engine menu offers Stop engine and Reconnect', async () => {
  const fixture = nativeDesktop();
  await settle();
  assert.equal(typeof fixture.menuItem('Stop engine').click, 'function');
  assert.equal(typeof fixture.menuItem('Reconnect').click, 'function');
  await fixture.menuItem('Stop engine').click();
  await settle();
  assert.equal(fixture.bridgeShutdowns(), 1);
  assert.equal(fixture.state().phase, 'stopped');
});