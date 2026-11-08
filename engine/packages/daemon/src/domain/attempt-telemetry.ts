import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type Database from "better-sqlite3";
import type { TeamAttempt } from "../contracts/team-control.js";
import { agentTurnOutputPaths } from "./agent-turn.js";
import { redactTranscriptContent } from "./transcript-redaction.js";

const countKeys = ["inputTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
type CountKey = typeof countKeys[number];
type Counts = Record<CountKey, number | null>;
type EvidenceStatus = "available" | "partial" | "unavailable";
export type AttemptOutcome = "succeeded" | "failed" | "canceled" | "unknown";
export interface TurnUsage extends Counts { status: EvidenceStatus; model: string | null; reason: string | null }
export interface ToolActivityRecord {
  id: string; seq: number; at: string; tool: string; summary: string;
  status: "running" | "completed" | "failed" | "aborted";
}
export interface TurnProgress {
  sequence: number; at: string; status: "working" | "thinking" | "responding" | "completed" | "failed" | "stopped";
  blocks: Array<{ id: string; text: string; complete: boolean }>; truncated: boolean;
}
interface NativeUsage {
  nativeSessionId: string | null; model: string | null; resumed: boolean; mode: "turn" | "cumulative";
  counts: Counts | null;
}
interface AttemptMetadata { ordinal: number; startedAt: string; seat: string | null; rigId: string }
interface StoredRow {
  startedAt: string; stoppedAt: string; activeMs: number;
  usageJson: string; activityJson: string; activityStatus: EvidenceStatus; outcome: AttemptOutcome;
}
export interface AttemptActivity {
  attemptId: string; state: TeamAttempt["state"]; source: "live" | "stored" | "unavailable";
  startedAt: string; stoppedAt: string | null; activeMs: number | null; outcome: AttemptOutcome;
  usage: TurnUsage; activityStatus: EvidenceStatus; records: ToolActivityRecord[]; nextSeq: number;
}
const emptyCounts = (): Counts => Object.fromEntries(countKeys.map(key => [key, null])) as Counts;
const clean = (value: string, limit: number) => redactTranscriptContent(value).slice(0, limit);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nativeId = (value: unknown): string | null => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
const unavailableUsage = (model: string | null, reason: string): TurnUsage =>
  ({ ...emptyCounts(), model, status: "unavailable", reason });

/** These files are external observations, not an authority to follow links or read unlimited bytes. */
function readSidecar(path: string, limit: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return null;
    const bytes = Buffer.alloc(stat.size);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function parseUsage(text: string | null, provider: TeamAttempt["provider"]): NativeUsage | null {
  if (text === null) return null;
  try {
    const value = object(JSON.parse(text));
    const client = provider === "codex" ? "codex" : "claude-code", mode = provider === "codex" ? "cumulative" : "turn";
    if (!value || value.version !== 1 || value.client !== client || typeof value.resumed !== "boolean"
      || typeof value.available !== "boolean" || (value.available && value.mode !== mode)) return null;
    const native: NativeUsage = { nativeSessionId: nativeId(value.nativeSessionId),
      model: typeof value.model === "string" ? clean(value.model, 128) : null, resumed: value.resumed, mode, counts: null };
    if (!value.available) return native;
    const raw = object(value.counts);
    if (!raw) return native;
    const counts = emptyCounts();
    for (const key of countKeys) {
      const value = raw[key];
      if (value === null || value === undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return native;
      counts[key] = value;
    }
    native.counts = counts;
    return native;
  } catch { return null; }
}

function parseActivity(text: string | null): { records: ToolActivityRecord[]; status: EvidenceStatus } {
  if (text === null) return { records: [], status: "unavailable" };
  const records: ToolActivityRecord[] = [], open = new Set<string>(), settled = new Set<string>();
  let seq = 0, status: EvidenceStatus = "available";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = object(JSON.parse(line));
      if (!value || typeof value.id !== "string" || !/^call-[1-9]\d*$/.test(value.id)
        || typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq <= seq || value.seq >= Number.MAX_SAFE_INTEGER
        || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))
        || typeof value.tool !== "string" || typeof value.summary !== "string"
        || !["running", "completed", "failed", "aborted"].includes(String(value.status))) throw new Error("Invalid activity");
      seq = value.seq;
      if (settled.has(value.id) || (value.status === "running" && open.has(value.id))) throw new Error("Duplicate activity");
      if (value.status === "running") open.add(value.id); else { open.delete(value.id); settled.add(value.id); }
      records.push({ id: value.id, seq, at: new Date(value.at).toISOString(), tool: clean(value.tool, 128),
        summary: clean(value.summary, 512), status: value.status as ToolActivityRecord["status"] });
    } catch { status = "partial"; }
  }
  return { records, status };
}

export class AttemptTelemetry {
  private readonly now: () => Date;
  private readonly readFile: (path: string, limit: number) => string | null;

  constructor(private readonly db: Database.Database, private readonly options: {
    turnStateRoot?: string; now?: () => Date; readFile?: (path: string, limit: number) => string | null;
  } = {}) {
    this.now = options.now ?? (() => new Date());
    this.readFile = options.readFile ?? readSidecar;
  }

  private metadata(attemptId: string): AttemptMetadata {
    const row = this.db.prepare(`SELECT a.rowid AS ordinal, a.created_at AS startedAt,
      q.destination_session AS seat, r.rig_id AS rigId
      FROM team_attempts a JOIN team_runs r ON r.id = a.run_id
      LEFT JOIN queue_items q ON q.qitem_id = a.qitem_id WHERE a.id = ?`).get(attemptId) as AttemptMetadata | undefined;
    if (!row) throw new Error("Telemetry requires a recorded attempt");
    return row;
  }

  private stored(attemptId: string): StoredRow | undefined {
    return this.db.prepare(`SELECT started_at AS startedAt, stopped_at AS stoppedAt,
      active_ms AS activeMs, usage_json AS usageJson, activity_json AS activityJson,
      activity_status AS activityStatus, outcome FROM attempt_telemetry WHERE attempt_id = ?`).get(attemptId) as StoredRow | undefined;
  }

  private outputPaths(attempt: TeamAttempt) {
    const root = this.options.turnStateRoot;
    // An admitted id still is not a filesystem path.
    return !root || !attempt.id || /[/\\]/.test(attempt.id) || [".", ".."].includes(attempt.id)
      ? null : agentTurnOutputPaths(root, attempt.id);
  }

  /** Read only the current public snapshot; it grants no chat, document or execution authority. */
  readProgress(attempt: TeamAttempt): TurnProgress | null {
    const paths = this.outputPaths(attempt);
    if (!paths) return null;
    try {
      const text = this.readFile(paths.progress, 512 * 1024);
      if (text === null) return null;
      const value = object(JSON.parse(text));
      if (!value || value.version !== 1 || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
        || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || typeof value.truncated !== "boolean"
        || !["working", "thinking", "responding", "completed", "failed", "stopped"].includes(String(value.status))
        || !Array.isArray(value.blocks) || value.blocks.length > 32) return null;
      const ids = new Set<string>(); let length = 0;
      const blocks: TurnProgress["blocks"] = [];
      for (const input of value.blocks) {
        const block = object(input);
        if (!block || typeof block.id !== "string" || !/^text-[1-9]\d*$/.test(block.id) || ids.has(block.id)
          || typeof block.text !== "string" || typeof block.complete !== "boolean") return null;
        ids.add(block.id); length += block.text.length;
        if (length > 65_536) return null;
        blocks.push({ id: block.id, text: clean(block.text, 65_536).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""), complete: block.complete });
      }
      return { sequence: Number(value.sequence), at: new Date(value.at).toISOString(), status: value.status as TurnProgress["status"],
        blocks, truncated: value.truncated };
    } catch { return null; }
  }

  private files(attempt: TeamAttempt) {
    const paths = this.outputPaths(attempt);
    if (!paths) return { native: null, activity: parseActivity(null) };

    const read = (path: string, limit: number) => { try { return this.readFile(path, limit); } catch { return null; } };
    let native = parseUsage(read(paths.usage, 16_384), attempt.provider);
    if (attempt.provider === "codex" && !native?.nativeSessionId) {
      const thread = nativeId(read(paths.threadId, 256)?.trim());
      // The pre-existing thread sidecar survives a wrapper killed before usage publication.
      if (thread) native = { ...(native ?? { model: null, resumed: true, mode: "cumulative", counts: null }), nativeSessionId: thread };
    }
    return { native, activity: parseActivity(read(paths.activity, 4 * 1024 * 1024)) };
  }

  private turnUsage(attempt: TeamAttempt, metadata: AttemptMetadata, native: NativeUsage | null): TurnUsage {
    if (!native?.counts) return unavailableUsage(native?.model ?? null, "The native client did not report usable final usage.");
    const counts = { ...native.counts };
    if (native.mode === "cumulative" && native.resumed) {
      if (native.nativeSessionId === null) return unavailableUsage(native.model, "The resumed native thread is unknown.");
      const previous = this.db.prepare(`SELECT t.native_usage_json AS nativeUsageJson, t.native_session_id AS nativeSessionId
        FROM team_attempts a LEFT JOIN attempt_telemetry t ON t.attempt_id = a.id
        JOIN team_runs r ON r.id = a.run_id LEFT JOIN queue_items q ON q.qitem_id = a.qitem_id
        WHERE a.rowid < ? AND a.provider = ? AND (t.native_session_id = ?
          OR (t.native_session_id IS NULL AND COALESCE(t.seat_name, q.destination_session) = ? AND r.rig_id = ?))
        ORDER BY a.rowid DESC LIMIT 1`).get(metadata.ordinal, attempt.provider, native.nativeSessionId, metadata.seat, metadata.rigId) as { nativeUsageJson: string | null; nativeSessionId: string | null } | undefined;
      const baseline = previous?.nativeUsageJson ? JSON.parse(previous.nativeUsageJson) as NativeUsage : null;
      if (previous?.nativeSessionId !== native.nativeSessionId || !baseline?.counts) {
        return unavailableUsage(native.model, "The preceding native thread total is unavailable.");
      }
      for (const key of countKeys) {
        const current = counts[key], before = baseline.counts[key];
        if (current !== null && before !== null && current < before) {
          return unavailableUsage(native.model, "The native thread counters decreased.");
        }
        counts[key] = current === null || before === null ? null : current - before;
      }
    }
    const status: EvidenceStatus = counts.inputTokens !== null && counts.outputTokens !== null ? "available"
      : countKeys.some(key => counts[key] !== null) ? "partial" : "unavailable";
    return { ...counts, model: native.model, status, reason: status === "available" ? null : "Some native token counters are unavailable." };
  }

  read(attempt: TeamAttempt, after = 0): AttemptActivity {
    const metadata = this.metadata(attempt.id), stored = this.stored(attempt.id);
    let records: ToolActivityRecord[], usage: TurnUsage, activityStatus: EvidenceStatus;
    if (stored) {
      records = JSON.parse(stored.activityJson) as ToolActivityRecord[];
      usage = JSON.parse(stored.usageJson) as TurnUsage; activityStatus = stored.activityStatus;
    } else if (attempt.state === "running") {
      const files = this.files(attempt);
      records = files.activity.records; activityStatus = files.activity.status;
      usage = this.turnUsage(attempt, metadata, files.native);
    } else {
      records = []; activityStatus = "unavailable";
      usage = unavailableUsage(null, "No telemetry was captured for this stopped attempt.");
    }
    return { attemptId: attempt.id, state: attempt.state, source: stored ? "stored" : attempt.state === "running" ? "live" : "unavailable",
      startedAt: stored?.startedAt ?? metadata.startedAt, stoppedAt: stored?.stoppedAt ?? null,
      activeMs: stored?.activeMs ?? (attempt.state === "running" ? Math.max(0, this.now().getTime() - Date.parse(metadata.startedAt)) : null),
      outcome: stored?.outcome ?? "unknown", usage, activityStatus,
      nextSeq: records.at(-1)?.seq ?? 0, records: records.filter(record => record.seq > after) };
  }

  /** Capture before lifecycle release. A retry preserves the first stop time and the original evidence. */
  capture(attempt: TeamAttempt): void {
    if (this.stored(attempt.id)) return;
    const metadata = this.metadata(attempt.id), stoppedAt = this.now().toISOString(), files = this.files(attempt);
    const records = files.activity.records, open = new Map<string, ToolActivityRecord>();
    for (const record of records) {
      if (record.status === "running") open.set(record.id, record); else open.delete(record.id);
    }
    let seq = records.at(-1)?.seq ?? 0;
    for (const record of open.values()) records.push({ ...record, seq: ++seq, at: stoppedAt, status: "aborted" });
    const usage = this.turnUsage(attempt, metadata, files.native);
    this.db.prepare(`INSERT INTO attempt_telemetry
      (attempt_id, native_session_id, native_usage_json, seat_name, started_at, stopped_at, active_ms,
        usage_json, activity_json, activity_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(attempt.id, files.native?.nativeSessionId ?? null,
      files.native === null ? null : JSON.stringify(files.native), metadata.seat, metadata.startedAt, stoppedAt,
      Math.max(0, Date.parse(stoppedAt) - Date.parse(metadata.startedAt)), JSON.stringify(usage), JSON.stringify(records),
      open.size > 0 ? "partial" : files.activity.status);
  }

  recordOutcome(attemptId: string, result: { outcome: AttemptOutcome; retryScheduled: boolean }): void {
    this.db.prepare("UPDATE attempt_telemetry SET outcome = ?, retry_scheduled = ? WHERE attempt_id = ?")
      .run(result.outcome, Number(result.retryScheduled), attemptId);
  }

  analytics(options: { days: number; teamId?: string; runId?: string }) {
    const through = this.now().toISOString(), start = new Date(through);
    start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - options.days + 1);
    const from = start.toISOString();
    const rows = this.db.prepare(`SELECT t.attempt_id AS attemptId, t.seat_name AS seat, t.stopped_at AS stoppedAt,
      t.active_ms AS activeMs, t.usage_json AS usageJson, t.outcome, a.qitem_id AS qitemId, q.state AS taskState,
      (t.retry_scheduled = 1 OR EXISTS (SELECT 1 FROM events e WHERE e.type = 'team.control'
        AND json_extract(e.payload, '$.action') = 'task.retry-requested'
        AND json_extract(e.payload, '$.runId') = a.run_id AND json_extract(e.payload, '$.attemptId') = a.id)) AS retried
      FROM attempt_telemetry t JOIN team_attempts a ON a.id = t.attempt_id JOIN team_runs r ON r.id = a.run_id
      LEFT JOIN queue_items q ON q.qitem_id = a.qitem_id
      WHERE t.stopped_at >= ? AND t.stopped_at <= ? AND (? IS NULL OR r.rig_id = ?) AND (? IS NULL OR a.run_id = ?)
      ORDER BY t.stopped_at, a.rowid`).all(from, through, options.teamId ?? null, options.teamId ?? null,
        options.runId ?? null, options.runId ?? null) as Array<{
          attemptId: string; seat: string | null; stoppedAt: string; activeMs: number; usageJson: string;
          outcome: AttemptOutcome; qitemId: string | null; taskState: string | null; retried: number }>;
    const bucket = () => ({ ...emptyCounts(), tokens: null as number | null, attempts: 0, measuredAttempts: 0,
      partialAttempts: 0, activeMs: 0 });
    type Bucket = ReturnType<typeof bucket>;
    const totals = { ...bucket(), succeeded: 0, failed: 0, canceled: 0, unknown: 0, retryCount: 0 };
    const days = new Map<string, Bucket>(), models = new Map<string | null, Bucket>(), seats = new Map<string | null, Bucket>();
    const tasks = new Map<string, string>(), durations: number[] = [];
    for (let offset = 0; offset < options.days; offset++) {
      const day = new Date(start); day.setUTCDate(day.getUTCDate() + offset);
      days.set(day.toISOString().slice(0, 10), bucket());
    }
    const get = <T>(map: Map<T, Bucket>, key: T) => { if (!map.has(key)) map.set(key, bucket()); return map.get(key)!; };
    for (const row of rows) {
      const usage = JSON.parse(row.usageJson) as TurnUsage;
      const targets = [totals, get(days, row.stoppedAt.slice(0, 10)), get(models, usage.model), get(seats, row.seat)];
      for (const target of targets) {
        target.attempts++; target.activeMs += row.activeMs;
        if (usage.status !== "unavailable") target.measuredAttempts++;
        if (usage.status === "partial") target.partialAttempts++;
        for (const key of countKeys) if (usage[key] !== null) target[key] = (target[key] ?? 0) + usage[key]!;
        // Reasoning output is a subset of output, not another category of spend.
        for (const key of countKeys) if (key !== "reasoningOutputTokens" && usage[key] !== null) target.tokens = (target.tokens ?? 0) + usage[key]!;
      }
      totals[row.outcome]++; totals.retryCount += Number(row.retried !== 0); durations.push(row.activeMs);
      if (row.qitemId !== null && row.taskState !== null) tasks.set(row.qitemId, row.taskState);
    }
    durations.sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2), knownOutcomes = totals.succeeded + totals.failed;
    const taskCounts: Record<string, number> = {};
    for (const state of tasks.values()) taskCounts[state] = (taskCounts[state] ?? 0) + 1;
    return { window: { from, through, timeZone: "UTC" }, population: "Captured stopped attempts",
      totals: { ...totals, outcomeAttempts: knownOutcomes,
        successRate: knownOutcomes ? totals.succeeded / knownOutcomes : null,
        retryRate: totals.attempts ? totals.retryCount / totals.attempts : null,
        medianDurationMs: durations.length ? (durations.length % 2 ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2) : null },
      tasks: { total: tasks.size, byState: taskCounts },
      byDay: [...days].map(([day, values]) => ({ day, ...values })),
      byModel: [...models].map(([model, values]) => ({ model, ...values })),
      bySeat: [...seats].map(([seat, values]) => ({ seat, ...values })) };
  }
}
