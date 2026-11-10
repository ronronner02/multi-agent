'use strict';
/**
 * The Multi-Agent desktop window.
 *
 * The engine lives in WSL2 and the user never types a WSL command: this process checks WSL,
 * finds or creates the repository, starts the daemon if it is not answering, and then shows
 * the daemon's own Web UI. The shared page owns its chrome; this process supplies native
 * caption controls and folder selection.
 *
 * Two rules shape the code below:
 *  - The window may only ever show the daemon's own loopback origin, plus its own local
 *    first-run page. Every other navigation is refused, and external links open in the
 *    user's browser instead.
 *  - No credential is logged, written outside the daemon's own cookie jar, or placed in a
 *    URL. The owner session comes from the daemon's own pairing flow.
 */
const { app, BrowserWindow, Menu, ipcMain, screen, session, shell, dialog, clipboard } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// U5 — the native engine switch. Native is the default on Windows when the
// built daemon entry exists; `MULTI_AGENT_DESKTOP_ENGINE=wsl` keeps the old
// WSL path reachable until U12 deletes it.
const NATIVE_DAEMON_ENTRY = path.resolve(__dirname, '../../engine/packages/daemon/dist/index.js');
const hasNativeDaemon = process.env.MULTI_AGENT_DESKTOP_ENGINE === 'wsl'
  ? false
  : fs.existsSync(NATIVE_DAEMON_ENTRY);

let engineBridge = null;
if (hasNativeDaemon) {
  engineBridge = require('./engine-bridge.js');
}

const {
  DAEMON_ORIGIN, HEALTH_URL, TEAM_URL,
  cloneAndSetupArgv, decideWsl, enableUiArgv, installArgv, isAllowedNavigation, isDaemonHealth,
  listQuietArgv, listVerboseArgv, nativeFolderToWsl, normalizeRepoPath, pairArgv, parseDistroList, parseDistroTable,
  parsePairingResult, probeRepoArgv, runtimeEnvironment, startArgv, statusArgv, stopEngineArgv,
} = require('./wsl.js');

const BACKGROUND = '#151619';
const FIRST_RUN_URL = new URL(`file://${path.join(__dirname, 'first-run.html').replace(/\\/g, '/')}`).href;

// U5 — configurable data directory (KTD7). Production defaults to
// %LOCALAPPDATA%\Multi-Agent. Override via MULTI_AGENT_DESKTOP_DATA_DIR
// for tests and manual runs.
const DATA_DIR_ROOT = process.env.MULTI_AGENT_DESKTOP_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Multi-Agent');

let window = null;
let state = { phase: 'checking', message: 'Checking Windows Subsystem for Linux…', log: [], project: null, connected: false };
let resolved = { distro: null, repoPath: null };
let csrfToken = null;

// U5 — native engine state
let nativeEngine = null;
let nativeDaemonPid = null;
// The one origin the window may show. The WSL path uses the fixed daemon origin;
// the native path replaces it with the OS-assigned loopback origin after readiness.
let allowedOrigin = DAEMON_ORIGIN;

// ---------------------------------------------------------------- settings

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, 2), 'utf8');
  } catch (error) {
    console.error('settings write failed:', error.message);
  }
}

// ---------------------------------------------------------------- state

function publicState() {
  return { phase: state.phase, message: state.message, connected: state.connected, project: state.project, log: state.log.slice(-200) };
}

function publish(patch) {
  state = { ...state, ...patch };
  if (window && !window.isDestroyed()) window.webContents.send('desktop:state', publicState());
}

function appendLog(line) {
  const text = String(line).replace(/\r/g, '').trimEnd();
  if (!text) return;
  state = { ...state, log: [...state.log, text].slice(-200) };
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

  // U5 — closing the last window while attempts are running asks for confirmation.
  // The one-line consequence: agents stop, and Resume continues next time.
  // Running attempt state is polled from the daemon's /healthz endpoint.
  window.on('close', async (event) => {
    if (!nativeEngine) return;
    // Poll the daemon one more time fresh for the confirmation decision.
    const count = await pollRunningAttempts(allowedOrigin || undefined);
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
    appendLog(`page load failed: ${description}`);
  });

  void window.loadURL(FIRST_RUN_URL);
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

// ---------------------------------------------------------------- WSL

/** Run a WSL command and collect its bytes. Used only for short commands. */
function runWsl(argv, { timeoutMs = 20_000 } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('wsl.exe', argv, { windowsHide: true, env: runtimeEnvironment(process.env, readSettings().runtimeProfile), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, stdout: Buffer.alloc(0) });
      return;
    }
    const chunks = [];
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: Buffer.concat(chunks) });
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, timeoutMs);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', () => finish(false));
    child.on('close', code => finish(code === 0));
  });
}

/** Run a WSL command and stream each output line to the first-run screen. */
function streamWsl(argv, { detached = false } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('wsl.exe', argv, { windowsHide: true, detached, env: runtimeEnvironment(process.env, readSettings().runtimeProfile), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false });
      return;
    }
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) appendLog(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => resolve({ ok: false }));
    child.on('close', code => {
      if (buffer) appendLog(buffer);
      resolve({ ok: code === 0 });
    });
    if (detached) child.unref();
  });
}

/**
 * Is the daemon answering, and is it this product's daemon?
 *
 * A bare 200 is not proof: any local process can listen on the port, and the window is about
 * to load and trust whatever answers. The body has to carry the daemon's own health fields.
 */
async function healthAnswers() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return false;
    return isDaemonHealth(await response.text());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- startup flow

/**
 * U5 — native daemon startup: fork the utility process and wait for ready.
 * Uses a stable OPENRIG_HOME under the data directory (KTD7). The child
 * inherits the parent environment (HOME, USERPROFILE, auth config, etc.
 * pass through) so real Claude/Codex agents find the user's sign-in and
 * config. OPENRIG_HOME is <data root>\engine, stable across launches.
 * The team view is enabled via OPENRIG_UI_ENABLED=true (settings-store
 * ENV_MAP), so no config.json is written or overwritten.
 */
async function startNativeEngine() {
  if (!engineBridge) return false;

  // Stable engine data directory under the configured data root.
  const dataDir = path.join(DATA_DIR_ROOT, 'engine');
  fs.mkdirSync(dataDir, { recursive: true });

  // Inherit the parent environment unchanged, then apply overrides.
  const env = {
    ...process.env,
    OPENRIG_HOME: dataDir,
    MULTI_AGENT_MODE: 'managed',
    // Loopback only: no LAN or Tailscale fallback (KTD7 / R8).
    OPENRIG_BIND_HOST: '127.0.0.1',
    // Enable the team UI via env var (settings-store ENV_MAP) rather than
    // writing config.json, which would overwrite user settings.
    OPENRIG_UI_ENABLED: 'true',
  };
  // Clear the owner token so no real auth is used.
  delete env.MULTI_AGENT_OWNER_TOKEN;

  try {
    nativeEngine = engineBridge.startEngine({ dataDir, env });
    const readyInfo = await nativeEngine.ready;
    nativeDaemonPid = readyInfo.pid;
    publish({ phase: 'starting', message: `Native daemon ready on port ${readyInfo.port}`, connected: false });
    await openNativeTeamView(readyInfo.port);
  } catch (error) {
    publish({ phase: 'start-failed', message: `Native daemon failed: ${error.message}` });
    nativeEngine = null;
    nativeDaemonPid = null;
  }
}

async function openNativeTeamView(port) {
  const origin = `http://127.0.0.1:${port}`;
  const teamUrl = `${origin}/team`;
  allowedOrigin = origin;

  // Check health before loading
  try {
    const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`health check failed: ${response.status}`);
    const body = await response.text();
    if (!isDaemonHealth(body)) throw new Error('not the expected daemon');
  } catch (error) {
    publish({ phase: 'connection-failed', message: `Health check failed: ${error.message}`, connected: false });
    return;
  }

  publish({ phase: 'pairing', message: 'Connecting to the local runtime…' });
  // U6 — pair this window the same way a browser would: the daemon mints a one-time code
  // over its private parent channel, main exchanges it, and Chromium's jar keeps the
  // HttpOnly cookie. The renderer only ever sees the anti-forgery token.
  const token = await pairNativeOwnerSession(origin);
  if (!token) {
    publish({ phase: 'connection-failed', message: 'The desktop could not connect to the local runtime.', connected: false });
    return;
  }
  csrfToken = token;
  try {
    await window.loadURL(teamUrl);
  } catch {
    publish({ phase: 'connection-failed', message: 'Failed to load the UI.', connected: false });
    return;
  }
  // The preload consumed the token at document start; forget our copy.
  csrfToken = null;
  publish({
    phase: 'ready',
    message: 'Local runtime connected.',
    connected: true,
  });
}

/**
 * U6 — mint a one-time code over the daemon's private parent channel and exchange it.
 *
 * Returns the anti-forgery token, or null when pairing failed. The code and the session
 * cookie never cross into a URL, a log line, or the settings file: the code is used once
 * in the POST body and the cookie goes straight into Chromium's jar.
 */
async function pairNativeOwnerSession(origin) {
  if (!nativeEngine || typeof nativeEngine.mintPairing !== 'function') return null;
  let code;
  try { code = await nativeEngine.mintPairing(); } catch { return null; }
  if (typeof code !== 'string' || code.length === 0) return null;
  let response;
  try {
    response = await fetch(`${origin}/api/team-control/owner-session/exchange`, {
      method: 'POST',
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
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
      url: origin, name: 'multi_agent_owner', value: match[1], httpOnly: true, sameSite: 'strict', path: '/api',
    });
  } catch {
    return null;
  }
  return antiForgeryToken;
}

/**
 * U6 — "Open in browser". Mint a fresh one-time code, show and copy it, then open the
 * daemon's own pairing page in the default browser. The code is never put in the URL: the
 * owner pastes it into the page, which POSTs it to the existing exchange route.
 */
async function openInBrowser() {
  if (!nativeEngine || !allowedOrigin || !nativeEngine.mintPairing) {
    await dialog.showMessageBox({
      type: 'info', buttons: ['OK'], title: 'Open in browser',
      message: 'Connect the desktop to the local runtime before opening it in a browser.',
    });
    return;
  }
  let code;
  try { code = await nativeEngine.mintPairing(); } catch { code = null; }
  if (!code) {
    await dialog.showMessageBox({
      type: 'error', buttons: ['OK'], title: 'Open in browser',
      message: 'The local runtime did not issue a pairing code. Try again.',
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
  // The pairing page is the team view's own unpaired form. Only the origin is opened —
  // the code stays in the clipboard and the dialog, never in the URL.
  void shell.openExternal(`${allowedOrigin}/team`);
}

/**
 * Poll the daemon's /healthz endpoint for running attempt count.
 * Returns the count, or undefined when the daemon is not answering.
 */
async function pollRunningAttempts(origin) {
  try {
    const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return undefined;
    const body = JSON.parse(await response.text());
    return typeof body.runningAttempts === 'number' ? body.runningAttempts : 0;
  } catch {
    return undefined;
  }
}

async function checkWsl() {
  publish({ phase: 'checking', message: 'Checking Windows Subsystem for Linux…' });
  const status = await runWsl(statusArgv());
  const verbose = await runWsl(listVerboseArgv());
  const quiet = verbose.ok ? { ok: true, stdout: Buffer.alloc(0) } : await runWsl(listQuietArgv());
  const distros = parseDistroList(verbose.ok ? verbose.stdout : quiet.stdout);
  const table = parseDistroTable(verbose.stdout);
  const decision = decideWsl({ statusOk: status.ok, distros, table });
  resolved = { distro: decision.distro ?? null, repoPath: null };

  if (decision.kind !== 'ready') {
    publish({
      phase: decision.kind,
      message: decision.kind === 'wsl1' ? 'Your Linux distribution runs on WSL 1; this app needs WSL 2.'
        : decision.kind === 'no-distro' ? 'No Linux distribution is set up yet.'
          : decision.kind === 'wsl-missing' ? 'Windows Subsystem for Linux is not installed.'
            : 'The WSL probe did not answer.',
    });
    return;
  }
  await findRepository(decision.distro);
}

async function findRepository(distro) {
  publish({ phase: 'checking', message: 'Looking for the Multi-Agent engine…' });
  const saved = normalizeRepoPath(readSettings().repoPath);
  const candidates = saved ? [saved] : [];
  candidates.push(`/home/${await wslUser(distro)}/multi-agent`);

  for (const candidate of [...new Set(candidates)]) {
    const probe = await runWsl(probeRepoArgv(distro, candidate));
    if (probe.ok && probe.stdout.toString('utf8').includes('ready')) {
      resolved = { distro, repoPath: candidate };
      writeSettings({ repoPath: candidate });
      await startEngine();
      return;
    }
  }
  resolved = { distro, repoPath: null };
  publish({ phase: 'no-repo', message: 'The engine is not installed yet.' });
}

/** The default WSL user's name, used only to guess `~/multi-agent` before a path is saved. */
async function wslUser(distro) {
  const result = await runWsl(['-d', distro, '-e', 'bash', '-lc', 'printf %s "$USER"']);
  const name = result.stdout.toString('utf8').trim();
  return /^[a-z_][a-z0-9_-]*$/.test(name) ? name : 'user';
}

async function startEngine() {
  const { distro, repoPath } = resolved;
  if (!distro || !repoPath) return;

  if (await healthAnswers()) {
    await openTeamView();
    return;
  }

  publish({ phase: 'starting', message: 'Starting the local runtime…' });
  // The daemon reads `ui.enabled` once at startup, so this runs before the first start and
  // is harmless afterwards. A failure here is not fatal: the start reports its own outcome.
  if (!readSettings().uiEnabled) {
    const enabled = await runWsl(enableUiArgv(distro, repoPath), { timeoutMs: 60_000 });
    if (enabled.ok) writeSettings({ uiEnabled: true });
  }

  await streamWsl(startArgv(distro, repoPath), { detached: true });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await healthAnswers()) {
      await openTeamView();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  publish({ phase: 'start-failed', message: 'The local runtime did not answer on 127.0.0.1:7433.' });
}

/**
 * Open the team view with an owner session.
 *
 * The whole pairing runs inside WSL, through the daemon's own flow: mint a one-time code with
 * the owner token, exchange it for an HttpOnly cookie plus an anti-forgery token, and print
 * only those two. Neither the owner token nor the one-time code crosses into Windows, so a
 * rogue listener on Windows `127.0.0.1:7433` never receives either. The cookie goes into
 * Chromium's jar; the anti-forgery token lives in this tab's session storage.
 */
async function openTeamView() {
  publish({ phase: 'pairing', message: 'Connecting to the local runtime?' });
  const token = await pairOwnerSession();
  if (!token) {
    publish({ phase: 'connection-failed', message: 'The desktop could not connect to the selected runtime profile.', connected: false });
    return;
  }
  await showTeam(token);
}

async function pairOwnerSession() {
  const { distro } = resolved;
  if (!distro) return null;
  const paired = await runWsl(pairArgv(distro), { timeoutMs: 30_000 });
  const result = paired.ok ? parsePairingResult(paired.stdout.toString('utf8')) : null;
  if (!result) return null;
  try {
    await session.defaultSession.cookies.set({
      url: DAEMON_ORIGIN, name: 'multi_agent_owner', value: result.cookie, httpOnly: true, sameSite: 'strict', path: '/api',
    });
    return result.antiForgeryToken;
  } catch {
    return null;
  }
}

function isTeamSender(event, target = window) {
  return !!target && !target.isDestroyed() && event.sender === target.webContents
    && event.senderFrame === target.webContents.mainFrame && isAllowedNavigation(event.senderFrame.url, allowedOrigin);
}

/** Renew without navigating away from the owner's current form or project. */
async function reconnectOwnerSession(event) {
  const currentWindow = window;
  if (!isTeamSender(event, currentWindow)) throw new Error('Reconnection is available only in the active app window.');
  const token = nativeEngine ? await pairNativeOwnerSession(allowedOrigin) : await pairOwnerSession();
  return window === currentWindow && isTeamSender(event, currentWindow) ? token : null;
}

async function showTeam(token) {
  if (!window || window.isDestroyed()) return;
  csrfToken = token;
  await window.loadURL(TEAM_URL).catch(() => undefined);
  // The preload consumed the token at document start; forget our copy.
  csrfToken = null;
  publish({
    phase: 'ready',
    message: 'Local runtime connected.',
    connected: true,
    project: resolved.repoPath ? path.posix.basename(resolved.repoPath) : null,
  });
}

// ---------------------------------------------------------------- actions

async function pickFolder(event) {
  const currentWindow = window;
  const { distro } = resolved;
  if (!isTeamSender(event, currentWindow) || !distro) {
    throw new Error('Folder selection is available only in the active project window.');
  }
  const result = await dialog.showOpenDialog(currentWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const folder = nativeFolderToWsl(result.filePaths[0], distro);
  if (folder === null) throw new Error('Select a folder on a Windows drive or in the selected WSL distribution.');
  return folder;
}

function runInstall() {
  publish({ phase: 'installing', message: 'Windows is installing WSL. Approve the elevation prompt.' });
  const child = spawn('powershell.exe', installArgv(), { windowsHide: false, stdio: 'ignore' });
  child.on('error', () => publish({ phase: 'unknown', message: 'The installer could not be started.' }));
  child.on('close', code => {
    publish(code === 0
      ? { phase: 'reboot', message: 'WSL is installed. Restart Windows, then open Multi-Agent again.' }
      : { phase: 'unknown', message: 'The WSL installer did not finish.' });
  });
}

async function runClone() {
  const { distro } = resolved;
  if (!distro) return;
  publish({ phase: 'cloning', message: 'Downloading the engine and running setup…' });
  const result = await streamWsl(cloneAndSetupArgv(distro));
  if (!result.ok) {
    publish({ phase: 'no-repo', message: 'Setup did not finish. See the output above.' });
    return;
  }
  resolved = { distro, repoPath: `/home/${await wslUser(distro)}/multi-agent` };
  writeSettings({ repoPath: resolved.repoPath, uiEnabled: true });
  await startEngine();
}

async function runStopEngine() {
  // U5 — native engine: stop via the bridge.
  if (nativeEngine) {
    publish({ message: 'Stopping the local runtime…' });
    await nativeEngine.shutdown();
    nativeEngine = null;
    nativeDaemonPid = null;
    publish({ connected: false, message: 'Local runtime stopped.' });
    return;
  }
  const { distro, repoPath } = resolved;
  if (!distro || !repoPath) return;
  publish({ message: 'Stopping the local runtime…' });
  await runWsl(stopEngineArgv(distro, repoPath), { timeoutMs: 30_000 });
  publish({ connected: false, message: 'Local runtime stopped.' });
}

// ---------------------------------------------------------------- menu and lifecycle

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Engine', submenu: [
      { label: 'Open in browser', click: () => void openInBrowser() },
      { label: 'Stop engine', click: () => void runStopEngine() },
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
    ipcMain.handle('desktop:pick-folder', pickFolder);
    ipcMain.handle('desktop:reconnect', reconnectOwnerSession);
    ipcMain.on('desktop:csrf-token', event => {
      // Synchronous by design: the preload needs the value before the page's scripts run.
      // Any sender other than our own window gets nothing.
      event.returnValue = isTeamSender(event) ? csrfToken : null;
    });
    ipcMain.handle('desktop:retry', async () => {
      if (hasNativeDaemon) { await startNativeEngine(); return publicState(); }
      await checkWsl(); return publicState();
    });
    ipcMain.handle('desktop:install-wsl', () => { runInstall(); return publicState(); });
    ipcMain.handle('desktop:clone-repo', async () => { await runClone(); return publicState(); });

    // This page shows local data and needs no device access.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

    createWindow();
    // U5 — native is the default on Windows when the bundled daemon entry exists.
    // The WSL path stays reachable until U12.
    if (hasNativeDaemon) {
      void startNativeEngine();
    } else {
      void checkWsl();
    }
  });

  // U5 — the native engine is owned by this process: quit runs the daemon's own
  // bounded shutdown first (receipt included), then lets the app exit.
  // The close confirmation above already asked when attempts were running.
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting || !nativeEngine) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try { await nativeEngine.shutdown(); } catch { /* already gone */ }
      nativeEngine = null;
      nativeDaemonPid = null;
      app.quit();
    })();
  });

  // Closing the last window quits the app, which triggers before-quit above.
  app.on('window-all-closed', () => app.quit());
}
