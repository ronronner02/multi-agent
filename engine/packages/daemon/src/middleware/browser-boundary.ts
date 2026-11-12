import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { hostname as osHostname } from "node:os";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { constantTimeEqual, detectTailscaleInterface } from "./auth-bearer-token.js";

/**
 * Browser boundary for /api/* (0.6.4). Runs once per request, before the remote
 * read-through and every route, WebSocket upgrades included:
 *
 * 1. Target name (Host). Accepted: `localhost`, IP literals, this machine's own
 *    names (OS hostname, and its exact Tailscale MagicDNS name found by a reverse
 *    lookup of its own tailnet IP at Tailscale's resolver) and MULTI_AGENT_ALLOWED_HOSTS.
 *    A valid configured bearer token in Authorization waives only this check.
 * 2. Browser origin (Origin), when present. Accepted: the daemon's own UI origin
 *    while `ui.enabled` is on, or an entry in MULTI_AGENT_ALLOWED_ORIGINS. Nothing
 *    waives this check.
 *
 * Requests without Origin (CLI, TUI, MCP, daemon-to-daemon) meet only rule 1.
 * This is not complete browser isolation: a cross-site GET/HEAD that carries no
 * Origin and is addressed to an accepted name still reaches its handler.
 */

export interface BrowserBoundaryOptions {
  webUiEnabled: boolean;
  /** Managed owner sessions never accept remote names, Origin exceptions or browser bearer shortcuts. */
  pairedOwnerBoundary?: boolean;
  authenticateOwnerCookie?: (c: Context) => Response | null;
  /** Configured bearer tokens; a matching Authorization header waives only the target-name check. */
  bearerTokens: Array<string | null | undefined>;
  /** MULTI_AGENT_ALLOWED_ORIGINS: browser origins only. */
  allowedOrigins?: string;
  /** MULTI_AGENT_ALLOWED_HOSTS: target names only. */
  allowedHosts?: string;
  /** Returns this machine's own extra names (Tailscale MagicDNS). Absent: no discovery. */
  discoverSelfNames?: () => Promise<string[]>;
  discoveryTimeoutMs?: number;
  /** Minimum gap between lookups triggered by unrecognized names. */
  rediscoverAfterMs?: number;
  hostName?: () => string;
  warn?: (line: string) => void;
  now?: () => number;
  /** Test hook: one call per guarded request. */
  onDecision?: (decision: { outcome: "allow" | "refuse"; code?: BoundaryCode }) => void;
}

export type BoundaryCode = "untrusted_host" | "browser_origin_refused";

export type ParsedHost =
  | { kind: "absent" }
  | { kind: "malformed" }
  | { kind: "ok"; hostname: string; port: string };

export type ParsedOrigin =
  | { kind: "opaque" }
  | { kind: "malformed" }
  | { kind: "ok"; scheme: string; hostname: string; port: string };

const HOST_HEADER = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TAILSCALE_RESOLVER = "100.100.100.100";
const MAX_LOGGED_REFUSALS = 20;

/** Lowercase, drop IPv6 brackets and one trailing dot. */
export function normalizeName(name: string): string {
  let out = name.trim().toLowerCase();
  if (out.startsWith("[") && out.endsWith("]")) out = out.slice(1, -1);
  if (out.endsWith(".")) out = out.slice(0, -1);
  return out;
}

export function parseHostHeader(value: string | undefined): ParsedHost {
  if (value === undefined) return { kind: "absent" };
  const match = HOST_HEADER.exec(value);
  if (!match) return { kind: "malformed" };
  const rawName = match[1]!;
  if (rawName.startsWith("[") && isIP(rawName.slice(1, -1)) !== 6) return { kind: "malformed" };
  const port = match[2] ?? "80";
  if (Number(port) < 1 || Number(port) > 65535) return { kind: "malformed" };
  const hostname = normalizeName(rawName);
  if (!hostname) return { kind: "malformed" };
  return { kind: "ok", hostname, port: String(Number(port)) };
}

export function parseOrigin(value: string): ParsedOrigin {
  if (value === "null") return { kind: "opaque" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "malformed" };
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return { kind: "malformed" };
  }
  // An origin is scheme://host[:port]; anything after the authority is not one.
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/?$/i.test(value)) return { kind: "malformed" };
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const port = url.port || (scheme === "https" ? "443" : scheme === "http" ? "80" : "");
  return { kind: "ok", scheme, hostname: normalizeName(url.hostname), port };
}

function isLoopbackOrIp(hostname: string): boolean {
  return hostname === "localhost" || isIP(hostname) !== 0;
}

/** The OS hostname, its first label, and `<label>.local`. */
export function osOwnNames(hostName: () => string = osHostname): string[] {
  const full = normalizeName(hostName() || "");
  if (!full) return [];
  const label = full.split(".")[0]!;
  return [...new Set([full, label, `${label}.local`])];
}

function namesWithShortForm(names: string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const name = normalizeName(raw);
    if (!DNS_NAME.test(name)) continue;
    out.add(name);
    out.add(name.split(".")[0]!);
  }
  return [...out];
}

/**
 * This machine's exact Tailscale MagicDNS name: a reverse lookup of its own tailnet IP
 * (found from local interfaces), asked of Tailscale's resolver only. One query, bounded
 * by `timeoutMs`; no subprocess, no peer list. Returns [] when no tailnet IP is active.
 */
export async function discoverTailscaleSelfNames(opts: {
  timeoutMs: number;
  tailscaleIp?: () => string | null;
  reverse?: (ip: string, timeoutMs: number) => Promise<string[]>;
}): Promise<string[]> {
  const ip = (opts.tailscaleIp ?? detectTailscaleInterface)();
  if (!ip) return [];
  const reverse = opts.reverse ?? (async (address: string, timeoutMs: number) => {
    const resolver = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });
    resolver.setServers([TAILSCALE_RESOLVER]);
    return resolver.reverse(address);
  });
  return namesWithShortForm(await reverse(ip, opts.timeoutMs));
}

function parseAllowedHosts(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of (raw ?? "").split(",")) {
    const name = normalizeName(item);
    if (name && (DNS_NAME.test(name) || isIP(name) !== 0)) out.add(name);
  }
  return out;
}

/** MULTI_AGENT_ALLOWED_ORIGINS: a full `http(s)://…` entry matches that exact origin;
 *  any other `scheme://…` entry matches the identical string; a bare hostname matches
 *  that hostname on any scheme and port. */
function parseAllowedOrigins(raw: string | undefined): { origins: Set<string>; hostnames: Set<string>; exact: Set<string> } {
  const origins = new Set<string>();
  const hostnames = new Set<string>();
  const exact = new Set<string>();
  for (const item of (raw ?? "").split(",")) {
    const entry = item.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("http://") || entry.startsWith("https://")) {
      const parsed = parseOrigin(entry.replace(/\/$/, ""));
      if (parsed.kind === "ok") origins.add(`${parsed.scheme}://${parsed.hostname}:${parsed.port}`);
    } else if (entry.includes("://")) {
      exact.add(entry);
    } else {
      hostnames.add(normalizeName(entry));
    }
  }
  return { origins, hostnames, exact };
}

function shown(value: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

/**
 * One request header as the client sent it. Node adapters expose the original request as
 * `c.env.incoming`, whose `rawHeaders` keep duplicates and empty values; @hono/node-ws builds
 * its Request from the collapsed `incoming.headers`, which keep only the first duplicate and
 * drop empty values. Returns `undefined` when absent and `null` when duplicated (ambiguous).
 * Without a Node request (tests, other adapters) it falls back to the Request headers.
 */
export function rawHeader(c: Context, name: "host" | "origin" | "cookie" | "x-multi-agent-csrf" | "sec-websocket-protocol"): string | undefined | null {
  const raw = (c.env as { incoming?: { rawHeaders?: unknown } } | undefined)?.incoming?.rawHeaders;
  if (!Array.isArray(raw)) return c.req.header(name);
  const values: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === name) values.push(String(raw[i + 1]));
  }
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0]! : null;
}

function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

export function browserBoundary(options: BrowserBoundaryOptions): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const timeoutMs = options.discoveryTimeoutMs ?? 1500;
  const rediscoverAfterMs = options.rediscoverAfterMs ?? 10_000;
  const tokens = options.bearerTokens.filter((t): t is string => typeof t === "string" && t.length > 0);
  const allowedHosts = parseAllowedHosts(options.allowedHosts);
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins);
  const ownNames = new Set(osOwnNames(options.hostName));

  let discovered = new Set<string>();
  let lastDiscoveryAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  const discover = (): Promise<void> => {
    const source = options.discoverSelfNames;
    if (!source) return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const names = await Promise.race([
          source(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs + 250); }),
        ]);
        // A completed lookup replaces the set; a failed one keeps the previous names.
        discovered = new Set(namesWithShortForm(names));
      } catch {
        // Unavailable, malformed or slow discovery never blocks loopback/IP use.
      } finally {
        if (timer) clearTimeout(timer);
        lastDiscoveryAt = now();
        inflight = null;
      }
    })();
    return inflight;
  };
  if (options.discoverSelfNames) void discover();

  const knownTarget = (hostname: string): boolean =>
    isLoopbackOrIp(hostname) || ownNames.has(hostname) || discovered.has(hostname) || allowedHosts.has(hostname);

  const acceptedTarget = async (hostname: string): Promise<boolean> => {
    if (knownTarget(hostname)) return true;
    if (options.discoverSelfNames && (inflight || now() - lastDiscoveryAt >= rediscoverAfterMs)) {
      await discover();
      return knownTarget(hostname);
    }
    return false;
  };

  const explicitlyAllowedOrigin = (raw: string, origin: ParsedOrigin): boolean => {
    if (allowedOrigins.exact.has(raw.trim().toLowerCase())) return true;
    if (origin.kind !== "ok") return false;
    if (allowedOrigins.hostnames.has(origin.hostname)) return true;
    return allowedOrigins.origins.has(`${origin.scheme}://${origin.hostname}:${origin.port}`);
  };

  const logged = new Set<string>();
  let suppressionLogged = false;
  const logRefusal = (c: Context, code: BoundaryCode, value: string): void => {
    const key = `${code}|${value}`;
    if (logged.has(key)) return;
    if (logged.size >= MAX_LOGGED_REFUSALS) {
      if (!suppressionLogged) {
        suppressionLogged = true;
        warn("[multi-agent] browser boundary: further distinct refusals are not logged");
      }
      return;
    }
    logged.add(key);
    warn(`[multi-agent] browser boundary refused ${code}: ${value} (${c.req.method} ${shown(c.req.path)})`);
  };

  const refuse = (c: Context, code: BoundaryCode, value: string, error: string) => {
    logRefusal(c, code, value);
    options.onDecision?.({ outcome: "refuse", code });
    return c.json({ error, code }, 403);
  };

  return async (c, next) => {
    const rawOrigin = rawHeader(c, "origin");
    const cookie = rawHeader(c, "cookie");
    const browser = rawOrigin !== undefined || cookie !== undefined || c.req.header("Sec-Fetch-Site") !== undefined
      || (c.req.header("Upgrade")?.toLowerCase() === "websocket" && c.req.header("Authorization") === undefined);
    // Native bearer clients retain the existing Host boundary and all downstream token/peer checks.
    if (options.pairedOwnerBoundary && browser) {
      const deny = (code: string, status: 401 | 403 = 403) => {
        options.onDecision?.({ outcome: "refuse", code: "browser_origin_refused" });
        return c.json({ code }, status);
      };
      const rawHost = rawHeader(c, "host");
      const host = typeof rawHost === "string" ? parseHostHeader(rawHost) : { kind: "malformed" as const };
      if (host.kind !== "ok" || !(host.hostname === "localhost" || host.hostname === "::1"
        || (isIP(host.hostname) === 4 && host.hostname.startsWith("127.")))) return deny("untrusted_host");
      if ([...new URL(c.req.url).searchParams.keys()].some(k => /^(token|code|access_token|session_token|csrf)$/i.test(k))) {
        return deny("owner_query_credentials_refused", c.req.path.startsWith("/api/team-control/") ? 401 : 403);
      }
      if (browser) {
        let peer: string | undefined;
        try { peer = getConnInfo(c).remote.address?.replace(/^::ffff:/i, ""); } catch { /* Missing peer identity fails closed. */ }
        if (!peer || !(peer === "::1" || (isIP(peer) === 4 && peer.startsWith("127.")))) return deny("local_control_required");
        const requestOrigin = new URL(c.req.url).origin;
        // Browsers omit Origin on same-origin GET/HEAD. Fetch Metadata is browser-controlled;
        // mutation and upgrade admission still require an explicit matching Origin.
        const metadataRead = rawOrigin === undefined && ["GET", "HEAD"].includes(c.req.method)
          && c.req.header("Upgrade")?.toLowerCase() !== "websocket"
          && c.req.header("Sec-Fetch-Site") === "same-origin";
        const presentedOrigin = metadataRead ? requestOrigin : rawOrigin;
        const origin = typeof presentedOrigin === "string" ? parseOrigin(presentedOrigin) : { kind: "malformed" as const };
        if (origin.kind !== "ok" || origin.scheme + ":" !== new URL(c.req.url).protocol
          || origin.hostname !== host.hostname || origin.port !== host.port
          || ![undefined, "same-origin", "none"].includes(c.req.header("Sec-Fetch-Site"))) return deny("browser_origin_refused");
        c.set("ownerBrowserOrigin" as never, new URL(presentedOrigin!).origin);
        c.set("ownerCookieHeader" as never, cookie);
        const header = rawHeader(c, "x-multi-agent-csrf");
        const protocols = rawHeader(c, "sec-websocket-protocol");
        const offered = typeof protocols === "string" ? protocols.split(",").map(p => p.trim())
          .filter(p => p.startsWith("multi-agent-csrf.")).map(p => p.slice("multi-agent-csrf.".length)) : [];
        if (header === null || protocols === null || offered.length > 1
          || (header !== undefined && offered.length === 1 && header !== offered[0])) return deny("owner_anti_forgery_required");
        c.set("ownerAntiForgery" as never, header ?? offered[0]);
        if (c.req.path !== "/api/team-control/owner-session/exchange") {
          if (c.req.header("Authorization") !== undefined) return deny("owner_browser_bearer_refused");
          const refusal = options.authenticateOwnerCookie?.(c);
          if (!options.authenticateOwnerCookie) return deny("owner_session_required");
          if (refusal) return refusal;
        }
      }
      options.onDecision?.({ outcome: "allow" });
      c.header("Cache-Control", "no-store");
      await next();
      return;
    }
    // Paired browser sessions are a separate boundary; this bearer control surface is not a pairing shortcut.
    if ((c.req.path === "/api/team-control" || c.req.path.startsWith("/api/team-control/"))
      && (rawHeader(c, "origin") !== undefined || c.req.header("Cookie") !== undefined
        || c.req.header("Sec-Fetch-Site") !== undefined)) {
      return refuse(c, "browser_origin_refused", "(unpaired control client)", "Browser control requires a paired owner session.");
    }
    const hostHeader = rawHeader(c, "host");
    // A duplicated (ambiguous) Host is malformed; an explicitly empty one fails parsing.
    const host = hostHeader === null ? { kind: "malformed" as const } : parseHostHeader(hostHeader);
    let hostAccepted = false;
    if (host.kind === "malformed") {
      const value = shown(hostHeader === null ? "(duplicate Host)" : hostHeader ?? "");
      return refuse(c, "untrusted_host", value,
        `This Multi-Agent daemon refused a request with an unusable Host header ("${value}"). Address the daemon by localhost, an IP address or this machine's own name.`);
    }
    if (host.kind === "ok") {
      hostAccepted = await acceptedTarget(host.hostname);
      if (!hostAccepted) {
        const presented = bearerFrom(c.req.header("Authorization"));
        const tokenValid = presented !== null && tokens.some((token) => constantTimeEqual(presented, token));
        if (!tokenValid) {
          const value = shown(host.hostname);
          return refuse(c, "untrusted_host", value,
            `This Multi-Agent daemon does not accept requests addressed to "${value}". Use localhost, an IP address or this machine's own name, or add this name to MULTI_AGENT_ALLOWED_HOSTS in the daemon's environment and restart the daemon.`);
        }
      }
    }

    // A duplicated Origin is malformed; an explicitly empty one is present and fails parsing.
    const originHeader = rawOrigin === null ? "(duplicate Origin)" : rawOrigin;
    if (originHeader !== undefined) {
      const origin = rawOrigin === null ? { kind: "malformed" as const } : parseOrigin(originHeader);
      const ownUi = options.webUiEnabled && origin.kind === "ok" && origin.scheme === "http"
        && host.kind === "ok" && hostAccepted
        && origin.hostname === host.hostname && origin.port === host.port;
      if (!ownUi && !explicitlyAllowedOrigin(originHeader, origin)) {
        const value = shown(originHeader);
        return refuse(c, "browser_origin_refused", value,
          `This Multi-Agent daemon refuses browser requests from origin "${value}". Open the Multi-Agent UI from the daemon's own address with the web UI enabled (multi-agent config set ui.enabled true, then restart the daemon), or add this exact origin to MULTI_AGENT_ALLOWED_ORIGINS in the daemon's environment and restart. Web pages on other origins cannot read this response.`);
      }
    }

    options.onDecision?.({ outcome: "allow" });
    await next();
  };
}
