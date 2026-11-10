import type { FlowEvent, FlowSeat } from "./flow-events.js";

const BASE_TIME = Date.parse("2026-11-10T00:00:00.000Z");

export const FLOW_FIXTURE_SEATS: readonly FlowSeat[] = [
  { id: "lead", label: "Lead", role: "lead" },
  { id: "worker-1", label: "Worker 1", role: "implementer" },
  { id: "reviewer", label: "Reviewer", role: "reviewer" },
];

function event(action: string, offset: number, overrides: Partial<FlowEvent> = {}, payload: Record<string, unknown> = {}): FlowEvent {
  const eventId = overrides.eventId ?? `fixture-${offset}-${action}`;
  return {
    type: "team.control",
    protocolVersion: "1.0",
    eventId,
    runId: "run-fixture",
    taskId: overrides.taskId ?? "task-1",
    attemptId: overrides.attemptId ?? "attempt-1",
    entityId: overrides.entityId ?? "worker-1",
    entityVersion: overrides.entityVersion ?? offset + 1,
    action,
    payload,
    timestamp: BASE_TIME + offset,
    ...overrides,
  };
}

export const LOW_DENSITY_EVENTS: readonly FlowEvent[] = [
  event("task.created", 0, {}, { leadSeat: "lead", workerSeat: "worker-1" }),
  event("attempt.admitted", 80, {}, { leadSeat: "lead", workerSeat: "worker-1" }),
  event("attempt.started", 180),
  event("worker.tool.started", 260, {}, { workerSeat: "worker-1", tool: "read" }),
  event("worker.tool.completed", 360, {}, { workerSeat: "worker-1", tool: "read" }),
  event("attempt.acknowledged", 440),
  event("worker.tool.started", 600, {}, { workerSeat: "worker-1", tool: "edit" }),
  event("worker.tool.completed", 780, {}, { workerSeat: "worker-1", tool: "edit" }),
  event("review.verdict", 900, {}, { workerSeat: "worker-1", reviewerSeat: "reviewer", verdict: "accepted" }),
  event("task.outcome", 1_100, {}, { workerSeat: "worker-1", leadSeat: "lead", status: "done" }),
  event("task.integrated", 1_220, {}, { workerSeat: "worker-1", integrationId: "integration" }),
  event("chat.message", 1_400, { taskId: null, attemptId: null, entityId: "lead" }, { source: "owner", target: "lead", body: "Keep going" }),
  event("lead.woken", 1_600, { taskId: null, attemptId: null, entityId: "lead" }, { source: "lead", note: "New owner message" }),
  event("worker.waiting", 1_800, { entityId: "worker-1" }, { seat: "worker-1", state: "waiting" }),
  event("worker.error", 1_900, { entityId: "worker-1" }, { seat: "worker-1", state: "error" }),
  event("worker.occupant", 2_000, { entityId: "worker-1" }, { seat: "worker-1", state: "ambiguous" }),
  event("task.created", 2_120, { eventId: "fixture-second-task", taskId: "task-2", attemptId: null, entityId: "worker-1" }, { leadSeat: "lead", workerSeat: "worker-1" }),
  event("attempt.started", 2_200, { eventId: "fixture-no-response", taskId: "task-2", attemptId: "attempt-2", entityId: "worker-1" }),
  event("chat.message", 2_420, { eventId: "fixture-chat-2", taskId: null, attemptId: null, entityId: "lead" }, { source: "owner", target: "lead", body: "Status?" }),
  event("task.outcome", 2_600, { eventId: "fixture-outcome-2", taskId: "task-2", attemptId: "attempt-2", entityId: "worker-1" }, { workerSeat: "worker-1", leadSeat: "lead", status: "done" }),
];

export const HIGH_DENSITY_SEATS: readonly FlowSeat[] = [
  { id: "lead", label: "Lead", role: "lead" },
  ...Array.from({ length: 10 }, (_, index) => ({ id: `worker-${index + 1}`, label: `Worker ${index + 1}`, role: "implementer" as const })),
  { id: "reviewer", label: "Reviewer", role: "reviewer" },
];

export const HIGH_DENSITY_EVENTS: readonly FlowEvent[] = Array.from({ length: 2_000 }, (_, index) => {
  const worker = `worker-${(index % 10) + 1}`;
  const taskId = `task-${(index % 48) + 1}`;
  const attemptId = `attempt-${(index % 48) + 1}`;
  const cycle = index % 10;
  if (cycle === 0) return event("task.created", index * 20, { eventId: `high-${index}`, taskId, attemptId: null, entityId: worker }, { leadSeat: "lead", workerSeat: worker });
  if (cycle === 1) return event("attempt.admitted", index * 20, { eventId: `high-${index}`, taskId, attemptId, entityId: worker }, { leadSeat: "lead", workerSeat: worker });
  if (cycle === 2) return event("attempt.started", index * 20, { eventId: `high-${index}`, taskId, attemptId, entityId: worker }, { workerSeat: worker });
  if (cycle === 3) return event("attempt.acknowledged", index * 20, { eventId: `high-${index}`, taskId, attemptId, entityId: worker }, { workerSeat: worker });
  if (cycle === 4 || cycle === 5 || cycle === 6) return event("worker.tool.completed", index * 20, { eventId: `high-${index}`, taskId, attemptId, entityId: worker }, { workerSeat: worker, tool: cycle === 4 ? "read" : cycle === 5 ? "edit" : "test" });
  if (cycle === 7) return event("review.verdict", index * 20, { eventId: `high-${index}`, taskId, attemptId, entityId: worker }, { workerSeat: worker, reviewerSeat: "reviewer", verdict: index % 4 ? "accepted" : "changes-requested" });
  if (cycle === 8) return event("task.outcome", index * 20, { eventId: `high-${index}`, taskId, attemptId, entityId: worker }, { workerSeat: worker, leadSeat: "lead", status: "done" });
  return event("task.integrated", index * 20, { eventId: `high-${index}`, taskId, attemptId, entityId: worker }, { workerSeat: worker, integrationId: "integration" });
});

export const lowDensityFixture = { seats: FLOW_FIXTURE_SEATS, events: LOW_DENSITY_EVENTS } as const;
export const highDensityFixture = { seats: HIGH_DENSITY_SEATS, events: HIGH_DENSITY_EVENTS } as const;

