import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { IntakeSettings } from "../intake-settings.js";
import { InboxScreen } from "../inbox.js";
import type { IntakeItem, IntakePolicy, IntakeReply } from "../intake.js";

const { request, ReadError } = vi.hoisted(() => {
  class ReadError extends Error { constructor(readonly code: string, readonly error: string | null = null) { super(code); } }
  return { request: vi.fn(), ReadError };
});
vi.mock("../../hooks/useOwnerSession.js", () => ({ OwnerReadError: ReadError, useOwnerSession: () => ({ paired: true, request }) }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

const policy: IntakePolicy = { revision: 2, mode: "observe", rules: [
  { name: "Failing main", instruction: "Fix a failing default-branch CI run.", enabled: true },
  { name: "Crash reports", instruction: "Triage issues labelled crash.", enabled: false },
] };
const item = (overrides: Partial<IntakeItem> = {}): IntakeItem => ({
  item: "issue:1", kind: "issue", title: "Login rejects a valid password", url: "https://github.com/acme/app/issues/1",
  author: "someone", explicit: false, state: "would_start", matched: ["Failing main"], policyRevision: 2, runId: null,
  createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z", ...overrides,
});
const reply = (items: IntakeItem[] = [item()]): IntakeReply => ({ policy, repository: "acme/app", items });

async function show(child: React.ReactNode) {
  const language = await createInterfaceI18n({ language: "en" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>{child}</I18nextProvider></QueryClientProvider>);
}
const writes = () => request.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")
  .map(([path, init]) => ({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }));

describe("intake policy settings", () => {
  beforeEach(() => request.mockReset().mockImplementation(async (_path: string, init?: { method?: string }) =>
    init?.method === "PUT" ? { policy: { ...policy, revision: 3, mode: "auto" } } : reply()));

  it("reads the mode and rules and saves the whole policy in one request", async () => {
    await show(<IntakeSettings teamId="team-1" />);
    const panel = await screen.findByRole("region", { name: "Intake" });
    expect((within(panel).getByRole("radio", { name: "Observe" }) as HTMLInputElement).checked).toBe(true);
    expect((within(panel).getByRole("textbox", { name: "Rule name 1" }) as HTMLInputElement).value).toBe("Failing main");
    expect(within(panel).getAllByRole("checkbox")[0]!.closest("label")).toHaveProperty("textContent", "Enabled");
    expect(request).toHaveBeenCalledWith("/teams/team-1/intake", expect.anything());
    expect(within(panel).queryByRole("button", { name: "Save intake policy" })).toBeNull();
    fireEvent.click(within(panel).getByRole("radio", { name: "Automatic" }));
    fireEvent.change(within(panel).getByRole("textbox", { name: "Rule name 2" }), { target: { value: "Crashes" } });
    fireEvent.click(within(panel).getAllByRole("checkbox")[1]!);
    fireEvent.click(within(panel).getByRole("button", { name: "Save intake policy" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ path: "/teams/team-1/intake/policy", method: "PUT", body: {
      baseRevision: 2, mode: "auto",
      rules: [
        { name: "Failing main", instruction: "Fix a failing default-branch CI run.", enabled: true },
        { name: "Crashes", instruction: "Triage issues labelled crash.", enabled: true },
      ],
    } });
  });

  it("adds and removes rules within the server's limits", async () => {
    request.mockImplementation(async (_path: string, init?: { method?: string }) =>
      init?.method === "PUT" ? { policy } : reply());
    await show(<IntakeSettings teamId="team-1" />);
    const panel = await screen.findByRole("region", { name: "Intake" });
    fireEvent.click(within(panel).getByRole("button", { name: "Add rule" }));
    expect(within(panel).getByRole("textbox", { name: "Rule name 3" })).toBeTruthy();
    fireEvent.change(within(panel).getByRole("textbox", { name: "Rule name 3" }), { target: { value: "Docs" } });
    fireEvent.change(within(panel).getByRole("textbox", { name: "Rule instruction 3" }), { target: { value: "Fix broken links." } });
    fireEvent.click(within(panel).getByRole("button", { name: "Remove rule 2" }));
    expect(within(panel).queryByRole("textbox", { name: "Rule instruction 2" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Save intake policy" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body.rules).toEqual([
      { name: "Failing main", instruction: "Fix a failing default-branch CI run.", enabled: true },
      { name: "Docs", instruction: "Fix broken links.", enabled: true },
    ]);
  });

  it("refuses a duplicate or empty rule locally and shows the server's own refusal text", async () => {
    await show(<IntakeSettings teamId="team-1" />);
    const panel = await screen.findByRole("region", { name: "Intake" });
    fireEvent.change(within(panel).getByRole("textbox", { name: "Rule name 2" }), { target: { value: "Failing main" } });
    expect(within(panel).getByRole("button", { name: "Save intake policy" })).toHaveProperty("disabled", true);
    fireEvent.change(within(panel).getByRole("textbox", { name: "Rule name 2" }), { target: { value: "Crashes" } });
    request.mockImplementationOnce(async () => { throw new ReadError("intake_policy_invalid", "Rule 2 needs an instruction."); });
    fireEvent.click(within(panel).getByRole("button", { name: "Save intake policy" }));
    expect(await within(panel).findByRole("alert")).toHaveProperty("textContent", "Rule 2 needs an instruction.");
    expect(within(panel).getByRole("button", { name: "Save intake policy" })).toHaveProperty("disabled", false);
  });

  it("names a save that another save overtook and reloads the policy on request", async () => {
    await show(<IntakeSettings teamId="team-1" />);
    const panel = await screen.findByRole("region", { name: "Intake" });
    fireEvent.click(within(panel).getByRole("radio", { name: "Off" }));
    request.mockImplementationOnce(async () => { throw new ReadError("intake_policy_conflict", "The intake policy changed. Reload it before saving."); });
    fireEvent.click(within(panel).getByRole("button", { name: "Save intake policy" }));
    expect(await within(panel).findByRole("alert")).toHaveProperty("textContent", "The intake policy changed. Reload it before saving.");
    const reads = request.mock.calls.length;
    fireEvent.click(within(panel).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(reads));
    expect((within(panel).getByRole("radio", { name: "Observe" }) as HTMLInputElement).checked).toBe(true);
    expect(within(panel).queryByRole("alert")).toBeNull();
  });
});

describe("project inbox", () => {
  beforeEach(() => request.mockReset().mockImplementation(async (_path: string, init?: { method?: string }) => {
    if (init?.method === "POST") return _path.endsWith("/start") ? { runId: "run-9" }
      : { item: item({ state: "dismissed" }) };
    return reply([item(), item({ item: "comment:2", kind: "comment", title: "Please retry the upload", author: "acme-owner",
      explicit: true, matched: [], url: "https://github.com/acme/app/issues/1#issuecomment-2" })]);
  }));

  it("lists each item with its link, state, matched rules and per-state actions", async () => {
    const onOpenRun = vi.fn();
    await show(<InboxScreen teamId="team-1" onOpenRun={onOpenRun} />);
    const region = await screen.findByRole("region", { name: "Inbox" });
    const rows = within(region).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: /Login rejects a valid password/ })
      .getAttribute("href")).toBe("https://github.com/acme/app/issues/1");
    expect(within(rows[0]!).getByText("Would start")).toBeTruthy();
    expect(within(rows[0]!).getByText("Failing main")).toBeTruthy();
    expect(rows[0]!.getAttribute("data-explicit")).toBe("false");
    expect(within(rows[0]!).getByRole("button", { name: "Start" })).toBeTruthy();
    expect(within(rows[0]!).getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(rows[1]!.getAttribute("data-explicit")).toBe("true");
    expect(within(rows[1]!).getByText("Explicit request")).toBeTruthy();
    expect(screen.getByText("acme/app")).toBeTruthy();
  });

  it("starts an eligible item through its own endpoint", async () => {
    await show(<InboxScreen teamId="team-1" onOpenRun={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Inbox" });
    fireEvent.click(within(region).getAllByRole("button", { name: "Start" })[0]!);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ path: "/teams/team-1/intake/items/issue%3A1/start", method: "POST", body: undefined });
  });

  it("shows the daemon's reason when a start is refused", async () => {
    await show(<InboxScreen teamId="team-1" onOpenRun={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Inbox" });
    request.mockImplementationOnce(async () => {
      throw new ReadError("intake_start_failed", "A planning run needs a lead seat: name one, or create a team with `multi-agent team create`.");
    });
    fireEvent.click(within(region).getAllByRole("button", { name: "Start" })[0]!);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent",
      "A planning run needs a lead seat: name one, or create a team with `multi-agent team create`.");
  });

  it("dismisses an item through its own endpoint and keeps the returned state", async () => {
    await show(<InboxScreen teamId="team-1" onOpenRun={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Inbox" });
    fireEvent.click(within(region).getAllByRole("button", { name: "Dismiss" })[0]!);
    await waitFor(() => expect(within(region).getAllByText("Dismissed")).toHaveLength(1));
    expect(writes()).toEqual([{ path: "/teams/team-1/intake/items/issue%3A1/dismiss", method: "POST", body: undefined }]);
  });

  it("offers only the run link once an item is started", async () => {
    request.mockResolvedValueOnce(reply([item({ item: "issue:3", state: "started", runId: "run-7" })]));
    const onOpenRun = vi.fn();
    await show(<InboxScreen teamId="team-1" onOpenRun={onOpenRun} />);
    const row = within(await screen.findByRole("region", { name: "Inbox" })).getAllByRole("listitem")[0]!;
    expect(within(row).queryByRole("button", { name: "Start" })).toBeNull();
    expect(within(row).getByRole("link", { name: "Open run" }).getAttribute("href")).toBe("/team/overview?run=run-7");
    expect(within(row).queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(within(row).getByRole("link", { name: "Open run" }));
    expect(onOpenRun).toHaveBeenCalledWith("run-7");
  });

  it("names an empty inbox and a failed read without inventing items", async () => {
    request.mockResolvedValueOnce(reply([]));
    await show(<InboxScreen teamId="team-1" onOpenRun={vi.fn()} />);
    expect(await screen.findByText("Nothing in the inbox yet.")).toBeTruthy();
    cleanup();
    request.mockRejectedValueOnce(new Error("offline"));
    await show(<InboxScreen teamId="team-1" onOpenRun={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The inbox could not be loaded.");
  });
});