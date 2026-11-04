import type {
  ManagedWorkerHealthEvidence, TeamAttemptHealth, TeamHealthLight, TeamHealthLightName,
  TeamHealthState, TeamSystemHealth,
} from "../contracts/team-control.js";
import { TEAM_HEALTH_LIGHTS, TEAM_SYSTEM_HEALTH_VERSION } from "../contracts/team-control.js";

export const SYSTEM_HEALTH_PROBE_TIMEOUT_MS = 5_000;
export const SYSTEM_HEALTH_TOTAL_TIMEOUT_MS = 30_000;

export interface SystemHealthProbeResult {
  state: TeamHealthState;
  evidenceRef?: string | null;
  reason?: string | null;
}
export type SystemHealthProbe = (signal?: AbortSignal) => SystemHealthProbeResult | Promise<SystemHealthProbeResult>;
export type SystemHealthAttemptsProbe = (signal?: AbortSignal) => Record<string, TeamAttemptHealth> | Promise<Record<string, TeamAttemptHealth>>;
export interface SystemHealthSources {
  database?: SystemHealthProbe;
  queueMailbox?: SystemHealthProbe;
  controlTmux?: SystemHealthProbe;
  workerBoundary?: SystemHealthProbe;
  sandboxNetwork?: SystemHealthProbe;
  clients?: SystemHealthProbe;
  latestAttempts?: SystemHealthAttemptsProbe;
  /**
   * The `workers.isolation` level this process resolved at startup. It is a fact the daemon
   * decided, not a probe: a reader asking the daemon what it runs under gets the level the
   * launch chain is actually using. Absent leaves the runtime block out, which a client shows
   * as unknown rather than as the setting's default.
   */
  isolation?: "none" | "hardened";
  now?: () => Date;
  timeoutMs?: number;
}
type BoundedResult<T> = { kind: "value"; value: T } | { kind: "timeout" } | { kind: "error" };

function state(value: unknown): TeamHealthState {
  return value === "ok" || value === "degraded" || value === "failed" || value === "unknown" ? value : "unknown";
}
function checkedAt(now: () => Date): string {
  const value = now();
  return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
}
function light(now: () => Date, result: unknown): TeamHealthLight {
  if (!result || typeof result !== "object" || Array.isArray(result)) return unknownLight(now, "probe_invalid_result");
  const value = result as Partial<SystemHealthProbeResult>;
  if (!["ok", "degraded", "failed", "unknown"].includes(value.state ?? "")) return unknownLight(now, "probe_invalid_result");
  return { state: state(value.state), checkedAt: checkedAt(now),
    evidenceRef: typeof value.evidenceRef === "string" ? value.evidenceRef : null,
    reason: typeof value.reason === "string" ? value.reason : null };
}
function unknownLight(now: () => Date, reason: string): TeamHealthLight {
  return { state: "unknown", checkedAt: checkedAt(now), evidenceRef: null, reason };
}
function failedLight(now: () => Date, reason: string): TeamHealthLight {
  return { state: "failed", checkedAt: checkedAt(now), evidenceRef: null, reason };
}
function overall(lights: Record<TeamHealthLightName, TeamHealthLight>, latestAttemptsUnavailable = false): TeamHealthState {
  const values = Object.values(lights).map(value => value.state);
  if (values.includes("failed")) return "failed";
  if (values.includes("unknown") || latestAttemptsUnavailable) return "unknown";
  if (values.includes("degraded")) return "degraded";
  return "ok";
}
async function bounded<T>(run: (signal: AbortSignal) => T | Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)).then(value => ({ kind: "value" as const, value })),
      new Promise<{ kind: "timeout" }>(resolve => {
        timer = setTimeout(() => {
          resolve({ kind: "timeout" });
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch {
    return { kind: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function probeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.min(SYSTEM_HEALTH_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(value!)))
    : SYSTEM_HEALTH_PROBE_TIMEOUT_MS;
}
async function runProbe(now: () => Date, name: TeamHealthLightName, probe: SystemHealthProbe | undefined, timeoutMs: number): Promise<TeamHealthLight> {
  if (!probe) return unknownLight(now, name + "_source_unavailable");
  const result = await bounded(async signal => light(now, await probe(signal)), timeoutMs);
  if (result.kind === "timeout") return unknownLight(now, "probe_timeout");
  if (result.kind === "error") return failedLight(now, "probe_failed");
  return result.value;
}
function attemptsFromEvidence(now: () => Date, evidence: ManagedWorkerHealthEvidence | null): Record<string, TeamAttemptHealth> {
  if (!evidence) return {};
  return Object.fromEntries(evidence.attempts.map(attempt => [attempt.attemptId, {
    attemptId: attempt.attemptId, runId: attempt.runId, worker: attempt.worker, client: attempt.client,
    state: attempt.state, reasonCode: null, resumeSafe: null,
    checkedAt: evidence.observedAt || checkedAt(now), evidenceRef: attempt.evidenceRef,
  }]));
}

/**
 * T033 — the health projection of an attempt, carrying the KTD20 decision the classifier
 * recorded with its stop.
 *
 * This is the same read the owner's Tasks screen makes, through the governance owner, so a
 * health light and a task card cannot disagree about why an attempt failed. An attempt still
 * running, or one that ended cleanly, has no code and says so with `null` rather than a guess.
 * The caller names which attempts it publishes, so this never invents a scope of its own.
 */
export function attemptsFromRecords(now: () => Date, records: ReadonlyArray<{
  id: string; runId: string; provider: "claude" | "codex"; state: string;
  failure: { reasonCode: string; resumeSafe: boolean } | null;
}>): Record<string, TeamAttemptHealth> {
  return Object.fromEntries(records.map(attempt => [attempt.id, {
    attemptId: attempt.id, runId: attempt.runId, worker: null,
    client: attempt.provider === "codex" ? "codex" as const : "claude-code" as const, state: attempt.state,
    reasonCode: attempt.failure?.reasonCode ?? null, resumeSafe: attempt.failure?.resumeSafe ?? null,
    checkedAt: checkedAt(now), evidenceRef: "team_attempts:" + attempt.id,
  }]));
}
function validAttempts(value: unknown): value is Record<string, TeamAttemptHealth> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([key, entry]) => !!entry && typeof entry === "object"
      && entry.attemptId === key && typeof entry.runId === "string"
      && (entry.worker === null || typeof entry.worker === "string")
      && (entry.client === null || entry.client === "claude-code" || entry.client === "codex")
      && typeof entry.state === "string" && (entry.reasonCode === null || typeof entry.reasonCode === "string")
      && (entry.resumeSafe === null || typeof entry.resumeSafe === "boolean")
      && typeof entry.checkedAt === "string" && Number.isFinite(Date.parse(entry.checkedAt))
      && (entry.evidenceRef === null || typeof entry.evidenceRef === "string"));
}
export function unknownSystemHealth(
  now: () => Date = () => new Date(), timeoutMs = SYSTEM_HEALTH_PROBE_TIMEOUT_MS, reason?: string,
): TeamSystemHealth {
  const lights = Object.fromEntries(TEAM_HEALTH_LIGHTS.map(name => [name,
    unknownLight(now, reason ?? name + "_source_unavailable")])) as Record<TeamHealthLightName, TeamHealthLight>;
  return { schema: "multi-agent-system-health/v1", protocolVersion: TEAM_SYSTEM_HEALTH_VERSION,
    checkedAt: checkedAt(now), timeoutMs, overall: "unknown", lights, latestAttempts: {} };
}
export async function readSystemHealth(sources: SystemHealthSources): Promise<TeamSystemHealth> {
  const now = sources.now ?? (() => new Date()), timeoutMs = probeTimeout(sources.timeoutMs);
  const [probeResults, attemptsResult] = await Promise.all([
    Promise.all(TEAM_HEALTH_LIGHTS.map(async name => [name, await runProbe(now, name, sources[name], timeoutMs)] as const)),
    sources.latestAttempts ? bounded(signal => sources.latestAttempts!(signal), timeoutMs) : null,
  ]);
  const lights = Object.fromEntries(probeResults) as Record<TeamHealthLightName, TeamHealthLight>;
  const attemptsValid = attemptsResult?.kind === "value" && validAttempts(attemptsResult.value);
  const latestAttempts = attemptsValid ? attemptsResult.value : {};
  return { schema: "multi-agent-system-health/v1", protocolVersion: TEAM_SYSTEM_HEALTH_VERSION,
    checkedAt: checkedAt(now), timeoutMs, overall: overall(lights, attemptsResult !== null && !attemptsValid), lights, latestAttempts,
    ...(sources.isolation ? { runtime: { isolation: sources.isolation } } : {}) };
}
export function createSystemHealthReader(sources: SystemHealthSources): () => Promise<TeamSystemHealth> {
  return () => readSystemHealth(sources);
}
function validHealth(value: unknown): value is TeamSystemHealth {
  if (!value || typeof value !== "object") return false;
  const result = value as TeamSystemHealth;
  if (result.schema !== "multi-agent-system-health/v1" || result.protocolVersion !== TEAM_SYSTEM_HEALTH_VERSION
    || typeof result.checkedAt !== "string" || !Number.isFinite(Date.parse(result.checkedAt))
    || !Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0 || result.timeoutMs > SYSTEM_HEALTH_PROBE_TIMEOUT_MS
    || !["ok", "degraded", "failed", "unknown"].includes(result.overall) || !result.lights || !validAttempts(result.latestAttempts)) return false;
  // The runtime block is optional, and a present one must name a level the launch chain has.
  if (result.runtime !== undefined && (result.runtime === null || typeof result.runtime !== "object"
    || !["none", "hardened"].includes(String(result.runtime.isolation)))) return false;
  if (!TEAM_HEALTH_LIGHTS.every(name => {
    const entry = result.lights[name];
    return !!entry && ["ok", "degraded", "failed", "unknown"].includes(entry.state)
      && typeof entry.checkedAt === "string" && Number.isFinite(Date.parse(entry.checkedAt))
      && (entry.evidenceRef === null || typeof entry.evidenceRef === "string")
      && (entry.reason === null || typeof entry.reason === "string");
  })) return false;
  const expected = overall(result.lights);
  return result.overall === expected || (result.overall === "unknown" && expected !== "failed");
}
export async function readSystemHealthBounded(
  reader: (() => TeamSystemHealth | Promise<TeamSystemHealth>) | undefined,
  now: () => Date = () => new Date(), timeoutMs = SYSTEM_HEALTH_TOTAL_TIMEOUT_MS,
): Promise<TeamSystemHealth> {
  if (!reader) return unknownSystemHealth(now);
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(SYSTEM_HEALTH_TOTAL_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs))) : SYSTEM_HEALTH_TOTAL_TIMEOUT_MS;
  const result = await bounded(async () => {
    const value = await reader();
    return validHealth(value) ? value : unknownSystemHealth(now, SYSTEM_HEALTH_PROBE_TIMEOUT_MS, "health_invalid_result");
  }, limit);
  return result.kind === "value" ? result.value
    : unknownSystemHealth(now, SYSTEM_HEALTH_PROBE_TIMEOUT_MS, result.kind === "timeout" ? "health_timeout" : "health_reader_failed");
}
export function attemptsFromManagedWorkerEvidence(now: () => Date, evidence: ManagedWorkerHealthEvidence | null): Record<string, TeamAttemptHealth> {
  return attemptsFromEvidence(now, evidence);
}
