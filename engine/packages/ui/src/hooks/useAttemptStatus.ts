import { useEffect, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { WORKER_TURN_START_WINDOW_MS } from "../../../daemon/dist/contracts/worker-events.js";
import type { TeamAttemptView } from "@multi-agent/daemon/team-control";
import type { AttemptEventFacts, TeamEventState } from "./team-event-stream.js";
import { teamEventsKey } from "./useTeamEvents.js";

export function attemptStatus(attempt: Pick<TeamAttemptView, "state" | "createdAt">, facts: AttemptEventFacts | undefined, now: number, providerEvent = false) {
  if (attempt.state !== "running") return attempt.state;
  if (facts?.acknowledged) return "acknowledged";
  if (facts?.providerEvent || providerEvent) return "working";
  return now >= (facts?.startedAt ?? Date.parse(attempt.createdAt)) + WORKER_TURN_START_WINDOW_MS ? "no-response" : "started";
}

/** Observe the existing event query without opening another connection; the only timer is the response deadline. */
export function useAttemptStatus(runId: string, attempt: Pick<TeamAttemptView, "attemptId" | "state" | "createdAt"> | undefined, providerEvent = false) {
  const events = useQuery<TeamEventState>({ queryKey: teamEventsKey(runId), queryFn: skipToken });
  const facts = attempt ? events.data?.attempts[attempt.attemptId] : undefined;
  const [now, setNow] = useState(Date.now);
  const deadline = attempt ? (facts?.startedAt ?? Date.parse(attempt.createdAt)) + WORKER_TURN_START_WINDOW_MS : 0;
  useEffect(() => {
    setNow(Date.now());
    if (!attempt || attempt.state !== "running" || facts?.acknowledged || facts?.providerEvent || providerEvent || !Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [attempt?.attemptId, attempt?.state, deadline, facts?.acknowledged, facts?.providerEvent, providerEvent]);
  return attempt ? attemptStatus(attempt, facts, now, providerEvent) : null;
}
