import {
  WORKER_EVENT_PROTOCOL_VERSION,
  WORKER_EVENT_SCHEMA,
  WORKER_EVENT_SUMMARY_LIMIT,
  type WorkerEvent,
  type WorkerProvider,
} from "../contracts/worker-events.js";
import { extractClaudeFinalMessage, extractClaudeResumeToken, normalizeClaudeRecord } from "./claude-worker-events.js";
import { extractCodexFinalMessage, extractCodexResumeToken, normalizeCodexRecord } from "./codex-worker-events.js";

export interface WorkerEventNormalizerOptions {
  provider: WorkerProvider;
  attemptId: string;
  now?: () => Date;
  initialSequence?: number;
  summaryLimit?: number;
}

export interface WorkerNormalizationResult {
  events: WorkerEvent[];
  acknowledged: boolean;
  noResponse: boolean;
  finalMessage: string | null;
  resumeToken: string | null;
}

type RecordValue = Record<string, unknown>;

const object = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;

function diagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested provider data omitted]";
  if (Array.isArray(value)) return value.map(item => diagnosticValue(item, depth + 1));
  const objectValue = object(value);
  if (objectValue) {
    if (objectValue.type === "reasoning" || objectValue.type === "thinking") {
      return { type: objectValue.type, text: "[private reasoning omitted]" };
    }
    return Object.fromEntries(Object.entries(objectValue)
      .filter(([key]) => !["thinking", "reasoning", "privateReasoning"].includes(key))
      .map(([key, nested]) => [key, diagnosticValue(nested, depth + 1)]));
  }
  return value;
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(diagnosticValue(value));
    return json === undefined ? String(value) : json;
  } catch {
    return "[unserializable provider record]";
  }
}

function summary(value: unknown, limit: number): string {
  return safeJson(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
}

function eventTimestamp(value: RecordValue, fallback: () => Date): string {
  const candidate = value.timestamp ?? value.created_at ?? value.createdAt ?? value.time;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    const date = new Date(candidate < 10_000_000_000 ? candidate * 1000 : candidate);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (typeof candidate === "string") {
    const date = new Date(candidate);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return fallback().toISOString();
}

export class WorkerEventNormalizer {
  private sequence: number;
  private readonly now: () => Date;
  private readonly summaryLimit: number;
  private readonly events: WorkerEvent[] = [];
  private generatedId = 0;
  private sessionId: string | null = null;
  private didAcknowledge = false;
  private lastFinalMessage: string | null = null;
  private lastResumeToken: string | null = null;

  constructor(private readonly options: WorkerEventNormalizerOptions) {
    if (!options.attemptId || options.attemptId.length > 256) throw new Error("attemptId is required");
    this.sequence = options.initialSequence ?? 0;
    this.now = options.now ?? (() => new Date());
    this.summaryLimit = Math.max(1, Math.min(options.summaryLimit ?? WORKER_EVENT_SUMMARY_LIMIT, WORKER_EVENT_SUMMARY_LIMIT));
  }

  private context() {
    return {
      provider: this.options.provider,
      attemptId: this.options.attemptId,
      // Provider adapters must not allocate event sequence numbers. The value is
      // retained in their context only so direct adapter callers keep a stable shape.
      sequence: () => 0,
      nextId: (prefix: string) => `${prefix}-${++this.generatedId}`,
      finalMessage: () => this.lastFinalMessage,
      resumeToken: () => this.lastResumeToken,
      timestamp: (record: RecordValue) => eventTimestamp(record, this.now),
      rawSummary: (value: unknown) => summary(value, this.summaryLimit),
    };
  }

  private acknowledgment(source: unknown, firstProviderEvent: "session.started" | "turn.started", sessionId: string | null, turnId: string | null): WorkerEvent {
    return {
      schema: WORKER_EVENT_SCHEMA,
      protocolVersion: WORKER_EVENT_PROTOCOL_VERSION,
      type: "attempt.acknowledged",
      provider: this.options.provider,
      attemptId: this.options.attemptId,
      sequence: 0,
      timestamp: eventTimestamp(object(source) ?? {}, this.now),
      rawSummary: summary(source, this.summaryLimit),
      firstProviderEvent,
      sessionId,
      turnId,
    };
  }

  private append(events: readonly WorkerEvent[]): WorkerEvent[] {
    const emitted = events.map(event => ({ ...event, sequence: ++this.sequence }));
    this.events.push(...emitted);
    return emitted;
  }

  private suppressDuplicateSessions(events: readonly WorkerEvent[]): WorkerEvent[] {
    const result: WorkerEvent[] = [];
    for (const event of events) {
      if (event.type === "session.started") {
        if (this.sessionId !== null) continue;
        this.sessionId = event.sessionId;
      }
      result.push(event);
    }
    return result;
  }

  private normalizeProviderRecord(record: unknown): WorkerEvent[] {
    const context = this.context();
    const providerEvents = this.options.provider === "claude"
      ? normalizeClaudeRecord(record, context)
      : normalizeCodexRecord(record, context);
    const events = this.suppressDuplicateSessions(providerEvents);
    const acknowledgmentIndex = events.findIndex(event => event.type === "session.started" || event.type === "turn.started");
    if (!this.didAcknowledge && acknowledgmentIndex >= 0) {
      const event = events[acknowledgmentIndex]!;
      this.didAcknowledge = true;
      const firstProviderEvent = event.type as "session.started" | "turn.started";
      const acknowledgment = this.acknowledgment(record, firstProviderEvent,
        event.type === "session.started" ? event.sessionId : null,
        event.type === "turn.started" ? event.turnId : null);
      return [...events.slice(0, acknowledgmentIndex), acknowledgment, ...events.slice(acknowledgmentIndex)];
    }
    return events;
  }

  private advanceState(record: unknown): void {
    const final = this.options.provider === "claude" ? extractClaudeFinalMessage(record) : extractCodexFinalMessage(record);
    const resume = this.options.provider === "claude" ? extractClaudeResumeToken(record) : extractCodexResumeToken(record);
    if (final !== null) this.lastFinalMessage = final;
    if (resume !== null) this.lastResumeToken = resume;
  }

  /** Parse and normalize one provider JSONL line. A malformed line becomes one bounded error fact. */
  normalizeLine(line: string): WorkerEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      const rawSummary = summary(trimmed, this.summaryLimit);
      return this.append([{
        schema: WORKER_EVENT_SCHEMA,
        protocolVersion: WORKER_EVENT_PROTOCOL_VERSION,
        type: "provider.error",
        provider: this.options.provider,
        attemptId: this.options.attemptId,
        sequence: 0,
        timestamp: this.now().toISOString(),
        rawSummary,
        code: "malformed_json",
        message: "Provider emitted malformed JSON",
        retryable: false,
        terminal: false,
      }]);
    }
    return this.normalize(value);
  }

  /** Normalize an already parsed provider record. */
  normalize(record: unknown): WorkerEvent[] {
    this.advanceState(record);
    return this.append(this.normalizeProviderRecord(record));
  }

  get allEvents(): readonly WorkerEvent[] { return this.events; }
  get acknowledged(): boolean { return this.didAcknowledge; }
  get noResponse(): boolean { return !this.didAcknowledge; }
  get finalMessage(): string | null { return this.lastFinalMessage; }
  get resumeToken(): string | null { return this.lastResumeToken; }
  result(): WorkerNormalizationResult {
    return {
      events: [...this.events],
      acknowledged: this.didAcknowledge,
      noResponse: !this.didAcknowledge,
      finalMessage: this.lastFinalMessage,
      resumeToken: this.lastResumeToken,
    };
  }
}

export function normalizeWorkerStream(provider: WorkerProvider, input: string | Iterable<string | unknown>, options: Omit<WorkerEventNormalizerOptions, "provider">): WorkerNormalizationResult {
  const normalizer = new WorkerEventNormalizer({ ...options, provider });
  if (typeof input === "string") {
    for (const line of input.split(/\r?\n/)) normalizer.normalizeLine(line);
  } else {
    for (const line of input) typeof line === "string" ? normalizer.normalizeLine(line) : normalizer.normalize(line);
  }
  return normalizer.result();
}
