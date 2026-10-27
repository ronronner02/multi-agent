import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeamOwnerRead, TeamReadModel } from "@openrig/daemon/team-control";
import { OwnerReadError, useOwnerSession } from "./useOwnerSession.js";

export function useTeamEvents(runId: string, snapshot?: TeamOwnerRead) {
  const { paired, request } = useOwnerSession();
  const client = useQueryClient();
  const key = ["team", runId, "events"];
  return useQuery({
    queryKey: key, enabled: paired && snapshot?.runId === runId, retry: false, refetchInterval: 2_000,
    queryFn: async ({ signal }) => {
      const previous = client.getQueryData<ReturnType<TeamReadModel["replay"]>>(key);
      const afterSeq = previous?.events.at(-1)?.seq ?? previous?.window.latestSeq ?? snapshot!.replay.latestSeq;
      const page = await request<ReturnType<TeamReadModel["replay"]> & Pick<TeamOwnerRead, "runId">>(
        `/runs/${encodeURIComponent(runId)}/replay?afterSeq=${afterSeq}&limit=500`, { signal });
      if (page.runId !== runId) throw new OwnerReadError(502, "invalid_team_replay");
      const events = new Map([...(previous?.events ?? []), ...page.events].map(event => [event.seq, event]));
      // Events notify the reader to rehydrate; the server remains the projection owner.
      if (page.events.some(event => event.seq > afterSeq) || (page.gap && !previous?.gap)) {
        void client.invalidateQueries({ queryKey: ["team", runId, "read"] });
      }
      return { ...page, events: [...events.values()].sort((a, b) => a.seq - b.seq).slice(-200), gap: page.gap || !!previous?.gap };
    },
  });
}
