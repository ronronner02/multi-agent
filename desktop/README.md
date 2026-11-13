# Multi-Agent for Windows

A native Windows window around the Multi-Agent team UI. The engine is the app's own child
process: the window starts it, connects to it, and shows your projects. No WSL, no terminal, and
no separate engine install.

## What it does

1. Starts the daemon as an isolated Electron utility process. The daemon binds `127.0.0.1` on an
   OS-assigned port and reports that origin back over a private parent channel, so nothing here
   assumes a fixed port.
2. Pairs the window automatically: the daemon mints a one-time code over that private channel,
   the window exchanges it for an owner session cookie, and the team view loads already connected.
3. On first run, reads dependency status from the daemon's own executable resolver and shows
   **Git**, **GitHub CLI**, **Claude Code** and **Codex** as found (with the resolved Windows
   path) or missing (with the one install line that fixes it).

Closing the window stops the engine, because the app owns it. **Engine → Stop engine** stops it
without closing the window; **Engine → Reconnect** starts it again.

## Reopening and reconnecting

The app keeps its data in `%LOCALAPPDATA%\Multi-Agent`, so projects, runs and sign-ins survive a
restart; `MULTI_AGENT_DESKTOP_DATA_DIR` overrides that root for tests and manual runs.

The engine inherits the app's own environment, so it reads your real `HOME`/`USERPROFILE`,
`CODEX_HOME` and `CLAUDE_CONFIG_DIR` and finds the client sign-ins already there.

An expired owner session is renewed through the window without reloading the page, preserving the
mounted project and form. Only a pre-action authentication rejection permits one retry; network
and business failures are not replayed. A second launch of the app focuses the window that is
already open instead of starting a second engine.

If the engine exits unexpectedly, the window says so and offers **Reconnect** rather than leaving
a dead page.

## Sign in and create a project

Install and sign in to the clients you want to use. The lead and workers launch the real
`claude.exe` and `codex.exe` on this machine. A new project folder does not need git history or a
plan file.

1. On first open, choose **Sign in to GitHub**, then **Open GitHub**. Approve the
   displayed one-time code on GitHub. The app opens the project view after verifying
   the account.
2. Choose **Create project**, use **Browse…** to select a folder, and enter a project name.
   Choose **Review files**, check the resolved path, exclusions and upload consequence,
   then **Create**. A new folder becomes a private GitHub repository with its initial
   commit pushed. An existing `origin` is registered without a push or visibility change.
3. Enter your goal. The project begins with a lead, which proposes the plan and the
   team it needs. Discuss the proposal in chat, then choose **Approve plan** to approve
   both. For a later run in the project, choose **New work**.
4. Follow progress and selected-task evidence on **Overview**, live seat activity
   on **Workspace**, and candidate findings on **Reviews**. **Tasks** has a searchable
   list with a persistent inspector for the task brief, declared acceptance text,
   existing task worktree, integration branch, attempts and reports; **Board** retains
   dependency stages. Declared criteria are requirements, not verified progress. **Analytics** shows the project's captured token use over 7 or
   30 days; missing counters are not estimates.
5. Answer escalations in chat. For a blocked run, resolve the reason and choose
   **Resume**; any budget increase is shown before the action.
6. Inspect task diffs and the integration history on Overview, then choose **Merge**.
   This updates the clean, currently-checked-out local branch. It does not push.

**Settings** contains General, GitHub, Appearance, Sessions and Agents. General selects
what client future project leads use; Agents displays the roster rather than editing it.
GitHub sign-out and revoking this browser session are different actions: sign-out
returns to the GitHub gate; revocation leaves the desktop disconnected until you
choose **Reconnect**. In a standalone browser, revocation requires a new pairing code,
which **Engine → Open in browser** shows and copies. Revoking the owner session does
not sign GitHub out or stop the team.

The command strip contains the project and run selectors, navigation and lead chat.
The mobile layout folds navigation into a menu. See the [quick start](../README.md)
and [operations guide](../docs/operations.md) for CLI commands, Create retries and
browser setup.

The **Shuimo Danqing** ink-wash backdrop remains visible around the content panels
and in the Overview heading. **Settings → Appearance** controls theme and background
motion. The entrance plays once per app session. Afterward, only the fully revealed
character remains animated: navigation, reload and reconnect do not replay the
entrance or the fade to an empty canvas. Closing and reopening the app starts a new
session. Animation pauses while the window is unfocused or hidden; reduced motion
or disabling background motion shows the portrait still instead.

## Building

Build the engine first (`cd engine; npm ci; npm run build`), then:

```powershell
cd desktop
npm ci
npm run dist
```

`npm run dist` stages the installer's runtime, then builds the NSIS artifact:

1. `node scripts/stage-engine.mjs` copies the daemon build, its assets, the shipped specs, the
   Web UI build and `engine/config` into `desktop/resources/engine/`, and copies the daemon's
   production `node_modules` beside them (`desktop/resources/engine/node_modules`). That tree
   keeps the relative layout the daemon resolves with `new URL("../../...", import.meta.url)`.
   better-sqlite3 is taken from its win32-x64 prebuild; no compiler is involved.
2. `node scripts/stage-gh.mjs` downloads the GitHub CLI release pinned in
   `engine/config/toolchain/gh-lock.json`, verifies its SHA-256, and extracts `gh.exe` to
   `desktop/resources/engine/plugins/github-cli/`. The daemon's executable resolver looks there
   after an explicit configured path and before PATH, so GitHub sign-in needs no separate install.
3. `electron-builder --win nsis --x64` writes `desktop/dist/Multi-Agent-Setup-<version>-x64.exe`.

The build is unsigned, so Windows shows a SmartScreen warning on first run: choose **More info**
then **Run anyway**. Signing, auto-update and publishing are out of scope, so the installer is the
whole delivery. Installing N+1 over N replaces the program files; uninstalling removes them but
keeps `%LOCALAPPDATA%\Multi-Agent` and `%APPDATA%\Multi-Agent`, including recovery records of
interrupted runs.

The engine tree must be rebuilt before staging (`npm run stage:check` fails when the staged copy
is older than the engine build). The packaged-engine test runs the packaged `Multi-Agent.exe` with
`ELECTRON_RUN_AS_NODE=1`, so it loads better-sqlite3 from the staged tree and opens a real
database without opening a window.

The app runs the daemon from `resources/engine/packages/daemon/dist/index.js` when packaged, and
from `engine/packages/daemon/dist/index.js` in a source checkout (`src/engine-paths.js`). Run the
app from source with `npm start`. Run the unit tests with `npm test`; they cover the startup
sequence, the dynamic origin, pairing, dependency rows, the folder dialog, the preload boundary,
reconnect, shutdown, and the staged installer tree, with an in-memory window. The installer
lifecycle test is opt-in (`MULTI_AGENT_INSTALLER_SMOKE=1` with two artifacts) because it installs
an artifact and writes an uninstall entry.

## How it authenticates

The daemon serves its control surface only to a paired owner session. The app uses that
same pairing flow, so there is no token to paste:

1. The daemon mints a one-time code over the private parent channel. Only this app's main process
   can reach that channel, so no HTTP route changes and no owner token is held in Electron.
2. The window exchanges the code at `/api/team-control/owner-session/exchange` for an HttpOnly
   session cookie and an anti-forgery token.
3. The cookie goes into Chromium's own cookie jar. The anti-forgery token reaches the
   page through its preload on initial pairing and native renewal, and stays in that
   tab's memory and session storage rather than the app's settings.

The app does not copy the owner credential into its settings, logs or URLs. GitHub
credentials remain in GitHub CLI's own store, and the daemon uses that store for sign-in and the
initial upload. Signing out affects the selected account in that store.

## Security posture

- Context isolation on, Node integration off, sandbox on.
- The page may only load the engine's own current `127.0.0.1` origin. Any other navigation is
  refused, and external `http`/`https` links open in the default browser.
- All permission requests from the page are denied.

## Window chrome

The Web UI owns the command strip and connection footer; the desktop adds no duplicate
bars or body padding. Drag the window by the command strip. Its controls remain clickable,
and space is reserved for the native caption buttons. Setup has its own charcoal drag strip.
Language, theme and settings are shared with the Web UI.

**Browse…** opens the native Windows folder dialog and returns the selected path unchanged:
`D:\code\app` stays `D:\code\app`. Canceling keeps the existing form values. Selection returns
path data without starting a shell or creating anything; **Review files** and **Create** still
validate the folder and confirm any upload.