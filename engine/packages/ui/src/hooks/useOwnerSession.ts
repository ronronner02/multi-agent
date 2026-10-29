import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { parseProtocolVersion } from "../../../daemon/dist/contracts/team-control.js";

export class OwnerReadError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function usePairedBrowser() {
  const credential = useRef<string | null>(null);
  const [paired, setPaired] = useState(false);
  const sockets = useRef(new Set<WebSocket>());
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname);
  const closeTerminals = useCallback(() => {
    for (const socket of sockets.current) socket.close();
    sockets.current.clear();
  }, []);
  useEffect(() => closeTerminals, [closeTerminals]);
  const clearSession = useCallback(() => {
    credential.current = null; closeTerminals(); setPaired(false);
  }, [closeTerminals]);
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
    const token = credential.current;
    const headers = new Headers(init.headers);
    if (token) headers.set("X-Multi-Agent-CSRF", token);
    const response = await fetch(`/api/team-control${path}`, { ...init, credentials: "same-origin", headers });
    const body = await response.json();
    if (!response.ok) {
      if (["owner_session_required", "owner_anti_forgery_required", "owner_pairing_required"].includes(body.code)
          && credential.current === token) {
        clearSession();
      }
      throw new OwnerReadError(response.status, body.code ?? "read_failed");
    }
    if (!path.startsWith("/owner-session") && (init.method ?? "GET").toUpperCase() === "GET") parseProtocolVersion(body.protocolVersion);
    return body as T;
  }, [clearSession]);
  const pair = useCallback(async (code: string) => {
    const result = await request<{ antiForgeryToken: string }>("/owner-session/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    closeTerminals();
    credential.current = result.antiForgeryToken;
    setPaired(true);
  }, [request, closeTerminals]);
  const revoke = useCallback(async () => {
    await request("/owner-session", { method: "DELETE" });
    clearSession();
  }, [request, clearSession]);
  return { paired, request, pair, revoke, openTerminal, terminalAvailable: paired && loopback };
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
