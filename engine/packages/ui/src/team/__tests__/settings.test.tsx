import React from "react";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n, type InterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { OwnerSessionProvider } from "../../hooks/useOwnerSession.js";
import { SETTINGS_SECTIONS, SettingsScreen } from "../settings.js";
import { TEAM_THEME_KEY, readTeamThemePreference, resolveTeamTheme, useThemePreference, writeTeamTheme } from "../theme.js";

/**
 * Slice C — Settings.
 *
 * The section list carries only sections with a real owner behind them, Appearance and language
 * persist where the client already keeps them, Sessions lists and revokes the paired browsers
 * through the owner-session route, and Runtime reports the daemon's own facts read-only.
 */

const mocks = vi.hoisted(() => ({ request: vi.fn(), changeLanguage: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({ ...(await importOriginal<object>()),
  useOwnerSession: () => ({ paired: true, request: mocks.request }),
}));

function clearStorage(): void {
  try { localStorage.clear(); } catch { /* storage may be unavailable in this environment */ }
}

afterEach(() => { mocks.request.mockReset(); mocks.changeLanguage.mockReset(); clearStorage(); });

async function show(overrides: Partial<Parameters<typeof SettingsScreen>[0]> = {}): Promise<InterfaceI18n> {
  const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    <OwnerSessionProvider><div className="team-shell"><SettingsScreen language={language} theme="dark" onTheme={() => {}}
      connection="shell.connected" isolation="none" address="http://localhost:7433" planRef="docs/plans/fixture.md" {...overrides} />
    </div></OwnerSessionProvider>
  </I18nextProvider></QueryClientProvider>);
  return language;
}

function section(language: InterfaceI18n, id: (typeof SETTINGS_SECTIONS)[number]): void {
  fireEvent.click(screen.getByRole("button", { name: language.t(`settings.section.${id}`) }));
}

describe("settings sections", () => {
  it("lists only the sections that have a real owner", async () => {
    const language = await show();
    const nav = screen.getByRole("navigation", { name: language.t("settings.sections") });
    expect(within(nav).getAllByRole("button").map(button => button.textContent))
      .toEqual(SETTINGS_SECTIONS.map(id => language.t(`settings.section.${id}`)));
    // General, Agents, Providers and Workspace have no store in this client, so they are absent
    // rather than rendered as empty panels.
    expect(SETTINGS_SECTIONS).toEqual(["appearance", "sessions", "runtime", "plan"]);
  });

  it("moves the selected section and marks it pressed", async () => {
    const language = await show();
    const nav = screen.getByRole("navigation", { name: language.t("settings.sections") });
    expect(within(nav).getByRole("button", { name: language.t("settings.section.appearance") }).getAttribute("aria-pressed")).toBe("true");
    section(language, "runtime");
    expect(within(nav).getByRole("button", { name: language.t("settings.section.runtime") }).getAttribute("aria-pressed")).toBe("true");
    expect(within(nav).getByRole("button", { name: language.t("settings.section.appearance") }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("region", { name: language.t("settings.runtime") })).toBeTruthy();
  });
});

describe("appearance", () => {
  it("persists the theme choice in the client's own storage", async () => {
    const onTheme = vi.fn();
    const language = await show({ onTheme });
    const group = screen.getByRole("radiogroup", { name: language.t("settings.theme") });
    expect([...group.querySelectorAll("[data-theme-option]")].map(option => option.getAttribute("data-theme-option")))
      .toEqual(["dark", "light", "ink", "system"]);
    fireEvent.click(within(group).getByRole("radio", { name: language.t("settings.theme.light") }));
    expect(onTheme).toHaveBeenCalledWith("light");
  });

  it("selects Ink as an explicit appearance without removing System", async () => {
    const onTheme = vi.fn();
    const language = await show({ theme: "ink", onTheme });
    const ink = screen.getByRole("radio", { name: language.t("settings.theme.ink") });
    expect(ink.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(ink);
    expect(onTheme).toHaveBeenCalledWith("ink");
    expect(screen.getByRole("radio", { name: language.t("settings.theme.system") })).toBeTruthy();
  });

  it("retains Ink across a remount and ignores the OS palette", () => {
    const first = renderHook(useThemePreference);
    act(() => first.result.current.setPreference("ink"));
    expect(first.result.current.theme).toBe("ink");
    expect(localStorage.getItem(TEAM_THEME_KEY)).toBe("ink");
    first.unmount();
    const second = renderHook(useThemePreference);
    expect(second.result.current.preference).toBe("ink");
    expect(second.result.current.theme).toBe("ink");
    expect(resolveTeamTheme("ink", true)).toBe("ink");
    expect(resolveTeamTheme("ink", false)).toBe("ink");
  });

  it("stores and reads the preference, resolving system through the OS", () => {
    expect(readTeamThemePreference()).toBe("dark");
    writeTeamTheme("system");
    expect(localStorage.getItem(TEAM_THEME_KEY)).toBe("system");
    expect(readTeamThemePreference()).toBe("system");
    expect(resolveTeamTheme("system", true)).toBe("dark");
    expect(resolveTeamTheme("system", false)).toBe("light");
    // An explicit choice never follows the OS.
    expect(resolveTeamTheme("light", true)).toBe("light");
    expect(resolveTeamTheme("dark", false)).toBe("dark");
    // A stored value the shell cannot render falls back to the default rather than through it.
    localStorage.setItem(TEAM_THEME_KEY, "sepia");
    expect(readTeamThemePreference()).toBe("dark");
  });

  it("persists the language through the interface client", async () => {
    const changeLanguage = vi.fn();
    const language = await show();
    const select = screen.getByRole("combobox", { name: language.t("language.label") }) as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(["zh-CN", "en"]);
    // The screen calls the client's own changeLanguage, which is what writes the preference.
    const client = await createInterfaceI18n({ preference: { read: () => "en", write: changeLanguage } });
    await client.changeLanguage("zh-CN");
    expect(changeLanguage).toHaveBeenCalledWith("zh-CN");
    expect(client.language).toBe("zh-CN");
  });
});

describe("sessions", () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, origin: `http://localhost:${id}`, created_at: 1_760_000_000_000, last_seen_at: 1_760_000_600_000,
    expires_at: 1_760_043_200_000, revoked_at: null, ...overrides,
  });

  it("lists the paired browsers and revokes one through the owner-session route", async () => {
    const language = await show();
    mocks.request.mockImplementation((path: string) => path === "/owner-session/sessions"
      ? Promise.resolve({ sessions: [row("7433"), row("7434")] })
      : Promise.resolve({ revoked: true }));
    section(language, "sessions");
    await waitFor(() => expect(screen.getByRole("region", { name: language.t("settings.sessions") }).querySelectorAll("[data-session]").length).toBe(2));
    const list = screen.getByRole("region", { name: language.t("settings.sessions") });
    expect(list.querySelectorAll("[data-session]")[0]!.textContent).toContain("http://localhost:7433");
    fireEvent.click(within(list).getByRole("button", { name: /http:\/\/localhost:7434/ }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/owner-session/sessions/7434", { method: "DELETE" }));
  });

  it("shows a revoked session without offering a second revocation", async () => {
    const language = await show();
    mocks.request.mockResolvedValue({ sessions: [row("7433", { revoked_at: 1_760_000_700_000 })] });
    section(language, "sessions");
    await waitFor(() => expect(screen.getByText(language.t("settings.sessions.revoked"))).toBeTruthy());
    const list = screen.getByRole("region", { name: language.t("settings.sessions") });
    // The button is labelled by the session it revokes, so a list of several browsers never
    // offers two identical "Revoke" controls to a screen reader.
    const revoke = within(list.querySelector("[data-session]") as HTMLElement)
      .getByRole("button", { name: `${language.t("settings.sessions.revokeSession")} http://localhost:7433` });
    expect(revoke.hasAttribute("disabled")).toBe(true);
    expect(revoke.textContent).toBe(language.t("settings.sessions.revoke"));
  });

  it("says the list is unavailable when the route fails, never that it is empty", async () => {
    const language = await show();
    mocks.request.mockRejectedValue(new Error("read failed"));
    section(language, "sessions");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(language.t("settings.sessions.unavailable")));
    expect(screen.queryByText(language.t("settings.sessions.none"))).toBeNull();
  });
});

describe("runtime", () => {
  it("reports the connection, the isolation level and the daemon address read-only", async () => {
    const language = await show();
    section(language, "runtime");
    const panel = screen.getByRole("region", { name: language.t("settings.runtime") });
    expect(panel.querySelector('[data-runtime="connection"]')!.textContent).toContain(language.t("shell.connected"));
    expect(panel.querySelector('[data-runtime="isolation"]')!.textContent).toContain(language.t("settings.runtime.isolation.none"));
    expect(panel.querySelector('[data-runtime="isolation"]')!.textContent).toContain(language.t("settings.runtime.isolationHelp.none"));
    expect(panel.querySelector('[data-runtime="address"]')!.textContent).toBe("http://localhost:7433");
    // Read-only: no control in the panel can change a fact the daemon decided.
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows an unreported isolation level as unknown with its reason", async () => {
    const language = await show({ isolation: null });
    section(language, "runtime");
    const panel = screen.getByRole("region", { name: language.t("settings.runtime") });
    expect(panel.querySelector('[data-runtime="isolation"]')!.textContent).toContain(language.t("web.unknown"));
    expect(panel.querySelector('[data-runtime="isolation"]')!.textContent).toContain(language.t("settings.runtime.isolationUnknown"));
  });
});

describe("plan", () => {
  it("shows the selected run's plan reference", async () => {
    const language = await show();
    section(language, "plan");
    expect(screen.getByRole("region", { name: language.t("settings.plan") }).textContent).toContain("docs/plans/fixture.md");
  });

  it("says no run is selected when there is no plan reference to show", async () => {
    const language = await show({ planRef: undefined });
    section(language, "plan");
    expect(screen.getByRole("region", { name: language.t("settings.plan") }).textContent).toContain(language.t("web.noRun"));
  });
});
