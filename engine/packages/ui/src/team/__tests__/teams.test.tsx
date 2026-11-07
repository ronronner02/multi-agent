import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { TeamsScreen } from "../teams-screen.js";
import type { RunSummary, TeamSummary } from "../hooks.js";

const request = vi.hoisted(() => vi.fn());
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

vi.mock("../../hooks/useOwnerSession.js", () => ({
  OwnerReadError: class OwnerReadError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
  },
  useOwnerSession: () => ({ paired: true, request, pair: vi.fn(), revoke: vi.fn(), openTerminal: vi.fn(), terminalAvailable: false }),
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
  const openedRun = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <TeamsScreen teams={teams} runs={runs} loading={false} onOpenTeam={opened} onOpenRun={openedRun} />
  </I18nextProvider></QueryClientProvider>);
  return { opened, openedRun };
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
    const { opened } = await show();
    fireEvent.click(screen.getByText("text-utils"));
    expect(opened).toHaveBeenCalledWith("01M6PCBFR46AZS672KPX5Z38ZM");
  });

  it("offers new work per team, preset to that team, even when it already has a run", async () => {
    const { opened, openedRun } = await show();
    expect(screen.getAllByRole("button", { name: "New work" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "New work" }));
    expect(await screen.findByLabelText("What should the team do?")).toBeTruthy();
    expect((screen.getByLabelText("Teams") as HTMLSelectElement).value).toBe(teams[0]!.id);
    expect(opened).not.toHaveBeenCalled();
    expect(openedRun).not.toHaveBeenCalled();
  });

  it("opens the create sheet with one seat per role", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    expect(await screen.findByLabelText("Repository")).toBeTruthy();
    expect(screen.getAllByRole("combobox").length).toBe(6);
    expect(screen.getByRole("button", { name: "Create team" })).toBeTruthy();
  });
});

describe("desktop folder selection", () => {
  it("keeps manual entry without a desktop picker", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    expect(await screen.findByLabelText("Repository")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Browse\u2026" })).toBeNull();
  });

  it("puts the selected folder in the unchanged team request", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/mnt/d/Client Work/fixture");
    vi.stubGlobal("multiAgentDesktop", { pickFolder });
    request.mockResolvedValue({});
    await show();
    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    fireEvent.click(await screen.findByRole("button", { name: "Browse\u2026" }));
    await waitFor(() => expect((screen.getByLabelText("Repository") as HTMLInputElement).value).toBe("/mnt/d/Client Work/fixture"));
    expect(pickFolder).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    const [route, init] = request.mock.calls[0]!;
    expect(route).toBe("/teams");
    expect(JSON.parse(init.body)).toEqual({ repository: "/mnt/d/Client Work/fixture", seats: [
      { role: "lead", client: "claude-code" }, { role: "implementer", client: "claude-code" },
      { role: "reviewer", client: "codex" },
    ] });
  });

  it("preserves an entered path on native cancellation and blocks duplicate picks", async () => {
    let finish!: (value: null) => void;
    const pickFolder = vi.fn(() => new Promise<null>(resolve => { finish = resolve; }));
    vi.stubGlobal("multiAgentDesktop", { pickFolder });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "/home/dev/original" } });
    const browse = screen.getByRole("button", { name: "Browse\u2026" });
    fireEvent.click(browse);
    expect((browse as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create team" }) as HTMLButtonElement).disabled).toBe(true);
    finish(null);
    await waitFor(() => expect((browse as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText("Repository") as HTMLInputElement).value).toBe("/home/dev/original");
    expect(request).not.toHaveBeenCalled();
  });

  it("shows a selection error without submitting or losing the existing path", async () => {
    vi.stubGlobal("multiAgentDesktop", { pickFolder: vi.fn().mockRejectedValue(new Error("unsupported distro")) });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "/home/dev/original" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse\u2026" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Folder selection did not finish");
    expect((screen.getByLabelText("Repository") as HTMLInputElement).value).toBe("/home/dev/original");
    expect(request).not.toHaveBeenCalled();
  });
});
