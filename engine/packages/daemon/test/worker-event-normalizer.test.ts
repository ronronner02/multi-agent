import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  WORKER_EVENT_PROTOCOL_VERSION,
  WORKER_EVENT_SCHEMA,
  WORKER_EVENT_SUMMARY_LIMIT,
  isWorkerEvent,
  type WorkerEvent,
} from "../src/contracts/worker-events.js";
import {
  WorkerEventNormalizer,
  normalizeWorkerStream,
} from "../src/adapters/worker-event-normalizer.js";

const fixtures = fileURLToPath(new URL("./fixtures/agent-streams/", import.meta.url));

function fixture(name: string): { events: unknown[] } {
  return JSON.parse(readFileSync(`${fixtures}/${name}.json`, "utf8")) as { events: unknown[] };
}

function normalize(provider: "claude" | "codex", name: string) {
  const normalizer = new WorkerEventNormalizer({ provider,
    attemptId: `${provider}-${name}`,
    now: () => new Date("2026-11-10T00:00:00.000Z"),
  });
  for (const record of fixture(name).events) normalizer.normalize(record);
  return normalizer.result();
}

describe("worker event contract", () => {
  it("publishes one versioned, bounded event shape for Claude and Codex", () => {
    for (const event of [...normalize("claude", "claude-initial").events, ...normalize("codex", "codex-initial").events]) {
      expect(event.schema).toBe(WORKER_EVENT_SCHEMA);
      expect(event.protocolVersion).toBe(WORKER_EVENT_PROTOCOL_VERSION);
      expect(event.rawSummary.length).toBeLessThanOrEqual(WORKER_EVENT_SUMMARY_LIMIT);
      expect("summary" in event).toBe(false);
      expect(isWorkerEvent(event)).toBe(true);
      expect(isWorkerEvent({ ...event, summary: event.rawSummary })).toBe(false);
    }
  });

  it.each([
    { provider: "claude" as const, name: "claude-initial", lifecycle: ["session.started", "tool.started", "tool.completed", "message.agent", "turn.completed"] },
    { provider: "codex" as const, name: "codex-initial", lifecycle: ["session.started", "turn.started", "tool.started", "tool.completed", "message.agent", "turn.completed"] },
  ])("normalizes the $provider fixture into a provider-independent lifecycle", ({ provider, name, lifecycle }) => {
    const result = normalize(provider, name);
    expect(result.acknowledged).toBe(true);
    expect(result.noResponse).toBe(false);
    expect(result.events.filter(event => event.type !== "attempt.acknowledged").map(event => event.type)).toEqual(lifecycle);
    expect(result.events.filter(event => event.type === "attempt.acknowledged")).toHaveLength(1);
    expect(result.events.map(event => event.sequence)).toEqual(result.events.map((_, index) => index + 1));
  });

  it("acknowledges Claude init before any provider activity and does not treat a delivered message as acknowledgment", () => {
    const normalizer = new WorkerEventNormalizer({ provider: "claude", attemptId: "attempt-1", now: () => new Date("2026-11-10T00:00:00.000Z") });
    const events = normalizer.normalize({ type: "system", subtype: "hook_started", session_id: "ignored" });
    expect(events.map(event => event.type)).toEqual(["unknown"]);
    const init = normalizer.normalize({ type: "system", subtype: "init", session_id: "session-1", permissionMode: "bypassPermissions" });
    expect(init.map(event => event.type)).toEqual(["attempt.acknowledged", "session.started", "permission.state"]);
    expect(init[0]).toMatchObject({ type: "attempt.acknowledged", firstProviderEvent: "session.started", sessionId: "session-1" });
    expect(normalizer.normalize({ type: "assistant", session_id: "session-1", message: { id: "m", content: [{ type: "text", text: "OK" }] } }).some(event => event.type === "attempt.acknowledged")).toBe(false);
  });

  it("acknowledges an older Claude assistant-first fixture and keeps private reasoning out", () => {
    const result = normalize("claude", "claude-initial");
    expect(result.events[0]?.type).toBe("attempt.acknowledged");
    expect(result.events[1]).toMatchObject({ type: "session.started", sessionId: "00000000-0000-4000-8000-000000000001" });
    expect(JSON.stringify(result.events)).not.toContain("Private reasoning");
  });

  it("leaves a child that emitted nothing explicitly in no-response", () => {
    const result = normalizeWorkerStream("codex", "", { attemptId: "silent", now: () => new Date("2026-11-10T00:00:00.000Z") });
    expect(result).toEqual({ events: [], acknowledged: false, noResponse: true, finalMessage: null, resumeToken: null });
  });

  it("bounds malformed JSON as a provider error without crashing or acknowledging", () => {
    const normalizer = new WorkerEventNormalizer({ provider: "codex", attemptId: "bad-json", summaryLimit: 80, now: () => new Date("2026-11-10T00:00:00.000Z") });
    const [event] = normalizer.normalizeLine("{" + "x".repeat(10_000));
    expect(event).toMatchObject({ type: "provider.error", code: "malformed_json", terminal: false, retryable: false });
    expect(event?.rawSummary.length).toBe(80);
    expect(normalizer.acknowledged).toBe(false);
  });

  it("keeps unknown provider records diagnostic and preserves known record order", () => {
    const normalizer = new WorkerEventNormalizer({ provider: "codex", attemptId: "unknown-order", now: () => new Date("2026-11-10T00:00:00.000Z") });
    for (const record of [
      { type: "mystery.event", payload: { detail: "fixture" } },
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "m", type: "agent_message", text: "OK" } },
    ]) normalizer.normalize(record);
    const result = normalizer.result();
    expect(result.events.map(event => event.type)).toEqual(["unknown", "attempt.acknowledged", "session.started", "turn.started", "message.agent"]);
    expect(result.events.find(event => event.type === "unknown")).toMatchObject({ providerEventType: "mystery.event" });
  });

  it("assigns immutable contiguous sequences after duplicate session suppression", () => {
    const normalizer = new WorkerEventNormalizer({ provider: "codex", attemptId: "sequence-stability", now: () => new Date("2026-11-10T00:00:00.000Z") });
    const first = normalizer.normalizeLine(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
    const firstSequences = first.map(event => event.sequence);
    const duplicate = normalizer.normalizeLine(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
    const third = normalizer.normalizeLine(JSON.stringify({ type: "turn.started", turn_id: "turn-1" }));

    expect(duplicate).toEqual([]);
    expect(first.map(event => event.sequence)).toEqual(firstSequences);
    expect([...first, ...third].map(event => event.sequence)).toEqual([1, 2, 3]);
  });

  it("keeps no raw provider-record history while processing a large quiet stream", () => {
    const normalizer = new WorkerEventNormalizer({ provider: "codex", attemptId: "large-quiet-stream" });
    for (let index = 0; index < 20_000; index += 1) {
      normalizer.normalize({ type: "item.completed", item: { id: `reasoning-${index}`, type: "reasoning", text: "private" } });
    }

    expect(normalizer.allEvents).toHaveLength(0);
    expect("records" in (normalizer as unknown as Record<string, unknown>)).toBe(false);
  });

  it("extracts final messages, resume tokens, and Codex cumulative usage deterministically", () => {
    const claude = normalize("claude", "claude-resumed");
    const codex = normalize("codex", "codex-resumed");
    expect(claude.finalMessage).toBe("resumed complete.");
    expect(claude.resumeToken).toBe("00000000-0000-4000-8000-000000000001");
    expect(codex.finalMessage).toBe("resumed complete.");
    expect(codex.resumeToken).toBe("00000000-0000-4000-8000-000000000002");
    expect(codex.events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed", finalMessage: "resumed complete.",
      resumeToken: "00000000-0000-4000-8000-000000000002", usage: { inputTokens: 59480, outputTokens: 190, reasoningOutputTokens: 38 } });
  });

  it("maps Claude notifications, tool results, errors, and permission state", () => {
    const normalizer = new WorkerEventNormalizer({ provider: "claude", attemptId: "claude-shapes", now: () => new Date("2026-11-10T00:00:00.000Z") });
    for (const record of [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "system", subtype: "notification", key: "stop-hook-error" },
      { type: "assistant", session_id: "s", message: { id: "m", content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "echo ok" } }] } },
      { type: "user", session_id: "s", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "ok", is_error: false }] } },
      { type: "permission", id: "p", state: "denied", reason: "owner denied", tool_name: "Bash" },
      { type: "error", code: "network", message: "offline" },
      { type: "result", subtype: "error", is_error: true, result: "failed", session_id: "s" },
    ]) normalizer.normalize(record);
    const result = normalizer.result();
    expect(result.events.map(event => event.type)).toEqual([
      "attempt.acknowledged", "session.started", "heartbeat", "tool.started", "tool.completed", "permission.state", "provider.error", "turn.completed",
    ]);
    expect(result.events.find(event => event.type === "permission.state")).toMatchObject({ state: "denied", permissionId: "p", tool: "Bash" });
    expect(result.events.at(-1)).toMatchObject({ type: "turn.completed", status: "failed", finalMessage: "failed" });
  });
});
