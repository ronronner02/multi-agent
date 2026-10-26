import { createContext, createElement, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { parseProtocolVersion } from "@openrig/daemon/team-control";

export class OwnerReadError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function usePairedBrowser() {
  const credential = useRef<string | null>(null);
  const [paired, setPaired] = useState(false);
  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const token = credential.current;
    const headers = new Headers(init.headers);
    if (token) headers.set("X-Multi-Agent-CSRF", token);
    const response = await fetch(`/api/team-control${path}`, { ...init, credentials: "same-origin", headers });
    const body = await response.json();
    if (!response.ok) {
      if (["owner_session_required", "owner_anti_forgery_required", "owner_pairing_required"].includes(body.code)
          && credential.current === token) {
        credential.current = null;
        setPaired(false);
      }
      throw new OwnerReadError(response.status, body.code ?? "read_failed");
    }
    if (!path.startsWith("/owner-session")) parseProtocolVersion(body.protocolVersion);
    return body as T;
  }, []);
  const pair = useCallback(async (code: string) => {
    const result = await request<{ antiForgeryToken: string }>("/owner-session/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    credential.current = result.antiForgeryToken;
    setPaired(true);
  }, [request]);
  const revoke = useCallback(async () => {
    await request("/owner-session", { method: "DELETE" });
    credential.current = null;
    setPaired(false);
  }, [request]);
  return { paired, request, pair, revoke };
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
