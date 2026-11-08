import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { AttemptActivity, TeamAttemptView } from "@openrig/daemon/team-control";
import { useAttemptActivity } from "../../hooks/useAttemptActivity.js";
import { ActivityFacts, ToolCalls } from "../workspace/workspace-view.js";
import { useTeamChat } from "../hooks.js";
import { attempt, RUN_ID } from "./fixtures.js";

const session = vi.hoisted(() => ({ paired: true, request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({ useOwnerSession: () => session }));
let visibility: (visible: boolean) => void;
let language: Awaited<ReturnType<typeof createInterfaceI18n>>;
let client: QueryClient;
const at = "2026-11-07T10:00:00.000Z";
const running = attempt({ state: "running" });
function activity(): AttemptActivity {
  return { attemptId: running.attemptId, state: "running", source: "live", startedAt: at, stoppedAt: null,
    activeMs: 1000, outcome: "unknown", activityStatus: "available", nextSeq: 2,
    usage: { status: "available", reason: null, model: "fixture-model", inputTokens: 1000,
      cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 },
    records: [
      { id: "call-1", seq: 1, at, tool: "Read", summary: "src/filter.ts", status: "running" },
      { id: "call-2", seq: 2, at, tool: "Test", summary: "Filter cases", status: "running" },
    ] };
}
beforeEach(async () => {
  language = await createInterfaceI18n({ language: "en" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  session.paired = true; session.request.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) {
      visibility = value => callback([{ isIntersecting: value } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe() {}
    disconnect() {}
  });
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function advance(ms = 5) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function Probe({ current }: { current?: TeamAttemptView }) {
  const result = useAttemptActivity(RUN_ID, current);
  return <section ref={result.ref}><ActivityFacts activity={result.data} /><ToolCalls activity={result.data} error={result.isError} /></section>;
}
function tree(current?: TeamAttemptView) {
  return <QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <Probe current={current} />
  </I18nextProvider></QueryClientProvider>;
}

describe("visible attempt activity", () => {
  it("refreshes active chat increments at 500 ms and returns to the history cadence when stopped", async () => {
    let state = "running";
    session.request.mockImplementation(async () => ({ phase: "planning", messages: [], pendingDecision: null,
      liveTurn: { attemptId: "lead-live", state, progress: null, activity: null } }));
    function ChatProbe() { const chat = useTeamChat(RUN_ID, true); return <p>{chat.data?.liveTurn?.state}</p>; }
    const view = render(<QueryClientProvider client={client}><ChatProbe /></QueryClientProvider>);
    await advance(); expect(screen.getByText("running")).toBeTruthy();
    const initial = session.request.mock.calls.length;
    await advance(500); await advance(); expect(session.request.mock.calls.length).toBe(initial + 1);
    state = "stopped";
    await advance(500); await advance(); expect(screen.getByText("stopped")).toBeTruthy();
    const stopped = session.request.mock.calls.length;
    await advance(1000); expect(session.request.mock.calls.length).toBe(stopped);
    await advance(2000); await advance(); expect(session.request.mock.calls.length).toBe(stopped + 1);
    view.unmount(); const unmounted = session.request.mock.calls.length;
    await advance(4000); expect(session.request.mock.calls.length).toBe(unmounted);
  });

  it("appends live calls and tokens, pauses when hidden, then reads the stopped attempt once without moving its rows", async () => {
    let frame = activity();
    session.request.mockImplementation(async (path: string) => {
      const after = Number(new URL(path, "http://localhost").searchParams.get("after"));
      return { activity: { ...frame, records: frame.records.filter(record => record.seq > after) } };
    });
    const view = render(tree(running));
    await advance();
    expect(session.request).not.toHaveBeenCalled();
    act(() => visibility(true)); await advance();
    expect(screen.getByText("1,200")).toBeTruthy();
    const first = view.container.querySelector('[data-call="call-1"]');
    const firstText = first?.textContent;
    frame = { ...frame, usage: { ...frame.usage, outputTokens: 400 }, nextSeq: 4, records: [...frame.records,
      { ...frame.records[0]!, seq: 3, at: "2026-11-07T10:00:02.000Z", status: "completed" },
      { ...frame.records[1]!, id: "call-3", seq: 4, tool: "Write" },
    ] };
    await advance(2000); await advance();
    expect(screen.getByText("1,400")).toBeTruthy();
    expect(view.container.querySelector('[data-call="call-1"]')).toBe(first);
    expect(first?.textContent).toBe(firstText);
    expect(first?.getAttribute("data-status")).toBe("succeeded");
    expect([...view.container.querySelectorAll("[data-call]")].map(row => row.getAttribute("data-call"))).toEqual(["call-1", "call-2", "call-3"]);
    act(() => visibility(false)); const beforeHidden = session.request.mock.calls.length;
    await advance(6000);
    expect(session.request).toHaveBeenCalledTimes(beforeHidden);
    act(() => visibility(true)); await advance();
    let settle!: (value: { activity: AttemptActivity }) => void;
    session.request.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    view.rerender(tree({ ...running, state: "stopped" })); await advance();
    expect(view.container.querySelector('[data-call="call-1"]')).toBe(first);
    expect(first?.getAttribute("data-status")).toBe("succeeded");
    await act(async () => settle({ activity: { ...frame, state: "stopped", source: "stored", nextSeq: 6,
      records: [...frame.records, { ...frame.records[1]!, seq: 5, status: "aborted" },
        { ...frame.records[3]!, seq: 6, status: "aborted" }] } }));
    await advance();
    expect(view.container.querySelector('[data-call="call-2"]')?.getAttribute("data-status")).toBe("aborted");
    const stoppedReads = session.request.mock.calls.length;
    await advance(6000);
    act(() => visibility(false)); act(() => visibility(true)); await advance();
    expect(session.request).toHaveBeenCalledTimes(stoppedReads);
    expect(view.container.querySelector('[data-call="call-1"]')).toBe(first);
  });

  it("suppresses reads in a hidden document and while unpaired", async () => {
    session.request.mockResolvedValue({ activity: activity() });
    const visibilityState = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const view = render(tree(running));
    act(() => visibility(true)); await advance(4000);
    expect(session.request).not.toHaveBeenCalled();
    visibilityState.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange"))); await advance();
    expect(session.request).toHaveBeenCalledTimes(1);
    session.paired = false; view.rerender(tree(running)); await advance(4000);
    expect(session.request).toHaveBeenCalledTimes(1);
  });

  it("shows unavailable activity after a failed read rather than a success", async () => {
    session.request.mockRejectedValue(new Error("offline"));
    render(tree(running)); act(() => visibility(true)); await advance();
    expect(screen.getByText("Tool activity is unavailable.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
