import { describe, expect, it } from "vitest";
import { WORKER_EVENT_TYPES, type WorkerEvent } from "../src/contracts/worker-events.js";
import { workerEventNotification } from "../src/domain/worker-event-notification.js";

const secret = "fixture-secret-do-not-persist";
const content = `${secret} cat private-fixture.txt ${"private assistant content ".repeat(10_000)}`;
const base = { schema: "multi-agent-worker-events/v1", protocolVersion: "1.0", provider: "codex", attemptId: "attempt",
  sequence: 1, timestamp: "2026-11-12T00:00:00.000Z", rawSummary: content } as const;
const usage = { inputTokens: 20, cacheReadInputTokens: 3, cacheWriteInputTokens: null, outputTokens: 5, reasoningOutputTokens: 2 };
const variants: Array<{ event: WorkerEvent; status: Record<string, unknown> }> = [
  { event: { ...base, type: "session.started", sessionId: content, resumeToken: content, model: content }, status: {} },
  { event: { ...base, type: "turn.started", turnId: content }, status: {} },
  ...(["tool.started", "tool.updated", "tool.completed"] as const).map(type => ({
    event: { ...base, type, toolCallId: "call-1", tool: "command_execution", status: "completed" as const,
      title: content, input: { command: content }, output: content, error: content },
    status: { toolCallId: "call-1", tool: "command_execution", status: "completed" },
  })),
  { event: { ...base, type: "message.agent", messageId: content, text: content, final: true }, status: {} },
  { event: { ...base, type: "permission.state", permissionId: content, state: "pending", reason: content, tool: content }, status: { state: "pending" } },
  { event: { ...base, type: "heartbeat", status: "working" }, status: { status: "working" } },
  { event: { ...base, type: "provider.error", code: "malformed_json", message: content, retryable: false, terminal: false }, status: { code: "malformed_json" } },
  { event: { ...base, type: "turn.completed", status: "completed", finalMessage: content, resumeToken: content, usage }, status: { status: "completed", usage } },
  { event: { ...base, type: "attempt.acknowledged", firstProviderEvent: "session.started", sessionId: content, turnId: content }, status: { firstProviderEvent: "session.started" } },
  { event: { ...base, type: "unknown", providerEventType: content, diagnostic: content }, status: {} },
];

describe("durable worker notification projection", () => {
  it("covers every worker event variant", () => {
    expect(variants.map(({ event }) => event.type).sort()).toEqual([...WORKER_EVENT_TYPES].sort());
  });
  it.each(variants)("keeps only bounded status metadata for $event.type", ({ event, status }) => {
    for (const provider of ["claude", "codex"] as const) {
      const payload = workerEventNotification({ ...event, provider, raw: { content }, text: content, input: content, output: content } as WorkerEvent);
      expect(payload).toEqual({ type: event.type, provider, timestamp: base.timestamp, ...status });
      const encoded = JSON.stringify(payload);
      expect(encoded).not.toContain(secret);
      expect(encoded).not.toContain("private-fixture.txt");
      expect(encoded).not.toContain("private assistant content");
      expect(Buffer.byteLength(encoded)).toBeLessThan(768);
    }
  });
  it("omits content and oversized values from identifier fields instead of truncating them", () => {
    const tool = variants.find(({ event }) => event.type === "tool.completed")!.event as Extract<WorkerEvent, { toolCallId: string }>;
    for (const value of [content, "cat private-fixture.txt", "/private/fixture.txt", "x".repeat(129)]) {
      expect(workerEventNotification({ ...tool, toolCallId: value, tool: value })).toMatchObject({ toolCallId: null, tool: null });
      expect(workerEventNotification({ ...base, type: "provider.error", code: value, message: content, retryable: false, terminal: false })).toMatchObject({ code: null });
    }
    expect(Buffer.byteLength(JSON.stringify(workerEventNotification({ ...tool, toolCallId: "x".repeat(128), tool: "x".repeat(64) })))).toBeLessThan(768);
  });
  it("copies token counts explicitly without retaining provider usage extensions", () => {
    const event: WorkerEvent = { ...base, type: "turn.completed", status: "completed", finalMessage: content, resumeToken: content,
      usage: { ...usage, raw: content } as typeof usage };
    expect(workerEventNotification(event)).toEqual({ type: event.type, provider: base.provider, timestamp: base.timestamp, status: "completed", usage });
    expect(workerEventNotification({ ...event, usage: null })).toMatchObject({ usage: null });
  });
});
