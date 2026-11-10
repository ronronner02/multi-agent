/**
 * The Flow view's local event vocabulary.
 *
 * The daemon deliberately is not imported here. U16 supplies durable `team.control` records;
 * this file is the pure, bounded translation from those records to visual intents.
 */

export type FlowRole = "lead" | "implementer" | "reviewer" | "owner" | "integration" | "worker";

export type FlowNodeState =
  | "idle"
  | "started"
  | "acknowledged"
  | "working"
  | "waiting"
  | "error"
  | "ambiguous"
  | "no-response"
  | "complete";

export type FlowIntentKind =
  | "assignment"
  | "started"
  | "acknowledgment"
  | "activity"
  | "review"
  | "delivery"
  | "integration"
  | "lead-message"
  | "static";

/** The durable shape consumed from the replay/live event stream. */
export interface FlowEvent {
  type?: "team.control" | string;
  protocolVersion?: string;
  eventId?: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  entityId: string;
  entityVersion?: number;
  action: string;
  payload: Record<string, unknown>;
  /** Replay adapters may provide either field; both are optional for fixture-friendly callers. */
  timestamp?: string | number;
  createdAt?: string | number;
  seq?: number;
}

export interface FlowSeat {
  id: string;
  label?: string;
  role?: FlowRole;
}

export interface FlowNode {
  id: string;
  label: string;
  role: FlowRole;
  state: FlowNodeState;
  activityCount: number;
  lastEventAt: number;
}

export interface FlowIntent {
  id: string;
  kind: FlowIntentKind;
  sourceId: string;
  targetId: string | null;
  nodeId: string | null;
  action: string;
  eventId: string;
  taskId: string | null;
  attemptId: string | null;
  createdAt: number;
  count: number;
  label: string;
  state?: FlowNodeState;
}

export interface FlowMappingOptions {
  /** Events in one edge burst are represented by one intent with a count. */
  coalesceWindowMs?: number;
  /** Maximum animated/static intents retained by the renderer-facing model. */
  maxParticles?: number;
  /** Used only when an input event has no timestamp. */
  now?: number;
  seats?: readonly FlowSeat[];
}

export interface FlowMapping {
  nodes: FlowNode[];
  intents: FlowIntent[];
  particles: FlowIntent[];
  staticIntents: FlowIntent[];
  events: FlowEvent[];
}

const DEFAULT_COALESCE_WINDOW_MS = 280;
const DEFAULT_MAX_PARTICLES = 96;
const LEAD_ID = "lead";
const OWNER_ID = "owner";
const INTEGRATION_ID = "integration";

const ACTIONS_WITHOUT_ANIMATION = new Set(["attempt.recorded", "task.transitioned"]);

function value(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = payload[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function numberValue(input: string | number | undefined, fallback: number): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string") {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(input);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function eventTime(event: FlowEvent, index: number, now: number): number {
  return numberValue(event.timestamp ?? event.createdAt, now + index);
}

function payloadState(event: FlowEvent): string {
  return (value(event.payload, "state", "status", "occupantState", "occupantLifecycle", "outcome") ?? "").toLowerCase();
}

function roleFor(id: string, hint?: string): FlowRole {
  const role = hint?.toLowerCase();
  if (role === "lead" || role === "implementer" || role === "reviewer" || role === "owner" || role === "integration" || role === "worker") {
    return role;
  }
  if (id === LEAD_ID || /(^|[-_:.])lead($|[-_:.])/i.test(id)) return "lead";
  if (id === OWNER_ID || /owner/i.test(id)) return "owner";
  if (id === INTEGRATION_ID || /integration/i.test(id)) return "integration";
  if (/review/i.test(id)) return "reviewer";
  return "worker";
}

function labelFor(id: string, payload?: Record<string, unknown>): string {
  return value(payload ?? {}, "label", "displayName", "display_name", "name") ?? id;
}

function sourceAndTarget(event: FlowEvent, kind: FlowIntentKind): { sourceId: string; targetId: string | null } {
  const payload = event.payload;
  const explicitSource = value(payload, "sourceId", "source", "from", "fromSeat", "sourceSession", "sourceSessionName");
  const explicitTarget = value(payload, "targetId", "target", "to", "toSeat", "destinationSession", "destinationSessionName", "reviewerId", "reviewerSeat", "integrationId", "ownerId");
  const worker = value(payload, "workerId", "workerSeat", "worker", "seat", "session", "destination", "destinationSession", "destinationSessionName")
    ?? event.entityId
    ?? event.taskId
    ?? "worker";
  const reviewer = value(payload, "reviewerId", "reviewerSeat", "reviewer") ?? "reviewer";

  if (kind === "assignment") return { sourceId: explicitSource ?? LEAD_ID, targetId: explicitTarget ?? worker };
  if (kind === "acknowledgment" || kind === "delivery") return { sourceId: explicitSource ?? worker, targetId: explicitTarget ?? LEAD_ID };
  if (kind === "review") return { sourceId: explicitSource ?? worker, targetId: explicitTarget ?? reviewer };
  if (kind === "integration") return { sourceId: explicitSource ?? worker, targetId: explicitTarget ?? INTEGRATION_ID };
  if (kind === "lead-message") return { sourceId: explicitSource ?? LEAD_ID, targetId: explicitTarget ?? null };
  return { sourceId: explicitSource ?? worker, targetId: explicitTarget ?? null };
}

function stablePayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

function eventIdentity(event: FlowEvent, index: number): string {
  if (typeof event.seq === "number") return `sequence:${event.runId}:${event.seq}`;
  return event.eventId ?? `${event.action}:${event.runId}:${event.taskId ?? ""}:${event.attemptId ?? ""}:${event.entityId}:${event.entityVersion ?? ""}:${stablePayload(event.payload)}:${index}`;
}

function stateIntent(event: FlowEvent, time: number, id: string, state: FlowNodeState, label: string): FlowIntent {
  const eventId = event.eventId ?? eventIdentity(event, 0);
  return {
    id: `static:${eventId}:${state}`,
    kind: "static",
    sourceId: id,
    targetId: null,
    nodeId: id,
    action: event.action,
    eventId,
    taskId: event.taskId,
    attemptId: event.attemptId,
    createdAt: time,
    count: 1,
    label,
    state,
  };
}

function intentFor(event: FlowEvent, index: number, time: number): FlowIntent | null {
  const action = event.action.toLowerCase();
  if (ACTIONS_WITHOUT_ANIMATION.has(action)) return null;

  let kind: FlowIntentKind | null = null;
  let label = action;
  let state: FlowNodeState | undefined;
  if (action === "task.created" || action === "attempt.admitted") {
    kind = "assignment";
    label = action === "task.created" ? "Task assigned" : "Attempt admitted";
  } else if (action === "attempt.started") {
    kind = "started";
    state = "started";
    label = "Attempt started";
  } else if (action === "attempt.acknowledged") {
    kind = "acknowledgment";
    state = "acknowledged";
    label = "Attempt acknowledged";
  } else if (action.startsWith("worker.tool.")) {
    kind = "activity";
    state = "working";
    label = value(event.payload, "tool", "title", "name") ?? "Tool activity";
  } else if (action === "review.verdict") {
    kind = "review";
    label = value(event.payload, "verdict", "status") ?? "Review verdict";
  } else if (action === "task.outcome" || action === "task.outcome.denied") {
    kind = "delivery";
    state = action.endsWith("denied") ? "error" : "complete";
    label = action.endsWith("denied") ? "Task delivery denied" : "Task delivered";
  } else if (action === "task.integrated") {
    kind = "integration";
    state = "complete";
    label = "Task integrated";
  } else if (action === "chat.message" || action === "lead.woken" || action === "run.lead-woken") {
    kind = "lead-message";
    label = action === "lead.woken" || action === "run.lead-woken" ? "Lead woken" : "Lead message";
  } else if (action.includes("waiting") || action === "worker.permission.state" || payloadState(event) === "waiting" || payloadState(event) === "pending") {
    return stateIntent(event, time, value(event.payload, "seat", "worker", "session") ?? event.entityId ?? "worker", "waiting", "Waiting");
  } else if (action.includes("ambiguous") || payloadState(event) === "ambiguous" || payloadState(event) === "unknown") {
    return stateIntent(event, time, value(event.payload, "seat", "worker", "session") ?? event.entityId ?? "worker", "ambiguous", "Ambiguous occupant");
  } else if (action.includes("error") || action.includes("failed") || action === "worker.provider.error" || payloadState(event) === "error" || payloadState(event) === "failed") {
    return stateIntent(event, time, value(event.payload, "seat", "worker", "session") ?? event.entityId ?? "worker", "error", "Worker error");
  } else {
    return null;
  }

  const route = sourceAndTarget(event, kind);
  const eventId = event.eventId ?? eventIdentity(event, index);
  return {
    id: `intent:${eventId}`,
    kind,
    sourceId: route.sourceId,
    targetId: route.targetId,
    nodeId: kind === "activity" || kind === "started" || kind === "acknowledgment" ? route.sourceId : null,
    action: event.action,
    eventId,
    taskId: event.taskId,
    attemptId: event.attemptId,
    createdAt: time,
    count: 1,
    label,
    state,
  };
}

function ensureNode(nodes: Map<string, FlowNode>, id: string, event: FlowEvent, time: number, state?: FlowNodeState): void {
  if (!id) return;
  const payload = event.payload;
  const existing = nodes.get(id);
  const nextState = state ?? existing?.state ?? "idle";
  const next: FlowNode = existing ?? {
    id,
    label: labelFor(id, payload),
    role: roleFor(id, value(payload, "role") ?? undefined),
    state: "idle",
    activityCount: 0,
    lastEventAt: time,
  };
  next.state = nextState;
  next.lastEventAt = Math.max(next.lastEventAt, time);
  if (state === "working" || state === "started" || state === "acknowledged") next.activityCount += 1;
  nodes.set(id, next);
}

function coalesce(intents: FlowIntent[], windowMs: number): FlowIntent[] {
  const output: FlowIntent[] = [];
  const lastByEdge = new Map<string, FlowIntent>();
  for (const intent of intents) {
    if (intent.kind === "static") {
      output.push(intent);
      continue;
    }
    const edge = `${intent.kind}:${intent.sourceId}:${intent.targetId ?? intent.nodeId ?? ""}`;
    const previous = lastByEdge.get(edge);
    if (previous && intent.createdAt - previous.createdAt <= windowMs) {
      previous.count += 1;
      previous.label = `${intent.label} ×${previous.count}`;
      previous.createdAt = intent.createdAt;
      previous.eventId = intent.eventId;
      previous.id = `${previous.id.split(":")[0]}:${previous.eventId}`;
    } else {
      const copy = { ...intent };
      output.push(copy);
      lastByEdge.set(edge, copy);
    }
  }
  return output;
}

/** Map durable events into the bounded model consumed by the renderer and DOM fallback. */
export function mapTeamEvents(events: readonly FlowEvent[], options: FlowMappingOptions = {}): FlowMapping {
  const coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  const maxParticles = options.maxParticles ?? DEFAULT_MAX_PARTICLES;
  const now = options.now ?? Date.now();
  const unique = new Map<string, { event: FlowEvent; index: number; time: number }>();
  for (const [index, event] of events.entries()) {
    const identity = event.eventId ?? eventIdentity(event, index);
    if (!unique.has(identity)) unique.set(identity, { event, index, time: eventTime(event, index, now) });
  }

  const nodes = new Map<string, FlowNode>();
  for (const seat of options.seats ?? []) {
    nodes.set(seat.id, { id: seat.id, label: seat.label ?? seat.id, role: seat.role ?? roleFor(seat.id), state: "idle", activityCount: 0, lastEventAt: 0 });
  }
  nodes.set(LEAD_ID, nodes.get(LEAD_ID) ?? { id: LEAD_ID, label: "Lead", role: "lead", state: "idle", activityCount: 0, lastEventAt: 0 });

  const rawIntents: FlowIntent[] = [];
  const started = new Map<string, FlowIntent>();
  const acknowledged = new Set<string>();
  const materializedEvents: FlowEvent[] = [];

  for (const { event, index, time } of unique.values()) {
    materializedEvents.push(event);
    const intent = intentFor(event, index, time);
    if (intent) rawIntents.push(intent);
    if (event.action === "attempt.started" && event.attemptId) started.set(event.attemptId, intent ?? stateIntent(event, time, sourceAndTarget(event, "started").sourceId, "started", "Attempt started"));
    if (event.action === "attempt.acknowledged" && event.attemptId) acknowledged.add(event.attemptId);
    if (intent) {
      const route = sourceAndTarget(event, intent.kind);
      ensureNode(nodes, route.sourceId, event, time, intent.state ?? (intent.kind === "activity" ? "working" : undefined));
      if (route.targetId) ensureNode(nodes, route.targetId, event, time);
      if (intent.kind === "activity" && intent.nodeId) ensureNode(nodes, intent.nodeId, event, time, "working");
    }
    if (intent?.kind === "started" && intent.nodeId) ensureNode(nodes, intent.nodeId, event, time, "started");
    if (intent?.kind === "acknowledgment" && intent.nodeId) ensureNode(nodes, intent.nodeId, event, time, "acknowledged");
    if (intent?.kind === "delivery" && intent.nodeId) ensureNode(nodes, intent.nodeId, event, time, intent.state);
  }

  for (const [attemptId, intent] of started) {
    if (acknowledged.has(attemptId)) continue;
    const nodeId = intent.nodeId ?? intent.sourceId;
    const noResponse: FlowIntent = {
      ...intent,
      id: `${intent.id}:no-response`,
      kind: "static",
      nodeId,
      targetId: null,
      label: "No response yet",
      state: "no-response",
    };
    rawIntents.push(noResponse);
    const node = nodes.get(nodeId);
    if (node) node.state = "no-response";
  }

  const coalesced = coalesce(rawIntents, coalesceWindowMs);
  const staticIntents = coalesced.filter(intent => intent.kind === "static");
  const particles = coalesced.filter(intent => intent.kind !== "static").slice(-maxParticles);
  const intents = [...staticIntents, ...particles];
  for (const event of options.seats ?? []) {
    if (!nodes.has(event.id)) nodes.set(event.id, { id: event.id, label: event.label ?? event.id, role: event.role ?? roleFor(event.id), state: "idle", activityCount: 0, lastEventAt: 0 });
  }
  return { nodes: [...nodes.values()], intents, particles, staticIntents, events: materializedEvents };
}

export const mapFlowEvents = mapTeamEvents;
export const FLOW_DEFAULTS = { coalesceWindowMs: DEFAULT_COALESCE_WINDOW_MS, maxParticles: DEFAULT_MAX_PARTICLES } as const;
