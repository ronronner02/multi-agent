import type Database from "better-sqlite3";
import { validateDependencyGraph } from "./workflow-runtime.js";
import { applyTaskEdit, readTaskEdit } from "./task-edit.js";
import { LeadWakePolicy } from "./lead-wake-policy.js";
import { RigRepository } from "./rig-repository.js";
import { createHash, randomUUID } from "node:crypto";
import {
  TEAM_CONTROL_VERSION, TEAM_QUEUE_STATES, TeamContractError, LEAD_FAILED_REASON, canonicalJson, digest, integer, jsonValue,
  object, parseAssignment, parseAttemptIdentity, parseControlRequest, parsePlanBinding, parseTaskInputs, parseTeamEvent, parseUsage, text,
  teamReasonLabelKey, type ApprovalAction, type ApprovalConsumption, type ApprovalKind, type AttemptState, type ControlActor,
  type ControlReceipt, type ControlRequest, type JsonObject, type TeamApproval, type TeamAttempt,
  type TeamRun, type TeamRunPhase, type TeamTaskAuthority, type UsageEvidence, type UsageMetric, type TeamOwnerCommand,
} from "../contracts/team-control.js";
import { roleConfiguration } from "./role-configuration.js";
import { ordinalRunName, reviewName, taskName } from "./display-names.js";
import { classificationFor, parseAttemptClassification, type AttemptReasonCode } from "./attempt-failure.js";
import { ensureSeatMailboxCapability } from "./seat-mailbox-capability.js";
import type { LeadTask } from "./lead-proposal.js";
import { planningRosterRequired, rosterRefusal, type LeadRosterSeat, type LeadSeatChanges } from "./lead-roster.js";
import { addTeamSeats, nextTeamSeatNames } from "./team-setup.js";
import { appendChatMessage, answerDecision, chatBody, getChatMessage, listChatMessages, pendingDecision, runLeadTask, type TeamChatMessage } from "./lead-chat.js";
import { blockingFindings, recordedFindings, reviewBody, reviewerTaskId, reviewVerdict } from "./review-loop.js";
import type { ReviewFinding } from "./review-evidence.js";
import { ScopeExtensions, ScopeExtensionError, type CandidateScopeEvidence } from "./scope-extension.js";
import type { EventBus, NotifyRegister } from "./event-bus.js";
import type { QueueRepository, QueueState } from "./queue-repository.js";

export function hashBytes(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function hashBinding(binding: unknown): string {
  return hashBytes(canonicalJson(parsePlanBinding(binding)));
}

export interface ProviderPolicyCapability {
  policyRevision: number;
  policyFingerprint: string;
  verifiedProviders: readonly ("claude" | "codex")[];
}


export interface NativeLaunchIntent {
  attemptId: string;
  commandDigest: string;
  /** Optional for digest-only callers; recovery of an executable command requires this bound snapshot. */
  command?: JsonObject;
  bindingDigest: string;
  policyFingerprint: string;
  qitemId: string;
  taskVersion: number;
  sessionId: string;
  role: TeamAttempt["role"];
  provider: TeamAttempt["provider"];
  generation: number;
  previous: { attemptId: string; identity: NonNullable<TeamAttempt["identity"]>; version: number } | null;
  state: "admitted" | "running" | "stopped" | "not_started";
  evidenceRef?: string;
}

export class ManagedControlError extends Error {
  readonly code = "managed_control_required";
  constructor() { super("Legacy operations are inactive while managed authority exists; managed dispatch remains disabled."); }
  getResponse(): Response {
    return Response.json({ code: this.code, error: this.message }, { status: 403 });
  }
}

export function hasManagedAuthority(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_runs'").get()
    && !!db.prepare("SELECT 1 FROM team_runs LIMIT 1").get();
}

export type DaemonMode = "legacy" | "managed";

const daemonModes = new WeakMap<Database.Database, DaemonMode>();

/** KTD22: the mode is fixed once per process, before any service starts. Existing authority
 * forces managed mode, so a legacy-mode process never runs beside managed authority. */
export function fixDaemonMode(db: Database.Database, managedRequested: boolean): DaemonMode {
  const mode: DaemonMode = managedRequested || hasManagedAuthority(db) ? "managed" : "legacy";
  const fixed = daemonModes.get(db);
  if (fixed && fixed !== mode) throw new Error(`Daemon mode is already fixed as ${fixed}; restart to switch modes`);
  daemonModes.set(db, mode);
  return mode;
}

export function daemonModeOf(db: Database.Database): DaemonMode | undefined {
  return daemonModes.get(db);
}

export function isManagedMode(db: Database.Database): boolean {
  const fixed = daemonModes.get(db);
  if (fixed !== undefined) return fixed === "managed";
  return hasManagedAuthority(db);
}

export function assertLegacyOperationAllowed(db: Database.Database): void {
  if (isManagedMode(db)) throw new ManagedControlError();
}

const queueWrites = new WeakMap<Database.Database, { operation: "create" | "update"; qitemId?: string }>();

// Only the two synchronous, transaction-owned queue writes below receive this grant.
// It is never supplied by a request, inherited by a detached task, or retained through notification.
function withQueueWrite<T>(db: Database.Database, grant: { operation: "create" | "update"; qitemId?: string }, write: () => T): T {
  const previous = queueWrites.get(db);
  queueWrites.set(db, grant);
  try { return write(); }
  finally {
    if (previous) queueWrites.set(db, previous);
    else queueWrites.delete(db);
  }
}

export function assertGovernedQueueWrite(db: Database.Database, operation: "create" | "update", qitemId?: string): void {
  const grant = queueWrites.get(db);
  if (grant?.operation === operation && grant.qitemId === qitemId && db.inTransaction) return;
  assertLegacyOperationAllowed(db);
}

interface CommandContext {
  request: ControlRequest;
  run: TeamRun;
  now: string;
  register: NotifyRegister;
}

interface Result {
  status: ControlReceipt["status"];
  value?: unknown;
  reason?: string;
  effectMayStart?: boolean;
  observedBy?: string;
  taskId?: string;
  attemptId?: string;
  /** C2 — the implementer task a review sent back, which the route dispatches next. */
  reworkTaskId?: string;
  /** C2 — the reviewer task a completion created, which the route dispatches next. */
  reviewTaskId?: string;
  /** MVP — the lead task a rejected proposal reopened, which the route dispatches next. */
  revisionTaskId?: string;
  /** U8 — pending work a resumed run should offer to the dispatcher. */
  resumeTaskIds?: string[];
}

/**
 * C2 — one review round's recorded verdict, as the durable `review.verdict` event carries it.
 *
 * `taskId` is the implementer under review and `reviewerTaskId` is the run's own reviewer
 * task, so a reader can tell the two apart without joining the assignment rows.
 */
export interface ReviewOutcome {
  taskId: string;
  reviewerTaskId: string;
  round: number;
  candidateDigest: string | null;
  verdict: "approved" | "changes-required";
  findings: ReviewFinding[];
  recordedAt: string;
}

const deny = (reason: string): Result => ({ status: "denied", reason });
const approvalActions: readonly ApprovalAction[] = ["implementation", "commit", "push", "pr-create", "merge", "release", "deploy", "scope-change", "limit-increase", "native-tool", "scope-extension"];
const IMPLEMENTATION_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1_000;
const APPROVAL_RENEWAL_THRESHOLD_MS = 60 * 60 * 1_000;

function isEscalation(approval: { kind: ApprovalKind; action: ApprovalAction }): boolean {
  return approval.kind === "orchestrator" && (approval.action === "scope-change" || approval.action === "limit-increase");
}

function approvalPayload(input: unknown) {
  const v = object(input, "approval");
  if (v.kind !== "orchestrator" && v.kind !== "native") throw new TeamContractError("approval.kind");
  if (!approvalActions.includes(v.action as ApprovalAction)
    || (v.kind === "native") !== (v.action === "native-tool")) throw new TeamContractError("approval.action");
  const payload = jsonValue(object(v.payload, "approval.payload")) as JsonObject;
  return { kind: v.kind as ApprovalKind, action: v.action as ApprovalAction, payload,
    payloadDigest: hashBytes(canonicalJson(payload)), targetDigest: digest(v.targetDigest, "targetDigest") };
}

function attemptState(value: unknown): AttemptState {
  if (value !== "running" && value !== "stopped" && value !== "unknown") throw new TeamContractError("attempt.state");
  return value;
}

function timestamp(value: unknown, field: string): string {
  const s = text(value, field);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) || !Number.isFinite(Date.parse(s))
    || new Date(s).toISOString() !== s) throw new TeamContractError(field);
  return s;
}

function actorIdentity(actor: ControlActor, ownerOnly = false, daemonAllowed = false): ControlActor {
  const v = object(actor, "actor");
  if (v.kind !== "owner" && v.kind !== "worker" && !(daemonAllowed && v.kind === "daemon")) throw new TeamContractError("actor.kind");
  if (ownerOnly && v.kind !== "owner") throw new Error("An authenticated owner control session is required");
  return { kind: v.kind, sessionId: text(v.sessionId, "actor.sessionId", 256) };
}

function taskDefinition(binding: import("../contracts/team-control.js").PlanBinding, payload: unknown, taskId?: string) {
  const v = object(payload, "task"), assignment = parseAssignment(v.assignment);
  if (taskId !== undefined && assignment.taskId !== taskId) throw new TeamContractError("assignment.taskId");
  if (!binding.roles.includes(assignment.role)) return "Assignment role is outside the binding";
  const allowed = assignment.role === "reviewer" ? [...binding.readPaths, ...binding.writePaths] : binding.writePaths;
  const covers = (paths: string[], entry: string) => paths.some(path => entry === path || entry.startsWith(path + "/"));
  if (assignment.paths.some(path => !covers(allowed, path))) return "Assignment path is outside the binding";
  const inputs = parseTaskInputs(v);
  if (inputs.outputs.some(path => !covers(assignment.paths, path) || !covers(binding.writePaths, path))) {
    return "An output is outside the assignment's reviewable write paths";
  }
  if (inputs.permissions.some(permission => !roleConfiguration[assignment.role].permissions.includes(permission))) {
    return "A permission is outside the assignment role's vocabulary";
  }
  if (typeof v.body !== "string" || !v.body.trim() || v.body.length > 262_144) throw new TeamContractError("task.body");
  return { assignment, ...inputs, body: v.body, sourceSession: text(v.sourceSession, "sourceSession"),
    destinationSession: text(v.destinationSession, "destinationSession") };
}

function cumulativeMetric(usages: UsageEvidence[], key: "inputTokens" | "outputTokens" | "costUsd"): UsageMetric {
  if (!usages.length || usages.some((usage) => usage[key].value === null)) {
    return { value: null, reason: `Complete ${key} evidence is unavailable` };
  }
  const value = usages.reduce((total, usage) => total + usage[key].value!, 0);
  if (!Number.isFinite(value) || (key !== "costUsd" && !Number.isSafeInteger(value))) {
    return { value: null, reason: `Cumulative ${key} exceeds the numeric range` };
  }
  return { value, reason: null };
}

/**
 * Internal control-domain boundary, not an authenticated route or a scheduler.
 * Callers supply authenticated actors and freshly resolved source/policy bindings.
 * Native launch, path realpath checks and transport capability enforcement remain
 * with their runtime/route owners; these methods never launch or nudge a process.
 */
export class PlanGovernance {
  private readonly rigs: RigRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly events: EventBus,
    private readonly queue: QueueRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly readPolicyCapability?: () => ProviderPolicyCapability | null,
  ) {
    if (events.db !== db || queue.db !== db) throw new Error("Governance, queue and events must share one database connection");
    this.rigs = new RigRepository(db);
  }

  createRun(input: { id: string; rigId: string; binding: unknown; reviewerSeat?: string | null; displayName?: string | null;
    phase?: TeamRunPhase }): TeamRun {
    this.assertStandalone();
    if (daemonModeOf(this.db) === "legacy") throw new Error("A legacy-mode daemon cannot register managed authority; restart in managed mode");
    const id = text(input.id, "runId", 256);
    const rigId = text(input.rigId, "rigId", 256);
    const binding = parsePlanBinding(input.binding);
    // C2 — the seat every review round of this run routes to. A start that names none keeps
    // the pre-C2 behaviour: an implementer task completes and no review task is created.
    const reviewerSeat = input.reviewerSeat === undefined || input.reviewerSeat === null ? null : text(input.reviewerSeat, "reviewerSeat", 256);
    // U9 — the run's name from its goal. A caller that names none records no name, and `getRun`
    // falls back to the run's creation order on the rig.
    const displayName = input.displayName?.trim() || null;
    // U5 — a planning run's work is the lead's conversation with the owner; every other run
    // starts in delivery, which is what every row recorded before the phase existed is.
    const phase: TeamRunPhase = input.phase === "planning" ? "planning" : "delivery";
    const bindingDigest = hashBinding(binding);
    return this.events.withNotifyEnvelope((register) => {
      if (this.db.prepare("SELECT id FROM team_runs WHERE id = ?").get(id)) {
        const existing = this.getRun(id);
        if (existing.rigId !== rigId || existing.bindingDigest !== bindingDigest) throw new Error("Run identity conflict");
        return existing;
      }
      this.rigs.assertNoPendingDeletion(rigId);
      const now = this.clock().toISOString();
      this.db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, reviewer_seat, display_name, phase, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, rigId, canonicalJson(binding), bindingDigest, reviewerSeat, displayName, phase, now, now);
      const run = this.getRun(id);
      this.emit(run, register, "run.created", { bindingDigest, state: "pending" });
      return run;
    });
  }

  /**
   * MVP slice 2 — every recorded run, newest first.
   *
   * A read for the owner's run picker: a client that has no run id cannot discover one from
   * the per-run routes, and asking the owner to remember a UUID is not a flow. It writes
   * nothing, so it holds no authority of its own; the route that serves it is owner-only.
   */
  listRuns(): TeamRun[] {
    const rows = this.db.prepare("SELECT id FROM team_runs ORDER BY created_at DESC, id").all() as Array<{ id: string }>;
    return rows.map(row => this.getRun(row.id));
  }

  getRun(id: string): TeamRun {
    const row = this.db.prepare(`SELECT id, rig_id AS rigId, binding_json AS bindingJson, binding_digest AS bindingDigest,
      reviewer_seat AS reviewerSeat, state, state_reason AS stateReason, phase, entity_version AS entityVersion,
      active_ms AS activeMs, accounted_at AS accountedAt, retries_used AS retriesUsed,
      review_rounds_used AS reviewRoundsUsed, display_name AS displayName, created_at AS createdAt,
      updated_at AS updatedAt, rowid AS rowOrdinal
      FROM team_runs WHERE id = ?`).get(id) as (Omit<TeamRun, "binding" | "usage" | "displayName"> &
        { bindingJson: string; displayName: string | null; rowOrdinal: number }) | undefined;
    if (!row) throw new Error("Run not found");
    const { bindingJson, displayName, rowOrdinal, ...run } = row;
    const usages = (this.db.prepare("SELECT usage_json FROM team_attempts WHERE run_id = ?").all(id) as Array<{ usage_json: string }>)
      .map((attempt) => parseUsage(JSON.parse(attempt.usage_json)));
    return { ...run, displayName: displayName ?? this.runOrdinalName(run.rigId, rowOrdinal),
      stateReasonKey: teamReasonLabelKey(run.stateReason),
      binding: parsePlanBinding(JSON.parse(bindingJson)), usage: { activeMs: run.activeMs,
      inputTokens: cumulativeMetric(usages, "inputTokens"), outputTokens: cumulativeMetric(usages, "outputTokens"), costUsd: cumulativeMetric(usages, "costUsd") } };
  }

  /**
   * U8 — refresh the run's implementation approval immediately before a launch.
   *
   * There is deliberately no timer. Dispatch is the boundary that needs the authority, so a
   * dispatch close to (or just after) the old expiry extends the grant for another 24-hour
   * approval window and records the daemon action. An expired row is recoverable when no command has yet
   * observed the expiry; the run is still approved and the binding is unchanged.
   */
  renewImplementationApproval(runId: string): boolean {
    this.assertStandalone();
    return this.events.withNotifyEnvelope((register) => {
      const run = this.getRun(runId);
      if (run.state !== "approved") return false;
      const now = this.clock().toISOString();
      const approval = this.db.prepare(`SELECT id, expires_at AS expiresAt, state FROM team_approvals
        WHERE run_id = ? AND kind = 'orchestrator' AND action = 'implementation'
          AND binding_digest = ? AND state IN ('approved', 'expired')
        ORDER BY rowid DESC LIMIT 1`).get(run.id, run.bindingDigest) as
        { id: string; expiresAt: string; state: string } | undefined;
      if (!approval) return false;
      const remaining = Date.parse(approval.expiresAt) - Date.parse(now);
      if (approval.state === "approved" && remaining > APPROVAL_RENEWAL_THRESHOLD_MS) return false;
      const nextExpiry = new Date(Date.parse(now) + IMPLEMENTATION_APPROVAL_WINDOW_MS).toISOString();
      const updated = this.db.prepare(`UPDATE team_approvals SET state = 'approved', expires_at = ?,
        entity_version = entity_version + 1, decision_actor = 'daemon', updated_at = ?
        WHERE id = ? AND state IN ('approved', 'expired')`).run(nextExpiry, now, approval.id);
      if (updated.changes !== 1) return false;
      this.emit(run, register, "approval.renewed", {
        approvalId: approval.id, previousExpiresAt: approval.expiresAt, expiresAt: nextExpiry, observedBy: "daemon",
      });
      return true;
    });
  }

  /**
   * U7 — the run's integration branch, where it lives, and the commits landed on it.
   *
   * A run that has not integrated anything yet has no record, and the caller derives the branch
   * name from the run itself. The commits are returned in the order they landed, which is the
   * order the owner reads them in and the order the branch holds them.
   */
  integrationRecord(runId: string): {
    branch: string | null; worktree: string | null; repository: string | null;
    commits: Array<{ taskId: string; commitSha: string; subject: string; committedAt: string }>;
  } {
    const row = this.db.prepare(`SELECT integration_branch AS branch, integration_worktree AS worktree,
      integration_repository AS repository FROM team_runs WHERE id = ?`).get(runId) as
      { branch: string | null; worktree: string | null; repository: string | null } | undefined;
    if (!row) throw new Error("Run not found");
    const commits = (this.db.prepare(`SELECT task_id AS taskId, commit_sha AS commitSha, subject, committed_at AS committedAt
      FROM team_integration_commits WHERE run_id = ? ORDER BY committed_at, rowid`).all(runId) as Array<
      { taskId: string; commitSha: string; subject: string; committedAt: string }>);
    return { ...row, commits };
  }

  /**
   * U9 — the name a task was admitted with, or null when its row recorded none.
   *
   * The integration commit's subject is the task's display name, so the reader here is the
   * integration owner rather than any part of the task contract.
   */
  taskDisplayName(qitemId: string): string | null {
    const row = this.db.prepare("SELECT display_name AS name FROM team_queue_authority WHERE qitem_id = ?")
      .get(qitemId) as { name: string | null } | undefined;
    return row?.name ?? null;
  }

  /**
   * U9 — a run recorded before names existed is named by its creation order on its rig.
   *
   * `rowid` is the insertion order, which is what "created" means for rows whose `created_at`
   * can tie at millisecond resolution; the row's own position is what makes the ordinal stable.
   */
  private runOrdinalName(rigId: string, rowOrdinal: number): string {
    const { ordinal } = this.db.prepare("SELECT count(*) AS ordinal FROM team_runs WHERE rig_id = ? AND rowid <= ?")
      .get(rigId, rowOrdinal) as { ordinal: number };
    return ordinalRunName(ordinal);
  }

  listApprovals(runId: string): TeamApproval[] {
    this.getRun(runId);
    const rows = this.db.prepare("SELECT id FROM team_approvals WHERE run_id = ? ORDER BY created_at, id").all(runId) as Array<{ id: string }>;
    return rows.map(row => this.getApproval(row.id)!);
  }

  getApproval(id: string): TeamApproval | null {
    const row = this.db.prepare(`SELECT id, run_id AS runId, kind, action, payload_json AS payloadJson,
      payload_digest AS payloadDigest, target_digest AS targetDigest, binding_digest AS bindingDigest, state,
      entity_version AS entityVersion, expires_at AS expiresAt, decision_actor AS decisionActor FROM team_approvals WHERE id = ?`)
      .get(id) as (Omit<TeamApproval, "payload"> & { payloadJson: string }) | undefined;
    if (!row) return null;
    const { payloadJson, ...approval } = row;
    return { ...approval, payload: JSON.parse(payloadJson) as JsonObject };
  }

  getTask(qitemId: string): TeamTaskAuthority | null {
    const row = this.db.prepare(`SELECT qitem_id AS qitemId, run_id AS runId, assignment_json AS assignmentJson,
      outputs_json AS outputsJson, permissions_json AS permissionsJson,
      entity_version AS entityVersion, evidence_json AS evidenceJson FROM team_queue_authority WHERE qitem_id = ?`)
      .get(qitemId) as (Omit<TeamTaskAuthority, "assignment" | "outputs" | "permissions" | "evidence">
        & { assignmentJson: string; outputsJson: string | null; permissionsJson: string | null; evidenceJson: string | null }) | undefined;
    if (!row) return null;
    const { assignmentJson, outputsJson, permissionsJson, evidenceJson, ...task } = row;
    return { ...task, assignment: parseAssignment(JSON.parse(assignmentJson)),
      // `null` is "this row predates the record", which is different from a task that
      // declared nothing: only a recorded value can be compared with a caller's.
      outputs: outputsJson === null ? null : JSON.parse(outputsJson) as string[],
      permissions: permissionsJson === null ? null : JSON.parse(permissionsJson) as string[],
      evidence: evidenceJson === null ? null : JSON.parse(evidenceJson) as JsonObject };
  }

  /** T053 — the run's recorded task for a plan task id, or null when `task.created` never ran for it. */
  findTask(runId: string, taskId: string): TeamTaskAuthority | null {
    const row = this.db.prepare("SELECT qitem_id AS qitemId FROM team_queue_authority WHERE run_id = ? AND task_id = ?")
      .get(runId, taskId) as { qitemId: string } | undefined;
    return row ? this.getTask(row.qitemId) : null;
  }

  /** MVP slice 3 — a task's queue state, so a reader can tell a finished task from one in flight. */
  queueState(qitemId: string): string | null {
    return this.queue.getById(qitemId)?.state ?? null;
  }

  /** MVP — the seat the queue recorded for a task, which an owner observation must identify. */
  taskSeat(qitemId: string): string | null {
    return this.queue.getById(qitemId)?.destinationSession ?? null;
  }

  /**
   * MVP — attempts of a task that are not observed stopped.
   *
   * The owner outcome command refuses while any attempt of the task is unresolved, so the
   * completion read states the same number instead of leaving the owner to infer it.
   */
  openAttemptCount(qitemId: string): number {
    const row = this.db.prepare("SELECT count(*) AS count FROM team_attempts WHERE qitem_id = ? AND state <> 'stopped'")
      .get(qitemId) as { count: number };
    return row.count;
  }

  assertTaskContinuation(runId: string, taskId: string, version: number, currentBinding: unknown, attemptId: string): void {
    const run = this.getRun(runId), task = this.findTask(runId, taskId);
    if (!task) throw new Error("Task not found");
    const latest = this.getLatestTaskAttempt(task.qitemId);
    if (run.entityVersion !== version || hashBinding(currentBinding) !== run.bindingDigest
      || !["pending", "in-progress"].includes(this.queueState(task.qitemId) ?? "")
      || (latest && (latest.id !== attemptId || latest.state !== "running"))) {
      throw new Error("Continuation conflict: the run, task or attempt changed");
    }
    const reason = this.eligibility({ run, now: this.clock().toISOString() }, attemptId);
    if (reason) throw new Error(`Continuation conflict: ${reason}`);
  }

  getAttempt(id: string): TeamAttempt | null {
    const row = this.db.prepare(`SELECT id, run_id AS runId, qitem_id AS qitemId, role, provider, identity_json AS identityJson,
      unknown_reason AS unknownReason, state, usage_json AS usageJson, entity_version AS entityVersion,
      failure_json AS failureJson FROM team_attempts WHERE id = ?`)
      .get(id) as (Omit<TeamAttempt, "identity" | "usage" | "failure"> & { identityJson: string | null; usageJson: string; failureJson: string | null }) | undefined;
    if (!row) return null;
    const { identityJson, usageJson, failureJson, ...attempt } = row;
    return { ...attempt, identity: identityJson === null ? null : parseAttemptIdentity(JSON.parse(identityJson)), usage: parseUsage(JSON.parse(usageJson)),
      failure: failureJson === null ? null : parseAttemptClassification(JSON.parse(failureJson)) };
  }


  getLatestTaskAttempt(qitemId: string): TeamAttempt | null {
    const row = this.db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1").get(qitemId) as { id: string } | undefined;
    return row ? this.getAttempt(row.id) : null;
  }

  getNativeLaunchIntent(runId: string, attemptId: string): NativeLaunchIntent | null {
    return this.nativeLaunchIntents(runId).find(intent => intent.attemptId === attemptId) ?? null;
  }

  private nativeLaunchIntents(runId: string): NativeLaunchIntent[] {
    const rows = this.db.prepare(`SELECT payload FROM events WHERE seq IN (
      SELECT MAX(seq) FROM events WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ?
        AND json_extract(payload, '$.action') = 'attempt.launch-intent' GROUP BY json_extract(payload, '$.attemptId'))`)
      .all(runId) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload).payload as NativeLaunchIntent);
  }

  getConsumption(approvalId: string): ApprovalConsumption | null {
    const row = this.db.prepare(`SELECT approval_id AS approvalId, run_id AS runId, attempt_id AS attemptId, state,
      receipt_json AS receiptJson FROM team_approval_consumptions WHERE approval_id = ?`).get(approvalId) as
      (Omit<ApprovalConsumption, "receipt"> & { receiptJson: string | null }) | undefined;
    if (!row) return null;
    const { receiptJson, ...consumption } = row;
    return { ...consumption, receipt: receiptJson === null ? null : JSON.parse(receiptJson) as JsonObject };
  }

  stageCandidateScope(runId: string, taskId: string, evidence: CandidateScopeEvidence) {
    const scope = new ScopeExtensions(this.db), run = this.getRun(runId), task = this.findTask(runId, taskId);
    if (!task) throw new Error("Task not found in this run");
    const current = scope.currentBinding(run);
    if (!current || hashBinding(current) !== run.bindingDigest) {
      this.reconcileBinding({ protocolVersion: TEAM_CONTROL_VERSION, runId, actionId: randomUUID(),
        expectedEntityVersion: run.entityVersion, idempotencyKey: randomUUID(), payload: current ?? {} });
      throw new ScopeExtensionError("plan-change-required", "plan-digest");
    }
    if (run.state !== "approved") throw new ScopeExtensionError("plan-change-required", "run-not-approved");
    const result = this.events.withNotifyEnvelope(register => {
      const value = scope.stage(run, task, evidence, this.clock().toISOString());
      if (value.invalidated.length) this.emit(run, register, "scope-extension.invalidated", { approvalIds: value.invalidated }, taskId);
      if (value.created) this.emit(run, register, "scope-extension.requested",
        { approvalId: value.created.id, automatic: value.created.automatic }, taskId, value.created.attemptId ?? undefined);
      return value;
    });
    if (result.refusal) throw result.refusal;
    return result.projection;
  }

  scopeForTask(runId: string, taskId: string) {
    const task = this.findTask(runId, taskId);
    if (!task) throw new Error("Task not found in this run");
    return new ScopeExtensions(this.db).projection(this.getRun(runId), task);
  }

  proposeRunGrowth(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command("run.growth-requested", raw, owner, ctx => {
      if (ctx.run.state !== "invalidated") return deny("Run growth requires a suspended plan-change request");
      const binding = parsePlanBinding(currentBinding), v = object(ctx.request.payload, "growth");
      if (binding.repository.root !== ctx.run.binding.repository.root || binding.planRef !== ctx.run.binding.planRef
        || canonicalJson(binding.limits) !== canonicalJson(ctx.run.binding.limits)
        || canonicalJson(binding.roles) !== canonicalJson(ctx.run.binding.roles)) return deny("Run growth preserves the repository, roles and limits");
      if (hashBinding(binding) === ctx.run.bindingDigest) return deny("The replacement plan binding has not changed");
      const tasks = this.growthTasks(ctx, binding, v.tasks, owner.sessionId);
      if (typeof tasks === "string") return deny(tasks);
      const payload = jsonValue({ change: "run-growth", binding, tasks }) as JsonObject;
      const targetDigest = hashBytes(canonicalJson(payload)), expiresAt = timestamp(v.expiresAt, "expiresAt");
      if (expiresAt <= ctx.now) return deny("Approval expiry must be in the future");
      if (this.db.prepare(`SELECT id FROM team_approvals WHERE run_id=? AND action='scope-change'
        AND target_digest=? AND binding_digest=? AND state<>'expired'`).get(ctx.run.id, targetDigest, ctx.run.bindingDigest)) {
        return deny("An approval for this exact operation is already recorded");
      }
      this.db.prepare(`INSERT INTO team_approvals
        (id,run_id,kind,action,payload_json,payload_digest,target_digest,binding_digest,state,expires_at,created_at,updated_at)
        VALUES (?,?,'orchestrator','scope-change',?,?,?,?,'pending',?,?,?)`).run(ctx.request.actionId, ctx.run.id,
        canonicalJson(payload), targetDigest, targetDigest, ctx.run.bindingDigest, expiresAt, ctx.now, ctx.now);
      return { status: "accepted", value: this.getApproval(ctx.request.actionId), observedBy: owner.sessionId };
    });
  }

  private growthTasks(ctx: CommandContext, binding: import("../contracts/team-control.js").PlanBinding,
    value: unknown, sourceSession?: string) {
    if (!Array.isArray(value) || !value.length || value.length > 100) throw new TeamContractError("growth.tasks");
    const tasks = [];
    for (const input of value) {
      const value = object(input, "task"), role = parseAssignment(value.assignment).role;
      const task = taskDefinition(binding, { ...value, ...(sourceSession ? { sourceSession,
        outputs: value.outputs ?? [], permissions: value.permissions ?? [...roleConfiguration[role].permissions] } : {}) });
      if (typeof task === "string") return task;
      tasks.push(task);
    }
    const existing = (this.db.prepare("SELECT assignment_json AS assignment FROM team_queue_authority WHERE run_id=?")
      .all(ctx.run.id) as Array<{ assignment: string }>).map(row => parseAssignment(JSON.parse(row.assignment)));
    const covers = (path: string) => binding.writePaths.some(root => path === root || path.startsWith(root + "/"));
    if (existing.some(task => task.role !== "reviewer" && task.paths.some(path => !covers(path)))) {
      return "The replacement binding must preserve existing task scopes";
    }
    const graph = validateDependencyGraph([...existing, ...tasks.map(task => task.assignment)]);
    return graph.ok ? tasks : graph.reason;
  }

  /**
   * C3 — whether a seat on this rig declares the implementer role.
   *
   * The seat is the latest session registered for a node, which is the address a launch
   * resolves; the role is that node's. A seat the rig does not have, or one that declares
   * another role, is not an implementer seat.
   */
  private implementerSeat(rigId: string, seat: string): boolean {
    const row = this.db.prepare(`SELECT n.role AS role FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND n.retired_at IS NULL AND s.session_name = ? ORDER BY s.created_at DESC, s.id DESC LIMIT 1`).get(rigId, seat) as
      { role: string | null } | undefined;
    return row?.role === "implementer";
  }

  /**
   * C3 — record the owner decision a lead's decomposition becomes.
   *
   * The lead cannot admit work, and nothing it writes is admitted by the daemon: this records
   * one pending approval carrying the exact task batch the daemon read from the lead's own
   * candidate tree. The owner approves it through the same `approvals/decide` path C1 growth
   * uses, and the batch is admitted by `applyLeadProposal`. Unlike growth, the plan binding is
   * unchanged — the tasks stay inside the scope the owner already approved — so nothing is
   * suspended and no implementation approval is reissued.
   */
  proposeLeadTasks(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown, leadTasks: readonly LeadTask[]): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command("run.lead-proposal-requested", raw, owner, ctx => {
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (ctx.run.state !== "approved") return deny("A lead proposal requires an approved run");
      // The lead's seats and paths are its proposal; everything else about each task is the
      // run's own vocabulary, exactly as a growth task gets it.
      const batch = this.growthTasks(ctx, ctx.run.binding, leadTasks.map(task => ({
        assignment: { taskId: task.taskId, role: "implementer", paths: task.paths, dependencies: task.dependencies },
        outputs: [], permissions: [...roleConfiguration.implementer.permissions], body: task.body,
        destinationSession: task.seat })), owner.sessionId);
      if (typeof batch === "string") return deny(batch);
      // A lead chooses seats from its roster, and the roster lists roles too. The batch this
      // boundary builds is always implementer work, so a seat that declares another role would
      // be handed an implementer assignment: refuse it here rather than at the launch.
      const notImplementer = batch.find(task => !this.implementerSeat(ctx.run.rigId, task.destinationSession));
      if (notImplementer) return deny(`Seat ${notImplementer.destinationSession} is not an implementer seat on this rig`);
      const payload = jsonValue({ change: "lead-proposal", tasks: batch }) as JsonObject;
      const targetDigest = hashBytes(canonicalJson(payload)), expiresAt = timestamp(object(object(ctx.request.payload, "payload").leadProposal, "leadProposal").expiresAt, "expiresAt");
      if (expiresAt <= ctx.now) return deny("Approval expiry must be in the future");
      if (this.db.prepare(`SELECT id FROM team_approvals WHERE run_id=? AND action='scope-change'
        AND target_digest=? AND binding_digest=? AND state<>'expired'`).get(ctx.run.id, targetDigest, ctx.run.bindingDigest)) {
        return deny("An approval for this exact operation is already recorded");
      }
      this.db.prepare(`INSERT INTO team_approvals
        (id,run_id,kind,action,payload_json,payload_digest,target_digest,binding_digest,state,expires_at,created_at,updated_at)
        VALUES (?,?,'orchestrator','scope-change',?,?,?,?,'pending',?,?,?)`).run(ctx.request.actionId, ctx.run.id,
        canonicalJson(payload), targetDigest, targetDigest, ctx.run.bindingDigest, expiresAt, ctx.now, ctx.now);
      return { status: "accepted", value: this.getApproval(ctx.request.actionId), observedBy: owner.sessionId };
    });
  }

  /**
   * C3 — admit an owner-approved lead decomposition.
   *
   * Runs inside the decision command, so the approval and every task it carries commit
   * together. The batch is re-validated against the run's own binding and rows here rather
   * than trusted from the approval row, exactly as run growth does, and each task goes through
   * the one admission write.
   */
  private applyLeadProposal(ctx: CommandContext, approval: TeamApproval, owner: ControlActor): Result {
    const tasks = this.growthTasks(ctx, ctx.run.binding, approval.payload.tasks);
    if (typeof tasks === "string") throw new Error("Lead task admission conflict: " + tasks);
    for (const task of tasks) {
      const taskId = task.assignment.taskId;
      const result = this.writeTask({ ...ctx, request: { ...ctx.request, actionId: taskId, payload: jsonValue(task) } });
      if (result.status !== "accepted") throw new Error("Lead task admission conflict: " + result.reason);
      this.emit(ctx.run, ctx.register, "task.created", { actionId: taskId, status: "accepted",
        valueDigest: hashBytes(canonicalJson(result.value)) }, taskId);
    }
    return { status: "accepted", value: { ...this.getApproval(approval.id), addedTasks: tasks.map(task => task.assignment.taskId) },
      effectMayStart: true, observedBy: owner.sessionId };
  }

  /**
   * MVP — reopen the lead's task after the owner rejected its proposal.
   *
   * The rejection is the reason the lead's next attempt exists, so it is recorded as the
   * decision's own event payload rather than a second table: the launch reads the newest
   * `approval.decided` for the task and states the reason in the resumed turn's prompt. The
   * lead task is reopened through the transition the rework path already uses, so its
   * transition log and the dependency gate keep working exactly as they do for a rework.
   *
   * A task that is no longer terminal has already been reopened by a concurrent decision, and
   * a run that is not `approved` dispatches nothing; neither is an error of this decision.
   */
  private startLeadRevision(ctx: CommandContext, approval: TeamApproval, reason: unknown, owner: ControlActor): Result {
    // The run has exactly one lead task, and a lead proposal only exists because that task
    // wrote it; reading it from the run's own rows keeps the revision attached to the seat that
    // proposed rather than to whatever the approval payload happens to name.
    const row = this.db.prepare(`SELECT task_id AS taskId FROM team_queue_authority
      WHERE run_id = ? AND json_extract(assignment_json, '$.role') = 'lead' LIMIT 2`).all(ctx.run.id) as Array<{ taskId: string }>;
    const taskId = row.length === 1 ? row[0]!.taskId : null;
    if (taskId === null) return { status: "accepted", value: this.getApproval(approval.id), observedBy: owner.sessionId };
    const task = this.findTask(ctx.run.id, taskId);
    if (!task || task.assignment.role !== "lead") return deny("The proposal's task is not this run's lead task");
    // The reason is owner prose that reaches an agent's prompt, so it is bounded and refused
    // rather than truncated: a revision asked for in a sentence nobody can read is worse than
    // a rejection that says nothing.
    const note = reason === undefined || reason === null ? null : text(reason, "reason", 4_096);
    // Recorded even when the owner said nothing: the event is what the lead's next attempt
    // reads to learn that its proposal was refused, and "no reason given" is still an answer.
    this.emit(ctx.run, ctx.register, "approval.decided", { actionId: approval.id, status: "accepted",
      reason: null, valueDigest: hashBytes(canonicalJson(null)), observedBy: owner.sessionId, taskId, note },
      taskId);
    const item = this.queue.getById(task.qitemId);
    if (item && (item.state === "done" || item.state === "handed-off")) {
      const updated = withQueueWrite(this.db, { operation: "update", qitemId: task.qitemId }, () => this.queue.updateWithinTransaction({
        qitemId: task.qitemId, actorSession: ctx.run.id, state: "pending", reopen: true,
        transitionNote: "The owner rejected the lead's proposal; the lead revises it",
      }));
      for (const event of updated.persistedEvents) ctx.register(event);
    }
    return { status: "accepted", value: { ...this.getApproval(approval.id), revisionTaskId: taskId },
      effectMayStart: true, observedBy: owner.sessionId, revisionTaskId: taskId };
  }

  /**
   * U6 — admit the lead's decomposition at its turn end, with no owner approval.
   *
   * After the plan is approved the owner is the board, not the dispatcher (KTD1): the lead's
   * task list is ordinary work inside a binding the owner already approved, so the daemon
   * admits it the way it would admit any work — through the same `growthTasks` validation and
   * the same one admission write — and no approval row is created. The owner-decided path
   * (`proposeLeadTasks`/`applyLeadProposal`) stays for a caller that still wants a decision.
   *
   * A batch the binding does not cover is refused with the reason the lead is then told: the
   * lead task is reopened in this same transaction, and the refusal is recorded as the note its
   * next prompt carries. The lead can shrink the change or escalate; the daemon never widens the
   * plan on the lead's behalf.
   */
  private prepareSeatChanges(ctx: CommandContext, changes: LeadSeatChanges, maxSeats: number) {
    const current = this.db.prepare(`SELECT n.id, n.role, n.runtime AS client,
        (SELECT session_name FROM sessions WHERE node_id = n.id ORDER BY created_at DESC, id DESC LIMIT 1) AS member
      FROM nodes n WHERE n.rig_id = ? AND n.retired_at IS NULL AND n.role IN ('implementer', 'reviewer')`)
      .all(ctx.run.rigId) as Array<LeadRosterSeat & { id: string; member: string | null }>;
    const retired: typeof current = [];
    for (const member of changes.retire) {
      const seat = current.find(seat => seat.member === member);
      if (!seat) return `Seat ${member} is not an active non-lead seat on this rig`;
      const live = this.db.prepare(`SELECT 1 FROM team_attempts a JOIN queue_items q ON q.qitem_id = a.qitem_id
        JOIN team_runs r ON r.id = a.run_id WHERE r.rig_id = ? AND a.state <> 'stopped'
        AND q.destination_session IN (SELECT session_name FROM sessions WHERE node_id = ?) LIMIT 1`).get(ctx.run.rigId, seat.id);
      if (live) return `Seat ${member} has a live attempt`;
      const sessions = this.db.prepare("SELECT session_name AS name FROM sessions WHERE node_id = ?").all(seat.id) as Array<{ name: string }>;
      const rigsRuns = this.db.prepare("SELECT id FROM team_runs WHERE rig_id = ?").all(ctx.run.rigId) as Array<{ id: string }>;
      if (rigsRuns.some(run => this.nativeLaunchIntents(run.id).some(intent => intent.state === "admitted"
        && sessions.some(session => session.name === intent.sessionId)))) return `Seat ${member} has a pending native launch`;
      // Failed tasks can be retried. Canceled and denied tasks no longer hold an assignment.
      const assigned = this.db.prepare(`SELECT 1 FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
        JOIN team_runs r ON r.id = a.run_id WHERE r.rig_id = ? AND q.state IN ('pending', 'in-progress', 'blocked', 'failed')
        AND q.destination_session IN (SELECT session_name FROM sessions WHERE node_id = ?) LIMIT 1`).get(ctx.run.rigId, seat.id);
      if (assigned) return `Seat ${member} has an unfinished assigned task`;
      // A completed implementation still owns rework while its separate reviewer task is unresolved.
      const awaitingReview = this.db.prepare(`SELECT 1 FROM team_queue_authority a
        JOIN queue_items q ON q.qitem_id = a.qitem_id JOIN team_runs r ON r.id = a.run_id
        JOIN team_queue_authority review ON review.run_id = a.run_id
          AND json_extract(review.assignment_json, '$.reviewOf') = a.task_id
        JOIN queue_items rq ON rq.qitem_id = review.qitem_id
        WHERE r.rig_id = ? AND json_extract(a.assignment_json, '$.role') = 'implementer'
          AND json_extract(review.assignment_json, '$.role') = 'reviewer' AND q.state IN ('done', 'handed-off')
          AND rq.state IN ('pending', 'in-progress', 'blocked', 'failed')
          AND q.destination_session IN (SELECT session_name FROM sessions WHERE node_id = ?) LIMIT 1`).get(ctx.run.rigId, seat.id);
      if (awaitingReview) return `Seat ${member} has an implementation with an unresolved review`;
      const reserved = this.db.prepare(`SELECT 1 FROM team_runs WHERE rig_id = ? AND id <> ? AND state <> 'canceled'
        AND reviewer_seat IN (SELECT session_name FROM sessions WHERE node_id = ?) LIMIT 1`).get(ctx.run.rigId, ctx.run.id, seat.id);
      if (reserved) return `Seat ${member} is reserved by another open run`;
      retired.push(seat);
    }
    const names = nextTeamSeatNames(this.db, ctx.run.rigId, changes.add);
    const final = [...current.filter(seat => !retired.includes(seat)),
      ...changes.add.map((seat, index) => ({ ...seat, member: names[index]! }))];
    const refusal = rosterRefusal(final, maxSeats);
    if (refusal) return refusal;
    return { retired, added: changes.add, reviewer: final.find(seat => seat.role === "reviewer")?.member ?? null,
      implementers: new Set(final.filter(seat => seat.role === "implementer").map(seat => seat.member)) };
  }

  admitLeadProposal(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown, leadTasks: readonly LeadTask[],
    seats?: LeadSeatChanges, maxSeats = 6): ControlReceipt {
    const daemon = actorIdentity(actor, false, true);
    if (daemon.kind !== "daemon") throw new Error("A lead's decomposition is admitted by the daemon, not by another caller");
    return this.command("run.lead-tasks-admitted", raw, daemon, ctx => {
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (ctx.run.phase !== "delivery") return deny("A lead's decomposition is admitted after the owner approves the plan");
      // A closed run dispatches nothing, so reopening the lead would only record work the run
      // cannot do. That is an observation about the run, not a defect in the lead's list.
      if (ctx.run.state !== "approved") return deny(`Run is closed to task admission (${ctx.run.state})`);
      const seatChanges = seats === undefined ? null : this.prepareSeatChanges(ctx, seats, maxSeats);
      if (typeof seatChanges === "string") return this.refuseLeadProposal(ctx, seatChanges);
      // The lead's seats and paths are its proposal; everything else about each task is the
      // run's own vocabulary, exactly as a growth task gets it.
      const batch = this.growthTasks(ctx, ctx.run.binding, leadTasks.map(task => ({
        assignment: { taskId: task.taskId, role: "implementer", paths: task.paths, dependencies: task.dependencies },
        outputs: [], permissions: [...roleConfiguration.implementer.permissions], body: task.body,
        destinationSession: task.seat })), "daemon");
      if (typeof batch === "string") return this.refuseLeadProposal(ctx, batch);
      const notImplementer = batch.find(task => seatChanges ? !seatChanges.implementers.has(task.destinationSession)
        : !this.implementerSeat(ctx.run.rigId, task.destinationSession));
      if (notImplementer) {
        return this.refuseLeadProposal(ctx, `Seat ${notImplementer.destinationSession} is not an implementer seat on this rig`);
      }
      if (seatChanges) {
        for (const seat of seatChanges.retired) this.db.prepare("UPDATE nodes SET retired_at = ? WHERE id = ?").run(ctx.now, seat.id);
        addTeamSeats(this.db, ctx.run.rigId, seatChanges.added);
        ctx.run.reviewerSeat = seatChanges.reviewer;
        this.db.prepare("UPDATE team_runs SET reviewer_seat = ? WHERE id = ?").run(ctx.run.reviewerSeat, ctx.run.id);
      }
      for (const task of batch) {
        const taskId = task.assignment.taskId;
        const result = this.writeTask({ ...ctx, request: { ...ctx.request, actionId: taskId, payload: jsonValue(task) } });
        if (result.status !== "accepted") throw new Error("Lead task admission conflict: " + result.reason);
        this.emit(ctx.run, ctx.register, "task.created", { actionId: taskId, status: "accepted",
          valueDigest: hashBytes(canonicalJson(result.value)) }, taskId);
      }
      return { status: "accepted", value: { addedTasks: batch.map(task => task.assignment.taskId),
        ...(seats === undefined ? {} : { proposalDigest: hashBytes(canonicalJson({ tasks: leadTasks, seats })) }) },
        effectMayStart: true, observedBy: "daemon" };
    });
  }

  /**
   * U6 — refuse a decomposition the boundary could not parse, and make the reason the lead's
   * next piece of work.
   *
   * `admitLeadProposal` refuses a batch the approved plan does not cover, but only after the
   * proposal has been parsed: a file that names a task with no write paths, or is not the shape
   * the boundary states, has no batch to validate. That refusal is the lead's to act on all the
   * same, so it is recorded through the same `lead.proposal-refused` event and the same reopen
   * the plan-coverage refusal uses. Leaving it silent is what let a live run sit idle with a
   * failed lead task and no list admitted.
   */
  refuseLeadTasks(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown,
    reason: string): ControlReceipt {
    const daemon = actorIdentity(actor, false, true);
    if (daemon.kind !== "daemon") throw new Error("A lead's decomposition is refused by the daemon, not by another caller");
    const note = text(reason, "reason", 4_096);
    return this.command("run.lead-tasks-refused", raw, daemon, ctx => {
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (ctx.run.phase !== "delivery") return deny("A lead's decomposition is admitted after the owner approves the plan");
      if (ctx.run.state !== "approved") return deny(`Run is closed to task admission (${ctx.run.state})`);
      return this.refuseLeadProposal(ctx, note);
    });
  }

  /**
   * U6 — refuse a decomposition and make the refusal the lead's next piece of work.
   *
   * The reason reaches an agent's prompt, so it is the governance owner's own sentence and not
   * a stack trace. The lead task is reopened through the transition a rejected proposal already
   * uses, and the `lead.proposal-refused` event is what its next attempt reads to learn why.
   */
  refuseLeadPlan(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown, reason: string): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command("run.lead-plan-refused", raw, owner, ctx => {
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (ctx.run.phase !== "planning" || ctx.run.state !== "approved") return deny("This run is not awaiting a planning revision");
      return this.refuseLeadProposal(ctx, text(reason, "reason", 4_096));
    });
  }

  private refuseLeadProposal(ctx: CommandContext, reason: string): Result {
    const lead = runLeadTask(this.db, ctx.run.id);
    if (!lead) return deny(reason);
    const planning = ctx.run.phase === "planning";
    this.emit(ctx.run, ctx.register, planning ? "lead.plan-refused" : "lead.proposal-refused", { note: reason }, lead.taskId);
    this.reopenLeadTask(ctx, planning ? "The planning roster was refused; the lead revises it"
      : "The daemon refused the lead's task list; the lead revises it or escalates");
    return { status: "denied", reason, effectMayStart: true, observedBy: "daemon", revisionTaskId: lead.taskId };
  }

  /**
   * U6 — wake the lead with the team events it has not been told about.
   *
   * One command per wake, not one per event: the caller collects everything one sweep found and
   * the note lists them together, so a team that fails two tasks at once is one turn, not two.
   * The events are counted by the caller and recorded here with the note, which is what makes a
   * second sweep over the same facts wake nobody.
   */
  wakeLeadTask(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown,
    events: readonly { key: string; note: string }[]): ControlReceipt {
    const daemon = actorIdentity(actor, false, true);
    if (daemon.kind !== "daemon") throw new Error("A lead wake is observed by the daemon, not by another caller");
    return this.command("run.lead-woken", raw, daemon, ctx => {
      if (!events.length) return deny("A lead wake carries at least one event");
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (ctx.run.phase !== "delivery") return deny("This run is not delivering work");
      if (ctx.run.state !== "approved") return deny(`Run is closed to a lead wake (${ctx.run.state})`);
      const lead = runLeadTask(this.db, ctx.run.id);
      if (!lead) return deny("This run has no lead task to wake");
      if (this.db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? AND state <> 'stopped' LIMIT 1").get(lead.qitemId)) {
        return deny("The lead is already answering a turn");
      }
      const item = this.queue.getById(lead.qitemId);
      if (!item || !["pending", "in-progress", "done", "handed-off"].includes(item.state)) return deny("The lead task is not woken here");
      // The event is the wake's own record: the note its next prompt reads, and the keys that
      // say which facts it has now been told about.
      this.emit(ctx.run, ctx.register, "lead.woken", { note: events.map(event => event.note).join("\n"),
        keys: events.map(event => event.key) }, lead.taskId);
      this.reopenLeadTask(ctx, "The daemon woke the lead for its team's events");
      return { status: "accepted", value: { keys: events.map(event => event.key) }, effectMayStart: true,
        observedBy: "daemon", revisionTaskId: lead.taskId };
    });
  }

  /**
   * Return the run's lead task to the queue when it has already finished, so its next attempt
   * exists. A task still pending or running is left alone: the wake or the refusal is the reason
   * its next prompt carries, and a second reopen would only rewrite the transition that is
   * already current.
   */
  private reopenLeadTask(ctx: CommandContext, note: string): void {
    const lead = runLeadTask(this.db, ctx.run.id);
    if (!lead) return;
    const item = this.queue.getById(lead.qitemId);
    if (!item || (item.state !== "done" && item.state !== "handed-off")) return;
    const updated = withQueueWrite(this.db, { operation: "update", qitemId: lead.qitemId }, () => this.queue.updateWithinTransaction({
      qitemId: lead.qitemId, actorSession: ctx.run.id, state: "pending", reopen: true, transitionNote: note,
    }));
    for (const event of updated.persistedEvents) ctx.register(event);
  }

  /**
   * U6 — put a failed lead task back in the queue when the owner resumes the run.
   *
   * A lead failure the daemon will not retry blocks the run, and no wake can reach the lead:
   * it is the manager. Resume is the owner's one action for a blocked run, so it is also what
   * starts the manager again. `failed` is not a guarded terminal, so this is the queue's
   * ordinary transition, and the caller reads the pending tasks after it.
   */
  private reopenFailedLeadTask(ctx: CommandContext): void {
    const lead = runLeadTask(this.db, ctx.run.id);
    if (!lead) return;
    const item = this.queue.getById(lead.qitemId);
    if (!item || item.state !== "failed") return;
    const updated = withQueueWrite(this.db, { operation: "update", qitemId: lead.qitemId }, () => this.queue.updateWithinTransaction({
      qitemId: lead.qitemId, actorSession: ctx.run.id, state: "pending",
      transitionNote: "The owner resumed the run; the lead's task runs again",
    }));
    for (const event of updated.persistedEvents) ctx.register(event);
  }

  /**
   * U6 — the chat message, and the decision it answers.
   *
   * An owner message that names a decision answers it: the decision row keeps the message id,
   * which is what makes it no longer pending. The message itself is unchanged — it is the owner
   * speaking — so the lead's next prompt carries the answer exactly as it carries any message.
   */
  postChatMessage(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command("chat.message", raw, owner, (ctx) => {
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (ctx.run.state === "canceled" || ctx.run.state === "cancel_requested") return deny("Run is closed; the lead is not reading messages");
      const payload = object(ctx.request.payload, "chat");
      const body = chatBody(payload.body, "chat.body");
      // The decision the owner is answering, when they name one. Checked before anything is
      // written, so a message that names a decision this run does not have is not stored as if
      // it had answered something.
      const answerTo = payload.answerTo === undefined || payload.answerTo === null
        ? null : text(payload.answerTo, "chat.answerTo", 256);
      if (answerTo !== null) {
        const decision = getChatMessage(this.db, answerTo);
        if (!decision || decision.runId !== ctx.run.id || decision.kind !== "decision") {
          return deny("This run has no decision with that id");
        }
        if (decision.answeredBy !== null) return deny("That decision was already answered");
      }
      const lead = runLeadTask(this.db, ctx.run.id);
      if (!lead) return deny("This run has no lead task to answer the owner");
      const message = appendChatMessage(this.db, { id: ctx.request.actionId, runId: ctx.run.id,
        body, createdAt: ctx.now });
      // The answer is recorded in the same transaction as the message, so a decision is never
      // answered by a message this run did not keep.
      if (answerTo !== null) answerDecision(this.db, answerTo, message.id);
      const answered = answerTo === null ? {} : { answered: answerTo };
      // The command's own event carries the message id and the owner as its observer; the text
      // itself stays in the chat table, so it is not copied into the log with a second retention.
      // A turn already running is the whole answer: the message is pending now, and the turn-end
      // owner starts the next turn for it. Two turns at once is never a state this command makes.
      if (this.db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? AND state <> 'stopped' LIMIT 1").get(lead.qitemId)) {
        return { status: "accepted", value: { messageId: message.id, queued: true, ...answered }, taskId: lead.taskId,
          observedBy: owner.sessionId };
      }
      const item = this.queue.getById(lead.qitemId);
      if (item && (item.state === "done" || item.state === "handed-off")) {
        const updated = withQueueWrite(this.db, { operation: "update", qitemId: lead.qitemId }, () => this.queue.updateWithinTransaction({
          qitemId: lead.qitemId, actorSession: ctx.run.id, state: "pending", reopen: true,
          transitionNote: "The owner sent a chat message; the lead answers it",
        }));
        for (const event of updated.persistedEvents) ctx.register(event);
        return { status: "accepted", value: { messageId: message.id, queued: false, ...answered },
          effectMayStart: true, taskId: lead.taskId, revisionTaskId: lead.taskId, observedBy: owner.sessionId };
      }
      if (item && (item.state === "pending" || item.state === "in-progress") && ctx.run.state === "approved") {
        return { status: "accepted", value: { messageId: message.id, queued: false, ...answered },
          effectMayStart: true, taskId: lead.taskId, revisionTaskId: lead.taskId, observedBy: owner.sessionId };
      }
      // A blocked or canceled lead task is not dispatchable, and this command does not unblock a
      // run. The message is recorded as queued so the owner sees it was kept, not answered.
      return { status: "accepted", value: { messageId: message.id, queued: true, ...answered }, taskId: lead.taskId,
        observedBy: owner.sessionId, reason: "The lead task is not dispatchable; the message waits for it" };
    });
  }

  /** U6 — the decision the run is waiting on, as the chat read publishes it. */
  chatDecision(runId: string): TeamChatMessage | null {
    this.getRun(runId);
    return pendingDecision(this.db, runId);
  }

  /** U5 — the run's conversation, in order. A read for the route; it writes nothing. */
  chatMessages(runId: string): TeamChatMessage[] {
    this.getRun(runId);
    return listChatMessages(this.db, runId);
  }

  /** U5 — the run's one lead task: the task a chat message and a plan approval address. */
  leadTask(runId: string): { taskId: string; qitemId: string } | null {
    this.getRun(runId);
    return runLeadTask(this.db, runId);
  }

  /**
   * U5 — the owner approves the plan, and the run becomes delivery.
   *
   * The plan's bytes were read from the lead's own candidate tree and committed to the
   * daemon-owned branch before this runs; what is left is the binding it establishes. The
   * replacement is the same kind C1 growth already accepts — same repository, same plan path,
   * same roles and limits, a write scope the owner chose — and it is recorded the same way: a
   * fresh implementation approval under the new digest, with the bootstrap approval and the
   * pending decisions it made obsolete invalidated in one write.
   *
   * The lead's task is reopened, because its next activation is the decomposition the approved
   * plan calls for; a task still pending is left as it is and the route starts it. A plan
   * approval is not a task admission: nothing about the decomposition is known yet, and the
   * lead's proposal still goes through the owner's decision.
   */
  planRosterRefusal(runId: string, seats: readonly LeadRosterSeat[], maxSeats: number): string | null {
    const result = this.reconcilePlanRoster(this.getRun(runId).rigId, seats, maxSeats);
    return "reason" in result ? result.reason : null;
  }

  private reconcilePlanRoster(rigId: string, seats: readonly LeadRosterSeat[], maxSeats: number):
    { reason: string } | { missing: LeadRosterSeat[]; reviewerSeat: string | null } {
    const reason = rosterRefusal(seats, maxSeats);
    if (reason) return { reason };
    const existing = this.db.prepare(`SELECT n.logical_id AS logicalId, n.role, n.runtime AS client,
      (SELECT s.session_name FROM sessions s WHERE s.node_id = n.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS member
      FROM nodes n WHERE n.rig_id = ? AND n.retired_at IS NULL AND n.role IN ('implementer', 'reviewer')
      ORDER BY n.logical_id`).all(rigId) as Array<{
        logicalId: string; role: LeadRosterSeat["role"]; client: string | null; member: string | null;
      }>;
    const missing = [...seats];
    let reviewerSeat: string | null = null;
    for (const seat of existing) {
      const name = seat.member ?? seat.logicalId;
      if (!seat.member || (seat.client !== "claude-code" && seat.client !== "codex")) {
        return { reason: `Existing seat ${name} (${seat.role}, ${seat.client ?? "no client"}) needs a supported client and session before approval.` };
      }
      const index = missing.findIndex(requested => requested.role === seat.role && requested.client === seat.client);
      if (index < 0) {
        return { reason: `Existing seat ${name} (${seat.role}, ${seat.client}) is not included in the proposed roster. Keep its role and client and revise the roster.` };
      }
      missing.splice(index, 1);
      if (seat.role === "reviewer") reviewerSeat = seat.member;
    }
    return { missing, reviewerSeat };
  }

  approvePlan(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown, approved: unknown,
    roster?: { seats: readonly LeadRosterSeat[]; maxSeats: number }): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command("plan.approved", raw, owner, (ctx) => {
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (ctx.run.phase !== "planning") return deny("This run's plan was already approved");
      if (ctx.run.state !== "approved") return deny(`Run is closed to plan approval (${ctx.run.state})`);
      const binding = parsePlanBinding(approved);
      // Everything the owner did not decide with this approval is the bootstrap's: the same
      // repository, plan path, roles and limits, and a write scope that still covers the lead
      // task the run already admitted. A plan that moved the repository would be a different
      // run, which is a new start rather than an approval.
      if (binding.repository.root !== ctx.run.binding.repository.root || binding.planRef !== ctx.run.binding.planRef
        || canonicalJson(binding.roles) !== canonicalJson(ctx.run.binding.roles)
        || canonicalJson(binding.limits) !== canonicalJson(ctx.run.binding.limits)) {
        return deny("Approving a plan keeps the run's repository, plan path, roles and limits");
      }
      const covers = (path: string) => binding.writePaths.some(root => path === root || path.startsWith(root + "/"));
      const admitted = (this.db.prepare("SELECT assignment_json AS assignment FROM team_queue_authority WHERE run_id = ?")
        .all(ctx.run.id) as Array<{ assignment: string }>).map(row => parseAssignment(JSON.parse(row.assignment)));
      if (admitted.some(task => task.role !== "reviewer" && task.paths.some(path => !covers(path)))) {
        return deny("The approved plan's write scope must cover the tasks this run already admitted");
      }
      const lead = runLeadTask(this.db, ctx.run.id);
      if (!lead) return deny("This run has no lead task to decompose the plan");
      if (planningRosterRequired(ctx.run.binding)) {
        if (!roster) return this.refuseLeadProposal(ctx, "Read and approve the lead-roster.json digest with the plan.");
        const reconciled = this.reconcilePlanRoster(ctx.run.rigId, roster.seats, roster.maxSeats);
        if ("reason" in reconciled) return this.refuseLeadProposal(ctx, reconciled.reason);
        const added = addTeamSeats(this.db, ctx.run.rigId, reconciled.missing);
        ctx.run.reviewerSeat = reconciled.reviewerSeat ?? added.find(seat => seat.role === "reviewer")?.member ?? null;
        this.db.prepare("UPDATE team_runs SET reviewer_seat = ? WHERE id = ?").run(ctx.run.reviewerSeat, ctx.run.id);
      }
      this.invalidateUnused(ctx, false);
      ctx.run.binding = binding;
      ctx.run.bindingDigest = hashBinding(binding);
      const payload = { bindingDigest: ctx.run.bindingDigest };
      this.db.prepare(`INSERT INTO team_approvals
        (id,run_id,kind,action,payload_json,payload_digest,target_digest,binding_digest,state,expires_at,decision_actor,created_at,updated_at)
        VALUES (?,?,'orchestrator','implementation',?,?,?,?,'approved',?,?,?,?)`).run(randomUUID(), ctx.run.id,
        canonicalJson(payload), hashBytes(canonicalJson(payload)), ctx.run.bindingDigest, ctx.run.bindingDigest,
        // A plan approval's grant lives as long as the run's budget does: the plan was just
        // approved, and a second expiry a day later would close a run nobody had finished.
        new Date(this.clock().getTime() + ctx.run.binding.limits.maxActiveMs).toISOString(),
        owner.sessionId, ctx.now, ctx.now);
      ctx.run.phase = "delivery";
      ctx.run.state = "approved";
      ctx.run.stateReason = null;
      const item = this.queue.getById(lead.qitemId);
      if (item && (item.state === "done" || item.state === "handed-off")) {
        const updated = withQueueWrite(this.db, { operation: "update", qitemId: lead.qitemId }, () => this.queue.updateWithinTransaction({
          qitemId: lead.qitemId, actorSession: ctx.run.id, state: "pending", reopen: true,
          transitionNote: "The owner approved the plan; the lead decomposes it",
        }));
        for (const event of updated.persistedEvents) ctx.register(event);
      }
      return { status: "accepted", value: { phase: ctx.run.phase, bindingDigest: ctx.run.bindingDigest, planRef: binding.planRef },
        effectMayStart: true, taskId: lead.taskId, revisionTaskId: lead.taskId, observedBy: owner.sessionId };
    });
  }

  private applyRunGrowth(ctx: CommandContext, approval: TeamApproval, owner: ControlActor): Result {
    const binding = parsePlanBinding(approval.payload.binding);
    const tasks = this.growthTasks(ctx, binding, approval.payload.tasks);
    if (typeof tasks === "string") throw new Error("Run growth admission conflict: " + tasks);
    this.invalidateUnused(ctx, false, approval.id);
    ctx.run.binding = binding; ctx.run.bindingDigest = hashBinding(binding);
    ctx.run.state = "approved"; ctx.run.stateReason = null;
    const payload = { bindingDigest: ctx.run.bindingDigest };
    this.db.prepare(`INSERT INTO team_approvals
      (id,run_id,kind,action,payload_json,payload_digest,target_digest,binding_digest,state,expires_at,decision_actor,created_at,updated_at)
      VALUES (?,?,'orchestrator','implementation',?,?,?,?,'approved',?,?,?,?)`).run(randomUUID(), ctx.run.id,
      canonicalJson(payload), hashBytes(canonicalJson(payload)), ctx.run.bindingDigest, ctx.run.bindingDigest,
      approval.expiresAt, owner.sessionId, ctx.now, ctx.now);
    for (const task of tasks) {
      const taskId = task.assignment.taskId;
      const result = this.writeTask({ ...ctx, request: { ...ctx.request, actionId: taskId, payload: jsonValue(task) } });
      if (result.status !== "accepted") throw new Error("Run growth admission conflict: " + result.reason);
      this.emit(ctx.run, ctx.register, "task.created", { actionId: taskId, status: "accepted",
        valueDigest: hashBytes(canonicalJson(result.value)) }, taskId);
    }
    return { status: "accepted", value: { ...this.getApproval(approval.id), addedTasks: tasks.map(task => task.assignment.taskId) },
      effectMayStart: true, observedBy: owner.sessionId };
  }

  requestApproval(raw: ControlRequest<unknown>, actor: ControlActor): ControlReceipt {
    const requester = actorIdentity(actor);
    return this.command("approval.requested", raw, requester, (ctx) => {
      const approval = approvalPayload(ctx.request.payload);
      if (approval.action === "scope-extension") return deny("Only candidate staging creates scope extensions");
      if (approval.payload.change === "run-growth") return deny("Only suspended run growth creates replacement proposals");
      if (approval.kind === "native") return deny("A native prompt is a configuration fault, not an owner approval action");
      const v = object(ctx.request.payload, "approval");
      const expiresAt = timestamp(v.expiresAt, "expiresAt");
      if (expiresAt <= ctx.now) return deny("Approval expiry must be in the future");
      const blockedEscalation = ctx.run.state === "blocked" && requester.kind === "owner" && isEscalation(approval);
      if (ctx.run.state !== "pending" && ctx.run.state !== "approved" && !blockedEscalation) return deny("Run is closed to new approvals");
      if (approval.action === "implementation" && (approval.targetDigest !== ctx.run.bindingDigest
        || canonicalJson(approval.payload) !== canonicalJson({ bindingDigest: ctx.run.bindingDigest }))) return deny("Implementation approval must bind the complete registered scope");
      // Expiry permits a new pending decision, never an implicit grant or a reset of run usage.
      const duplicate = this.db.prepare(`SELECT id FROM team_approvals WHERE run_id = ? AND kind = ? AND action = ?
        AND payload_digest = ? AND target_digest = ? AND binding_digest = ?
        AND (state <> 'expired' OR id = ? OR EXISTS
          (SELECT 1 FROM team_approval_consumptions c WHERE c.approval_id = team_approvals.id))`)
        .get(ctx.run.id, approval.kind, approval.action, approval.payloadDigest, approval.targetDigest, ctx.run.bindingDigest, ctx.request.actionId);
      if (duplicate) return deny("An approval for this exact operation is already recorded; renaming it does not renew authority");
      this.db.prepare(`INSERT INTO team_approvals
        (id, run_id, kind, action, payload_json, payload_digest, target_digest, binding_digest, state, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(ctx.request.actionId, ctx.run.id, approval.kind, approval.action,
        canonicalJson(approval.payload), approval.payloadDigest, approval.targetDigest, ctx.run.bindingDigest, expiresAt, ctx.now, ctx.now);
      return { status: "accepted", value: this.getApproval(ctx.request.actionId) };
    });
  }

  decideApproval(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command("approval.decided", raw, owner, (ctx) => {
      const approval = this.getApproval(ctx.request.actionId);
      if (!approval || approval.runId !== ctx.run.id) throw new Error("Approval not found in this run");
      const growth = approval.action === "scope-change" && approval.payload.change === "run-growth";
      // C3 — a lead's decomposition is a batch inside the binding the owner already approved,
      // so it is decided against the current binding exactly like any other decision; only its
      // admission differs from growth's, which also replaces the binding.
      const lead = approval.action === "scope-change" && approval.payload.change === "lead-proposal";
      if (growth) {
        if (ctx.run.state !== "invalidated" || approval.bindingDigest !== ctx.run.bindingDigest) return deny("Run growth no longer matches the suspended binding");
        if (hashBinding(currentBinding) !== hashBinding(approval.payload.binding)) {
          this.invalidateUnused(ctx);
          return deny("The proposed plan, repository or policy binding changed");
        }
        if (ctx.run.activeMs >= ctx.run.binding.limits.maxActiveMs) return deny("Active wall-clock budget exhausted");
      } else if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (approval.kind === "native") return deny("A native prompt is a configuration fault, not an owner approval action");
      const v = object(ctx.request.payload, "decision");
      if (approval.state !== "pending") {
        if (approval.action === "scope-extension") throw new Error("Scope extension approval state conflict");
        return deny("Approval is no longer pending");
      }
      if (integer(v.approvalVersion, "approvalVersion", 1) !== approval.entityVersion) throw new Error("Approval version conflict");
      if (v.decision !== "approved" && v.decision !== "rejected") throw new TeamContractError("decision");
      const blockedEscalation = growth || ctx.run.state === "blocked" && isEscalation(approval);
      if (ctx.run.state !== "pending" && ctx.run.state !== "approved" && !blockedEscalation) return deny("Run is closed to decisions");
      if (v.decision === "approved" && approval.action !== "implementation" && !blockedEscalation) {
        const reason = this.eligibility(ctx);
        if (reason) return deny(reason);
      }
      if (approval.action === "scope-extension") {
        const task = this.findTask(ctx.run.id, text(approval.payload.taskId, "taskId"));
        if (!task) throw new Error("Task not found in this run");
        new ScopeExtensions(this.db).decide(ctx.run, task, approval, v.expectedChainHead, v.decision);
      }
      const updated = this.db.prepare(`UPDATE team_approvals SET state = ?, decision_actor = ?, entity_version = entity_version + 1,
        updated_at = ? WHERE id = ? AND entity_version = ? AND state = 'pending'`)
        .run(v.decision, owner.sessionId, ctx.now, approval.id, approval.entityVersion);
      if (updated.changes !== 1) throw new Error("Approval version conflict");
      if (growth && v.decision === "approved") return this.applyRunGrowth(ctx, approval, owner);
      if (lead && v.decision === "approved") return this.applyLeadProposal(ctx, approval, owner);
      // MVP — a rejected lead proposal is the lead's next piece of work, not the end of the
      // conversation. With headless turns the owner can no longer type a revision request into
      // the lead's terminal, so the rejection itself carries the reason and reopens the lead
      // task; the dispatch that already follows an `effectMayStart` receipt starts its next
      // attempt, which resumes the lead's conversation and is told what the owner refused.
      if (lead && v.decision === "rejected") return this.startLeadRevision(ctx, approval, v.reason, owner);
      if (approval.action === "implementation" && v.decision === "approved") {
        ctx.run.state = "approved";
        ctx.run.stateReason = null;
      }
      return { status: "accepted", value: this.getApproval(approval.id), observedBy: owner.sessionId };
    });
  }

  reconcileBinding(raw: ControlRequest<unknown>): ControlReceipt {
    return this.command("run.reconciled", raw, null, (ctx) => this.reconcile(ctx, ctx.request.payload)
      ? { status: "observed", value: { bindingDigest: ctx.run.bindingDigest } } : deny("Plan, repository or policy binding changed"));
  }

  cancelRun(raw: ControlRequest<unknown>, actor: ControlActor): ControlReceipt {
    return this.command("run.cancel-requested", raw, actorIdentity(actor, true), (ctx) => {
      const reason = text(object(ctx.request.payload, "cancellation").reason, "cancellation.reason");
      // A canceled run is already at rest: its attempts ended and its tasks closed, so a second
      // request would reopen nothing and could only rewrite the recorded outcome.
      if (ctx.run.state === "canceled") return deny("Run is already canceled");
      ctx.run.state = "cancel_requested";
      ctx.run.stateReason = reason;
      this.invalidateUnused(ctx);
      return { status: "pending-execution", value: { state: "cancel_requested" }, reason: "Termination has not been observed" };
    });
  }

  /**
   * T017 (cancellation half) — record that the cancellation came to rest, or say what did not.
   *
   * `cancelRun` records the owner's intent and says in its own reason that termination has not
   * been observed. This is the observation: once every attempt the run recorded has ended and no
   * launch is outstanding, the run is `canceled` and every task still open is closed with it.
   *
   * Nothing is deleted. The candidate trees, the attempts and the evidence stay exactly as they
   * were, so a canceled run's work is still reviewable and `rig team apply` still reads it — the
   * owner asked for the work to stop, not for the record of it to disappear.
   *
   * While anything is unresolved the run stays `cancel_requested` and this says which attempts
   * are still alive, so the owner sees an outcome that was not observed instead of a stop that
   * was assumed.
   */
  observeCancellation(raw: ControlRequest<unknown>, actor: ControlActor): ControlReceipt {
    return this.command("run.cancel-observed", raw, actorIdentity(actor, true), (ctx) => {
      if (ctx.run.state !== "cancel_requested") return deny(`Run is not awaiting cancellation (${ctx.run.state})`);
      const unresolved = this.unresolvedAttempts(ctx.run.id);
      if (unresolved.length) {
        return { status: "pending-execution", value: { state: "cancel_requested", unresolvedAttempts: unresolved },
          reason: `Termination was not observed for ${unresolved.length} attempt(s): ${unresolved.join(", ")}` };
      }
      ctx.run.state = "canceled";
      const canceled = this.cancelOpenTasks(ctx);
      return { status: "observed", value: { state: "canceled", canceledTasks: canceled, reason: ctx.run.stateReason } };
    });
  }

  /** The attempts of one run that no observation has ended, as the ids a reader can act on. */
  private unresolvedAttempts(runId: string): string[] {
    const rows = this.db.prepare("SELECT id FROM team_attempts WHERE run_id = ? AND state IN ('running', 'unknown') ORDER BY rowid")
      .all(runId) as Array<{ id: string }>;
    return [...rows.map(row => row.id),
      ...this.nativeLaunchIntents(runId).filter(intent => intent.state === "admitted").map(intent => intent.attemptId)];
  }

  /**
   * Close every task of a canceled run that is still open.
   *
   * A task that already reached a terminal state keeps it: a candidate the owner accepted is
   * still accepted. `canceled` is the queue's own terminal state, written through the same
   * update the rework path uses, so the transition log and the dependency gate see it.
   */
  private cancelOpenTasks(ctx: CommandContext): string[] {
    const rows = this.db.prepare("SELECT qitem_id AS qitemId FROM team_queue_authority WHERE run_id = ? ORDER BY task_id")
      .all(ctx.run.id) as Array<{ qitemId: string }>;
    const canceled: string[] = [];
    for (const row of rows) {
      const item = this.queue.getById(row.qitemId);
      if (!item || !["pending", "in-progress", "blocked"].includes(item.state)) continue;
      const updated = withQueueWrite(this.db, { operation: "update", qitemId: row.qitemId }, () => this.queue.updateWithinTransaction({
        qitemId: row.qitemId, actorSession: ctx.run.id, state: "canceled",
        transitionNote: "Run canceled; the owner observed every attempt end",
      }));
      for (const event of updated.persistedEvents) ctx.register(event);
      canceled.push(this.getTask(row.qitemId)!.assignment.taskId);
    }
    return canceled;
  }

  ownerCommand(operation: TeamOwnerCommand, raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command(operation === "retry" ? "task.retry-requested" : `run.${operation}`, raw, owner, ctx => {
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (operation === "retry") {
        const reason = this.eligibility(ctx);
        if (reason) return deny(reason);
        const task = this.getTask(ctx.request.actionId), item = this.queue.getById(ctx.request.actionId);
        if (!task || task.runId !== ctx.run.id || !item) throw new Error("Task not found in this run");
        const v = object(ctx.request.payload, "retry");
        if (integer(v.expectedTaskVersion, "expectedTaskVersion", 1) !== task.entityVersion) throw new Error("Task version conflict");
        const attempt = this.getAttempt(text(v.attemptId, "attemptId", 256));
        if (!attempt || attempt.runId !== ctx.run.id || attempt.qitemId !== task.qitemId || attempt.role !== task.assignment.role) return deny("Retry requires this task's stopped attempt");
        if (integer(v.expectedAttemptVersion, "expectedAttemptVersion", 1) !== attempt.entityVersion) throw new Error("Attempt version conflict");
        const latest = this.db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1").get(task.qitemId) as { id: string };
        if (item.state !== "failed" || !task.evidence || !Object.keys(task.evidence).length
          || attempt.state !== "stopped" || attempt.identity === null || latest.id !== attempt.id
          || this.db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? AND state <> 'stopped' LIMIT 1").get(task.qitemId)) {
          return deny("Retry requires a verified failed task with every attempt observed stopped");
        }
        // T033 — KTD20 decides whether this failure may be retried, and this command never
        // re-derives that answer: it reads the code the classifier recorded with the stop. An
        // attempt with no classification is exactly "when uncertain, choose not retried", and a
        // code outside the eligible set is a blocker whose reason is the owner action.
        if (attempt.failure === null) return deny("The failed attempt has no classification, so it is not retried");
        if (!attempt.failure.retryEligible) {
          return deny(`Retry is not eligible for ${attempt.failure.reasonCode}: ${attempt.failure.ownerAction}`);
        }
        if (ctx.run.retriesUsed >= ctx.run.binding.limits.maxRetries) return deny("Retry limit exhausted");
        ctx.run.retriesUsed += 1;
        const changed = this.db.prepare("UPDATE team_queue_authority SET entity_version = entity_version + 1 WHERE qitem_id = ? AND entity_version = ?")
          .run(task.qitemId, task.entityVersion);
        if (changed.changes !== 1) throw new Error("Task version conflict");
        // Failed rows use the queue's ordinary transition; its reopen flag is only for archived outcomes.
        const updated = withQueueWrite(this.db, { operation: "update", qitemId: task.qitemId }, () => this.queue.updateWithinTransaction({
          qitemId: task.qitemId, actorSession: owner.sessionId, state: "pending", transitionNote: `Owner counted retry of ${attempt.id}`,
        }));
        for (const event of updated.persistedEvents) ctx.register(event);
        return { status: "accepted", value: this.getTask(task.qitemId), taskId: task.assignment.taskId,
          attemptId: attempt.id, observedBy: owner.sessionId };
      }
      if (ctx.request.actionId !== ctx.run.id) throw new TeamContractError("ownerCommand.actionId");
      const payload = object(ctx.request.payload, "ownerCommand");
      if (operation === "resume") {
        if (ctx.run.state !== "blocked") return deny("Only a blocked run can resume");
        const option = (name: string): number => {
          const value = payload[name];
          if (value === undefined) return 0;
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TeamContractError(`ownerCommand.${name}`);
          return value;
        };
        const addMinutes = option("addMinutes"), addRetries = option("addRetries"), addReviewRounds = option("addReviewRounds");
        const reason = ctx.run.stateReason;
        const activeBudget = reason === "Active wall-clock budget exhausted";
        const retryBudget = reason === "retry limit exhausted" || reason === "Retry limit exhausted";
        const reviewBudget = reason === "review limit exhausted";
        // Review exhaustion is a lead escalation point: the owner may resume it so the lead can
        // decide what follow-up work is needed. Retry and wall-clock exhaustion are the budgets
        // that require an explicit increase in this same owner action.
        const required = activeBudget ? "addMinutes" : retryBudget ? "addRetries"
          : reviewBudget && addReviewRounds > 0 ? "addReviewRounds" : null;
        const amount = required === "addMinutes" ? addMinutes : required === "addRetries" ? addRetries
          : required === "addReviewRounds" ? addReviewRounds : 0;
        if (required !== null && amount <= 0) {
          return deny(`Resume requires a positive ${required} increase for ${reason}`);
        }
        if (required === null && (addMinutes > 0 || addRetries > 0 || addReviewRounds > 0)) {
          return deny("Budget increases are only accepted for a budget-blocked run");
        }
        if (required !== null) {
          const limits = { ...ctx.run.binding.limits,
            ...(activeBudget ? { maxActiveMs: ctx.run.binding.limits.maxActiveMs + addMinutes * 60_000 } : {}),
            ...(retryBudget ? { maxRetries: ctx.run.binding.limits.maxRetries + addRetries } : {}),
            ...(reviewBudget ? { maxReviewRounds: ctx.run.binding.limits.maxReviewRounds + addReviewRounds } : {}),
          };
          const binding = parsePlanBinding({ ...ctx.run.binding, limits });
          this.invalidateUnused(ctx);
          ctx.run.binding = binding;
          ctx.run.bindingDigest = hashBinding(binding);
          const approvalPayload = { bindingDigest: ctx.run.bindingDigest };
          this.db.prepare(`INSERT INTO team_approvals
            (id,run_id,kind,action,payload_json,payload_digest,target_digest,binding_digest,state,expires_at,decision_actor,created_at,updated_at)
            VALUES (?,?,'orchestrator','implementation',?,?,?,?,'approved',?,?,?,?)`).run(randomUUID(), ctx.run.id,
            canonicalJson(approvalPayload), hashBytes(canonicalJson(approvalPayload)), ctx.run.bindingDigest, ctx.run.bindingDigest,
            new Date(Date.parse(ctx.now) + binding.limits.maxActiveMs).toISOString(), owner.sessionId, ctx.now, ctx.now);
        } else if (reason !== "owner-paused" && !this.db.prepare(`SELECT id FROM team_approvals WHERE run_id = ? AND kind = 'orchestrator'
          AND action = 'implementation' AND binding_digest = ? AND state = 'approved' AND expires_at > ?`)
          .get(ctx.run.id, ctx.run.bindingDigest, ctx.now)) {
          // Blocking transitions revoke the old implementation grant. Resume is the one owner
          // action that reopens that same binding, so issue a fresh grant before eligibility
          // checks the dispatch gate.
          this.invalidateUnused(ctx);
          const approvalPayload = { bindingDigest: ctx.run.bindingDigest };
          this.db.prepare(`INSERT INTO team_approvals
            (id,run_id,kind,action,payload_json,payload_digest,target_digest,binding_digest,state,expires_at,decision_actor,created_at,updated_at)
            VALUES (?,?,'orchestrator','implementation',?,?,?,?,'approved',?,?,?,?)`).run(randomUUID(), ctx.run.id,
            canonicalJson(approvalPayload), hashBytes(canonicalJson(approvalPayload)), ctx.run.bindingDigest, ctx.run.bindingDigest,
            new Date(Date.parse(ctx.now) + ctx.run.binding.limits.maxActiveMs).toISOString(), owner.sessionId, ctx.now, ctx.now);
        }
        ctx.run.state = "approved";
        const eligibilityReason = this.eligibility(ctx);
        if (eligibilityReason) {
          ctx.run.state = "blocked";
          ctx.run.stateReason = eligibilityReason;
          return deny(eligibilityReason);
        }
        ctx.run.stateReason = null;
        // U6 — a run blocked because its lead failed is restarted by the same click. The lead
        // cannot wake itself, so Resume is what puts it back in the queue; the dispatcher then
        // gets it through `resumeTaskIds`, exactly as it gets any other pending task.
        this.reopenFailedLeadTask(ctx);
        return { status: "observed", value: { state: ctx.run.state, stateReason: ctx.run.stateReason,
          ...(required === "addMinutes" ? { addMinutes } : {}), ...(required === "addRetries" ? { addRetries } : {}),
          ...(required === "addReviewRounds" ? { addReviewRounds } : {}) },
          observedBy: owner.sessionId, effectMayStart: true, resumeTaskIds: this.pendingResumeTaskIds(ctx.run.id) };
      } else {
        const reason = this.eligibility(ctx);
        if (reason) return deny(reason);
        ctx.run.state = "blocked";
        ctx.run.stateReason = "owner-paused";
      }
      return { status: "observed", value: { state: ctx.run.state, stateReason: ctx.run.stateReason }, observedBy: owner.sessionId };
    });
  }

  taskForEdit(runId: string, taskId: string) {
    const run = this.getRun(runId);
    return { protocolVersion: TEAM_CONTROL_VERSION, runVersion: run.entityVersion, runState: run.state,
      task: readTaskEdit(this.db, runId, taskId), scope: this.scopeForTask(runId, taskId) };
  }

  editTask(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command("task.edited", raw, owner, ctx => {
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      if (ctx.run.state !== "approved") return deny("Run is closed to task edits");
      const task = this.findTask(ctx.run.id, ctx.request.actionId);
      if (!task) throw new Error("Task not found in this run");
      const result = applyTaskEdit(this.db, this.queue, ctx.run, ctx.request.actionId, ctx.request.payload, ctx.now, () => this.eligibility(ctx));
      if (result.status === "accepted" && result.value.classification === "plan-change-required") {
        ctx.run.state = "invalidated";
        ctx.run.stateReason = "plan-change-required";
        this.invalidateUnused(ctx);
      }
      return { ...result, taskId: ctx.request.actionId, observedBy: owner.sessionId };
    });
  }

  createTask(raw: ControlRequest<unknown>, currentBinding: unknown): ControlReceipt {
    return this.command("task.created", raw, null, ctx => {
      const reason = this.boundEligibility(ctx, currentBinding);
      return reason ? deny(reason) : this.writeTask(ctx);
    });
  }

  private writeTask(ctx: CommandContext): Result {
    const task = taskDefinition(ctx.run.binding, ctx.request.payload, ctx.request.actionId);
    return typeof task === "string" ? deny(task) : this.admitTask(ctx, task);
  }

  /**
   * C2 — the one admission write, for a definition the caller already validated.
   *
   * `createTask` and run growth both reach it through `writeTask`; the review loop reaches
   * it with a reviewer assignment it derived from the run's own records, so there is one
   * queue write and one authority row per task no matter which path admitted it.
   */
  private admitTask(ctx: CommandContext, task: Exclude<ReturnType<typeof taskDefinition>, string>): Result {
    const { assignment, outputs, permissions, sourceSession, destinationSession, body } = task;
    const count = this.db.prepare("SELECT count(*) AS count FROM team_queue_authority WHERE run_id=?")
      .get(ctx.run.id) as { count: number };
    if (count.count >= 100) return deny("Managed task limit reached");
    const created = withQueueWrite(this.db, { operation: "create" }, () => this.queue.createWithinTransaction({
      sourceSession, destinationSession, body, targetRepo: ctx.run.binding.repository.root, nudge: false }));
    ctx.register(created.persistedEvent);
    // U9 — the task's name, derived from the row it is admitted with: its own title, or for a
    // reviewer task the task it reviews. A body with nothing to name it by records none, and
    // the read model falls back to the task's order.
    const displayName = assignment.role === "reviewer" && assignment.reviewOf
      ? this.reviewDisplayName(ctx.run.id, assignment.reviewOf) : taskName(body);
    this.db.prepare(`INSERT INTO team_queue_authority
      (qitem_id,run_id,task_id,assignment_json,outputs_json,permissions_json,display_name) VALUES (?,?,?,?,?,?,?)`)
      .run(created.qitemId, ctx.run.id, assignment.taskId, canonicalJson(assignment), canonicalJson(outputs), canonicalJson(permissions), displayName);
    ensureSeatMailboxCapability(this.db, ctx.run.id, destinationSession, new Date(ctx.now));
    return { status: "accepted", value: this.getTask(created.qitemId), taskId: assignment.taskId };
  }

  /**
   * U9 — a reviewer task's name from the task it reviews.
   *
   * The reviewed task's stored name is preferred; a row recorded before names existed is named
   * from its body by the rule `admitTask` applies to a plain task. The round is the count of
   * the implementer's reviewer tasks plus this one, which is the same derivation `createReview`
   * uses for the reviewer task id.
   */
  private reviewDisplayName(runId: string, implementerTaskId: string): string {
    const row = this.db.prepare(`SELECT a.display_name AS displayName, q.body AS body
      FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
      WHERE a.run_id = ? AND a.task_id = ?`).get(runId, implementerTaskId) as
      { displayName: string | null; body: string | null } | undefined;
    const name = row?.displayName ?? taskName(row?.body ?? "") ?? "Task";
    return reviewName(name, this.reviewRounds(runId, implementerTaskId) + 1);
  }

  transitionTask(raw: ControlRequest<unknown>, currentBinding: unknown): ControlReceipt {
    return this.command("task.transitioned", raw, null, (ctx) => {
      const reason = this.boundEligibility(ctx, currentBinding);
      return reason ? deny(reason) : this.writeTaskTransition(ctx, null);
    });
  }

  /** Records an owner- or daemon-observed stopped outcome, without granting launch authority. */
  recordTaskOutcome(raw: ControlRequest<unknown>, actor: ControlActor): ControlReceipt {
    const observer = actorIdentity(actor, false, true);
    if (observer.kind !== "owner" && observer.kind !== "daemon") {
      throw new Error("An authenticated owner or daemon observation is required");
    }
    const observedBy = observer.kind === "daemon" ? "daemon" : observer.sessionId;
    return this.command("task.outcome", raw, observer, (ctx) => this.writeTaskTransition(ctx, observedBy));
  }

  /**
   * U7 — the daemon records a commit it landed on the run's integration branch.
   *
   * The commit is the run's delivery history, so it is recorded as one fact with the branch it
   * landed on, and the task's row is what says which work it carries. The only binding change
   * accepted here is the head the commit moved: everything the owner approved — the repository,
   * the plan path and its bytes, the scope, the roles and the limits — has to be identical, or
   * this is a different run's plan wearing this one's id.
   *
   * A moved head changes the binding digest, and every dispatch gate reads the implementation
   * grant under that digest. So the grant is reissued with the window the run already had: the
   * daemon advancing its own branch is not a reason for the team to stop working, and it grants
   * nothing the owner did not already approve.
   */
  recordIntegrationCommit(raw: ControlRequest<unknown>, actor: ControlActor): ControlReceipt {
    const daemon = actorIdentity(actor, false, true);
    if (daemon.kind !== "daemon") throw new Error("The daemon records integration commits");
    return this.command("task.integrated", raw, daemon, (ctx) => {
      const v = object(ctx.request.payload, "integrationCommit");
      const taskId = text(v.taskId, "integrationCommit.taskId");
      const task = this.findTask(ctx.run.id, taskId);
      if (!task || task.assignment.role !== "implementer") return deny("An integration commit names this run's implementer task");
      if (this.queueState(task.qitemId) !== "done") return deny("Only a completed task's work is integrated");
      const commitSha = text(v.commitSha, "integrationCommit.commitSha", 64);
      if (!/^[0-9a-f]{40,64}$/.test(commitSha)) throw new TeamContractError("integrationCommit.commitSha");
      const subject = text(v.subject, "integrationCommit.subject", 256);
      const branch = text(v.branch, "integrationCommit.branch", 256);
      const worktree = text(v.worktree, "integrationCommit.worktree", 4096);
      const repository = text(v.repository, "integrationCommit.repository", 4096);
      if (v.binding !== undefined && v.binding !== null) {
        const binding = parsePlanBinding(v.binding), current = ctx.run.binding;
        const unchanged = binding.repository.root === current.repository.root && binding.planRef === current.planRef
          && binding.planDigest === current.planDigest && binding.policyRevision === current.policyRevision
          && binding.policyFingerprint === current.policyFingerprint
          && canonicalJson(binding.readPaths) === canonicalJson(current.readPaths)
          && canonicalJson(binding.writePaths) === canonicalJson(current.writePaths)
          && canonicalJson(binding.roles) === canonicalJson(current.roles)
          && canonicalJson(binding.limits) === canonicalJson(current.limits);
        if (!unchanged) return deny("An integration commit preserves everything the owner approved");
        if (hashBinding(binding) !== ctx.run.bindingDigest) {
          const prior = this.db.prepare(`SELECT expires_at AS expiresAt FROM team_approvals
            WHERE run_id = ? AND kind = 'orchestrator' AND action = 'implementation' AND state = 'approved'
            ORDER BY rowid DESC LIMIT 1`).get(ctx.run.id) as { expiresAt: string } | undefined;
          this.invalidateUnused(ctx, false);
          ctx.run.binding = binding;
          ctx.run.bindingDigest = hashBinding(binding);
          if (prior) {
            const payload = { bindingDigest: ctx.run.bindingDigest };
            this.db.prepare(`INSERT INTO team_approvals
              (id,run_id,kind,action,payload_json,payload_digest,target_digest,binding_digest,state,expires_at,decision_actor,created_at,updated_at)
              VALUES (?,?,'orchestrator','implementation',?,?,?,?,'approved',?,?,?,?)`).run(randomUUID(), ctx.run.id,
              canonicalJson(payload), hashBytes(canonicalJson(payload)), ctx.run.bindingDigest, ctx.run.bindingDigest,
              prior.expiresAt, daemon.sessionId, ctx.now, ctx.now);
          }
        }
      }
      this.db.prepare(`UPDATE team_runs SET integration_branch = ?, integration_worktree = ?, integration_repository = ?
        WHERE id = ?`).run(branch, worktree, repository, ctx.run.id);
      this.db.prepare(`INSERT INTO team_integration_commits (run_id, task_id, commit_sha, subject, committed_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id, task_id) DO UPDATE SET commit_sha = excluded.commit_sha,
        subject = excluded.subject, committed_at = excluded.committed_at`)
        .run(ctx.run.id, taskId, commitSha, subject, ctx.now);
      return { status: "observed", value: { commitSha, subject, branch, worktree, repository }, taskId };
    });
  }

  private writeTaskTransition(ctx: CommandContext, observedBy: string | null): Result {
    const observedOutcome = observedBy !== null;
    const task = this.getTask(ctx.request.actionId);
    if (!task || task.runId !== ctx.run.id) throw new Error("Task not found in this run");
    const v = object(ctx.request.payload, "transition");
    if (integer(v.expectedTaskVersion, "expectedTaskVersion", 1) !== task.entityVersion) throw new Error("Task version conflict");
    if (!TEAM_QUEUE_STATES.includes(v.state as QueueState)) throw new TeamContractError("task.state");
    const item = this.queue.getById(task.qitemId);
    // U7 — one observed failure is decided after the task closed. A task's review approved its
    // work and the patch could not land on the run's integration branch: the work exists, it was
    // accepted, and what failed is delivering it. That is the run's own recorded fact, so the
    // closed row is reopened and closed as failed in this command rather than left saying done.
    const integrationConflict = observedOutcome && v.state === "failed" && item !== undefined
      && (v.evidence as JsonObject | undefined)?.reasonCode === "integration_conflict";
    const reopeningTerminal = integrationConflict && ["done", "handed-off"].includes(item!.state);
    if (!item || (!["pending", "in-progress", "blocked"].includes(item.state) && !reopeningTerminal)) {
      return deny("Task already has a terminal outcome; reopening requires an explicitly counted retry path");
    }
    if (!observedOutcome && !["pending", "in-progress", "blocked"].includes(v.state as string)) {
      return deny("Terminal task states require an owner-observed outcome; handoff requires a separate authority path");
    }
    let observedAttempt: TeamAttempt | null = null;
    if (observedOutcome) {
      if (!["done", "failed", "denied", "canceled"].includes(v.state as string)) return deny("Observation cannot start or reopen work");
      if (v.actorSession !== item.destinationSession) return deny("Observation must identify the task's assigned queue session");
      const attempt = this.getAttempt(text(v.attemptId, "attemptId", 256));
      observedAttempt = attempt;
      if (!attempt || attempt.runId !== ctx.run.id || attempt.qitemId !== task.qitemId || attempt.role !== task.assignment.role) {
        return deny("Observation requires an attempt belonging to this task and role");
      }
      if (integer(v.expectedAttemptVersion, "expectedAttemptVersion", 1) !== attempt.entityVersion) throw new Error("Attempt version conflict");
      if (attempt.state !== "stopped" || attempt.identity === null) return deny("Native termination has not been observed");
      const latest = this.db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1").get(task.qitemId) as { id: string };
      if (latest.id !== attempt.id || this.db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? AND state <> 'stopped' LIMIT 1").get(task.qitemId)
        || this.nativeLaunchIntents(ctx.run.id).some(intent => intent.qitemId === task.qitemId && intent.state === "admitted")) {
        return deny("All task attempts must be stopped and the outcome must belong to the latest attempt");
      }
      if (!Object.keys(object(v.evidence, "evidence")).length) throw new TeamContractError("evidence");
    }
    const optionalText = (key: string) => v[key] === undefined ? undefined : text(v[key], key);
    let transitionNote = optionalText("transitionNote");
    if (observedOutcome) {
      const observer = observedBy === "daemon" ? "Daemon" : "Owner";
      transitionNote = `${observer} observation of ${v.actorSession}${transitionNote ? `: ${transitionNote}` : ""}`;
    }
    // The dependency gate inside the queue write reads this row's evidence in the
    // same transaction, so outcome evidence must be durable BEFORE the state write.
    const evidence = v.evidence === undefined ? task.evidence : jsonValue(object(v.evidence, "evidence"));
    // C2 — a reviewer's completion is a review, not another reviewable candidate. Its
    // findings are validated before anything is written, so a P0/P1 with no failing scenario
    // refuses the whole outcome instead of recording a round nothing can act on. The verdict
    // itself is emitted with the rest of this command's writes, after the outcome is recorded.
    const review = observedOutcome && task.assignment.role === "reviewer" && v.state === "done"
      ? this.reviewOutcome(task, evidence as JsonObject | null) : null;
    if (typeof review === "string") return deny(review);
    const changed = this.db.prepare(`UPDATE team_queue_authority SET entity_version = entity_version + 1, evidence_json = ?
      WHERE qitem_id = ? AND entity_version = ?`).run(evidence === null ? null : canonicalJson(evidence), task.qitemId, task.entityVersion);
    if (changed.changes !== 1) throw new Error("Task version conflict");
    if (reopeningTerminal) {
      // Two writes, both in this command's transaction: the queue admits an active state from a
      // terminal row only through a deliberate reopen, and the failure is the close that follows.
      const reopened = withQueueWrite(this.db, { operation: "update", qitemId: task.qitemId }, () => this.queue.updateWithinTransaction({
        qitemId: task.qitemId, actorSession: observedBy ?? ctx.run.id, state: "pending", reopen: true,
        transitionNote: "The daemon delivers the approved work to the run's integration branch",
      }));
      for (const event of reopened.persistedEvents) ctx.register(event);
    }
    const updated = withQueueWrite(this.db, { operation: "update", qitemId: task.qitemId }, () => this.queue.updateWithinTransaction({ qitemId: task.qitemId, actorSession: observedBy ?? text(v.actorSession, "actorSession"),
      state: v.state as QueueState, transitionNote, closureReason: optionalText("closureReason"),
      closureTarget: optionalText("closureTarget"), blockedOn: optionalText("blockedOn") }));
    for (const event of updated.persistedEvents) ctx.register(event);
    // KTD3 — "failed with the classifier's code, which routes to one retry and then to the lead".
    // The daemon's own observation spends the run's retry budget; an owner who records a failure
    // has the explicit retry command instead. A lead cannot wake itself, so a lead failure the
    // run will not retry — because the classifier forbids it, or because the budget is spent —
    // leaves the run blocked with a reason Resume handles, never sitting failed and silent: the
    // live acceptance run sat in exactly that state for an hour and a half.
    if (observedOutcome && observedBy === "daemon" && v.state === "failed") {
      const retryable = observedAttempt?.failure?.retryEligible === true;
      if (retryable && observedAttempt !== null && ctx.run.retriesUsed < ctx.run.binding.limits.maxRetries) {
        ctx.run.retriesUsed += 1;
        const retried = withQueueWrite(this.db, { operation: "update", qitemId: task.qitemId }, () => this.queue.updateWithinTransaction({
          qitemId: task.qitemId, actorSession: ctx.run.id, state: "pending",
          transitionNote: `Daemon counted retry of ${observedAttempt.id}`,
        }));
        for (const event of retried.persistedEvents) ctx.register(event);
      } else if (task.assignment.role === "lead") {
        this.block(ctx, retryable ? "retry limit exhausted" : LEAD_FAILED_REASON);
      }
    }
    // C2 — an implementer that completed with validated evidence gets its review task now,
    // through the same admission path a start and a run growth use. A run that named no
    // reviewer seat keeps the pre-C2 behaviour: the completion stands and no review exists,
    // and so does a refusal the loop itself decided (no second seat to route to).
    if (observedOutcome && task.assignment.role === "implementer" && v.state === "done"
      && (evidence as JsonObject | null)?.validated === true) {
      const review = this.createReview(ctx, this.getTask(task.qitemId)!);
      if (typeof review === "string") {
        // A run-level refusal: the binding's `maxReviewRounds` covers no further round, so
        // the completion that would start one is denied rather than recorded without it.
        if (review === "review limit exhausted") return deny(review);
      } else {
        return { status: "observed", value: { ...this.getTask(task.qitemId), review }, taskId: task.assignment.taskId,
          attemptId: v.attemptId as string, observedBy: observedBy ?? undefined, effectMayStart: true, reviewTaskId: review.reviewerTaskId };
      }
    }
    // A completed review is recorded and then acted on: an approving round closes the task,
    // and a cited P0/P1 reopens it for rework. The round was charged when its reviewer task
    // was admitted, so nothing here spends the counter twice.
    if (review) {
      this.emit(ctx.run, ctx.register, "review.verdict", jsonValue(review.record) as JsonObject, review.record.taskId);
      if (review.record.verdict === "approved") {
        return { status: "observed", value: { ...this.getTask(task.qitemId), review: review.record },
          taskId: task.assignment.taskId, attemptId: v.attemptId as string, observedBy: observedBy ?? undefined };
      }
      const rework = this.startRework(ctx, review.record);
      if (typeof rework === "string") return deny(rework);
      return { status: "observed", value: { ...this.getTask(task.qitemId), review: review.record },
        taskId: task.assignment.taskId, attemptId: v.attemptId as string, observedBy: observedBy ?? undefined,
        effectMayStart: true, reworkTaskId: review.record.taskId };
    }
    return { status: observedOutcome ? "observed" : "accepted", value: this.getTask(task.qitemId), taskId: task.assignment.taskId,
      attemptId: observedOutcome ? v.attemptId as string : undefined, observedBy: observedBy ?? undefined };
  }

  /**
   * C2 — what a completed reviewer task's evidence says about the implementer it names.
   *
   * The reviewer task is the run's own row, so the implementer it reviews comes from that
   * row's `reviewOf` link, never from the request. Returns the round it will record, or the
   * reason it refused; a refusal is decided before any write, so a refused review leaves the
   * reviewer task pending rather than closing it with findings nobody could act on.
   */
  private reviewOutcome(reviewer: TeamTaskAuthority, evidence: JsonObject | null): { record: ReviewOutcome } | string {
    const reviewedTaskId = reviewer.assignment.reviewOf;
    if (reviewedTaskId === undefined) return "A reviewer task must name the task it reviews";
    const implementer = this.findTask(reviewer.runId, reviewedTaskId);
    if (!implementer || implementer.assignment.role !== "implementer") return "A review must name this run's implementer task";
    let findings: ReviewFinding[];
    try { findings = recordedFindings(evidence ?? {}); }
    catch (error) { return (error as Error).message; }
    const round = this.reviewRound(reviewer.runId, reviewedTaskId) + 1;
    const record: ReviewOutcome = { taskId: reviewedTaskId, reviewerTaskId: reviewer.assignment.taskId, round,
      candidateDigest: typeof evidence?.manifestDigest === "string" ? evidence.manifestDigest : null,
      verdict: reviewVerdict(findings), findings, recordedAt: this.clock().toISOString() };
    // A blocking review reopens the implementer, so its precondition is checked here — before
    // any write — rather than left to fail after the reviewer task was already recorded done.
    if (record.verdict === "changes-required") {
      const state = this.queue.getById(implementer.qitemId)?.state;
      if (state !== "done" && state !== "handed-off") return "The reviewed task is not a completed task";
    }
    return { record };
  }

  /** C2 — how many review rounds the durable log already holds for one implementer task. */
  private reviewRound(runId: string, taskId: string): number {
    const row = this.db.prepare(`SELECT count(*) AS count FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.taskId') = ?
      AND json_extract(payload, '$.action') = 'review.verdict'`).get(runId, taskId) as { count: number };
    return row.count;
  }

  /**
   * C2 — send a reviewed implementer task back for rework.
   *
   * The round was charged to `review_rounds_used` when the run admitted its reviewer task, so
   * this only reopens the implementer's terminal queue row. A review with no blocking finding
   * never reaches here; the caller closes the task instead.
   */
  private startRework(ctx: CommandContext, record: ReviewOutcome): { effectMayStart: boolean } | string {
    const task = this.findTask(ctx.run.id, record.taskId)!;
    const item = this.queue.getById(task.qitemId);
    // Only a task the run recorded as completed is reviewable, and only a closure the queue
    // guards (`done`, `handed-off`) reopens — deliberately, and with the reason it reopens for.
    if (!item || (item.state !== "done" && item.state !== "handed-off")) return "The reviewed task is not a completed task";
    const updated = withQueueWrite(this.db, { operation: "update", qitemId: task.qitemId }, () => this.queue.updateWithinTransaction({
      qitemId: task.qitemId, actorSession: ctx.run.id, state: "pending", reopen: true,
      transitionNote: `Review round ${record.round} returned ${blockingFindings(record.findings).length} blocking finding(s)`,
    }));
    for (const event of updated.persistedEvents) ctx.register(event);
    return { effectMayStart: true };
  }

  /**
   * C2 — create the reviewer task for an implementer that just completed with validated
   * evidence.
   *
   * Runs inside the outcome command, so the implementer's `done` and the reviewer task commit
   * together. A run that named no reviewer seat keeps the pre-C2 behaviour: the completion
   * stands and no review is created. The round is derived from the run's own recorded
   * reviewer tasks, so a replayed completion finds the task it already admitted instead of
   * creating a second one. Returns the reviewer task id, which the route dispatches to that
   * seat, or the reason nothing was created.
   *
   * `maxReviewRounds` is a per-task allowance: the plan's Review convergence gives "each task
   * two review rounds, counted across all of its slices and runs", so one task's spent rounds
   * never take another task's away. The run's `review_rounds_used` still records the total,
   * which is what the owner read publishes.
   */
  private createReview(ctx: CommandContext, implementer: TeamTaskAuthority): { reviewerTaskId: string; round: number } | string {
    const seat = ctx.run.reviewerSeat;
    if (seat === null) return "No reviewer seat is recorded for this run";
    const implementerSeat = this.queue.getById(implementer.qitemId)?.destinationSession;
    if (!implementerSeat || implementerSeat === seat) return "The reviewer seat must differ from the implementer's seat";
    const spent = this.reviewRounds(ctx.run.id, implementer.assignment.taskId);
    if (spent >= ctx.run.binding.limits.maxReviewRounds) {
      this.block(ctx, "review limit exhausted");
      return "review limit exhausted";
    }
    const round = spent + 1;
    const taskId = reviewerTaskId(implementer.assignment.taskId, round);
    if (this.findTask(ctx.run.id, taskId)) return { reviewerTaskId: taskId, round };
    const assignment = { taskId, role: "reviewer" as const, reviewOf: implementer.assignment.taskId,
      paths: [...implementer.assignment.paths], dependencies: [] };
    const task = taskDefinition(ctx.run.binding, { assignment, outputs: [], permissions: [...roleConfiguration.reviewer.permissions],
      sourceSession: implementer.assignment.taskId, destinationSession: seat,
      body: reviewBody({ implementerTaskId: implementer.assignment.taskId, round,
        candidateDigest: typeof implementer.evidence?.manifestDigest === "string" ? implementer.evidence.manifestDigest : null }) },
      taskId);
    if (typeof task === "string") return task;
    const written = this.admitTask(ctx, task);
    if (written.status !== "accepted") return written.reason ?? "The reviewer task was refused";
    ctx.run.reviewRoundsUsed += 1;
    return { reviewerTaskId: taskId, round };
  }

  /** C2 — how many reviewer tasks the run has admitted for one implementer, from its own rows. */
  private reviewRounds(runId: string, implementerTaskId: string): number {
    const row = this.db.prepare(`SELECT count(*) AS count FROM team_queue_authority WHERE run_id = ?
      AND json_extract(assignment_json, '$.role') = 'reviewer'
      AND json_extract(assignment_json, '$.reviewOf') = ?`).get(runId, implementerTaskId) as { count: number };
    return row.count;
  }

  recordAttempt(raw: ControlRequest<unknown>, currentBinding: unknown): ControlReceipt {
    return this.recordAttemptCommand(raw, currentBinding, null);
  }

  /** Control-only admission. A durable intent is not a claimed native session. */
  admitNativeAttempt(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown): ControlReceipt {
    return this.recordAttemptCommand(raw, currentBinding, actorIdentity(actor, true));
  }

  private recordAttemptCommand(raw: ControlRequest<unknown>, currentBinding: unknown, owner: ControlActor | null): ControlReceipt {
    return this.command(owner ? "attempt.admitted" : "attempt.recorded", raw, owner, (ctx) => {
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      // An intent keeps its original run owner even when no native row was created.
      if (this.db.prepare(`SELECT seq FROM events WHERE type = 'team.control'
        AND json_extract(payload, '$.action') = 'attempt.launch-intent' AND json_extract(payload, '$.attemptId') = ?
        AND json_extract(payload, '$.runId') <> ? LIMIT 1`).get(ctx.request.actionId, ctx.run.id)) return deny("Native launch identity is already reserved");
      const intent = owner ? this.prepareNativeLaunchIntent(ctx) : null;
      if (typeof intent === "string") return deny(intent);
      const unavailable = { value: null, reason: "Native usage has not been observed" };
      const v = intent ? { role: intent.role, provider: intent.provider, qitemId: intent.qitemId, identity: null,
        state: "unknown", unknownReason: "Native launch is unresolved",
        usage: { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable } }
        : object(ctx.request.payload, "attempt");
      const state = attemptState(v.state);
      const role = text(v.role, "role");
      if (!ctx.run.binding.roles.some((allowed) => allowed === role)) return deny("Attempt role is outside the binding");
      if (v.provider !== "claude" && v.provider !== "codex") throw new TeamContractError("provider");
      const identity = v.identity === null ? null : parseAttemptIdentity(v.identity);
      const unknownReason = state === "unknown" ? text(v.unknownReason, "unknownReason") : null;
      if (state !== "unknown" && (identity === null || v.unknownReason !== null)) throw new TeamContractError("attempt.identity");
      if (identity !== null && identity.policyFingerprint !== ctx.run.binding.policyFingerprint) return deny("Attempt policy differs from the binding");
      const qitemId = v.qitemId === null ? null : text(v.qitemId, "qitemId", 256);
      const task = qitemId === null ? null : this.getTask(qitemId);
      if (qitemId !== null && task?.runId !== ctx.run.id) throw new Error("Task not found in this run");
      if (task && task.assignment.role !== role) return deny("Attempt role differs from its task assignment");
      const item = role === "lead" && qitemId !== null ? this.queue.getById(qitemId) : null;
      if (role === "lead" && qitemId !== null && (!item || item.sourceSession === item.destinationSession)) return deny("Lead wake originates from itself");
      const usage = parseUsage(v.usage);
      if (usage.activeMs !== 0) {
        const reason = "Initial attempt registration must precede work; elapsed intervals require reconciliation";
        this.block(ctx, reason);
        return { status: "denied", reason, value: { reportedUsage: usage } };
      }
      const live = this.liveAttemptCount(ctx.run.id);
      if ((state === "running" || intent) && live >= ctx.run.binding.limits.maxSessions) return deny("Live session limit reached");
      const policy = new LeadWakePolicy(this.db, this.events);
      const wake = role === "lead" ? policy.check(ctx.run, qitemId, ctx.now) : null;
      if (wake?.reason) {
        policy.pause(ctx.run, wake.reason, ctx.now); policy.save(ctx.run, wake.state, ctx.register);
        return deny(wake.reason);
      }
      if (wake) policy.resume(ctx.run);
      const reason = this.eligibility(ctx);
      if (reason) return deny(reason);
      if (wake) policy.record(ctx.run, qitemId, ctx.now, wake, ctx.register);
      if (intent) {
        // Persist before command() synchronizes the active clock; a later response alone is too late.
        this.emit(ctx.run, ctx.register, "attempt.launch-intent", jsonValue(intent) as JsonObject, task!.assignment.taskId, intent.attemptId);
        return { status: "pending-execution", effectMayStart: true, value: intent,
          taskId: task!.assignment.taskId, attemptId: intent.attemptId, observedBy: owner!.sessionId };
      }
      this.db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason,
        state, usage_json, active_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ctx.request.actionId, ctx.run.id, qitemId, role, v.provider, identity === null ? null : canonicalJson(identity),
          unknownReason, state, canonicalJson(usage), usage.activeMs, ctx.now, ctx.now);
      return { status: "observed", value: this.getAttempt(ctx.request.actionId), attemptId: ctx.request.actionId };
    });
  }


  private prepareNativeLaunchIntent(ctx: CommandContext): NativeLaunchIntent | string {
    const v = object(ctx.request.payload, "nativeLaunch"), qitemId = text(v.qitemId, "qitemId", 256);
    const task = this.getTask(qitemId), item = this.queue.getById(qitemId);
    if (!task || task.runId !== ctx.run.id || !item) throw new Error("Task not found in this run");
    if (integer(v.expectedTaskVersion, "expectedTaskVersion", 1) !== task.entityVersion) throw new Error("Task version conflict");
    const sessionId = text(v.sessionId, "sessionId", 256), commandDigest = digest(v.commandDigest, "commandDigest");
    const command = v.command === undefined ? undefined : jsonValue(object(v.command, "nativeLaunch.command")) as JsonObject;
    if (command !== undefined) {
      const bytes = canonicalJson(command);
      if (Buffer.byteLength(bytes, "utf8") > 65_536 || hashBytes(bytes) !== commandDigest) throw new TeamContractError("nativeLaunch.command");
    }
    if (v.provider !== "claude" && v.provider !== "codex") throw new TeamContractError("provider");
    if (sessionId !== item.destinationSession || !["pending", "in-progress"].includes(item.state)) return "Native launch task/session is not dispatchable";
    if (this.db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? AND state <> 'stopped' LIMIT 1").get(qitemId)) {
      return "Task already has an unresolved native attempt";
    }
    const previousId = v.previousAttemptId === null ? null : text(v.previousAttemptId, "previousAttemptId", 256);
    const previous = previousId === null ? null : this.getAttempt(previousId);
    if (previousId !== null && (!previous || previous.runId !== ctx.run.id || previous.qitemId !== qitemId
      || previous.role !== task.assignment.role || previous.provider !== v.provider || previous.state !== "stopped" || !previous.identity)) {
      return "Exact resume requires an observed stopped attempt for this task and provider";
    }
    if (previous ? integer(v.expectedPreviousVersion, "expectedPreviousVersion", 1) !== previous.entityVersion : v.expectedPreviousVersion !== null) {
      throw new Error("Previous attempt version conflict");
    }
    const prior = this.getNativeLaunchIntent(ctx.run.id, ctx.request.actionId);
    const generation = previous?.identity ? integer(previous.identity.generation + 1, "generation", 1) : 1;
    if ((this.getAttempt(ctx.request.actionId) || prior) && previous?.id !== ctx.request.actionId
      || prior && (prior.state === "admitted" || prior.generation >= generation)) return "Native launch identity is already reserved";
    return { attemptId: ctx.request.actionId, commandDigest, ...(command === undefined ? {} : { command }),
      bindingDigest: ctx.run.bindingDigest, policyFingerprint: ctx.run.binding.policyFingerprint, qitemId,
      taskVersion: task.entityVersion, sessionId, role: task.assignment.role, provider: v.provider, generation,
      previous: previous?.identity ? { attemptId: previous.id, identity: previous.identity, version: previous.entityVersion } : null,
      state: "admitted" };
  }


  /** Observations never mint another launch grant, including after cancellation. */
  reconcileNativeAttempt(raw: ControlRequest<unknown>, actor: ControlActor, currentBinding: unknown): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command("attempt.reconciled", raw, owner, ctx => {
      const v = object(ctx.request.payload, "nativeObservation"), intent = this.getNativeLaunchIntent(ctx.run.id, ctx.request.actionId);
      if (!intent || intent.commandDigest !== digest(v.commandDigest, "commandDigest")) return deny("Native observation has no matching command intent");
      if (v.outcome !== "running" && v.outcome !== "stopped" && v.outcome !== "not_started") throw new TeamContractError("nativeObservation.outcome");
      const evidenceRef = text(v.evidenceRef, "evidenceRef", 4096), attempt = this.getAttempt(intent.attemptId);
      if (attempt ? integer(v.expectedAttemptVersion, "expectedAttemptVersion", 1) !== attempt.entityVersion : v.expectedAttemptVersion !== null) {
        throw new Error("Attempt version conflict");
      }
      const sameAttemptResume = intent.previous?.attemptId === intent.attemptId;
      if (attempt && (attempt.runId !== ctx.run.id || attempt.qitemId !== intent.qitemId
        || attempt.role !== intent.role || attempt.provider !== intent.provider)) return deny("Native attempt scope differs from its intent");
      if (intent.state === "admitted") {
        if (sameAttemptResume ? !attempt || attempt.state !== "stopped"
          || canonicalJson(attempt.identity) !== canonicalJson(intent.previous!.identity) : attempt !== null) {
          return deny("The admitted native generation no longer matches its prior state");
        }
      } else if (!attempt || intent.state === "not_started") return deny("Native command intent is already closed");
      const task = this.getTask(intent.qitemId), item = this.queue.getById(intent.qitemId);
      if (!task || task.runId !== ctx.run.id) return deny("Native task scope is unavailable");
      if (v.outcome === "not_started") {
        if (intent.state !== "admitted" || v.identity !== null) return deny("No-start requires an unresolved command with no observed identity");
      } else {
        const identity = parseAttemptIdentity(v.identity);
        if (identity.policyFingerprint !== intent.policyFingerprint || identity.generation !== intent.generation
          || intent.previous && (identity.nativeSessionId !== intent.previous.identity.nativeSessionId
            || identity.processId === intent.previous.identity.processId && identity.processStart === intent.previous.identity.processStart)) {
          return deny("Observed native identity differs from the admitted generation");
        }
        if (intent.state !== "admitted" && canonicalJson(attempt!.identity) !== canonicalJson(identity)) return deny("Observed native identity changed");
        if (v.outcome === "running") {
          if (intent.state !== "admitted" && attempt!.state === "stopped") return deny("Continuation requires a newly admitted native generation");
          const reason = this.boundEligibility(ctx, currentBinding, intent.attemptId);
          if (reason) return deny(reason);
          if (intent.bindingDigest !== ctx.run.bindingDigest || !item || item.destinationSession !== intent.sessionId
            || !["pending", "in-progress"].includes(item.state) || task.assignment.role !== intent.role
            || intent.state === "admitted" && task.entityVersion !== intent.taskVersion) return deny("Native task/session binding changed");
          if (this.liveAttemptCount(ctx.run.id) > ctx.run.binding.limits.maxSessions) return deny("Live session limit reached");
        }
        if (attempt) {
          this.db.prepare(`UPDATE team_attempts SET identity_json = ?, state = ?, unknown_reason = NULL,
            entity_version = entity_version + 1, updated_at = ? WHERE id = ? AND entity_version = ?`)
            .run(canonicalJson(identity), v.outcome, ctx.now, attempt.id, attempt.entityVersion);
        } else {
          const unavailable = { value: null, reason: "Native usage has not been observed" };
          const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };
          this.db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason,
            state, usage_json, active_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?)`)
            .run(intent.attemptId, ctx.run.id, intent.qitemId, intent.role, intent.provider, canonicalJson(identity), v.outcome,
              canonicalJson(usage), ctx.now, ctx.now);
        }
      }
      const observed: NativeLaunchIntent = { ...intent, state: v.outcome, evidenceRef };
      this.emit(ctx.run, ctx.register, "attempt.launch-intent", jsonValue(observed) as JsonObject, task.assignment.taskId, intent.attemptId);
      return { status: "observed", value: { intent: observed, attempt: this.getAttempt(intent.attemptId) },
        taskId: task.assignment.taskId, attemptId: intent.attemptId, observedBy: owner.sessionId };
    });
  }

  recordUsage(raw: ControlRequest<unknown>): ControlReceipt {
    return this.command("attempt.observed", raw, null, (ctx) => {
      const attempt = this.getAttempt(ctx.request.actionId);
      if (!attempt || attempt.runId !== ctx.run.id) throw new Error("Attempt not found in this run");
      const v = object(ctx.request.payload, "usageObservation");
      if (integer(v.expectedAttemptVersion, "expectedAttemptVersion", 1) !== attempt.entityVersion) throw new Error("Attempt version conflict");
      const state = attemptState(v.state);
      if ((attempt.state === "stopped" && state !== "stopped") || (attempt.state === "unknown" && state === "running")) return deny("Continuation requires native identity reconciliation");
      if (state !== "unknown" && attempt.identity === null) return deny("A known native identity is required for an observed stopped outcome");
      const usage = parseUsage(v.usage);
      if (usage.activeMs < attempt.usage.activeMs) throw new Error("Cumulative attempt usage must not decrease");
      for (const key of ["inputTokens", "outputTokens", "costUsd"] as const) {
        const previous = attempt.usage[key].value;
        if (previous !== null && (usage[key].value === null || usage[key].value! < previous)) throw new Error("Cumulative usage evidence must not decrease or disappear");
      }
      const unknownReason = state === "unknown" ? text(v.unknownReason, "unknownReason") : null;
      // T033 — the classifier's decision travels with the stop, so a reader never re-derives it.
      // It is accepted only on a stopped attempt, and only in the shape its own code implies:
      // a stored `retryEligible` that disagrees with KTD20 would be authority this command does
      // not have. The observation owner classifies; this command records what it said.
      const failure = state !== "stopped" || v.failure === undefined || v.failure === null
        ? null : parseAttemptClassification(v.failure);
      this.db.prepare(`UPDATE team_attempts SET state = ?, unknown_reason = ?, usage_json = ?, active_ms = ?,
        failure_json = ?, entity_version = entity_version + 1, updated_at = ? WHERE id = ? AND entity_version = ?`)
        .run(state, unknownReason, canonicalJson(usage), usage.activeMs, failure === null ? null : canonicalJson(failure),
          ctx.now, attempt.id, attempt.entityVersion);
      return { status: "observed", value: this.getAttempt(attempt.id), attemptId: attempt.id };
    });
  }

  recordCycle(raw: ControlRequest<unknown>, currentBinding: unknown): ControlReceipt {
    return this.command("cycle.recorded", raw, null, (ctx) => {
      const reason = this.boundEligibility(ctx, currentBinding);
      if (reason) return deny(reason);
      const v = object(ctx.request.payload, "cycle");
      text(v.reason, "cycle.reason");
      if (v.kind !== "retry" && v.kind !== "review") throw new TeamContractError("cycle.kind");
      const key = v.kind === "retry" ? "retriesUsed" : "reviewRoundsUsed";
      const limit = v.kind === "retry" ? ctx.run.binding.limits.maxRetries : ctx.run.binding.limits.maxReviewRounds;
      if (ctx.run[key] >= limit) {
        this.block(ctx, `${v.kind} limit exhausted`);
        return deny(`${v.kind} limit exhausted`);
      }
      ctx.run[key] += 1;
      return { status: "accepted", value: { kind: v.kind, used: ctx.run[key], reason: v.reason } };
    });
  }

  reserveApproval(raw: ControlRequest<unknown>, currentBinding: unknown): ControlReceipt {
    return this.command("approval.reserved", raw, null, (ctx) => {
      const reason = this.boundEligibility(ctx, currentBinding);
      if (reason) return deny(reason);
      const v = object(ctx.request.payload, "consumption");
      const approval = this.getApproval(ctx.request.actionId);
      if (!approval || approval.runId !== ctx.run.id) throw new Error("Approval not found in this run");
      if (approval.kind === "native") return deny("A native prompt is a configuration fault, not an owner approval action");
      // A mismatched kind is a denied claim, not authority to reinterpret it.
      if (v.kind !== approval.kind || v.action !== approval.action || v.targetDigest !== approval.targetDigest
        || hashBytes(canonicalJson(v.payload)) !== approval.payloadDigest || approval.bindingDigest !== ctx.run.bindingDigest) return deny("Approval does not match the exact operation");
      if (approval.action === "implementation") return deny("A plan grant is scope authority, not a one-shot operation grant");
      if (isEscalation(approval) || approval.action === "scope-extension") return deny("Scope and limit decisions do not authorize a process effect or mutate the run binding");
      if (approval.state !== "approved") return deny("Operation approval is not active");
      const attempt = this.getAttempt(text(v.attemptId, "attemptId", 256));
      if (!attempt || attempt.runId !== ctx.run.id || attempt.state !== "running" || attempt.identity === null) return deny("Operation requires the recorded active attempt");
      if (this.getConsumption(approval.id)) return deny("Operation was already reserved; reconcile its observed outcome");
      this.db.prepare(`INSERT INTO team_approval_consumptions (approval_id, run_id, attempt_id, state, created_at, updated_at)
        VALUES (?, ?, ?, 'reserved', ?, ?)`).run(approval.id, ctx.run.id, attempt.id, ctx.now, ctx.now);
      return { status: "pending-execution", value: this.getConsumption(approval.id), effectMayStart: true, attemptId: attempt.id };
    });
  }

  recordOutcome(raw: ControlRequest<unknown>): ControlReceipt {
    return this.command("approval.outcome", raw, null, (ctx) => {
      const consumption = this.getConsumption(ctx.request.actionId);
      if (!consumption || consumption.runId !== ctx.run.id) throw new Error("Consumption not found in this run");
      const v = object(ctx.request.payload, "outcome");
      if (v.state !== "confirmed" && v.state !== "ambiguous") throw new TeamContractError("outcome.state");
      const receipt = object(v.receipt, "outcome.receipt");
      if (!Object.keys(receipt).length) throw new TeamContractError("outcome.receipt");
      if (consumption.state !== "reserved") return deny("Outcome is already recorded; reconciliation is required");
      this.db.prepare(`UPDATE team_approval_consumptions SET state = ?, receipt_json = ?, updated_at = ? WHERE approval_id = ?`)
        .run(v.state, canonicalJson(receipt), ctx.now, consumption.approvalId);
      return { status: "observed", value: this.getConsumption(consumption.approvalId), attemptId: consumption.attemptId };
    });
  }

  private assertStandalone(): void {
    if (this.db.inTransaction) throw new Error("Governance must own the outer transaction before notifying subscribers");
  }

  private command(action: string, raw: ControlRequest<unknown>, actor: ControlActor | null, apply: (ctx: CommandContext) => Result): ControlReceipt {
    this.assertStandalone();
    const request = parseControlRequest(raw);
    const requestDigest = hashBytes(canonicalJson({ action, actor, request }));
    return this.events.withNotifyEnvelope((register) => {
      const prior = this.db.prepare("SELECT request_digest, response_json FROM team_control_requests WHERE run_id = ? AND idempotency_key = ?")
        .get(request.runId, request.idempotencyKey) as { request_digest: string; response_json: string } | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new Error("Control idempotency key is bound to another exact request");
        return { ...JSON.parse(prior.response_json) as ControlReceipt, replayed: true, effectMayStart: false };
      }
      const run = this.getRun(request.runId);
      if (run.entityVersion !== request.expectedEntityVersion) throw new Error("Run entity version conflict");
      run.entityVersion += 1;
      const ctx: CommandContext = { request, run, now: this.clock().toISOString(), register };
      this.expireApprovals(ctx);
      this.accountClock(ctx);
      const result = apply(ctx);
      this.syncClock(ctx);
      const changed = this.db.prepare(`UPDATE team_runs SET state = ?, state_reason = ?, phase = ?, entity_version = ?, active_ms = ?,
        accounted_at = ?, retries_used = ?, review_rounds_used = ?, updated_at = ?, binding_json = ?, binding_digest = ?
        WHERE id = ? AND entity_version = ?`)
        .run(run.state, run.stateReason, run.phase, run.entityVersion, run.activeMs, run.accountedAt, run.retriesUsed,
          run.reviewRoundsUsed, ctx.now, canonicalJson(run.binding), run.bindingDigest, run.id, request.expectedEntityVersion);
      if (changed.changes !== 1) throw new Error("Run entity version conflict");
      const value = result.value === undefined ? null : jsonValue(result.value);
      const receipt: ControlReceipt = { status: result.status, runId: run.id, entityVersion: run.entityVersion,
        replayed: false, effectMayStart: result.effectMayStart ?? false, value,
        ...(result.reworkTaskId === undefined ? {} : { reworkTaskId: result.reworkTaskId }),
        ...(result.reviewTaskId === undefined ? {} : { reviewTaskId: result.reviewTaskId }),
        ...(result.revisionTaskId === undefined ? {} : { revisionTaskId: result.revisionTaskId }),
        ...(result.resumeTaskIds === undefined ? {} : { resumeTaskIds: result.resumeTaskIds }),
        reason: result.reason ?? null, reasonKey: teamReasonLabelKey(result.reason ?? null) };
      this.db.prepare(`INSERT INTO team_control_requests (run_id, idempotency_key, request_digest, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(run.id, request.idempotencyKey, requestDigest, canonicalJson(receipt), ctx.now);
      this.emit(run, register, result.status === "denied" ? `${action}.denied` : action,
        { actionId: request.actionId, status: receipt.status, reason: receipt.reason, valueDigest: hashBytes(canonicalJson(value)),
          ...(result.observedBy === undefined ? {} : { observedBy: result.observedBy }) }, result.taskId, result.attemptId);
      return { ...receipt, ...(result.reworkTaskId === undefined ? {} : { reworkTaskId: result.reworkTaskId }),
        ...(result.reviewTaskId === undefined ? {} : { reviewTaskId: result.reviewTaskId }),
        ...(result.revisionTaskId === undefined ? {} : { revisionTaskId: result.revisionTaskId }),
        ...(result.resumeTaskIds === undefined ? {} : { resumeTaskIds: result.resumeTaskIds }) };
    });
  }

  private emit(run: TeamRun, register: NotifyRegister, action: string, payload: JsonObject, taskId?: string, attemptId?: string): void {
    register(this.events.persistWithinTransaction(parseTeamEvent({ type: "team.control", protocolVersion: TEAM_CONTROL_VERSION,
      eventId: randomUUID(), rigId: run.rigId, runId: run.id, taskId: taskId ?? null, attemptId: attemptId ?? null,
      entityId: run.id, entityVersion: run.entityVersion, action, payload })));
  }

  private reconcile(ctx: CommandContext, currentBinding: unknown): boolean {
    let matches = false;
    try { matches = hashBinding(currentBinding) === ctx.run.bindingDigest; }
    catch (error) { if (!(error instanceof TeamContractError)) throw error; }
    if (matches) return true;
    if (ctx.run.state !== "cancel_requested") {
      ctx.run.state = "invalidated";
      ctx.run.stateReason = "Plan, repository or policy binding changed";
    }
    this.invalidateUnused(ctx);
    return false;
  }

  private boundEligibility(ctx: CommandContext, currentBinding: unknown, reconcilingAttemptId?: string): string | null {
    return this.reconcile(ctx, currentBinding) ? this.eligibility(ctx, reconcilingAttemptId) : "Plan, repository or policy binding changed";
  }

  private eligibility(ctx: Pick<CommandContext, "run" | "now">, reconcilingAttemptId?: string): string | null {
    if (ctx.run.state !== "approved") return `Run is closed to dispatch (${ctx.run.state})`;
    if (!this.db.prepare(`SELECT id FROM team_approvals WHERE run_id = ? AND kind = 'orchestrator' AND action = 'implementation'
      AND binding_digest = ? AND state = 'approved' AND expires_at > ?`).get(ctx.run.id, ctx.run.bindingDigest, ctx.now)) return "Implementation approval is not active";
    if (this.db.prepare("SELECT id FROM team_attempts WHERE run_id = ? AND state = 'unknown' AND id <> ? LIMIT 1").get(ctx.run.id, reconcilingAttemptId ?? "")) return "Native identity is unknown; reconciliation is required";
    if (this.nativeLaunchIntents(ctx.run.id).some(intent => intent.state === "admitted" && intent.attemptId !== reconcilingAttemptId)) return "Native launch is unresolved; reconciliation is required";
    try {
      const capability = this.readPolicyCapability?.();
      if (!capability || capability.policyRevision !== ctx.run.binding.policyRevision
        || capability.policyFingerprint !== ctx.run.binding.policyFingerprint
        || !["claude", "codex"].every(provider => capability.verifiedProviders.includes(provider as "claude" | "codex"))) {
        return "Provider policy capability is not verified for the current binding";
      }
    } catch {
      return "Provider policy capability is not verified for the current binding";
    }
    return null;
  }

  private invalidateUnused(ctx: CommandContext, preserveEscalations = false, exceptApprovalId = ""): void {
    this.db.prepare(`UPDATE team_approvals SET state = 'invalidated', entity_version = entity_version + 1, updated_at = ?
      WHERE run_id = ? AND id <> ? AND state IN ('pending', 'approved') AND NOT EXISTS
        (SELECT 1 FROM team_approval_consumptions c WHERE c.approval_id = team_approvals.id)
        AND (? = 0 OR kind <> 'orchestrator' OR action NOT IN ('scope-change', 'limit-increase'))`)
      .run(ctx.now, ctx.run.id, exceptApprovalId, preserveEscalations ? 1 : 0);
  }

  private expireApprovals(ctx: CommandContext): void {
    const result = this.db.prepare(`UPDATE team_approvals SET state = 'expired', entity_version = entity_version + 1, updated_at = ?
      WHERE run_id = ? AND state IN ('pending', 'approved') AND expires_at <= ? AND NOT EXISTS
        (SELECT 1 FROM team_approval_consumptions c WHERE c.approval_id = team_approvals.id)`).run(ctx.now, ctx.run.id, ctx.now);
    if (result.changes) this.emit(ctx.run, ctx.register, "approvals.expired", { count: result.changes });
  }

  private block(ctx: CommandContext, reason: string): void {
    if (ctx.run.state !== "cancel_requested" && ctx.run.state !== "invalidated") {
      ctx.run.state = "blocked";
      ctx.run.stateReason = reason;
    }
    // Blocking work preserves non-dispatching owner decisions; cancellation and drift revoke them.
    this.invalidateUnused(ctx, ctx.run.state === "blocked");
  }

  private accountClock(ctx: CommandContext): void {
    if (ctx.run.accountedAt !== null) {
      const elapsed = Date.parse(ctx.now) - Date.parse(ctx.run.accountedAt);
      if (elapsed < 0) {
        this.block(ctx, "Clock moved backwards; budget reconciliation is required");
        return;
      }
      ctx.run.activeMs = integer(ctx.run.activeMs + elapsed, "run.activeMs");
      ctx.run.accountedAt = ctx.now;
    }
    if (ctx.run.activeMs >= ctx.run.binding.limits.maxActiveMs) this.block(ctx, "Active wall-clock budget exhausted");
  }

  private liveAttemptCount(runId: string): number {
    return (this.db.prepare("SELECT count(*) AS count FROM team_attempts WHERE run_id = ? AND state IN ('running', 'unknown')")
      .get(runId) as { count: number }).count + this.nativeLaunchIntents(runId).filter(intent => intent.state === "admitted").length;
  }

  /** U8 — work a resumed run may offer to the dispatcher, in queue order. */
  private pendingResumeTaskIds(runId: string): string[] {
    const rows = this.db.prepare(`SELECT a.task_id AS taskId
      FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
      WHERE a.run_id = ? AND q.state IN ('pending', 'in-progress')
        AND NOT EXISTS (SELECT 1 FROM team_attempts t WHERE t.qitem_id = a.qitem_id AND t.state <> 'stopped')
      ORDER BY a.rowid`).all(runId) as Array<{ taskId: string }>;
    return rows.map(row => row.taskId);
  }

  private syncClock(ctx: CommandContext): void {
    if (this.liveAttemptCount(ctx.run.id) > 0) {
      ctx.run.accountedAt ??= ctx.now;
    } else if (ctx.run.accountedAt !== null) {
      ctx.run.accountedAt = null;
      this.emit(ctx.run, ctx.register, "run.clock-paused", { activeMs: ctx.run.activeMs, reason: "All recorded managed attempts are observed stopped" });
    }
  }
}
