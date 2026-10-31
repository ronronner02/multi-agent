import { useQuery } from "@tanstack/react-query";
import type { TeamTaskResult } from "@openrig/daemon/team-control";
import { useOwnerSession } from "./useOwnerSession.js";

/**
 * Slice B — one finished task's candidate, read through the result route.
 *
 * The route refuses a task without a recorded outcome (409), so this query is enabled only once
 * the read model says the task finished. Asking earlier would turn a normal "still running" into
 * an error the screen has to explain away.
 */
export function useTeamResult(runId: string, taskId: string | null, enabled: boolean) {
  const { paired, request } = useOwnerSession();
  return useQuery({
    queryKey: ["team", runId, "result", taskId ?? ""],
    enabled: paired && !!runId && !!taskId && enabled, retry: false,
    queryFn: async ({ signal }) => {
      const { result } = await request<{ result: TeamTaskResult }>(
        `/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId!)}/result`, { signal });
      if (result.schema !== "multi-agent-team-result/v1" || result.runId !== runId || result.taskId !== taskId) {
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
