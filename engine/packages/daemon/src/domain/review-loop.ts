import { parseFindings, type ReviewFinding } from "./review-evidence.js";

/**
 * MVP slice C2 — the review loop's pure half.
 *
 * `plan-governance.ts` owns the writes: the reviewer task is admitted through the same
 * `writeTask` path C1 built, and the rework counter is the run's existing
 * `review_rounds_used`. Everything a caller could get wrong on its own lives here, as
 * functions over plain data, so the route and the demo cannot invent a second rule:
 *
 * - which reviewer task id a round owns (derived, so a replay admits the same id);
 * - what a reviewer task's body says (facts only, per the reviewer charter);
 * - what a recorded review's findings mean for the implementer (rework or approved);
 * - which findings block delivery (P0/P1 with a citation, the same rule the review
 *   protocol's gate applies).
 */

/** The reviewer task id a round's review is recorded under. Derived so a replay reuses it. */
export function reviewerTaskId(implementerTaskId: string, round: number): string {
  return `${implementerTaskId}-review-${round}`;
}

/**
 * The round a reviewer task id names, or `null` when the id was not derived for that task.
 *
 * The inverse of `reviewerTaskId`. The round is not a row of its own, so this is how a reviewer
 * task recorded before display names existed is named by the round it was admitted for.
 */
export function reviewRoundFor(implementerTaskId: string, reviewerTaskIdValue: string): number | null {
  const prefix = `${implementerTaskId}-review-`;
  if (!reviewerTaskIdValue.startsWith(prefix)) return null;
  const round = Number(reviewerTaskIdValue.slice(prefix.length));
  return Number.isSafeInteger(round) && round > 0 ? round : null;
}

/** The reviewer task's recorded body. Facts about the candidate, never instructions. */
export function reviewBody(input: { implementerTaskId: string; round: number; candidateDigest: string | null }): string {
  return [
    `Review ${input.implementerTaskId}'s candidate (round ${input.round}).`,
    ...(input.candidateDigest === null ? [] : [`Candidate manifest digest: ${input.candidateDigest}.`]),
    "Report findings as the reviewer charter's JSON block. A P0/P1 needs a failing scenario.",
  ].join("\n");
}

/**
 * The findings a completed review recorded.
 *
 * The owner observes the reviewer's report and records it as the task's outcome evidence,
 * so this is the boundary where worker-written text enters the run: `parseFindings` is the
 * same normalizer the review protocol uses, and a P0/P1 without a failing scenario is
 * refused rather than stored.
 */
export function recordedFindings(evidence: Record<string, unknown>): ReviewFinding[] {
  return parseFindings(evidence.findings ?? []);
}

/** Distinct cited P0/P1 classes: the findings a rework round exists to close. */
export function blockingFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.filter(finding => (finding.severity === "P0" || finding.severity === "P1") && finding.citation.trim() !== "");
}

/**
 * What a review's findings mean for the implementer.
 *
 * P2/P3 are residuals, exactly as the reviewer charter says: they are recorded and never
 * extend the loop. Only a cited P0/P1 sends the implementer back.
 */
export function reviewVerdict(findings: readonly ReviewFinding[]): "approved" | "changes-required" {
  return blockingFindings(findings).length ? "changes-required" : "approved";
}
