import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { ProjectHome } from "../project-home.js";
import { TextPreview } from "../text-preview.js";
import type { RunSummary } from "../hooks.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("separates discussions, executions and recorded results without treating approval as completion", async () => {
  const language = await createInterfaceI18n({ language: "en" }), onOpenRun = vi.fn();
  const base = { rigId: "project", rigName: "Fixture", state: "approved" as const, planRef: "plan.md", createdAt: "2026-11-08" };
  const runs: RunSummary[] = [
    { ...base, id: "discussion", displayName: "Scope discussion", phase: "planning", messageCount: 3, executionTaskCount: 0, resultCount: 0 },
    { ...base, id: "work", displayName: "Ongoing work", phase: "delivery", resultCount: 0 },
    { ...base, id: "result", displayName: "Earlier result", phase: "delivery", resultCount: 2 },
  ];
  render(<I18nextProvider i18n={language.instance}><ProjectHome team={{ id: "project", name: "Fixture", repository: "/fixture", kind: "test", seats: [] }}
    runs={runs} section="overview" onOpenRun={onOpenRun} onDiscuss={() => {}} onModels={() => {}} /></I18nextProvider>);
  expect(screen.getByText("Test project")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Planning records" })).getByText("Scope discussion")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Execution records" })).queryByText("Scope discussion")).toBeNull();
  const results = screen.getByRole("region", { name: "Recorded results" });
  expect(within(results).queryByText("Ongoing work")).toBeNull();
  fireEvent.click(within(results).getByRole("button", { name: /Earlier result/ }));
  expect(onOpenRun).toHaveBeenCalledWith("result", "reviews");
});
it("does not describe recorded executions as an empty task history", async () => {
  const language = await createInterfaceI18n({ language: "en" });
  render(<I18nextProvider i18n={language.instance}><ProjectHome team={{ id: "project", name: "Fixture", repository: "/fixture", seats: [] }}
    runs={[{ id: "work", rigId: "project", rigName: "Fixture", displayName: "Ongoing work", state: "approved", phase: "delivery", planRef: "plan.md", createdAt: "2026-11-08", executionTaskCount: 2 }]}
    section="tasks" onOpenRun={() => {}} onDiscuss={() => {}} onModels={() => {}} /></I18nextProvider>);
  expect(screen.queryByText("No execution tasks yet. Approve a plan before implementation starts.")).toBeNull();
  expect(screen.getByText("Choose an execution record to view its tasks.")).toBeTruthy();
});

it("preserves long project names and paths in accessible disclosures", async () => {
  const language = await createInterfaceI18n({ language: "en" });
  const name = "A project with extended planning context. ".repeat(15).trim();
  const repository = "/workspace/" + "very-long-repository-segment/".repeat(20);
  render(<I18nextProvider i18n={language.instance}><ProjectHome team={{ id: "project", name, repository, seats: [] }}
    runs={[]} section="overview" onOpenRun={() => {}} onDiscuss={() => {}} onModels={() => {}} /></I18nextProvider>);
  expect(screen.getByRole("heading", { name, level: 1 })).toBeTruthy();
  const toggles = screen.getAllByRole("button", { name: "Show more" });
  expect(toggles).toHaveLength(2);
  for (const [index, toggle] of toggles.entries()) {
    const body = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(body?.textContent).toBe([name, repository][index]);
    fireEvent.click(toggle);
    expect(body?.tabIndex).toBe(0);
  }
  expect(screen.getAllByRole("button", { name: "Show less" })).toHaveLength(2);
});

it("detects rendered overflow below the character cutoff and remeasures when resized", async () => {
  const language = await createInterfaceI18n({ language: "en" });
  const text = "项目规划与执行".repeat(20);
  let scrollHeight = 340;
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(64);
  let resized = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {} disconnect() {}
  });
  render(<I18nextProvider i18n={language.instance}><TextPreview text={text} /></I18nextProvider>);
  const toggle = screen.getByRole("button", { name: "Show more" });
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.textContent).toBe(text);
  scrollHeight = 40; act(() => resized());
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  scrollHeight = 340; act(() => resized());
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  act(() => resized());
  expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
});
