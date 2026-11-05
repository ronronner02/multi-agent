import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { RunHome } from "../run-home.js";
import { attempt, read, reviewTask, RUN_ID, task } from "./fixtures.js";

vi.mock("../../hooks/useOwnerSession.js", () => ({
  OwnerReadError: class OwnerReadError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
  },
  useOwnerSession: () => ({ paired: true, request: vi.fn(), pair: vi.fn(), revoke: vi.fn(), openTerminal: vi.fn(), terminalAvailable: false }),
  OwnerSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

/** Neither the chat nor the branch surface is on this branch; the screen must still be whole. */
vi.mock("../hooks.js", () => ({
  useTeamChat: () => ({ data: { available: false, messages: [], phase: "delivery" }, isPending: false }),
  useBranch: () => ({ data: { available: false, branch: "", base: "main", commits: [] }, isPending: false }),
}));

async function show(ui: React.ReactElement, locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  return render(<I18nextProvider i18n={language.instance}>{ui}</I18nextProvider>);
}

const noop = () => {};

describe("run home", () => {
  it("names every task and never renders a task id or a run UUID", async () => {
    const tasks = [task(), reviewTask(), task({ taskId: "task-9", displayName: "Filter chips", queueState: "in-progress" })];
    await show(<RunHome read={read({ tasks })} runId={RUN_ID} available now={Date.now()} onOpenTask={noop} onOpenBranch={noop} />);

    expect(screen.getAllByText("Status filter").length).toBeGreaterThan(0);
    expect(screen.getByText("Review: Status filter")).toBeTruthy();
    expect(screen.getAllByText("Filter chips").length).toBeGreaterThan(0);

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    expect(text).not.toMatch(/task-\d+/);
    expect(text).not.toContain("qitem-");
  });

  it("localises a reviewer task's name instead of showing the stored English one", async () => {
    await show(<RunHome read={read({ tasks: [reviewTask()] })} runId={RUN_ID} available now={Date.now()} onOpenTask={noop} onOpenBranch={noop} />, "zh-CN");
    expect(screen.getByText("审查：Status filter")).toBeTruthy();
    expect(screen.queryByText("Review: Status filter")).toBeNull();
  });

  it("maps queue states to the five words the line uses", async () => {
    const tasks = [
      task({ taskId: "task-1", displayName: "Queued one", queueState: "pending" }),
      task({ taskId: "task-2", displayName: "Running one", queueState: "in-progress" }),
      reviewTask("Running one"),
      task({ taskId: "task-4", displayName: "Broken one", queueState: "blocked" }),
      task({ taskId: "task-5", displayName: "Finished one", queueState: "done" }),
    ];
    await show(<RunHome read={read({ tasks })} runId={RUN_ID} available now={Date.now()} onOpenTask={noop} onOpenBranch={noop} />);
    expect(screen.getAllByText("Queued").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getAllByText("In review").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Blocked").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
  });

  it("keeps the merge disabled until every task is finished", async () => {
    const open = [task(), task({ taskId: "task-2", displayName: "Second", queueState: "in-progress" })];
    const view = await show(<RunHome read={read({ tasks: open })} runId={RUN_ID} available now={Date.now()} onOpenTask={noop} onOpenBranch={noop} />);
    const merge = view.container.querySelector(".merge")!;
    expect(merge.getAttribute("data-ready")).toBe("false");
    expect((within(merge as HTMLElement).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);

    view.unmount();
    await show(<RunHome read={read({ tasks: [task()] })} runId={RUN_ID} available now={Date.now()} onOpenTask={noop} onOpenBranch={noop} />);
    // Every task is finished, but U7's branch surface is absent, so the action stays closed.
    const after = document.querySelector(".merge")!;
    expect(after.getAttribute("data-ready")).toBe("false");
    expect((within(after as HTMLElement).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    expect(after.textContent).toContain("Merge is not available yet");
  });

  it("says how many tasks are left while the line is unfinished", async () => {
    const tasks = [task({ taskId: "task-1", displayName: "One", queueState: "done" }),
      task({ taskId: "task-2", displayName: "Two", queueState: "pending" })];
    await show(<RunHome read={read({ tasks })} runId={RUN_ID} available now={Date.now()} onOpenTask={noop} onOpenBranch={noop} />);
    expect(screen.getByText("1 left")).toBeTruthy();
  });
});