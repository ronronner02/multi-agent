import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { StartRunForm } from "../new-task.js";
import type { TeamSummary } from "../hooks.js";

const request = vi.fn(async () => ({ runId: "3f2b0c9e-0d1a-4c5b-8f2e-1a2b3c4d5e6f" }));

vi.mock("../../hooks/useOwnerSession.js", () => ({
  OwnerReadError: class OwnerReadError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
  },
  useOwnerSession: () => ({ paired: true, request, pair: vi.fn(), revoke: vi.fn(), openTerminal: vi.fn(), terminalAvailable: false }),
  OwnerSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const teams: TeamSummary[] = [
  { id: "rig-01M6P2CGXVE037YT9C19K76PWK", name: "Text utils", repository: "/src/text-utils",
    seats: [{ role: "lead", client: "claude-code" }, { role: "implementer", client: "codex" }] },
];

async function show() {
  const language = await createInterfaceI18n({ language: "en" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const started = vi.fn();
  render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <StartRunForm teams={teams} onStarted={started} />
  </I18nextProvider></QueryClientProvider>);
  return { started };
}

describe("new task", () => {
  it("starts a run with the goal and the chosen team", async () => {
    const { started } = await show();
    fireEvent.change(screen.getByLabelText("What should the team do?"), { target: { value: "Add the status filter" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/runs");
    expect(JSON.parse(String(init.body))).toEqual({ goal: "Add the status filter", rig: teams[0]!.id });
    await waitFor(() => expect(started).toHaveBeenCalledWith("3f2b0c9e-0d1a-4c5b-8f2e-1a2b3c4d5e6f"));
  });

  it("keeps the start button closed until there is a goal", async () => {
    await show();
    expect((screen.getByRole("button", { name: "Start task" }) as HTMLButtonElement).disabled).toBe(true);
  });
});