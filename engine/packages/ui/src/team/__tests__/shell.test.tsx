import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { ShellFrame, TEAM_SECTIONS, teamSection, showsNewWork } from "../shell.js";
import { read, task } from "./fixtures.js";

/**
 * U10 — the shell is a bar, not a rail.
 *
 * These pin the destination map (four screens, with retired deep links landing on the screen
 * that now owns the work) and the two controls the bar carries: the language switch and the
 * overflow menu that opens settings.
 */

async function show(locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  const onLanguage = vi.fn();
  const onSettings = vi.fn();
  const view = render(<I18nextProvider i18n={language.instance}>
    <ShellFrame language={language} crumbs={<span>Add the status filter</span>}
      onLanguage={onLanguage} onSettings={onSettings}><p>content</p></ShellFrame>
  </I18nextProvider>);
  return { view, onLanguage, onSettings, language };
}

describe("team shell", () => {
  it("ships four destinations and sends retired deep links to the screen that owns the work", () => {
    expect([...TEAM_SECTIONS]).toEqual(["teams", "run", "task", "branch"]);
    expect(teamSection("/team/overview")).toBe("run");
    expect(teamSection("/team/tasks")).toBe("task");
    expect(teamSection("/team/reviews")).toBe("task");
    expect(teamSection("/team/workspace")).toBe("task");
    expect(teamSection("/team/analytics")).toBe("run");
    expect(teamSection("/team/settings")).toBe("settings");
    expect(teamSection("/team")).toBe("teams");
  });

  it("renders one bar with the crumbs, the language switch and the overflow menu", async () => {
    const { view } = await show();
    expect(screen.getByText("Add the status filter")).toBeTruthy();
    expect(view.container.querySelector(".ui-sidebar")).toBeNull();
    expect(view.container.querySelector(".ui-topstrip")).toBeNull();
    expect(view.container.querySelector(".topbar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "EN" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "中" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("reports the language and the settings request upward", async () => {
    const { onLanguage, onSettings } = await show();
    fireEvent.click(screen.getByRole("button", { name: "中" }));
    expect(onLanguage).toHaveBeenCalledWith("zh-CN");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalled();
  });

  it("has no video backdrop and no second palette", async () => {
    const { view } = await show();
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector(".team-backdrop")).toBeNull();
    expect(view.container.querySelector(".team-shell")!.getAttribute("data-ui-theme")).toBeNull();
  });

  it("offers the next run when this one is no longer doing work", () => {
    // In flight: the team is busy, so nothing offers a second run.
    expect(showsNewWork(read({ tasks: [task({ queueState: "in-progress" })] }))).toBe(false);
    // Every task finished, and the run still reads "approved": the owner can start more.
    expect(showsNewWork(read({ tasks: [task({ queueState: "done" })] }))).toBe(true);
    // A run that ended without finishing its work also offers the next one.
    expect(showsNewWork(read({ run: { ...read().run, state: "canceled" }, tasks: [task({ queueState: "pending" })] }))).toBe(true);
    expect(showsNewWork(undefined)).toBe(false);
  });
});