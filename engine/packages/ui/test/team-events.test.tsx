import React, { type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerSessionProvider, useOwnerSession } from "../src/hooks/useOwnerSession.js";
import { teamEventsKey, useTeamEvents } from "../src/hooks/useTeamEvents.js";
import { attemptStatus, useAttemptStatus } from "../src/hooks/useAttemptStatus.js";
import { usePendingAction } from "../src/hooks/usePendingAction.js";
import { useAttemptActivity } from "../src/hooks/useAttemptActivity.js";
import { useTeamChat } from "../src/team/hooks.js";
import { mergeTeamEvents, parseTeamEvent, readSSE, streamTeamEvents, type TeamEvent, type TeamEventState } from "../src/hooks/team-event-stream.js";
import { attempt, read, RUN_ID } from "../src/team/__tests__/fixtures.js";

const at = "2026-11-12T00:00:00.000Z";
function event(seq: number, action = "attempt.started"): TeamEvent {
  return { seq, action, createdAt: at, type: "team.control", runId: RUN_ID, taskId: "task", attemptId: "attempt", body: "{}", truncated: false };
}
function state(cursor = 1): TeamEventState {
  return { events: [], cursor, window: { retainedFrom: 1, latestSeq: cursor }, gap: false, connection: "connecting",
    initialized: true, trimmedThrough: 0, attempts: {} };
}
function wire(record: TeamEvent) { return `id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`; }
function channel() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  return { body, cancel, send: (text: string) => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close(),
    response: () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }) };
}
async function messages(text: string, width = 1) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += width) controller.enqueue(bytes.slice(offset, offset + width));
    controller.close();
  } });
  const output = [];
  for await (const message of readSSE(body, new AbortController().signal)) output.push(message);
  return output;
}

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  sessionStorage.clear(); sessionStorage.setItem("multi-agent.desktop.csrf", "a".repeat(43));
});
afterEach(() => { cleanup(); client.clear(); sessionStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><OwnerSessionProvider>{children}</OwnerSessionProvider></QueryClientProvider>;
async function flush(ms = 1) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

describe("SSE text parser and sequence reducer", () => {
  it("decodes chunked UTF-8, BOM, comments, CRLF, multiline data and custom events", async () => {
    expect(await messages('\ufeff: heartbeat\r\nevent: gap\r\nid: 7\r\ndata: {\r\ndata: "text": "你好"}\r\n\r\n'))
      .toEqual([{ event: "gap", id: "7", data: '{\n"text": "你好"}' }]);
  });
  it("supports CR and LF delimiters and discards incomplete EOF frames", async () => {
    expect(await messages("data: one\r\rdata: two\n\ndata: unfinished", 4)).toEqual([
      { event: "message", id: "", data: "one" }, { event: "message", id: "", data: "two" },
    ]);
  });
  it("aborts a pending read and releases the body", async () => {
    const stream = channel(), abort = new AbortController();
    const reading = readSSE(stream.body, abort.signal).next();
    abort.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });
  it("merges replay/live records in sequence order, deduplicating out-of-order arrivals", () => {
    const previous = mergeTeamEvents(state(), [event(4), event(2)]);
    const merged = mergeTeamEvents(previous, [event(3), event(4, "attempt.acknowledged")]);
    expect(merged.events.map(event => event.seq)).toEqual([2, 3, 4]);
    expect(merged.events.at(-1)?.action).toBe("attempt.started");
    expect(merged.cursor).toBe(4);
  });
  it("bounds records and keeps lifecycle facts after the acknowledgment leaves the window", () => {
    const first = mergeTeamEvents(state(), [event(2), event(3, "attempt.acknowledged")]);
    const merged = mergeTeamEvents(first, Array.from({ length: 220 }, (_, index) => event(index + 4, "worker.tool.updated")));
    expect(merged.events).toHaveLength(200);
    expect(merged.attempts.attempt?.acknowledged).toBe(true);
    expect(mergeTeamEvents(merged, [event(2)]).events).toEqual(merged.events);
  });
  it("interprets SQLite event timestamps as UTC when deriving the response deadline", () => {
    const merged = mergeTeamEvents(state(), [{ ...event(2), createdAt: "2026-11-12 00:00:00" }]);
    expect(merged.attempts.attempt?.startedAt).toBe(Date.parse(at));
  });
  it("rejects foreign or malformed records before advancing the cursor", () => {
    expect(() => parseTeamEvent({ ...event(2), runId: "other" }, RUN_ID)).toThrow();
    expect(() => parseTeamEvent({ ...event(2), seq: -1 }, RUN_ID)).toThrow();
  });
});

describe("shared owner event stream", () => {
  function fixture(streams: ReturnType<typeof channel>[], replay = vi.fn(async () => ({ events: [], window: { retainedFrom: 1, latestSeq: 1 }, gap: false }))) {
    let index = 0;
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.includes("/replay?")) return new Response(JSON.stringify({ protocolVersion: "1.0", runId: RUN_ID, ...await replay(path, init) }));
      return streams[index++]!.response();
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  it("opens once per run with cookie credentials, CSRF, snapshot cursor, and cache invalidation", async () => {
    vi.useFakeTimers();
    const stream = channel(), fetcher = fixture([stream]);
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const snapshot = read();
    const first = renderHook(() => useTeamEvents(RUN_ID, snapshot), { wrapper });
    const second = renderHook(() => useTeamEvents(RUN_ID, snapshot), { wrapper });
    await flush();
    const calls = fetcher.mock.calls.filter(([path]) => path.endsWith("/events/stream"));
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]?.credentials).toBe("include");
    expect(new Headers(calls[0]![1]?.headers).get("X-Multi-Agent-CSRF")).toBe("a".repeat(43));
    expect(new Headers(calls[0]![1]?.headers).get("Last-Event-ID")).toBe("1");
    invalidated.mockClear();
    stream.send(wire(event(2)) + wire(event(2)) + wire(event(4, "attempt.acknowledged")) + wire(event(3, "worker.turn.started")));
    await flush();
    expect(first.result.current.data?.events.map(event => event.seq)).toEqual([2, 3, 4]);
    expect(second.result.current.data?.cursor).toBe(4);
    expect(invalidated).toHaveBeenCalledTimes(3);
    first.unmount(); expect(stream.cancel).not.toHaveBeenCalled();
    second.unmount(); await flush(); expect(stream.cancel).toHaveBeenCalledTimes(1);
  });
  it("refreshes public chat and tool projections from content-free notifications", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
      disconnect() {}
    });
    const stream = channel(), current = attempt({ attemptId: "attempt", state: "running", createdAt: at });
    let text = "Before the update", summary = "Initial activity";
    const fetcher = vi.fn(async (path: string) => {
      const envelope = { protocolVersion: "1.0", runId: RUN_ID };
      if (path.includes("/replay?")) return new Response(JSON.stringify({ ...envelope, events: [], window: { retainedFrom: 1, latestSeq: 1 }, gap: false }));
      if (path.endsWith("/chat")) return new Response(JSON.stringify({ ...envelope, messages: [], liveTurn: {
        attemptId: current.attemptId, state: "running", progress: { sequence: 1, blocks: [{ id: "text-1", text, complete: false }] },
      } }));
      if (path.includes("/activity?")) return new Response(JSON.stringify({ ...envelope, activity: {
        attemptId: current.attemptId, state: "running", nextSeq: text === "Before the update" ? 0 : 1,
        records: text === "Before the update" ? [] : [{ id: "call-1", seq: 1, at, tool: "Read", summary, status: "completed" }],
      } }));
      return stream.response();
    });
    vi.stubGlobal("fetch", fetcher);
    const view = renderHook(() => ({ events: useTeamEvents(RUN_ID, read()), chat: useTeamChat(RUN_ID, true),
      activity: useAttemptActivity(RUN_ID, current) }), { wrapper });
    act(() => view.result.current.activity.ref(document.createElement("section")));
    await flush(5);
    expect(view.result.current.chat.data?.liveTurn?.progress?.blocks[0]?.text).toBe(text);
    expect(view.result.current.activity.data?.records).toEqual([]);
    const before = fetcher.mock.calls.length;
    text = "Public output from the chat projection"; summary = "Public activity from the telemetry projection";
    stream.send(wire({ ...event(2, "worker.message.agent"), body: JSON.stringify({ type: "message.agent", provider: "codex", timestamp: at }) })
      + wire({ ...event(3, "worker.tool.completed"), body: JSON.stringify({ type: "tool.completed", provider: "codex", timestamp: at,
        toolCallId: "call-1", tool: "Read", status: "completed" }) }));
    await flush(5);
    expect(fetcher.mock.calls.length).toBeGreaterThan(before);
    expect(view.result.current.chat.data?.liveTurn?.progress?.blocks[0]?.text).toBe(text);
    expect(view.result.current.activity.data?.records[0]).toMatchObject({ summary, status: "completed" });
    expect(JSON.stringify(view.result.current.events.data)).not.toContain(text);
    expect(JSON.stringify(view.result.current.events.data)).not.toContain(summary);
  });
  it("replays a gap from the last good sequence and deduplicates the stream's retained tail", async () => {
    vi.useFakeTimers();
    const stream = channel();
    const replay = vi.fn(async () => ({ events: [event(3), event(4)], window: { retainedFrom: 3, latestSeq: 4 }, gap: true }));
    fixture([stream], replay);
    client.setQueryData(teamEventsKey(RUN_ID), state(2));
    const view = renderHook(() => useTeamEvents(RUN_ID, read()), { wrapper }); await flush();
    stream.send(`event: gap\ndata: ${JSON.stringify({ protocolVersion: "1.0", runId: RUN_ID, afterSeq: 2, retainedFrom: 3 })}\n\n` + wire(event(3)) + wire(event(4)));
    await flush();
    expect(replay.mock.calls[0]?.[0]).toContain("afterSeq=2");
    expect(view.result.current.data?.events.map(event => event.seq)).toEqual([3, 4]);
    expect(view.result.current.data?.gap).toBe(true);
  });
  it("hydrates every retained replay page before opening the live tail, once per cached run", async () => {
    vi.useFakeTimers();
    const records = Array.from({ length: 505 }, (_, index) => event(index + 1, index === 0 ? "attempt.acknowledged" : "worker.tool.updated"));
    const replay = vi.fn(async (path: string) => {
      const after = Number(new URL(path, "http://localhost").searchParams.get("afterSeq"));
      return { events: records.filter(record => record.seq > after).slice(0, 500), window: { retainedFrom: 1, latestSeq: 505 }, gap: false };
    });
    const fetcher = fixture([channel(), channel()], replay);
    const view = renderHook(() => useTeamEvents(RUN_ID, read()), { wrapper }); await flush();
    expect(replay).toHaveBeenCalledTimes(2);
    expect(view.result.current.data?.events).toHaveLength(200);
    expect(view.result.current.data?.attempts.attempt?.acknowledged).toBe(true);
    const live = fetcher.mock.calls.find(([path]) => path.endsWith("/events/stream"))!;
    expect(new Headers(live[1]?.headers).get("Last-Event-ID")).toBe("505");
    view.unmount(); await flush();
    renderHook(() => useTeamEvents(RUN_ID, read()), { wrapper }); await flush();
    expect(replay).toHaveBeenCalledTimes(2);
  });
  it("reconnects with Last-Event-ID after a close and resumes from cached data on remount", async () => {
    vi.useFakeTimers();
    const first = channel(), second = channel(), third = channel();
    const fetcher = fixture([first, second, third]);
    const view = renderHook(() => useTeamEvents(RUN_ID, read()), { wrapper }); await flush();
    first.send(wire(event(2))); await flush(); first.close(); await flush();
    expect(view.result.current.data?.connection).toBe("reconnecting");
    await flush(500);
    let calls = fetcher.mock.calls.filter(([path]) => path.endsWith("/events/stream"));
    expect(new Headers(calls[1]![1]?.headers).get("Last-Event-ID")).toBe("2");
    second.send(wire(event(3))); await flush(); view.unmount(); await flush();
    renderHook(() => useTeamEvents(RUN_ID, read()), { wrapper }); await flush();
    calls = fetcher.mock.calls.filter(([path]) => path.endsWith("/events/stream"));
    expect(new Headers(calls[2]![1]?.headers).get("Last-Event-ID")).toBe("3");
    expect(second.cancel).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403])("stops and returns to pairing on permission failure (%s)", async status => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: "owner_session_required" }), { status }));
    vi.stubGlobal("fetch", fetcher);
    const view = renderHook(() => ({ events: useTeamEvents(RUN_ID, read()), session: useOwnerSession() }), { wrapper });
    await flush(); await flush(30_000);
    expect(view.result.current.session.paired).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("multi-agent.desktop.csrf")).toBeNull();
  });
  it.each([401, 403])("stops when the stream handshake is denied after successful replay (%s)", async status => {
    vi.useFakeTimers();
    const reconnect = vi.fn(); vi.stubGlobal("multiAgentDesktop", { reconnect });
    const fetcher = vi.fn(async (path: string) => path.includes("/replay?")
      ? new Response(JSON.stringify({ protocolVersion: "1.0", runId: RUN_ID, events: [], window: { retainedFrom: 1, latestSeq: 1 }, gap: false }))
      : new Response(JSON.stringify({ code: "owner_anti_forgery_required" }), { status }));
    vi.stubGlobal("fetch", fetcher);
    const view = renderHook(() => ({ events: useTeamEvents(RUN_ID, read()), session: useOwnerSession() }), { wrapper });
    await flush(); await flush(30_000);
    expect(view.result.current.session.paired).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(reconnect).not.toHaveBeenCalled();
  });
  it("stops on a non-JSON permission response as well", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response("Forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const view = renderHook(() => ({ events: useTeamEvents(RUN_ID, read()), session: useOwnerSession() }), { wrapper });
    await flush(); await flush(30_000);
    expect(view.result.current.session.paired).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not open an unpaired run", async () => {
    vi.useFakeTimers(); sessionStorage.clear();
    const fetcher = fixture([channel()]);
    renderHook(() => useTeamEvents(RUN_ID, read()), { wrapper }); await flush();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("waits for the snapshot and aborts the stream on unmount", async () => {
    vi.useFakeTimers();
    const stream = channel(), fetcher = fixture([stream]);
    const view = renderHook(({ snapshot }) => useTeamEvents(RUN_ID, snapshot), { initialProps: { snapshot: undefined as ReturnType<typeof read> | undefined }, wrapper });
    await flush(); expect(fetcher).not.toHaveBeenCalled();
    view.rerender({ snapshot: read() }); await flush();
    const signal = fetcher.mock.calls.at(-1)![1]!.signal!;
    view.unmount(); await flush();
    expect(signal.aborted).toBe(true); expect(stream.cancel).toHaveBeenCalledTimes(1);
    const count = fetcher.mock.calls.length; await flush(60_000); expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it("rejects a malformed frame without advancing the reconnect cursor", async () => {
    vi.useFakeTimers(); const first = channel(), second = channel();
    const fetcher = fixture([first, second]);
    const view = renderHook(() => useTeamEvents(RUN_ID, read()), { wrapper }); await flush();
    first.send(`id: 99\ndata: ${JSON.stringify(event(2))}\n\n`); await flush();
    expect(view.result.current.data?.cursor).toBe(1); expect(first.cancel).toHaveBeenCalledTimes(1);
    await flush(500);
    const calls = fetcher.mock.calls.filter(([path]) => path.endsWith("/events/stream"));
    expect(new Headers(calls[1]![1]?.headers).get("Last-Event-ID")).toBe("1");
  });
  it("caps reconnect delay and cancels the pending retry on abort", async () => {
    vi.useFakeTimers();
    let current = state();
    const abort = new AbortController(), open = vi.fn(async () => { throw new TypeError("offline"); });
    const running = streamTeamEvents({ runId: RUN_ID, signal: abort.signal, open, replay: vi.fn(), read: () => current,
      update: value => { current = value; }, invalidate: vi.fn(), permissionFailure: () => false });
    await flush(500 + 1000 + 2000 + 4000 + 8000 + 8000);
    expect(open).toHaveBeenCalledTimes(7);
    abort.abort(); await running; const count = open.mock.calls.length;
    await flush(60_000); expect(open).toHaveBeenCalledTimes(count);
  });
  it("keeps the cursor when an owner action invalidates all run queries", async () => {
    vi.useFakeTimers(); const stream = channel(); fixture([stream]);
    const view = renderHook(() => useTeamEvents(RUN_ID, read()), { wrapper }); await flush();
    stream.send(wire(event(9))); await flush();
    await act(async () => { await client.invalidateQueries({ queryKey: ["team", RUN_ID] }); }); await flush();
    expect(view.result.current.data?.cursor).toBe(9);
  });
});

describe("attempt display facts", () => {
  const attempt = { attemptId: "attempt", state: "running" as const, createdAt: at };
  const started = mergeTeamEvents(state(), [event(2)]).attempts.attempt!;
  it("renders started before the deadline and no-response at the existing 30-second deadline", () => {
    expect(attemptStatus(attempt, started, Date.parse(at) + 29_999)).toBe("started");
    expect(attemptStatus(attempt, started, Date.parse(at) + 30_000)).toBe("no-response");
  });
  it("only the acknowledgment fact means acknowledged; delivery and provider activity do not", () => {
    const delivered = mergeTeamEvents(state(), [event(2), event(3, "task.outcome")]);
    expect(attemptStatus(attempt, delivered.attempts.attempt, Date.parse(at))).toBe("started");
    const provider = mergeTeamEvents(delivered, [event(4, "worker.tool.started")]);
    expect(attemptStatus(attempt, provider.attempts.attempt, Date.parse(at) + 60_000)).toBe("working");
    const acknowledged = mergeTeamEvents(provider, [event(5, "attempt.acknowledged")]);
    expect(attemptStatus(attempt, acknowledged.attempts.attempt, Date.parse(at) + 60_000)).toBe("acknowledged");
  });
  it("updates at the deadline without polling and reconciles a later acknowledgment", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(at));
    client.setQueryData(teamEventsKey(RUN_ID), mergeTeamEvents(state(), [event(2)]));
    const view = renderHook(() => useAttemptStatus(RUN_ID, attempt), { wrapper }); await flush();
    expect(view.result.current).toBe("started");
    await flush(30_000); expect(view.result.current).toBe("no-response");
    act(() => client.setQueryData<TeamEventState>(teamEventsKey(RUN_ID), previous => mergeTeamEvents(previous!, [event(3, "attempt.acknowledged")])));
    await flush(); expect(view.result.current).toBe("acknowledged");
    view.unmount(); expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });
});

describe("owner action pending state", () => {
  it("blocks duplicate actions synchronously and waits for event reconciliation after success", () => {
    const view = renderHook(({ revision }) => usePendingAction(revision), { initialProps: { revision: 1 } });
    act(() => { expect(view.result.current.begin()).toBe(true); expect(view.result.current.begin()).toBe(false); });
    expect(view.result.current.busy).toBe(true);
    act(() => view.result.current.complete());
    expect(view.result.current.busy).toBe(true);
    act(() => expect(view.result.current.begin()).toBe(false));
    view.rerender({ revision: 2 });
    expect(view.result.current.busy).toBe(false);
    act(() => expect(view.result.current.begin()).toBe(true));
  });
  it("allows a deliberate retry after failure and retains the lock while the request is pending", () => {
    const view = renderHook(({ revision }) => usePendingAction(revision), { initialProps: { revision: 1 } });
    act(() => { view.result.current.begin(); });
    view.rerender({ revision: 2 }); expect(view.result.current.busy).toBe(true);
    act(() => view.result.current.fail()); expect(view.result.current.busy).toBe(false);
    act(() => expect(view.result.current.begin()).toBe(true));
    view.rerender({ revision: 3 });
    act(() => view.result.current.complete()); expect(view.result.current.busy).toBe(false);
  });
});
