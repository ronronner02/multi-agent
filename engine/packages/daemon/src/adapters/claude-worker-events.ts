import {
  WORKER_EVENT_PROTOCOL_VERSION,
  WORKER_EVENT_SCHEMA,
  WORKER_EVENT_SUMMARY_LIMIT,
  type WorkerAgentMessage,
  type WorkerEvent,
  type WorkerPermissionEvent,
  type WorkerProvider,
  type WorkerProviderError,
  type WorkerSessionStarted,
  type WorkerToolEvent,
  type WorkerTurnCompleted,
  type WorkerTurnStarted,
  type WorkerUnknownEvent,
  type WorkerUsage,
  type WorkerHeartbeat,
} from "../contracts/worker-events.js";

export interface ProviderEventContext {
  provider: WorkerProvider;
  attemptId: string;
  /** Provider adapters emit sequence-neutral events; the normalizer assigns order. */
  sequence: () => number;
  nextId: (prefix: string) => string;
  finalMessage: () => string | null;
  resumeToken: () => string | null;
  timestamp: (record: Record<string, unknown>) => string;
  rawSummary: (record: unknown) => string;
}

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;

const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

const id = (value: unknown): string | null => text(value)?.slice(0, 256) ?? null;

const bounded = (value: string): string => value.slice(0, WORKER_EVENT_SUMMARY_LIMIT);

const model = (value: unknown): string | undefined => text(value)?.slice(0, 128);

const usageNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function usage(value: unknown): WorkerUsage | null {
  const input = record(value);
  if (!input) return null;
  return {
    inputTokens: usageNumber(input.input_tokens ?? input.inputTokens),
    cacheReadInputTokens: usageNumber(input.cache_read_input_tokens ?? input.cacheReadInputTokens),
    cacheWriteInputTokens: usageNumber(input.cache_creation_input_tokens ?? input.cacheWriteInputTokens),
    outputTokens: usageNumber(input.output_tokens ?? input.outputTokens),
    reasoningOutputTokens: usageNumber(input.reasoning_output_tokens ?? input.thinking_tokens ?? input.reasoningOutputTokens),
  };
}

function base(context: ProviderEventContext, type: WorkerEvent["type"], source: unknown): Omit<WorkerEvent, "type"> & { type: WorkerEvent["type"] } {
  const rawSummary = context.rawSummary(source);
  return {
    schema: WORKER_EVENT_SCHEMA,
    protocolVersion: WORKER_EVENT_PROTOCOL_VERSION,
    type,
    provider: context.provider,
    attemptId: context.attemptId,
    sequence: context.sequence(),
    timestamp: context.timestamp(record(source) ?? {}),
    rawSummary,
  } as Omit<WorkerEvent, "type"> & { type: WorkerEvent["type"] };
}

function sessionStarted(context: ProviderEventContext, source: RecordValue, sessionId: string): WorkerSessionStarted {
  return { ...base(context, "session.started", source), type: "session.started", sessionId, resumeToken: sessionId,
    ...(model(source.model) ? { model: model(source.model) } : {}) };
}

function turnStarted(context: ProviderEventContext, source: RecordValue): WorkerTurnStarted {
  return { ...base(context, "turn.started", source), type: "turn.started", turnId: id(source.turn_id ?? source.turnId) };
}

function toolEvent(context: ProviderEventContext, source: unknown, type: WorkerToolEvent["type"], item: RecordValue, status: WorkerToolEvent["status"]): WorkerToolEvent {
  const input = record(item.input);
  return { ...base(context, type, source), type, toolCallId: id(item.id) ?? context.nextId("claude-tool"),
    tool: text(item.name) ?? "tool", title: text(input?.description) ?? null, status,
    ...(input ? { input } : {}) };
}

function messageEvent(context: ProviderEventContext, source: unknown, message: RecordValue, textValue: string, final = false): WorkerAgentMessage {
  return { ...base(context, "message.agent", source), type: "message.agent", messageId: id(message.id), text: bounded(textValue), final };
}

function permissionEvent(context: ProviderEventContext, source: unknown, permissionId: string | null, state: WorkerPermissionEvent["state"], reason: string | null, tool: string | null): WorkerPermissionEvent {
  return { ...base(context, "permission.state", source), type: "permission.state", permissionId, state, reason: reason ? bounded(reason) : null, tool };
}

function heartbeat(context: ProviderEventContext, source: unknown, status: WorkerHeartbeat["status"]): WorkerHeartbeat {
  return { ...base(context, "heartbeat", source), type: "heartbeat", status };
}

function providerError(context: ProviderEventContext, source: unknown, message: string, code: string | null, retryable: boolean, terminal: boolean): WorkerProviderError {
  return { ...base(context, "provider.error", source), type: "provider.error", code, message: bounded(message), retryable, terminal };
}

function turnCompleted(context: ProviderEventContext, source: RecordValue, status: WorkerTurnCompleted["status"]): WorkerTurnCompleted {
  const sessionId = id(source.session_id ?? source.sessionId) ?? context.resumeToken();
  return { ...base(context, "turn.completed", source), type: "turn.completed", status,
    finalMessage: context.finalMessage(), resumeToken: sessionId, usage: usage(source.usage) };
}

function unknown(context: ProviderEventContext, source: unknown, providerEventType: string | null, diagnostic: string): WorkerUnknownEvent {
  return { ...base(context, "unknown", source), type: "unknown", providerEventType,
    diagnostic: bounded(diagnostic) };
}

function contentBlocks(context: ProviderEventContext, source: RecordValue, message: RecordValue): WorkerEvent[] {
  const result: WorkerEvent[] = [];
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const input of blocks) {
    const block = record(input);
    if (!block) continue;
    if (block.type === "tool_use") {
      result.push(toolEvent(context, source, "tool.started", block, "running"));
    } else if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      result.push(messageEvent(context, source, message, block.text));
    }
    // `thinking` is provider-private reasoning and intentionally has no public event.
  }
  return result;
}

function streamEvent(context: ProviderEventContext, source: RecordValue, nested: RecordValue): WorkerEvent[] {
  const eventType = text(nested.type);
  const message = record(nested.message);
  if (eventType === "message_start") {
    return message ? [heartbeat(context, source, "started")] : [unknown(context, source, eventType, "Claude message_start lacked a message")];
  }
  if (eventType === "content_block_start") {
    const block = record(nested.content_block);
    if (block?.type === "tool_use") return [toolEvent(context, source, "tool.started", block, "running")];
    return [];
  }
  if (eventType === "content_block_delta") {
    const delta = record(nested.delta);
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return [messageEvent(context, source, message ?? {}, delta.text)];
    }
    return [];
  }
  return [unknown(context, source, eventType, `Unsupported Claude stream event ${eventType ?? "unknown"}`)];
}

/** Normalize one Claude stream-json record without adding the daemon acknowledgment. */
export function normalizeClaudeRecord(source: unknown, context: ProviderEventContext): WorkerEvent[] {
  const value = record(source);
  if (!value) return [unknown(context, source, null, "Claude record was not an object")];
  const type = text(value.type);
  if (type === "system") {
    const subtype = text(value.subtype);
    if (subtype === "init") {
      const sessionId = id(value.session_id ?? value.sessionId);
      const events: WorkerEvent[] = sessionId ? [sessionStarted(context, value, sessionId)] : [unknown(context, value, "system:init", "Claude init lacked session_id")];
      if (typeof value.permissionMode === "string") {
        events.push(permissionEvent(context, value, null, "not_required", `permission mode: ${value.permissionMode}`, null));
      }
      return events;
    }
    if (subtype === "api_retry") return [providerError(context, value, text(value.error) ?? "Claude provider retry", "api_retry", true, false)];
    if (subtype === "notification") return [heartbeat(context, value, "provider_notification")];
    return [unknown(context, value, `system:${subtype ?? "unknown"}`, "Unknown Claude system event")];
  }
  if (type === "stream_event") {
    const nested = record(value.event);
    return nested ? streamEvent(context, value, nested) : [unknown(context, value, type, "Claude stream_event lacked event")];
  }
  if (type === "assistant") {
    const message = record(value.message);
    if (!message) return [unknown(context, value, type, "Claude assistant record lacked message")];
    const sessionId = id(value.session_id ?? value.sessionId);
    return [...(sessionId ? [sessionStarted(context, value, sessionId)] : []), ...contentBlocks(context, value, message)];
  }
  if (type === "user") {
    const message = record(value.message);
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const events: WorkerEvent[] = [];
    for (const input of blocks) {
      const block = record(input);
      if (!block || block.type !== "tool_result") continue;
      const output = typeof block.content === "string" ? block.content : block.content === undefined ? null : JSON.stringify(block.content);
      const failed = block.is_error === true;
      events.push({ ...base(context, "tool.completed", value), type: "tool.completed", toolCallId: id(block.tool_use_id) ?? context.nextId("claude-tool"),
        tool: "tool", title: null, status: failed ? "failed" : "completed", output: output === null ? null : bounded(output), error: failed ? bounded(output ?? "Tool failed") : null });
    }
    return events;
  }
  if (type === "result") {
    const failed = value.is_error === true || (typeof value.subtype === "string" && value.subtype !== "success");
    const sessionId = id(value.session_id ?? value.sessionId);
    return [...(sessionId ? [sessionStarted(context, value, sessionId)] : []), turnCompleted(context, value, failed ? "failed" : "completed")];
  }
  if (type === "error") return [providerError(context, value, text(value.message ?? value.error) ?? "Claude provider error", text(value.code), false, true)];
  if (type === "permission" || type === "control_request") {
    const state = value.state === "denied" || value.behavior === "deny" ? "denied" : "requested";
    return [permissionEvent(context, value, id(value.id ?? value.request_id), state, text(value.reason), text(value.tool_name))];
  }
  return [unknown(context, value, type, `Unknown Claude event ${type ?? "without type"}`)];
}

export function extractClaudeResumeToken(input: unknown): string | null {
  const value = record(input);
  return value ? id(value.session_id ?? value.sessionId) : null;
}

export function extractClaudeFinalMessage(input: unknown): string | null {
  const value = record(input);
  if (!value) return null;
  let fallback: string | null = null;
  if (typeof value.result === "string" && value.result.length > 0) fallback = value.result;
  const message = record(value.message);
  if (message && Array.isArray(message.content)) {
    for (const blockInput of message.content) {
      const block = record(blockInput);
      if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) fallback = block.text;
    }
  }
  const nested = record(value.event);
  const delta = record(nested?.delta);
  if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
    fallback = delta.text;
  }
  return fallback === null ? null : bounded(fallback);
}
