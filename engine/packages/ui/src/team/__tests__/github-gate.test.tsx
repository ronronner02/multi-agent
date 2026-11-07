import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { OwnerReadError } from "../../hooks/useOwnerSession.js";
import { GithubGate, githubStatusKey } from "../github-gate.js";

const request = vi.fn();
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../hooks/useOwnerSession.js")>(),
  useOwnerSession: () => ({ paired: true, request }),
}));
let cache: QueryClient, signedIn: boolean, state: string;
beforeEach(() => {
  signedIn = false; state = "idle";
  request.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/github/status") return { signedIn, login: signedIn ? "fixture-owner" : null, host: "github.com" };
    if (path === "/github/login") {
      if (init?.method === "POST") state = "pending";
      return state === "pending" ? { state, code: "ABCD-1234", url: "https://github.com/login/device" } : { state };
    }
    throw new Error("Unexpected request: " + path);
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); cache.clear(); });
async function show() {
  const language = await createInterfaceI18n({ language: "en" });
  return render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    <GithubGate frame={content => <div>{content}</div>}><p>Project content</p></GithubGate>
  </I18nextProvider></QueryClientProvider>);
}

describe("GitHub first-open gate", () => {
  it("shows the public device code, polls the flow, and opens the app only after account verification", async () => {
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to GitHub" }));
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open GitHub" }).getAttribute("href")).toBe("https://github.com/login/device");
    expect(screen.queryByText("Project content")).toBeNull();
    state = "done"; signedIn = true;
    await waitFor(() => expect(screen.getByText("Project content")).toBeTruthy(), { timeout: 2500 });
    expect(screen.queryByText("ABCD-1234")).toBeNull();
  });

  it("offers a fresh flow after failure", async () => {
    state = "failed"; await show();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    expect(request).toHaveBeenCalledWith("/github/login", { method: "POST" });
  });

  it("does not use a cached signed-in value before a fresh status response", async () => {
    cache.setQueryData(githubStatusKey, { signedIn: true, login: "old-owner", host: "github.com" });
    let finish!: (body: object) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await show();
    expect(screen.queryByText("Project content")).toBeNull();
    await act(async () => finish({ signedIn: false, login: null, host: "github.com" }));
    expect(await screen.findByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
    expect(screen.queryByText("Project content")).toBeNull();
  });

  it("closes the app immediately when sign-out updates the account", async () => {
    signedIn = true; await show();
    expect(await screen.findByText("Project content")).toBeTruthy();
    await act(async () => { signedIn = false; cache.setQueryData(githubStatusKey, { signedIn: false, login: null, host: "github.com" }); });
    await waitFor(() => expect(screen.queryByText("Project content")).toBeNull());
    expect(await screen.findByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
  });

  it("keeps the app gated when the account check fails", async () => {
    request.mockRejectedValueOnce(new OwnerReadError(503, "github_cli_missing")); await show();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "GitHub CLI is missing. Run ./setup.sh, then try again.");
    expect(screen.queryByText("Project content")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
  });
});
