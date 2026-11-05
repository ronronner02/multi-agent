import { useQuery } from "@tanstack/react-query";
import type { TeamRunState } from "@openrig/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { readIntegration, readChat, type ChatState, type IntegrationState } from "./clients.js";

/**
 * U10 — the team surface's reads.
 *
 * Teams and runs come from U3's routes; the chat and the branch come from the client module
 * that answers "not available" until U5 and U7 land. Every query is owner-scoped and disabled
 * until the browser is paired, so an unpaired page never fires a request.
 */

export interface TeamSeatSummary { role: "lead" | "implementer" | "reviewer"; client: string; model?: string }
export interface TeamSummary { id: string; name: string; repository: string; seats: TeamSeatSummary[] }
export interface RunSummary {
  id: string; rigId: string; rigName: string; state: TeamRunState; planRef: string; displayName: string; createdAt: string;
}

export const teamsKey = ["team", "teams"] as const;
export const runsKey = ["team", "runs"] as const;

export function useTeams() {
  const { paired, request } = useOwnerSession();
  return useQuery({
    queryKey: teamsKey, enabled: paired, retry: false, refetchInterval: 5_000,
    queryFn: async ({ signal }) => (await request<{ teams: TeamSummary[] }>("/teams", { signal })).teams,
  });
}

export function useRuns() {
  const { paired, request } = useOwnerSession();
  return useQuery({
    queryKey: runsKey, enabled: paired, retry: false, refetchInterval: 5_000,
    queryFn: async ({ signal }) => (await request<{ runs: RunSummary[] }>("/runs", { signal })).runs,
  });
}

/** The run a team opened most recently; a team with no run has none. */
export function latestRunFor(runs: readonly RunSummary[] | undefined, teamId: string): RunSummary | undefined {
  return (runs ?? []).filter(run => run.rigId === teamId).at(0);
}

export function useTeamChat(runId: string, enabled: boolean) {
  const { paired, request } = useOwnerSession();
  return useQuery<ChatState>({
    queryKey: ["team", runId, "chat"], enabled: paired && enabled && !!runId, retry: false, refetchInterval: 3_000,
    queryFn: ({ signal }) => readChat(request, runId, signal),
  });
}

export function useIntegration(runId: string, enabled: boolean) {
  const { paired, request } = useOwnerSession();
  return useQuery<IntegrationState>({
    queryKey: ["team", runId, "integration"], enabled: paired && enabled && !!runId, retry: false, refetchInterval: 5_000,
    queryFn: ({ signal }) => readIntegration(request, runId, signal),
  });
}