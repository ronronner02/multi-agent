import { describe, expect, it } from "vitest";
import { FLOW_DEFAULTS, mapTeamEvents, type FlowEvent } from "../flow/flow-events.js";
import { HIGH_DENSITY_EVENTS, HIGH_DENSITY_SEATS, LOW_DENSITY_EVENTS } from "../flow/fixtures.js";

function event(action: string, offset: number, overrides: Partial<FlowEvent> = {}, payload: Record<string, unknown> = {}): FlowEvent {
  return {
    type: "team.control", runId: "run", taskId: "task", attemptId: "attempt", entityId: "worker-1", action,
    eventId: `event-${offset}-${action}`, timestamp: offset, payload, ...overrides,
  };
}

describe("mapTeamEvents", () => {
  it("maps each Flow event kind to the requested visual intent", () => {
    const events = [
      event("task.created", 0, {}, { workerSeat: "worker-1" }),
      event("attempt.admitted", 1, {}, { workerSeat: "worker-1" }),
      event("attempt.started", 2),
      event("attempt.acknowledged", 3),
      event("worker.tool.started", 4, {}, { workerSeat: "worker-1", tool: "read" }),
      event("review.verdict", 5, {}, { workerSeat: "worker-1", reviewerSeat: "reviewer" }),
      event("task.outcome", 6, {}, { workerSeat: "worker-1" }),
      event("task.integrated", 7, {}, { workerSeat: "worker-1" }),
      event("chat.message", 8, { taskId: null, attemptId: null, entityId: "lead" }),
      event("lead.woken", 9, { taskId: null, attemptId: null, entityId: "lead" }),
      event("worker.waiting", 10, {}, { seat: "worker-1", state: "waiting" }),
      event("worker.error", 11, {}, { seat: "worker-1", state: "error" }),
      event("worker.occupant", 12, {}, { seat: "worker-1", state: "ambiguous" }),
    ];
    const mapping = mapTeamEvents(events, { now: 1000 });
    expect(new Set(mapping.intents.map(intent => intent.kind))).toEqual(new Set([
      "assignment", "started", "acknowledgment", "activity", "review", "delivery", "integration", "lead-message", "static",
    ]));
    expect(mapping.intents.some(intent => intent.action === "attempt.started" && intent.state === "started")).toBe(true);
    expect(mapping.intents.some(intent => intent.action === "attempt.acknowledged" && intent.state === "acknowledged")).toBe(true);
    expect(mapping.intents.some(intent => intent.state === "waiting")).toBe(true);
    expect(mapping.intents.some(intent => intent.state === "error")).toBe(true);
    expect(mapping.intents.some(intent => intent.state === "ambiguous")).toBe(true);
    expect(mapping.intents.find(intent => intent.kind === "assignment")?.sourceId).toBe("lead");
    expect(mapping.intents.find(intent => intent.kind === "review")?.targetId).toBe("reviewer");
    expect(mapping.intents.find(intent => intent.kind === "integration")?.targetId).toBe("integration");
  });

  it("keeps started distinct from acknowledgment and exposes no-response", () => {
    const started = event("attempt.started", 100, { attemptId: "attempt-no-response" });
    const mapping = mapTeamEvents([started], { now: 500 });
    expect(mapping.intents.some(intent => intent.kind === "started" && intent.state === "started")).toBe(true);
    expect(mapping.intents.some(intent => intent.state === "no-response" && intent.label === "No response yet")).toBe(true);

    const acknowledged = mapTeamEvents([started, event("attempt.acknowledged", 150, { attemptId: "attempt-no-response" })], { now: 500 });
    expect(acknowledged.intents.some(intent => intent.state === "no-response")).toBe(false);
    expect(acknowledged.intents.some(intent => intent.kind === "acknowledgment")).toBe(true);
  });

  it("coalesces same-edge bursts and deduplicates repeated event ids", () => {
    const first = event("worker.tool.completed", 100, { eventId: "same" }, { workerSeat: "worker-1", tool: "read" });
    const duplicate = { ...first };
    const second = event("worker.tool.completed", 200, { eventId: "second" }, { workerSeat: "worker-1", tool: "read" });
    const mapping = mapTeamEvents([first, duplicate, second], { coalesceWindowMs: 250 });
    const activity = mapping.intents.filter(intent => intent.kind === "activity");
    expect(activity).toHaveLength(1);
    expect(activity[0]?.count).toBe(2);

    const sequenced = event("worker.tool.completed", 300, { eventId: undefined, seq: 17 }, { workerSeat: "worker-1", tool: "read" });
    const repeatedSequence = { ...sequenced };
    const sequenceMapping = mapTeamEvents([sequenced, repeatedSequence], { coalesceWindowMs: 250 });
    expect(sequenceMapping.intents.filter(intent => intent.kind === "activity")).toHaveLength(1);
  });

  it("caps particles while retaining static node states", () => {
    const mapping = mapTeamEvents(HIGH_DENSITY_EVENTS, { seats: HIGH_DENSITY_SEATS, maxParticles: 12 });
    expect(mapping.particles.length).toBeLessThanOrEqual(12);
    expect(mapping.staticIntents.every(intent => intent.kind === "static")).toBe(true);
    expect(mapping.nodes.length).toBeGreaterThanOrEqual(12);
  });

  it("uses the documented defaults for fixture-sized runs", () => {
    const mapping = mapTeamEvents(LOW_DENSITY_EVENTS);
    expect(mapping.particles.length).toBeLessThanOrEqual(FLOW_DEFAULTS.maxParticles);
    expect(mapping.nodes.some(node => node.role === "lead")).toBe(true);
  });
});
