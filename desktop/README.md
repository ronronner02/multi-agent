# Multi-Agent for Windows

A native window around the Multi-Agent Web UI. The engine keeps running in WSL2; this app
starts it, connects to it, and shows your teams. Engine setup and browser pairing are
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
4. Opens the daemon's own team view in the window.

Closing the window leaves the engine running, because agents may still be working.
**Engine → Stop engine** stops it.

## Work on your repository

Install and sign in to the clients you want to use inside the selected WSL
distribution. Seats use those local Claude Code or Codex configurations. Your
repository must be available in WSL and have at least one commit.

1. Open **Teams → New team**, choose **Browse…** or enter the repository's WSL path, and choose the clients
   for the lead, implementers and reviewer. No seed script or existing plan is needed.
2. Choose **New work**. A team with a lead starts in planning; discuss the goal in
   the lead chat and choose **Approve plan** when it is ready.
3. Watch the tasks alongside the chat. The daemon records completed turns, starts
   reviews and commits approved work to the team's integration branch. Open a task
   for its attempts, review and diff, or **Commits** for the branch history.
4. Answer escalations in the chat. If the run is blocked, resolve the displayed
   reason and choose **Resume** in its plate. A budget increase is shown before the
   action.
5. Review the integration branch and choose **Merge**. This updates the currently
   checked-out branch in your repository, which must be clean.

The same actions are available in a WSL shell through `rig team create <repository>`,
`rig team start "<goal>" --planning`, `rig team chat <run-id>`,
`rig team approve-plan <run-id>`, `rig team resume <run-id>` and
`rig team merge <run-id>`. See the [quick start](../README.md) and
[operations guide](../docs/operations.md) for the complete commands and browser setup.

## Building

```powershell
cd desktop
npm ci
npm run dist
```

`npm run dist` writes an NSIS installer to `desktop/dist/`. The build is unsigned, so
Windows shows a SmartScreen warning on first run.

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
3. The cookie goes into Chromium's own cookie jar. The anti-forgery token is handed to the
   page once, through its preload, and lives only in that tab's session storage.

No credential is written to a file by this app, logged, or placed in a URL.

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
keeps the entered path. Selection returns path data without starting a shell or creating
anything; the normal Create action still validates and registers the project.
