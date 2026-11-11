import { describe, it, expect, vi } from "vitest";
import { getEventListeners } from "node:events";
import { fetchWithTimeout, FetchTimeoutError } from "../src/fetch-with-timeout.js";

describe("fetchWithTimeout", () => {
  it.each([false, true])("removes the caller's abort listener after a settled request (fails=%s)", async fails => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      if (fails) throw new Error("request failed");
      return new Response("ok");
    });
    const result = fetchWithTimeout(fetchImpl as typeof fetch, "http://localhost:7433/read", { signal: controller.signal }, {
      timeoutMs: 1_000, timeoutMessage: "request timed out",
    });
    if (fails) await expect(result).rejects.toThrow("request failed");
    else expect((await result).status).toBe(200);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("shares one deadline across waiting for headers and reading the body", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let headersReceived = false;
      const fetchImpl: typeof fetch = async (_url, init) => {
        signal = init?.signal ?? undefined;
        await new Promise((resolve) => setTimeout(resolve, 600));
        headersReceived = true;
        return new Response("body");
      };
      const result = fetchWithTimeout(fetchImpl, "http://localhost:7433/read", {}, {
        timeoutMs: 1_000,
        timeoutMessage: "complete request timed out",
        consumeResponse: async () => {
          await new Promise<void>((resolve, reject) => {
            setTimeout(resolve, 600);
            signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
        },
      }).then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(600);
      expect(headersReceived).toBe(true);
      expect(signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(signal!.aborted).toBe(true);
      expect(await result).toBeInstanceOf(FetchTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with FetchTimeoutError when fetch blackholes", async () => {
    const fetchImpl: typeof fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;

    await expect(
      fetchWithTimeout(fetchImpl, "http://localhost:7433/healthz", {}, {
        timeoutMs: 20,
        timeoutMessage: "probe timed out",
      }),
    ).rejects.toThrow(FetchTimeoutError);
  });
});
