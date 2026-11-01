import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { createInterfaceI18n } from "@openrig/i18n";
import { OwnerReadError } from "../../hooks/useOwnerSession.js";
import { NewTaskForm, NoRunCard, RunSelect } from "../new-task.js";

/**
 * MVP slice 2 — the Web UI "New task" form.
 *
 * The form is the owner's only in-browser way to create work, so what matters is that it
 * sends the goal to the one endpoint, that a refusal is reported instead of a silent no-op,
 * and that the run list is the list the daemon returned.
 */

const mocks = vi.hoisted(() => ({ request: vi.fn(), paired: true, navigate: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({ ...(await importOriginal<object>()),
  useOwnerSession: () => ({ paired: mocks.paired, request: mocks.request }),
}));
vi.mock("@tanstack/react-router", async importOriginal => ({ ...(await importOriginal<object>()),
  useNavigate: () => mocks.navigate,
  Link: ({ children, search }: { children: React.ReactNode; search: { run?: string } }) =>
    React.createElement("a", { href: "/team?run=" + (search.run ?? "") }, children),
}));

afterEach(() => { mocks.request.mockReset(); mocks.navigate.mockReset(); mocks.paired = true; });

async function show(component: React.ReactElement, locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>{component}</I18nextProvider></QueryClientProvider>);
  return language;
}

it.each(["en", "zh-CN"] as const)("starts a run from the goal and opens it (%s)", async locale => {
  mocks.request.mockResolvedValue({ protocolVersion: "1.0", runId: "run-9", rigId: "rig", approvalId: "a",
    taskId: "task-1", qitemId: "q", seat: "dev@demo", state: "approved" });
  const language = await show(<NewTaskForm />, locale);
  fireEvent.change(screen.getByLabelText(language.t("web.goal")), { target: { value: "Add a health endpoint" } });
  fireEvent.click(screen.getByRole("button", { name: language.t("web.startTask") }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
  const [path, init] = mocks.request.mock.calls[0]!;
  expect(path).toBe("/runs");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ goal: "Add a health endpoint" });
  expect(mocks.navigate.mock.calls[0]![0]).toMatchObject({ params: { section: "overview" }, search: { run: "run-9" } });
  // One start is one request: a second click while busy must not create a second run.
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("reports a refused start and stays on the form", async () => {
  mocks.request.mockRejectedValue(new OwnerReadError(409, "start_refused"));
  const language = await show(<NewTaskForm />);
  fireEvent.change(screen.getByLabelText(language.t("web.goal")), { target: { value: "Add a health endpoint" } });
  fireEvent.click(screen.getByRole("button", { name: language.t("web.startTask") }));
  expect((await screen.findByRole("alert")).textContent).toBe(language.t("web.startRefused"));
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("lists the runs the daemon returned so an id need not be typed", async () => {
  mocks.request.mockResolvedValue({ runs: [
    { id: "run-9", rigId: "rig", rigName: "demo", state: "approved", planRef: "plan.md", createdAt: "2026-10-31T00:00:00.000Z" },
    { id: "run-8", rigId: "rig", rigName: "demo", state: "pending", planRef: "plan.md", createdAt: "2026-10-30T00:00:00.000Z" },
  ] });
  const language = await show(<RunSelect current="run-8" />);
  const select = screen.getByRole("combobox", { name: language.t("shell.run") }) as HTMLSelectElement;
  await waitFor(() => expect(select.options).toHaveLength(2));
  expect([...select.options].map(option => option.value)).toEqual(["run-9", "run-8"]);
  expect(select.value).toBe("run-8");
  fireEvent.change(select, { target: { value: "run-9" } });
  expect(mocks.navigate.mock.calls[0]![0]).toMatchObject({ params: { section: "overview" }, search: { run: "run-9" } });
});

it("keeps the current run selectable when the run list does not include it", async () => {
  mocks.request.mockResolvedValue({ runs: [] });
  const language = await show(<RunSelect current="run-7" />);
  const select = screen.getByRole("combobox", { name: language.t("shell.run") }) as HTMLSelectElement;
  await waitFor(() => expect(select.options).toHaveLength(1));
  expect(select.options[0]!.value).toBe("run-7");
  expect(select.value).toBe("run-7");
});

it("does not call the daemon until the browser is paired", async () => {
  mocks.paired = false;
  const language = await show(<NewTaskForm />);
  expect(screen.getByRole("button", { name: language.t("web.startTask") }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("status").textContent).toBe(language.t("web.pairRequired"));
  expect(mocks.request).not.toHaveBeenCalled();
});

it.each(["en", "zh-CN"] as const)("offers the start form when no run is selected, so a fresh install can begin (%s)", async locale => {
  const language = await show(<NoRunCard />, locale);
  const status = screen.getByRole("status");
  expect(status.textContent).toContain(language.t("shell.noRun"));
  expect(status.textContent).toContain(language.t("shell.noRunHint"));
  expect(screen.getByRole("region", { name: language.t("web.newTask") })).toBeTruthy();
  expect(screen.getByLabelText(language.t("web.goal"))).toBeTruthy();
});
