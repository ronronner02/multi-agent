export * from "./contracts/team-control.js";

import type Database from "better-sqlite3";
import { redactTranscriptContent } from "./domain/transcript-redaction.js";
import {
  TEAM_READ_MODEL_VERSION, TEAM_WORKFLOW_STAGES, canonicalJson, parseUsage,
  type JsonObject, type TeamApproval, type TeamAttemptView, type TeamCriteriaProgress,
  type TeamLogRecord, type TeamOwnerRead, type TeamReplayEvent, type TeamReviewView, type TeamRunStageView,
  type TeamSeatView, type TeamStageProgress, type TeamStageState, type TeamTaskNameParts, type TeamWorkflowStage,
} from "./contracts/team-control.js";
import type { PlanGovernance } from "./domain/plan-governance.js";
import type { EventBus } from "./domain/event-bus.js";
import { foldReviewState, type Entry } from "./domain/review-evidence.js";
import { ordinalTaskName, reviewName, seatName, taskName } from "./domain/display-names.js";
import { reviewRoundFor } from "./domain/review-loop.js";
import { teamTaskStage } from "./domain/team-task-stage.js";
import type { TaskReport } from "./domain/task-report.js";

/** C2 — the shape a review round's durable verdict carries, for a client that renders it. */
export type { ReviewFinding, ReviewVerdictRecord } from "./domain/review-evidence.js";
export type { AttemptActivity, ToolActivityRecord, TurnUsage, TurnProgress } from "./domain/attempt-telemetry.js";
export type TeamAnalytics = ReturnType<import("./domain/attempt-telemetry.js").AttemptTelemetry["analytics"]>;

/**
 * T052 — the managed owner read projections.
 *
 * Every field is read from a durable owner that already holds it; this module
 * composes and correlates, and never writes. The plan is explicit that a route
 * or envelope parser alone does not prove real evidence, so each projection
 * names the durable rows its verdict rests on and reports `unavailable` when
 * the owner has recorded nothing. "Unavailable" and "zero" stay distinct: a
 * reader must not render an absent review as a passing one (AE12).
 *
 * The only transformation applied to stored text is redaction, and it happens
 * here at the boundary rather than in the client, so no consumer can forget it.
 */

/** Bound on one log body. Long enough for a useful line, short enough that a replay stays bounded. */
const LOG_BODY_LIMIT = 2000;
/** How many log records one read returns; the plan requires bounded structured logs. */
const LOG_RECORD_LIMIT = 200;
/** A task title is one display line, not the whole body: the body can be 256 KiB. */
const TASK_TITLE_LIMIT = 80;

/** One task's own recorded facts, as the naming and title projections read them. */
interface TaskIdentity {
  title: string | null;
  body: string;
  /** The name stored when the task was admitted, or `null` for a row recorded before names existed. */
  displayName: string | null;
  /** The implementer task a reviewer task reviews, or `null` for a task that reviews nothing. */
  reviewOf: string | null;
  dependencies: string[] | null;
}

export interface TeamReadModelDeps {
  db: Database.Database;
  governance: PlanGovernance;
  events: EventBus;
  /** The queue's own destination-session map, so a task's seat is read from its owner. */
  readTaskRows: (runId: string) => Array<{ qitemId: string; taskId: string; role: string; queueState: string; session: string | null }>;
  /** Read an already-known candidate only; never acquire a workspace while projecting a task. */
  readTaskWorkspace?: (runId: string, taskId: string) => NonNullable<TeamReviewView["workspace"]> | null;
  /** The run's review evidence, folded from the durable team log. */
  now?: () => Date;
}

/**
 * Bound and redact one stored body. Escape sequences are stripped rather than
 * passed through: a log body is inert text to every client, and a terminal
 * control sequence that reached a renderer would execute.
 */
export function boundedLogBody(raw: string): { body: string; truncated: boolean } {
  // eslint-disable-next-line no-control-regex
  const withoutControls = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const redacted = redactTranscriptContent(withoutControls);
  if (redacted.length <= LOG_BODY_LIMIT) return { body: redacted, truncated: false };
  return { body: redacted.slice(0, LOG_BODY_LIMIT), truncated: true };
}

/** Extract only an explicit Markdown section; never infer criteria from prose or code examples. */
function declaredAcceptanceCriteria(body: string): TeamReviewView["declaredAcceptanceCriteria"] {
  const lines = body.split("\n");
  let start = -1, depth = 0, fence = "";
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length
        && line.slice(marker[0].length).trim() === "") fence = "";
      continue;
    }
    if (marker) { fence = marker[1]!; continue; }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!heading) continue;
    if (start >= 0 && heading[1]!.length <= depth) return boundedLogBody(lines.slice(start, index).join("\n").trim());
    if (start < 0 && /^(?:acceptance criteria|acceptance|\u9a8c\u6536\u6807\u51c6):?$/i.test(heading[2]!)) {
      start = index + 1; depth = heading[1]!.length;
    }
  }
  return start < 0 ? null : boundedLogBody(lines.slice(start).join("\n").trim());
}

export class TeamReadModel {
  constructor(private readonly deps: TeamReadModelDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /**
   * The run's task projections, each bound to its review evidence.
   *
   * Criteria stay `null` unless a durable record names them. No task in the
   * pack owns acceptance-criteria storage yet, and inventing one here would be
   * a second store, so the honest value is "unavailable" until its owner lands.
   */
  private tasks(runId: string): TeamReviewView[] {
    const rows = this.deps.readTaskRows(runId);
    const identities = new Map(rows.map((row) => [row.qitemId, this.identity(row.qitemId)]));
    const names = this.taskNames(rows, identities);
    const run = this.deps.governance.getRun(runId);
    const integrationBranch = this.deps.governance.integrationRecord(runId).branch;
    const actionable = run.state !== "canceled" && run.state !== "cancel_requested";
    const ownerDecision = actionable && (run.phase === "planning" || this.deps.governance.chatDecision(runId) !== null);
    return rows.map((row) => {
      const state = foldReviewState(row.taskId, this.reviewEntries(runId, row.taskId));
      const evidence = this.deps.governance.getTask(row.qitemId)?.evidence;
      // Native implementer completion records its candidate in the authority row, not the legacy ledger.
      const currentCandidateDigest = state.currentManifestDigest ?? (row.role === "implementer"
        && ["done", "handed-off"].includes(row.queueState) && evidence?.validated === true
        && typeof evidence.manifestDigest === "string" ? evidence.manifestDigest : null);
      const criteria = this.criteria(row.qitemId, currentCandidateDigest);
      const identity = identities.get(row.qitemId)!;
      // U9 — built from these same rows above, so every task has a name.
      const name = names.get(row.taskId)!;
      const report = evidence?.taskReport as unknown as TaskReport | undefined;
      const reportBody = report ? boundedLogBody(report.evidence) : null;
      const resolution = evidence?.resolution as { action: "rework" | "reassign" | "drop" } | undefined;
      const workerReport: TeamReviewView["workerReport"] = report ? {
        status: report.status, question: report.question ? boundedLogBody(report.question).body : null,
        evidence: reportBody!.body, truncated: reportBody!.truncated,
        attemptId: typeof evidence?.reportedAttemptId === "string" ? evidence.reportedAttemptId : null,
        resolution: resolution?.action ?? null,
      } : null;
      const liveAttempt = this.deps.governance.openAttemptCount(row.qitemId) > 0;
      const verdict = state.verdicts.at(-1);
      const awaitingReview = actionable && row.role === "implementer" && run.reviewerSeat !== null
        && ["done", "handed-off"].includes(row.queueState) && report?.status !== "dropped" && resolution?.action !== "drop"
        && !(verdict?.verdict === "approved" && verdict.candidateDigest === currentCandidateDigest);
      // A run-wide decision gates unfinished work, not tasks that already finished.
      // The lead remains its representative even after its planning turn has stopped.
      const waiting = row.role === "lead" || liveAttempt || awaitingReview
        || !["done", "handed-off", "canceled"].includes(row.queueState);
      return {
        taskId: row.taskId,
        qitemId: row.qitemId,
        role: row.role as TeamReviewView["role"],
        queueState: row.queueState as TeamReviewView["queueState"],
        stage: teamTaskStage({
          ownerDecision: waiting && ownerDecision,
          ownerQuestion: row.role === "implementer" && row.queueState === "blocked" && workerReport !== null && workerReport.status === "needs-decision"
            && workerReport.question !== null && workerReport.resolution === null,
          ownerBlocked: waiting && run.state === "blocked",
          workerReport: row.queueState === "blocked" && workerReport !== null
            && workerReport.status !== "dropped" && workerReport.resolution === null,
          pending: row.queueState === "pending" || row.queueState === "in-progress"
            || (actionable && row.queueState === "failed" && typeof evidence?.retryNotBefore === "string"),
          liveAttempt, awaitingReview,
        }),
        seat: row.session,
        workerReport,
        displayName: name.displayName,
        displayNameParts: name.parts,
        title: identity.title,
        description: identity.body.trim() ? boundedLogBody(identity.body) : null,
        declaredAcceptanceCriteria: declaredAcceptanceCriteria(identity.body),
        workspace: this.deps.readTaskWorkspace?.(runId, identity.reviewOf ?? row.taskId) ?? null,
        integrationBranch,
        dependencies: identity.dependencies,
        criteria,
        currentCandidateDigest,
        rounds: state.rounds.length + state.verdicts.length,
        openP0P1: state.openP0P1,
        // C2 — the run's own review rounds, so a client can show the verdict that sent the
        // task back or approved it. A run that never used the loop publishes `[]`.
        verdicts: state.verdicts.map(verdict => ({ round: verdict.round, reviewerTaskId: verdict.reviewerTaskId,
          verdict: verdict.verdict, candidateDigest: verdict.candidateDigest, findings: verdict.findings.length,
          findingRecords: verdict.findings.map(finding => ({ id: finding.id, severity: finding.severity,
            file: boundedLogBody(finding.file).body,
            summary: boundedLogBody(finding.scenario ?? finding.category).body })),
          blocking: verdict.findings.filter(finding => finding.severity === "P0" || finding.severity === "P1").length,
          recordedAt: verdict.recordedAt })),
        // A review record exists once at least one round was recorded; until then
        // the task has no review to read, and a crashed round cannot be faked.
        reviewAvailable: state.rounds.length + state.verdicts.length > 0,
        acceptance: state.acceptance
          ? { manifestDigest: state.acceptance.manifestDigest, passed: state.acceptance.passed,
              reason: state.acceptance.reason, recordedAt: state.acceptance.recordedAt }
          : null,
      };
    });
  }

  /**
   * The task's own words: its title and its declared dependencies, plus the two facts naming
   * it needs — the body it was admitted with and the task it reviews, if any.
   *
   * Both are read from the rows that already own them — the queue item's body and
   * the authority row's assignment — rather than added to `readTaskRows`, which
   * two hosts build. An assignment that will not parse is `null`, not `[]`: an
   * unreadable assignment is missing evidence, and an empty list would claim the
   * task was recorded with no dependencies.
   */
  private identity(qitemId: string): TaskIdentity {
    const row = this.deps.db
      .prepare(`SELECT q.body AS body, a.assignment_json AS assignmentJson, a.display_name AS displayName
        FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
        WHERE a.qitem_id = ?`)
      .get(qitemId) as { body: string | null; assignmentJson: string | null; displayName: string | null } | undefined;
    if (!row) return { title: null, body: "", displayName: null, reviewOf: null, dependencies: null };
    const firstLine = (row.body ?? "").split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
    const title = firstLine ? [...firstLine].slice(0, TASK_TITLE_LIMIT).join("") : null;
    let dependencies: string[] | null = null;
    let reviewOf: string | null = null;
    if (row.assignmentJson) {
      try {
        const assignment = JSON.parse(row.assignmentJson) as { dependencies?: unknown; reviewOf?: unknown };
        dependencies = Array.isArray(assignment.dependencies)
          ? assignment.dependencies.filter((entry): entry is string => typeof entry === "string") : null;
        reviewOf = typeof assignment.reviewOf === "string" ? assignment.reviewOf : null;
      } catch {
        // Covered by the `null` initializers: an unreadable assignment has no list and no
        // reviewed task.
      }
    }
    return { title, body: row.body ?? "", displayName: row.displayName, reviewOf, dependencies };
  }

  /**
   * U9 — every task's name, from the row it was recorded with.
   *
   * A stored name is used as recorded. A row recorded before names existed is named from itself:
   * its body's first line, or for a reviewer task the task it reviews and the round. Reviewer
   * tasks are resolved second so an old reviewer row takes its reviewed task's name whatever
   * that task's own provenance is, and a task with nothing to name it by falls back to its
   * position in the read rather than to its id.
   */
  private taskNames(rows: Array<{ taskId: string; qitemId: string }>, identities: Map<string, TaskIdentity>):
    Map<string, { displayName: string; parts: TeamTaskNameParts }> {
    const plain = new Map<string, string>();
    rows.forEach((row, index) => {
      const identity = identities.get(row.qitemId)!;
      if (identity.reviewOf !== null) return;
      plain.set(row.taskId, identity.displayName ?? taskName(identity.body) ?? ordinalTaskName(index + 1));
    });
    const names = new Map<string, { displayName: string; parts: TeamTaskNameParts }>();
    rows.forEach((row, index) => {
      const identity = identities.get(row.qitemId)!;
      if (identity.reviewOf === null) {
        names.set(row.taskId, { displayName: plain.get(row.taskId)!, parts: { kind: "task" } });
        return;
      }
      const round = reviewRoundFor(identity.reviewOf, row.taskId) ?? 1;
      const of = plain.get(identity.reviewOf) ?? ordinalTaskName(index + 1);
      names.set(row.taskId, {
        displayName: identity.displayName ?? reviewName(of, round),
        parts: { kind: "review", round, of },
      });
    });
    return names;
  }

  /**
   * U9 — the rig's seats, named from the role and client each runs.
   *
   * A seat is a session on a node that declares a team role and a client runtime; a terminal
   * node is not an agent seat. The latest session is the address a launch resolves, so it is the
   * seat's name. A role and client that repeat are numbered — both members of the group carry
   * the number, so two implementers on Codex stay distinct — and a unique pair carries none.
   */
  private seats(rigId: string): TeamSeatView[] {
    const rows = this.deps.db.prepare(`SELECT n.role AS role, n.runtime AS runtime, n.retired_at AS retiredAt, s.session_name AS seat
      FROM nodes n JOIN sessions s ON s.node_id = n.id
      WHERE n.rig_id = ? AND n.role IN ('lead', 'implementer', 'reviewer')
        AND n.runtime IS NOT NULL AND n.runtime <> 'terminal'
        AND s.id = (SELECT latest.id FROM sessions latest WHERE latest.node_id = n.id
          ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
      ORDER BY n.logical_id`).all(rigId) as Array<{ role: TeamSeatView["role"]; runtime: string; retiredAt: string | null; seat: string }>;
    const members = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.role}\u0000${row.runtime}`;
      members.set(key, (members.get(key) ?? 0) + 1);
    }
    const ordinal = new Map<string, number>();
    return rows.map((row) => {
      const key = `${row.role}\u0000${row.runtime}`;
      const position = (ordinal.get(key) ?? 0) + 1;
      ordinal.set(key, position);
      const index = (members.get(key) ?? 0) > 1 ? position : null;
      return { seat: row.seat, role: row.role, client: row.runtime, index, retired: row.retiredAt !== null,
        displayName: seatName({ role: row.role, client: row.runtime, index }) };
    });
  }

  /**
   * Acceptance criteria, read from the task authority's own evidence row.
   *
   * The row is `team_queue_authority.evidence_json`, which the owner's task
   * outcome already writes to. The shape is `{ criteria: [{ verified: boolean }] }`
   * when a caller records verification; anything else leaves the projection
   * unavailable rather than guessing a denominator.
   *
   * Criteria describe one candidate, so the record must name the candidate it
   * verified. Criteria recorded against a candidate the task no longer holds
   * are stale evidence, not current progress: reporting them beside a newer
   * digest would claim that a different tree passed.
   */
  private criteria(qitemId: string, currentDigest: string | null): TeamCriteriaProgress {
    const row = this.deps.db
      .prepare("SELECT evidence_json AS evidenceJson FROM team_queue_authority WHERE qitem_id = ?")
      .get(qitemId) as { evidenceJson: string | null } | undefined;
    if (!row?.evidenceJson) return { verified: null, total: null, source: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.evidenceJson);
    } catch {
      // An unparseable evidence row is not zero criteria; it is unreadable evidence.
      return { verified: null, total: null, source: "team_queue_authority.evidence_json" };
    }
    const record = parsed as { criteria?: unknown; manifestDigest?: unknown };
    const criteria = record.criteria;
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return { verified: null, total: null, source: "team_queue_authority.evidence_json" };
    }
    // An unbound record cannot be attributed to the current candidate, and a
    // record bound to another candidate describes a tree the task has left.
    if (typeof record.manifestDigest !== "string" || currentDigest === null
      || record.manifestDigest !== currentDigest) {
      return { verified: null, total: null, source: "team_queue_authority.evidence_json" };
    }
    const verified = criteria.filter((entry) => (entry as { verified?: unknown }).verified === true).length;
    return { verified, total: criteria.length, source: "team_queue_authority.evidence_json" };
  }

  /** Fold one task's durable review history through the existing ledger fold. */
  private reviewEntries(runId: string, taskId: string): Entry[] {
    const rows = this.deps.db
      .prepare(`SELECT json_extract(payload, '$.action') AS action, payload FROM events
        WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.taskId') = ?
          AND json_extract(payload, '$.action') IN ('review.candidate', 'review.rework', 'review.recorded', 'review.retry', 'review.acceptance', 'review.verdict')
        ORDER BY seq`)
      .all(runId, taskId) as Array<{ action: string; payload: string }>;
    const entries: Entry[] = [];
    for (const row of rows) {
      const payload = (JSON.parse(row.payload) as { payload: Record<string, unknown> }).payload;
      if (row.action === "review.recorded") entries.push({ kind: "review", record: payload as never });
      else if (row.action === "review.retry") entries.push({ kind: "retry", record: payload as never });
      else if (row.action === "review.acceptance") entries.push({ kind: "acceptance", record: payload as never });
      else if (row.action === "review.verdict") entries.push({ kind: "verdict", record: payload as never });
      else entries.push({ kind: "candidate", identity: payload as never });
    }
    return entries;
  }

  /**
   * The seven-stage stepper, derived from durable run, task and review state.
   *
   * The current stage is the earliest one without finished required work, which
   * is what makes "counts show tasks in later stages" meaningful. A stage whose
   * evidence owner has recorded nothing is `unavailable`, never "not started",
   * so an empty database cannot render as a run that has not begun.
   *
   * Every task-scoped stage is decided over *all* tasks, not any of them: one
   * task having a review cannot make the run's review stage complete while
   * another task has none, and a single passing acceptance cannot complete
   * integration verification for a run whose other tasks were never accepted.
   */
  private workflow(runId: string, tasks: TeamReviewView[]): TeamRunStageView {
    const run = this.deps.governance.getRun(runId);
    const approvals = this.deps.governance.listApprovals(runId);
    const approved = approvals.some((approval) => approval.action === "implementation" && approval.state === "approved");
    const pendingPlan = approvals.some((approval) => approval.action === "implementation" && approval.state === "pending");
    const allTasksTerminal = tasks.length > 0 && tasks.every((task) =>
      ["done", "failed", "denied", "canceled", "handed-off"].includes(task.queueState));
    // A crashed or missing review is unavailable, so it cannot count as reviewed.
    const everyTaskReviewed = tasks.length > 0 && tasks.every((task) => task.reviewAvailable);
    const anyReviewStarted = tasks.some((task) => task.reviewAvailable);
    const everyTaskAccepted = tasks.length > 0 && tasks.every((task) => task.acceptance?.passed === true);
    const anyAccepted = tasks.some((task) => task.acceptance?.passed === true);
    // Stage 6 completes only on a decision the owner actually made. A pending
    // delivery approval is a request, and treating it as decided would claim a
    // release nobody approved.
    const deliveryDecided = approvals.some((approval) =>
      (approval.action === "release" || approval.action === "merge" || approval.action === "pr-create")
      && approval.state === "approved");
    const deliveryPending = approvals.some((approval) =>
      (approval.action === "release" || approval.action === "merge" || approval.action === "pr-create")
      && approval.state === "pending");

    const stages: TeamStageProgress[] = [
      {
        stage: "setup-checks",
        // The binding is the durable proof that setup produced a usable run.
        state: run.bindingDigest ? "complete" : "unavailable",
        evidence: "team_runs.binding_digest",
      },
      {
        stage: "plan-approved",
        state: approved ? "complete" : pendingPlan ? "active" : "pending",
        evidence: "team_approvals(action=implementation)",
      },
      {
        stage: "assignments-derived",
        state: tasks.length > 0 ? "complete" : "unavailable",
        evidence: "team_queue_authority",
      },
      {
        stage: "execution",
        state: tasks.length === 0 ? "unavailable" : allTasksTerminal ? "complete" : "active",
        evidence: "queue_items.state",
      },
      {
        stage: "review",
        state: tasks.length === 0 ? "unavailable" : everyTaskReviewed ? "complete"
          : anyReviewStarted ? "active" : "not-started",
        evidence: "events(action=review.recorded)",
      },
      {
        stage: "integration-verification",
        state: everyTaskAccepted ? "complete" : anyAccepted || anyReviewStarted ? "active" : "not-started",
        evidence: "events(action=review.acceptance)",
      },
      {
        stage: "delivery-decision",
        // Stage 6 waits for an owner decision forever; it never implies publishing ran.
        state: deliveryDecided ? "complete" : deliveryPending || everyTaskAccepted
          ? "awaiting-decision" : "not-started",
        evidence: "team_approvals(action in merge,pr-create,release)",
      },
    ];

    const current = (stages.find((stage) => stage.state !== "complete")?.stage ?? null) as TeamWorkflowStage | null;
    return { current, stages };
  }

  /**
   * Attempts, correlated to the session their queue item names.
   *
   * Each attempt carries its own recorded usage and recording time. The run's usage is a
   * cumulative projection of these rows, so publishing them is what lets a reader show
   * usage over time without a second store: the per-attempt numbers are the ones the
   * run total was summed from.
   */
  private attempts(runId: string, tasks: TeamReviewView[]): TeamAttemptView[] {
    const taskByQitem = new Map(tasks.map((task) => [task.qitemId, task]));
    const rows = this.deps.db
      .prepare(`SELECT a.id AS attemptId, a.run_id AS runId, a.qitem_id AS qitemId, a.role, a.provider, a.state,
        a.unknown_reason AS unknownReason, a.usage_json AS usageJson, a.created_at AS createdAt,
        a.failure_json AS failureJson, q.destination_session AS session
        FROM team_attempts a LEFT JOIN queue_items q ON q.qitem_id = a.qitem_id
        WHERE a.run_id = ? ORDER BY a.created_at, a.id`)
      .all(runId) as Array<{ attemptId: string; runId: string; qitemId: string | null; role: string;
        provider: string; state: string; unknownReason: string | null; usageJson: string;
        createdAt: string; failureJson: string | null; session: string | null }>;
    return rows.map((row) => ({
      attemptId: row.attemptId,
      runId: row.runId,
      taskId: row.qitemId ? (taskByQitem.get(row.qitemId)?.taskId ?? null) : null,
      qitemId: row.qitemId,
      role: row.role as TeamAttemptView["role"],
      provider: row.provider as TeamAttemptView["provider"],
      state: row.state as TeamAttemptView["state"],
      unknownReason: row.unknownReason,
      session: row.session,
      createdAt: row.createdAt,
      usage: parseUsage(JSON.parse(row.usageJson)),
      // T033 — the recorded KTD20 decision, published as it was stored. A row with no code is
      // an attempt that is still running or that ended cleanly; the reader is told null, not
      // given an invented reason.
      failure: row.failureJson === null ? null : JSON.parse(row.failureJson) as TeamAttemptView["failure"],
    }));
  }

  /**
   * Bounded structured logs and exit outcomes.
   *
   * Sources are the durable rows that already hold this evidence: the stream
   * store's inert output, and the task-outcome events the control records when
   * an owner observes an exit. Both are read through this run's task and
   * attempt identities, so a record that cannot be correlated is not published.
   *
   * A seat's session name outlives any one run: the same session can host a
   * later run, or a retry of this one. Attributing every stream row for that
   * name to this run's attempt would publish another run's output under this
   * run's identity, so each row must fall inside the interval its attempt was
   * actually recorded. Rows outside every interval are not this run's evidence
   * and are dropped rather than mislabelled.
   */
  private logs(runId: string, tasks: TeamReviewView[], attempts: TeamAttemptView[]): TeamLogRecord[] {
    const taskByQitem = new Map(tasks.map((task) => [task.qitemId, task]));
    const records: TeamLogRecord[] = [];

    /**
     * Seat windows must be disjoint even when two attempts were recorded in the
     * same millisecond, which is ordinary in tests and possible in production.
     * The boundary therefore orders by `(created_at, id)` and excludes only rows
     * strictly before this attempt's own position: an attempt whose timestamp
     * equals the next one's still owns nothing after it. The opening bound is
     * inclusive of its own instant and the closing bound is exclusive from the
     * next attempt's instant onward, so no row can fall in two windows.
     */
    const intervals = this.deps.db
      .prepare(`SELECT a.id AS attemptId, a.run_id AS runId, a.qitem_id AS qitemId,
        q.destination_session AS session, a.created_at AS startedAt,
        (SELECT MIN(next.created_at) FROM team_attempts next
           JOIN queue_items nextq ON nextq.qitem_id = next.qitem_id
          WHERE nextq.destination_session = q.destination_session
            AND (next.created_at > a.created_at OR (next.created_at = a.created_at AND next.id > a.id))) AS endsAt,
        (SELECT MIN(next.id) FROM team_attempts next
           JOIN queue_items nextq ON nextq.qitem_id = next.qitem_id
          WHERE nextq.destination_session = q.destination_session
            AND next.created_at = a.created_at AND next.id > a.id) AS sameInstantNextId
        FROM team_attempts a JOIN queue_items q ON q.qitem_id = a.qitem_id
        WHERE a.run_id = ? AND q.destination_session IS NOT NULL
        ORDER BY a.created_at, a.id`)
      .all(runId) as Array<{ attemptId: string; runId: string; qitemId: string | null; session: string;
        startedAt: string; endsAt: string | null; sameInstantNextId: string | null }>;

    for (const interval of intervals) {
      // A seat's log rows belong to the attempt that held it. The window opens
      // at this attempt's own recording instant and closes when the next
      // attempt on that seat was recorded, whichever run it belongs to. The
      // last attempt on a seat stays open, because nothing has taken the seat
      // from it. The id tie-break keeps windows disjoint when timestamps tie,
      // so a reused session cannot publish one run's output under another's
      // identity in either direction.
      const rows = interval.endsAt === null
        ? this.deps.db.prepare(`SELECT stream_item_id AS streamItemId, ts_emitted AS ts, body FROM stream_items
            WHERE source_session = ? AND ts_emitted >= ?
            ORDER BY ts_emitted DESC, stream_sort_key DESC LIMIT ?`)
          .all(interval.session, interval.startedAt, LOG_RECORD_LIMIT)
        : this.deps.db.prepare(`SELECT stream_item_id AS streamItemId, ts_emitted AS ts, body FROM stream_items
            WHERE source_session = ? AND ts_emitted >= ? AND ts_emitted < ?
            ORDER BY ts_emitted DESC, stream_sort_key DESC LIMIT ?`)
          .all(interval.session, interval.startedAt, interval.endsAt, LOG_RECORD_LIMIT);
      const seatRows = rows as Array<{ streamItemId: string; ts: string; body: string }>;
      const task = interval.qitemId ? taskByQitem.get(interval.qitemId) : undefined;
      for (const row of seatRows) {
        const { body, truncated } = boundedLogBody(row.body);
        records.push({
          source: "stream",
          streamItemId: row.streamItemId,
          ts: row.ts,
          runId: interval.runId,
          taskId: task?.taskId ?? null,
          attemptId: interval.attemptId,
          session: interval.session,
          body,
          truncated,
          exitOutcome: null,
        });
      }
    }

    // Task outcomes the owner observed carry the only recorded exit verdict for
    // a managed task; they are correlated by the task id the event names.
    const outcomeRows = this.deps.db
      .prepare(`SELECT seq, created_at AS createdAt, payload FROM events
        WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ?
          AND json_extract(payload, '$.action') IN ('task.outcome', 'task.outcome.denied')
        ORDER BY seq DESC LIMIT ?`)
      .all(runId, LOG_RECORD_LIMIT) as Array<{ seq: number; createdAt: string; payload: string }>;
    for (const row of outcomeRows) {
      const parsed = JSON.parse(row.payload) as { payload?: JsonObject; taskId?: string | null; attemptId?: string | null };
      const qitemId = (parsed.payload as { qitemId?: unknown } | undefined)?.qitemId;
      const task = typeof qitemId === "string" ? taskByQitem.get(qitemId) : undefined;
      // The event's taskId identifies the task; the payload's qitemId is the
      // durable key. Without either there is nothing to correlate, so the record
      // is not published rather than attributed by guesswork.
      const taskId = task?.taskId ?? (typeof parsed.taskId === "string" ? parsed.taskId : null);
      if (taskId === null) continue;
      const outcome = (parsed.payload as { state?: unknown } | undefined)?.state;
      const exitOutcome = outcome === "done" || outcome === "failed" || outcome === "denied" || outcome === "canceled"
        ? outcome : null;
      const { body, truncated } = boundedLogBody(canonicalJson(parsed.payload ?? {}));
      records.push({
        source: "task-outcome",
        streamItemId: null,
        ts: row.createdAt,
        runId,
        taskId,
        attemptId: parsed.attemptId ?? null,
        session: null,
        body,
        truncated,
        exitOutcome,
      });
    }

    return records.sort((left, right) => (left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0)).slice(0, LOG_RECORD_LIMIT);
  }

  /**
   * The whole owner read for one run.
   *
   * The projection and the replay cursor must describe one moment. If a commit
   * landed between the last projection read and the cursor read, a client that
   * replays from that cursor would skip the change the projection never saw —
   * the snapshot and the log would disagree forever. Both reads therefore run
   * inside one deferred read transaction, so the cursor cannot advance past
   * state the projection did not observe.
   */
  read(runId: string): TeamOwnerRead {
    return this.readConsistent(() => {
      const run = this.deps.governance.getRun(runId);
      const tasks = this.tasks(runId);
      const attempts = this.attempts(runId, tasks);
      const approvals: TeamApproval[] = this.deps.governance.listApprovals(runId);
      return {
        schema: "multi-agent-team-read/v1",
        protocolVersion: TEAM_READ_MODEL_VERSION,
        runId,
        generatedAt: this.now(),
        run,
        workflow: this.workflow(runId, tasks),
        tasks,
        seats: this.seats(run.rigId),
        attempts,
        approvals: approvals.map((approval) => ({ ...approval, awaitingDecision: approval.state === "pending" })),
        logs: this.logs(runId, tasks, attempts),
        replay: this.deps.events.replayWindow(),
      };
    });
  }

  /**
   * Run a set of reads against one consistent view.
   *
   * `BEGIN DEFERRED` opens a read transaction whose first read fixes the
   * snapshot, so every later read in the callback sees the same committed
   * state. It takes no write lock and writes nothing, which keeps the task's
   * no-mutation acceptance true. A database that refuses the transaction (an
   * already-open transaction on the same connection) is read without one and
   * the limitation is recorded, rather than replacing the read with an error.
   */
  private readConsistent<T>(read: () => T): T {
    const db = this.deps.db;
    let began = false;
    try {
      db.exec("BEGIN DEFERRED");
      began = true;
    } catch {
      // Nested or unavailable transaction: fall back to a plain read.
    }
    try {
      return read();
    } finally {
      if (began) {
        try {
          db.exec("COMMIT");
        } catch {
          try {
            db.exec("ROLLBACK");
          } catch { /* the connection already closed the transaction */ }
        }
      }
    }
  }

  /**
   * One bounded run-scoped replay page from a durable cursor.
   *
   * Replay publishes the same evidence the snapshot does, so it is bounded and
   * redacted by the same rules. A client that got a redacted log from the
   * snapshot and the raw payload from replay would have been handed the secret
   * the first read removed.
   */
  replay(runId: string, afterSeq: number, limit: number): { events: TeamReplayEvent[]; window: { retainedFrom: number; latestSeq: number }; gap: boolean } {
    return this.readConsistent(() => {
      const window = this.deps.events.replayWindow();
      const events = this.deps.events.replayRunSince(runId, afterSeq, limit).map((event) => {
        const envelope = event as unknown as {
          action?: unknown; runId?: unknown; taskId?: unknown; attemptId?: unknown; payload?: unknown;
        };
        const { body, truncated } = boundedLogBody(canonicalJson(envelope.payload ?? {}));
        return {
          seq: event.seq,
          createdAt: event.createdAt,
          type: event.type,
          action: typeof envelope.action === "string" ? envelope.action : null,
          runId: typeof envelope.runId === "string" ? envelope.runId : null,
          taskId: typeof envelope.taskId === "string" ? envelope.taskId : null,
          attemptId: typeof envelope.attemptId === "string" ? envelope.attemptId : null,
          body,
          truncated,
        };
      });
      // Sequence 0 is "from the beginning", not a gap. A gap exists only when a
      // cursor that named real history is older than what is still retained.
      const gap = afterSeq > 0 && afterSeq < window.retainedFrom;
      return { events, window, gap };
    });
  }
}

/** Stage list re-exported so a client can render the stepper without the contract module. */
export { TEAM_WORKFLOW_STAGES };
export type { TeamStageState, TeamWorkflowStage };

export type { TeamModelChoice, TeamModelSettings } from "./domain/team-model-policy.js";
export type { SpecialistSoul } from "./domain/team-souls.js";
export type { WorkflowSelection, TaskWorkflow } from "./domain/team-workflows.js";
export type { FrameworkEntry } from "./integrations/framework/catalog.js";
export type { FrameworkOutcome } from "./integrations/framework/invocation.js";
