# Multi-Agent for Windows

A native window around the Multi-Agent Web UI. The engine keeps running in WSL2; this app
starts it, connects to it, and shows your projects. Engine setup and browser pairing are
handled by the app.

## What it does

1. Checks that Windows Subsystem for Linux is installed, has a distribution, and that the
   distribution is WSL 2. If anything is missing it explains what is missing and offers to
   run `wsl --install` (which asks for administrator approval and needs a restart).
2. Finds the engine repository inside the distribution: the path saved in the app's
   settings, then `~/multi-agent`. If neither is there, it offers to clone
   `https://github.com/ronronner02/multi-agent.git` and run `./setup.sh`, streaming the
   output into the first-run screen.
3. Starts the daemon through `scripts/start.sh` when `127.0.0.1:7433` is not answering, and
   turns `ui.enabled` on once with `rig config set` (the daemon reads that setting at start).
4. Pairs the local window automatically and opens the daemon's own team view.

Closing the window leaves the engine running, because agents may still be working.
**Engine → Stop engine** stops it.

## Reopening and reconnecting

The app saves the engine repository path. If a runtime profile is configured in its
settings, the same non-secret state, configuration and GitHub-store paths are used
for startup and local pairing. Reopening does not require entering a browser pairing
code; an existing valid GitHub sign-in opens the project view directly.

An expired owner session is renewed through the native app without reloading the
page, preserving the mounted project and form. Only a pre-action authentication
rejection permits one retry; network and business failures are not replayed. If
startup pairing fails with the selected profile, the connection screen offers **Retry**
instead of silently selecting another profile.

## Sign in and create a project

Install and sign in to the clients you want to use inside the selected WSL
distribution. The lead and workers use those local Claude Code or Codex configurations.
A new project folder does not need git history or a plan file.

1. On first open, choose **Sign in to GitHub**, then **Open GitHub**. Approve the
   displayed one-time code on GitHub. The app opens the project view after verifying
   the account. Browser pairing and GitHub sign-in are separate steps; pairing is automatic here.
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
   This updates the clean, currently checked-out local branch. It does not push.

**Settings** contains General, GitHub, Appearance, Sessions and Agents. General selects
what client future project leads use; Agents displays the roster rather than editing it.
GitHub sign-out and revoking this browser session are different actions: sign-out
returns to the GitHub gate; revocation leaves the desktop disconnected until you
choose **Retry**. In a standalone browser, revocation requires a new pairing code.
Revoking the owner session does not sign GitHub out or stop the team.

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

```powershell
cd desktop
npm ci
npm run dist -- --publish never
```

`npm run dist` writes an NSIS installer to `desktop/dist/`. The build is unsigned, so
Windows shows a SmartScreen warning on first run. Building the installer is separate
from installing it and checking first open with a clean profile; record those checks
separately before claiming desktop acceptance.

Run the app from source with `npm start`. Run the unit tests with `npm test`; they cover the
path mapping, WSL decisions and argv, navigation rules, and the preload/picker boundary with an in-memory window and never start WSL, clone anything or prompt for elevation.

## How it authenticates

The daemon serves its control surface only to a paired owner session. The app uses that
same pairing flow, so there is no token to paste:

1. It mints a one-time pairing code inside WSL, using the owner token that `./setup.sh`
   wrote. That command reads the token from the file and uses it for one loopback request;
   it never prints the token, and the token never leaves WSL.
2. It exchanges the code at `/api/team-control/owner-session/exchange` for an HttpOnly
   session cookie and an anti-forgery token.
3. The cookie goes into Chromium's own cookie jar. The anti-forgery token reaches the
   page through its preload on initial pairing and native renewal, and stays in that
   tab's memory and session storage rather than the app's settings.

The app does not copy the owner credential into its settings, logs or URLs. GitHub
credentials remain in GitHub CLI's store inside WSL; the daemon uses that store for
sign-in and the initial upload. Signing out affects the selected account in that store.

## Security posture

- Context isolation on, Node integration off, sandbox on.
- The page may only load the daemon's own `http://127.0.0.1:7433` origin. Any other
  navigation is refused, and external `http`/`https` links open in the default browser.
- All permission requests from the page are denied.
- WSL commands run through `wsl.exe -e` with an argv, so WSL's outer shell never expands
  anything, and the repository path is always a separate argv element.

## Window chrome

The Web UI owns the command strip and connection footer; the desktop adds no duplicate
bars or body padding. Drag the window by the command strip. Its controls remain clickable,
and space is reserved for the native caption buttons. Setup has its own charcoal drag strip.
Language, theme and settings are shared with the Web UI.

**Browse…** opens the native Windows folder dialog. A drive folder such as
`D:\code\app` becomes `/mnt/d/code/app`; a `\\wsl.localhost\Ubuntu\home\dev\app`
folder becomes `/home/dev/app` only when Ubuntu is the engine's selected distribution.
Another distribution or an unrelated network share produces a selection error. Canceling
keeps the existing form values. Selection returns path data without starting a shell or creating
anything; **Review files** and **Create** still validate the folder and confirm any upload.
