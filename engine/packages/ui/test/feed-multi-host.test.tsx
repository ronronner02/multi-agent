// @vitest-environment jsdom
//
// OPR.0.4.4.15 S15-5/6 — multi-host feed legs (unit tier; the DOM-level
// chips/filter/status walk is the QA browser proof per the ux-change
// standard).
//
// Load-bearing pins here: (1) NO-BEARER negative — every URL the attention
// hook touches is local-daemon-relative, no Authorization header, in BOTH
// modes; (2) zero-config wire parity — aggregation off keeps today's endpoint.

import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAttentionItems } from "../src/hooks/useAttentionItems.js";
import type { AttentionQueueItem } from "../src/hooks/useAttentionItems.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function item(qitemId: string, hostId?: string): AttentionQueueItem {
  return {
    qitemId,
    tsCreated: "2026-07-05T00:00:00.000Z",
    tsUpdated: "2026-07-05T00:00:00.000Z",
    sourceSession: "a@h",
    destinationSession: "human@host",
    state: "pending",
    priority: "urgent",
    tier: "human-gate",
    tags: null,
    blockedOn: null,
    handedOffTo: null,
    handedOffFrom: null,
    body: "b",
    ...(hostId !== undefined ? { hostId } : {}),
  };
}

describe("useAttentionItems — endpoint selection + the no-bearer negative (FR-1)", () => {
  it("zero-config (aggregated=false): today's endpoint, bare-array wire, hosts normalized empty; no bearer, local-relative URL only", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify([item("q-1")]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch);
    const { result } = renderHook(() => useAttentionItems(50, false), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({ items: [item("q-1")], hosts: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/queue/list?attention=1&limit=50"); // today's wire, byte-for-byte
    expect(calls[0]!.url.startsWith("/")).toBe(true); // local-daemon-relative — never a remote origin
    expect(calls[0]!.init?.headers).toBeUndefined(); // NO Authorization / bearer material in the browser
  });

  it("aggregated=true: polls the local aggregate endpoint (still relative, still bearer-free) and returns items + per-host statuses", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          items: [item("q-1", "local"), item("r-1", "vps-b")],
          hosts: [
            { hostId: "local", status: "ok" },
            { hostId: "vps-b", status: "ok" },
            { hostId: "vps-c", status: "unreachable", error: "ECONNREFUSED" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch);
    const { result } = renderHook(() => useAttentionItems(50, true), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(calls[0]!.url).toBe("/api/queue/attention-aggregate");
    expect(calls[0]!.init?.headers).toBeUndefined();
    expect(result.current.data!.items.map((i) => i.hostId)).toEqual(["local", "vps-b"]);
    expect(result.current.data!.hosts).toHaveLength(3);
    expect(result.current.data!.hosts[2]).toMatchObject({ hostId: "vps-c", status: "unreachable" });
  });
});
