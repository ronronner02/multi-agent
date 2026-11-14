import type { TeamReplayEvent, TeamSeatView } from "@multi-agent/daemon/team-control";
import type { FlowEvent, FlowRole, FlowSeat } from "./flow-events.js";

function bodyPayload(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Event bodies are bounded and redacted at the daemon boundary; malformed text is inert.
  }
  return {};
}

function entityId(event: TeamReplayEvent): string {
  return event.attemptId ?? event.taskId ?? event.runId ?? `event-${event.seq}`;
}

/** Convert the nullable, redacted replay contract into the renderer's stable event shape. */
export function adaptTeamReplayEvent(event: TeamReplayEvent, fallbackRunId = ""): FlowEvent {
  return {
    type: event.type,
    eventId: `replay:${event.seq}`,
    runId: event.runId ?? fallbackRunId,
    taskId: event.taskId,
    attemptId: event.attemptId,
    entityId: entityId(event),
    action: event.action ?? "event.unknown",
    payload: bodyPayload(event.body),
    createdAt: event.createdAt,
    seq: event.seq,
  };
}

export function adaptTeamEvents(events: readonly TeamReplayEvent[], fallbackRunId = ""): FlowEvent[] {
  return events.map(event => adaptTeamReplayEvent(event, fallbackRunId));
}

export function mapTeamSeat(seat: TeamSeatView): FlowSeat {
  return { id: seat.seat, label: seat.displayName, role: seat.role as FlowRole };
}
