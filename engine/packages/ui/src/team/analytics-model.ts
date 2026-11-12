import type { TeamAnalytics } from "@multi-agent/daemon/team-control";

export const ANALYTICS_RANGES = [7, 30] as const;
export type AnalyticsRange = typeof ANALYTICS_RANGES[number];
export type TokenDay = Pick<TeamAnalytics["byDay"][number], "day" | "tokens" | "attempts">;

/** Restored chart scale: every observed value fits under a readable top tick. */
export function axisTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(multiplier => multiplier * magnitude).find(candidate => candidate >= rough)!;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);
}

export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function duration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export const percent = (value: number | null): string => value === null ? "—" : `${Math.round(value * 100)}%`;
export const count = (value: number | null | undefined): string => value == null ? "—" : compactCount(value);
export function cachedTokens(data: TeamAnalytics["totals"] | undefined): number | null {
  if (!data || (data.cacheReadInputTokens === null && data.cacheWriteInputTokens === null)) return null;
  return (data.cacheReadInputTokens ?? 0) + (data.cacheWriteInputTokens ?? 0);
}
