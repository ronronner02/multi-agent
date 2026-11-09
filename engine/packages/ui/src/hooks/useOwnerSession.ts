import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { parseProtocolVersion } from "../../../daemon/dist/contracts/team-control.js";

export class OwnerReadError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/**
 * The anti-forgery token a desktop window paired for us before this document loaded. The
 * window performs the pairing exchange itself, so the page starts already paired and never
 * asks the owner for a code; a browser without that hand-off returns null and pairs normally.
 */
const DESKTOP_CSRF_KEY = "multi-agent.desktop.csrf";

export function desktopCredential(): string | null {
  try {
    const value = window.sessionStorage.getItem(DESKTOP_CSRF_KEY);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  } catch { return null; }
}

function usePairedBrowser() {
  const credential = useRef<string | null>(desktopCredential());
  const [paired, setPaired] = useState(credential.current !== null);
  const sockets = useRef(new Set<WebSocket>());
  const desktop = (window as Window & { multiAgentDesktop?: { reconnect?: () => Promise<string | null> } }).multiAgentDesktop;
  const nativeReconnect = desktop?.reconnect;
  const renewal = useRef<Promise<boolean> | null>(null);
  const autoPairing = useRef<Promise<boolean> | null>(null);
  const generation = useRef(0);
  const automaticReconnect = useRef(true);
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname);
  const directOpen = loopback && (window.location.pathname === "/team" || window.location.pathname.startsWith("/team/"));
  const closeTerminals = useCallback(() => {
    for (const socket of sockets.current) socket.close();
    sockets.current.clear();
  }, []);
  useEffect(() => () => { generation.current += 1; closeTerminals(); }, [closeTerminals]);
  const clearSession = useCallback(() => {
    generation.current += 1;
    credential.current = null; closeTerminals(); setPaired(false);
    try { window.sessionStorage.removeItem(DESKTOP_CSRF_KEY); } catch { /* Memory is already cleared. */ }
  }, [closeTerminals]);
  const autoPair = useCallback((): Promise<boolean> => {
    if (!directOpen || credential.current) return Promise.resolve(credential.current !== null);
    if (!autoPairing.current) {
      const pending = fetch("/api/team-control/owner-session/auto", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      }).then(async response => {
        const body = await response.json().catch(() => null) as { antiForgeryToken?: unknown } | null;
        const token = body?.antiForgeryToken;
        if (!response.ok || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
        credential.current = token;
        try { window.sessionStorage.setItem(DESKTOP_CSRF_KEY, token); } catch { /* The in-memory credential remains usable. */ }
        closeTerminals(); setPaired(true);
        return true;
      }).catch(() => false).finally(() => { if (autoPairing.current === pending) autoPairing.current = null; });
      autoPairing.current = pending;
    }
    return autoPairing.current;
  }, [closeTerminals, directOpen]);
  useEffect(() => {
    if (!credential.current && directOpen) void autoPair();
  }, [autoPair, directOpen]);
  const reconnect = useCallback((): Promise<boolean> => {
    if (!nativeReconnect) return Promise.resolve(false);
    automaticReconnect.current = true;
    if (!renewal.current) {
      const before = credential.current, version = generation.current;
      const pending = Promise.resolve().then(nativeReconnect).then(token => {
        if (generation.current !== version || credential.current !== before || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
        credential.current = token;
        try { window.sessionStorage.setItem(DESKTOP_CSRF_KEY, token); } catch { /* This document still has the credential. */ }
        closeTerminals(); setPaired(true);
        return true;
      }).catch(() => false).finally(() => { if (renewal.current === pending) renewal.current = null; });
      renewal.current = pending;
    }
    return renewal.current;
  }, [nativeReconnect, closeTerminals]);
  const openTerminal = useCallback((session: string | null, nonce: string) => {
    if (!credential.current || !loopback) throw new OwnerReadError(403, "owner_session_required");
    if (session !== null && ["", ".", "..", "owner"].includes(session)) throw new OwnerReadError(400, "invalid_terminal_target");
    const url = new URL("/api/terminal/" + (session === null ? "owner" : encodeURIComponent(session)), window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (session !== null) { url.searchParams.set("format", "framed"); url.searchParams.set("nonce", nonce); }
    const socket = new WebSocket(url.href, ["multi-agent-csrf." + credential.current]);
    sockets.current.add(socket);
    socket.addEventListener("close", () => sockets.current.delete(socket), { once: true });
    return socket;
  }, [loopback]);
  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      init.signal?.throwIfAborted();
      const token = credential.current;
      const headers = new Headers(init.headers);
      if (token) headers.set("X-Multi-Agent-CSRF", token);
      const response = await fetch(`/api/team-control${path}`, { ...init, credentials: "same-origin", headers });
      const body = await response.json();
      if (response.ok) {
        if (!path.startsWith("/owner-session") && (init.method ?? "GET").toUpperCase() === "GET") parseProtocolVersion(body.protocolVersion);
        return body as T;
      }
      const rejectedSession = ["owner_session_required", "owner_anti_forgery_required", "owner_pairing_required"].includes(body.code);
      // These failures come from authentication, before an action runs. Never retry a
      // network failure, business denial, or the owner's explicit session revocation.
      if (rejectedSession && attempt === 0 && token && automaticReconnect.current && !path.startsWith("/owner-session")) {
        if (credential.current === token) await reconnect();
        init.signal?.throwIfAborted();
        if (automaticReconnect.current && credential.current && credential.current !== token) continue;
      }
      // Other requests must not clear a credential while revocation uses it.
      if (rejectedSession && (automaticReconnect.current || path === "/owner-session") && credential.current === token) clearSession();
      throw new OwnerReadError(response.status, body.code ?? "read_failed");
    }
  }, [clearSession, reconnect]);
  const pair = useCallback(async (code: string) => {
    const result = await request<{ antiForgeryToken: string }>("/owner-session/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    closeTerminals();
    credential.current = result.antiForgeryToken;
    setPaired(true);
  }, [request, closeTerminals]);
  const revoke = useCallback(async () => {
    automaticReconnect.current = false;
    await renewal.current;
    try {
      await request("/owner-session", { method: "DELETE" });
      clearSession();
    } catch (error) {
      automaticReconnect.current = credential.current !== null;
      throw error;
    }
  }, [request, clearSession]);
  return { paired, request, pair, revoke, reconnect, canReconnect: !!nativeReconnect, openTerminal, terminalAvailable: paired && loopback };
}

const OwnerSessionContext = createContext<ReturnType<typeof usePairedBrowser> | null>(null);
export function OwnerSessionProvider({ children }: { children: ReactNode }) {
  return createElement(OwnerSessionContext.Provider, { value: usePairedBrowser() }, children);
}
export function useOwnerSession() {
  const session = useContext(OwnerSessionContext);
  if (!session) throw new Error("OwnerSessionProvider is required");
  return session;
}
