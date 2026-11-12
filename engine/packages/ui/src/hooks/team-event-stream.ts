import type { TeamReadModel } from "@multi-agent/daemon/team-control";

export type TeamReplay = ReturnType<TeamReadModel["replay"]>;
export type TeamEvent = TeamReplay["events"][number];
export interface AttemptEventFacts { startedAt: number | null; acknowledged: boolean; providerEvent: boolean }
export interface TeamEventState extends TeamReplay {
  cursor: number;
  initialized: boolean;
  trimmedThrough: number;
  attempts: Record<string, AttemptEventFacts>;
  connection: "connecting" | "live" | "reconnecting" | "denied";
}

export interface SSEMessage { event: string; id: string; data: string }

/** Decode lines across arbitrary UTF-8 chunks, including split CRLF delimiters. */
export async function* readSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SSEMessage> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let line = "", skipLF = false, event = "", id = "", data: string[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      const text = decoder.decode(chunk.value, { stream: !chunk.done });
      for (const char of text) {
        if (skipLF && char === "\n") { skipLF = false; continue; }
        skipLF = false;
        if (char !== "\n" && char !== "\r") { line += char; continue; }
        skipLF = char === "\r";
        if (!line) {
          if (data.length) yield { event: event || "message", id, data: data.join("\n") };
          event = ""; id = ""; data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (field === "event") event = value;
          else if (field === "id" && !value.includes("\0")) id = value;
        }
        line = "";
      }
      // An incomplete frame at EOF is not committed; reconnect replays it.
      if (chunk.done) break;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function parseTeamEvent(value: unknown, runId: string): TeamEvent {
  const event = value as Partial<TeamEvent> | null;
  if (!event || event.runId !== runId || !Number.isSafeInteger(event.seq) || event.seq! <= 0
    || typeof event.createdAt !== "string" || typeof event.type !== "string" || typeof event.body !== "string"
    || typeof event.truncated !== "boolean" || ![event.action, event.taskId, event.attemptId].every(value => value === null || typeof value === "string")) {
    throw new TypeError("Invalid team event");
  }
  return event as TeamEvent;
}

/** The query cache owns the single bounded replay/live record list. Sequences are global, not contiguous per run. */
export function mergeTeamEvents(state: TeamEventState, incoming: readonly TeamEvent[]): TeamEventState {
  const records = new Map(state.events.map(event => [event.seq, event]));
  const attempts = { ...state.attempts };
  for (const event of incoming) {
    if (event.seq <= state.trimmedThrough || records.has(event.seq)) continue;
    records.set(event.seq, event);
    if (!event.attemptId) continue;
    const facts = { ...(attempts[event.attemptId] ?? { startedAt: null, acknowledged: false, providerEvent: false }) };
    // SQLite's zone-less event timestamps are UTC, including in a browser with a local time zone.
    if (event.action === "attempt.started") facts.startedAt = Date.parse(event.createdAt.includes("T")
      ? event.createdAt : event.createdAt.replace(" ", "T") + "Z");
    if (event.action === "attempt.acknowledged") facts.acknowledged = true;
    if (event.action?.startsWith("worker.")) facts.providerEvent = true;
    attempts[event.attemptId] = facts;
  }
  const ordered = [...records.values()].sort((a, b) => a.seq - b.seq);
  const events = ordered.slice(-200);
  const trimmedThrough = ordered.length > 200 ? ordered[ordered.length - 201]!.seq : state.trimmedThrough;
  const cursor = Math.max(state.cursor, ...incoming.map(event => event.seq));
  return { ...state, events, attempts, cursor, trimmedThrough, window: { ...state.window, latestSeq: Math.max(state.window.latestSeq, cursor) } };
}

export interface TeamStreamOptions {
  runId: string;
  signal: AbortSignal;
  open: (path: string, init: RequestInit) => Promise<Response>;
  replay: (afterSeq: number, signal: AbortSignal) => Promise<TeamReplay>;
  read: () => TeamEventState;
  update: (state: TeamEventState) => void;
  invalidate: () => void;
  permissionFailure: (error: unknown) => boolean;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function streamTeamEvents(options: TeamStreamOptions): Promise<void> {
  const { runId, signal, open, replay, read, update, invalidate, permissionFailure } = options;
  let failures = 0;
  const accept = (events: TeamEvent[]) => {
    signal.throwIfAborted();
    const previous = read();
    const known = new Set(previous.events.map(event => event.seq));
    const accepted = events.filter(event => event.seq > previous.trimmedThrough && !known.has(event.seq));
    if (!accepted.length) return;
    update(mergeTeamEvents(previous, accepted));
    invalidate();
  };
  const catchUp = async (afterSeq: number) => {
    let cursor = afterSeq;
    for (;;) {
      const page = await replay(cursor, signal);
      signal.throwIfAborted();
      const events = page.events.map(event => parseTeamEvent(event, runId));
      accept(events);
      update({ ...read(), window: page.window, gap: read().gap || page.gap });
      const next = Math.max(cursor, ...events.map(event => event.seq));
      if (next <= cursor || events.length < 500) break;
      cursor = next;
    }
  };
  while (!signal.aborted) {
    try {
      update({ ...read(), connection: failures ? "reconnecting" : "connecting" });
      // Fold retained lifecycle facts once so remounting cannot turn an old acknowledgment into no-response.
      if (!read().initialized) { await catchUp(0); update({ ...read(), initialized: true }); }
      const response = await open(`/runs/${encodeURIComponent(runId)}/events/stream`, {
        signal, headers: { Accept: "text/event-stream", "Last-Event-ID": String(read().cursor) },
      });
      signal.throwIfAborted();
      if (!response.body || !response.headers.get("Content-Type")?.startsWith("text/event-stream")) throw new TypeError("Invalid team stream");
      update({ ...read(), connection: "live" });
      // Reconcile projections after reconnect, even if no new durable record remains.
      invalidate();
      for await (const message of readSSE(response.body, signal)) {
        if (message.event === "gap") {
          const gap = JSON.parse(message.data) as { protocolVersion?: string; runId?: string };
          if (gap.protocolVersion !== "1.0" || gap.runId !== runId) throw new TypeError("Invalid team gap");
          update({ ...read(), gap: true });
          invalidate();
          await catchUp(read().cursor);
        } else if (message.event === "message") {
          const event = parseTeamEvent(JSON.parse(message.data), runId);
          if (message.id !== String(event.seq)) throw new TypeError("Invalid team event sequence");
          accept([event]);
          failures = 0;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (permissionFailure(error)) { update({ ...read(), connection: "denied" }); return; }
    }
    if (signal.aborted) return;
    update({ ...read(), connection: "reconnecting" });
    // A closed/failed stream retries from 500 ms up to 8 seconds; abort clears the timer.
    await delay(Math.min(500 * 2 ** Math.min(failures++, 4), 8_000), signal).catch(() => {});
  }
}
