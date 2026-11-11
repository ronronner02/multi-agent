'use strict';
/**
 * The Multi-Agent desktop window.
 *
 * The daemon is this app's own child: Electron forks it as a utility process, the daemon binds
 * loopback on an OS-assigned port, and reports that origin back over the private parent channel.
 * The window then pairs itself and loads the daemon's own Web UI. Nothing this app shows comes
 * from an external process or a fixed port.
 *
 * Three rules shape the code below:
 *  - The window may only ever show the daemon's current loopback origin, plus its own local
 *    first-run page. Every other navigation is refused, and external links open in the user's
 *    browser instead.
 *  - No credential is logged, written outside the daemon's own cookie jar, or placed in a URL.
 *    The owner session comes from the daemon's own pairing flow.
 *  - The engine this app starts is the engine this app stops. Quitting, or Stop engine, runs the
 *    daemon's bounded shutdown and leaves no child behind.
 */
const { app, BrowserWindow, Menu, ipcMain, screen, session, shell, dialog, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const engineBridge = require('./engine-bridge.js');
const { dependencyRows } = require('./dependencies.js');
const { isAllowedNavigation, isDaemonHealth } = require('./origin.js');

const BACKGROUND = '#151619';
const FIRST_RUN_URL = new URL(`file://${path.join(__dirname, 'first-run.html').replace(/\\/g, '/')}`).href;
const DAEMON_ENTRY = path.resolve(__dirname, '../../engine/packages/daemon/dist/index.js');

// KTD7 — the stable data directory. Production is %LOCALAPPDATA%\Multi-Agent; a test or a manual
// run points MULTI_AGENT_DESKTOP_DATA_DIR somewhere else.
const DATA_DIR_ROOT = process.env.MULTI_AGENT_DESKTOP_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Multi-Agent');

let window = null;
let state = { phase: 'checking', message: 'Starting the local engine…', dependencies: null, connected: false };
let csrfToken = null;

/** The forked engine, or null while it is not running. */
let engine = null;
let enginePid = null;
/** The one origin the window may show. Null until the engine reports one. */
let allowedOrigin = null;
/**
 * Why the engine stopped on its own, when it was not this app that stopped it.
 *
 * A daemon that exits without a shutdown request is a crash or an external kill; the window then
 * offers Reconnect instead of a dead page. Null while the engine is expected to be running.
 */
let engineExit = null;

// ---------------------------------------------------------------- state

function publicState() {
  return {
    phase: state.phase,
    message: state.message,
    connected: state.connected,
    dependencies: state.dependencies,
  };
}

function publish(patch) {
  state = { ...state, ...patch };
  if (window && !window.isDestroyed()) window.webContents.send('desktop:state', publicState());
}

// ---------------------------------------------------------------- window

function createWindow() {
  // The design targets 1440x940; a smaller screen gets the whole work area instead of a
  // window that hangs off the edge.
  const work = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    width: Math.min(1440, work.width),
    height: Math.min(940, work.height),
    minWidth: Math.min(960, work.width),
    minHeight: Math.min(640, work.height),
    backgroundColor: BACKGROUND,
    show: false,
    title: 'Multi-Agent',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BACKGROUND, symbolColor: '#ededf0', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });

  // Closing the last window while attempts are running asks for confirmation. The one-line
  // consequence: agents stop, and Resume continues next time. Running attempt state is read from
  // the engine's own /healthz projection.
  window.on('close', async (event) => {
    if (!engine) return;
    const count = await pollRunningAttempts();
    if (count === undefined || count === 0) return;
    event.preventDefault();
    const currentWindow = window;
    const result = await dialog.showMessageBox(currentWindow, {
      type: 'warning',
      buttons: ['Stop agents and quit', 'Keep running'],
      defaultId: 1,
      cancelId: 1,
      title: `Agents are running (${count})`,
      message: 'Closing stops the running agents. Resume continues the work next time you open the app.',
    });
    if (result.response !== 0) return; // Keep running
    currentWindow.close();
  });

  const contents = window.webContents;
  contents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, allowedOrigin) || url === FIRST_RUN_URL) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('did-finish-load', () => publish({}));
  contents.on('did-fail-load', (_event, code, description) => {
    if (code === -3) return; // An aborted load is a navigation we replaced, not a failure.
    publish({ phase: 'connection-failed', message: `Page load failed: ${description}`, connected: false });
  });

  void window.loadURL(FIRST_RUN_URL);
}

/**
 * A first-run diagnostic for a source run: capture this app's own window to a PNG and log the
 * text it rendered. It is off unless MULTI_AGENT_DESKTOP_SCREENSHOT names a file, and it never
 * captures or reads anything but this app's own window.
 */
async function captureWindow(file) {
  if (!process.env.MULTI_AGENT_DESKTOP_SCREENSHOT || !window || window.isDestroyed()) return;
  try {
    const image = await window.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
    const url = window.webContents.getURL();
    const text = await window.webContents.executeJavaScript('document.body.innerText.replace(/\\s+/g, " ").slice(0, 400)');
    console.log(`[desktop] captured ${file} url=${url} text=${JSON.stringify(text)}`);
  } catch (error) {
    console.error(`[desktop] screenshot failed: ${error.message}`);
  }
}

function openExternal(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(rawUrl);
}

// ---------------------------------------------------------------- engine lifecycle

/**
 * Fork the daemon and connect the window to it.
 *
 * One call owns the whole startup: the daemon reports readiness on a dynamic port, the window
 * pairs over the daemon's private parent channel, and only then does the window load the origin.
 * A failure at any step publishes its own phase and leaves the window on the first-run page.
 */
async function startEngine() {
  if (engine) return;
  if (!fs.existsSync(DAEMON_ENTRY)) {
    publish({ phase: 'engine-missing', message: 'The engine build is missing. Build it, then Reconnect.', connected: false });
    return;
  }
  const dataDir = path.join(DATA_DIR_ROOT, 'engine');
  fs.mkdirSync(dataDir, { recursive: true });

  // The daemon inherits this process's environment unchanged, so it reads the owner's real
  // HOME/USERPROFILE/CODEX_HOME/CLAUDE_CONFIG_DIR and finds the sign-in already there. The
  // overrides below are the managed-mode contract only.
  const env = {
    ...process.env,
    OPENRIG_HOME: dataDir,
    MULTI_AGENT_MODE: 'managed',
    // Loopback only: no LAN or Tailscale fallback (KTD7 / R8).
    OPENRIG_BIND_HOST: '127.0.0.1',
    // The team UI is enabled by environment (settings-store ENV_MAP) instead of writing
    // config.json, which would overwrite the owner's settings.
    OPENRIG_UI_ENABLED: 'true',
  };
  delete env.MULTI_AGENT_OWNER_TOKEN;

  publish({ phase: 'starting', message: 'Starting the local engine…', connected: false });
  engineExit = null;
  let started;
  try {
    started = engineBridge.startEngine({
      dataDir,
      env,
      onExit: exit => onEngineExit(exit),
    });
  } catch (error) {
    publish({ phase: 'start-failed', message: `The engine did not start: ${error.message}`, connected: false });
    return;
  }
  engine = started;
  try {
    const ready = await started.ready;
    enginePid = ready.pid;
    allowedOrigin = `http://127.0.0.1:${ready.port}`;
    console.log(`[desktop] engine ready pid=${ready.pid} origin=${allowedOrigin}`);
    publish({ phase: 'checking', message: 'Reading the local engine…' });
    const rows = await readDependencies(started);
    console.log(`[desktop] dependencies ${rows.map(row => `${row.client}=${row.ok ? row.path : row.reason}`).join(' ')}`);
    publish({ dependencies: rows });
    await openTeamView();
  } catch (error) {
    // The child may still be alive behind a failed readiness (a hang, a crash message): end it
    // here so a failed start never leaves a daemon this app no longer tracks.
    try { await started.shutdown(); } catch { /* already gone */ }
    engine = null;
    enginePid = null;
    allowedOrigin = null;
    console.error(`[desktop] engine start failed: ${error.message}`);
    publish({ phase: 'start-failed', message: `The engine did not start: ${error.message}`, connected: false });
  }
}

/**
 * Stop the engine this app owns.
 *
 * The bridge sends the daemon's own shutdown message and waits for its bounded receipt, then
 * ends what is left of the child's tree. Quitting and the menu action both come here.
 */
async function stopEngine(reason) {
  const current = engine;
  if (!current) return;
  engine = null;
  enginePid = null;
  allowedOrigin = null;
  if (reason !== 'quit') {
    publish({ phase: 'stopped', message: 'The local engine is stopped.', connected: false });
  }
  try {
    await current.shutdown();
  } catch (error) {
    console.error('engine shutdown failed:', error.message);
  }
  console.log('[desktop] engine stopped');
}

/**
 * What a daemon exit that this app did not ask for means.
 *
 * The bridge reports every exit; the ones that matter are the unexpected ones. An exit while
 * the app is stopping its own engine is already accounted for, so it is ignored.
 */
function onEngineExit(exit) {
  if (!engine) return;
  engine = null;
  enginePid = null;
  allowedOrigin = null;
  engineExit = exit;
  console.error(`[desktop] engine exited unexpectedly: ${exit.reason}`);
  publish({ phase: 'engine-exited', message: `The local engine stopped (${exit.reason}).`, connected: false });
  // The team view belongs to the daemon that just went away. Replace it with the page that owns
  // the reconnect action rather than leaving a page whose every request now fails.
  if (window && !window.isDestroyed() && window.webContents.getURL() !== FIRST_RUN_URL) {
    void window.loadURL(FIRST_RUN_URL);
  }
}

/** The engine as this app currently sees it: for the preload and the first-run page. */
function engineStatus() {
  return { running: engine !== null, pid: enginePid, exit: engineExit };
}

async function pollRunningAttempts() {
  if (!allowedOrigin) return undefined;
  try {
    const response = await fetch(`${allowedOrigin}/healthz`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return undefined;
    const body = JSON.parse(await response.text());
    return typeof body.runningAttempts === 'number' ? body.runningAttempts : 0;
  } catch {
    return undefined;
  }
}

/**
 * The first-run dependency list, from the daemon's own resolver.
 *
 * The resolver is the daemon's (U1); this reads its output rather than resolving a second time,
 * so a path the first-run page shows is the path a worker launch will use.
 */
async function readDependencies(current) {
  let resolutions = [];
  try { resolutions = await current.dependencies(); } catch (error) { console.error('[desktop] dependency probe failed:', error.message); resolutions = []; }
  return dependencyRows(resolutions);
}

// ---------------------------------------------------------------- connecting the window

async function openTeamView() {
  if (!allowedOrigin) return;
  publish({ phase: 'pairing', message: 'Connecting this window to the local engine…', connected: false });
  const screenshot = process.env.MULTI_AGENT_DESKTOP_SCREENSHOT;
  if (screenshot) {
    // The first-run page is on screen now; capture it before the window navigates away.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    await captureWindow(screenshot.replace(/\.png$/i, '-setup.png'));
  }
  try {
    const response = await fetch(`${allowedOrigin}/healthz`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`health check failed: ${response.status}`);
    if (!isDaemonHealth(await response.text())) throw new Error('not the expected daemon');
  } catch (error) {
    publish({ phase: 'connection-failed', message: `The local engine did not answer: ${error.message}`, connected: false });
    return;
  }

  // U6 — pair this window the way a browser would: the daemon mints a one-time code over its
  // private parent channel, main exchanges it, and Chromium's jar keeps the HttpOnly cookie.
  // The renderer only ever sees the anti-forgery token.
  const token = await pairOwnerSession();
  if (!token) {
    publish({ phase: 'connection-failed', message: 'The desktop could not connect to the local engine.', connected: false });
    return;
  }
  csrfToken = token;
  try {
    await window.loadURL(`${allowedOrigin}/team`);
  } catch {
    publish({ phase: 'connection-failed', message: 'The engine UI did not load.', connected: false });
    return;
  }
  // The preload consumed the token at document start; forget our copy.
  csrfToken = null;
  console.log(`[desktop] window loaded ${allowedOrigin}/team after pairing`);
  publish({ phase: 'ready', message: 'Connected to the local engine.', connected: true });
  if (process.env.MULTI_AGENT_DESKTOP_SCREENSHOT) {
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await captureWindow(process.env.MULTI_AGENT_DESKTOP_SCREENSHOT);
  }
}

/**
 * U6 — mint a one-time code over the daemon's private parent channel and exchange it.
 *
 * Returns the anti-forgery token, or null when pairing failed. The code and the session cookie
 * never cross into a URL, a log line, or the settings file: the code is used once in the POST
 * body and the cookie goes straight into Chromium's jar.
 */
async function pairOwnerSession() {
  if (!engine || !allowedOrigin || typeof engine.mintPairing !== 'function') return null;
  let code;
  try { code = await engine.mintPairing(); } catch { return null; }
  if (typeof code !== 'string' || code.length === 0) return null;
  let response;
  try {
    response = await fetch(`${allowedOrigin}/api/team-control/owner-session/exchange`, {
      method: 'POST',
      headers: { Origin: allowedOrigin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const setCookie = response.headers.get('set-cookie') || '';
  const match = /(?:^|,\s*)multi_agent_owner=([A-Za-z0-9_-]+)/.exec(setCookie);
  let body;
  try { body = await response.json(); } catch { return null; }
  const antiForgeryToken = body && typeof body.antiForgeryToken === 'string' ? body.antiForgeryToken : null;
  if (!match || !antiForgeryToken) return null;
  try {
    await session.defaultSession.cookies.set({
      url: allowedOrigin, name: 'multi_agent_owner', value: match[1], httpOnly: true, sameSite: 'strict', path: '/api',
    });
  } catch {
    return null;
  }
  return antiForgeryToken;
}

/**
 * U6 — "Open in browser". Mint a fresh one-time code, show and copy it, then open the daemon's
 * own team page in the default browser. The code is never put in the URL: the owner pastes it
 * into the page, which POSTs it to the existing exchange route.
 */
async function openInBrowser() {
  if (!engine || !allowedOrigin) {
    await dialog.showMessageBox({
      type: 'info', buttons: ['OK'], title: 'Open in browser',
      message: 'Connect the desktop to the local engine before opening it in a browser.',
    });
    return;
  }
  let code;
  try { code = await engine.mintPairing(); } catch { code = null; }
  if (!code) {
    await dialog.showMessageBox({
      type: 'error', buttons: ['OK'], title: 'Open in browser',
      message: 'The local engine did not issue a pairing code. Try again.',
    });
    return;
  }
  try { clipboard.writeText(code); } catch { /* clipboard unavailable; the dialog still shows the code */ }
  const box = {
    type: 'info', buttons: ['Open browser'], defaultId: 0, cancelId: 0,
    title: 'Open in browser',
    message: 'Paste this one-time code into the pairing page.',
    detail: `Code: ${code}\n\nIt is copied to your clipboard and expires in one minute.`,
  };
  if (window && !window.isDestroyed()) await dialog.showMessageBox(window, box);
  else await dialog.showMessageBox(box);
  // Only the origin is opened — the code stays in the clipboard and the dialog, never in the URL.
  void shell.openExternal(`${allowedOrigin}/team`);
}

// ---------------------------------------------------------------- actions

function isTeamSender(event, target = window) {
  return !!target && !target.isDestroyed() && event.sender === target.webContents
    && event.senderFrame === target.webContents.mainFrame && isAllowedNavigation(event.senderFrame.url, allowedOrigin);
}

/** Renew without navigating away from the owner's current form or project. */
async function reconnectOwnerSession(event) {
  const currentWindow = window;
  if (!currentWindow || !isTeamSender(event, currentWindow)) throw new Error('Reconnection is available only in the active app window.');
  const token = await pairOwnerSession();
  return window === currentWindow && isTeamSender(event, currentWindow) ? token : null;
}

/**
 * The native Windows folder dialog. It hands the UI the selected Windows path unchanged: the
 * daemon accepts native paths at its team boundary (U7), so nothing converts `D:\code\app`.
 */
async function pickFolder(event) {
  const currentWindow = window;
  if (!currentWindow || !isTeamSender(event, currentWindow)) {
    throw new Error('Folder selection is available only in the active app window.');
  }
  const result = await dialog.showOpenDialog(currentWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
}

/**
 * Reconnect: restart the engine when it is gone, or pair the window again when it is running.
 * Both leave the owner on the page they were on unless the engine itself has to be restarted.
 */
async function reconnectEngine() {
  publish({ phase: 'checking', message: 'Starting the local engine…', connected: false });
  if (!engine) {
    await startEngine();
  } else if (allowedOrigin) {
    await openTeamView();
  }
  return publicState();
}

// ---------------------------------------------------------------- menu and lifecycle

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Engine', submenu: [
      { label: 'Open in browser', click: () => void openInBrowser() },
      { label: 'Reconnect', click: () => void reconnectEngine() },
      { label: 'Stop engine', click: () => void stopEngine() },
      { label: 'Reload window', accelerator: 'CmdOrCtrl+R', click: () => window?.webContents.reload() },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ] },
    { label: 'View', submenu: [
      { role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
    ] },
  ]);
}

if (!app.requestSingleInstanceLock()) {
  // A second launch hands focus to the window that already exists, which owns the one engine.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());

    ipcMain.handle('desktop:get-state', () => publicState());
    ipcMain.handle('desktop:engine-status', () => engineStatus());
    ipcMain.handle('desktop:pick-folder', pickFolder);
    ipcMain.handle('desktop:reconnect', reconnectOwnerSession);
    ipcMain.on('desktop:csrf-token', event => {
      // Synchronous by design: the preload needs the value before the page's scripts run.
      // Any sender other than our own window gets nothing.
      event.returnValue = isTeamSender(event) ? csrfToken : null;
    });
    ipcMain.handle('desktop:reconnect-engine', () => reconnectEngine());

    // This page shows local data and needs no device access.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

    createWindow();
    void startEngine();
  });

  // The engine is owned by this process: quit runs the daemon's bounded shutdown first, then
  // lets the app exit. The close confirmation above already asked when attempts were running.
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!engine) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      await stopEngine('quit');
      app.quit();
    })();
  });

  // Closing the last window quits the app, which triggers before-quit above.
  app.on('window-all-closed', () => app.quit());
}