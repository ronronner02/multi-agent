import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { PromptSectionSettings } from "../prompt-sections.js";

const { request, ReadError } = vi.hoisted(() => {
  class ReadError extends Error { constructor(readonly code: string) { super(code); } }
  return { request: vi.fn(), ReadError };
});
vi.mock("../../hooks/useOwnerSession.js", () => ({ OwnerReadError: ReadError, useOwnerSession: () => ({ paired: true, request }) }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

const view = (overrides: Record<string, unknown> = {}) => ({ revision: 2, sections: [
  { name: "communication", text: "## Communication\n\nMine.", overridden: true, defaultText: "## Communication\n\nNew default.",
    previousDefault: "## Communication\n\nOld default.", defaultChanged: true, ...overrides },
  { name: "scope", text: "## Task scope\n\nDefault scope.", overridden: false, defaultText: "## Task scope\n\nDefault scope.", previousDefault: null, defaultChanged: false },
  { name: "delivery", text: "## Delivery\n\nDefault delivery.", overridden: false, defaultText: "## Delivery\n\nDefault delivery.", previousDefault: null, defaultChanged: false },
] });

async function show() {
  const language = await createInterfaceI18n({ language: "en" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}><PromptSectionSettings teamId="team-1" /></I18nextProvider></QueryClientProvider>);
  return screen.findByRole("region", { name: "Team instructions" });
}
const puts = () => request.mock.calls.filter(([, init]) => init?.method === "PUT").map(([path, init]) => ({ path, body: JSON.parse(init.body) }));

describe("team instructions settings", () => {
  beforeEach(() => request.mockReset().mockImplementation(async (_path: string, init?: { method?: string }) => init?.method === "PUT" ? view({ defaultChanged: false, previousDefault: null }) : view()));

  it("saves only the edited section against the revision it read, from one save bar", async () => {
    const panel = await show();
    await within(panel).findByDisplayValue(/Default scope\./);
    expect(within(panel).queryByRole("button", { name: "Save instructions" })).toBeNull();
    fireEvent.change(within(panel).getByRole("textbox", { name: "Task scope" }), { target: { value: "## Task scope\n\nStop at 300 lines." } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual({ path: "/teams/team-1/prompt-sections", body: { baseRevision: 2, sections: { scope: "## Task scope\n\nStop at 300 lines." } } });
  });

  it("shows both defaults beside the owner's text when a default changed, and resolves it either way", async () => {
    const panel = await show();
    const changed = await within(panel).findByRole("group", { name: "Default updated" });
    expect(within(changed).getByText(/Old default\./)).toBeTruthy();
    expect(within(changed).getByText(/New default\./)).toBeTruthy();
    fireEvent.click(within(changed).getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.sections).toEqual({ communication: "## Communication\n\nMine." });
  });

  it("says a conflicting save must be reloaded and keeps the draft", async () => {
    request.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === "PUT") throw new ReadError("sections_revision_conflict");
      return view();
    });
    const panel = await show();
    const field = await within(panel).findByRole("textbox", { name: "Delivery requirements" });
    fireEvent.change(field, { target: { value: "## Delivery\n\nTwo reviewers." } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save instructions" }));
    expect(await within(panel).findByRole("alert")).toHaveProperty("textContent", "These instructions changed. Reload them before saving.");
    expect((within(panel).getByRole("textbox", { name: "Delivery requirements" }) as HTMLTextAreaElement).value).toBe("## Delivery\n\nTwo reviewers.");
  });
});
