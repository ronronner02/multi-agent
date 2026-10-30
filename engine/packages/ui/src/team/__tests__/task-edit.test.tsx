import React, { StrictMode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { createInterfaceI18n } from "@openrig/i18n";
import { OwnerReadError } from "../../hooks/useOwnerSession.js";
import { TaskEditControls, TaskEditDialog } from "../task-edit/task-edit-dialog.js";

const mocks = vi.hoisted(() => ({ request: vi.fn(), paired: true }));
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({ ...(await importOriginal<object>()),
  useOwnerSession: () => ({ paired: mocks.paired, request: mocks.request }),
}));
type Snapshot = Parameters<typeof TaskEditDialog>[0]["snapshot"];
const snapshot: Snapshot = { protocolVersion: "1.0", runVersion: 10, runState: "approved",
  task: { taskId: "A", qitemId: "q-A", taskVersion: 2, state: "pending", priority: "routine", role: "implementer", paths: ["src/A.ts"], dependencies: [], notes: "existing note", order: 0 },
  scope: { chainHead: "head", scopeDigest: "scope", extensions: [] },
};
const applied = { status: "accepted", value: { classification: "applied", affectedTasks: [] } };
afterEach(() => { cleanup(); mocks.request.mockReset(); mocks.paired = true; });
async function show(locale: "en" | "zh-CN" = "en", refreshFailure = false, controls = false) {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refresh = vi.fn();
  function Fixture() {
    const [current, setCurrent] = useState(snapshot);
    return <div className="team-shell">{controls ? <TaskEditControls runId="run" taskId="A" /> : <TaskEditDialog snapshot={current} runId="run" trigger={null} refreshing={false}
      refresh={async () => { refresh(); if (refreshFailure) throw new Error("unavailable"); setCurrent({ ...current, runVersion: 11, task: { ...current.task, taskVersion: 3 } }); }} onClose={() => {}} />}</div>;
  }
  render(<StrictMode><QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}><Fixture /></I18nextProvider></QueryClientProvider></StrictMode>);
  return { t: language.t, refresh, cache };
}

it.each(["en", "zh-CN"] as const)("sends a versioned edit and announces daemon classification (%s)", async locale => {
  mocks.request.mockResolvedValue(applied);
  const { t } = await show(locale);
  await screen.findByRole("dialog", { name: t("edit.title") });
  fireEvent.change(screen.getByLabelText(t("edit.value")), { target: { value: "owner note" } });
  fireEvent.click(screen.getByRole("button", { name: t("edit.submit") }));
  await waitFor(() => expect(screen.getByTestId("task-edit-result").textContent).toBe(t("edit.applied")));
  const body = JSON.parse(mocks.request.mock.calls[0]![1].body);
  expect(body).toMatchObject({ runId: "run", actionId: "A", expectedEntityVersion: 10, payload: { expectedTaskVersion: 2, changes: { notes: "owner note" } } });
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: t("edit.submit") }).hasAttribute("disabled")).toBe(true);
});

it("requires a new confirmation after a conflict and uses the refreshed versions", async () => {
  mocks.request.mockRejectedValueOnce(new OwnerReadError(409, "control_conflict")).mockResolvedValue(applied);
  const { t, refresh } = await show();
  fireEvent.click(await screen.findByRole("button", { name: t("edit.submit") }));
  await waitFor(() => expect(screen.getByTestId("task-edit-result").textContent).toBe(t("edit.conflict")));
  expect(refresh).toHaveBeenCalledTimes(1); expect(mocks.request).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole("button", { name: t("edit.submit") }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: t("edit.submit") }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  const first = JSON.parse(mocks.request.mock.calls[0]![1].body), second = JSON.parse(mocks.request.mock.calls[1]![1].body);
  expect(second.expectedEntityVersion).toBe(11); expect(second.payload.expectedTaskVersion).toBe(3);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
});

it.each([new TypeError("connection lost"), new OwnerReadError(500, "control_persistence_failed")])("retains the exact request after an unknown acknowledgement: %s", async error => {
  mocks.request.mockRejectedValueOnce(error).mockResolvedValue(applied);
  const { t } = await show();
  fireEvent.click(await screen.findByRole("button", { name: t("edit.submit") }));
  const retry = await screen.findByRole("button", { name: t("edit.retryExact") });
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
  expect(screen.getByLabelText(t("edit.value")).hasAttribute("disabled")).toBe(true);
  fireEvent.click(retry);
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  expect(mocks.request.mock.calls[1]![1].body).toBe(mocks.request.mock.calls[0]![1].body);
});

it("keeps confirmation disabled when conflict refresh fails", async () => {
  mocks.request.mockRejectedValue(new OwnerReadError(409, "control_conflict"));
  const { t } = await show("en", true);
  fireEvent.click(await screen.findByRole("button", { name: t("edit.submit") }));
  await waitFor(() => expect(screen.getByTestId("task-edit-result").textContent).toBe(t("edit.error")));
  expect(screen.getByRole("button", { name: t("edit.submit") }).hasAttribute("disabled")).toBe(true);
});

it("shows affected work only from the daemon's plan-change receipt", async () => {
  mocks.request.mockResolvedValue({ ...applied, value: { classification: "plan-change-required", affectedTasks: ["A", "B"] } });
  const { t } = await show();
  fireEvent.change(await screen.findByLabelText(t("edit.field")), { target: { value: "acceptanceCriteria" } });
  fireEvent.change(screen.getByLabelText(t("edit.value")), { target: { value: '["new criterion"]' } });
  fireEvent.click(screen.getByRole("button", { name: t("edit.submit") }));
  await waitFor(() => expect(screen.getByTestId("task-edit-result").getAttribute("role")).toBe("alert"));
  expect(screen.getByTestId("task-edit-result").textContent).toBe(t("edit.plan-change-required"));
  expect(screen.getByText("A, B")).toBeTruthy();
});

it("renders automatic and invalidated extension states without disguising invalidation", async () => {
  mocks.request.mockResolvedValue({ ...snapshot, scope: { ...snapshot.scope, extensions: [
    { id: "auto", automatic: true, state: "approved", paths: [{ path: "src/new.ts", operation: "create" }] },
    { id: "invalid", automatic: true, state: "invalidated", paths: [] },
  ] } });
  const { t } = await show("en", false, true);
  await screen.findByText("auto");
  expect(screen.getByText("auto").parentElement?.textContent).toContain(t("edit.automatic"));
  expect(screen.getByText("invalid").parentElement?.textContent).toContain(t("edit.invalidated"));
  expect(screen.getByText("invalid").parentElement?.textContent).not.toContain(t("edit.automatic"));
});

it("replays a lost material edit after the snapshot becomes invalidated", async () => {
  let current = snapshot; const requests: string[] = [];
  mocks.request.mockImplementation(async (_path, init) => {
    if (init?.method !== "POST") return current;
    requests.push(init.body);
    current = { ...snapshot, runState: "invalidated", runVersion: 11 };
    if (requests.length === 1) throw new TypeError("lost after commit");
    return { ...applied, value: { classification: "plan-change-required", affectedTasks: ["A"] } };
  });
  const { t, cache } = await show("en", false, true);
  fireEvent.click(await screen.findByRole("button", { name: t("edit.title") }));
  fireEvent.change(await screen.findByLabelText(t("edit.field")), { target: { value: "acceptanceCriteria" } });
  fireEvent.change(screen.getByLabelText(t("edit.value")), { target: { value: '["new criterion"]' } });
  fireEvent.click(screen.getByRole("button", { name: t("edit.submit") }));
  const retry = await screen.findByRole("button", { name: t("edit.retryExact") });
  await cache.invalidateQueries({ queryKey: ["team", "run"] });
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByTestId("task-edit-result").textContent).toBe(t("edit.plan-change-required")));
  expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]);
});

it("returns focus to the task edit region when suspension disables its trigger", async () => {
  let current = snapshot;
  mocks.request.mockImplementation(async (_path, init) => {
    if (init?.method !== "POST") return current;
    current = { ...snapshot, runState: "invalidated", runVersion: 11 };
    return { ...applied, value: { classification: "plan-change-required", affectedTasks: ["A"] } };
  });
  const { t } = await show("en", false, true);
  const trigger = await screen.findByRole("button", { name: t("edit.title") });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("button", { name: t("edit.submit") }));
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: t("web.close") }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: t("edit.title") })));
});
