// Coverage for the retained mobile navigation and responsive visibility.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AppShell } from "../src/components/AppShell.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify([]));
    if (url.includes("/api/rigs/ps")) return new Response(JSON.stringify([]));
    if (url.includes("/api/inventory")) return new Response(JSON.stringify([]));
    if (url.includes("/api/config")) return new Response("not implemented", { status: 404 });
    return new Response("[]");
  });
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  window.localStorage.clear();
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
});

async function renderAt(initialPath: string, viewportWidth: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: viewportWidth,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
  const result = render(
    createAppTestRouter({
      routes: [
        { path: "$", component: () => null },
      ],
      rootComponent: ({ children }) => <AppShell>{children}</AppShell>,
      initialPath,
    }),
  );
  await waitFor(() => {
    expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
  }, { timeout: 5000 });
  return result;
}

describe("MobileBottomNav P5-9 — universal-shell.md L135 + L144", () => {
  it("renders the retained Project slot at mobile viewport", async () => {
    const { container } = await renderAt("/", 375);
    const nav = container.querySelector("[data-testid='mobile-bottom-nav']");
    expect(nav).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-for-you']")).toBeNull();
    expect(container.querySelector("[data-testid='mobile-nav-project']")).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-topology']")).toBeNull();
  });

  it("does NOT render Talk / advisor / operator slots (V2 deferred per L144)", async () => {
    const { container } = await renderAt("/", 375);
    expect(container.querySelector("[data-testid='mobile-nav-advisor']")).toBeNull();
    expect(container.querySelector("[data-testid='mobile-nav-operator']")).toBeNull();
    expect(container.querySelector("[data-testid='mobile-nav-talk']")).toBeNull();
    // Source-assertion: AppShell.tsx mobile-bottom-nav block must not
    // mention "advisor" or "operator" or "talk" in slot ids.
    const src = readFileSync(
      path.resolve(__dirname, "../src/components/AppShell.tsx"),
      "utf8",
    );
    const navBlock = src.match(/MobileBottomNav[\s\S]*?^}/m)?.[0] ?? "";
    expect(navBlock).not.toMatch(/id:\s*"(advisor|operator|talk)"/);
  });

  it("active route highlights the matching mobile nav slot", async () => {
    const { container } = await renderAt("/project", 375);
    const project = container.querySelector("[data-testid='mobile-nav-project']");
    expect(project?.getAttribute("data-active")).toBe("true");
  });

  it("nav element carries lg:hidden so desktop never shows it (CSS-source contract)", async () => {
    const { container } = await renderAt("/", 375);
    const nav = container.querySelector("[data-testid='mobile-bottom-nav']");
    expect(nav?.className).toMatch(/lg:hidden/);
  });
});
