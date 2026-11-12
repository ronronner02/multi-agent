'use strict';
/**
 * The two decisions the window makes about the daemon it is about to trust.
 *
 * Both are pure: nothing here reads Electron, the filesystem, or a process. The origin is not a
 * constant — the daemon binds loopback on an OS-assigned port, so the window learns the one
 * origin it may show from the engine bridge and everything else stays refused.
 */

/**
 * Whether a `/healthz` body comes from the engine this app forked. A bare 200 is not proof: any
 * local process can listen on a port, and the window is about to load and trust whatever answers
 * there. The engine reported its pid over the private parent channel, so the body must name it.
 */
function isDaemonHealth(body, expectedPid) {
  if (typeof body !== 'string' || body.length === 0) return false;
  if (!Number.isInteger(expectedPid) || expectedPid <= 0) return false;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return !!parsed && typeof parsed === 'object' && parsed.status === 'ok' && parsed.pid === expectedPid;
}

/**
 * Where a navigation is allowed to go: the current daemon origin and nothing else. Before the
 * engine reports an origin there is nothing to allow. A missing or unparsable URL is refused, so
 * a broken link cannot silently become a navigation.
 */
function isAllowedNavigation(rawUrl, allowedOrigin) {
  if (typeof allowedOrigin !== 'string' || allowedOrigin.length === 0) return false;
  try {
    return new URL(rawUrl).origin === allowedOrigin;
  } catch {
    return false;
  }
}

module.exports = { isAllowedNavigation, isDaemonHealth };