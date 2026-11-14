import { describe, expect, it } from "vitest";
import type { TeamReplayEvent, TeamSeatView } from "@multi-agent/daemon/team-control";
import { adaptTeamEvents, adaptTeamReplayEvent, mapTeamSeat } from "../flow/team-flow-adapter.js";

function event(overrides: Partial<TeamReplayEvent> = {}): TeamReplayEvent {
  return {
    seq: 7,
    createdAt: "2026-11-14 10:00:00",
    type: "team.control",
    action: "worker.tool.started",
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    body: '{"workerSeat":"impl@rig","tool":"read"}',
    truncated: false,
    ...overrides,
  };
}

describe("team flow adapter", () => {
  it("preserves replay identity and parses a structured body", () => {
    const adapted = adaptTeamReplayEvent(event(), "fallback");
    expect(adapted).toMatchObject({
      type: "team.control",
      eventId: "replay:7",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      entityId: "attempt-1",
      action: "worker.tool.started",
      createdAt: "2026-11-14 10:00:00",
      seq: 7,
      payload: { workerSeat: "impl@rig", tool: "read" },
    });
  });

  it("keeps nullable or malformed replay fields inert", () => {
    const adapted = adaptTeamReplayEvent(event({ runId: null, action: null, body: "not-json", attemptId: null, taskId: null }), "fallback");
    expect(adapted.runId).toBe("fallback");
    expect(adapted.action).toBe("event.unknown");
    expect(adapted.entityId).toBe("event-7");
    expect(adapted.payload).toEqual({});
    expect(adaptTeamEvents([event(), event()], "fallback")).toHaveLength(2);
  });

  it("maps named daemon seats to flow nodes without exposing seat addresses as labels", () => {
    const seat: TeamSeatView = {
      seat: "impl@rig",
      role: "implementer",
      client: "codex",
      index: null,
      displayName: "Implementer \u00b7 Codex",
      retired: false,
    };
    expect(mapTeamSeat(seat)).toEqual({ id: "impl@rig", label: "Implementer \u00b7 Codex", role: "implementer" });
  });
});
