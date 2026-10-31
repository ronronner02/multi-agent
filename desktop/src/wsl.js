/**
 * Pure decisions for the desktop window: what the WSL probe means, which distro to use,
 * which repository path to trust, and the exact argv for every WSL command.
 *
 * Nothing here touches Electron, the filesystem or a child process, so `node --test` can
 * cover every branch without a WSL install, a clone or an elevated prompt.
 */

/** WSL writes its console output as UTF-16LE with a BOM; NUL bytes sit between every character. */
function decodeUtf16le(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";
  const body = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2) : buffer;
  return body.toString("utf16le");
}

/**
 * Decode one WSL console result. WSL emits UTF-16LE on stdout, but a localized build can
 * leave stray bytes; the NUL-heavy shape is the reliable signal, so a buffer without any
 * NUL falls back to UTF-8 instead of being shredded into CJK garbage.
 */
export function decodeWslOutput(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";
  return buffer.includes(0) ? decodeUtf16le(buffer) : buffer.toString("utf8");
}

/** `wsl.exe -l -q` prints one distro name per line, the default marked with `*` in `-l -v`. */
export function parseDistroList(stdout) {
  const distros = [];
  for (const rawLine of decodeWslOutput(stdout).split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, "").trim();
    if (!line) continue;
    const isDefault = line.startsWith("*");
    const name = (isDefault ? line.slice(1) : line).trim();
    if (name) distros.push({ name, isDefault });
  }
  return distros;
}

/**
 * `wsl.exe -l -v` rows look like `* Ubuntu   Running   2`. Version 1 means WSL1, which the
 * engine cannot run in: its setup needs a real Linux user, a tmux server and Node 22/24.
 */
export function parseDistroTable(stdout) {
  const rows = [];
  for (const rawLine of decodeWslOutput(stdout).split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, "").trimEnd();
    if (!line.trim() || /^\s*NAME\s+STATE\s+VERSION/.test(line)) continue;
    const match = /^(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line.trim());
    if (match) rows.push({ name: match[2], state: match[3], version: Number(match[4]), isDefault: !!match[1] });
  }
  return rows;
}

/**
 * The one decision the first-run screen acts on.
 *
 * `ready` means a WSL2 distro exists and the app may look for the repository. `no-distro`
 * and `wsl1` are installable problems (`wsl --install` fixes both). `wsl-missing` means the
 * feature itself is absent, which only an elevated `wsl --install --no-distribution` plus a
 * reboot can fix. `unknown` is a failed probe, never proof of absence.
 */
export function decideWsl({ statusOk, distros, table }) {
  if (!statusOk && distros.length === 0) return { kind: "wsl-missing" };
  if (distros.length === 0) return { kind: "no-distro" };
  const versions = table.map(row => row.version);
  const chosen = table.find(row => row.isDefault && row.version === 2)
    ?? table.find(row => row.version === 2)
    ?? table.find(row => row.isDefault)
    ?? table[0];
  if (!chosen) {
    // The list answered but the version table did not: prefer the default name and let the
    // repository probe discover a WSL1 distro's own failure rather than blocking the user.
    const fallback = distros.find(distro => distro.isDefault) ?? distros[0];
    return { kind: "ready", distro: fallback.name, version: null };
  }
  if (chosen.version === 1 && versions.every(version => version === 1)) {
    return { kind: "wsl1", distro: chosen.name };
  }
  if (chosen.version === 1) {
    const wsl2 = table.find(row => row.version === 2);
    return { kind: "ready", distro: wsl2.name, version: 2 };
  }
  return { kind: "ready", distro: chosen.name, version: chosen.version };
}

/**
 * A saved repository path is used only when it is an absolute POSIX path under the user's
 * home or `/srv`. The value crosses a file the user can edit, so a `~`, a relative path or a
 * shell metacharacter must not reach an argv that runs inside WSL.
 */
export function normalizeRepoPath(candidate) {
  if (typeof candidate !== "string") return null;
  const value = candidate.trim();
  if (!value.startsWith("/") || value.includes("..")) return null;
  if (!/^\/[A-Za-z0-9._\-/]+$/.test(value)) return null;
  return value.replace(/\/+$/, "") || null;
}

/** `wsl.exe --status`, run without a shell. */
export function statusArgv() {
  return ["--status"];
}

/** `wsl.exe -l -v` — names, states and versions in one call. */
export function listVerboseArgv() {
  return ["-l", "-v"];
}

/** `wsl.exe -l -q` — the plain list, used when the verbose table cannot be parsed. */
export function listQuietArgv() {
  return ["-l", "-q"];
}

/**
 * `wsl --install` is the only command here that needs elevation, and it is the only one the
 * app runs through a shell: Windows has no direct "run this elevated" spawn, so the app asks
 * the shell to elevate a fixed command string. Nothing from the user is interpolated.
 */
export function installArgv() {
  return ["-NoProfile", "-Command", "Start-Process wsl.exe -ArgumentList '--install' -Verb RunAs -Wait"];
}

/**
 * One probe inside the distro. `-e` skips WSL's outer shell entirely, so the argv reaches
 * bash exactly as written and nothing expands `$VAR` on the way in.
 *
 * `.git` is tested with `-e`, not `-d`: in a clone it is a directory, but in a linked
 * worktree it is a file, and both are a repository this app can start.
 */
export function probeRepoArgv(distro, repoPath) {
  return ["-d", distro, "-e", "bash", "-c",
    'd="$1"; [ -e "$d/.git" ] && [ -f "$d/scripts/start.sh" ] && [ -x "$d/engine/node_modules/.bin/rig" ] && printf ready',
    "probe", repoPath];
}

/**
 * Every command that runs project code uses `bash -lc`, because that is the shell a fresh
 * WSL terminal is: it loads the distro profile, which is where a version manager puts
 * `node` on PATH. `./setup.sh` requires Node 22/24 and reports a missing one itself; the
 * app never guesses at a Node location.
 */
const LOGIN_SHELL = "bash";
const LOGIN_FLAG = "-lc";

/** `./setup.sh` from the repository root, streamed to the first-run screen. */
export function setupArgv(distro, repoPath) {
  return ["-d", distro, "-e", LOGIN_SHELL, LOGIN_FLAG, 'cd "$1" || exit 1; exec ./setup.sh', "setup", repoPath];
}

/** The daemon launcher the repository owns. Kept in one place so the argv is reviewable. */
export function startArgv(distro, repoPath) {
  return ["-d", distro, "-e", LOGIN_SHELL, LOGIN_FLAG, 'cd "$1" || exit 1; exec ./scripts/start.sh', "start", repoPath];
}

/**
 * Enable the web UI once. The daemon reads `ui.enabled` at startup, so this runs before the
 * first start; a daemon that is already running keeps its old value until restarted.
 */
export function enableUiArgv(distro, repoPath) {
  return ["-d", distro, "-e", LOGIN_SHELL, LOGIN_FLAG,
    'cd "$1/engine" || exit 1; exec node_modules/.bin/rig config set ui.enabled true', "enable-ui", repoPath];
}

/** `rig daemon stop`, the "Stop engine" menu action. */
export function stopEngineArgv(distro, repoPath) {
  return ["-d", distro, "-e", LOGIN_SHELL, LOGIN_FLAG,
    'cd "$1/engine" || exit 1; exec node_modules/.bin/rig daemon stop', "stop", repoPath];
}

/** `git clone` + `./setup.sh`, in one streamed command, only when the user asks for it. */
export function cloneAndSetupArgv(distro) {
  return ["-d", distro, "-e", LOGIN_SHELL, LOGIN_FLAG,
    'set -e; cd "$HOME"; [ -e multi-agent ] && { echo "~/multi-agent already exists"; exit 1; }; '
    + 'git clone https://github.com/ronronner02/multi-agent.git multi-agent; cd multi-agent; exec ./setup.sh',
    "clone"];
}

/**
 * Pair this window with the daemon, entirely inside the distro.
 *
 * Both halves stay in WSL on purpose. The owner token is the daemon's own credential and
 * never leaves WSL, and the one-time code and the session it buys never cross the Windows
 * boundary either: a rogue process listening on Windows `127.0.0.1:7433` never sees them.
 * The app receives only the finished session cookie and anti-forgery token, which it would
 * hold anyway.
 *
 * The token reaches curl through `-K -` on stdin, not argv, so it never appears in a
 * process command line that any other local user can read.
 */
export function pairArgv(distro) {
  return ["-d", distro, "-e", LOGIN_SHELL, LOGIN_FLAG, PAIR_SCRIPT, "pair"];
}

/**
 * The in-distro pairing script. Written as lines rather than a template literal so the
 * shell's own `${...}` expressions stay literal JavaScript strings.
 */
export const PAIR_SCRIPT = [
  'set -e',
  'f="${XDG_CONFIG_HOME:-$HOME/.config}/multi-agent/owner.env"',
  '[ -f "$f" ] || { echo "missing-owner-env" >&2; exit 1; }',
  'tok="$(sed -n \'s/^MULTI_AGENT_OWNER_TOKEN=//p\' "$f" | head -1)"',
  '[ -n "$tok" ] || { echo "missing-owner-token" >&2; exit 1; }',
  'base=http://127.0.0.1:7433',
  'mint="$(printf \'header = "Authorization: Bearer %s"\\n\' "$tok" | curl -sf --noproxy \'*\' -K - -X POST "$base/api/team-control/owner-session/pairing")"',
  'code="$(printf \'%s\' "$mint" | sed -n \'s/.*"code":"\\([A-Za-z0-9_-]*\\)".*/\\1/p\')"',
  '[ -n "$code" ] || { echo "mint-failed" >&2; exit 1; }',
  'hdr="$(mktemp)"',
  'trap \'rm -f "$hdr"\' EXIT',
  'body="$(printf \'{"code":"%s"}\' "$code" | curl -sf --noproxy \'*\' -D "$hdr" -X POST -H \'Origin: http://127.0.0.1:7433\' -H \'Sec-Fetch-Site: same-origin\' -H \'Content-Type: application/json\' --data-binary @- "$base/api/team-control/owner-session/exchange")"',
  'cookie="$(sed -n \'s/^[Ss]et-[Cc]ookie: *multi_agent_owner=\\([^;]*\\).*/\\1/p\' "$hdr")"',
  'csrf="$(printf \'%s\' "$body" | sed -n \'s/.*"antiForgeryToken":"\\([A-Za-z0-9_-]*\\)".*/\\1/p\')"',
  '[ -n "$cookie" ] && [ -n "$csrf" ] || { echo "exchange-failed" >&2; exit 1; }',
  'printf \'cookie=%s\\ncsrf=%s\\n\' "$cookie" "$csrf"',
].join('\n');

/**
 * Read the pair script's two output lines. Anything short of both a session cookie and an
 * anti-forgery token is a failed pairing, never a partial session.
 */
export function parsePairingResult(stdout) {
  const text = String(stdout);
  const cookie = /^cookie=([A-Za-z0-9_-]{43})$/m.exec(text)?.[1];
  const antiForgeryToken = /^csrf=([A-Za-z0-9_-]{43})$/m.exec(text)?.[1];
  return cookie && antiForgeryToken ? { cookie, antiForgeryToken } : null;
}

/**
 * Whether a `/healthz` body is this product's daemon. A bare 200 is not enough: anything can
 * answer on the port, and the window is about to load and trust whatever it finds there.
 */
export function isDaemonHealth(body) {
  if (typeof body !== "string" || body.length === 0) return false;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return !!parsed && typeof parsed === "object" && parsed.status === "ok"
    && typeof parsed.selfHostId === "string" && parsed.selfHostId.length > 0
    && Number.isInteger(parsed.pid) && parsed.pid > 0;
}

/** The health probe target. Loopback only; the daemon binds nowhere else in this product. */
export const DAEMON_ORIGIN = "http://127.0.0.1:7433";
export const HEALTH_URL = `${DAEMON_ORIGIN}/healthz`;
export const TEAM_URL = `${DAEMON_ORIGIN}/team`;

/**
 * Where a navigation is allowed to go: the daemon's own origin and nothing else. A missing or
 * unparsable URL is refused, so a broken link cannot silently become a navigation.
 */
export function isAllowedNavigation(rawUrl, allowedOrigin = DAEMON_ORIGIN) {
  try {
    return new URL(rawUrl).origin === allowedOrigin;
  } catch {
    return false;
  }
}
