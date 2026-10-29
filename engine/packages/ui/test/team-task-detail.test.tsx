import React, { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { createInterfaceI18n, type InterfaceLanguage } from "@openrig/i18n";
import type { TeamLogRecord, TeamReviewView } from "@openrig/daemon/team-control";
import { I18nextProvider } from "react-i18next";
import { TaskDetail } from "../src/team/task-detail.js";
import { Logs } from "../src/team/logs.js";
import { ReviewDecisions } from "../src/team/review-decisions.js";

const task: TeamReviewView = { taskId: "T020", qitemId: "qitem", role: "implementer", queueState: "done",
  criteria: { verified: 3, total: 4, source: "criteria-evidence" }, currentCandidateDigest: "<script>candidate</script>",
  rounds: 2, openP0P1: 0, reviewAvailable: true,
  acceptance: { manifestDigest: "manifest-digest", passed: true, reason: "<img src=x onerror=alert(1)>", recordedAt: "2026-10-29T00:00:00Z" } };
function Detail() { const [tab, setTab] = useState("details"); return <TaskDetail tab={tab} onTab={setTab} task={task} />; }

it.each<InterfaceLanguage>(["en", "zh-CN"])("shows only published task evidence and leaves rich fields unavailable in %s", async locale => {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } }); const t = language.instance.t.bind(language.instance);
  render(<I18nextProvider i18n={language.instance}><Detail /></I18nextProvider>);
  expect(screen.getByText(/3\/4/)).toBeTruthy(); expect(document.querySelector("script")).toBeNull();
  for (const key of ["web.description", "web.criteria", "web.dependencies", "web.owners", "web.timestamps"] as const)
    expect(screen.getByText(t(key)).nextElementSibling?.textContent).toBe(t("value.unavailable"));
  expect(screen.getByText("criteria-evidence")).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: t("web.tests") }), { button: 0, ctrlKey: false });
  expect(screen.getByText("manifest-digest")).toBeTruthy(); expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText(task.acceptance!.reason)).toBeTruthy();
  for (const key of ["web.discussion", "web.changes"] as const) {
    fireEvent.mouseDown(screen.getByRole("tab", { name: t(key) }), { button: 0, ctrlKey: false });
    expect(within(screen.getByRole("tabpanel")).getByText(t("value.unavailable"))).toBeTruthy();
  }
});

it("filters run-published logs by both task and attempt without interpreting agent content", async () => {
  const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
  const log = (taskId: string, attemptId: string, body: string): TeamLogRecord => ({ source: "stream", streamItemId: attemptId, ts: "2026-10-29",
    runId: "run", taskId, attemptId, session: "session", body, truncated: true, exitOutcome: null });
  const logs = [log("T020", "a1", "<img src=x onerror=alert(1)>"), log("T020", "a2", "second attempt"), log("OTHER", "a3", "different task")];
  render(<I18nextProvider i18n={language.instance}><Logs read={{ tasks: [task], logs }} /></I18nextProvider>);
  expect(document.querySelector("img")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Task ID" }), { target: { value: "T020" } });
  expect(screen.queryByText("different task")).toBeNull(); expect(screen.getByText("second attempt")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Attempt" }), { target: { value: "a1" } });
  expect(screen.queryByText("second attempt")).toBeNull(); expect(screen.getByText(logs[0]!.body)).toBeTruthy();
});

it("keeps a missing review unavailable rather than presenting zero findings as a passing review", async () => {
  const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
  render(<I18nextProvider i18n={language.instance}><ReviewDecisions tasks={[{ ...task, reviewAvailable: false }]} /></I18nextProvider>);
  expect(screen.getByText("Unavailable")).toBeTruthy(); expect(screen.queryByText(/Open P0\/P1/)).toBeNull();
});
