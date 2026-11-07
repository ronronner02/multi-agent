import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { SettingsScreen } from "../settings.js";
import { GithubGate, githubStatusKey } from "../github-gate.js";
import { seats } from "./fixtures.js";

const request = vi.fn(), revoke = vi.fn(), onLanguage = vi.fn(), setPreference = vi.fn(), setMotion = vi.fn();
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../hooks/useOwnerSession.js")>(),
  useOwnerSession: () => ({ paired: true, request, revoke }),
}));
let cache: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); revoke.mockResolvedValue(undefined);
  let lead = "claude-code";
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/settings") {
      if (init?.method === "PUT") lead = JSON.parse(String(init.body)).value;
      return { settings: { "team.leadClient": { value: lead, source: "file" } } };
    }
    if (path === "/github/status") return { signedIn: true, login: "fixture-owner", host: "github.com" };
    if (path === "/github/logout") return { signedIn: false, login: null, host: "github.com" };
    if (path === "/github/login") return { state: "idle" };
    throw new Error("Unexpected request: " + path);
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); cache.clear(); });

async function show(locale: "en" | "zh-CN" = "en", gated = false) {
  const language = await createInterfaceI18n({ language: locale });
  const settings = <SettingsScreen language={language} onLanguage={onLanguage}
      appearance={{ preference: "dark", theme: "dark", setPreference }} background={{ motion: true, setMotion }}
      connection="shell.connected" isolation="none" address="http://127.0.0.1:7433" seats={seats} />;
  return render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    {gated ? <GithubGate frame={content => content}>{settings}</GithubGate> : settings}
  </I18nextProvider></QueryClientProvider>);
}

describe("command-center settings", () => {
  it("reads and persists the default lead through the owner settings route", async () => {
    await show();
    const lead = await screen.findByRole("combobox", { name: "Default lead client" }) as HTMLSelectElement;
    await waitFor(() => expect(lead.disabled).toBe(false));
    expect(lead.value).toBe("claude-code");
    fireEvent.change(lead, { target: { value: "codex" } });
    await waitFor(() => expect(lead.value).toBe("codex"));
    expect(request).toHaveBeenCalledWith("/settings", expect.objectContaining({ method: "PUT", body: JSON.stringify({ key: "team.leadClient", value: "codex" }) }));
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
    expect(onLanguage).toHaveBeenCalledWith("zh-CN");
  });

  it("shows the account and publishes a successful sign-out to the gate", async () => {
    await show(); fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(await screen.findByText("fixture-owner")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(cache.getQueryData(["team", "github", "status"])).toMatchObject({ signedIn: false }));
    expect(request).toHaveBeenCalledWith("/github/logout", { method: "POST" });
  });

  it("keeps the app signed out when a pre-logout account read finishes late", async () => {
    await show("en", true);
    fireEvent.click(await screen.findByRole("button", { name: "GitHub" }));
    expect(await screen.findByText("fixture-owner")).toBeTruthy();
    await waitFor(() => expect(cache.getQueryState(githubStatusKey)?.fetchStatus).toBe("idle"));
    const original = request.getMockImplementation()!;
    let finish!: (value: object) => void;
    let signal!: AbortSignal;
    request.mockImplementation((path: string, init?: RequestInit) => path === "/github/status"
      ? new Promise(resolve => { finish = resolve; signal = init!.signal!; }) : original(path, init));
    const pending = cache.refetchQueries({ queryKey: githubStatusKey });
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
    await act(async () => { finish({ signedIn: true, login: "fixture-owner", host: "github.com" }); await pending; });
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    expect(cache.getQueryData(githubStatusKey)).toMatchObject({ signedIn: false });
    expect(signal.aborted).toBe(true);
  });

  it("keeps dark, light, system and background motion as real preferences", async () => {
    await show(); fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(setPreference).toHaveBeenCalledWith("light");
    fireEvent.click(screen.getByRole("checkbox", { name: "Background motion" }));
    expect(setMotion).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("radio", { name: "Ink" })).toBeNull();
  });

  it("revokes only this browser and keeps a failed revocation visible", async () => {
    revoke.mockRejectedValueOnce(new Error("network"));
    await show(); fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(screen.getByText("http://127.0.0.1:7433")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke this browser" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The revocation failed; the session is still active.");
    expect(request.mock.calls.some(([path]) => String(path).includes("/owner-session/sessions"))).toBe(false);
  });

  it("renders the team's seats read-only without exposing their internal IDs", async () => {
    await show(); fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByText("Implementer · Codex")).toBeTruthy();
    expect(screen.queryByText("impl@rig")).toBeNull();
    expect(screen.queryByRole("button", { name: /add seat|remove seat/i })).toBeNull();
  });

  it("localizes every restored settings section", async () => {
    await show("zh-CN");
    for (const name of ["通用", "GitHub", "外观", "会话", "智能体"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(document.body.textContent).not.toMatch(/settings\.|github\.|team\.settings\./));
    }
  });
});
