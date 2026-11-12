import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { TeamOwnerRead } from "@multi-agent/daemon/team-control";
import { OwnerReadError, useOwnerSession } from "./useOwnerSession.js";
import { streamTeamEvents, type TeamEventState, type TeamReplay } from "./team-event-stream.js";

// Transport lifetimes only. All event data and cursors live in the existing query cache.
const connections = new WeakMap<QueryClient, Map<string, { users: number; controller: AbortController }>>();
export const teamEventsKey = (runId: string) => ["team", runId, "events"] as const;

function initialState(snapshot: TeamOwnerRead): TeamEventState {
  return { events: [], cursor: snapshot.replay.latestSeq, window: snapshot.replay, gap: false, connection: "connecting",
    initialized: false, trimmedThrough: 0, attempts: {} };
}

export function useTeamEvents(runId: string, snapshot?: TeamOwnerRead) {
  const { paired, openStream } = useOwnerSession();
  const client = useQueryClient();
  const ready = paired && !!runId && snapshot?.runId === runId;
  const query = useQuery<TeamEventState>({
    queryKey: teamEventsKey(runId), enabled: ready, retry: false, staleTime: Infinity,
    initialData: () => ready ? initialState(snapshot!) : undefined,
    queryFn: () => client.getQueryData<TeamEventState>(teamEventsKey(runId)) ?? initialState(snapshot!),
  });
  useEffect(() => {
    if (!ready) return;
    let runs = connections.get(client);
    if (!runs) { runs = new Map(); connections.set(client, runs); }
    let connection = runs.get(runId);
    if (!connection) {
      connection = { users: 0, controller: new AbortController() };
      runs.set(runId, connection);
      const signal = connection.controller.signal;
      const read = () => client.getQueryData<TeamEventState>(teamEventsKey(runId))!;
      void streamTeamEvents({
        runId, signal, open: openStream, read,
        update: state => { if (!signal.aborted) client.setQueryData(teamEventsKey(runId), state); },
        replay: async (afterSeq, signal) => {
          const response = await openStream(`/runs/${encodeURIComponent(runId)}/replay?afterSeq=${afterSeq}&limit=500`, { signal });
          const page = await response.json() as TeamReplay & { runId: string; protocolVersion: string };
          if (page.protocolVersion !== "1.0" || !Array.isArray(page.events) || !page.window
            || !Number.isSafeInteger(page.window.latestSeq) || !Number.isSafeInteger(page.window.retainedFrom)) throw new TypeError("Invalid team replay");
          if (page.runId !== runId) throw new OwnerReadError(502, "invalid_team_replay");
          return page;
        },
        invalidate: () => {
          void client.invalidateQueries({ queryKey: ["team", runId], predicate: query => query.queryKey[2] !== "events" });
        },
        permissionFailure: error => error instanceof OwnerReadError && [401, 403].includes(error.status),
      });
    }
    connection.users += 1;
    return () => {
      if (--connection.users === 0) { connection.controller.abort(); runs.delete(runId); }
    };
  }, [client, openStream, paired, ready, runId]);
  return query;
}
