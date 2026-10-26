import { useQuery } from "@tanstack/react-query";
import type { TeamApproval, TeamRun, TeamSystemHealth } from "@openrig/daemon/team-control";
import { useOwnerSession } from "./useOwnerSession.js";

export function useTeamRun(runId: string) {
  const { paired, request } = useOwnerSession();
  const run = useQuery({
    queryKey: ["team", runId, "run"], enabled: paired && !!runId, retry: false, refetchInterval: 2_000,
    queryFn: async ({ signal }) => (await request<{ run: TeamRun }>(`/runs/${encodeURIComponent(runId)}`, { signal })).run,
  });
  const approvals = useQuery({
    queryKey: ["team", runId, "approvals"], enabled: paired && !!runId, retry: false, refetchInterval: 2_000,
    queryFn: async ({ signal }) => (await request<{ approvals: TeamApproval[] }>(`/runs/${encodeURIComponent(runId)}/approvals`, { signal })).approvals,
  });
  const health = useQuery({
    queryKey: ["team", "health"], enabled: paired, retry: false, refetchInterval: 2_000,
    queryFn: async ({ signal }) => (await request<{ health: TeamSystemHealth }>("/health", { signal })).health,
  });
  return { run, approvals, health };
}
