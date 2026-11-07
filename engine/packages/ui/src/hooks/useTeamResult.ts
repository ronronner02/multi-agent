import { useQuery } from "@tanstack/react-query";
import type { TeamTaskResult } from "@openrig/daemon/team-control";
import { useOwnerSession } from "./useOwnerSession.js";

/** A finished candidate is cached by digest so rework never reuses an earlier diff. */
export function useTeamResult(runId: string, taskId: string | null, enabled: boolean, candidateDigest: string | null) {
  const { paired, request } = useOwnerSession();
  return useQuery({
    queryKey: ["team", runId, "result", taskId ?? "", candidateDigest],
    enabled: paired && !!runId && !!taskId && enabled && !!candidateDigest, retry: false,
    queryFn: async ({ signal }) => {
      const { result } = await request<{ result: TeamTaskResult }>(
        "/runs/" + encodeURIComponent(runId) + "/tasks/" + encodeURIComponent(taskId!) + "/result", { signal });
      if (result.schema !== "multi-agent-team-result/v1" || result.runId !== runId || result.taskId !== taskId
        || result.manifestDigest !== candidateDigest) {
        throw new Error("invalid_team_result");
      }
      return result;
    },
  });
}

/** The queue states the result route accepts as a finished outcome. */
export const FINISHED_QUEUE_STATES = ["done", "failed", "denied", "canceled"] as const;

export function isFinished(state: string): boolean {
  return (FINISHED_QUEUE_STATES as readonly string[]).includes(state);
}
