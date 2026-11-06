import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "../../routes.js";
import { queryClient } from "../../lib/query-client.js";
import { read, RUN_ID, task } from "./fixtures.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

let mobile = false;
const data = read({ tasks: [task({ queueState: "pending" }), task({ taskId: "task-2", displayName: "Filter chips", queueState: "pending" })] });
const unexpected: string[] = [];
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  mobile = false; unexpected.length = 0;
  localStorage.clear(); sessionStorage.clear(); queryClient.clear();
  localStorage.setItem("openrig.interfaceLanguage", "en");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const original = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ ...original(query), matches: mobile && query === "(max-width: 760px)" }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
    const response = (body: object) => new Response(JSON.stringify({ protocolVersion: "1.0", ...body }), { headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/owner-session/exchange")) return response({ antiForgeryToken: "a".repeat(43) });
    if (path === "/api/team-control/teams") return response({ teams: [{ id: data.run.rigId, name: "Status board", repository: "/fixture", seats: [] }] });
    if (path === "/api/team-control/runs") return response({ runs: [{ id: RUN_ID, rigId: data.run.rigId, rigName: "Status board", displayName: data.run.displayName, state: data.run.state }] });
    if (path.endsWith("/health")) return response({ health: { runtime: { isolation: "none" } } });
    if (path.endsWith("/read")) return response({ read: data });
    if (path.endsWith("/replay")) return response({ runId: RUN_ID, events: [], window: data.replay, gap: false });
    if (path.endsWith("/chat")) return response({ phase: "delivery", pendingDecision: null, messages: [{
      id: "question-1", sender: "lead", kind: "decision", body: "Keep the existing behavior?", options: ["Keep", "Change"], answeredBy: null, createdAt: data.generatedAt,
    }] });
    if (path.endsWith("/integration")) return response({ integration: { branch: "team/status-filter", commits: [], tasksDone: false, merge: { possible: false, reason: null } } });
    if (path.endsWith("/result")) return response({ result: { patch: "" } });
    if (path.endsWith("/completion")) return response({ completion: { queueState: "pending", attempt: null } });
    unexpected.push(path);
    return new Response(JSON.stringify({ code: "unexpected_fixture_read" }), { status: 404 });
  }));
});
afterEach(() => {
  cleanup(); queryClient.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  expect(unexpected).toEqual([]);
});

async function openShell() {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [`/team/overview?run=${RUN_ID}`] }), defaultPendingMinMs: 0 });
  await act(async () => { render(<RouterProvider router={router} />); await router.load(); });
  const pairing = await screen.findByLabelText("One-time pairing code");
  fireEvent.change(pairing, { target: { value: "fixture-pairing" } });
  fireEvent.submit(pairing.closest("form")!);
  await screen.findByRole("button", { name: "Notifications: 1" });
  return router;
}

describe("command-center router integration", () => {
  it("keeps the real chat draft mounted while every destination changes the URL", async () => {
    const router = await openShell();
    const opener = screen.getByRole("button", { name: "Coordinator" });
    fireEvent.click(opener);
    const panel = screen.getByRole("dialog", { name: "Lead chat" });
    const field = within(panel).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Retain this question across sections" } });
    const nav = screen.getByRole("navigation", { name: "Multi-Agent" });
    for (const section of ["Workspace", "Tasks", "Reviews", "Analytics", "Settings", "Overview"]) {
      const link = within(nav).getByRole("link", { name: section });
      fireEvent.pointerDown(link); fireEvent.click(link);
      await waitFor(() => expect(router.state.location.pathname).toBe(`/team/${section.toLowerCase()}`));
      expect(router.state.location.search.run).toBe(RUN_ID);
      expect(link.getAttribute("aria-current")).toBe("page");
      expect(within(panel).getByRole("textbox", { name: "Message" })).toBe(field);
      expect(field.value).toBe("Retain this question across sections");
    }
    const rows = within(panel).getByRole("region", { name: "Needs your attention" });
    expect(within(rows).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("uses Ctrl K and Enter to navigate to the selected task", async () => {
    const router = await openShell();
    const opener = screen.getByRole("button", { name: "Search or jump to…" });
    opener.focus(); fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const field = screen.getByRole("combobox", { name: "Search or jump to…" });
    fireEvent.keyDown(field, { key: "ArrowDown" }); fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(router.state.location.search.task).toBe("task-2"));
    expect(router.state.location.pathname).toBe("/team/tasks");
    expect(router.state.location.search.run).toBe(RUN_ID);
    expect(screen.getByRole("heading", { name: "Filter chips" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("closes mobile navigation before opening chat and returns focus to the menu trigger", async () => {
    mobile = true;
    await openShell();
    const menu = screen.getByLabelText("Open navigation");
    menu.style.display = "grid";
    fireEvent.click(menu);
    const navigation = screen.getByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Coordinator" }));
    await waitFor(() => expect(navigation.isConnected).toBe(false));
    const panel = screen.getByRole("dialog", { name: "Lead chat" });
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });
});
