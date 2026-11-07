const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const wsl = require('../src/wsl.js');

function desktop(selected = { canceled: false, filePaths: [String.raw`D:\Client Work\fixture`] }) {
  const dialogs = [];
  let options;
  const contents = { mainFrame: { url: wsl.TEAM_URL }, on() {}, send() {}, setWindowOpenHandler() {} };
  class Window {
    constructor(value) { options = value; this.webContents = contents; }
    once() {}
    on() {}
    isDestroyed() { return false; }
    loadURL() { return Promise.resolve(); }
  }
  const electron = {
    app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) },
    BrowserWindow: Window,
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 940 } }) },
    dialog: { showOpenDialog: async (parent, settings) => { dialogs.push({ parent, settings }); return selected; } },
  };
  const context = vm.createContext({ __dirname: path.resolve(__dirname, '../src'), URL, console,
    require: name => name === 'electron' ? electron : name === './wsl.js' ? wsl
      : name === 'node:child_process' ? { spawn() { throw new Error('Folder selection must not start a process'); } } : require(name),
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8'), context);
  vm.runInContext('createWindow(); resolved.distro = "Ubuntu";', context);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { context, contents, event, dialogs, options,
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
