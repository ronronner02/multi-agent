import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead, ToolActivityRecord } from "@openrig/daemon/team-control";
import { WorkspaceScreen } from "../workspace/workspace-screen.js";
import { mergeToolCalls } from "../../hooks/useAttemptActivity.js";
import { read, seats, task } from "./fixtures.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({ useOwnerSession: () => ({ paired: true, request }) }));
const clients: QueryClient[] = [];
beforeEach(() => {
  request.mockReset();
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

async function show(snapshot: TeamOwnerRead = read()) {
  const language = await createInterfaceI18n({ language: "en" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <WorkspaceScreen read={snapshot} selectedTaskId="" />
  </I18nextProvider></QueryClientProvider>);
}

describe("Workspace", () => {
  it("keeps a tool call's first-seen position and text when it settles", () => {
    const first: ToolActivityRecord = { id: "call-1", seq: 1, at: "2026-11-07T10:00:00.000Z",
      tool: "Read", summary: "src/filter.ts", status: "running" };
    const second: ToolActivityRecord = { ...first, id: "call-2", seq: 2, tool: "Test" };
    const merged = mergeToolCalls([first, second], [
      { ...first, seq: 3, at: "2026-11-07T10:00:02.000Z", status: "completed" },
      { ...second, seq: 4, status: "aborted" }, first,
    ]);
    expect(merged).toEqual([{ ...first, seq: 3, status: "completed" }, { ...second, seq: 4, status: "aborted" }]);
  });

  it("renders one card per seat and explicitly marks retired seats", async () => {
    await show(read({ seats: seats.map(seat => ({ ...seat, retired: seat.role === "reviewer" })) }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(within(screen.getByRole("article", { name: "Reviewer · Claude Code" })).getByText("Retired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pause|Stop/ })).toBeNull();
    expect(document.body.textContent).not.toContain("impl@rig");
  });

  it("preserves the selected seat across grid, split and focus", async () => {
    await show(read({ tasks: [task(), task({ taskId: "review-work", role: "reviewer", seat: "review@rig",
      displayName: "Check filters", stage: "review" })] }));
    fireEvent.click(within(screen.getByRole("article", { name: "Reviewer · Claude Code" })).getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(within(screen.getByRole("region", { name: "Agent identity" })).getByText("Check filters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect((screen.getByRole("combobox", { name: "Agent" }) as HTMLSelectElement).value).toBe("review@rig");
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(within(screen.getByRole("article", { name: "Reviewer · Claude Code" })).getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });
});
