import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { BottomPanel, type TerminalTarget } from "../bottom-panel.js";
import { OwnerSessionProvider } from "../../hooks/useOwnerSession.js";

// Terminal rendering is covered in the real browser; this test exercises tab state.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
afterEach(() => vi.unstubAllGlobals());

it.each(["en", "zh-CN"] as const)("moves an owner terminal to visible logs and restores focus at 390 px (%s)", async locale => {
  vi.stubGlobal("innerWidth", 1440);
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  function Panel() {
    const [tab, setTab] = useState("terminal");
    const [target, setTarget] = useState<TerminalTarget>("owner");
    return <div className="team-shell"><BottomPanel tab={tab} onTab={setTab} target={target} onTarget={setTarget}
      read={{ runId: "run", attempts: [], tasks: [], logs: [] }} available={false} /></div>;
  }
  render(<I18nextProvider i18n={language.instance}><OwnerSessionProvider><Panel /></OwnerSessionProvider></I18nextProvider>);
  screen.getByRole("tabpanel").focus();
  vi.stubGlobal("innerWidth", 390);
  act(() => window.dispatchEvent(new Event("resize")));
  const logs = screen.getByRole("tab", { name: language.t("web.logs") });
  expect(logs.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(logs);
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(logs.id);
  vi.stubGlobal("innerWidth", 1024);
  act(() => window.dispatchEvent(new Event("resize")));
  expect(logs.getAttribute("aria-selected")).toBe("true");
  fireEvent.mouseDown(screen.getByRole("tab", { name: language.t("web.reviewConversation") }), { button: 0 });
  expect(screen.getByRole("tab", { name: language.t("web.reviewConversation") }).getAttribute("aria-selected")).toBe("true");
});
