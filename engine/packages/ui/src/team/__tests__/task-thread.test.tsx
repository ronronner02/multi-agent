import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead } from "@multi-agent/daemon/team-control";
import { TaskDetails } from "../task-drawer.js";
import { read, RUN_ID, task } from "./fixtures.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({
  OwnerReadError: class extends Error {},
  useOwnerSession: () => ({ paired: true, request }),
}));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });

async function show(snapshot: TeamOwnerRead, taskId: string) {
  const language = await createInterfaceI18n({ language: "en" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <TaskDetails read={snapshot} task={snapshot.tasks.find(item => item.taskId === taskId)!} thread />
  </I18nextProvider></QueryClientProvider>);
}

describe("task thread", () => {
  beforeEach(() => {
    request.mockReset().mockImplementation(async (path: string, init?: { method?: string }) =>
      init?.method === "POST" ? { status: "accepted" }
        : path.endsWith("/comments") ? { comments: [{ id: "c1", runId: RUN_ID, taskId: "task-api", body: "Use the theme hook.",
          createdAt: "2026-11-13T08:00:00.000Z", deliveredAttempt: "a1" }] } : {});
  });

  it("lists the task's comments and sends a new one to that task's agent", async () => {
    await show(read({ tasks: [task({ taskId: "task-api", role: "implementer" })] }), "task-api");
    const thread = screen.getByRole("region", { name: "Comments" });
    expect(await within(thread).findByText("Use the theme hook.")).toBeTruthy();
    expect(within(thread).getByText(/Delivered/)).toBeTruthy();
    fireEvent.change(within(thread).getByRole("textbox", { name: "Comment" }), { target: { value: "Also cover the empty state." } });
    fireEvent.click(within(thread).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(request.mock.calls.some(([path, init]) => init?.method === "POST" && path === `/runs/${RUN_ID}/tasks/task-api/comments`)).toBe(true));
    const [, init] = request.mock.calls.find(([path, init]) => init?.method === "POST" && path.endsWith("/comments"))!;
    expect(JSON.parse(init.body).payload).toEqual({ taskId: "task-api", body: "Also cover the empty state." });
  });

  it("holds and releases the task, and names the task a follow-up continues", async () => {
    const held = read({ tasks: [task({ taskId: "task-api", role: "implementer" }),
      task({ taskId: "task-api-followup-1", role: "implementer", held: true, followUpOf: "task-api" })] });
    await show(held, "task-api-followup-1");
    expect(screen.getByText(/^Follow-up of /)).toBeTruthy();
    const thread = screen.getByRole("region", { name: /Comments/ });
    expect(within(thread).getByText("Held")).toBeTruthy();
    fireEvent.click(within(thread).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === `/runs/${RUN_ID}/tasks/task-api-followup-1/hold`)).toBe(true));
    const [, init] = request.mock.calls.find(([path]) => path.endsWith("/hold"))!;
    expect(JSON.parse(init.body).payload).toEqual({ taskId: "task-api-followup-1", held: false });
  });

  it("offers no thread on a reviewer task", async () => {
    await show(read({ tasks: [task({ taskId: "review-1", role: "reviewer" })] }), "review-1");
    expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();
  });
});
