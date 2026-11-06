import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTeamThemePreference, TEAM_THEME_KEY, useThemePreference, writeTeamTheme } from "../theme.js";

let dark = false;
let query: MediaQueryList;
beforeEach(() => {
  localStorage.clear();
  dark = false;
  const events = new EventTarget();
  query = Object.assign(events, { media: "(prefers-color-scheme: dark)", onchange: null,
    addListener: vi.fn(), removeListener: vi.fn() }) as unknown as MediaQueryList;
  Object.defineProperty(query, "matches", { get: () => dark });
  vi.spyOn(window, "matchMedia").mockReturnValue(query);
});
afterEach(() => vi.restoreAllMocks());

describe("command-center appearance", () => {
  it("defaults to dark even when the operating system is light", () => {
    expect(readTeamThemePreference()).toBe("dark");
    expect(renderHook(useThemePreference).result.current.theme).toBe("dark");
  });

  it.each(["dark", "light", "system"] as const)("persists the %s preference across loads", preference => {
    writeTeamTheme(preference);
    expect(localStorage.getItem(TEAM_THEME_KEY)).toBe(preference);
    expect(readTeamThemePreference()).toBe(preference);
  });

  it("follows system changes only while the system preference is selected", () => {
    const { result } = renderHook(useThemePreference);
    act(() => result.current.setPreference("system"));
    expect(result.current.theme).toBe("light");
    act(() => { dark = true; query.dispatchEvent(new Event("change")); });
    expect(result.current.theme).toBe("dark");
    act(() => result.current.setPreference("light"));
    act(() => { dark = false; query.dispatchEvent(new Event("change")); dark = true; query.dispatchEvent(new Event("change")); });
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem(TEAM_THEME_KEY)).toBe("light");
  });

  it("uses dark for an obsolete or invalid stored preference", () => {
    localStorage.setItem(TEAM_THEME_KEY, "ink");
    expect(readTeamThemePreference()).toBe("dark");
  });
});
