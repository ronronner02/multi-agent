import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead, TeamTaskStage } from "@openrig/daemon/team-control";
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
        findings: 2, blocking: 1, recordedAt: "2026-11-01T00:00:00Z" }] });
    const snapshot = read({ tasks: [primary, task({ taskId: "dependency", displayName: "Dependency task" })],
      attempts: [attempt({ state: "running" })], logs: [{ source: "task-outcome", streamItemId: null,
        ts: "2026-11-01T00:00:00Z", runId: "run-private-id", taskId: primary.taskId, attemptId: null,
        session: null, body: "task-1 recorded a report", truncated: false, exitOutcome: null }] });
    const view = await show(snapshot);
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
    expect(screen.getByRole("region", { name: "等待负责人" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "等待你处理" })).toBeTruthy();
    expect(screen.getByText("审查：Status filter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(onNewTask).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/tasks\.|overview\.|progress\./);
  });
});
