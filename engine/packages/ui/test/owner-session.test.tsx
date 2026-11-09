import React, { type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerSessionProvider, useOwnerSession } from "../src/hooks/useOwnerSession.js";

const oldToken = "a".repeat(43), newToken = "b".repeat(43);
const storageKey = "multi-agent.desktop.csrf";
const response = (status: number, body: object) => new Response(JSON.stringify(body), { status });
const denied = () => response(401, { code: "owner_session_required" });
const ok = () => response(200, { protocolVersion: "1.0", value: "fixture" });
const wrapper = ({ children }: { children: ReactNode }) => <OwnerSessionProvider>{children}</OwnerSessionProvider>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
let request: ReturnType<typeof vi.fn>, reconnect: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sessionStorage.clear(); sessionStorage.setItem(storageKey, oldToken);
  request = vi.fn(); reconnect = vi.fn().mockResolvedValue(newToken);
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("multiAgentDesktop", { reconnect });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState({}, "", "/"); });

describe("desktop owner-session reconnect", () => {
  it("auto-pairs a loopback browser without displaying a pairing-code prompt", async () => {
    sessionStorage.clear();
    vi.stubGlobal("multiAgentDesktop", undefined);
    window.history.replaceState({}, "", "/team");
    const directToken = "c".repeat(43);
    request.mockResolvedValueOnce(response(200, { antiForgeryToken: directToken, session: { id: "local" } }));
    const { result } = renderHook(useOwnerSession, { wrapper });
    await vi.waitFor(() => expect(result.current.paired).toBe(true));
    expect(request).toHaveBeenCalledWith("/api/team-control/owner-session/auto", expect.objectContaining({ method: "POST" }));
    expect(sessionStorage.getItem(storageKey)).toBe(directToken);
    expect(result.current.canReconnect).toBe(false);
  });

  it("renews an expired desktop session without unmounting the paired view or asking for a code", async () => {
    request.mockResolvedValueOnce(denied()).mockResolvedValueOnce(ok());
    const states: boolean[] = [];
    const { result } = renderHook(() => { const session = useOwnerSession(); states.push(session.paired); return session; }, { wrapper });
    await act(async () => { expect(await result.current.request("/health")).toHaveProperty("value", "fixture"); });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(new Headers(request.mock.calls[1][1].headers).get("X-Multi-Agent-CSRF")).toBe(newToken);
    expect(sessionStorage.getItem(storageKey)).toBe(newToken);
    expect(states.every(Boolean)).toBe(true);
  });

  it("shares one reconnect between concurrent authentication failures", async () => {
    const connection = deferred<string>(); reconnect.mockReturnValue(connection.promise);
    request.mockImplementation(async (_path, init) => new Headers(init.headers).get("X-Multi-Agent-CSRF") === oldToken ? denied() : ok());
    const { result } = renderHook(useOwnerSession, { wrapper });
    let reads!: Promise<PromiseSettledResult<unknown>[]>;
    await act(async () => {
      reads = Promise.allSettled([result.current.request("/health"), result.current.request("/runs")]);
      await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
      connection.resolve(newToken); expect((await reads).every(read => read.status === "fulfilled")).toBe(true);
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(4);
    expect(result.current.paired).toBe(true);
  });

  it("retries a late old-session rejection with the renewed credential rather than clearing it", async () => {
    const late = deferred<Response>();
    request.mockReturnValueOnce(late.promise).mockResolvedValueOnce(denied()).mockImplementation(async () => ok());
    const { result } = renderHook(useOwnerSession, { wrapper });
    await act(async () => {
      const first = result.current.request("/runs");
      await result.current.request("/health");
      late.resolve(denied()); await first;
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(result.current.paired).toBe(true);
    expect(sessionStorage.getItem(storageKey)).toBe(newToken);
  });

  it("replays a rejected write only once and preserves its exact body", async () => {
    request.mockResolvedValueOnce(denied()).mockResolvedValueOnce(ok());
    const { result } = renderHook(useOwnerSession, { wrapper });
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest: "fixture-digest" }) };
    await act(async () => { await result.current.request("/runs/fixture/approve", init); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]).toMatchObject({ method: init.method, body: init.body });
    expect(new Headers(request.mock.calls[1][1].headers).get("Content-Type")).toBe("application/json");
  });

  it("stops after one unsuccessful renewal and removes the stale reload credential", async () => {
    request.mockImplementation(async () => denied());
    const { result } = renderHook(useOwnerSession, { wrapper });
    await act(async () => { await expect(result.current.request("/health")).rejects.toMatchObject({ code: "owner_session_required" }); });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.paired).toBe(false);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("clears a failed renewal and lets the owner reconnect locally without a code", async () => {
    reconnect.mockResolvedValueOnce(null).mockResolvedValueOnce(newToken);
    request.mockResolvedValueOnce(denied());
    const { result } = renderHook(useOwnerSession, { wrapper });
    await act(async () => { await expect(result.current.request("/health")).rejects.toMatchObject({ status: 401 }); });
    expect(result.current.canReconnect).toBe(true);
    expect(result.current.paired).toBe(false);
    await act(async () => { expect(await result.current.reconnect()).toBe(true); });
    expect(result.current.paired).toBe(true);
    expect(sessionStorage.getItem(storageKey)).toBe(newToken);
  });

  it("keeps explicit browser pairing when the native bridge is absent", async () => {
    vi.stubGlobal("multiAgentDesktop", undefined);
    request.mockResolvedValueOnce(denied());
    const { result } = renderHook(useOwnerSession, { wrapper });
    await act(async () => { await expect(result.current.request("/health")).rejects.toMatchObject({ status: 401 }); });
    expect(reconnect).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.paired).toBe(false);
  });

  it("does not renew or replay an application denial or a network failure", async () => {
    request.mockResolvedValueOnce(response(403, { code: "plan_approval_required" })).mockRejectedValueOnce(new TypeError("offline"));
    const { result } = renderHook(useOwnerSession, { wrapper });
    await act(async () => {
      await expect(result.current.request("/runs/fixture/approve", { method: "POST" })).rejects.toMatchObject({ code: "plan_approval_required" });
      await expect(result.current.request("/health")).rejects.toThrow("offline");
    });
    expect(reconnect).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.paired).toBe(true);
  });

  it("never replays a request that was cancelled while reconnecting", async () => {
    const connection = deferred<string>(); reconnect.mockReturnValue(connection.promise);
    request.mockResolvedValueOnce(denied());
    const abort = new AbortController();
    const { result } = renderHook(useOwnerSession, { wrapper });
    await act(async () => {
      const read = result.current.request("/health", { signal: abort.signal });
      const settled = read.then(() => null, error => error);
      await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
      abort.abort(); connection.resolve(newToken); expect(await settled).toMatchObject({ name: "AbortError" });
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.paired).toBe(true);
  });

  it("honors explicit revocation and stays unpaired after a reload", async () => {
    request.mockResolvedValueOnce(response(200, { revoked: true }));
    const view = renderHook(useOwnerSession, { wrapper });
    await act(async () => { await view.result.current.revoke(); });
    expect(reconnect).not.toHaveBeenCalled();
    expect(view.result.current.paired).toBe(false);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    view.unmount();
    const reopened = renderHook(useOwnerSession, { wrapper });
    expect(reopened.result.current.paired).toBe(false);
  });

  it.each([[401, "owner_session_required"], [403, "owner_anti_forgery_required"]] as const)(
    "stays disconnected after DELETE rejects the stored credential with %s", async (status, code) => {
      request.mockResolvedValueOnce(response(status, { code })).mockResolvedValueOnce(denied());
      const { result } = renderHook(useOwnerSession, { wrapper });
      await act(async () => { await expect(result.current.revoke()).rejects.toMatchObject({ code }); });
      expect(result.current.paired).toBe(false);
      expect(sessionStorage.getItem(storageKey)).toBeNull();
      await act(async () => { await expect(result.current.request("/health")).rejects.toMatchObject({ status: 401 }); });
      expect(reconnect).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(2);
    });

  it("retains the session after a revocation transport failure so the owner can retry", async () => {
    request.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(response(200, { revoked: true }));
    const { result } = renderHook(useOwnerSession, { wrapper });
    await act(async () => { await expect(result.current.revoke()).rejects.toThrow("offline"); });
    expect(result.current.paired).toBe(true);
    expect(sessionStorage.getItem(storageKey)).toBe(oldToken);
    await act(async () => { await result.current.revoke(); });
    expect(result.current.paired).toBe(false);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("retains a renewing credential for revocation when another old-session rejection arrives", async () => {
    const connection = deferred<string>(), late = deferred<Response>();
    reconnect.mockReturnValue(connection.promise);
    request.mockImplementation(async (path, init) => {
      if (init.method === "DELETE") return new Headers(init.headers).get("X-Multi-Agent-CSRF") === newToken
        ? response(200, { revoked: true }) : denied();
      if (path.endsWith("/runs")) return late.promise;
      return denied();
    });
    const { result } = renderHook(useOwnerSession, { wrapper });
    await act(async () => {
      const first = result.current.request("/runs").catch(error => error);
      const renewalRead = result.current.request("/health").catch(error => error);
      await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
      const revoked = result.current.revoke().then(() => "revoked", error => error);
      late.resolve(denied()); await first;
      connection.resolve(newToken);
      expect(await revoked).toBe("revoked");
      await renewalRead;
    });
    const removal = request.mock.calls.find(([, init]) => init.method === "DELETE")!;
    expect(new Headers(removal[1].headers).get("X-Multi-Agent-CSRF")).toBe(newToken);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(result.current.paired).toBe(false);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("finishes an in-flight renewal before revoking and never reopens the session afterward", async () => {
    const connection = deferred<string>(); reconnect.mockReturnValue(connection.promise);
    request.mockImplementation(async (_path, init) => init.method === "DELETE"
      ? response(200, { revoked: true }) : new Headers(init.headers).get("X-Multi-Agent-CSRF") === oldToken ? denied() : ok());
    const { result } = renderHook(useOwnerSession, { wrapper });
    await act(async () => {
      const read = result.current.request("/health").catch(error => error);
      await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
      const revoked = result.current.revoke();
      connection.resolve(newToken); await Promise.allSettled([read, revoked]);
    });
    const removal = request.mock.calls.find(([, init]) => init.method === "DELETE")!;
    expect(new Headers(removal[1].headers).get("X-Multi-Agent-CSRF")).toBe(newToken);
    expect(result.current.paired).toBe(false);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
});
