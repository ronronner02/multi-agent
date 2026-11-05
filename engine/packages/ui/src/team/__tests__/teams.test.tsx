import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { TeamsScreen } from "../teams-screen.js";
import type { RunSummary, TeamSummary } from "../hooks.js";

vi.mock("../../hooks/useOwnerSession.js", () => ({
  OwnerReadError: class OwnerReadError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
  },
  useOwnerSession: () => ({ paired: true, request: vi.fn(), pair: vi.fn(), revoke: vi.fn(), openTerminal: vi.fn(), terminalAvailable: false }),
  OwnerSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const teams: TeamSummary[] = [
  { id: "01M6PCBFR46AZS672KPX5Z38ZM", name: "text-utils", repository: "/src/text-utils",
    seats: [{ role: "lead", client: "claude-code" }, { role: "implementer", client: "codex" }, { role: "reviewer", client: "codex" }] },
];
const runs: RunSummary[] = [
  { id: "3f2b0c9e-0d1a-4c5b-8f2e-1a2b3c4d5e6f", rigId: "01M6PCBFR46AZS672KPX5Z38ZM", rigName: "text-utils",
    state: "approved", planRef: "plan.md", displayName: "Add slugify", createdAt: "2026-10-31T00:00:00.000Z" },
];

async function show(locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  const opened = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <TeamsScreen teams={teams} runs={runs} loading={false} onOpenTeam={opened} />
  </I18nextProvider></QueryClientProvider>);
  return opened;
}

describe("teams", () => {
  it("names the team, its repository and its seats, and shows the run's state", async () => {
    await show();
    expect(screen.getByRole("heading", { name: "Teams" })).toBeTruthy();
    expect(screen.getByText("text-utils")).toBeTruthy();
    expect(screen.getByText("/src/text-utils")).toBeTruthy();
    expect(screen.getByText("Lead · Claude Code")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(document.body.textContent ?? "").not.toMatch(/01M6PC/);
  });

  it("opens the team's run when the row is chosen", async () => {
    const opened = await show();
    fireEvent.click(screen.getByText("text-utils"));
    expect(opened).toHaveBeenCalledWith("01M6PCBFR46AZS672KPX5Z38ZM");
  });

  it("opens the create sheet with one seat per role", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    expect(await screen.findByLabelText("Repository")).toBeTruthy();
    expect(screen.getAllByRole("combobox").length).toBe(6);
    expect(screen.getByRole("button", { name: "Create team" })).toBeTruthy();
  });
});