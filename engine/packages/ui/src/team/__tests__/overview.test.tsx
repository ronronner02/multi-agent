import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead } from "@multi-agent/daemon/team-control";
import { Overview, verifiedChecks } from "../overview.js";
import { observedTokens } from "../hooks.js";
import { readIntegration, type ChatState, type IntegrationState } from "../clients.js";
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
  const content = (next: TeamOwnerRead) => <QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <Overview read={next} chat={options.chat ?? noChat} integration={options.integration ?? integration}
      onOpenChat={onOpenChat} onOpenTask={onOpenTask} onOpenTasks={onOpenTasks} />
  </I18nextProvider></QueryClientProvider>;
  const view = render(content(snapshot));
  return { ...view, rerenderRead: (next: TeamOwnerRead) => view.rerender(content(next)), onOpenChat, onOpenTask, onOpenTasks };
}

describe("Overview", () => {
  it("keeps the task list, a non-modal inspector and honest system status together", async () => {
    await show(read({ tasks: [task(), task({ taskId: "second", displayName: "Keyboard access", stage: "running" })] }));
    const list = screen.getByRole("region", { name: "Task list" });
    fireEvent.click(within(list).getByRole("button", { name: /Keyboard access/ }));
    const inspector = screen.getByRole("region", { name: "Task detail" });
    expect(within(inspector).getByRole("heading", { name: "Keyboard access" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    const health = screen.getByRole("region", { name: "System status" });
    expect(within(health).getAllByText("Unknown")).toHaveLength(6);
    expect(within(health).queryByText("OK")).toBeNull();
  });

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

  it("shows completed work by default and keeps the result before supporting status cards", async () => {
    await show(read({ tasks: [task({ stage: "done", queueState: "done" })] }), { integration: {
      ...integration, tasksDone: true, commits: [{ hash: "a".repeat(40), subject: "Status filter", task: "task-1" }],
    } });
    expect(screen.getByRole("combobox", { name: "Task status" })).toHaveProperty("value", "all");
    expect(within(screen.getByRole("region", { name: "Task list" })).getByRole("button", { name: /Status filter/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Commits" }).compareDocumentPosition(screen.getByRole("region", { name: "System status" }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("follows completion until the owner chooses a specific task filter", async () => {
    const snapshot = read({ tasks: [task({ stage: "running" })] });
    const view = await show(snapshot);
    const filter = screen.getByRole("combobox", { name: "Task status" });
    expect(filter).toHaveProperty("value", "active");
    view.rerenderRead({ ...snapshot, tasks: [task({ stage: "done", queueState: "done" })] });
    expect(filter).toHaveProperty("value", "all");
    fireEvent.change(filter, { target: { value: "active" } });
    view.rerenderRead({ ...snapshot, tasks: [task({ stage: "done", queueState: "done" })] });
    expect(filter).toHaveProperty("value", "active");
    expect(screen.queryByRole("region", { name: "Task detail" })).toBeNull();
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
    expect(within(within(screen.getByRole("region", { name: "Task list" })).getByRole("list")).getByText("Waiting on lead")).toBeTruthy();
  });

  it("shows a worker's question word for word and sends the owner's answer to that task", async () => {
    // Covers AE3: the question is in Needs attention as the worker wrote it, and the answer is a
    // comment on the worker's own task rather than a chat message to the lead.
    const question = "Keep the v1 endpoint or remove it?";
    await show(read({ tasks: [task({ taskId: "task-api", stage: "owner/question", queueState: "blocked",
      workerReport: { status: "needs-decision", question, evidence: "Both callers still exist.", truncated: false, attemptId: "a1", resolution: null } })] }));
    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(within(attention).getByText(question)).toBeTruthy();
    expect(attention.querySelector(".ui-count")?.textContent).toBe("1");
    fireEvent.change(within(attention).getByRole("textbox", { name: "Answer" }), { target: { value: "Remove it." } });
    fireEvent.click(within(attention).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe(`/runs/${RUN_ID}/tasks/task-api/comments`);
    expect(JSON.parse((init as { body: string }).body).payload).toEqual({ taskId: "task-api", body: "Remove it." });
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
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ actionId: RUN_ID, expectedEntityVersion: snapshot.run.entityVersion, payload: { addRetries: 2 } });
    expect(body.idempotencyKey).toEqual(expect.any(String));
    expect(within(screen.getByRole("region", { name: "Needs attention" })).getAllByRole("button")).toHaveLength(1);
  });

  it("resumes active-time blocks with a fixed one-hour increase", async () => {
    const snapshot = read();
    snapshot.run = { ...snapshot.run, state: "blocked", stateReasonKey: "team.reason.activeWallClockBudget",
      binding: { ...snapshot.run.binding, limits: { ...snapshot.run.binding.limits, maxActiveMs: 4 * 24 * 60 * 60_000 } } };
    const view = await show(snapshot);
    expect(screen.getByText("Resuming adds 60 minutes to the active-time budget.")).toBeTruthy();
    const resume = screen.getByRole("button", { name: "Resume" });
    fireEvent.click(resume);
    await waitFor(() => expect(request).toHaveBeenCalled());
    const [path, init] = request.mock.calls[0]!;
    const body = JSON.parse(init.body);
    expect(path).toBe("/runs/" + RUN_ID + "/resume");
    expect(body).toMatchObject({ actionId: RUN_ID, expectedEntityVersion: snapshot.run.entityVersion, payload: { addMinutes: 60 } });
    expect(body.idempotencyKey).toEqual(expect.any(String));
    fireEvent.click(resume);
    expect(request).toHaveBeenCalledTimes(1);
    expect(resume).toHaveProperty("disabled", true);
    view.rerenderRead({ ...snapshot, run: { ...snapshot.run, entityVersion: snapshot.run.entityVersion + 1 } });
    fireEvent.click(resume);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(JSON.parse(request.mock.calls[1]![1].body).idempotencyKey).not.toBe(body.idempotencyKey);
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

  it.each([true, false, null, undefined])("uses observed Merge completion after refresh, not readiness: %s", async (merged) => {
    const decoded = await readIntegration(vi.fn().mockResolvedValue({ integration: {
      ...integration, tasksDone: true, merge: { possible: true, reason: null, merged },
    } }), RUN_ID);
    expect(decoded.merge.merged).toBe(merged ?? null);
    await show(read({ tasks: [task({ stage: "done", queueState: "done" })] }), { integration: decoded });
    const phase = within(screen.getByRole("region", { name: "Verified progress" })).getByText("Merge").closest("li");
    expect(phase?.getAttribute("data-state")).toBe(merged === true ? "complete" : "awaiting-decision");
    const button = screen.getByRole("button", { name: merged === true ? "Merged" : "Merge" }) as HTMLButtonElement;
    expect(button.disabled).toBe(merged === true);
    expect(request).not.toHaveBeenCalled();
  });

  it("links a GitHub project's pull request and merges it there with the owner's account", async () => {
    const decoded = await readIntegration(vi.fn().mockResolvedValue({ integration: { ...integration, tasksDone: true, merge: { possible: true, reason: null } },
      pullRequest: { runId: RUN_ID, repository: "acme/app", number: 12, url: "https://github.com/acme/app/pull/12", headSha: "abc", state: "open" } }), RUN_ID);
    expect(decoded.pullRequest).toEqual({ number: 12, url: "https://github.com/acme/app/pull/12", state: "open" });
    request.mockResolvedValue({ status: "merged", code: null, reason: null, branch: "team/status-filter", mode: "pull-request", head: "abc" });
    await show(read(), { integration: decoded });
    const link = screen.getByRole("link", { name: "Pull request #12" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/app/pull/12");
    expect(link.getAttribute("target")).toBe("_blank");
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request #12" }));
    expect(window.confirm).toHaveBeenCalledWith("Merge pull request #12 on GitHub with your account.");
    expect((await screen.findByRole("status")).textContent).toBe("Merged");
  });

  it("names a merge GitHub refused, and shows a merged pull request as merged", async () => {
    const pullRequest = { number: 12, url: "https://github.com/acme/app/pull/12", state: "open" as const };
    request.mockResolvedValue({ status: "refused", code: "github_pr_failed", reason: null, branch: null, mode: null, head: null });
    const first = await show(read(), { integration: { ...integration, tasksDone: true, merge: { possible: true, reason: null }, pullRequest } });
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request #12" }));
    expect((await screen.findByRole("alert")).textContent).toBe("GitHub refused the merge");
    first.unmount();
    await show(read({ tasks: [task({ stage: "done", queueState: "done" })] }),
      { integration: { ...integration, tasksDone: true, merge: { possible: true, reason: null }, pullRequest: { ...pullRequest, state: "merged" } } });
    expect((screen.getByRole("button", { name: "Merged" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByRole("region", { name: "Verified progress" })).getByText("Merge").closest("li")?.getAttribute("data-state")).toBe("complete");
  });

  it("ignores a pull request record whose link is not on GitHub", async () => {
    const decoded = await readIntegration(vi.fn().mockResolvedValue({ integration,
      pullRequest: { number: 3, url: "javascript:alert(1)", state: "open" } }), RUN_ID);
    expect(decoded.pullRequest).toBeNull();
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

  it("shows observed cancellation only for the run that was canceled", async () => {
    request.mockResolvedValue({ status: "observed", value: { state: "canceled" } });
    const view = await show();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((await screen.findByRole("status")).textContent).toBe("Canceled");
    const next = read(); next.runId = "next-run"; next.run = { ...next.run, id: next.runId };
    view.rerenderRead(next);
    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not carry a pending action or its late result into another run", async () => {
    let finish!: (value: unknown) => void;
    request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = await show();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    const next = read(); next.runId = "next-run"; next.run = { ...next.run, id: next.runId };
    view.rerenderRead(next);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => finish({ status: "observed", value: { state: "canceled" } }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps unknown progress distinct from verified criteria without inventing an estimate", async () => {
    const tasks = [task({ stage: "queued" }), task({ taskId: "second", displayName: "Verified task", stage: "running",
      criteria: { verified: 2, total: 4, source: "evidence" } })];
    await show(read({ tasks }));
    expect(within(screen.getByRole("region", { name: "Task list" })).getByText("Progress unknown")).toBeTruthy();
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
    expect(within(screen.getByRole("region", { name: "任务列表" })).getByText("进度未知")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/tasks\.|overview\.|progress\./);
    for (const element of document.querySelectorAll(".ui-overview *")) {
      if (element.children.length === 0 && /qitem-|task-1|3f2b0c9e/.test(element.textContent ?? "")) {
        expect(element.closest("details")).not.toBeNull();
      }
    }
  });
});
