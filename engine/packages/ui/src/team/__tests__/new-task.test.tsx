import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { StartRunForm } from "../new-task.js";
import type { TeamSummary } from "../hooks.js";

const request = vi.fn(async (path: string, _init?: RequestInit) => path === "/workflows"
  ? { workflows: [] } : { runId: "3f2b0c9e-0d1a-4c5b-8f2e-1a2b3c4d5e6f" });

vi.mock("../../hooks/useOwnerSession.js", () => ({
  OwnerReadError: class OwnerReadError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
  },
  useOwnerSession: () => ({ paired: true, request, pair: vi.fn(), revoke: vi.fn(), openTerminal: vi.fn(), terminalAvailable: false }),
  OwnerSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const withLead: TeamSummary[] = [
  { id: "rig-01M6P2CGXVE037YT9C19K76PWK", name: "Text utils", repository: "/src/text-utils",
    seats: [{ role: "lead", client: "claude-code" }, { role: "implementer", client: "codex" }] },
];
const withoutLead: TeamSummary[] = [
  { id: "rig-01M6PCBFR46AZS672KPX5Z38ZM", name: "Site", repository: "/src/site",
    seats: [{ role: "implementer", client: "claude-code" }, { role: "reviewer", client: "codex" }] },
];

async function show(teams: TeamSummary[], presetTeamId?: string, locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const started = vi.fn();
  render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <StartRunForm teams={teams} presetTeamId={presetTeamId} onStarted={started} />
  </I18nextProvider></QueryClientProvider>);
  return { started };
}

async function start(goal: string, planning = false) {
  fireEvent.change(screen.getByLabelText("What should the team do?"), { target: { value: goal } });
  fireEvent.click(screen.getByRole("button", { name: planning ? "Start planning" : "Start task" }));
  await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/runs")).toBe(true));
  const [path, init] = request.mock.calls.find(([path]) => path === "/runs") as [string, RequestInit];
  expect(path).toBe("/runs");
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("new task", () => {
  beforeEach(() => request.mockClear());

  it("starts a planning run when the team has a lead, so the lead drafts the plan", async () => {
    const { started } = await show(withLead);
    const body = await start("Add the status filter", true);
    expect(body).toEqual({ goal: "Add the status filter", rig: withLead[0]!.id, planning: true, documentWorkflow: true, responseLanguage: "en" });
    await waitFor(() => expect(started).toHaveBeenCalledWith("3f2b0c9e-0d1a-4c5b-8f2e-1a2b3c4d5e6f"));
  });

  it("keeps the direct start for a team with no lead seat", async () => {
    await show(withoutLead);
    const body = await start("Ship the site");
    expect(body).toEqual({ goal: "Ship the site", rig: withoutLead[0]!.id, responseLanguage: "en" });
    expect(body).not.toHaveProperty("planning");
  });

  it("sends the selected Chinese reply language without altering the goal", async () => {
    await show(withLead, undefined, "zh-CN");
    const goal = "Read the product documents";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: goal } });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/runs")).toBe(true));
    const [, init] = request.mock.calls.find(([path]) => path === "/runs") as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ goal, responseLanguage: "zh-CN" });
  });

  it("presets the team the owner chose", async () => {
    await show([...withLead, ...withoutLead], withoutLead[0]!.id);
    const select = screen.getByLabelText("Projects") as HTMLSelectElement;
    expect(select.value).toBe(withoutLead[0]!.id);
    const body = await start("Ship the site");
    expect(body.rig).toBe(withoutLead[0]!.id);
  });

  it("keeps the start button closed until there is a goal", async () => {
    await show(withLead);
    expect((screen.getByRole("button", { name: "Start planning" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
