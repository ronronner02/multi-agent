import type { JsonObject } from "../contracts/team-control.js";
import type { WorkerEvent } from "../contracts/worker-events.js";

/** Durable notifications carry status; public content stays in the telemetry projection. */
export function workerEventNotification(event: WorkerEvent): JsonObject {
  const base = { type: event.type, provider: event.provider, timestamp: event.timestamp };
  // Provider identifiers must remain small identifiers, never command text or file paths.
  const identifier = (value: string | null, limit: number) =>
    value && value.length <= limit && /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(value) ? value : null;
  switch (event.type) {
    case "tool.started":
    case "tool.updated":
    case "tool.completed":
      return { ...base, toolCallId: identifier(event.toolCallId, 128), tool: identifier(event.tool, 64), status: event.status };
    case "permission.state":
      return { ...base, state: event.state };
    case "heartbeat":
      return { ...base, status: event.status };
    case "provider.error":
      return { ...base, code: identifier(event.code, 64) };
    case "turn.completed":
      return { ...base, status: event.status, usage: event.usage === null ? null : {
        inputTokens: event.usage.inputTokens,
        cacheReadInputTokens: event.usage.cacheReadInputTokens,
        cacheWriteInputTokens: event.usage.cacheWriteInputTokens,
        outputTokens: event.usage.outputTokens,
        reasoningOutputTokens: event.usage.reasoningOutputTokens,
      } };
    case "attempt.acknowledged":
      return { ...base, firstProviderEvent: event.firstProviderEvent };
    case "session.started":
    case "turn.started":
    case "message.agent":
    case "unknown":
      return base;
  }
}
