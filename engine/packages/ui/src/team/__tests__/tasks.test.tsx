import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead, TeamTaskStage } from "@multi-agent/daemon/team-control";
import { TasksScreen, groupTasks } from "../tasks.js";
import { attempt, read, reviewTask, task } from "./fixtures.js";

afterEach(cleanup);
async function show(snapshot: TeamOwnerRead, locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  const onNewTask = vi.fn();
  function Board() {
    const [selected, setSelected] = useState("");
    return <TasksScreen read={snapshot} selectedTaskId={selected} onSelect={setSelected} onNewTask={onNewTask} />;
  }
  return { ...render(<I18nextProvider i18n={language.instance}><Board /></I18nextProvider>), onNewTask };
}

describe("Tasks board and drawer", () => {
  it("groups only the published stage and keeps each count equal to its list", async () => {
    const stages: TeamTaskStage[] = ["queued", "running", "review", "lead/report", "owner/decision", "owner/blocked", "done"];
    const tasks = stages.map((stage, index) => task({ taskId: "fixture-" + index, displayName: "Work " + index, stage, queueState: "done" }));
    expect(groupTasks(tasks)["owner/decision"]).toHaveLength(2);
    await show(read({ tasks }));
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    for (const name of ["Queued", "Running", "Review", "Waiting on lead", "Waiting on you", "Done"]) {
      const region = screen.getByRole("region", { name });
      const items = within(region).getAllByRole("listitem");
      expect(region.querySelector(".ui-count")?.textContent).toBe(String(items.length));
    }
    expect(within(screen.getByRole("region", { name: "Waiting on lead" })).getByText("Work 3")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Waiting on you" })).queryByText("Work 3")).toBeNull();
    expect(document.body.textContent).not.toMatch(/fixture-\d|qitem-|task-1|3f2b0c9e/);
  });

  it("opens exact-seat evidence, dependencies, reports, attempts, verdicts and timeline with keyboard close", async () => {
    const primary = task({ stage: "lead/report", seat: "review@rig", dependencies: ["dependency", "missing-private-id"],
      workerReport: { status: "needs-decision", question: "Which behavior is intended?", evidence: "Use the supplied trace.",
        truncated: false, attemptId: "attempt-private-id", resolution: null },
      verdicts: [{ round: 1, reviewerTaskId: "review-private-id", verdict: "changes-required", candidateDigest: null,
        findings: 2, findingRecords: [
          { id: "finding-1", severity: "P1", file: "src/filter.ts", summary: "An empty selection hides every result." },
          { id: "finding-2", severity: "P3", file: "src/filter.ts", summary: "Clarify the label." },
        ], blocking: 1, recordedAt: "2026-11-01T00:00:00Z" }] });
    const snapshot = read({ tasks: [primary, task({ taskId: "dependency", displayName: "Dependency task" })],
      attempts: [attempt({ state: "running" })], logs: [{ source: "task-outcome", streamItemId: null,
        ts: "2026-11-01T00:00:00Z", runId: "run-private-id", taskId: primary.taskId, attemptId: null,
        session: null, body: "task-1 recorded a report", truncated: false, exitOutcome: null }] });
    const view = await show(snapshot);
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    const card = screen.getByRole("button", { name: /Status filter/ });
    fireEvent.click(card);
    const drawer = screen.getByRole("dialog", { name: "Status filter" });
    expect(within(drawer).getByText("Reviewer · Claude Code")).toBeTruthy();
    expect(within(drawer).getByText("Dependency task")).toBeTruthy();
    expect(within(drawer).getByText("Which behavior is intended?")).toBeTruthy();
    expect(within(drawer).getByText("Running")).toBeTruthy();
    expect(within(drawer).getByRole("heading", { name: "Timeline" })).toBeTruthy();
    expect(within(drawer).getByRole("heading", { name: "Review" })).toBeTruthy();
    for (const element of view.container.querySelectorAll("*")) {
      if (element.children.length === 0 && /qitem-|task-1|missing-private-id|6b1f9a02/.test(element.textContent ?? "")) {
        expect(element.closest("details")).not.toBeNull();
      }
    }
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it("reuses the existing new-task entry and localises board stages and review names", async () => {
    const { onNewTask } = await show(read({ tasks: [reviewTask()] }), "zh-CN");
    fireEvent.click(screen.getByRole("button", { name: "\u770b\u677f" }));
    expect(screen.getByRole("region", { name: "等待负责人" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "等待你处理" })).toBeTruthy();
    expect(screen.getByText("审查：Status filter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(onNewTask).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/tasks\.|overview\.|progress\./);
  });
});


describe("Tasks list and inspector", () => {
  it("shows the real brief, declared criteria and distinct task-worktree and integration identities", async () => {
    await show(read({ tasks: [task({
      description: { body: "Implement literal <button> text safely.", truncated: false },
      declaredAcceptanceCriteria: { body: "- Enter filters the list.\n- Empty input restores it.", truncated: false },
      workspace: { root: "/fixture/tasks/search", sourceRoot: "/fixture/integration", baseCommit: "a".repeat(40) },
      integrationBranch: "team/search-delivery",
    })] }));
    const inspector = screen.getByRole("region", { name: "Task detail" });
    expect(within(inspector).getByText("Implement literal <button> text safely.")).toBeTruthy();
    expect(within(inspector).getByRole("heading", { name: "Declared acceptance criteria" })).toBeTruthy();
    expect(within(inspector).getByText(/Enter filters the list/)).toBeTruthy();
    expect(within(inspector).getByText("/fixture/tasks/search")).toBeTruthy();
    expect(within(inspector).getByText("team/search-delivery")).toBeTruthy();
    expect(within(inspector).queryByRole("checkbox")).toBeNull();
  });

  it("keeps the full long brief behind a keyboard-operable disclosure and resets it for another task", async () => {
    const body = "Explain the integration evidence and retained document version. ".repeat(30);
    await show(read({ tasks: [task({ description: { body, truncated: false } }),
      task({ taskId: "second", displayName: "Second task", description: { body: body + "Second.", truncated: false } })] }));
    const inspector = screen.getByRole("region", { name: "Task detail" });
    const more = within(inspector).getByRole("button", { name: "Show more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    const text = document.getElementById(more.getAttribute("aria-controls")!);
    expect(text?.textContent).toBe(body);
    fireEvent.click(more);
    expect(within(inspector).getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    expect(text?.textContent).toBe(body);
    fireEvent.click(screen.getByRole("button", { name: /Second task/ }));
    expect(within(inspector).getByRole("button", { name: "Show more" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps older reads compatible and does not invent requirements or a workspace", async () => {
    await show(read({ tasks: [task()] }));
    const inspector = screen.getByRole("region", { name: "Task detail" });
    expect(within(inspector).getByText("No separate acceptance criteria recorded")).toBeTruthy();
    expect(within(inspector).getByText("Task workspace not available")).toBeTruthy();
    expect(within(inspector).queryByRole("checkbox")).toBeNull();
  });

  it("defaults to a persistent inspector with search and published-stage filtering", async () => {
    await show(read({ tasks: [task({ taskId: "alpha", displayName: "Search interface", stage: "running", queueState: "done" }),
      task({ taskId: "beta", displayName: "Keyboard access", stage: "queued", queueState: "in-progress" })] }));
    const list = screen.getByRole("region", { name: "Task list" });
    const inspector = screen.getByRole("region", { name: "Task detail" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(inspector).getByRole("heading", { name: "Search interface" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "keyboard" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(inspector).getByRole("heading", { name: "Keyboard access" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Task status" }), { target: { value: "running" } });
    expect(within(list).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Task detail" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Search interface")).toBeTruthy();
  });

  it("keeps selection non-modal and preserves the board and its keyboard-close drawer", async () => {
    await show(read({ tasks: [task(), task({ taskId: "second", displayName: "Second task" })] }));
    const second = screen.getByRole("button", { name: /Second task/ });
    second.focus(); fireEvent.click(second);
    expect(document.activeElement).toBe(second);
    expect(within(screen.getByRole("region", { name: "Task detail" })).getByRole("heading", { name: "Second task" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    const card = screen.getByRole("button", { name: /Second task/ });
    fireEvent.click(card);
    const dialog = screen.getByRole("dialog", { name: "Second task" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card));
  });
});
