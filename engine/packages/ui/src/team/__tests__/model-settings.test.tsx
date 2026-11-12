import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { ModelSettings } from "../model-settings.js";

const request = vi.fn();
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../hooks/useOwnerSession.js")>(),
  useOwnerSession: () => ({ paired: true, request }),
}));
let cache: QueryClient;
const saved = () => ({ teamId: "fixture-team", kind: "project", configured: true,
  lead: { client: "claude-code", model: "saved-claude" },
  allowedSubagents: [{ client: "codex", model: "saved-codex" }], launches: [] });
const choices = [{ client: "codex", model: "discovered-codex" }, { client: "claude-code", model: "discovered-claude" }];
const optionsFor = (label: string) => {
  const list = screen.getByLabelText(label).getAttribute("list")!;
  return [...document.getElementById(list)!.querySelectorAll("option")].map(option => option.value);
};
beforeEach(() => { vi.clearAllMocks(); cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { cleanup(); cache.clear(); });
async function show() {
  const language = await createInterfaceI18n({ language: "en" });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    <ModelSettings teamId="fixture-team" />
  </I18nextProvider></QueryClientProvider>);
  await screen.findByLabelText("Lead model");
}

describe("native model suggestions", () => {
  it("offers discovered and saved choices for the selected client on every model input", async () => {
    request.mockResolvedValue({ settings: saved(), modelChoices: choices });
    await show();
    expect(optionsFor("Lead model")).toEqual(["discovered-claude", "saved-claude"]);
    expect(optionsFor("Subagent model 1")).toEqual(["discovered-codex", "saved-codex"]);
    fireEvent.change(screen.getByLabelText("Lead client"), { target: { value: "codex" } });
    expect(optionsFor("Lead model")).toEqual(["discovered-codex", "saved-codex"]);
    fireEvent.change(screen.getByLabelText("Subagent client 1"), { target: { value: "claude-code" } });
    expect(optionsFor("Subagent model 1")).toEqual(["discovered-claude", "saved-claude"]);
  });

  it("preserves custom typed models and discovered suggestions after a successful save", async () => {
    let settings = saved();
    request.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") { settings = { ...settings, ...JSON.parse(String(init.body)) }; return { settings }; }
      return { settings, modelChoices: choices };
    });
    await show();
    fireEvent.change(screen.getByLabelText("Lead model"), { target: { value: "custom-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model settings" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/teams/fixture-team/settings", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ lead: { client: "claude-code", model: "custom-model" },
        allowedSubagents: [{ client: "codex", model: "saved-codex" }], kind: "project" }),
    })));
    await waitFor(() => expect((screen.getByLabelText("Lead model") as HTMLInputElement).disabled).toBe(false));
    expect(optionsFor("Lead model")).toContain("discovered-claude");
  });

  it("retains saved suggestions with an older server that omits discovery", async () => {
    request.mockResolvedValue({ settings: saved() });
    await show();
    expect(optionsFor("Lead model")).toEqual(["saved-claude"]);
    expect(optionsFor("Subagent model 1")).toEqual(["saved-codex"]);
  });
});
