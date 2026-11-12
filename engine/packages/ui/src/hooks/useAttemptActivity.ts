import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttemptActivity, TeamAttemptView, ToolActivityRecord } from "@multi-agent/daemon/team-control";
import { useOwnerSession } from "./useOwnerSession.js";

export function mergeToolCalls(previous: readonly ToolActivityRecord[], incoming: readonly ToolActivityRecord[]): ToolActivityRecord[] {
  const calls = new Map(previous.map(record => [record.id, record]));
  for (const record of incoming) {
    const current = calls.get(record.id);
    if (!current || record.seq > current.seq) {
      calls.set(record.id, current ? { ...current, seq: record.seq, status: record.status } : record);
    }
  }
  return [...calls.values()];
}

/** Visibility owns reads; events invalidate live projections, and stopping gets a final read. */
export function useAttemptActivity(runId: string, attempt: TeamAttemptView | undefined) {
  const { paired, request } = useOwnerSession();
  const cache = useQueryClient();
  const [target, ref] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting === true));
    observer.observe(target);
    return () => observer.disconnect();
  }, [target]);
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const queryKey = ["team", runId, "attempt", attempt?.attemptId ?? "", "activity", attempt?.state] as const;
  const enabled = paired && !!runId && !!attempt && visible && documentVisible;
  const query = useQuery<AttemptActivity>({
    queryKey, enabled, retry: false,
    staleTime: attempt?.state === "stopped" ? Infinity : 0,
    placeholderData: previous => previous?.attemptId === attempt?.attemptId ? previous : undefined,
    queryFn: async ({ signal }): Promise<AttemptActivity> => {
      const previous = cache.getQueryData<AttemptActivity>(queryKey);
      const { activity } = await request<{ activity: AttemptActivity }>(
        "/runs/" + encodeURIComponent(runId) + "/attempts/" + encodeURIComponent(attempt!.attemptId)
          + "/activity?after=" + (previous?.nextSeq ?? 0), { signal });
      return { ...activity, records: mergeToolCalls(previous?.records ?? [], activity.records) };
    },
  });
  return { ...query, ref };
}
