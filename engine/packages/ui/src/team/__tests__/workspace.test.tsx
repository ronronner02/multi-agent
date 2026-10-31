import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n, type InterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { WorkspaceScreen, WORKSPACE_VIEWS } from "../workspace/workspace-screen.js";
import { RunControlDialog, WorkspaceFocus, attemptFor, checksLabel, defaultTask, elapsedLabel } from "../workspace/workspace-focus.js";
import { read, run, task } from "./fixtures.js";

/**
 * Slice B — Workspace.
 *
 * The screen's promise is that it shows one agent honestly: a value the read model does not carry
 * is an em dash, the Changes tab says the result is not ready instead of drawing an empty diff, and
 * Pause and Stop ask before they send anything. Focus is the screen, but the surfaces slice A
 * mapped here keep a home as sub-views.
 */

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({ ...(await importOriginal<object>()),
  useOwnerSession: () => ({ paired: true, request: mocks.request }),
}));
// The evidence panel opens a real xterm in the browser; its own behaviour is covered elsewhere.
vi.mock("../bottom-panel.js", () => ({ BottomPanel: () => <p>evidence panel</p> }));
vi.mock("../workspace/workspace-view.js", () => ({ WorkspaceView: () => <p>file browser</p> }));
vi.mock("../knowledge/knowledge-view.js", () => ({ KnowledgeView: () => <p>knowledge base</p> }));
vi.mock("../agent-status.js", () => ({ AgentStatus: () => <p>agent monitoring</p> }));

async function showFocus(value: TeamOwnerRead, locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}><div className="team-shell">
    <WorkspaceFocus read={value} runId={run.id} attempts={value.attempts} available replay={[]}
      onPause={() => {}} onStop={() => {}}
      evidence={{ tab: "logs", onTab: () => {}, target: null, onTarget: () => {} }} />
  </div></I18nextProvider></QueryClientProvider>);
  return language;
}

async function showScreen(locale: "en" | "zh-CN" = "en"): Promise<InterfaceI18n> {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}><div className="team-shell">
    <WorkspaceScreen runId={run.id} available={false} replay={[]}
      browse={{ state: { path: "", source: "" }, onState: () => {} }}
      knowledge={{ state: { path: "", source: "target" }, onState: () => {} }}
      evidence={{ tab: "logs", onTab: () => {}, target: null, onTarget: () => {} }} />
  </div></I18nextProvider></QueryClientProvider>);
  return language;
}

afterEach(() => { mocks.request.mockReset(); });

describe("focus helpers", () => {
  it("formats elapsed time from the run's own accounted milliseconds, and says unknown otherwise", () => {
    expect(elapsedLabel(252_000)).toBe("4m12s");
    expect(elapsedLabel(3_723_000)).toBe("1h02m");
    expect(elapsedLabel(9_000)).toBe("9s");
    expect(elapsedLabel(undefined)).toBe("—");
  });

  it("opens on the task with a running attempt, else the first published task", () => {
    const tasks = [task({ taskId: "T-101", qitemId: "q-T-101" }), task({ queueState: "in-progress" })];
    const attempts = [{ attemptId: "a", runId: run.id, taskId: "T-101", qitemId: "q-T-101", role: "implementer" as const,
      provider: "claude" as const, state: "running" as const, unknownReason: null, session: "seat-a" }];
    expect(defaultTask(tasks, attempts)?.taskId).toBe("T-101");
    expect(defaultTask(tasks, [])?.taskId).toBe("T-101");
    expect(defaultTask([], undefined)).toBeUndefined();
    expect(attemptFor(attempts, tasks[0])?.attemptId).toBe("a");
  });

  it("counts checks only from a recorded criteria row, never from zero", () => {
    const translate = (key: string, values?: Record<string, number>) => key === "overview.verified"
      ? `${values!.verified} of ${values!.total} verified` : "no record";
    expect(checksLabel(task({ criteria: { verified: 2, total: 4, source: "queue" } }), translate)).toBe("2 of 4 verified");
    expect(checksLabel(task(), translate)).toBe("no record");
    expect(checksLabel(undefined, translate)).toBe("no record");
  });
});

describe("focus screen", () => {
  it.each(["en", "zh-CN"] as const)("shows the four tabs, the identity row and the check strip (%s)", async locale => {
    const language = await showFocus(read({ tasks: [task({ queueState: "in-progress", criteria: { verified: 2, total: 4, source: "queue" } })] }), locale);
    for (const key of ["workspace.execution", "workspace.changes", "workspace.tools", "workspace.output"] as const)
      expect(screen.getByRole("tab", { name: language.t(key) })).toBeTruthy();
    const identity = screen.getByRole("region", { name: language.t("workspace.identity") });
    expect(within(identity).getByText("4m12s")).toBeTruthy();
    expect(within(identity).getByText("42K")).toBeTruthy();
    expect(within(identity).getByText(language.t("status.queue.in-progress"))).toBeTruthy();
    // The strip counts what the criteria record holds, in the interface's own wording.
    expect(screen.getByTestId("focus-checks").textContent).toMatch(/2\D+4/);
  });

  it("says the result appears when the task finishes, instead of drawing an empty diff", async () => {
    const language = await showFocus(read({ tasks: [task({ queueState: "in-progress" })] }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: language.t("workspace.changes") }), { button: 0 });
    expect((await screen.findByTestId("changes-pending")).textContent).toContain(language.t("workspace.resultPendingTitle"));
    expect(screen.queryByTestId("diff-view")).toBeNull();
    expect(screen.queryByTestId("diff-empty")).toBeNull();
  });

  it("keeps the evidence panel under Tools and the task's own lines under Output", async () => {
    const value = read({ logs: [{ source: "stream", streamItemId: "s1", ts: "2026-10-31T00:00:01.000Z", runId: run.id,
      taskId: "T-102", attemptId: null, session: "seat-a", body: "applied the filter", truncated: false, exitOutcome: null }] });
    const language = await showFocus(value);
    fireEvent.mouseDown(screen.getByRole("tab", { name: language.t("workspace.tools") }), { button: 0 });
    expect(await screen.findByText("evidence panel")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: language.t("workspace.output") }), { button: 0 });
    await waitFor(() => expect(document.querySelector(".ui-output")?.textContent).toBe("applied the filter"));
  });

  it("asks before pausing or stopping, and sends only after the confirmation", async () => {
    const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
    function Control() {
      const [action, setAction] = React.useState<"pause" | "stop" | null>(null);
      const [trigger, setTrigger] = React.useState<HTMLElement | null>(null);
      return <div className="team-shell">
        <button onClick={event => { setTrigger(event.currentTarget); setAction("pause"); }}>Pause</button>
        <button onClick={event => { setTrigger(event.currentTarget); setAction("stop"); }}>Stop</button>
        <RunControlDialog action={action} run={run} trigger={trigger} available onClose={() => setAction(null)} />
      </div>;
    }
    mocks.request.mockResolvedValue({ status: "observed", reason: null });
    render(<I18nextProvider i18n={language.instance}><Control /></I18nextProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const dialog = await screen.findByRole("dialog", { name: language.t("workspace.pauseTitle") });
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: language.t("workspace.pause") }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    const [path, init] = mocks.request.mock.calls[0]!;
    expect(path).toBe("/runs/RUN-0142/pause");
    expect(JSON.parse(init.body)).toMatchObject({ runId: "RUN-0142", expectedEntityVersion: 3, payload: {} });
    expect(await screen.findByText(language.t("team.observed"))).toBeTruthy();
    // The action is sent once; a second click cannot replay it under a new idempotency key.
    expect(within(dialog).getByRole("button", { name: language.t("workspace.pause") })).toHaveProperty("disabled", true);
  });

  it("stops through the cancel route with a reason the owner can read", async () => {
    const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
    mocks.request.mockResolvedValue({ status: "pending-execution", reason: "Termination has not been observed" });
    render(<I18nextProvider i18n={language.instance}><div className="team-shell">
      <RunControlDialog action="stop" run={run} trigger={null} available onClose={() => {}} />
    </div></I18nextProvider>);
    fireEvent.click(screen.getByRole("button", { name: language.t("workspace.stop") }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    expect(mocks.request.mock.calls[0]![0]).toBe("/runs/RUN-0142/cancel");
    expect(JSON.parse(mocks.request.mock.calls[0]![1].body).payload).toEqual({ reason: language.t("workspace.stopReason") });
    expect(await screen.findByText(language.t("team.requested"))).toBeTruthy();
  });
});

describe("workspace frame", () => {
  it.each(["en", "zh-CN"] as const)("offers Focus, Split and Grid with only Focus enabled (%s)", async locale => {
    const language = await showScreen(locale);
    const group = screen.getByRole("group", { name: language.t("workspace.layout") });
    const [grid, split, focus] = [...group.querySelectorAll("button")];
    expect([grid!.textContent, split!.textContent, focus!.textContent]).toEqual([
      language.t("workspace.grid"), language.t("workspace.split"), language.t("workspace.focus")]);
    expect([grid!.disabled, split!.disabled, focus!.disabled]).toEqual([true, true, false]);
    expect(focus!.getAttribute("aria-pressed")).toBe("true");
    // The disabled pair says why, so a dead control is never mistaken for a broken one.
    expect(group.textContent).toContain(language.t("workspace.later"));
  });

  it("keeps the file browser, knowledge and agent monitoring reachable as sub-views", async () => {
    const language = await showScreen();
    const nav = screen.getByRole("navigation", { name: language.t("workspace.views") });
    expect([...nav.querySelectorAll("button")].map(button => button.getAttribute("aria-pressed")))
      .toEqual(WORKSPACE_VIEWS.map(name => String(name === "focus")));
    for (const [view, text] of [["browse", "file browser"], ["knowledge", "knowledge base"], ["agents", "agent monitoring"]] as const) {
      fireEvent.click(within(nav).getByRole("button", { name: language.t(`workspace.view.${view}`) }));
      expect(await screen.findByText(text)).toBeTruthy();
    }
    fireEvent.click(within(nav).getByRole("button", { name: language.t("workspace.view.focus") }));
    expect(await screen.findByTestId("focus-checks")).toBeTruthy();
  });
});
