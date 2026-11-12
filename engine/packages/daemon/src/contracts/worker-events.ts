/**
 * The daemon's provider-independent worker event vocabulary.
 *
 * The names follow ACP's useful distinction between sessions, turns, messages,
 * tools and permissions, but this is a local contract. Provider clients remain
 * direct child-process transports and no ACP package is required at runtime.
 */

export const WORKER_EVENT_PROTOCOL_VERSION = "1.0" as const;
export const WORKER_EVENT_SCHEMA = "multi-agent-worker-events/v1" as const;
export const WORKER_EVENT_SUMMARY_LIMIT = 512 as const;
export const WORKER_TURN_START_WINDOW_MS = 30_000;

export type WorkerProvider = "claude" | "codex";

export type WorkerEventType =
  | "session.started"
  | "turn.started"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "message.agent"
  | "permission.state"
  | "heartbeat"
  | "provider.error"
  | "turn.completed"
  | "attempt.acknowledged"
  | "unknown";

export const WORKER_EVENT_TYPES = [
  "session.started", "turn.started", "tool.started", "tool.updated", "tool.completed", "message.agent",
  "permission.state", "heartbeat", "provider.error", "turn.completed", "attempt.acknowledged", "unknown",
] as const satisfies readonly WorkerEventType[];

export type WorkerToolStatus = "running" | "completed" | "failed" | "canceled" | "awaiting_permission";
export type WorkerPermissionState = "requested" | "granted" | "denied" | "canceled" | "not_required" | "pending";
export type WorkerTurnStatus = "completed" | "failed" | "canceled" | "interrupted" | "unknown";

export interface WorkerEventBase {
  schema: typeof WORKER_EVENT_SCHEMA;
  protocolVersion: typeof WORKER_EVENT_PROTOCOL_VERSION;
  type: WorkerEventType;
  provider: WorkerProvider;
  attemptId: string;
  /** The daemon-local order in which facts were observed. It starts at one. */
  sequence: number;
  timestamp: string;
  /** A bounded, safe-to-display summary of the provider record. */
  rawSummary: string;
}

export interface WorkerSessionStarted extends WorkerEventBase {
  type: "session.started";
  sessionId: string;
  resumeToken: string;
  model?: string;
}

export interface WorkerTurnStarted extends WorkerEventBase {
  type: "turn.started";
  turnId: string | null;
}

export interface WorkerToolEvent extends WorkerEventBase {
  type: "tool.started" | "tool.updated" | "tool.completed";
  toolCallId: string;
  tool: string;
  title: string | null;
  status: WorkerToolStatus;
  input?: unknown;
  output?: string | null;
  error?: string | null;
}

export interface WorkerAgentMessage extends WorkerEventBase {
  type: "message.agent";
  messageId: string | null;
  text: string;
  final: boolean;
}

export interface WorkerPermissionEvent extends WorkerEventBase {
  type: "permission.state";
  permissionId: string | null;
  state: WorkerPermissionState;
  reason: string | null;
  tool: string | null;
}

export interface WorkerHeartbeat extends WorkerEventBase {
  type: "heartbeat";
  status: "started" | "working" | "waiting" | "provider_notification";
}

export interface WorkerProviderError extends WorkerEventBase {
  type: "provider.error";
  code: string | null;
  message: string;
  retryable: boolean;
  terminal: boolean;
}

export interface WorkerTurnCompleted extends WorkerEventBase {
  type: "turn.completed";
  status: WorkerTurnStatus;
  finalMessage: string | null;
  resumeToken: string | null;
  usage: WorkerUsage | null;
}

export interface WorkerAcknowledged extends WorkerEventBase {
  type: "attempt.acknowledged";
  /** The first provider event that established a session or turn. */
  firstProviderEvent: "session.started" | "turn.started";
  sessionId: string | null;
  turnId: string | null;
}

export interface WorkerUnknownEvent extends WorkerEventBase {
  type: "unknown";
  providerEventType: string | null;
  diagnostic: string;
}

export interface WorkerUsage {
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export type WorkerEvent =
  | WorkerSessionStarted
  | WorkerTurnStarted
  | WorkerToolEvent
  | WorkerAgentMessage
  | WorkerPermissionEvent
  | WorkerHeartbeat
  | WorkerProviderError
  | WorkerTurnCompleted
  | WorkerAcknowledged
  | WorkerUnknownEvent;

export function isWorkerEvent(value: unknown): value is WorkerEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Partial<WorkerEvent>;
  return event.schema === WORKER_EVENT_SCHEMA
    && event.protocolVersion === WORKER_EVENT_PROTOCOL_VERSION
    && (WORKER_EVENT_TYPES as readonly string[]).includes(event.type ?? "")
    && (event.provider === "claude" || event.provider === "codex")
    && typeof event.attemptId === "string"
    && typeof event.sequence === "number"
    && Number.isSafeInteger(event.sequence)
    && event.sequence > 0
    && typeof event.timestamp === "string"
    && typeof event.rawSummary === "string"
    && event.rawSummary.length <= WORKER_EVENT_SUMMARY_LIMIT
    && !("summary" in event);
}

export function assertWorkerEvent(value: unknown): asserts value is WorkerEvent {
  if (!isWorkerEvent(value)) throw new TypeError("Invalid worker event");
}

/** Additive action names for the eventual team.control event-log projection. */
export const WORKER_EVENT_ACTIONS = [
  "attempt.acknowledged",
  "worker.session.started",
  "worker.turn.started",
  "worker.tool.started",
  "worker.tool.updated",
  "worker.tool.completed",
  "worker.message.agent",
  "worker.permission.state",
  "worker.heartbeat",
  "worker.provider.error",
  "worker.turn.completed",
  "worker.unknown",
] as const;

export type WorkerEventAction = (typeof WORKER_EVENT_ACTIONS)[number];
