'use strict';
/**
 * U5 — native engine host tests at the desktop level: startup after ready,
 * the dynamic origin reaching the window, second-instance focus, crash state,
 * the close confirmation with cancel, clean shutdown leaving no child, and no
 * LAN bind.
 *
 * These drive `src/main.js` in a `vm` context with a mocked Electron and a
 * mocked `engine-bridge.js`, so they run under `node --test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const wsl = require('../src/wsl.js');

/**
 * Build a main.js fixture in native mode.
 *
 * @param {object} opts
 * @param {object} opts.ready          – what the bridge's ready promise resolves to
 * @param {Error}  [opts.readyError]   – what it rejects with instead
 * @param {number} [opts.closeResponse] – the close-confirmation response index
 * @param {number} [opts.runningAttempts] – value for runningAttempts in healthz (0 = no confirmation)
 */
function nativeDesktop(opts = {}) {
  const { ready = { port: 58123, pid: 4321 }, readyError = null, closeResponse = 1 } = opts;
  const runningAttempts = opts.runningAttempts !== undefined ? opts.runningAttempts : 0;
  const loaded = [];
  const messageBoxes = [];
  const lifecycle = new Map();
  const dialogHandlers = [];
  const ipcHandlers = new Map();
  const cookies = [];
  const clipboardWrites = [];
  const externalUrls = [];
  const mints = [];
  let capturedMenu = null;
  let options = null;
  let bridgeShutdowns = 0;
  let started = 0;
  let mintIndex = 0;
  const mintCode = opts.mintCode || (() => 'M'.repeat(40) + String(++mintIndex).padStart(3, '0'));

  const mainFrame = { url: 'file:///first-run.html' };
  const contents = {
    mainFrame,
    on(event, fn) { if (event === 'will-navigate') dialogHandlers.push(fn); },
    send() {},
    setWindowOpenHandler() {},
    reload() {},
  };

  class Window {
    constructor(value) { options = value; this.webContents = contents; this.destroyed = false; }
    once() {}
    on(event, fn) { if (event === 'close') dialogHandlers.push(fn); }
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
    getPath: () => path.join('D:', 'ma', 'tmp', 'userData'),
    getPath: (name) => name === 'appData' ? path.join('D:', 'ma', 'tmp', 'appData') : path.join('D:', 'ma', 'tmp', 'userData'),
  };

  const electron = {
    app,
    BrowserWindow: Window,
    session: { defaultSession: { cookies: { set: async (cookie) => { cookies.push(cookie); } }, setPermissionRequestHandler() {} } },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 940 } }) },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async (...args) => { const box = args.length === 2 ? args[1] : args[0]; messageBoxes.push(box); return { response: closeResponse }; },
    },
    ipcMain: {
      handle(channel, fn) { ipcHandlers.set(channel, fn); },
      on(channel, fn) { ipcHandlers.set(channel, fn); },
    },
    Menu: { buildFromTemplate: (template) => { capturedMenu = template; return {}; }, setApplicationMenu() {} },
    shell: { openExternal: async (url) => { externalUrls.push(url); } },
    clipboard: { writeText: (text) => { clipboardWrites.push(text); } },
  };

  const bridge = {
    startEngine(...args) {
      started += 1;
      bridge.lastStartArgs = args[0];
      return {
        ready: readyError ? Promise.reject(readyError) : Promise.resolve(ready),
        shutdown: async () => { bridgeShutdowns += 1; },
        mintPairing: async () => { const code = mintCode(); mints.push(code); return code; },
      };
    },
    isRunning: () => true,
    port: () => (ready ? ready.port : null),
    killEngine: () => {},
    lastStartArgs: null,
  };

  // Default healthz response includes runningAttempts so the close handler
  // can decide whether to show the confirmation dialog.
  const defaultText = JSON.stringify({
    status: 'ok', selfHostId: 'host-x', pid: 4321, runningAttempts,
  });
  // U6 — the default fetch answers the daemon's health probe and the owner-session exchange
  // the desktop posts after minting a code over the parent channel.
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
    URL,
    console,
    process: { env: { HOME: 'D:\\Users\\testuser', USERPROFILE: 'D:\\Users\\testuser', CODEX_HOME: 'D:\\Users\\testuser\\.codex', CLAUDE_CONFIG_DIR: 'D:\\Users\\testuser\\.claude' } },
    fetch: opts.fetch || defaultFetch,
    AbortSignal: { timeout: () => undefined },
    setTimeout,
    clearTimeout,
    require: name => {
      if (name === 'electron') return electron;
      if (name === './wsl.js') return wsl;
      if (name === './engine-bridge.js') return bridge;
      if (name === 'node:child_process') return { spawn() { throw new Error('No process in these tests'); } };
      if (name === 'node:fs') {
        return {
          existsSync: () => true,
          mkdirSync() {},
          writeFileSync() {},
          readFileSync: fs.readFileSync,
        };
      }
      return require(name);
    },
  });

  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8'), context);

  return {
    context, electron, bridge, loaded, messageBoxes, lifecycle, dialogHandlers, ipcHandlers, contents, mainFrame,
    cookies, clipboardWrites, externalUrls, mints, exchangeRequests,
    options: () => options,
    started: () => started,
    bridgeShutdowns: () => bridgeShutdowns,
    state: () => vm.runInContext('state', context),
    setState: (patch) => vm.runInContext(`state = { ...state, ...${JSON.stringify(patch)} }`, context),
    nativeEngine: () => vm.runInContext('nativeEngine', context),
    allowedOrigin: () => vm.runInContext('allowedOrigin', context),
    window: () => vm.runInContext('window', context),
    // The will-navigate handler is the one that takes (event, url).
    navigate: () => dialogHandlers.find(fn => fn.length === 2),
    close: () => dialogHandlers.find(fn => fn.length === 1),
    lastEnv: () => bridge.lastStartArgs ? bridge.lastStartArgs.env : null,
    menuItem: (label) => (capturedMenu || []).flatMap(item => item.submenu || []).find(item => item.label === label),
  };
}

// Let the async startup chain (fork → ready → health → mint → exchange → load) settle.
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };

test('native engine starts after app readiness and loads the dynamic origin', async () => {
  const fixture = nativeDesktop();
  await settle();
  await settle();
  assert.equal(fixture.started(), 1, 'the bridge must fork exactly one daemon');
  assert.ok(fixture.loaded.some(url => url === 'http://127.0.0.1:58123/team'),
    `the window must load the dynamic origin, got ${JSON.stringify(fixture.loaded)}`);
  assert.equal(fixture.allowedOrigin(), 'http://127.0.0.1:58123');
  assert.equal(fixture.state().phase, 'ready');
});

test('the dynamic origin is the only origin the window may navigate to', async () => {
  const fixture = nativeDesktop();
  await settle();
  await settle();
  const navigate = fixture.navigate();
  let prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, 'http://127.0.0.1:58123/team');
  assert.equal(prevented, false, 'the dynamic origin must be allowed');
  navigate({ preventDefault: () => { prevented = true; } }, 'http://127.0.0.1:7433/team');
  assert.equal(prevented, true, 'the old fixed origin must not be trusted in native mode');
});

test('a daemon crash shows a connection state without taking down the window', async () => {
  const fixture = nativeDesktop({ readyError: new Error('Daemon crash: ENOENT') });
  await settle();
  await settle();
  assert.equal(fixture.state().phase, 'start-failed');
  assert.match(fixture.state().message, /Daemon crash/);
  assert.ok(!fixture.loaded.some(url => url.includes('/team')));
  assert.ok(fixture.options(), 'the window still exists after a daemon crash');
});

test('closing while attempts run asks for confirmation and cancel keeps the app open', async () => {
  const fixture = nativeDesktop({ closeResponse: 1, runningAttempts: 2 });
  await settle();
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
  await settle();
  const close = fixture.close();
  await close({ preventDefault: () => {} });
  assert.equal(fixture.messageBoxes.length, 1);
  assert.equal(fixture.window().destroyed, true, 'approving closes the window');
});

test('no close confirmation is shown when no attempt is running', async () => {
  const fixture = nativeDesktop({ closeResponse: 0, runningAttempts: 0 });
  await settle();
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
  await settle();
  const secondInstance = fixture.lifecycle.get('second-instance');
  assert.equal(typeof secondInstance, 'function');
  secondInstance();
  assert.equal(fixture.window().focused, true);
});

test('quitting runs the daemon shutdown before the app exits', async () => {
  const fixture = nativeDesktop();
  await settle();
  await settle();
  const beforeQuit = fixture.lifecycle.get('before-quit');
  assert.equal(typeof beforeQuit, 'function');
  let prevented = false;
  beforeQuit({ preventDefault: () => { prevented = true; } });
  await settle();
  await settle();
  assert.equal(prevented, true, 'quit waits for the daemon shutdown');
  assert.equal(fixture.bridgeShutdowns(), 1, 'the daemon shutdown runs exactly once');
  assert.equal(fixture.nativeEngine(), null);
});

test('a non-loopback health answer is refused before the window loads it', async () => {
  const fixture = nativeDesktop({
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok' }) }),
  });
  await settle();
  await settle();
  assert.equal(fixture.state().phase, 'connection-failed');
  assert.ok(!fixture.loaded.some(url => url.includes('/team')));
});

test('shutdown leaves no child: the bridge shutdown runs once and is cleared', async () => {
  const fixture = nativeDesktop();
  await settle();
  await settle();
  assert.ok(fixture.nativeEngine(), 'the daemon is running before quit');
  const beforeQuit = fixture.lifecycle.get('before-quit');
  beforeQuit({ preventDefault: () => {} });
  await settle();
  await settle();
  assert.equal(fixture.bridgeShutdowns(), 1);
  assert.equal(fixture.nativeEngine(), null, 'the engine handle is cleared so no child is left behind');
});

test('the child env keeps the parent HOME, USERPROFILE, CODEX_HOME and CLAUDE_CONFIG_DIR', async () => {
  const fixture = nativeDesktop();
  await settle();
  await settle();
  const env = fixture.lastEnv();
  assert.ok(env, 'startEngine must have been called');
  assert.equal(env.HOME, 'D:\\Users\\testuser', 'HOME must pass through from the parent');
  assert.equal(env.USERPROFILE, 'D:\\Users\\testuser', 'USERPROFILE must pass through from the parent');
  assert.equal(env.CODEX_HOME, 'D:\\Users\\testuser\\.codex', 'CODEX_HOME must pass through from the parent');
  assert.equal(env.CLAUDE_CONFIG_DIR, 'D:\\Users\\testuser\\.claude', 'CLAUDE_CONFIG_DIR must pass through from the parent');
  assert.equal(env.MULTI_AGENT_MODE, 'managed', 'MULTI_AGENT_MODE must be set');
  assert.equal(env.OPENRIG_BIND_HOST, '127.0.0.1', 'OPENRIG_BIND_HOST must be loopback');
  assert.equal(env.OPENRIG_UI_ENABLED, 'true', 'OPENRIG_UI_ENABLED must be set');
  assert.equal(env.MULTI_AGENT_OWNER_TOKEN, undefined, 'owner token must be cleared');
});

test('OPENRIG_HOME is identical across two launches', async () => {
  const opts = { ready: { port: 58123, pid: 4321 } };
  const f1 = nativeDesktop(opts);
  await settle();
  await settle();
  const home1 = f1.lastEnv().OPENRIG_HOME;

  const f2 = nativeDesktop(opts);
  await settle();
  await settle();
  const home2 = f2.lastEnv().OPENRIG_HOME;

  assert.ok(home1 && home2, 'OPENRIG_HOME must be set in both launches');
  assert.equal(home1, home2, 'OPENRIG_HOME must be identical across launches');
});

test('OPENRIG_UI_ENABLED is set instead of writing config.json', async () => {
  const fixture = nativeDesktop();
  await settle();
  await settle();
  const env = fixture.lastEnv();
  assert.ok(env, 'startEngine must have been called');
  assert.equal(env.OPENRIG_UI_ENABLED, 'true', 'OPENRIG_UI_ENABLED must be set to enable the team UI');
  assert.equal(env.MULTI_AGENT_OWNER_TOKEN, undefined, 'owner token must be cleared');
});

// ---------------------------------------------------------------------------
// U6 — native pairing and the optional browser viewer
// ---------------------------------------------------------------------------

test('the window pairs over the private parent channel and only the anti-forgery token reaches it', async () => {
  const fixture = nativeDesktop();
  await settle();
  const [code] = fixture.mints;
  assert.equal(fixture.mints.length, 1, 'the desktop mints exactly one code for the window');
  assert.ok(code, 'a one-time code was minted');

  const [exchange] = fixture.exchangeRequests;
  assert.ok(exchange, 'the code is exchanged over HTTP');
  assert.equal(exchange.url, 'http://127.0.0.1:58123/api/team-control/owner-session/exchange');
  assert.ok(!exchange.url.includes(code), 'the code never appears in the exchange URL');
  assert.equal(exchange.init.headers.Origin, 'http://127.0.0.1:58123');
  assert.equal(exchange.init.headers['Sec-Fetch-Site'], 'same-origin');
  assert.deepEqual(JSON.parse(exchange.init.body), { code });

  assert.equal(fixture.cookies.length, 1, 'the HttpOnly cookie goes into the window jar');
  const [cookie] = fixture.cookies;
  assert.equal(cookie.name, 'multi_agent_owner');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'strict');
  assert.equal(cookie.path, '/api');
  assert.equal(cookie.url, 'http://127.0.0.1:58123');

  assert.ok(fixture.loaded.some(url => url === 'http://127.0.0.1:58123/team'));
  assert.equal(fixture.state().phase, 'ready');
  assert.ok(!JSON.stringify(fixture.state()).includes(code), 'the code never reaches the renderer state');
});

test('renewal mints and exchanges again without navigating the window', async () => {
  const fixture = nativeDesktop();
  await settle();
  const before = fixture.loaded.length;
  const exchangedBefore = fixture.exchangeRequests.length;
  fixture.mainFrame.url = 'http://127.0.0.1:58123/team';

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
  assert.equal(url, 'http://127.0.0.1:58123/team');
  assert.ok(!url.includes(code), 'the code never appears in the opened URL');
  const dialog = fixture.messageBoxes.find(box => String(box.detail || '').includes(code));
  assert.ok(dialog, 'the code is shown to the owner in a dialog');
});
