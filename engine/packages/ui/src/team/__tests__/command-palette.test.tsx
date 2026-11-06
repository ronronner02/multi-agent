import React, { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { CommandPalette } from "../command-palette.js";
import { task } from "./fixtures.js";

const scrollIntoView = vi.fn();
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView.mockClear() });
});
afterEach(() => {
  cleanup();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
async function show(tasks = [task(), task({ taskId: "task-2", displayName: "Filter chips" })]) {
  const language = await createInterfaceI18n({ language: "en" });
  const choose = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    const opener = useRef<HTMLButtonElement>(null);
    return <><button ref={opener} onClick={() => setOpen(true)}>Search</button>
      <CommandPalette open={open} onOpenChange={setOpen} opener={opener} onChoose={choose}
        tasks={tasks} /></>;
  }
  render(<I18nextProvider i18n={language.instance}><Harness /></I18nextProvider>);
  const opener = screen.getByRole("button", { name: "Search" });
  opener.focus(); fireEvent.click(opener);
  return { choose, opener };
}

describe("task command palette", () => {
  it("leaves IME navigation and confirmation to the composing input", async () => {
    const { choose } = await show();
    const field = screen.getByRole("combobox");
    const first = screen.getAllByRole("option")[0]!;
    fireEvent.keyDown(field, { key: "ArrowDown", isComposing: true });
    expect(field.getAttribute("aria-activedescendant")).toBe(first.id);
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(choose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(choose).toHaveBeenCalledWith("task-1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("scrolls the active option into view when keyboard selection wraps without moving input focus", async () => {
    await show(Array.from({ length: 24 }, (_, index) => task({ taskId: "task-" + index, displayName: "Task " + index })));
    const field = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    await waitFor(() => expect(document.activeElement).toBe(field));
    scrollIntoView.mockClear();
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.getAttribute("aria-activedescendant")).toBe(options.at(-1)!.id);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(options.at(-1));
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(options[0]);
    expect(document.activeElement).toBe(field);
  });

  it("moves the active option with arrows and chooses it with Enter", async () => {
    const { choose, opener } = await show();
    const field = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    expect(field.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(choose).toHaveBeenCalledWith("task-2");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("filters by readable names and leaves Enter inert for an empty result", async () => {
    const { choose } = await show();
    const field = screen.getByRole("combobox");
    fireEvent.change(field, { target: { value: "chips" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toBe("Filter chips");
    fireEvent.change(field, { target: { value: "no such task" } });
    expect(screen.getByRole("status").textContent).toBe("No matching tasks");
    expect(field.getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(choose).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
  });
});
