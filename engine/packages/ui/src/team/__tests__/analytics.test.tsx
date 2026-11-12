import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamAnalytics } from "@multi-agent/daemon/team-control";
import { AnalyticsScreen } from "../analytics.js";
import { TokenChart, ModelTokenChart } from "../analytics-charts.js";
import { axisTicks, compactCount, duration } from "../analytics-model.js";
import { seats } from "./fixtures.js";

const request = vi.fn();
vi.mock("../../hooks/useOwnerSession.js", () => ({ useOwnerSession: () => ({ paired: true, request }) }));
let cache: QueryClient, analytics: TeamAnalytics;
beforeEach(() => {
  const bucket = { inputTokens: 1200, cacheReadInputTokens: 200, cacheWriteInputTokens: 300, outputTokens: 300,
    reasoningOutputTokens: 50, tokens: 2000, attempts: 2, measuredAttempts: 2, partialAttempts: 0, activeMs: 60_000 };
  analytics = { window: { from: "2026-11-01T00:00:00.000Z", through: "2026-11-07T12:00:00.000Z", timeZone: "UTC" },
    population: "Captured stopped attempts", totals: { ...bucket, succeeded: 1, failed: 1, canceled: 0, unknown: 0,
      retryCount: 1, outcomeAttempts: 2, successRate: 0.5, retryRate: 0.5, medianDurationMs: 30_000 },
    tasks: { total: 2, byState: { done: 1, failed: 1 } },
    byDay: [{ day: "2026-11-06", ...bucket }], byModel: [{ model: "native-model", ...bucket }], bySeat: [{ seat: "impl@rig", ...bucket }],
  };
  request.mockReset().mockImplementation(async () => ({ analytics }));
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); cache.clear(); vi.restoreAllMocks(); });
async function show(child?: React.ReactNode, locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  return render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    {child ?? <AnalyticsScreen teamId="rig/name" seats={seats} />}
  </I18nextProvider></QueryClientProvider>);
}

describe("native command-center analytics", () => {
  it("renders native totals, charts and active-time utilization without monetary figures", async () => {
    await show();
    const summary = screen.getByRole("region", { name: "Usage summary" });
    expect(await within(summary).findByText("2K")).toBeTruthy();
    expect(within(summary).getByText("500")).toBeTruthy();
    expect(within(summary).getByText("300")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Token usage over time" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Tokens by model" })).toBeTruthy();
    expect(screen.getByText("Implementer · Codex")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getAllByText("50%")).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/cost|expense|USD|\$/i);
  });

  it("changes the real request range and keeps the selected team scope", async () => {
    await show();
    await waitFor(() => expect(request).toHaveBeenCalledWith("/analytics?days=7&team=rig%2Fname", expect.anything()));
    fireEvent.change(screen.getByRole("combobox", { name: "Range" }), { target: { value: "30" } });
    await waitFor(() => expect(request).toHaveBeenCalledWith("/analytics?days=30&team=rig%2Fname", expect.anything()));
  });

  it("preserves unavailable counters and exposes partial measurement", async () => {
    Object.assign(analytics.totals, { tokens: null, inputTokens: null, cacheReadInputTokens: null, cacheWriteInputTokens: null,
      outputTokens: null, measuredAttempts: 0, partialAttempts: 0, successRate: null, retryRate: null });
    analytics.byDay = []; analytics.byModel = []; analytics.bySeat = [];
    await show();
    expect(await screen.findByText("Usage captured for 0 of 2 attempts; some counters are incomplete.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Usage summary" })).getAllByText("—")).toHaveLength(4);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not draw across an unmeasured day", async () => {
    const view = await show(<TokenChart series={[
      { day: "2026-11-05", tokens: 100, attempts: 1 }, { day: "2026-11-06", tokens: null, attempts: 1 },
      { day: "2026-11-07", tokens: 300, attempts: 1 },
    ]} />);
    expect(view.container.querySelectorAll(".ui-chart-point")).toHaveLength(2);
    expect(view.container.querySelectorAll(".ui-chart-line")).toHaveLength(0);
  });

  it("sizes both chart viewports to their container so mobile labels retain their font size", async () => {
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 324 } as DOMRect);
    const view = await show(<><TokenChart series={Array.from({ length: 30 }, (_, index) => ({
      day: `2026-10-${String(index + 1).padStart(2, "0")}`, tokens: index * 100, attempts: 1,
    }))} /><ModelTokenChart rows={[{ label: "native-model", tokens: 1000 }]} /></>);
    for (const chart of view.container.querySelectorAll("svg")) expect(chart.getAttribute("viewBox")).toBe("0 0 324 220");
    const dates = [...view.container.querySelectorAll("text")].filter(node => /^10-\d{2}$/.test(node.textContent ?? ""));
    expect(dates).toHaveLength(3);
    expect(dates.map(node => node.textContent)).toEqual(["10-01", "10-16", "10-30"]);
  });

  it("shows request failure rather than cached figures", async () => {
    request.mockRejectedValue(new Error("offline")); await show();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Usage could not be loaded.");
    expect(within(screen.getByRole("region", { name: "Usage summary" })).getAllByText("—")).toHaveLength(4);
  });

  it("localizes restored analytics", async () => {
    await show(undefined, "zh-CN");
    expect(await screen.findByRole("img", { name: "按模型统计的 Token" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/analytics\.|role\./);
  });

  it("retains readable chart scales and unknown durations", () => {
    expect(axisTicks(0)).toEqual([]);
    expect(axisTicks(421).at(-1)).toBeGreaterThanOrEqual(421);
    expect(compactCount(1_280_000)).toBe("1.28M");
    expect(duration(null)).toBe("—"); expect(duration(65_000)).toBe("1m 5s");
  });
});
