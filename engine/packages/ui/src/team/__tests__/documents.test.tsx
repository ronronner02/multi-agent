import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createInterfaceI18n } from "@multi-agent/i18n";
import type { ProjectDocumentVersion, ProjectDocumentWorkflow } from "@multi-agent/daemon/team-control";
import { DocumentsScreen } from "../documents.js";
import { read, RUN_ID } from "./fixtures.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({ useOwnerSession: () => ({ request }) }));
const doc = (version: number, extra: Partial<ProjectDocumentVersion> = {}): ProjectDocumentVersion => ({
  id: `requirements-${version}`, kind: "requirements", version, path: "planning-docs/requirements.md", content: `# Requirements v${version}\nR1: Greet a name.`,
  hash: `sha256:${String(version).repeat(64)}`, requirementsVersionId: null, sourceAttemptId: `attempt-${version}`,
  createdAt: `2026-11-08T04:0${version}:00.000Z`, confirmedAt: null, confirmedBy: null, ...extra,
});
const workflow = (): ProjectDocumentWorkflow => ({ stage: "requirements", pendingStage: null, error: null,
  confirmed: { brainstorm: null, requirements: null, plan: null }, versions: [doc(2), doc(1)], executionVersions: null, executionHistory: [] });
afterEach(cleanup);
beforeEach(() => { request.mockReset().mockResolvedValue({}); });
async function show(state: ProjectDocumentWorkflow | null = workflow(), phase: "planning" | "delivery" = "planning", displayName = read().run.displayName) {
  const i18n = await createInterfaceI18n({ language: "en" });
  const onDiscuss = vi.fn(), onChanged = vi.fn();
  render(<I18nextProvider i18n={i18n.instance}><DocumentsScreen read={{ ...read(), run: { ...read().run, phase, displayName } }}
    chat={{ available: true, phase, messages: [], pendingDecision: null, documentWorkflow: state }}
    onDiscuss={onDiscuss} onChanged={onChanged} /></I18nextProvider>);
  return { onDiscuss, onChanged, language: i18n };
}

describe("desktop document center", () => {
  it("keeps a long record goal behind an explicit disclosure without changing document authority", async () => {
    const goal = "Detailed planning context and acceptance boundaries. ".repeat(30).trim();
    await show(workflow(), "planning", goal);
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const body = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(body?.textContent).toBe(goal);
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    expect(body?.tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Confirm v2" })).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it("shows saved documents without creating a run or launching a model", async () => {
    await show();
    expect(screen.getByRole("heading", { name: "Documents" })).toBeTruthy();
    expect(screen.getByText(/# Requirements v2/)).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Generate plan" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("compares two saved versions and never confirms a historical selection", async () => {
    await show();
    fireEvent.change(screen.getByRole("combobox", { name: "Compare with" }), { target: { value: "requirements-1" } });
    expect(screen.getByText(/# Requirements v1/)).toBeTruthy();
    expect(screen.getByText(/# Requirements v2/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Version" }), { target: { value: "requirements-1" } });
    const confirm = screen.getByRole("button", { name: "Confirm v1" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); fireEvent.click(confirm);
    expect(request).not.toHaveBeenCalled();
  });
  it("confirms only the displayed current ID and content hash without approving execution", async () => {
    const { onChanged } = await show();
    fireEvent.click(screen.getByRole("button", { name: "Confirm v2" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/documents/confirm`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ kind: "requirements", versionId: "requirements-2", hash: doc(2).hash, responseLanguage: "en" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("starts the requested planning stage, not execution, after requirements are confirmed", async () => {
    const state = workflow(); state.confirmed.requirements = "requirements-2";
    await show(state); fireEvent.click(screen.getByRole("button", { name: "Generate plan" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/documents/stage`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ stage: "plan", responseLanguage: "en" });
  });
  it.each(["confirm", "stage", "revise", "discuss"] as const)("uses a changed interface language for the %s document action", async action => {
    const state = workflow();
    if (action === "stage") state.confirmed.requirements = "requirements-2";
    const view = await show(state, action === "revise" || action === "discuss" ? "delivery" : "planning");
    await act(async () => { await view.language.changeLanguage("zh-CN"); });
    const key = action === "confirm" ? "documents.confirmVersion" : action === "stage" ? "documents.stage.plan"
      : action === "revise" ? "documents.revise.requirements" : "documents.discuss";
    fireEvent.click(screen.getByRole("button", { name: view.language.instance.t(key, { version: 2 }) }));
    await waitFor(() => expect(action === "discuss" ? view.onDiscuss : view.onChanged).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/documents/${action === "confirm" ? "confirm" : "stage"}`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual(action === "confirm"
      ? { kind: "requirements", versionId: "requirements-2", hash: doc(2).hash, responseLanguage: "zh-CN" }
      : { stage: action === "stage" ? "plan" : "requirements", responseLanguage: "zh-CN" });
  });

  it("keeps a plan based on older requirements unconfirmable", async () => {
    const state = workflow(); state.stage = "plan"; state.confirmed.requirements = "requirements-2";
    state.versions.unshift(doc(1, { id: "plan-1", kind: "plan", path: "plan.md", content: "# Old plan", requirementsVersionId: "requirements-1" }));
    await show(state);
    expect((screen.getByRole("button", { name: "Confirm v1" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/then generate a plan/)).toBeTruthy();
  });
  it("opens a revision discussion with the selected version and suspends delivery first", async () => {
    const { onDiscuss } = await show(workflow(), "delivery");
    fireEvent.click(screen.getByRole("button", { name: "Discuss this document" }));
    await waitFor(() => expect(onDiscuss).toHaveBeenCalled());
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/documents/stage`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ stage: "requirements", responseLanguage: "en" });
    expect(onDiscuss.mock.calls[0]![1]).toContain(doc(2).hash);
    expect(onDiscuss.mock.calls[0]![1]).toContain(doc(2).content);
  });
  it("includes the selected historical snapshot and identifies the latest version separately", async () => {
    const { onDiscuss } = await show();
    fireEvent.change(screen.getByRole("combobox", { name: "Version" }), { target: { value: "requirements-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Discuss this document" }));
    const context = onDiscuss.mock.calls[0]![1];
    expect(context).toContain(doc(1).hash);
    expect(context).toContain(doc(1).content);
    expect(context).toContain(`Latest saved version: v2 (${doc(2).hash})`);
    expect(context).not.toContain(doc(2).content);
    expect(request).not.toHaveBeenCalled();
  });
  it("labels a bounded snapshot excerpt instead of silently overflowing the conversation", async () => {
    const state = workflow(); state.versions[0] = doc(2, { content: "x".repeat(70_000) });
    const { onDiscuss } = await show(state);
    fireEvent.click(screen.getByRole("button", { name: "Discuss this document" }));
    const context = onDiscuss.mock.calls[0]![1];
    expect(context.length).toBeLessThan(40_000);
    expect(context).toContain("Snapshot excerpt; the complete version remains in Documents.");
    expect(context).toContain("x".repeat(100));
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps optional brainstorm and historical-record empty states explicit", async () => {
    await show(null);
    expect(screen.getByText(/predates versioned documents/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm v/ })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
