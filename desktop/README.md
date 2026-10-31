# Multi-Agent for Windows

A native window around the Multi-Agent Web UI. The engine keeps running in WSL2; this app
starts it, connects to it, and shows the team view. You never type a WSL command.

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

## Building

```powershell
cd desktop
npm ci
npm run dist
```

`npm run dist` writes an NSIS installer to `desktop/dist/`. The build is unsigned, so
Windows shows a SmartScreen warning on first run.

Run the app from source with `npm start`. Run the unit tests with `npm test`; they cover the
pure parts only (WSL output parsing, the install/version decision, the repository-path check
and every WSL argv) and never start WSL, clone anything or prompt for elevation.

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

The title bar and the connection footer are this app's own local HTML, in the desktop
design's charcoal (`#151619`). The page itself is the product's Web UI and is not restyled
here; a separate slice rebuilds it against the new design.
