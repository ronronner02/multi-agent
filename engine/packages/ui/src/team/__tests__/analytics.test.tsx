import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createInterfaceI18n, type InterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { AnalyticsScreen } from "../analytics.js";
import { axisTicks, compactCount, costByModel, duration, summary, tokenSeries, utilization } from "../analytics-model.js";
import { attempt, read, run, task } from "./fixtures.js";

/**
 * Slice C — Analytics.
 *
 * Two rules are pinned here: a figure the read model never observed is an em dash, not a zero,
 * and the chart's scale comes from the data it is drawn from, so a tick can never sit below the
 * highest point or above a round number.
 */

const observed = (input: number, output: number, cost: number, activeMs: number) => ({
  activeMs, inputTokens: { value: input, reason: null }, outputTokens: { value: output, reason: null },
  costUsd: { value: cost, reason: null },
});

/** A run with two days of recorded usage across all three roles. */
function full(): TeamOwnerRead {
  return read({
    tasks: [task({ taskId: "T-101", qitemId: "q-T-101", queueState: "done" }),
      task({ taskId: "T-102", qitemId: "q-T-102", queueState: "failed" }),
      task({ taskId: "T-103", qitemId: "q-T-103", queueState: "in-progress" })],
    attempts: [
      attempt({ attemptId: "a1", role: "lead", provider: "codex", taskId: "T-101", qitemId: "q-T-101",
        createdAt: "2026-10-30T09:00:00.000Z", usage: observed(100_000, 20_000, 1.5, 600_000) }),
      attempt({ attemptId: "a2", role: "implementer", taskId: "T-101", qitemId: "q-T-101",
        createdAt: "2026-10-30T10:00:00.000Z", usage: observed(200_000, 40_000, 3, 1_200_000) }),
      attempt({ attemptId: "a3", role: "implementer", taskId: "T-102", qitemId: "q-T-102",
        createdAt: "2026-10-31T08:00:00.000Z", usage: observed(150_000, 30_000, 2.25, 900_000) }),
      // A second implementer attempt at T-102: the one recorded retry.
      attempt({ attemptId: "a4", taskId: "T-102", qitemId: "q-T-102",
        createdAt: "2026-10-31T09:00:00.000Z", usage: observed(25_000, 5_000, 0.75, 300_000) }),
      attempt({ attemptId: "a5", role: "reviewer", taskId: "T-102", qitemId: "q-T-102",
        createdAt: "2026-10-31T11:00:00.000Z", usage: observed(50_000, 10_000, 0.5, 300_000) }),
    ],
    run: { ...run, usage: { activeMs: 3_000_000, inputTokens: { value: 500_000, reason: null },
      outputTokens: { value: 100_000, reason: null }, costUsd: { value: 7.5, reason: null } } },
  });
}

async function show(value: TeamOwnerRead | undefined, locale: "en" | "zh-CN" = "en"): Promise<InterfaceI18n> {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  render(<I18nextProvider i18n={language.instance}>
    <div className="team-shell"><AnalyticsScreen read={value} runId={value?.runId ?? ""} /></div>
  </I18nextProvider>);
  return language;
}

describe("analytics figures", () => {
  it.each(["en", "zh-CN"] as const)("shows every unobserved figure as an em dash, never zero (%s)", async locale => {
    // A run whose producers observed nothing: no usage, no attempt, and no terminal task.
    const language = await show(read({ run: { ...run, usage: { activeMs: 0, inputTokens: { value: null, reason: "not observed" },
      outputTokens: { value: null, reason: "not observed" }, costUsd: { value: null, reason: "not observed" } } },
      tasks: [task({ queueState: "in-progress" })] }), locale);
    const band = screen.getByRole("region", { name: language.t("analytics.summary") });
    const cell = (key: string) => within(band).getByText(language.t(key as "analytics.tokens")).parentElement!;
    // The fixture run published no usage and no terminal task, so nothing is measurable.
    expect(within(cell("analytics.tokens")).getByText("—")).toBeTruthy();
    expect(within(cell("analytics.cost")).getByText("—")).toBeTruthy();
    expect(within(cell("analytics.median")).getByText("—")).toBeTruthy();
    expect(within(cell("analytics.success")).getByText("—")).toBeTruthy();
    expect(within(cell("analytics.retry")).getByText("—")).toBeTruthy();
    expect(within(band).queryByText("$0.00")).toBeNull();
    expect(within(band).queryByText("0%")).toBeNull();
    // A run with no recorded attempt has no series, and the panel says so instead of drawing one.
    expect(screen.getByText(language.t("analytics.noSeries"))).toBeTruthy();
    expect(screen.getByText(language.t("analytics.noCost"))).toBeTruthy();
  });

  it("shows the observed totals, rates and per-role utilization", async () => {
    const language = await show(full());
    const band = screen.getByRole("region", { name: language.t("analytics.summary") });
    const cell = (key: string) => within(band).getByText(language.t(key as "analytics.tokens")).parentElement!;
    expect(within(cell("analytics.tokens")).getByText("600K")).toBeTruthy();
    expect(within(cell("analytics.cost")).getByText("$7.50")).toBeTruthy();
    // Two of three tasks reached a terminal state, one of them done.
    expect(within(cell("analytics.success")).getByText("50%")).toBeTruthy();
    // One of five attempts repeated work its role had already taken on the same task.
    expect(within(cell("analytics.retry")).getByText("20%")).toBeTruthy();
    const table = screen.getByRole("region", { name: language.t("analytics.utilization") });
    const row = (role: string) => table.querySelector(`[data-agent="${role}"]`)!;
    expect(row("lead").textContent).toContain("codex");
    expect(row("lead").textContent).toContain("10m 0s");
    expect(row("implementer").textContent).toContain("claude");
    expect(row("implementer").textContent).toContain("40m 0s");
    expect(row("implementer").textContent).toContain("$6.00");
    // The retry is charged to the role that repeated the work, which is where it happened.
    expect(row("implementer").textContent).toContain("1");
    // The lead never retried anything; a recorded zero is a measured result and shows as 0.
    expect(row("lead").textContent).toContain("$1.50");
  });

  it("shows an unknown usage cell for a role that recorded nothing, never a zero", async () => {
    const value = read({ attempts: [attempt({ role: "lead", usage: observed(1_000, 1_000, 0.1, 60_000) })] });
    const language = await show(value);
    const table = screen.getByRole("region", { name: language.t("analytics.utilization") });
    const reviewer = table.querySelector('[data-agent="reviewer"]')!;
    // No attempt at all: runtime, tasks, retries and cost are all unknown, not zero.
    expect(reviewer.textContent).toContain("—");
    expect(reviewer.textContent).not.toContain("$0.00");
  });

  it("keeps the model list honest: it groups by the provider the rows record", () => {
    const rows = costByModel(full());
    expect(rows).toEqual([{ model: "claude", costUsd: 6.5 }, { model: "codex", costUsd: 1.5 }]);
    expect(costByModel(read())).toBeNull();
  });

  it("leaves out a day whose attempts recorded no token counts", () => {
    const value = read({ attempts: [attempt({ createdAt: "2026-10-31T00:00:00.000Z" })] });
    expect(tokenSeries(value, "run", Date.parse("2026-10-31T12:00:00.000Z"))).toBeNull();
    const counted = read({ attempts: [attempt({ createdAt: "2026-10-31T00:00:00.000Z", usage: observed(10, 5, 0, 0) })] });
    expect(tokenSeries(counted, "run", Date.parse("2026-10-31T12:00:00.000Z")))
      .toEqual([{ day: "2026-10-31", input: 10, output: 5 }]);
  });

  it("keeps the summary and the table agreeing about what a retry is", () => {
    const value = full();
    const figures = summary(value);
    const rows = utilization(value);
    const retries = rows.reduce((total, row) => total + row.retries, 0);
    expect(retries).toBe(1);
    expect(figures.retryRate).toBe(retries / value.attempts.length);
  });
});

describe("analytics chart scale", () => {
  it("puts the top tick at or above the data and every tick on a round step", () => {
    expect(axisTicks(0)).toEqual([]);
    expect(axisTicks(Number.NaN)).toEqual([]);
    for (const max of [1, 3, 7, 128_000, 400_000, 1_280_000]) {
      const ticks = axisTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)!).toBeGreaterThanOrEqual(max);
      const step = ticks[1]! - ticks[0]!;
      expect(ticks.every((tick, index) => tick === index * step)).toBe(true);
      // A round step: its leading digit is one of the ones a reader counts in.
      expect([1, 2, 2.5, 5].some(lead => Math.abs(step / 10 ** Math.floor(Math.log10(step)) - lead) < 1e-9)).toBe(true);
    }
  });

  it("draws ticks that cover the plotted maximum", async () => {
    const language = await show(full());
    const panel = screen.getByRole("region", { name: language.t("analytics.tokensOverTime") });
    const labels = [...panel.querySelectorAll("text.ui-chart-tick")].map(node => node.textContent);
    // The highest day is 360K, so the top tick is 400K and every point sits inside the plot.
    expect(labels).toContain("400K");
    const costs = screen.getByRole("region", { name: language.t("analytics.costByModel") });
    const costLabels = [...costs.querySelectorAll("text.ui-chart-tick")].map(node => node.textContent);
    // The highest bar is $6.00, which is itself a tick.
    expect(costLabels).toContain("$6");
  });

  it("formats durations and counts without inventing precision", () => {
    expect(duration(null)).toBe("—");
    expect(duration(0)).toBe("0s");
    expect(duration(252_000)).toBe("4m 12s");
    expect(duration(3_720_000)).toBe("1h 2m");
    expect(compactCount(900)).toBe("900");
    expect(compactCount(1_280_000)).toBe("1.28M");
    expect(compactCount(420_000)).toBe("420K");
  });
});

describe("analytics range", () => {
  it("offers this run and the last seven days", async () => {
    const language = await show(full());
    const range = screen.getByRole("combobox", { name: new RegExp(language.t("analytics.range")) }) as HTMLSelectElement;
    expect([...range.options].map(option => option.value)).toEqual(["run", "7d"]);
    expect([...range.options].map(option => option.textContent)).toEqual([language.t("analytics.range.run"), language.t("analytics.range.7d")]);
    expect(range.value).toBe("run");
    fireEvent.change(range, { target: { value: "7d" } });
    expect(range.value).toBe("7d");
    // The same recorded attempts still produce a series in the wider window.
    expect(screen.getByRole("region", { name: language.t("analytics.tokensOverTime") }).querySelector("polyline")).toBeTruthy();
  });

  it("scopes the series to the run's whole history, and to seven days for the rolling window", () => {
    const value = full();
    const now = Date.parse("2026-10-31T12:00:00.000Z");
    // Both recorded days belong to the run, however far back they are.
    expect(tokenSeries(value, "run", Date.parse("2026-12-31T00:00:00.000Z"))?.map(day => day.day))
      .toEqual(["2026-10-30", "2026-10-31"]);
    // The rolling window drops the attempt older than seven days.
    expect(tokenSeries(value, "7d", now)?.map(day => day.day)).toEqual(["2026-10-30", "2026-10-31"]);
    expect(tokenSeries(value, "7d", Date.parse("2026-11-30T00:00:00.000Z"))).toBeNull();
  });
});
