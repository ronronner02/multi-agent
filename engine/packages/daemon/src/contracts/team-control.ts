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
  /**
   * The runtime facts a read-only client cannot infer from its own page. `isolation` is the
   * level this process resolved at startup, reported by the process that decided it. A host
   * that composes no runtime block leaves it absent, and a reader shows "unknown" rather
   * than guessing a level it never verified.
   */
  runtime?: { isolation: "none" | "hardened" | null };
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
export type TeamRunState = "pending" | "approved" | "cancel_requested" | "canceled" | "invalidated" | "blocked";
/**
 * U5 — what the run is doing, as opposed to what it is allowed to do.
 *
 * `planning` is a run whose work is the lead's conversation with the owner; `delivery` is every
 * run that has an approved plan. It is a separate column because dispatch and eligibility read
 * `state`, and a planning lead turn launches through exactly the same gates as any other task.
 */
export type TeamRunPhase = "planning" | "delivery";
export type AttemptState = "running" | "stopped" | "unknown";
export type TeamOwnerCommand = "pause" | "resume" | "retry";

/**
 * Short owner-facing labels for blockers and dispatch refusals. The labels are
 * interface keys; clients translate them through the i18n catalog instead of
 * rendering the daemon's diagnostic prose.
 */
export const TEAM_REASON_LABEL_KEYS = {
  leadWakeHourly: "team.reason.leadWakeHourly",
  leadWakeCycles: "team.reason.leadWakeCycles",
  reviewLimitExhausted: "team.reason.reviewLimitExhausted",
  retryLimitExhausted: "team.reason.retryLimitExhausted",
  initialAttemptRegistration: "team.reason.initialAttemptRegistration",
  clockMovedBackwards: "team.reason.clockMovedBackwards",
  activeWallClockBudget: "team.reason.activeWallClockBudget",
  ownerPaused: "team.reason.ownerPaused",
  implementationApprovalInactive: "team.reason.implementationApprovalInactive",
  runClosedToDispatch: "team.reason.runClosedToDispatch",
  nativeIdentityUnknown: "team.reason.nativeIdentityUnknown",
  nativeLaunchUnresolved: "team.reason.nativeLaunchUnresolved",
  providerPolicyUnverified: "team.reason.providerPolicyUnverified",
  liveSessionLimit: "team.reason.liveSessionLimit",
  planBindingChanged: "team.reason.planBindingChanged",
  recoveryWedge: "team.reason.recoveryWedge",
  integrationConflict: "team.reason.integrationConflict",
  leadFailed: "team.reason.leadFailed",
  generic: "team.reason.generic",
} as const;

/**
 * U6 — the reason a run is blocked when its lead failed and no retry will come.
 *
 * A lead cannot wake itself and the daemon only retries a failure the classifier allows, so a
 * lead failure the run will not retry is the owner's. Resume is the one action that restarts
 * the manager: it reopens the failed lead task and dispatches it.
 */
export const LEAD_FAILED_REASON = "The lead's task failed and the daemon will not retry it";

export type TeamReasonLabelKey = (typeof TEAM_REASON_LABEL_KEYS)[keyof typeof TEAM_REASON_LABEL_KEYS];

/** Map durable governance prose to the stable key an owner client renders. */
export function teamReasonLabelKey(reason: string | null): TeamReasonLabelKey | null {
  if (reason === null) return null;
  if (reason === "lead-wake:hourly") return TEAM_REASON_LABEL_KEYS.leadWakeHourly;
  if (reason === "lead-wake:cycles") return TEAM_REASON_LABEL_KEYS.leadWakeCycles;
  if (reason === "review limit exhausted") return TEAM_REASON_LABEL_KEYS.reviewLimitExhausted;
  if (reason === "retry limit exhausted" || reason === "Retry limit exhausted") return TEAM_REASON_LABEL_KEYS.retryLimitExhausted;
  if (reason.startsWith("Initial attempt registration must precede work")) return TEAM_REASON_LABEL_KEYS.initialAttemptRegistration;
  if (reason.startsWith("Clock moved backwards")) return TEAM_REASON_LABEL_KEYS.clockMovedBackwards;
  if (reason === "Active wall-clock budget exhausted") return TEAM_REASON_LABEL_KEYS.activeWallClockBudget;
  if (reason.startsWith("Resume requires a positive addMinutes")) return TEAM_REASON_LABEL_KEYS.activeWallClockBudget;
  if (reason.startsWith("Resume requires a positive addRetries")) return TEAM_REASON_LABEL_KEYS.retryLimitExhausted;
  if (reason === "owner-paused") return TEAM_REASON_LABEL_KEYS.ownerPaused;
  if (reason === "Implementation approval is not active") return TEAM_REASON_LABEL_KEYS.implementationApprovalInactive;
  if (reason.startsWith("Run is closed to dispatch")) return TEAM_REASON_LABEL_KEYS.runClosedToDispatch;
  if (reason === "Native identity is unknown; reconciliation is required") return TEAM_REASON_LABEL_KEYS.nativeIdentityUnknown;
  if (reason === "Native launch is unresolved; reconciliation is required") return TEAM_REASON_LABEL_KEYS.nativeLaunchUnresolved;
  if (reason === "Provider policy capability is not verified for the current binding") return TEAM_REASON_LABEL_KEYS.providerPolicyUnverified;
  if (reason === "Live session limit reached") return TEAM_REASON_LABEL_KEYS.liveSessionLimit;
  if (reason === "Plan, repository or policy binding changed") return TEAM_REASON_LABEL_KEYS.planBindingChanged;
  // U7 — the approved work could not be applied to the run's integration branch. The task
  // records it as `integration_conflict`, with the patch's own refusal as the reason.
  if (reason === "integration_conflict" || reason.startsWith("Integration conflict")) return TEAM_REASON_LABEL_KEYS.integrationConflict;
  if (reason === LEAD_FAILED_REASON) return TEAM_REASON_LABEL_KEYS.leadFailed;
  if (/seat|pane|wedge/i.test(reason)) return TEAM_REASON_LABEL_KEYS.recoveryWedge;
  return TEAM_REASON_LABEL_KEYS.generic;
}

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
  /**
   * U9 / KTD8 — the run's readable name, derived from its goal when it was created. A run
   * recorded before names existed is named by its creation order on the rig ("Run 2") on
   * read, so this is never the id and never empty.
   */
  displayName: string;
  binding: PlanBinding;
  bindingDigest: string;
  /**
   * MVP slice C2 — the seat this run's review tasks route to, or `null` when the start
   * named none. A null seat is not "no reviewer": it is the pre-C2 behaviour, where an
   * implementer task completes and the run creates no review.
   */
  reviewerSeat: string | null;
  state: TeamRunState;
  stateReason: string | null;
  /** Stable i18n key for `stateReason`, or null when the run is not blocked. */
  stateReasonKey: TeamReasonLabelKey | null;
  /** U5 — planning until the owner approves the lead's plan, delivery afterwards. */
  phase: TeamRunPhase;
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
  /**
   * T033 — the KTD20 decision recorded when this attempt was observed stopped, or null for an
   * attempt that ended without one (a clean exit, or a row written before T033). Its shape is
   * owned by `domain/attempt-failure.ts`; the fields are repeated here because this is the
   * contract every reader consumes.
   */
  failure: AttemptFailure | null;
}

/** The one classification of an ended attempt: its reason code, resume safety and retry eligibility. */
export interface AttemptFailure {
  reasonCode: string;
  resumeSafe: boolean;
  retryEligible: boolean;
  ownerAction: string;
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
  kind: "owner" | "worker" | "daemon";
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

/**
 * U9 — what a task's name is made of, so a client can render it in its own language.
 *
 * A plain task is named by its own words. A reviewer task is named by the task it reviews and
 * the round, which is the part a client has to translate ("Review" / "Review 2"); `of` is the
 * reviewed task's own name and is never translated.
 */
export type TeamTaskNameParts =
  | { kind: "task" }
  | { kind: "review"; round: number; of: string };

/**
 * U9 — one seat of the run's rig, named for display.
 *
 * A seat is a session on a node that declares a team role and a client runtime. `seat` is the
 * address everything internal keys on; `role` and `client` are returned so a client can build
 * the name locally, and `displayName` is the stored English form ("Implementer · Codex 2").
 */
export interface TeamSeatView {
  seat: string;
  role: TeamRole;
  /** The client runtime the seat runs, e.g. "claude-code" or "codex". */
  client: string;
  /**
   * The seat's number within its role and client group, or `null` when it is the only one.
   * Both members of a repeating group carry it, so two implementers on Codex are 1 and 2.
   */
  index: number | null;
  displayName: string;
}

export interface TeamReviewView {
  taskId: string;
  qitemId: string;
  role: TeamRole;
  queueState: TeamQueueState;
  /**
   * U9 / KTD8 — the task's readable name: its title, or for a reviewer task the task it
   * reviews. Stored when the task was admitted; a task recorded before names existed is named
   * on read from the same rows. It is never the id.
   */
  displayName: string;
  /**
   * The parts of `displayName`, so a client renders it in its own language instead of showing
   * the stored English fallback. A client with no localisation renders `displayName` directly.
   */
  displayNameParts: TeamTaskNameParts;
  /**
   * The first line of the task body, shortened for display, or `null` when the
   * row carries no body text. It is the task's own words, never a summary.
   */
  title: string | null;
  /**
   * The assignment's declared dependencies. `[]` is a recorded "none", and
   * `null` means the row's assignment could not be read — the two stay distinct
   * so a client never renders an unreadable assignment as no dependencies.
   */
  dependencies: string[] | null;
  criteria: TeamCriteriaProgress;
  currentCandidateDigest: string | null;
  rounds: number;
  openP0P1: number;
  /**
   * MVP slice C2 — the run's own review rounds for this task, oldest first. A round's
   * `verdict` is what the loop acted on: `changes-required` reopened the task, `approved`
   * closed it. Empty for a run that never used the loop.
   */
  verdicts: TeamReviewVerdict[];
  /** Availability of the review record itself; a crashed or missing round is unavailable, never passing. */
  reviewAvailable: boolean;
  acceptance: { manifestDigest: string; passed: boolean; reason: string; recordedAt: string } | null;
}

/** One review round the run recorded, as a client renders it. */
export interface TeamReviewVerdict {
  round: number;
  reviewerTaskId: string;
  verdict: "approved" | "changes-required";
  candidateDigest: string | null;
  /** How many findings the round recorded, and how many of them were P0/P1. */
  findings: number;
  blocking: number;
  recordedAt: string;
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
  /** When the attempt was recorded; the time axis of any per-attempt series. */
  createdAt: string;
  /** The attempt's own recorded usage. A metric is `null` with a reason until its producer observed it. */
  usage: UsageEvidence;
  /** T033 — the KTD20 decision for this attempt, or null while it runs or when it ended cleanly. */
  failure: AttemptFailure | null;
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
  /** U9 — the rig's seats, named, so a client never renders a seat address. */
  seats: TeamSeatView[];
  attempts: TeamAttemptView[];
  approvals: Array<TeamApproval & { awaitingDecision: boolean }>;
  controlVersions?: { tasks: Record<string, number>; attempts: Record<string, number>; latestAttempts: Record<string, string> };
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
  /** Stable i18n key for `reason`, when the action was denied or reports a blocker. */
  reasonKey?: TeamReasonLabelKey | null;
  /**
   * MVP slice C2 — the task a completion just created and the route must dispatch: the
   * reviewer task an implementer's validated completion admitted, or the implementer task a
   * review's blocking findings sent back. Absent on every other receipt.
   */
  reviewTaskId?: string;
  reworkTaskId?: string;
  /**
   * MVP — the lead task a rejected proposal reopened and the route must dispatch: the lead's
   * revision, resumed on the conversation that wrote the rejected proposal. Absent elsewhere.
   */
  revisionTaskId?: string;
  /** Pending task ids a resumed run should offer to the dispatcher. */
  resumeTaskIds?: string[];
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

/**
 * MVP slice 2 — one row of the owner's run picker.
 *
 * A projection of the run's own durable columns plus its rig's name, so a client can list
 * runs and open one without a second read per row. It is not a second store: every field is
 * read from `team_runs` or the rig it names.
 */
export interface TeamRunSummary {
  id: string;
  rigId: string;
  rigName: string;
  state: TeamRunState;
  planRef: string;
  /** U9 — the run's readable name, so a run picker lists runs without showing an id. */
  displayName: string;
  createdAt: string;
}

/**
 * MVP slice 2 — what an owner start returns.
 *
 * The run, the approval that admitted it, and the one task that puts an agent on the goal.
 * A client opens the run from `runId` and needs nothing else; the remaining fields say what
 * was created, so the owner can see the seat and the queue row rather than trust a 201.
 */
export interface TeamStartReceipt {
  protocolVersion: string;
  runId: string;
  rigId: string;
  approvalId: string;
  taskId: string;
  qitemId: string;
  seat: string;
  /** C2 — the seat review rounds route to, or `null` when the start named none. */
  reviewerSeat: string | null;
  /**
   * C3 — the seat the run's first task belongs to, or `null` for a start with no lead.
   * A non-null value means `taskId` is the lead's task, and `seat` names it too: there is
   * one task at start either way, and this says which role it carries.
   */
  leadSeat: string | null;
  state: TeamRunState;
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

/**
 * Prose an owner writes: the goal a run starts from, and the reason it was refused.
 *
 * `text` refuses every C0 control character, which is right for a name, a path or an id and
 * wrong for a paragraph: a goal is typed into a textarea and becomes the task's brief, so its
 * line breaks and tabs are part of what the owner meant. The characters no textarea produces
 * are still refused.
 */
export function prose(value: unknown, field: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new TeamContractError(field);
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
    // U8 allows an owner Resume action to add bounded budget. The original defaults remain
    // small; these ceilings keep an owner increase finite without making the action a new plan.
    limits: { maxSessions: integer(limits.maxSessions, "maxSessions", 1, 3), maxActiveMs: integer(limits.maxActiveMs, "maxActiveMs", 1, 7 * 24 * 3_600_000),
      maxRetries: integer(limits.maxRetries, "maxRetries", 0, 100), maxReviewRounds: integer(limits.maxReviewRounds, "maxReviewRounds", 0, 100) },
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

/**
 * MVP slice 3 — one finished task's result, as the owner receives it.
 *
 * The patch and the file manifest are the candidate's own computation
 * (`candidateManifest`); this contract only carries them to a client. `files`
 * is the complete candidate manifest, not only the changed paths, so a reader
 * can tell what the tree holds from what the patch moves.
 */
export const TEAM_RESULT_SCHEMA = "multi-agent-team-result/v1" as const;

export interface TeamTaskResult {
  schema: typeof TEAM_RESULT_SCHEMA;
  runId: string;
  taskId: string;
  /** The latest recorded attempt, or null when the producer recorded none. */
  attemptId: string | null;
  /** The run's project repository, which `rig team apply` defaults to. */
  repositoryRoot: string;
  /** Where the patch applies: an owner-established commit, or the snapshot baseline. */
  base: "commit" | "snapshot";
  baseIdentifier: string;
  manifestDigest: string;
  files: Array<{ path: string; hash: string; tracked: boolean }>;
  /** A unified diff against `baseIdentifier`; empty for the snapshot lane, which has no history. */
  patch: string;
}
