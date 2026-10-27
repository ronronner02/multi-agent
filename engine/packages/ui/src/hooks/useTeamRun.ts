import { useQuery } from "@tanstack/react-query";
import { parseProtocolVersion, type TeamOwnerRead, type TeamSystemHealth } from "../../../daemon/dist/contracts/team-control.js";
import { OwnerReadError, useOwnerSession } from "./useOwnerSession.js";
import { useTeamEvents } from "./useTeamEvents.js";

export function useTeamRun(runId: string) {
  const { paired, request } = useOwnerSession();
  const read = useQuery({
    queryKey: ["team", runId, "read"], enabled: paired && !!runId, retry: false, refetchInterval: 2_000,
    queryFn: async ({ signal }) => {
      const { read } = await request<{ read: TeamOwnerRead }>(`/runs/${encodeURIComponent(runId)}/read`, { signal });
      parseProtocolVersion(read.protocolVersion);
      if (read.schema !== "multi-agent-team-read/v1" || read.runId !== runId) throw new OwnerReadError(502, "invalid_team_read");
      return read;
    },
  });
  const health = useQuery({
    queryKey: ["team", "health"], enabled: paired, retry: false, refetchInterval: 2_000,
    queryFn: async ({ signal }) => (await request<{ health: TeamSystemHealth }>("/health", { signal })).health,
  });
  const events = useTeamEvents(runId, read.data);
  return { read, health, events };
}
