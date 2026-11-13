import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { AgentAccount } from "../agent-account.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({ OwnerReadError: class extends Error {}, useOwnerSession: () => ({ paired: true, request }) }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); request.mockReset(); });

async function show() {
  const language = await createInterfaceI18n({ language: "en" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}><AgentAccount /></I18nextProvider></QueryClientProvider>);
  return screen.findByRole("region", { name: "Agent account" });
}

describe("agent account", () => {
  it("starts the agent's own sign-in and shows its device code", async () => {
    request.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/github/agent/status") return { signedIn: false, login: null, host: "github.com", sameAsOwner: false };
      if (path === "/github/agent/login" && init?.method === "POST") return { state: "pending", code: "ABCD-1234", url: "https://github.com/login/device" };
      return { state: "idle" };
    });
    const panel = await show();
    fireEvent.click(await within(panel).findByRole("button", { name: "Sign in the agent account" }));
    expect(await within(panel).findByText("ABCD-1234")).toBeTruthy();
    expect(request.mock.calls.some(([path, init]) => path === "/github/agent/login" && init?.method === "POST")).toBe(true);
  });

  it("warns when the owner's own account is signed in as the agent", async () => {
    request.mockResolvedValue({ signedIn: true, login: "owner-login", host: "github.com", sameAsOwner: true });
    const panel = await show();
    expect(await within(panel).findByRole("alert")).toHaveProperty("textContent", "This is your own account. Sign in the team's agent account instead.");
    expect(within(panel).getByText("owner-login")).toBeTruthy();
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Sign out" })).toBeTruthy());
  });
});
