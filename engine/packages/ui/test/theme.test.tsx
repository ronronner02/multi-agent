// OPR.0.4.3.29 — dashboard theming: registry + resolution + persistence + no-FOUC
// contract + provider/selector behavior. Proves the AC-level guarantees:
//  - switch applies (the .dark class toggles on <html>) and persists across reload
//  - light is the default look; dark is a selectable new theme
//  - first load with no stored choice follows the OS (system) — the pre-paint path
//  - an explicit choice wins over the OS
//  - extensibility: the selector is registry-driven (adding a theme is data-only)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  THEME_STORAGE_KEY,
  THEMES,
  DEFAULT_THEME,
  readStoredTheme,
  writeStoredTheme,
  resolveTheme,
  applyTheme,
} from "../src/lib/theme.js";
import { ThemeProvider, useTheme } from "../src/components/ThemeProvider.js";

/** Override window.matchMedia so `(prefers-color-scheme: dark)` reports `osDark`. */
function mockOsDark(osDark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("dark") ? osDark : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("theme lib — registry + resolution", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    mockOsDark(false);
  });
  afterEach(cleanup);

  it("registry ships light + dark + system", () => {
    const ids = THEMES.map((t) => t.id);
    expect(ids).toEqual(["light", "dark", "system"]);
  });

  it("default is `system` when nothing is stored", () => {
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe("system");
  });

  it("reads an explicit stored choice; ignores malformed values", () => {
    writeStoredTheme("dark");
    expect(readStoredTheme()).toBe("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "chartreuse");
    expect(readStoredTheme()).toBe("system"); // falls back to default
  });

  it("`system` follows the OS; explicit light/dark ignore it", () => {
    mockOsDark(true);
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light"); // explicit wins over OS-dark
    mockOsDark(false);
    expect(resolveTheme("system")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark"); // explicit wins over OS-light
  });

  it("applyTheme toggles the .dark class on <html>", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    mockOsDark(true);
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

function Probe() {
  const { theme, resolved } = useTheme();
  return (
    <span data-testid="probe">
      {theme}:{resolved}
    </span>
  );
}

describe("ThemeProvider + ThemeSelector", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    mockOsDark(false);
  });
  afterEach(cleanup);

  it("first load with no stored choice + OS dark → renders dark (no explicit choice)", () => {
    mockOsDark(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("system:dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("an explicit stored choice wins over the OS", () => {
    writeStoredTheme("light");
    mockOsDark(true); // OS says dark, stored says light
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("light:light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

});
