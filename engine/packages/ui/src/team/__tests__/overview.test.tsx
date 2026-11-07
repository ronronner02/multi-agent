import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { Overview, verifiedChecks } from "../overview.js";
import { observedTokens } from "../hooks.js";
import type { ChatState, IntegrationState } from "../clients.js";
import { attempt, read, RUN_ID, task } from "./fixtures.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({
  OwnerReadError: class extends Error {},
  useOwnerSession: () => ({ paired: true, request }),
}));
const noChat: ChatState = { available: true, phase: "delivery", messages: [], pendingDecision: null };
const integration: IntegrationState = { available: true, branch: "team/status-filter", commits: [],
  tasksDone: false, merge: { possible: false, reason: null } };
const clients: QueryClient[] = [];
beforeEach(() => { request.mockReset().mockResolvedValue({ status: "accepted" }); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });

async function show(snapshot: TeamOwnerRead = read(), options: { integration?: IntegrationState; chat?: ChatState; locale?: "en" | "zh-CN" } = {}) {
  const language = await createInterfaceI18n({ language: options.locale ?? "en" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const onOpenChat = vi.fn(), onOpenTask = vi.fn(), onOpenTasks = vi.fn();
  const view = render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <Overview read={snapshot} chat={options.chat ?? noChat} integration={options.integration ?? integration}
      onOpenChat={onOpenChat} onOpenTask={onOpenTask} onOpenTasks={onOpenTasks} />
  </I18nextProvider></QueryClientProvider>);
  return { ...view, onOpenChat, onOpenTask, onOpenTasks };
}

describe("Overview", () => {
  it("keeps the integration commit list and task links in folded details", async () => {
    const { onOpenTask } = await show(read(), { integration: { ...integration,
      commits: [{ hash: "a".repeat(40), subject: "Status filter", task: "task-1" }] } });
    const history = screen.getByRole("region", { name: "Commits" });
    expect(within(history).getByText("1 reviewed commits")).toBeTruthy();
    expect(history.querySelector("details")?.open).toBe(false);
    fireEvent.click(within(history).getByText("1 reviewed commits"));
    fireEvent.click(within(history).getByRole("button", { name: "Status filter" }));
    expect(onOpenTask).toHaveBeenCalledWith("task-1");
    expect(history.querySelectorAll("li")).toHaveLength(1);
  });

  it("keeps retired seats out of the active fleet", async () => {
    const snapshot = read();
    snapshot.seats = snapshot.seats.map(seat => ({ ...seat, retired: seat.role === "reviewer" }));
    const view = await show(snapshot);
    expect(view.container.querySelectorAll(".ui-fleet-list li")).toHaveLength(2);
    expect(view.container.querySelector(".ui-fleet-list")?.textContent).not.toContain("Reviewer");
  });

  it("leaves healthy owner attention empty and keeps worker reports with the lead", async () => {
    await show(read({ tasks: [task({ stage: "lead/report", queueState: "blocked" })] }));
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Active tasks" })).getByText("Waiting on lead")).toBeTruthy();
  });

  it("opens the existing chat for plan approval and uses the same decision count", async () => {
    const snapshot = read(); snapshot.run = { ...snapshot.run, phase: "planning" };
    const { onOpenChat } = await show(snapshot);
    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(within(attention).getAllByRole("listitem")).toHaveLength(1);
    expect(attention.querySelector(".ui-count")?.textContent).toBe("1");
    const button = within(attention).getByRole("button", { name: "Review plan in chat" });
    fireEvent.click(button);
    expect(onOpenChat).toHaveBeenCalledWith(button);
  });

  it("does not mark Review complete on an empty planning run", async () => {
    const snapshot = read({ tasks: [] }); snapshot.run = { ...snapshot.run, phase: "planning" };
    await show(snapshot, { integration: { ...integration, tasksDone: true } });
    const reviewPhase = within(screen.getByRole("region", { name: "Verified progress" })).getByText("Review").closest("li");
    expect(reviewPhase?.getAttribute("data-state")).toBe("pending");
  });

  it("retains the existing Resume limit increase and reason", async () => {
    const snapshot = read();
    snapshot.run = { ...snapshot.run, state: "blocked", stateReasonKey: "team.reason.retryLimitExhausted",
      binding: { ...snapshot.run.binding, limits: { ...snapshot.run.binding.limits, maxRetries: 2 } } };
    await show(snapshot);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/runs/" + RUN_ID + "/resume");
    expect(JSON.parse(init.body)).toMatchObject({ expectedEntityVersion: snapshot.run.entityVersion, payload: { addRetries: 2 } });
    expect(within(screen.getByRole("region", { name: "Needs attention" })).getAllByRole("button")).toHaveLength(1);
  });

  it("waits for integration readiness before Merge and handles a refused result", async () => {
    const first = await show();
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount();
    request.mockResolvedValue({ status: "refused", code: "merge_checkout_dirty", reason: "task-private-id" });
    await show(read(), { integration: { ...integration, tasksDone: true, merge: { possible: true, reason: null } } });
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(window.confirm).toHaveBeenCalledWith("Merge the integration branch into the current checkout. The checkout must be clean.");
    expect((await screen.findByRole("alert")).textContent).toContain("The checkout has uncommitted changes");
    expect(screen.queryByText("Merged")).toBeNull();
    expect(document.body.textContent).not.toContain("task-private-id");
  });

  it("confirms Cancel and sends the existing run-level command only after confirmation", async () => {
    await show();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("status");
    expect(request.mock.calls[0]![0]).toBe("/runs/" + RUN_ID + "/cancel");
    expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({
      runId: RUN_ID, payload: { reason: "Owner canceled the run" },
    });
  });

  it("shows the observed cancellation rather than a pending request after the daemon stops the run", async () => {
    request.mockResolvedValue({ status: "observed", value: { state: "canceled" } });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((await screen.findByRole("status")).textContent).toBe("Canceled");
  });

  it("keeps unknown progress distinct from verified criteria without inventing an estimate", async () => {
    const tasks = [task({ stage: "queued" }), task({ taskId: "second", displayName: "Verified task", stage: "running",
      criteria: { verified: 2, total: 4, source: "evidence" } })];
    await show(read({ tasks }));
    expect(screen.getByText("Progress unknown")).toBeTruthy();
    const bar = screen.getByRole("progressbar") as HTMLProgressElement;
    expect(bar.value).toBe(2); expect(bar.max).toBe(4);
    expect(verifiedChecks(tasks)).toBeNull();
    expect(document.body.textContent).not.toMatch(/estimated|0%/i);
  });

  it("uses run-scoped native tokens including cache without double-counting reasoning", async () => {
    const usage = { status: "available" as const, model: "fixture", reason: null,
      inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 20, cacheWriteInputTokens: 10, reasoningOutputTokens: 30 };
    request.mockResolvedValue({ activity: { usage } });
    await show(read({ attempts: [attempt()] }));
    await waitFor(() => expect(screen.getByText("Tokens").parentElement?.querySelector("dd")?.textContent).toBe("170"));
    expect(request.mock.calls[0]![0]).toContain("/runs/" + RUN_ID + "/attempts/");
    expect(observedTokens([usage, undefined])).toEqual({ tokens: 170, partial: true });
    expect(observedTokens([undefined])).toEqual({ tokens: null, partial: true });
    expect(observedTokens([{ ...usage, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }]).tokens).toBe(0);
  });

  it("suppresses stale decisions on a canceled planning run", async () => {
    const snapshot = read(); snapshot.run = { ...snapshot.run, phase: "planning", state: "canceled" };
    await show(snapshot);
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("localises the restored screens without exposing identifiers", async () => {
    await show(read({ tasks: [task({ stage: "queued" })] }), { locale: "zh-CN" });
    expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
    expect(screen.getByText("进度未知")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/tasks\.|overview\.|progress\.|qitem-|task-1|3f2b0c9e/);
  });
});
