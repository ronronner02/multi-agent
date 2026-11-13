import type { TeamTaskStage } from "../contracts/team-control.js";

export interface TeamTaskStageFacts {
  ownerDecision: boolean;
  /** Plan R11 — a worker asked the owner a question and is waiting for the answer. */
  ownerQuestion: boolean;
  ownerBlocked: boolean;
  workerReport: boolean;
  pending: boolean;
  liveAttempt: boolean;
  awaitingReview: boolean;
}

/** First match wins: the stage names the next dependency, not the last queue transition. */
export function teamTaskStage(facts: TeamTaskStageFacts): TeamTaskStage {
  if (facts.ownerDecision) return "owner/decision";
  if (facts.ownerQuestion) return "owner/question";
  if (facts.ownerBlocked) return "owner/blocked";
  if (facts.workerReport) return "lead/report";
  if (facts.pending && !facts.liveAttempt) return "queued";
  if (facts.liveAttempt) return "running";
  if (facts.awaitingReview) return "review";
  return "done";
}
