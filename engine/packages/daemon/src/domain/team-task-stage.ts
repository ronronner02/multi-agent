import type { TeamTaskStage } from "../contracts/team-control.js";

export interface TeamTaskStageFacts {
  ownerDecision: boolean;
  ownerBlocked: boolean;
  workerReport: boolean;
  pending: boolean;
  liveAttempt: boolean;
  awaitingReview: boolean;
}

/** First match wins: the stage names the next dependency, not the last queue transition. */
export function teamTaskStage(facts: TeamTaskStageFacts): TeamTaskStage {
  if (facts.ownerDecision) return "owner/decision";
  if (facts.ownerBlocked) return "owner/blocked";
  if (facts.workerReport) return "lead/report";
  if (facts.pending && !facts.liveAttempt) return "queued";
  if (facts.liveAttempt) return "running";
  if (facts.awaitingReview) return "review";
  return "done";
}
