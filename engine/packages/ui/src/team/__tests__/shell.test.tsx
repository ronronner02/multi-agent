import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createInterfaceI18n, type InterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { ShellFrame, TEAM_SECTIONS, teamSection, type TeamSection } from "../shell.js";
import type { TeamTheme } from "../theme.js";

/**
 * Slice A — the shell's six destinations.
 *
 * The navigation is the product's map: these tests pin the six names and their order, the active
 * marker, and that a retired destination's deep link lands on the destination that now owns its
 * evidence rather than on a blank page.
 */

function Shell({ language, theme = "dark", onTheme = () => {}, onSearch = () => {}, runPicker, coordinator = { state: "running", known: true }, connection = "shell.connected", snapshotAge = null }: {
  language: InterfaceI18n; theme?: TeamTheme; onTheme?: (theme: TeamTheme) => void; onSearch?: (query: string) => void;
  runPicker?: React.ReactNode; coordinator?: { state: "running" | "stopped" | "unknown"; known: boolean }; connection?: string; snapshotAge?: number | null;
}) {
  const [current, setCurrent] = React.useState<TeamSection>("overview");
  return <ShellFrame language={language} section={current} theme={theme} onTheme={onTheme}
    runId="RUN-0142" runPicker={runPicker} project="work-board" coordinator={coordinator}
    connection={connection} snapshotAge={snapshotAge} notifications={2} hrefFor={section => `/team/${section}?run=RUN-0142`}
    onSelect={setCurrent} onSearch={onSearch}><p>content</p></ShellFrame>;
}

async function show(locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  render(<I18nextProvider i18n={language.instance}><Shell language={language} /></I18nextProvider>);
  return language;
}

describe("managed shell navigation", () => {
  it.each(["en", "zh-CN"] as const)("shows exactly the six destinations in order (%s)", async locale => {
    const language = await show(locale);
    const nav = screen.getByRole("navigation", { name: language.t("shell.appName") });
    const links = within(nav).getAllByRole("link");
    expect(links.map(link => link.textContent)).toEqual(TEAM_SECTIONS.map(section => language.t(`nav.${section}`)));
    expect(links.map(link => link.getAttribute("href"))).toEqual(TEAM_SECTIONS.map(section => `/team/${section}?run=RUN-0142`));
    expect(links[0]!.getAttribute("aria-current")).toBe("page");
    expect(links.slice(1).every(link => link.getAttribute("aria-current") === null)).toBe(true);
    expect(TEAM_SECTIONS).toEqual(["overview", "workspace", "tasks", "reviews", "analytics", "settings"]);
  });

  it.each(["en", "zh-CN"] as const)("opens Reviews from the notification button (%s)", async locale => {
    const language = await show(locale);
    fireEvent.click(screen.getByRole("button", { name: `${language.t("shell.notifications")}: 2` }));
    expect(screen.getByRole("link", { name: language.t("nav.reviews") }).getAttribute("aria-current")).toBe("page");
  });

  it.each(["stopped", "unknown"] as const)("shows the coordinator's observed %s state instead of idle", async state => {
    const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
    render(<I18nextProvider i18n={language.instance}><Shell language={language} coordinator={{ state, known: true }} /></I18nextProvider>);
    expect(document.querySelector(".ui-coordinator")?.textContent).toContain(language.t(`status.attempt.${state}`));
    expect(document.querySelector(".ui-coordinator")?.textContent).not.toContain(language.t("shell.idle"));
  });

  it.each(["web.stale", "web.disconnected", "web.error", "web.notFound"])("makes %s visible above retained content", async connection => {
    const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
    render(<I18nextProvider i18n={language.instance}><Shell language={language} connection={connection} snapshotAge={12} /></I18nextProvider>);
    expect(screen.getByRole("alert").textContent).toContain(language.t(connection as "web.stale"));
    expect(screen.getByRole("alert").textContent).toContain(language.t("shell.snapshotWarning"));
    expect(screen.getByText(language.t("shell.snapshotAge", { seconds: 12 }))).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("keeps the warning out of a connected view", async () => {
    await show();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("maps the retired destinations onto the destination that owns their evidence", () => {
    expect(teamSection("/team/overview")).toBe("overview");
    expect(teamSection("/team/agents")).toBe("workspace");
    expect(teamSection("/team/logs")).toBe("workspace");
    expect(teamSection("/team/knowledge")).toBe("workspace");
    expect(teamSection("/team/decisions")).toBe("reviews");
    expect(teamSection("/team")).toBe("overview");
    expect(teamSection("/team/unknown")).toBe("overview");
  });

  it("keeps the project selector, coordinator row, command strip and theme switch in the shell", async () => {
    const onTheme = vi.fn();
    const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
    render(<I18nextProvider i18n={language.instance}><Shell language={language} onTheme={onTheme} /></I18nextProvider>);
    expect(screen.getByText(language.t("shell.project"))).toBeTruthy();
    expect(screen.getAllByText("work-board").length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`${language.t("shell.coordinator")} · ${language.t("shell.active")}`))).toBeTruthy();
    expect(screen.getByRole("search")).toBeTruthy();
    expect(screen.getByLabelText(language.t("shell.searchJump"))).toBeTruthy();
    expect(screen.getByText(language.t("shell.ctrlK"))).toBeTruthy();
    expect(screen.getByText(language.t("shell.remoteMonitor"))).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(language.t("shell.connected"));
    expect(document.querySelector(".ui-badge")?.textContent).toBe("2");
    expect(document.querySelector(".team-shell")?.getAttribute("data-ui-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: language.t("shell.themeLight") }));
    expect(onTheme).toHaveBeenCalledWith("light");
  });

  it("moves the active marker to the destination the owner selects", async () => {
    const language = await show();
    const nav = screen.getByRole("navigation", { name: language.t("shell.appName") });
    fireEvent.click(within(nav).getByRole("link", { name: language.t("nav.tasks") }));
    expect(within(nav).getByRole("link", { name: language.t("nav.tasks") }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: language.t("nav.overview") }).getAttribute("aria-current")).toBeNull();
  });

  it("puts the run selector in the breadcrumb when the browser is paired", async () => {
    const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
    render(<I18nextProvider i18n={language.instance}>
      <Shell language={language} runPicker={<select aria-label={language.t("shell.run")} value="RUN-0142" onChange={() => {}}><option value="RUN-0142">RUN-0142</option></select>} />
    </I18nextProvider>);
    const breadcrumb = document.querySelector(".ui-breadcrumb")!;
    expect(within(breadcrumb as HTMLElement).getByRole("combobox", { name: language.t("shell.run") })).toBeTruthy();
    expect(breadcrumb.textContent).toContain("work-board");
  });

  it("sends the command-strip query to the tasks search", async () => {
    const onSearch = vi.fn();
    const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
    render(<I18nextProvider i18n={language.instance}><Shell language={language} onSearch={onSearch} /></I18nextProvider>);
    fireEvent.change(screen.getByLabelText(language.t("shell.searchJump")), { target: { value: "T-102" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(onSearch).toHaveBeenCalledWith("T-102");
  });
});
