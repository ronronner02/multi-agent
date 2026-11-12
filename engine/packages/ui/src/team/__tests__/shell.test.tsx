import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { ShellFrame, TEAM_SECTIONS, teamSection, showsNewWork, type TeamSection } from "../shell.js";
import { TEAM_THEME_KEY, useThemePreference } from "../theme.js";
import { read, task } from "./fixtures.js";

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function show(locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  const onSelect = vi.fn();
  const onOpenChat = vi.fn();
  const onSearch = vi.fn();
  function Frame() {
    const [section, setSection] = useState<TeamSection>("overview");
    const appearance = useThemePreference();
    return <ShellFrame language={language} section={section} appearance={appearance}
      project="Status board" runName="Add the status filter" coordinator="shell.active"
      connection="shell.connected" branch="team/add-status-filter" notifications={2} canChat
      onLanguage={next => void language.changeLanguage(next)}
      hrefFor={next => `/team/${next}?run=run-1`}
      onSelect={next => { onSelect(next); setSection(next); }}
      onOpenChat={onOpenChat} onSearch={onSearch}><p>content</p></ShellFrame>;
  }
  const view = render(<I18nextProvider i18n={language.instance}><Frame /></I18nextProvider>);
  return { view, onSelect, onOpenChat, onSearch, language };
}

describe("command-center shell", () => {
  it("has seven destinations including documents and falls back for unknown URLs", () => {
    expect([...TEAM_SECTIONS]).toEqual(["overview", "documents", "workspace", "tasks", "reviews", "analytics", "settings"]);
    for (const section of TEAM_SECTIONS) {
      expect(teamSection(`/team/${section}`)).toBe(section);
    }
    expect(teamSection("/team")).toBe("overview");
    expect(teamSection("/team/unknown")).toBe("overview");
  });

  it("links every destination and marks the selected one as current", async () => {
    const { onSelect } = await show();
    const nav = screen.getByRole("navigation", { name: "Multi-Agent" });
    expect(within(nav).getAllByRole("link")).toHaveLength(7);
    for (const [index, name] of ["Overview", "Documents", "Workspace", "Tasks", "Reviews", "Analytics", "Settings"].entries()) {
      const link = within(nav).getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(`/team/${TEAM_SECTIONS[index]}?run=run-1`);
      fireEvent.click(link);
      expect(onSelect).toHaveBeenLastCalledWith(TEAM_SECTIONS[index]);
      expect(link.getAttribute("aria-current")).toBe("page");
      expect(within(nav).getAllByRole("link").filter(item => item.getAttribute("aria-current") === "page")).toHaveLength(1);
    }
  });

  it("switches dark, light and system preferences through the real persisted theme hook", async () => {
    const { view } = await show();
    expect(view.container.querySelector(".team-shell")!.getAttribute("data-ui-theme")).toBe("dark");
    const select = screen.getByRole("combobox", { name: "Appearance" });
    for (const next of ["light", "system", "dark"]) {
      fireEvent.change(select, { target: { value: next } });
      expect(localStorage.getItem(TEAM_THEME_KEY)).toBe(next);
      expect((select as HTMLSelectElement).value).toBe(next);
    }
  });

  it("opens the same chat from the coordinator, top bar and notifications", async () => {
    const { onOpenChat } = await show();
    for (const name of ["Coordinator", "Open lead chat", "Notifications: 2"]) {
      const button = screen.getByRole("button", { name });
      fireEvent.click(button);
      expect(onOpenChat).toHaveBeenLastCalledWith(button);
    }
    expect(onOpenChat).toHaveBeenCalledTimes(3);
  });

  it("switches shell labels to Chinese without leaving untranslated keys", async () => {
    const { language } = await show();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "中" })); await language.changeLanguage("zh-CN"); });
    expect(screen.getByRole("link", { name: "总览" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "工作区" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "任务" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "审查" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "分析" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "设置" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "外观" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "通知：2" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/shell\.|nav\.|settings\.theme\./);
  });

  it("opens a mobile navigation dialog and restores focus after choosing a destination", async () => {
    const { onSelect } = await show();
    // jsdom does not evaluate width media queries; browser coverage owns the breakpoint.
    const opener = screen.getByLabelText("Open navigation");
    opener.style.display = "grid";
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(dialog).getByRole("link", { name: "Tasks" }));
    expect(onSelect).toHaveBeenLastCalledWith("tasks");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("shows the integration branch and the observed connection in the footer", async () => {
    await show();
    const footer = screen.getByRole("contentinfo");
    expect(footer.textContent).toContain("team/add-status-filter");
    expect(footer.textContent).toContain("Connected");
  });

  it("offers the next run only when this one is no longer doing work", () => {
    expect(showsNewWork(read({ tasks: [task({ queueState: "in-progress" })] }))).toBe(false);
    expect(showsNewWork(read({ tasks: [task({ queueState: "done" })] }))).toBe(true);
    expect(showsNewWork(read({ run: { ...read().run, state: "canceled" }, tasks: [task({ queueState: "pending" })] }))).toBe(true);
    expect(showsNewWork(undefined)).toBe(false);
  });
});
