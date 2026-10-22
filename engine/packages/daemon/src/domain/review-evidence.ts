import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { EventBus, NotifyRegister } from "./event-bus.js";
import { TEAM_CONTROL_VERSION, parseTeamEvent, type JsonObject, type TeamRole } from "../contracts/team-control.js";

/**
 * T012 / KTD8, KTD9, R17, R18 — review bound to the exact candidate.
 *
 * A review is evidence about one specific tree. This module owns that claim.
 * Three rules keep it honest:
 *
 * 1. **Identity is derived, never supplied.** Who implemented and who reviewed
 *    come from the run's own queue authority rows. A caller cannot name a
 *    different implementer to make its own review look independent (R17).
 * 2. **The current candidate moves only when the daemon issues one.** Reviews
 *    describe a candidate; they never change which candidate is current, so a
 *    late review of an old tree cannot resurrect it.
 * 3. **The gate is enforced where the write happens.** A round the Review
 *    convergence gate refuses is not recorded at all, rather than recorded and
 *    merely advised against.
 *
 * Durable state is the run's `team.control` event log (KTD4), folded on every
 * read, so a restart resumes the same counters from the same bytes.
 */

export const REVIEW_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** Rounds 1-2 always run; 3-4 only for open P0/P1 under the gate; a fifth never starts. */
export const UNCONDITIONAL_ROUNDS = 2;
export const MAX_REVIEW_ROUNDS = 4;
/** KTD9: one diagnosed recoverable retry per task, not per attempt. */
export const MAX_RECOVERABLE_RETRIES = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * A finding cites what it violates or it is advisory (Review convergence). Its
 * `key` — the cited KTD plus the location — is what makes two rounds comparable:
 * two reviewers will not agree on an invented `id`, but they will agree that the
 * same KTD at the same file is the same defect. "Same class counts as one item."
 */
export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  citation: string;
  category: string;
  file: string;
}

/**
 * A defect class, as the plan defines it: the cited KTD or invariant plus the
 * location, with the category distinguishing defects at the same location.
 * Without the category, two genuinely different P1s in one file would collapse
 * into "one item" and a real fix would read as no progress; without path
 * normalization, a re-raise under `./src/a.ts` would slip past reappearance.
 *
 * `null` for an advisory finding: recorded, never counted.
 */
export function findingKey(finding: ReviewFinding): string | null {
  const citation = finding.citation.trim();
  if (!citation) return null;
  return `${citation}::${normalizeLocation(finding.file)}::${finding.category.trim().toLowerCase()}`;
}

/** Repository-relative form, so `./src/a.ts`, `src//a.ts` and `src/a.ts` are one location. */
function normalizeLocation(file: string): string {
  const normalized = file.replace(/\\/g, "/").split("/").filter(segment => segment && segment !== ".").join("/");
  return normalized || "unspecified";
}

export interface CandidateIdentity {
  manifestDigest: string;
  base: "commit" | "snapshot";
  baseIdentifier: string;
  fileCount: number;
}

export interface ReviewRecord {
  runId: string;
  taskId: string;
  round: number;
  reviewerSession: string;
  implementerSession: string;
  candidate: CandidateIdentity;
  findings: ReviewFinding[];
  recordedAt: string;
  /**
   * Identity of the delivered report, so a redelivery is recognized as the same
   * round rather than recorded as a new one. A transport retry is not a review
   * round (Review convergence). `null` when the submitter supplied no key.
   */
  reportDigest: string | null;
}

export interface RetryRecord {
  reasonCode: string;
  resumeSafe: boolean;
  recordedAt: string;
}

/**
 * Integrated acceptance for one candidate (R18/AE10).
 *
 * Recorded rather than handed to a verdict function, so it survives restart and a
 * pass earned by one tree cannot be presented as another tree's result.
 */
export interface AcceptanceRecord {
  manifestDigest: string;
  passed: boolean;
  reason: string;
  recordedAt: string;
}

/** Folded durable history for one task. */
export interface ReviewState {
  taskId: string;
  rounds: ReadonlyArray<{ round: number; manifestDigest: string; findings: ReviewFinding[];
    recordedAt: string; reportDigest: string | null }>;
  /** The validated integrated-acceptance result, once recorded. */
  acceptance: AcceptanceRecord | null;
  /**
   * Longest observed round, estimated from consecutive completion times. `null`
   * until two rounds exist, which the gate treats as "cannot show one fits".
   */
  longestRoundMs: number | null;
  /**
   * The candidate the daemon currently holds. Set only by candidate issuance or
   * rework — never by a review, which describes a tree rather than choosing one.
   */
  currentManifestDigest: string | null;
  retries: ReadonlyArray<RetryRecord>;
  /** Distinct P0/P1 classes open after the most recent round. */
  openP0P1: number;
  /** The same count one round earlier; the gate compares the two. */
  previousOpenP0P1: number;
  /** Classes open earlier and absent from the following round. */
  closedP0P1: string[];
}

export type ProgressGate =
  | { kind: "start"; round: number; basis: "unconditional" | "falling-p0p1" }
  | { kind: "stop"; reason: string; basis: "exhausted" | "no-open-p0p1" | "no-progress" | "reappeared" | "insufficient-time" };

export type ReviewEvidenceErrorCode =
  | "unknown_assignee"
  | "not_a_reviewer"
  | "self_review"
  | "stale_candidate"
  | "invalid_finding"
  | "invalid_input"
  | "round_out_of_order"
  | "retry_exhausted";

export class ReviewEvidenceError extends Error {
  readonly code: ReviewEvidenceErrorCode;
  constructor(code: ReviewEvidenceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ReviewEvidenceError";
  }
}

/** What the run's own records say about an assignee. Supplied by the runtime, never by a caller. */
export interface AssigneeFacts { session: string; role: TeamRole; taskId: string }
export type AssigneeResolver = (runId: string, qitemId: string) => AssigneeFacts | null;

/** Stable identity for a submitted report key; the key itself is not stored. */
function hashReport(key: string): string {
  return createHash("sha256").update(cleanText(key, "reportKey", 512)).digest("hex");
}

function validCandidate(candidate: CandidateIdentity, field: string): CandidateIdentity {
  if (!candidate || !DIGEST.test(candidate.manifestDigest)) {
    throw new ReviewEvidenceError("invalid_input", `${field} manifest digest must be a sha256 digest`);
  }
  if (candidate.base !== "commit" && candidate.base !== "snapshot") {
    throw new ReviewEvidenceError("invalid_input", `${field} base must be commit or snapshot`);
  }
  if (typeof candidate.baseIdentifier !== "string" || !candidate.baseIdentifier.trim() || CONTROL_CHARS.test(candidate.baseIdentifier)) {
    throw new ReviewEvidenceError("invalid_input", `${field} base identifier is missing or malformed`);
  }
  if (!Number.isSafeInteger(candidate.fileCount) || candidate.fileCount < 0) {
    throw new ReviewEvidenceError("invalid_input", `${field} file count is not a non-negative integer`);
  }
  return { ...candidate };
}

/** Free text a reviewer controls: bounded, single-line, no control characters (R21 hygiene). */
function cleanText(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string") throw new ReviewEvidenceError("invalid_input", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL_CHARS.test(trimmed)) {
    throw new ReviewEvidenceError("invalid_input", `${field} is empty, too long, or contains control characters`);
  }
  return trimmed;
}

/**
 * Findings are normalized, not policed.
 *
 * A finding that cites nothing is admissible and *advisory*: Review convergence
 * says an uncited finding is advisory, so refusing the whole review over one
 * would discard the cited defects alongside it.
 */
export function parseFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) throw new ReviewEvidenceError("invalid_finding", "Review findings must be an array");
  const ids = new Set<string>();
  return value.map(entry => {
    const finding = (entry ?? {}) as Partial<ReviewFinding>;
    const id = cleanText(finding.id, "finding.id");
    if (ids.has(id)) throw new ReviewEvidenceError("invalid_finding", `Duplicate finding id ${id}`);
    ids.add(id);
    if (!finding.severity || !REVIEW_SEVERITIES.includes(finding.severity)) {
      throw new ReviewEvidenceError("invalid_finding", `Finding ${id} has no valid severity`);
    }
    const citation = typeof finding.citation === "string" ? finding.citation : "";
    // Control characters are never legitimate in a citation. Silently dropping to
    // advisory would let an injection attempt also hide a real P0, so refuse it.
    if (CONTROL_CHARS.test(citation)) {
      throw new ReviewEvidenceError("invalid_input", `Finding ${id} citation contains control characters`);
    }
    return {
      id, severity: finding.severity,
      // An empty citation marks the advisory case rather than failing the review.
      citation: citation.trim().slice(0, 256),
      category: typeof finding.category === "string" && !CONTROL_CHARS.test(finding.category) ? finding.category.slice(0, 128) : "unspecified",
      file: typeof finding.file === "string" && !CONTROL_CHARS.test(finding.file) ? finding.file.slice(0, 512) : "unspecified",
    };
  });
}

/** Distinct counted P0/P1 classes; same class counts once. */
function openClasses(findings: readonly ReviewFinding[]): string[] {
  const keys = new Set<string>();
  for (const finding of findings) {
    if (finding.severity !== "P0" && finding.severity !== "P1") continue;
    const key = findingKey(finding);
    // An advisory P0 is still uncited: it cannot be counted or closed.
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * The review may only be recorded against the candidate the daemon holds now,
 * and only by a session the run itself assigned the reviewer role.
 */
export function recordReview(input: {
  runId: string;
  taskId: string;
  round: number;
  reviewer: AssigneeFacts | null;
  implementer: AssigneeFacts | null;
  candidate: CandidateIdentity;
  currentDigest: string | null;
  findings: unknown;
  recordedAt: string;
  reportDigest: string | null;
}): ReviewRecord {
  if (!input.reviewer || input.reviewer.role !== "reviewer") {
    throw new ReviewEvidenceError("not_a_reviewer", "The recording assignee does not hold the reviewer role in this run");
  }
  if (!input.implementer) throw new ReviewEvidenceError("unknown_assignee", "The reviewed task has no recorded assignee");
  if (input.reviewer.session === input.implementer.session) {
    throw new ReviewEvidenceError("self_review", "The implementer cannot satisfy its own review");
  }
  const candidate = validCandidate(input.candidate, "candidate");
  if (input.currentDigest === null) {
    throw new ReviewEvidenceError("stale_candidate", "No candidate has been issued for this task");
  }
  if (candidate.manifestDigest !== input.currentDigest) {
    throw new ReviewEvidenceError("stale_candidate", "Review is bound to a candidate the task no longer holds");
  }
  return { runId: input.runId, taskId: input.taskId, round: input.round,
    reviewerSession: input.reviewer.session, implementerSession: input.implementer.session,
    candidate, findings: parseFindings(input.findings), recordedAt: input.recordedAt,
    reportDigest: input.reportDigest };
}

type Entry =
  | { kind: "candidate"; identity: CandidateIdentity }
  | { kind: "review"; record: ReviewRecord }
  | { kind: "retry"; record: RetryRecord }
  | { kind: "acceptance"; record: AcceptanceRecord };

/**
 * Fold the durable log for one task.
 *
 * `currentManifestDigest` comes only from candidate issuance and rework. A
 * review records what a reviewer saw; it never decides which tree is current, so
 * a review that lands after a rework is stale rather than authoritative.
 */
export function foldReviewState(taskId: string, entries: ReadonlyArray<Entry>): ReviewState {
  const rounds: Array<{ round: number; manifestDigest: string; findings: ReviewFinding[];
    recordedAt: string; reportDigest: string | null }> = [];
  const retries: RetryRecord[] = [];
  let acceptance: AcceptanceRecord | null = null;
  let currentManifestDigest: string | null = null;
  for (const entry of entries) {
    if (entry.kind === "candidate") {
      // A new candidate begins a new obligation: acceptance of the old tree can no
      // longer describe the task, so it is dropped rather than left to look current.
      if (entry.identity.manifestDigest !== currentManifestDigest) acceptance = null;
      currentManifestDigest = entry.identity.manifestDigest;
    } else if (entry.kind === "retry") retries.push(entry.record);
    else if (entry.kind === "acceptance") acceptance = entry.record;
    else rounds.push({ round: entry.record.round, manifestDigest: entry.record.candidate.manifestDigest,
      findings: entry.record.findings, recordedAt: entry.record.recordedAt,
      reportDigest: entry.record.reportDigest ?? null });
  }
  rounds.sort((left, right) => left.round - right.round);
  const latest = rounds.at(-1);
  const earlier = rounds.at(-2);
  const closed = new Set<string>();
  for (let index = 1; index < rounds.length; index += 1) {
    const before = openClasses(rounds[index - 1]!.findings);
    const after = new Set(openClasses(rounds[index]!.findings));
    for (const key of before) if (!after.has(key)) closed.add(key);
  }
  // A round's duration is the gap to the next completion; the last one is still
  // open, so only completed intervals count.
  const intervals = rounds.flatMap((round, index) => {
    const next = rounds[index + 1];
    if (!next) return [];
    const elapsed = Date.parse(next.recordedAt) - Date.parse(round.recordedAt);
    return Number.isFinite(elapsed) && elapsed >= 0 ? [elapsed] : [];
  });
  return { taskId, rounds, acceptance, currentManifestDigest, retries,
    longestRoundMs: intervals.length ? Math.max(...intervals) : null,
    openP0P1: latest ? openClasses(latest.findings).length : 0,
    previousOpenP0P1: earlier ? openClasses(earlier.findings).length : 0,
    closedP0P1: [...closed].sort() };
}

/**
 * The Review convergence progress gate.
 *
 * The first two rounds are unconditional. After that a round starts only while
 * the open P0/P1 count strictly falls, no earlier-closed class has reappeared,
 * and the run's clock still covers another round. The clock fails closed: past
 * round 2, missing time evidence is not evidence that another round fits.
 */
export function evaluateProgressGate(input: {
  state: ReviewState;
  /** The approved binding's `maxReviewRounds`, capped by the plan's own four-round ceiling. */
  maxRounds?: number;
  remainingActiveMs?: number | null;
  longestRoundMs?: number | null;
}): ProgressGate {
  const { state } = input;
  // KTD9 splits the allowance in two. `maxReviewRounds` is the binding's
  // unconditional cycles (the contract caps it at 2); the extra rounds 3-4 are
  // the plan's own extension for open P0/P1, not something the binding grants.
  // Treating the binding cap as the ceiling would make that extension unreachable.
  const unconditional = Math.max(1, Math.min(UNCONDITIONAL_ROUNDS,
    Number.isSafeInteger(input.maxRounds) ? input.maxRounds! : UNCONDITIONAL_ROUNDS));
  const completed = state.rounds.length;
  if (completed >= MAX_REVIEW_ROUNDS) {
    return { kind: "stop", basis: "exhausted", reason: `Round ${MAX_REVIEW_ROUNDS} is the last permitted review round` };
  }
  const next = completed + 1;
  if (next <= unconditional) return { kind: "start", round: next, basis: "unconditional" };
  if (state.openP0P1 === 0) {
    return { kind: "stop", basis: "no-open-p0p1", reason: "P2/P3-only findings never extend review" };
  }
  const latest = state.rounds.at(-1)!;
  const latestOpen = new Set(openClasses(latest.findings));
  const reopened = state.closedP0P1.filter(key => latestOpen.has(key));
  if (reopened.length) {
    return { kind: "stop", basis: "reappeared", reason: `A closed P0/P1 reappeared: ${reopened.join(", ")}` };
  }
  if (state.openP0P1 >= state.previousOpenP0P1) {
    return { kind: "stop", basis: "no-progress", reason: `Open P0/P1 count did not fall: ${state.openP0P1}` };
  }
  const remaining = input.remainingActiveMs, longest = input.longestRoundMs;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!finite(remaining) || !finite(longest)) {
    // Managed rounds cost KTD9 time; without it the gate cannot show one fits.
    return { kind: "stop", basis: "insufficient-time", reason: "No run-clock evidence that another round fits" };
  }
  if (remaining < longest) {
    return { kind: "stop", basis: "insufficient-time", reason: "Remaining run time does not cover another round" };
  }
  return { kind: "start", round: next, basis: "falling-p0p1" };
}

/**
 * R18 / AE10 — acceptance is a verified result bound to one candidate, never a
 * process exit code and never a pass earned by a different tree.
 */
export function deliveryVerdict(input: {
  state: ReviewState;
}): { complete: boolean; reason: string } {
  const { state } = input;
  const acceptance = state.acceptance;
  if (state.currentManifestDigest === null) return { complete: false, reason: "No candidate is recorded for this task" };
  const latest = state.rounds.at(-1);
  if (!latest) return { complete: false, reason: "No review is recorded for this task" };
  if (latest.manifestDigest !== state.currentManifestDigest) {
    return { complete: false, reason: "The candidate changed after its last review" };
  }
  if (state.openP0P1 > 0) return { complete: false, reason: `Open P0/P1 findings: ${state.openP0P1}` };
  if (!acceptance) return { complete: false, reason: "No validated acceptance result is recorded" };
  if (acceptance.manifestDigest !== state.currentManifestDigest) {
    return { complete: false, reason: "Acceptance was recorded for a different candidate" };
  }
  if (!acceptance.passed) return { complete: false, reason: "Integrated acceptance failed" };
  return { complete: true, reason: "Reviewed candidate with passing acceptance" };
}

/**
 * Durable review evidence.
 *
 * Writes are `team.control` events in the caller's transaction and notify
 * envelope. Reads refold the log. Identity is resolved through the run's own
 * queue authority, so neither the implementer nor the reviewer can be named by
 * the caller.
 */
export class ReviewEvidenceLedger {
  constructor(private readonly deps: {
    db: Database.Database;
    events: EventBus;
    resolveAssignee: AssigneeResolver;
    /** The approved binding's limits. Read per call, never hard-coded, so a stricter approval wins. */
    limits: (runId: string) => { maxRetries: number; maxReviewRounds: number };
    /**
     * The run's KTD9 clock, derived by the caller from run state. Supplied as a
     * function so the ledger cannot be handed a favourable clock by a request.
     */
    clock?: (runId: string) => { remainingActiveMs: number };
    now?: () => Date;
  }) {}

  private clock(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }

  private append(runId: string, rigId: string, taskId: string, action: string, payload: JsonObject, register: NotifyRegister): void {
    register(this.deps.events.persistWithinTransaction(parseTeamEvent({ type: "team.control", protocolVersion: TEAM_CONTROL_VERSION,
      eventId: randomUUID(), rigId, runId, taskId, attemptId: null, entityId: taskId, entityVersion: 1, action, payload })));
  }

  /**
   * The assignee the run actually recorded for a task id.
   *
   * Both sides of the independence check come from the same resolver, so the
   * comparison can never mix a caller-supplied identity with a recorded one.
   */
  private taskAssignee(runId: string, taskId: string): AssigneeFacts | null {
    const row = this.deps.db.prepare(`SELECT qitem_id AS qitemId FROM team_queue_authority
      WHERE run_id = ? AND task_id = ?`).get(runId, taskId) as { qitemId: string } | undefined;
    return row ? this.deps.resolveAssignee(runId, row.qitemId) : null;
  }

  /**
   * Record the candidate the daemon issued. This is the only writer that moves
   * the current candidate forward, so a review cannot choose what is current.
   */
  issue(input: { runId: string; rigId: string; taskId: string; identity: CandidateIdentity; register: NotifyRegister }): CandidateIdentity {
    const identity = validCandidate(input.identity, "candidate");
    this.append(input.runId, input.rigId, input.taskId, "review.candidate", { ...identity }, input.register);
    return identity;
  }

  /**
   * Record a review.
   *
   * The reviewer is named by its queue item, not by a session string, and the
   * implementer comes from the task's own authority row. The candidate must still
   * be the current one, and the progress gate must authorize the round: a refused
   * round is not recorded, so no count can be manufactured by ignoring the gate.
   */
  record(input: {
    runId: string; rigId: string; taskId: string; reviewerQitemId: string;
    candidate: CandidateIdentity; findings: unknown; register: NotifyRegister;
    /** Optional submitter key identifying the delivered report; enables redelivery dedup. */
    reportKey?: string;
  }): ReviewRecord {
    const current = this.state(input.runId, input.taskId);
    // A redelivered report is the same round, not a new one. Review convergence
    // says a transport retry is not a round, so it must not consume one.
    const reportDigest = input.reportKey === undefined ? null : hashReport(input.reportKey);
    if (reportDigest !== null) {
      const existing = current.rounds.find(round => round.reportDigest === reportDigest);
      if (existing) {
        const stored = this.storedRecord(input.runId, input.taskId, existing.round);
        if (!stored) throw new ReviewEvidenceError("invalid_input", "Redelivered report has no stored record");
        return stored;
      }
    }
    const record = recordReview({ runId: input.runId, taskId: input.taskId, round: current.rounds.length + 1,
      reviewer: this.deps.resolveAssignee(input.runId, input.reviewerQitemId),
      implementer: this.taskAssignee(input.runId, input.taskId),
      candidate: input.candidate, currentDigest: current.currentManifestDigest,
      findings: input.findings, recordedAt: this.clock(), reportDigest });
    // The limit is the approved binding's, not a constant, and the clock comes
    // from run state rather than from the request: a caller cannot grant itself
    // another round by claiming there is time for one.
    const limits = this.deps.limits(input.runId);
    // Both time figures are derived here: the remaining run clock from the run's
    // own accounting and the round duration from recorded completion times. A
    // request cannot supply either, so it cannot buy itself another round.
    const remainingActiveMs = this.deps.clock?.(input.runId).remainingActiveMs ?? 0;
    const gate = evaluateProgressGate({ state: current, maxRounds: limits.maxReviewRounds,
      remainingActiveMs, longestRoundMs: current.longestRoundMs });
    if (gate.kind === "stop") {
      throw new ReviewEvidenceError(gate.basis === "exhausted" ? "round_out_of_order" : "stale_candidate",
        `Round ${record.round} is not authorized: ${gate.reason}`);
    }
    if (gate.round !== record.round) {
      throw new ReviewEvidenceError("round_out_of_order", `Review round ${record.round} does not follow round ${current.rounds.length}`);
    }
    this.append(input.runId, input.rigId, input.taskId, "review.recorded",
      { ...record, candidate: { ...record.candidate }, findings: record.findings.map(finding => ({ ...finding })) } as unknown as JsonObject,
      input.register);
    return record;
  }

  /**
   * Record integrated acceptance for the candidate it names.
   *
   * R18/AE10: a clean exit is not acceptance, and a pass earned by one tree is not
   * another tree's result, so the digest is required and must be the current one.
   */
  accept(input: { runId: string; rigId: string; taskId: string; manifestDigest: string; passed: boolean;
    reason: string; register: NotifyRegister }): AcceptanceRecord {
    const current = this.state(input.runId, input.taskId);
    if (current.currentManifestDigest === null || input.manifestDigest !== current.currentManifestDigest) {
      throw new ReviewEvidenceError("stale_candidate", "Acceptance must name the candidate the task currently holds");
    }
    const record: AcceptanceRecord = { manifestDigest: input.manifestDigest, passed: input.passed,
      reason: cleanText(input.reason, "acceptance.reason", 512), recordedAt: this.clock() };
    this.append(input.runId, input.rigId, input.taskId, "review.acceptance", { ...record }, input.register);
    return record;
  }

  /** Record that the candidate moved, which retires every earlier review. */
  rework(input: { runId: string; rigId: string; taskId: string; identity: CandidateIdentity; register: NotifyRegister }): CandidateIdentity {
    const identity = validCandidate(input.identity, "candidate");
    this.append(input.runId, input.rigId, input.taskId, "review.rework", { ...identity }, input.register);
    return identity;
  }

  /** KTD9's single diagnosed recoverable retry, counted from durable state. */
  retry(input: { runId: string; rigId: string; taskId: string; reasonCode: string; resumeSafe: boolean; register: NotifyRegister }): RetryRecord {
    const current = this.state(input.runId, input.taskId);
    if (current.retries.length >= this.deps.limits(input.runId).maxRetries) {
      throw new ReviewEvidenceError("retry_exhausted", "The task's single recoverable retry is already used");
    }
    const record: RetryRecord = { reasonCode: cleanText(input.reasonCode, "reasonCode"), resumeSafe: input.resumeSafe, recordedAt: this.clock() };
    this.append(input.runId, input.rigId, input.taskId, "review.retry", { ...record }, input.register);
    return record;
  }

  /** The stored event for a round, so a redelivery returns what was recorded rather than a copy. */
  private storedRecord(runId: string, taskId: string, round: number): ReviewRecord | null {
    const row = this.deps.db.prepare(`SELECT payload FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.taskId') = ?
      AND json_extract(payload, '$.action') = 'review.recorded'
      AND json_extract(payload, '$.payload.round') = ?`).get(runId, taskId, round) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as { payload: ReviewRecord }).payload : null;
  }

  /** Fold this task's durable review history. */
  state(runId: string, taskId: string): ReviewState {
    const rows = this.deps.db.prepare(`SELECT json_extract(payload, '$.action') AS action, payload FROM events
      WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.taskId') = ?
        AND json_extract(payload, '$.action') IN ('review.candidate', 'review.rework', 'review.recorded', 'review.retry', 'review.acceptance') ORDER BY seq`)
      .all(runId, taskId) as Array<{ action: string; payload: string }>;
    const entries: Entry[] = [];
    for (const row of rows) {
      const payload = (JSON.parse(row.payload) as { payload: Record<string, unknown> }).payload;
      if (row.action === "review.recorded") entries.push({ kind: "review", record: payload as unknown as ReviewRecord });
      else if (row.action === "review.retry") entries.push({ kind: "retry", record: payload as unknown as RetryRecord });
      else if (row.action === "review.acceptance") entries.push({ kind: "acceptance", record: payload as unknown as AcceptanceRecord });
      else entries.push({ kind: "candidate", identity: payload as unknown as CandidateIdentity });
    }
    return foldReviewState(taskId, entries);
  }
}