export const TEAM_CONTROL_VERSION = "1.0";
export const TEAM_QUEUE_STATES = ["pending", "in-progress", "done", "blocked", "failed", "denied", "canceled", "handed-off"] as const;
export type TeamQueueState = (typeof TEAM_QUEUE_STATES)[number];
export type TeamRole = "lead" | "implementer" | "reviewer";

export const TEAM_SYSTEM_HEALTH_VERSION = "1.0" as const;
export const TEAM_HEALTH_STATES = ["ok", "degraded", "failed", "unknown"] as const;
export type TeamHealthState = (typeof TEAM_HEALTH_STATES)[number];
export const TEAM_HEALTH_LIGHTS = ["database", "queueMailbox", "controlTmux", "workerBoundary", "sandboxNetwork", "clients"] as const;
export type TeamHealthLightName = (typeof TEAM_HEALTH_LIGHTS)[number];
export interface TeamHealthLight { state: TeamHealthState; checkedAt: string; evidenceRef: string | null; reason: string | null; }
export interface TeamAttemptHealth {
  attemptId: string; runId: string; worker: string | null; client: "claude-code" | "codex" | null;
  state: string; reasonCode: string | null; resumeSafe: boolean | null; checkedAt: string; evidenceRef: string | null;
}
export interface TeamSystemHealth {
  schema: "multi-agent-system-health/v1"; protocolVersion: typeof TEAM_SYSTEM_HEALTH_VERSION; checkedAt: string; timeoutMs: number;
  overall: TeamHealthState; lights: Record<TeamHealthLightName, TeamHealthLight>; latestAttempts: Record<string, TeamAttemptHealth>;
}
export interface ManagedWorkerHealthEvidence {
  observedAt: string;
  attempts: Array<{ attemptId: string; runId: string; worker: string; client: "claude-code" | "codex";
    state: "preflight" | "starting" | "running" | "stopped" | "unknown"; provider: "signed_in" | "signed_out" | "unknown";
    policyRevision: number; policyFingerprint: string; clientVersion: string; clientLockDigest: string;
    networkMode: "isolated-allowlist" | "filtered-proxy" | "host-shared" | "unknown"; networkProfileFingerprint: string; evidenceRef: string; }>;
}
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ApprovalKind = "orchestrator" | "native";
export type ApprovalAction = "implementation" | "commit" | "push" | "pr-create" | "merge" | "release" | "deploy" | "scope-change" | "limit-increase" | "native-tool" | "scope-extension";
export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "invalidated";
export type TeamRunState = "pending" | "approved" | "cancel_requested" | "invalidated" | "blocked";
export type AttemptState = "running" | "stopped" | "unknown";

export interface TeamLimits {
  maxSessions: number;
  maxActiveMs: number;
  maxRetries: number;
  maxReviewRounds: number;
}

export interface PlanBinding {
  artifactContract: "spec-unified-plan/v1";
  artifactReadiness: "implementation-ready";
  execution: "code";
  status: "active";
  planRef: string;
  planDigest: string;
  repository: { root: string; identity: string };
  readPaths: string[];
  writePaths: string[];
  roles: TeamRole[];
  policyRevision: number;
  policyFingerprint: string;
  limits: TeamLimits;
}

export interface ScopedAssignment {
  taskId: string;
  role: TeamRole;
  /**
   * A reviewer's link to the task whose candidate it reviews (plan U5).
   *
   * The reviewer enters that task's candidate read-only and takes no claim on it, so its
   * own `taskId` still keys everything it owns: its queue row, its attempt and its release.
   */
  reviewOf?: string;
  paths: string[];
  dependencies: string[];
}

export interface UsageMetric {
  value: number | null;
  reason: string | null;
}

export interface UsageEvidence {
  activeMs: number;
  inputTokens: UsageMetric;
  outputTokens: UsageMetric;
  costUsd: UsageMetric;
}

export interface NativeAttemptIdentity {
  nativeSessionId: string;
  tmuxServer: string;
  paneId: string;
  processId: number;
  processStart: string;
  generation: number;
  policyFingerprint: string;
}

export interface TeamRun {
  id: string;
  rigId: string;
  binding: PlanBinding;
  bindingDigest: string;
  state: TeamRunState;
  stateReason: string | null;
  entityVersion: number;
  activeMs: number;
  accountedAt: string | null;
  retriesUsed: number;
  reviewRoundsUsed: number;
  usage: UsageEvidence;
  createdAt: string;
  updatedAt: string;
}

export interface TeamApproval {
  id: string;
  runId: string;
  kind: ApprovalKind;
  action: ApprovalAction;
  payload: JsonObject;
  payloadDigest: string;
  targetDigest: string;
  bindingDigest: string;
  state: ApprovalState;
  entityVersion: number;
  expiresAt: string;
  decisionActor: string | null;
}

export interface TeamTaskAuthority {
  qitemId: string;
  runId: string;
  assignment: ScopedAssignment;
  /**
   * T053 — the task's declared production inputs, recorded beside the assignment at
   * `task.created` and read back by the launch path, so the attempt's projection is built
   * from one record instead of from whichever values its caller supplied.
   *
   * `null` means the row predates this record. It is not an empty grant: it says "nothing
   * was recorded", and the launch path can only refuse a *recorded* disagreement.
   */
  outputs: string[] | null;
  permissions: string[] | null;
  entityVersion: number;
  evidence: JsonObject | null;
}

export interface TeamAttempt {
  id: string;
  runId: string;
  qitemId: string | null;
  role: TeamRole;
  provider: "claude" | "codex";
  identity: NativeAttemptIdentity | null;
  unknownReason: string | null;
  state: AttemptState;
  usage: UsageEvidence;
  entityVersion: number;
}

export interface ApprovalConsumption {
  approvalId: string;
  runId: string;
  attemptId: string;
  state: "reserved" | "confirmed" | "ambiguous";
  receipt: JsonObject | null;
}

export interface ScopeExtension {
  runId: string;
  classification: "new-sibling" | "owner-decision" | "low-risk-dev-dependencies";
  dependencyDigest: string | null;
  id: string;
  bindingDigest: string;
  taskId: string;
  attemptId: string | null;
  paths: Array<{ path: string; canonicalPath: string; operation: "create" | "modify"; evidenceDigest: string }>;
  reason: string;
  candidateDigest: string;
  assignmentDigest: string;
  expectedChainHead: string;
  chainHead: string | null;
  packages: Array<{ name: string; version: string; matched: string }>;
  state: ApprovalState;
  decisionActor: string | null;
  automatic: boolean;
}
export interface ScopeProjection { chainHead: string; scopeDigest: string; extensions: ScopeExtension[]; }

export interface ControlActor {
  kind: "owner" | "worker";
  sessionId: string;
}

/**
 * T052 — the managed run's owner read projections.
 *
 * One read contract that U6's two clients consume. It publishes committed,
 * correlated evidence only; it holds no second store and derives nothing a
 * durable row does not already say. Every availability field is explicit
 * because "no evidence" and "zero" are different facts to a reader (AE12).
 */
export const TEAM_READ_MODEL_VERSION = "1.0" as const;

/** The seven-stage run stepper (U6). Stage order is the array order. */
export const TEAM_WORKFLOW_STAGES = [
  "setup-checks",
  "plan-approved",
  "assignments-derived",
  "execution",
  "review",
  "integration-verification",
  "delivery-decision",
] as const;
export type TeamWorkflowStage = (typeof TEAM_WORKFLOW_STAGES)[number];

/**
 * A stage's observed completion. `unavailable` is not "not started": it means
 * the durable evidence that would decide the stage does not exist yet, so a
 * reader must say "unavailable" rather than draw an empty stepper.
 */
export type TeamStageState = "complete" | "active" | "pending" | "awaiting-decision" | "not-started" | "unavailable";

export interface TeamStageProgress {
  stage: TeamWorkflowStage;
  state: TeamStageState;
  /** Durable rows the verdict rests on, so a reader can trace it. */
  evidence: string;
}

export interface TeamRunStageView {
  /** The earliest stage without finished required work; `null` when every stage is complete. */
  current: TeamWorkflowStage | null;
  stages: TeamStageProgress[];
}

/**
 * Verified acceptance criteria, never an agent's self-report (U6). `verified` is
 * `null` while no durable criteria record exists, so a reader cannot render
 * `0/0` as if everything were done.
 */
export interface TeamCriteriaProgress {
  verified: number | null;
  total: number | null;
  source: string | null;
}

export interface TeamReviewView {
  taskId: string;
  qitemId: string;
  role: TeamRole;
  queueState: TeamQueueState;
  criteria: TeamCriteriaProgress;
  currentCandidateDigest: string | null;
  rounds: number;
  openP0P1: number;
  /** Availability of the review record itself; a crashed or missing round is unavailable, never passing. */
  reviewAvailable: boolean;
  acceptance: { manifestDigest: string; passed: boolean; reason: string; recordedAt: string } | null;
}

export interface TeamAttemptView {
  attemptId: string;
  runId: string;
  taskId: string | null;
  qitemId: string | null;
  role: TeamRole;
  provider: "claude" | "codex";
  state: AttemptState;
  unknownReason: string | null;
  session: string | null;
}

/** One bounded, redacted log or exit record correlated to its task and attempt. */
export interface TeamLogRecord {
  /** Durable origin of the record, so a reader never has to guess which table it came from. */
  source: "stream" | "task-outcome" | "attempt-lifecycle";
  streamItemId: string | null;
  ts: string;
  runId: string | null;
  taskId: string | null;
  attemptId: string | null;
  session: string | null;
  /** Already redacted at the boundary; inert text a client renders literally. */
  body: string;
  /** True when the body was shortened to the record bound. */
  truncated: boolean;
  exitOutcome: "done" | "failed" | "denied" | "canceled" | null;
}

/**
 * Replay metadata. `retainedFrom` is the earliest durable sequence still
 * present: a client that asks for an older cursor has a real gap, and saying so
 * is the point (AE12).
 */
export interface TeamReplayWindow {
  retainedFrom: number;
  latestSeq: number;
}

export interface TeamOwnerRead {
  schema: "multi-agent-team-read/v1";
  protocolVersion: typeof TEAM_READ_MODEL_VERSION;
  runId: string;
  generatedAt: string;
  run: TeamRun;
  workflow: TeamRunStageView;
  tasks: TeamReviewView[];
  attempts: TeamAttemptView[];
  approvals: Array<TeamApproval & { awaitingDecision: boolean }>;
  logs: TeamLogRecord[];
  replay: TeamReplayWindow;
}

/**
 * One durable event in a run-scoped replay, with its identity preserved.
 *
 * The payload is published as a bounded, redacted body rather than the raw
 * nested object: replay is the same evidence surface as the snapshot, so a
 * secret the snapshot removed must not reappear here.
 */
export interface TeamReplayEvent {
  seq: number;
  createdAt: string;
  type: string;
  action: string | null;
  runId: string | null;
  taskId: string | null;
  attemptId: string | null;
  body: string;
  truncated: boolean;
}

export interface ControlRequest<T = JsonValue> {
  protocolVersion: string;
  runId: string;
  actionId: string;
  expectedEntityVersion: number;
  idempotencyKey: string;
  payload: T;
}

export interface ControlReceipt<T = unknown> {
  status: "accepted" | "pending-execution" | "conflict" | "denied" | "observed";
  runId: string;
  entityVersion: number;
  replayed: boolean;
  effectMayStart: boolean;
  value: T | null;
  reason: string | null;
}

export interface TeamControlEvent {
  type: "team.control";
  protocolVersion: string;
  eventId: string;
  rigId: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  entityId: string;
  entityVersion: number;
  action: string;
  payload: JsonObject;
}

export class TeamContractError extends Error {
  readonly code = "invalid_team_contract";
  constructor(readonly field: string) {
    super(`Invalid team contract field: ${field}`);
    this.name = "TeamContractError";
  }
}

export function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TeamContractError(field);
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TeamContractError(field);
  return value;
}

export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new TeamContractError(field);
  return value;
}

export function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TeamContractError(field);
  return value;
}

export function relativePath(value: unknown, field: string): string {
  const result = text(value, field, 4096);
  if (result.startsWith("/") || result.startsWith("~") || /[\\:*?\[\]{}]/.test(result)
    || result.split("/").some((part) => part === "" || part === "." || part === "..")) throw new TeamContractError(field);
  return result;
}

function absolutePath(value: unknown, field: string): string {
  const result = text(value, field, 4096);
  if (!result.startsWith("/") || result === "/" || result.includes("\\")
    || result.slice(1).split("/").some((part) => !part || part === "." || part === "..")) throw new TeamContractError(field);
  return result;
}

function strings(value: unknown, field: string, parse = text): string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new TeamContractError(field);
  const result = value.map((item) => parse(item, field));
  if (new Set(result).size !== result.length) throw new TeamContractError(field);
  return result;
}

function role(value: unknown): TeamRole {
  if (value !== "lead" && value !== "implementer" && value !== "reviewer") throw new TeamContractError("role");
  return value;
}

export function parseProtocolVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 32 || !/^1\.(0|[1-9][0-9]*)$/.test(value)) throw new TeamContractError("protocolVersion");
  return value;
}

export function parsePlanBinding(value: unknown): PlanBinding {
  const v = object(value, "binding");
  for (const [key, expected] of Object.entries({ artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active" })) {
    if (v[key] !== expected) throw new TeamContractError(key);
  }
  const repository = object(v.repository, "repository");
  const root = absolutePath(repository.root, "repository.root");
  const identity = text(repository.identity, "repository.identity");
  if (!/^(git:(?:[a-f0-9]{40}|[a-f0-9]{64})|snapshot:sha256:[a-f0-9]{64})$/.test(identity)) throw new TeamContractError("repository.identity");
  const limits = object(v.limits, "limits");
  const roles = strings(v.roles, "roles").map(role);
  if (!roles.length) throw new TeamContractError("roles");
  const readPaths = strings(v.readPaths, "readPaths", relativePath);
  const writePaths = strings(v.writePaths, "writePaths", relativePath);
  if (!readPaths.length && !writePaths.length) throw new TeamContractError("scope");
  return {
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: relativePath(v.planRef, "planRef"), planDigest: digest(v.planDigest, "planDigest"),
    repository: { root, identity }, readPaths, writePaths, roles,
    policyRevision: integer(v.policyRevision, "policyRevision", 1), policyFingerprint: digest(v.policyFingerprint, "policyFingerprint"),
    limits: { maxSessions: integer(limits.maxSessions, "maxSessions", 1, 3), maxActiveMs: integer(limits.maxActiveMs, "maxActiveMs", 1, 3_600_000),
      maxRetries: integer(limits.maxRetries, "maxRetries", 0, 1), maxReviewRounds: integer(limits.maxReviewRounds, "maxReviewRounds", 0, 2) },
  };
}

export function parseAssignment(value: unknown): ScopedAssignment {
  const v = object(value, "assignment");
  const taskId = text(v.taskId, "taskId", 256);
  const dependencies = strings(v.dependencies, "dependencies");
  if (dependencies.includes(taskId)) throw new TeamContractError("dependencies");
  const paths = strings(v.paths, "paths", relativePath);
  if (!paths.length) throw new TeamContractError("paths");
  const parsed = role(v.role);
  // Plan U5: only a reviewer reviews, and it cannot review itself — either would point a
  // launch at a tree the launching task does not own.
  if (v.reviewOf === undefined) return { taskId, role: parsed, paths, dependencies };
  const reviewOf = text(v.reviewOf, "reviewOf", 256);
  if (parsed !== "reviewer" || reviewOf === taskId) throw new TeamContractError("reviewOf");
  return { taskId, role: parsed, reviewOf, paths, dependencies };
}

/**
 * T053 — the two arrays `task.created` now requires beside the assignment.
 *
 * Both are required rather than defaulted: the record is what the launch path compares a
 * caller's values against, so a task that recorded nothing could never refuse a
 * disagreement. Membership in the role's permission vocabulary and containment in the
 * assignment's write paths are checked by the governance owner, which is where the
 * binding and the role charter are known.
 */
export function parseTaskInputs(value: unknown): { outputs: string[]; permissions: string[] } {
  const v = object(value, "task");
  return { outputs: strings(v.outputs, "outputs", relativePath), permissions: strings(v.permissions, "permissions") };
}

export function jsonValue(value: unknown, field = "payload", depth = 0): JsonValue {
  if (depth > 32) throw new TeamContractError(field);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new TeamContractError(field);
    return Array.from({ length: value.length }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(value, index);
      if (!property?.enumerable || !("value" in property)) throw new TeamContractError(field);
      return jsonValue(property.value, field, depth + 1);
    });
  }
  const record = object(value, field);
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string")) throw new TeamContractError(field);
  return Object.fromEntries((keys as string[]).sort().map((key) => {
    const property = Object.getOwnPropertyDescriptor(record, key)!;
    if (!property.enumerable || !("value" in property)) throw new TeamContractError(field);
    return [key, jsonValue(property.value, field, depth + 1)];
  }));
}

export function canonicalJson(value: unknown): string {
  const result = JSON.stringify(jsonValue(value));
  if (new TextEncoder().encode(result).length > 1_048_576) throw new TeamContractError("payload_size");
  return result;
}

export function parseUsage(value: unknown): UsageEvidence {
  const v = object(value, "usage");
  function metric(input: unknown, field: string, whole: boolean): UsageMetric {
    const m = object(input, field);
    if (m.value === null) return { value: null, reason: text(m.reason, `${field}.reason`) };
    if (typeof m.value !== "number" || !Number.isFinite(m.value) || m.value < 0 || (whole && !Number.isSafeInteger(m.value)) || m.reason !== null) throw new TeamContractError(field);
    return { value: m.value, reason: null };
  }
  return { activeMs: integer(v.activeMs, "usage.activeMs"), inputTokens: metric(v.inputTokens, "inputTokens", true),
    outputTokens: metric(v.outputTokens, "outputTokens", true), costUsd: metric(v.costUsd, "costUsd", false) };
}

export function parseAttemptIdentity(value: unknown): NativeAttemptIdentity {
  const v = object(value, "attemptIdentity");
  const paneId = text(v.paneId, "paneId");
  if (!/^%[0-9]+$/.test(paneId)) throw new TeamContractError("paneId");
  return { nativeSessionId: text(v.nativeSessionId, "nativeSessionId"), tmuxServer: absolutePath(v.tmuxServer, "tmuxServer"),
    paneId, processId: integer(v.processId, "processId", 1), processStart: text(v.processStart, "processStart"),
    generation: integer(v.generation, "generation", 1), policyFingerprint: digest(v.policyFingerprint, "policyFingerprint") };
}

export function parseControlRequest(value: unknown): ControlRequest {
  const v = object(value, "controlRequest");
  return { protocolVersion: parseProtocolVersion(v.protocolVersion), runId: text(v.runId, "runId", 256),
    actionId: text(v.actionId, "actionId", 256), expectedEntityVersion: integer(v.expectedEntityVersion, "expectedEntityVersion", 1),
    idempotencyKey: text(v.idempotencyKey, "idempotencyKey", 256), payload: JSON.parse(canonicalJson(v.payload)) as JsonValue };
}

export function parseTeamEvent(value: unknown): TeamControlEvent {
  const v = object(value, "event");
  if (v.type !== "team.control") throw new TeamContractError("event.type");
  return { type: "team.control", protocolVersion: parseProtocolVersion(v.protocolVersion), eventId: text(v.eventId, "eventId"),
    rigId: text(v.rigId, "rigId"), runId: text(v.runId, "runId"), taskId: v.taskId === null ? null : text(v.taskId, "taskId"),
    attemptId: v.attemptId === null ? null : text(v.attemptId, "attemptId"), entityId: text(v.entityId, "entityId"),
    entityVersion: integer(v.entityVersion, "entityVersion", 1), action: text(v.action, "action"),
    payload: JSON.parse(canonicalJson(object(v.payload, "event.payload"))) as JsonObject };
}
