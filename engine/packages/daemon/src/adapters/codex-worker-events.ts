import {
  WORKER_EVENT_PROTOCOL_VERSION,
  WORKER_EVENT_SCHEMA,
  WORKER_EVENT_SUMMARY_LIMIT,
  type WorkerAgentMessage,
  type WorkerEvent,
  type WorkerPermissionEvent,
  type WorkerProviderError,
  type WorkerToolEvent,
  type WorkerTurnCompleted,
  type WorkerTurnStarted,
  type WorkerSessionStarted,
  type WorkerUnknownEvent,
  type WorkerUsage,
} from "../contracts/worker-events.js";
import type { ProviderEventContext } from "./claude-worker-events.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const id = (value: unknown): string | null => text(value)?.slice(0, 256) ?? null;
const bounded = (value: string): string => value.slice(0, WORKER_EVENT_SUMMARY_LIMIT);
const usageNumber = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function usage(value: unknown): WorkerUsage | null {
  const input = record(value);
  if (!input) return null;
  return { inputTokens: usageNumber(input.input_tokens), cacheReadInputTokens: usageNumber(input.cached_input_tokens),
    cacheWriteInputTokens: usageNumber(input.cache_write_input_tokens), outputTokens: usageNumber(input.output_tokens),
    reasoningOutputTokens: usageNumber(input.reasoning_output_tokens) };
}

function base(context: ProviderEventContext, type: WorkerEvent["type"], source: unknown): Omit<WorkerEvent, "type"> & { type: WorkerEvent["type"] } {
  const rawSummary = context.rawSummary(source);
  return { schema: WORKER_EVENT_SCHEMA, protocolVersion: WORKER_EVENT_PROTOCOL_VERSION, type, provider: "codex", attemptId: context.attemptId,
    sequence: context.sequence(), timestamp: context.timestamp(record(source) ?? {}), rawSummary } as Omit<WorkerEvent, "type"> & { type: WorkerEvent["type"] };
}

function sessionStarted(context: ProviderEventContext, source: RecordValue, sessionId: string): WorkerSessionStarted {
  return { ...base(context, "session.started", source), type: "session.started", sessionId, resumeToken: sessionId };
}

function turnStarted(context: ProviderEventContext, source: RecordValue): WorkerTurnStarted {
  return { ...base(context, "turn.started", source), type: "turn.started", turnId: id(source.turn_id ?? source.turnId) };
}

function toolEvent(context: ProviderEventContext, source: unknown, type: WorkerToolEvent["type"], item: RecordValue): WorkerToolEvent {
  const itemType = text(item.type) ?? "tool";
  const status = type === "tool.started" ? "running" : item.status === "failed" || item.exit_code !== undefined && item.exit_code !== null && item.exit_code !== 0 ? "failed" : "completed";
  const output = typeof item.aggregated_output === "string" ? item.aggregated_output : typeof item.result === "string" ? item.result : null;
  const error = status === "failed" ? (output ?? "Tool failed") : null;
  return { ...base(context, type, source), type, toolCallId: id(item.id) ?? context.nextId("codex-tool"), tool: itemType,
    title: text(item.command ?? item.tool ?? item.query) ?? null, status, ...(item.input !== undefined ? { input: item.input } : {}),
    output: output === null ? null : bounded(output), error: error === null ? null : bounded(error) };
}

function messageEvent(context: ProviderEventContext, source: unknown, item: RecordValue, final: boolean): WorkerAgentMessage {
  return { ...base(context, "message.agent", source), type: "message.agent", messageId: id(item.id), text: bounded(text(item.text) ?? ""), final };
}

function permissionEvent(context: ProviderEventContext, source: unknown, item: RecordValue): WorkerPermissionEvent {
  const state = item.status === "denied" || item.approved === false ? "denied" : item.status === "completed" || item.approved === true ? "granted" : "pending";
  return { ...base(context, "permission.state", source), type: "permission.state", permissionId: id(item.id), state,
    reason: text(item.reason), tool: text(item.type) };
}

function providerError(context: ProviderEventContext, source: unknown, message: string, code: string | null, terminal: boolean): WorkerProviderError {
  return { ...base(context, "provider.error", source), type: "provider.error", code, message: bounded(message), retryable: !terminal, terminal };
}

function completed(context: ProviderEventContext, source: RecordValue, status: WorkerTurnCompleted["status"]): WorkerTurnCompleted {
  return { ...base(context, "turn.completed", source), type: "turn.completed", status, finalMessage: context.finalMessage(),
    resumeToken: context.resumeToken(), usage: usage(source.usage) };
}

function unknown(context: ProviderEventContext, source: unknown, providerEventType: string | null, diagnostic: string): WorkerUnknownEvent {
  return { ...base(context, "unknown", source), type: "unknown", providerEventType, diagnostic: bounded(diagnostic) };
}

/** Normalize one Codex `exec --json` record without adding the daemon acknowledgment. */
export function normalizeCodexRecord(source: unknown, context: ProviderEventContext): WorkerEvent[] {
  const value = record(source);
  if (!value) return [unknown(context, source, null, "Codex record was not an object")];
  const type = text(value.type);
  if (type === "thread.started") {
    const token = id(value.thread_id ?? value.threadId);
    return token ? [sessionStarted(context, value, token)] : [unknown(context, value, type, "Codex thread.started lacked thread_id")];
  }
  if (type === "turn.started") return [turnStarted(context, value)];
  if (type === "turn.completed") {
    return [completed(context, value, "completed")];
  }
  if (type === "turn.failed") {
    const message = text(value.message ?? value.error) ?? "Codex turn failed";
    return [providerError(context, value, message, text(value.code), true), completed(context, value, "failed")];
  }
  if (type === "error") return [providerError(context, value, text(value.message) ?? "Codex provider error", text(value.code), true)];
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = record(value.item);
    if (!item) return [unknown(context, value, type, `Codex ${type} lacked item`)];
    if (item.type === "reasoning") return [];
    if (item.type === "agent_message") return [messageEvent(context, value, item, type === "item.completed")];
    if (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call" || item.type === "web_search") {
      return [toolEvent(context, value, type === "item.started" ? "tool.started" : type === "item.updated" ? "tool.updated" : "tool.completed", item)];
    }
    if (item.status === "awaiting_approval" || item.status === "requires_approval") return [permissionEvent(context, value, item)];
    return [unknown(context, value, `${type}:${text(item.type) ?? "unknown"}`, `Unknown Codex item ${text(item.type) ?? "without type"}`)];
  }
  if (type === "permission" || type === "approval") {
    const item = record(value.item) ?? value;
    return [permissionEvent(context, value, item)];
  }
  return [unknown(context, value, type, `Unknown Codex event ${type ?? "without type"}`)];
}

export function extractCodexResumeToken(input: unknown): string | null {
  const value = record(input);
  return value ? id(value.thread_id ?? value.threadId) : null;
}

export function extractCodexFinalMessage(input: unknown): string | null {
  const value = record(input);
  const item = record(value?.item);
  return item?.type === "agent_message" && typeof item.text === "string" && item.text.length > 0 ? bounded(item.text) : null;
}
