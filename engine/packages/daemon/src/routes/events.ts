import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { PersistedEvent } from "../domain/types.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";
import { parseProtocolVersion, TEAM_CONTROL_VERSION, canonicalJson } from "../contracts/team-control.js";
import { boundedLogBody, type TeamReadModel } from "../team-control-surface.js";

export const eventsRoute = new Hono();

function getEventBus(c: { get: (key: string) => unknown }): EventBus {
  return c.get("eventBus" as never) as EventBus;
}

/**
 * T052 — the managed, owner-authenticated, run-scoped replay reader.
 *
 * This route is the transport owner only: it authenticates the owner, scopes by
 * run, and replays persisted events with their sequence ids. It synthesizes no
 * workflow state and keeps no store of its own. The legacy `/api/events` stream
 * below is deliberately untouched, because legacy admission must stay exactly
 * as it was; the managed mount is separate and additive.
 */
export interface TeamEventsOptions {
  credentials: TeamControlCredentials;
  legacyTokens: readonly (string | null | undefined)[];
  /**
   * T052 — the composed read projection. The page endpoint delegates to it so
   * identity, redaction, bounding and the gap verdict are decided in one place
   * rather than re-derived by the transport.
   */
  readModel?: TeamReadModel;
}

const TEAM_READ_UNAVAILABLE = {
  code: "team_read_unavailable",
  error: "The managed read projection is not composed.",
} as const;

export function teamEventsRoutes(options: TeamEventsOptions): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("*", teamControlAuthentication(() => options.credentials, options.legacyTokens));

  const ownerScope = (c: { get: (key: never) => unknown; req: { param: (key: string) => string } }) => {
    if ((c.get("controlActor" as never) as { kind: string }).kind !== "owner") return "worker" as const;
    const scope = c.get("controlRunId" as never) as string | null;
    return scope !== null && scope !== c.req.param("runId") ? "cross-run" as const : "ok" as const;
  };

  /**
   * One bounded replay page.
   *
   * Identity is preserved on every record — sequence, time, type and the
   * action/task/attempt the producer committed — because a reader that lost the
   * action could not tell a review from an exit. The body is the same bounded,
   * redacted text the snapshot publishes.
   */
  app.get("/runs/:runId/events", (c) => {
    // Only an owner may read committed run evidence; a worker credential can
    // request decisions but never read the owner projections (KTD6).
    const allowed = ownerScope(c);
    if (allowed === "worker") return c.json({ code: "owner_control_required" }, 403);
    if (allowed === "cross-run") return c.json({ code: "control_scope_denied" }, 403);
    const runId = c.req.param("runId");
    try {
      parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    } catch {
      return c.json({ code: "invalid_team_contract" }, 400);
    }
    const afterRaw = c.req.query("afterSeq") ?? c.req.header("Last-Event-ID") ?? "0";
    const afterSeq = Number.parseInt(afterRaw, 10);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return c.json({ code: "invalid_team_contract" }, 400);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "500", 10);
    const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 500;
    if (!options.readModel) return c.json(TEAM_READ_UNAVAILABLE, 503);
    const page = options.readModel.replay(runId, afterSeq, limit);
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, runId, ...page });
  });

  /**
   * The live tail: a run-scoped SSE stream with subscribe-before-replay.
   *
   * Ordering is the whole point. The subscriber is attached *before* the
   * replay query so an event committed between the two is buffered rather than
   * lost; the buffer then drains in sequence order, and only afterwards does
   * the stream switch to live. Persisted sequence ids survive as the SSE id, so
   * a reconnect resumes from the last event the client actually saw.
   */
  app.get("/runs/:runId/events/stream", (c) => {
    const allowed = ownerScope(c);
    if (allowed === "worker") return c.json({ code: "owner_control_required" }, 403);
    if (allowed === "cross-run") return c.json({ code: "control_scope_denied" }, 403);
    const runId = c.req.param("runId");
    try {
      parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    } catch {
      return c.json({ code: "invalid_team_contract" }, 400);
    }
    const lastId = Number.parseInt(c.req.header("Last-Event-ID") ?? c.req.query("afterSeq") ?? "0", 10);
    const cursor = Number.isSafeInteger(lastId) && lastId >= 0 ? lastId : 0;
    const bus = getEventBus(c);

    return streamSSE(c, async (stream) => {
      const buffer: PersistedEvent[] = [];
      let replaying = true;
      let highest = cursor;
      const belongs = (event: PersistedEvent) =>
        (event as unknown as { runId?: unknown }).runId === runId;
      const window = bus.replayWindow();
      // An explicit gap is announced before any event, so a client that resumed
      // from a pruned cursor knows it missed history instead of assuming a lull.
      if (cursor > 0 && cursor < window.retainedFrom) {
        await stream.writeSSE({ event: "gap", data: JSON.stringify({
          protocolVersion: TEAM_CONTROL_VERSION, runId, afterSeq: cursor, retainedFrom: window.retainedFrom }) });
      }

      // 1. Subscribe BEFORE replay, so nothing committed in between is lost.
      const unsubscribe = bus.subscribe((event) => {
        if (!belongs(event)) return;
        if (replaying) buffer.push(event);
        else if (event.seq > highest) {
          highest = event.seq;
          stream.writeSSE({ id: String(event.seq), data: JSON.stringify(boundedEvent(event)) }).catch(() => {});
        }
      });
      const aborted = new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      try {
        // 2. Replay what the client missed, in sequence order, in pages.
        //
        //    Paging matters: a reconnect with more backlog than one page would
        //    otherwise stop mid-history, switch to live, and then advance its
        //    SSE cursor past the events it never sent — a permanent, silent
        //    skip. `replayCursor` walks the backlog to its end; only then does
        //    the stream switch to live.
        const PAGE = 500;
        let replayCursor = cursor;
        for (;;) {
          const page = bus.replayRunSince(runId, replayCursor, PAGE);
          if (page.length === 0) break;
          for (const event of page) {
            await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(boundedEvent(event)) });
            if (event.seq > highest) highest = event.seq;
            replayCursor = event.seq;
          }
          if (page.length < PAGE) break;
        }
        // 3. Drain the buffer in order, deduplicating anything replay already sent.
        while (buffer.length > 0) {
          for (const event of buffer.splice(0)) {
            if (event.seq <= highest) continue;
            await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(boundedEvent(event)) });
            highest = event.seq;
          }
        }
        // 4. Switch to live.
        replaying = false;
        await aborted;
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}

/** One event as the managed stream publishes it: identity kept, body bounded. */
function boundedEvent(event: PersistedEvent): Record<string, unknown> {
  const envelope = event as unknown as {
    action?: unknown; runId?: unknown; taskId?: unknown; attemptId?: unknown; payload?: unknown;
  };
  const bounded = boundedLogBody(canonicalJson(envelope.payload ?? {}));
  return {
    seq: event.seq,
    createdAt: event.createdAt,
    type: event.type,
    // The full identity a replay consumer needs: which run, which task, which
    // attempt and which action. Dropping any of them makes the stream record
    // uncorrelatable, and the page endpoint publishes the same set.
    runId: typeof envelope.runId === "string" ? envelope.runId : null,
    action: typeof envelope.action === "string" ? envelope.action : null,
    taskId: typeof envelope.taskId === "string" ? envelope.taskId : null,
    attemptId: typeof envelope.attemptId === "string" ? envelope.attemptId : null,
    body: bounded.body,
    truncated: bounded.truncated,
  };
}

eventsRoute.get("/", (c) => {
  const rigId = c.req.query("rigId"); // Optional — omit for global stream

  const lastEventIdRaw = c.req.header("Last-Event-ID") ?? "0";
  const lastEventId = parseInt(lastEventIdRaw, 10);
  const lastSeq = isNaN(lastEventId) ? 0 : lastEventId;

  const eventBus = getEventBus(c);

  return streamSSE(c, async (stream) => {
    // Buffer for live events arriving during replay
    const buffer: PersistedEvent[] = [];
    let replaying = true;
    let maxReplayedSeq = lastSeq;

    // 1. Subscribe to live bus BEFORE replay query (no gap)
    const unsubscribe = eventBus.subscribe((event) => {
      // Rig-scoped: filter by rigId. Global: accept all events.
      if (rigId) {
        const eventRigId = "rigId" in event ? (event as { rigId: string }).rigId : null;
        if (eventRigId !== rigId) return;
      }
      if (replaying) {
        buffer.push(event);
      } else {
        // Stream directly — skip if already sent during replay
        if (event.seq <= maxReplayedSeq) return;
        stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) }).catch(() => {});
      }
    });

    const aborted = new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });

    try {
      // 2. Replay missed events from DB
      const missed = rigId
        ? eventBus.replaySince(lastSeq, rigId)
        : eventBus.replayAll(lastSeq);
      for (const event of missed) {
        await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
        if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
      }

      // 3. Drain buffer while still in replaying mode (new live events
      //    continue to buffer, preserving monotonic ordering)
      //    Drain in a loop since new events may arrive during drain.
      while (buffer.length > 0) {
        const snapshot = buffer.splice(0);
        for (const event of snapshot) {
          if (event.seq <= maxReplayedSeq) continue; // dedup
          await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
          if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
        }
      }

      // 4. Switch to live mode — new events go directly to stream
      replaying = false;

      // 4. Keep stream alive until client disconnects
      await aborted;
    } finally {
      unsubscribe();
    }
  });
});
