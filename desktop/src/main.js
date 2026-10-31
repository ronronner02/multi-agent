'use strict';
/**
 * The Multi-Agent desktop window.
 *
 * The engine lives in WSL2 and the user never types a WSL command: this process checks WSL,
 * finds or creates the repository, starts the daemon if it is not answering, and then shows
 * the daemon's own Web UI. The window adds a title bar and a connection footer and nothing
 * else; the page inside is the product's own Web UI, untouched.
 *
 * Two rules shape the code below:
 *  - The window may only ever show the daemon's own loopback origin, plus its own local
 *    first-run page. Every other navigation is refused, and external links open in the
 *    user's browser instead.
 *  - No credential is logged, written outside the daemon's own cookie jar, or placed in a
 *    URL. The owner session comes from the daemon's own pairing flow.
 */
const { app, BrowserWindow, Menu, ipcMain, screen, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  DAEMON_ORIGIN, HEALTH_URL, TEAM_URL,
  cloneAndSetupArgv, decideWsl, enableUiArgv, installArgv, isAllowedNavigation, listQuietArgv,
  listVerboseArgv, mintPairingArgv, normalizeRepoPath, parseDistroList, parseDistroTable,
  parsePairingCode, probeRepoArgv, startArgv, statusArgv, stopEngineArgv,
} = require('./wsl.js');

const BACKGROUND = '#151619';
const FIRST_RUN_URL = new URL(`file://${path.join(__dirname, 'first-run.html').replace(/\\/g, '/')}`).href;

let window = null;
let state = { phase: 'checking', message: 'Checking Windows Subsystem for Linux…', log: [], project: null, connected: false };
let resolved = { distro: null, repoPath: null };
let csrfToken = null;

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
    titleBarOverlay: { color: BACKGROUND, symbolColor: '#ededf0', height: 40 },
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

  const contents = window.webContents;
  contents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url) || url === FIRST_RUN_URL) return;
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
      child = spawn('wsl.exe', argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
      child = spawn('wsl.exe', argv, { windowsHide: true, detached, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function healthAnswers() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2_500) });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- startup flow

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
 * The daemon's pairing flow is the only supported way in: mint a one-time code with the
 * owner token inside WSL, exchange it for an HttpOnly cookie plus an anti-forgery token, and
 * hand only the anti-forgery token to the page. The cookie stays in Chromium's jar; the
 * token lives in this tab's session storage; the owner token never leaves WSL.
 */
async function openTeamView() {
  const { distro } = resolved;
  publish({ phase: 'pairing', message: 'Connecting to the local runtime…' });
  let token = null;
  if (distro) {
    const minted = await runWsl(mintPairingArgv(distro), { timeoutMs: 20_000 });
    const code = minted.ok ? parsePairingCode(minted.stdout.toString('utf8')) : null;
    if (code) token = await pair(code);
    else appendLog('No pairing code was available; the team view opens unpaired.');
  }
  await showTeam(token);
}

async function pair(code) {
  let response;
  try {
    response = await fetch(`${DAEMON_ORIGIN}/api/team-control/owner-session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: DAEMON_ORIGIN, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    appendLog('The pairing exchange could not be reached; the team view opens unpaired.');
    return null;
  }
  if (!response.ok) {
    appendLog(`The pairing exchange was refused (HTTP ${response.status}); the team view opens unpaired.`);
    return null;
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body.antiForgeryToken !== 'string') {
    appendLog('The pairing exchange returned no anti-forgery token; the team view opens unpaired.');
    return null;
  }
  // Apply the session cookie to the window's own jar, so the page's requests carry it and the
  // page never has to see the value.
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pairPart] = raw.split(';');
    const index = pairPart.indexOf('=');
    if (index <= 0) continue;
    await session.defaultSession.cookies.set({
      url: DAEMON_ORIGIN,
      name: pairPart.slice(0, index).trim(),
      value: pairPart.slice(index + 1).trim(),
      httpOnly: true,
      sameSite: 'strict',
      path: '/api',
    }).catch(() => undefined);
  }
  return body.antiForgeryToken;
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
    ipcMain.on('desktop:csrf-token', event => {
      // Synchronous by design: the preload needs the value before the page's scripts run.
      // Any sender other than our own window gets nothing.
      event.returnValue = window && !window.isDestroyed() && event.sender === window.webContents ? csrfToken : null;
    });
    ipcMain.handle('desktop:retry', async () => { await checkWsl(); return publicState(); });
    ipcMain.handle('desktop:install-wsl', () => { runInstall(); return publicState(); });
    ipcMain.handle('desktop:clone-repo', async () => { await runClone(); return publicState(); });

    // This page shows local data and needs no device access.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

    createWindow();
    void checkWsl();
  });

  // Closing the window leaves the daemon running: agents may still be working, and the
  // engine is the user's. "Engine → Stop engine" is the explicit way to stop it.
  app.on('window-all-closed', () => app.quit());
}
