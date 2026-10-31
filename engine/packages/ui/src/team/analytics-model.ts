import type { TeamOwnerRead, TeamRole } from "@openrig/daemon/team-control";

/**
 * Slice C — what Analytics can say from the read model alone.
 *
 * Every number here is derived from a durable row the read model publishes, and every one can
 * be `null`. A `null` means "the producer never observed this", which is a different fact from
 * zero, so the screen renders an em dash and never a fabricated series point.
 */

export const ANALYTICS_RANGES = ["run", "7d"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** One calendar day of observed token usage, in UTC so the bucket boundary is unambiguous. */
export interface TokenDay { day: string; input: number; output: number }

/** One bar of observed cost by the model an attempt reported. */
export interface ModelCost { model: string; costUsd: number }

/** One row of the utilization table. */
export interface AgentUsage {
  role: TeamRole;
  /** The providers the role's attempts ran on; empty when no attempt was recorded. */
  providers: string[];
  activeMs: number | null;
  tasks: number;
  attempts: number;
  retries: number;
  costUsd: number | null;
}

export interface AnalyticsSummary {
  tokens: number | null;
  costUsd: number | null;
  medianTaskMs: number | null;
  successRate: number | null;
  retryRate: number | null;
}

const TERMINAL_TASKS = ["done", "failed", "denied", "canceled", "handed-off"];

/**
 * The earliest instant the range covers. "This run" is the run's whole recorded history, so it
 * has no floor: an attempt the run recorded belongs to it however long ago it was. "Last 7
 * days" is a rolling window from now, which is the only range where wall-clock time decides
 * what is in scope.
 */
function windowFloor(range: AnalyticsRange, now: number): number {
  return range === "7d" ? now - 7 * 86_400_000 : Number.NEGATIVE_INFINITY;
}

/** The UTC day key of an instant, so a bucket is a calendar day rather than a 24-hour drift. */
function dayKey(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/**
 * Token usage per day, from the attempts' own recorded usage.
 *
 * A day appears only when at least one attempt that day published both token counts; a day
 * whose attempts all report "not observed" is left out rather than plotted as zero, because a
 * zero point would claim the run spent nothing that day. `null` when no day has a value.
 */
export function tokenSeries(read: TeamOwnerRead, range: AnalyticsRange, now: number): TokenDay[] | null {
  const floor = windowFloor(range, now);
  const byDay = new Map<string, TokenDay>();
  for (const attempt of read.attempts) {
    const at = Date.parse(attempt.createdAt);
    if (!Number.isFinite(at) || at < floor) continue;
    const input = attempt.usage.inputTokens.value, output = attempt.usage.outputTokens.value;
    if (input === null || output === null) continue;
    const key = dayKey(at);
    const day = byDay.get(key) ?? { day: key, input: 0, output: 0 };
    day.input += input; day.output += output;
    byDay.set(key, day);
  }
  if (byDay.size === 0) return null;
  return [...byDay.values()].sort((left, right) => (left.day < right.day ? -1 : 1));
}

/**
 * Observed cost by model.
 *
 * The read model publishes a provider, not a model id, and the run's binding does not record
 * which model a seat was configured with. Grouping by provider is therefore the finest honest
 * grouping available; inventing a model name per provider would state a fact no row holds.
 */
export function costByModel(read: TeamOwnerRead): ModelCost[] | null {
  const byModel = new Map<string, number>();
  for (const attempt of read.attempts) {
    const cost = attempt.usage.costUsd.value;
    if (cost === null) continue;
    byModel.set(attempt.provider, (byModel.get(attempt.provider) ?? 0) + cost);
  }
  if (byModel.size === 0) return null;
  return [...byModel.entries()].map(([model, costUsd]) => ({ model, costUsd })).sort((left, right) => right.costUsd - left.costUsd);
}

/**
 * The five summary figures.
 *
 * Median task duration is over tasks whose start and finish both exist, which the read model
 * does not publish, so it stays `null`: a duration computed from "now" would measure the page,
 * not the work. Success rate counts terminal tasks that finished `done`. Retry rate uses the
 * same attempts `retryAttempts` names for the table, so the summary and the rows cannot
 * disagree about what a retry is.
 */
export function summary(read: TeamOwnerRead): AnalyticsSummary {
  const tokens = read.run.usage.inputTokens.value !== null && read.run.usage.outputTokens.value !== null
    ? read.run.usage.inputTokens.value + read.run.usage.outputTokens.value : null;
  const terminal = read.tasks.filter(task => TERMINAL_TASKS.includes(task.queueState));
  const done = terminal.filter(task => task.queueState === "done").length;
  const attempts = read.attempts.length;
  return {
    tokens,
    costUsd: read.run.usage.costUsd.value,
    medianTaskMs: null,
    successRate: terminal.length ? done / terminal.length : null,
    retryRate: attempts ? retryAttempts(read).size / attempts : null,
  };
}

/**
 * The attempts that repeated work: one whose task an earlier attempt by the same role already took.
 *
 * The role is part of the key because a task's lead wake and its implementer's work are two
 * different jobs, not a second attempt at one. The read model orders attempts by their recording
 * time, so the first attempt for a `(task, role)` pair is the work and every later one is a
 * retry of it. The retry is charged to the attempt that repeated the work, which is what lets
 * the table's per-role counts add up to the summary's rate.
 */
function retryAttempts(read: TeamOwnerRead): Set<string> {
  const seen = new Set<string>();
  const retries = new Set<string>();
  for (const attempt of read.attempts) {
    if (attempt.taskId === null) continue;
    const key = `${attempt.taskId}\0${attempt.role}`;
    if (seen.has(key)) retries.add(attempt.attemptId);
    else seen.add(key);
  }
  return retries;
}

/** Per-role utilization. Active time and cost stay unknown when any attempt of the role lacks them. */
export function utilization(read: TeamOwnerRead): AgentUsage[] {
  const roles: TeamRole[] = ["lead", "implementer", "reviewer"];
  const retries = retryAttempts(read);
  return roles.map(role => {
    const mine = read.attempts.filter(attempt => attempt.role === role);
    const active = mine.every(attempt => Number.isFinite(attempt.usage.activeMs))
      ? mine.reduce((total, attempt) => total + attempt.usage.activeMs, 0) : null;
    const costed = mine.every(attempt => attempt.usage.costUsd.value !== null);
    const tasks = new Set(mine.flatMap(attempt => (attempt.taskId === null ? [] : [attempt.taskId])));
    return {
      role,
      providers: [...new Set(mine.map(attempt => attempt.provider))],
      activeMs: mine.length && active !== null ? active : null,
      tasks: tasks.size,
      attempts: mine.length,
      retries: mine.filter(attempt => retries.has(attempt.attemptId)).length,
      costUsd: mine.length && costed ? mine.reduce((total, attempt) => total + (attempt.usage.costUsd.value ?? 0), 0) : null,
    };
  });
}

/**
 * Axis ticks for a value axis.
 *
 * The top tick is the smallest round step at or above the data's maximum, so the highest point
 * is always inside the plot and every tick is a readable number. An all-zero or empty series
 * yields no ticks rather than a fake scale from 0 to 1.
 */
export function axisTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(multiplier => multiplier * magnitude).find(candidate => candidate >= rough)!;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);
}

/** Compact token counts: 1.28M, 420K, 900. */
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** A duration as h/m/s, or an em dash when the value is unknown. */
export function duration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
