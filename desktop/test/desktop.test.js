const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const wsl = require('../src/wsl.js');

function desktop(selected = { canceled: false, filePaths: [String.raw`D:\Client Work\fixture`] }, cookieError = null) {
  const dialogs = [], cookies = [], loaded = [];
  let options;
  const contents = { mainFrame: { url: wsl.TEAM_URL }, on() {}, send() {}, setWindowOpenHandler() {} };
  class Window {
    constructor(value) { options = value; this.webContents = contents; }
    once() {}
    on() {}
    isDestroyed() { return false; }
    loadURL(url) { loaded.push(url); return Promise.resolve(); }
  }
  const electron = {
    app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }), getPath: () => path.join('D:', 'ma', 'tmp', 'userData') },
    BrowserWindow: Window,
    session: { defaultSession: { cookies: { set: async value => { if (cookieError) throw cookieError; cookies.push(value); } } } },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 940 } }) },
    dialog: { showOpenDialog: async (parent, settings) => { dialogs.push({ parent, settings }); return selected; } },
  };
  const context = vm.createContext({ __dirname: path.resolve(__dirname, '../src'), URL, console,
    process: { env: {} },
    require: name => name === 'electron' ? electron : name === './wsl.js' ? wsl
      : name === './engine-bridge.js' ? { startEngine() { throw new Error('Native engine is not part of this fixture'); } }
      : name === 'node:child_process' ? { spawn() { throw new Error('Folder selection must not start a process'); } } : require(name),
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8'), context);
  vm.runInContext('createWindow(); resolved.distro = "Ubuntu";', context);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { context, contents, event, dialogs, cookies, loaded, options,
    pick: (sender = event) => vm.runInContext('pickFolder', context)(sender),
  };
}

function preload(pick = async () => '/mnt/d/Client Work/fixture') {
  const listeners = new Map(), domListeners = new Map(), storage = new Map(), events = [], writes = [];
  let bridge;
  const status = { phase: 'ready', connected: true, project: 'fixture' };
  const document = {
    readyState: 'loading', documentElement: { dataset: {} },
    body: { appendChild: element => writes.push(element) }, head: { appendChild: element => writes.push(element) },
    getElementById: () => null, createElement: () => ({}),
    addEventListener: (name, callback) => domListeners.set(name, callback), dispatchEvent: event => events.push(event),
  };
  const context = vm.createContext({ document, window: { sessionStorage: { setItem: (key, value) => storage.set(key, value) } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    require: name => { assert.equal(name, 'electron'); return {
      contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'multiAgentDesktop'); bridge = value; } },
      ipcRenderer: {
        sendSync: channel => { assert.equal(channel, 'desktop:csrf-token'); return 'fixture-session-handoff'; },
        invoke: channel => channel === 'desktop:pick-folder' ? pick() : Promise.resolve(status),
        on: (channel, listener) => { const list = listeners.get(channel) ?? []; list.push(listener); listeners.set(channel, list); },
        removeListener: (channel, listener) => listeners.set(channel, listeners.get(channel).filter(item => item !== listener)),
      },
    }; },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/preload.js'), 'utf8'), context);
  return { bridge, status, document, storage, events, writes,
    loaded: () => { document.readyState = 'complete'; domListeners.get('DOMContentLoaded')?.(); },
    publish: next => { for (const listener of listeners.get('desktop:state') ?? []) listener({}, next); },
  };
}

test('keeps the native caption overlay aligned with the shared 48px strip', () => {
  const fixture = desktop();
  assert.equal(fixture.options.titleBarStyle, 'hidden');
  assert.equal(fixture.options.titleBarOverlay.height, 48);
  assert.equal(fixture.options.titleBarOverlay.color, '#151619');
  assert.equal(fixture.options.webPreferences.contextIsolation, true);
  assert.equal(fixture.options.webPreferences.nodeIntegration, false);
  assert.equal(fixture.options.webPreferences.sandbox, true);
});

test('the actual preload and main picker return a POSIX path without any process call', async () => {
  const fixture = desktop();
  const page = preload(() => fixture.pick());
  assert.equal(await page.bridge.pickFolder(), '/mnt/d/Client Work/fixture');
  assert.equal(fixture.dialogs.length, 1);
  assert.equal(fixture.dialogs[0].parent.webContents, fixture.contents);
  assert.deepEqual(Array.from(fixture.dialogs[0].settings.properties), ['openDirectory', 'createDirectory']);
});

test('the picker rejects a different window, subframe, origin or missing distro before opening', async () => {
  const fixture = desktop();
  await assert.rejects(fixture.pick({ ...fixture.event, sender: {} }));
  await assert.rejects(fixture.pick({ ...fixture.event, senderFrame: { url: wsl.TEAM_URL } }));
  fixture.contents.mainFrame.url = 'https://example.com/';
  await assert.rejects(fixture.pick());
  fixture.contents.mainFrame.url = wsl.TEAM_URL;
  vm.runInContext('resolved.distro = null;', fixture.context);
  await assert.rejects(fixture.pick());
  assert.equal(fixture.dialogs.length, 0);
});

test('native cancellation is empty and a different distro is an error', async () => {
  assert.equal(await desktop({ canceled: true, filePaths: [] }).pick(), null);
  await assert.rejects(desktop({ canceled: false, filePaths: [String.raw`\\wsl.localhost\Debian\home\dev\app`] }).pick());
});

test('preload preserves pairing and status but adds no title bar, footer or padding', async () => {
  const page = preload();
  assert.equal(page.storage.get('multi-agent.desktop.csrf'), 'fixture-session-handoff');
  assert.equal(await page.bridge.status(), page.status);
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


test('desktop startup connects before opening the app and keeps its session cookie HttpOnly', async () => {
  const fixture = desktop();
  fixture.context.pairResult = { ok: true, stdout: Buffer.from(`cookie=${'a'.repeat(43)}\ncsrf=${'b'.repeat(43)}\n`) };
  vm.runInContext('runWsl = async () => pairResult;', fixture.context);
  await vm.runInContext('openTeamView()', fixture.context);
  assert.equal(fixture.loaded.at(-1), wsl.TEAM_URL);
  assert.equal(fixture.cookies.length, 1);
  assert.equal(fixture.cookies[0].httpOnly, true);
  assert.equal(fixture.cookies[0].sameSite, 'strict');
  assert.equal(fixture.cookies[0].path, '/api');
  assert.equal(vm.runInContext('state.connected', fixture.context), true);
});

test('a failed desktop pairing stays on the connection screen instead of opening a code form', async () => {
  const fixture = desktop();
  fixture.context.pairResult = { ok: false, stdout: Buffer.alloc(0) };
  vm.runInContext('runWsl = async () => pairResult;', fixture.context);
  await vm.runInContext('openTeamView()', fixture.context);
  assert.ok(!fixture.loaded.includes(wsl.TEAM_URL));
  assert.equal(vm.runInContext('state.phase', fixture.context), 'connection-failed');
  assert.equal(vm.runInContext('state.connected', fixture.context), false);
});

test('a rejected cookie write is a connection failure rather than a ready desktop', async () => {
  const fixture = desktop(undefined, new Error('fixture cookie rejection'));
  fixture.context.pairResult = { ok: true, stdout: Buffer.from(`cookie=${'a'.repeat(43)}\ncsrf=${'b'.repeat(43)}\n`) };
  vm.runInContext('runWsl = async () => pairResult;', fixture.context);
  await vm.runInContext('openTeamView()', fixture.context);
  assert.ok(!fixture.loaded.includes(wsl.TEAM_URL));
  assert.equal(vm.runInContext('state.phase', fixture.context), 'connection-failed');
  assert.equal(vm.runInContext('state.connected', fixture.context), false);
});

test('native reconnection accepts only the active same-origin main frame and does not reload it', async () => {
  const fixture = desktop();
  fixture.context.pairResult = { ok: true, stdout: Buffer.from(`cookie=${'a'.repeat(43)}\ncsrf=${'b'.repeat(43)}\n`) };
  vm.runInContext('runWsl = async () => pairResult;', fixture.context);
  const reconnect = vm.runInContext('reconnectOwnerSession', fixture.context);
  await assert.rejects(reconnect({ ...fixture.event, sender: {} }));
  await assert.rejects(reconnect({ ...fixture.event, senderFrame: { url: wsl.TEAM_URL } }));
  fixture.contents.mainFrame.url = 'http://localhost:7433/team';
  await assert.rejects(reconnect(fixture.event));
  assert.equal(fixture.cookies.length, 0);
  fixture.contents.mainFrame.url = wsl.TEAM_URL;
  assert.equal(await reconnect(fixture.event), 'b'.repeat(43));
  assert.equal(fixture.cookies.length, 1);
  assert.equal(fixture.loaded.length, 1);
});

test('native reconnection withholds its token if the requesting frame navigated during pairing', async () => {
  const fixture = desktop();
  fixture.context.pairResult = { ok: true, stdout: Buffer.from(`cookie=${'a'.repeat(43)}\ncsrf=${'b'.repeat(43)}\n`) };
  fixture.context.navigateAway = () => { fixture.contents.mainFrame.url = 'https://example.com/'; };
  vm.runInContext('runWsl = async () => { navigateAway(); return pairResult; };', fixture.context);
  const reconnect = vm.runInContext('reconnectOwnerSession', fixture.context);
  assert.equal(await reconnect(fixture.event), null);
});

test('preload exposes only the native reconnect action, never the cookie', async () => {
  const page = preload();
  assert.equal(typeof page.bridge.reconnect, 'function');
  assert.equal(await page.bridge.reconnect(), page.status);
  assert.equal(page.bridge.cookie, undefined);
});
