import type Database from "better-sqlite3";
import { applyTaskEdit, readTaskEdit } from "./task-edit.js";
import { LeadWakePolicy } from "./lead-wake-policy.js";
import { RigRepository } from "./rig-repository.js";
import { createHash, randomUUID } from "node:crypto";
import {
  TEAM_CONTROL_VERSION, TEAM_QUEUE_STATES, TeamContractError, canonicalJson, digest, integer, jsonValue,
  object, parseAssignment, parseAttemptIdentity, parseControlRequest, parsePlanBinding, parseTaskInputs, parseTeamEvent, parseUsage, text,
  type ApprovalAction, type ApprovalConsumption, type ApprovalKind, type AttemptState, type ControlActor,
  type ControlReceipt, type ControlRequest, type JsonObject, type TeamApproval, type TeamAttempt,
  type TeamRun, type TeamTaskAuthority, type UsageEvidence, type UsageMetric, type TeamOwnerCommand,
} from "../contracts/team-control.js";
import { roleConfiguration } from "./role-configuration.js";
import { ensureSeatMailboxCapability } from "./seat-mailbox-capability.js";
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
}

const deny = (reason: string): Result => ({ status: "denied", reason });
const approvalActions: readonly ApprovalAction[] = ["implementation", "commit", "push", "pr-create", "merge", "release", "deploy", "scope-change", "limit-increase", "native-tool", "scope-extension"];

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

function actorIdentity(actor: ControlActor, ownerOnly = false): ControlActor {
  const v = object(actor, "actor");
  if (v.kind !== "owner" && v.kind !== "worker") throw new TeamContractError("actor.kind");
  if (ownerOnly && v.kind !== "owner") throw new Error("An authenticated owner control session is required");
  return { kind: v.kind, sessionId: text(v.sessionId, "actor.sessionId", 256) };
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

  createRun(input: { id: string; rigId: string; binding: unknown }): TeamRun {
    this.assertStandalone();
    if (daemonModeOf(this.db) === "legacy") throw new Error("A legacy-mode daemon cannot register managed authority; restart in managed mode");
    const id = text(input.id, "runId", 256);
    const rigId = text(input.rigId, "rigId", 256);
    const binding = parsePlanBinding(input.binding);
    const bindingDigest = hashBinding(binding);
    return this.events.withNotifyEnvelope((register) => {
      if (this.db.prepare("SELECT id FROM team_runs WHERE id = ?").get(id)) {
        const existing = this.getRun(id);
        if (existing.rigId !== rigId || existing.bindingDigest !== bindingDigest) throw new Error("Run identity conflict");
        return existing;
      }
      this.rigs.assertNoPendingDeletion(rigId);
      const now = this.clock().toISOString();
      this.db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(id, rigId, canonicalJson(binding), bindingDigest, now, now);
      const run = this.getRun(id);
      this.emit(run, register, "run.created", { bindingDigest, state: "pending" });
      return run;
    });
  }

  getRun(id: string): TeamRun {
    const row = this.db.prepare(`SELECT id, rig_id AS rigId, binding_json AS bindingJson, binding_digest AS bindingDigest,
      state, state_reason AS stateReason, entity_version AS entityVersion, active_ms AS activeMs, accounted_at AS accountedAt,
      retries_used AS retriesUsed, review_rounds_used AS reviewRoundsUsed, created_at AS createdAt, updated_at AS updatedAt
      FROM team_runs WHERE id = ?`).get(id) as (Omit<TeamRun, "binding" | "usage"> & { bindingJson: string }) | undefined;
    if (!row) throw new Error("Run not found");
    const { bindingJson, ...run } = row;
    const usages = (this.db.prepare("SELECT usage_json FROM team_attempts WHERE run_id = ?").all(id) as Array<{ usage_json: string }>)
      .map((attempt) => parseUsage(JSON.parse(attempt.usage_json)));
    return { ...run, binding: parsePlanBinding(JSON.parse(bindingJson)), usage: { activeMs: run.activeMs,
      inputTokens: cumulativeMetric(usages, "inputTokens"), outputTokens: cumulativeMetric(usages, "outputTokens"), costUsd: cumulativeMetric(usages, "costUsd") } };
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

  getAttempt(id: string): TeamAttempt | null {
    const row = this.db.prepare(`SELECT id, run_id AS runId, qitem_id AS qitemId, role, provider, identity_json AS identityJson,
      unknown_reason AS unknownReason, state, usage_json AS usageJson, entity_version AS entityVersion FROM team_attempts WHERE id = ?`)
      .get(id) as (Omit<TeamAttempt, "identity" | "usage"> & { identityJson: string | null; usageJson: string }) | undefined;
    if (!row) return null;
    const { identityJson, usageJson, ...attempt } = row;
    return { ...attempt, identity: identityJson === null ? null : parseAttemptIdentity(JSON.parse(identityJson)), usage: parseUsage(JSON.parse(usageJson)) };
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

  requestApproval(raw: ControlRequest<unknown>, actor: ControlActor): ControlReceipt {
    const requester = actorIdentity(actor);
    return this.command("approval.requested", raw, requester, (ctx) => {
      const approval = approvalPayload(ctx.request.payload);
      if (approval.action === "scope-extension") return deny("Only candidate staging creates scope extensions");
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
      if (!this.reconcile(ctx, currentBinding)) return deny("Plan, repository or policy binding changed");
      const approval = this.getApproval(ctx.request.actionId);
      if (!approval || approval.runId !== ctx.run.id) throw new Error("Approval not found in this run");
      if (approval.kind === "native") return deny("A native prompt is a configuration fault, not an owner approval action");
      const v = object(ctx.request.payload, "decision");
      if (approval.state !== "pending") {
        if (approval.action === "scope-extension") throw new Error("Scope extension approval state conflict");
        return deny("Approval is no longer pending");
      }
      if (integer(v.approvalVersion, "approvalVersion", 1) !== approval.entityVersion) throw new Error("Approval version conflict");
      if (v.decision !== "approved" && v.decision !== "rejected") throw new TeamContractError("decision");
      const blockedEscalation = ctx.run.state === "blocked" && isEscalation(approval);
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
      ctx.run.state = "cancel_requested";
      ctx.run.stateReason = reason;
      this.invalidateUnused(ctx);
      return { status: "pending-execution", value: { state: "cancel_requested" }, reason: "Termination has not been observed" };
    });
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
      object(ctx.request.payload, "ownerCommand");
      if (operation === "resume") {
        if (ctx.run.state !== "blocked" || ctx.run.stateReason !== "owner-paused") return deny("Only an owner-paused run can resume");
        ctx.run.state = "approved";
        const reason = this.eligibility(ctx);
        if (reason) {
          ctx.run.state = "blocked";
          ctx.run.stateReason = reason;
          return deny(reason);
        }
        ctx.run.stateReason = null;
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
    return this.command("task.created", raw, null, (ctx) => {
      const reason = this.boundEligibility(ctx, currentBinding);
      if (reason) return deny(reason);
      const v = object(ctx.request.payload, "task");
      const assignment = parseAssignment(v.assignment);
      if (assignment.taskId !== ctx.request.actionId) throw new TeamContractError("assignment.taskId");
      if (!ctx.run.binding.roles.includes(assignment.role)) return deny("Assignment role is outside the binding");
      const paths = assignment.role === "reviewer" ? [...ctx.run.binding.readPaths, ...ctx.run.binding.writePaths] : ctx.run.binding.writePaths;
      const covers = (entry: string) => paths.some((allowed) => entry === allowed || entry.startsWith(`${allowed}/`));
      if (assignment.paths.some((entry) => !covers(entry))) return deny("Assignment path is outside the binding");
      const count = this.db.prepare("SELECT count(*) AS count FROM team_queue_authority WHERE run_id = ?").get(ctx.run.id) as { count: number };
      if (count.count >= 100) return deny("Managed task limit reached");
      // T053: the task's declared production inputs are required and validated here, where the
      // assignment's own paths and the role's installed vocabulary are known. A refused task
      // reaches neither array, so it leaves no credential and no capability behind.
      const inputs = parseTaskInputs(v);
      const declares = (entry: string) => assignment.paths.some((allowed) => entry === allowed || entry.startsWith(`${allowed}/`));
      // An output is something the task produces, so it has to be writable. A reviewer's
      // assignment covers the binding's read paths too, and an output under one of those would
      // describe a write the approval never granted.
      const writable = (entry: string) => ctx.run.binding.writePaths.some((allowed) => entry === allowed || entry.startsWith(`${allowed}/`));
      if (inputs.outputs.some((entry) => !declares(entry) || !writable(entry))) return deny("An output is outside the assignment's reviewable write paths");
      if (inputs.permissions.some((entry) => !roleConfiguration[assignment.role].permissions.includes(entry))) {
        return deny("A permission is outside the assignment role's vocabulary");
      }
      const body = v.body;
      if (typeof body !== "string" || !body.trim() || body.length > 262_144) throw new TeamContractError("task.body");
      const sourceSession = text(v.sourceSession, "sourceSession");
      const destinationSession = text(v.destinationSession, "destinationSession");
      const created = withQueueWrite(this.db, { operation: "create" }, () => this.queue.createWithinTransaction({ sourceSession,
        destinationSession, body, targetRepo: ctx.run.binding.repository.root, nudge: false }));
      ctx.register(created.persistedEvent);
      this.db.prepare(`INSERT INTO team_queue_authority
        (qitem_id, run_id, task_id, assignment_json, outputs_json, permissions_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(created.qitemId, ctx.run.id, assignment.taskId, canonicalJson(assignment),
          canonicalJson(inputs.outputs), canonicalJson(inputs.permissions));
      // Minted in the same transaction as the assignment: the producer's bridge and every
      // later send for this seat must read one value, and a refused task leaves none.
      ensureSeatMailboxCapability(this.db, ctx.run.id, destinationSession, new Date(ctx.now));
      return { status: "accepted", value: this.getTask(created.qitemId), taskId: assignment.taskId };
    });
  }

  transitionTask(raw: ControlRequest<unknown>, currentBinding: unknown): ControlReceipt {
    return this.command("task.transitioned", raw, null, (ctx) => {
      const reason = this.boundEligibility(ctx, currentBinding);
      return reason ? deny(reason) : this.writeTaskTransition(ctx, null);
    });
  }

  /** Records an owner-verified stopped outcome, without granting launch or resume authority. */
  recordTaskOutcome(raw: ControlRequest<unknown>, actor: ControlActor): ControlReceipt {
    const owner = actorIdentity(actor, true);
    return this.command("task.outcome", raw, owner, (ctx) => this.writeTaskTransition(ctx, owner.sessionId));
  }

  private writeTaskTransition(ctx: CommandContext, observedBy: string | null): Result {
    const observedOutcome = observedBy !== null;
    const task = this.getTask(ctx.request.actionId);
    if (!task || task.runId !== ctx.run.id) throw new Error("Task not found in this run");
    const v = object(ctx.request.payload, "transition");
    if (integer(v.expectedTaskVersion, "expectedTaskVersion", 1) !== task.entityVersion) throw new Error("Task version conflict");
    if (!TEAM_QUEUE_STATES.includes(v.state as QueueState)) throw new TeamContractError("task.state");
    const item = this.queue.getById(task.qitemId);
    if (!item || !["pending", "in-progress", "blocked"].includes(item.state)) return deny("Task already has a terminal outcome; reopening requires an explicitly counted retry path");
    if (!observedOutcome && !["pending", "in-progress", "blocked"].includes(v.state as string)) {
      return deny("Terminal task states require an owner-observed outcome; handoff requires a separate authority path");
    }
    if (observedOutcome) {
      if (!["done", "failed", "denied", "canceled"].includes(v.state as string)) return deny("Observation cannot start or reopen work");
      if (v.actorSession !== item.destinationSession) return deny("Observation must identify the task's assigned queue session");
      const attempt = this.getAttempt(text(v.attemptId, "attemptId", 256));
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
    if (observedOutcome) transitionNote = `Owner observation of ${v.actorSession}${transitionNote ? `: ${transitionNote}` : ""}`;
    // The dependency gate inside the queue write reads this row's evidence in the
    // same transaction, so outcome evidence must be durable BEFORE the state write.
    const evidence = v.evidence === undefined ? task.evidence : jsonValue(object(v.evidence, "evidence"));
    const changed = this.db.prepare(`UPDATE team_queue_authority SET entity_version = entity_version + 1, evidence_json = ?
      WHERE qitem_id = ? AND entity_version = ?`).run(evidence === null ? null : canonicalJson(evidence), task.qitemId, task.entityVersion);
    if (changed.changes !== 1) throw new Error("Task version conflict");
    const updated = withQueueWrite(this.db, { operation: "update", qitemId: task.qitemId }, () => this.queue.updateWithinTransaction({ qitemId: task.qitemId, actorSession: observedBy ?? text(v.actorSession, "actorSession"),
      state: v.state as QueueState, transitionNote, closureReason: optionalText("closureReason"),
      closureTarget: optionalText("closureTarget"), blockedOn: optionalText("blockedOn") }));
    for (const event of updated.persistedEvents) ctx.register(event);
    return { status: observedOutcome ? "observed" : "accepted", value: this.getTask(task.qitemId), taskId: task.assignment.taskId,
      attemptId: observedOutcome ? v.attemptId as string : undefined, observedBy: observedBy ?? undefined };
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
      this.db.prepare(`UPDATE team_attempts SET state = ?, unknown_reason = ?, usage_json = ?, active_ms = ?,
        entity_version = entity_version + 1, updated_at = ? WHERE id = ? AND entity_version = ?`)
        .run(state, unknownReason, canonicalJson(usage), usage.activeMs, ctx.now, attempt.id, attempt.entityVersion);
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
      const changed = this.db.prepare(`UPDATE team_runs SET state = ?, state_reason = ?, entity_version = ?, active_ms = ?,
        accounted_at = ?, retries_used = ?, review_rounds_used = ?, updated_at = ? WHERE id = ? AND entity_version = ?`)
        .run(run.state, run.stateReason, run.entityVersion, run.activeMs, run.accountedAt, run.retriesUsed,
          run.reviewRoundsUsed, ctx.now, run.id, request.expectedEntityVersion);
      if (changed.changes !== 1) throw new Error("Run entity version conflict");
      const value = result.value === undefined ? null : jsonValue(result.value);
      const receipt: ControlReceipt = { status: result.status, runId: run.id, entityVersion: run.entityVersion,
        replayed: false, effectMayStart: result.effectMayStart ?? false, value, reason: result.reason ?? null };
      this.db.prepare(`INSERT INTO team_control_requests (run_id, idempotency_key, request_digest, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(run.id, request.idempotencyKey, requestDigest, canonicalJson(receipt), ctx.now);
      this.emit(run, register, result.status === "denied" ? `${action}.denied` : action,
        { actionId: request.actionId, status: receipt.status, reason: receipt.reason, valueDigest: hashBytes(canonicalJson(value)),
          ...(result.observedBy === undefined ? {} : { observedBy: result.observedBy }) }, result.taskId, result.attemptId);
      return receipt;
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

  private eligibility(ctx: CommandContext, reconcilingAttemptId?: string): string | null {
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

  private invalidateUnused(ctx: CommandContext, preserveEscalations = false): void {
    this.db.prepare(`UPDATE team_approvals SET state = 'invalidated', entity_version = entity_version + 1, updated_at = ?
      WHERE run_id = ? AND state IN ('pending', 'approved') AND NOT EXISTS
        (SELECT 1 FROM team_approval_consumptions c WHERE c.approval_id = team_approvals.id)
        AND (? = 0 OR kind <> 'orchestrator' OR action NOT IN ('scope-change', 'limit-increase'))`)
      .run(ctx.now, ctx.run.id, preserveEscalations ? 1 : 0);
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

  private syncClock(ctx: CommandContext): void {
    if (this.liveAttemptCount(ctx.run.id) > 0) {
      ctx.run.accountedAt ??= ctx.now;
    } else if (ctx.run.accountedAt !== null) {
      ctx.run.accountedAt = null;
      this.emit(ctx.run, ctx.register, "run.clock-paused", { activeMs: ctx.run.activeMs, reason: "All recorded managed attempts are observed stopped" });
    }
  }
}
