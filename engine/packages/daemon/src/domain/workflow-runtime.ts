import { leadRosterPath, parseLeadRoster, type LeadRosterEvidence } from "./lead-roster.js";
import { ScopeExtensions } from "./scope-extension.js";
import { PlanGovernance, hashBinding, hashBytes } from "./plan-governance.js";
import { prepareTeamAssignment, LeadActivation, type AssignmentInput } from "./team-assignment.js";
import { buildManagedNativePolicy, createContextManifest, recordedContextManifest, roleConfiguration, roleInstructionEntries, within,
  type ContextFile, type ContextInput, type ContextManifest, type ContextObservation } from "../integrations/framework/context-manifest.js";
import { WorkerMailboxBridge } from "../adapters/worker-mailbox-bridge.js";
import type { ManagedAttempt } from "./runtime-adapter.js";
import type { MailboxDelivery } from "./mailbox-delivery.js";
import type { ChatRepository } from "./chat-repository.js";
import type { TeamControlCredentials } from "../middleware/auth-bearer-token.js";
import { readWorkflowGuidance, type GuidanceInput } from "./workflow-guidance.js";
import { exceptionConfigurationSource, inspectExceptionReadiness, type ExceptionReadiness } from "./workflow-exception-readiness.js";
import { inspectGraph, recoverGraphOperation, reviseGraph } from "./workflow-reconciliation.js";
import { lifecycleObligations, requiredLifecycleSteps, type LifecycleObligation } from "./lifecycle-obligations.js";
import { ReviewEvidenceLedger, deliveryVerdict, evaluateProgressGate, type AssigneeFacts, type CandidateIdentity } from "./review-evidence.js";
import {
  candidateIdentity,
  candidateManifest,
  checkedOutBranch,
  createCandidateWorkspace,
  createReviewPacket,
  isSourceWorktree,
  recordSnapshotCandidate,
  removeCandidateWorkspace,
  resolveWorkspaceBase,
  snapshotCandidateRecorded,
  sourceFingerprint,
  TEAM_BRANCH_PREFIX,
  verifySourceUnchanged,
  readWorkspacePath,
  type CandidateWorkspace,
  type WorkspaceBase,
} from "./team-workspace.js";
import { LEAD_ESCALATION_PATH, LEAD_PROPOSAL_PATH, LeadProposalMissingError, parseLeadEscalation, parseLeadProposalFile, type LeadProposal,
  type LeadEscalation, type LeadTask } from "./lead-proposal.js";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { canonicalJson, type TeamRole, type PlanBinding } from "../contracts/team-control.js";
// PL-004 Phase D: workflow runtime facade.
//
// Coordinates spec cache + validator + instance store + projector +
// trail log into the four high-level operations:
//   - validate(specPath)
//   - instantiate(specPath, rootObjective, createdBySession)
//   - project(...)  (delegates to projector)
//   - continue(instanceId)  (idempotent advance; v1 = read-only inspector)
//
// Pattern mirrors Phase B's ProjectClassifier facade shape.

import type Database from "better-sqlite3";
import { parseTaskReport, type TaskReport } from "./task-report.js";
import type { WorkflowSpec } from "./workflow-types.js";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";
import type { QueueRepository } from "./queue-repository.js";
import {
  type CreateWorkflowInstanceInput,
  WorkflowInstanceStore,
  WorkflowInstanceError,
} from "./workflow-instance-store.js";
import { resolveExceptionRoute, type ExceptionRoute } from "./workflow-exception-router.js";
import type { WorkflowHumanDestination } from "./workflow-human-destination.js";
import { classifyGateTrip, workflowExceptionTags } from "./workflow-exception.js";
import { ACTIVE_QUEUE_STATES, newQitemId } from "./queue-repository.js";
import type { WorkflowExceptionClass } from "./workflow-exception.js";
import {
  WorkflowProjector,
  WorkflowProjectorError,
  compileGate,
  nodeRuntimeOf,
  reconcileExplicitOwnerHarness,
  resolveDefaultOwner,
  withWorkflowContinuation,
  workflowWaitWakeMessage,
  type GateCompileResult,
  type ProjectStepInput,
  type ProjectStepResult,
} from "./workflow-projector.js";
import { loadHostRegistry } from "./hosts/hosts-registry-reader.js";
import type { HostRegistryLookupFn } from "./workflow-validator.js";
import { WorkflowSpecCache, WorkflowSpecError } from "./workflow-spec-cache.js";
import { WorkflowStepTrailLog } from "./workflow-step-trail-log.js";
import {
  type SeatLivenessCheckFn,
  type ValidationResult,
  WorkflowValidator,
} from "./workflow-validator.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import { disarmAllWorkflowKeepalives, disarmWorkflowKeepalive, ensureWorkflowKeepaliveArmed } from "./workflow-keepalive-arming.js";
import { evaluateStepDeadline, type WorkflowDeadlineVerdict } from "./workflow-deadline.js";
import {
  rigDeclaresRole,
  rigMemberExists,
  roleResolutionContext,
  tryResolveRoleByCapability,
} from "./workflow-role-context.js";
import { isHumanSeatSession } from "./human-route-enforcer.js";
import { parseSessionName } from "./session-name.js";
import type {
  WorkflowFailureOccurrence,
  WorkflowInstance,
  WorkflowSpecRow,
  WorkflowStepSpec,
  WorkflowStepTrailEntry,
} from "./workflow-types.js";
import { compileProjectLifecycle, type LifecycleCompilation } from "./project-lifecycle-compiler.js";

export interface WorkflowRuntimeDeps {
  guidanceLibrary?: GuidanceInput["library"];
  db: Database.Database;
  eventBus: EventBus;
  queueRepo: QueueRepository;
  now?: () => Date;
  /**
   * OPR.0.4.6.WF1 FR-3: when supplied, instantiate + handoff
   * projections auto-arm the per-instance workflow-keepalive watchdog
   * job INSIDE the scribe transaction, and terminal exits disarm it.
   * Optional so tests / embedders without the watchdog subsystem keep
   * working; startup wires the real repository.
   */
  watchdogJobsRepo?: WatchdogJobsRepository;
  /**
   * OPR.0.4.6.WF5 FR-2: the maturity-dial inputs (injected at startup —
   * the projector never reads config itself). hostDefault is read LIVE
   * per exception; absent = the orchestrator-first engine default with
   * registered-human selection when no agent route resolves.
   */
  exceptionDial?: {
    hostDefault: () => "orchestrator" | "human_only" | null;
    humanFallbackSeat: WorkflowHumanDestination;
  };
  /**
   * T039 / KTD8: where a task's candidate tree is materialized. Must sit outside
   * every repository the run can write to, because a candidate inside its own
   * repository would let git discovery in the snapshot lane find the parent repo
   * and hide an isolation bug. Supplied by startup; absent disables candidate
   * isolation, which the launch boundary then refuses.
   *
   * The worker is a parameter because the privileged launcher requires the tree to
   * live under `assignment_root/<that attempt's worker>`. Hardcoding one identity
   * would make every attempt projected onto another worker unlaunchable.
   */
  candidateRoot?: (runId: string, taskId: string, worker: string) => string;
  /**
   * T039: the control-private root the kernel will mount as an assignment tree
   * (`paths.assignment_root` in the installed worker policy). A candidate is
   * only launchable from here; a candidate anywhere else is not admissible.
   * A function so a re-installed policy is read at launch, not at boot.
   */
  assignmentRoot?: () => string;
  /**
   * T048: where a snapshot-lane candidate's control-owned creation record is written. The
   * snapshot lane has no git registry, so this record is the only proof that a directory at a
   * candidate path was created by this runtime; it must sit in the control state directory, which
   * the worker sandbox neither mounts nor makes reachable. A function so a re-installed policy is
   * read at use. Absent, the snapshot lane refuses to create or adopt a candidate rather than
   * adopting a directory it cannot account for.
   * Delivery lead turns also keep their starting base here for recovery after a restart.
   */
  candidateRecordsRoot?: () => string;
  /**
   * T039: the worker whose assignment directory holds a candidate when the caller
   * does not name one. Only the non-launch accessors (identity, packet, source
   * check) fall back to it; the launch path always passes the attempt's own worker.
   */
  defaultWorker?: () => string;
  /**
   * T042 — where the daemon may create an attempt's context projection and mailbox
   * endpoint, read from the installed worker policy.
   *
   * Supplied as one object rather than three callbacks because all of it has to come
   * from the same policy bytes: the projection root is where the control writes and
   * where `inspectManagedWorker` reads, and the mailbox root is the one the launcher
   * requires the endpoint's private ancestry to descend from. Reading them separately
   * would let a re-installed policy split them. Absent disables the producer, which the
   * managed launch boundary then refuses rather than launching without a projection.
   */
  managedAttemptRoots?: () => {
    contextRoot: string;
    mailboxRoot: string;
    controlStateDir: string;
    policyRevision: number;
    workerIdentities: readonly string[];
    frameworkRoot: string;
    frameworkRevision: string;
    /** Where the pinned clients and their native policy live; the projection reads both. */
    toolchainDir: string;
  };
  /**
   * MVP — the worker is the daemon's own user (`workers.isolation: none`).
   *
   * The projection's private-ownership checks exist to prove a sandboxed worker cannot
   * rewrite the instructions it reads. With one identity there is no such boundary, so
   * those checks are skipped rather than made trivially true; everything else about the
   * projection (bytes, hashes, canonical paths, the plan, the role charter) is unchanged.
   */
  sameIdentity?: boolean;
  /**
   * T053 — the owners that supply the producer's per-attempt inputs, so an attempt can be
   * produced from production state rather than from whatever a call site happens to hold.
   *
   * Issuance and reading are separate: the endpoint authenticates every request by *reading*
   * the credential list, so a read that minted would let a request against a revoked seat
   * bring its own token back. The producer issues once, before the endpoint exists, and the
   * bridge only ever reads.
   */
  managedAttemptInputs?: {
    /** Mint this seat's token if it has none. Called once per produced attempt. */
    issueCredential: (runId: string, sessionId: string) => void;
    /** Whether the seat already has a live token, so an existing one is never re-issued. */
    hasCredential: (runId: string, sessionId: string) => boolean;
    /** The live credential list; never mints. */
    readCredentials: () => TeamControlCredentials;
    mailboxCapability: (runId: string, sessionId: string) => string;
    workerIdentity: (worker: string) => { uid: number; gid: number; groupIds: number[] };
  };
  /**
   * T053 — an attempt's worker credential lives exactly as long as its endpoint, so it is
   * revoked on the same retirement T042 already owns. Synchronous: the row and the live
   * token both go, and the bridge is already closed by the time this runs.
   */
  onManagedAttemptRetired?: (attempt: { runId: string; sessionId: string }) => void;
}

/**
 * T042 — what the producer hands back: the attempt object for the binding, the live
 * endpoint, and the candidate the assignment will run in. Frozen so a caller cannot
 * substitute a different attempt after it was registered.
 */
/** T042 — what the producer hands back: the attempt object for the binding, the live
 * endpoint, and the candidate the assignment will run in. Frozen so a caller cannot
 * substitute a different attempt after it was registered.
 */
export interface ProducedManagedAttempt {
  readonly attempt: ManagedAttempt;
  readonly bridge: WorkerMailboxBridge;
  readonly candidate: string;
  readonly manifestDigest: string;
}

/** T042/T053 — everything `produceManagedAttempt` takes. */
export interface ProduceManagedAttemptInput {
  attemptId: string;
  worker: string;
  assignment: AssignmentInput["assignment"];
  outputs: readonly string[];
  permissions: readonly string[];
  /** Everything about the attempt the projection needs; the producer derives the rest. */
  context: Omit<ContextInput, "root" | "projection" | "runId" | "files" | "binding" | "assignment"
    | "outputs" | "permissions" | "role" | "frameworkRoot" | "frameworkRevision" | "nativePolicy"
    | "workerUid" | "workerGroups"> & { workerUid?: number; workerGroups?: number[] };
  role: TeamRole;
  client: "claude-code" | "codex";
  /** The workspace the assignment will actually run in, from T039's candidate. */
  candidate: string;
  /** The session whose capability the mailbox accepts, and the seat it belongs to. */
  sessionId: string;
  rigId: string;
  taskId: string;
  recipients: readonly string[];
  /** The recipient's own mailbox capability: the secret its poll and consume are scoped by. */
  mailboxCapability?: string;
  /** The worker's own gid in the projection; the control side is this process. */
  workerGid?: number;
  delivery: MailboxDelivery;
  chat: ChatRepository;
  /** The credentials this attempt's endpoint authenticates against. */
  readCredentials?: () => TeamControlCredentials;
  /** The launcher's own liveness question for this attempt; false closes the generation. */
  isCurrent: () => boolean;
  deadline: number;
  previous?: ManagedAttempt["previous"];
  /** The pinned framework files this attempt loads. */
  frameworkFiles: readonly { path: string; source: string }[];
}

export interface InstantiateInput {
  specPath: string;
  rootObjective: string;
  createdBySession: string;
  /**
   * Override default entry-step owner. v1 falls back to spec
   * preferred_targets[0] for the entry step's role.
   */
  entryOwnerSession?: string;
  /**
   * OPR.0.4.6.FAC1 (AC-1): the rig this instance binds to. Overrides
   * the spec's `target.rig` DEFAULT; the effective binding
   * (`targetRig ?? spec.target.rig ?? null`) persists as
   * `WorkflowInstance.boundRig` and scopes role-capability resolution.
   * Absent AND no spec default = unbound (today's behavior).
   */
  targetRig?: string;
  lifecycle?: {
    operationKey: string;
    compiledInputDigest: string;
    binding: Record<string, unknown>;
  };
  /** Internal generated input from compileLifecycle; never accepted from a client. */
  compiledLifecycle?: LifecycleCompilation;
}

export interface InstantiateResult {
  instance: WorkflowInstance;
  spec: WorkflowSpecRow;
  entryQitemId: string;
  entryOwnerSession: string;
  /**
   * OPR.0.4.6.FAC1 (arch ruling 2026-07-07, target-rig zero-regression):
   * loud instantiate-time advisories. Non-fatal notices the operator MUST
   * see. TWO producers into this one list: (1) the spec-default degrade —
   * when a spec's `target.rig` DEFAULT (provenance = spec author's hint,
   * not an operator `--rig` demand) names an unregistered rig, the
   * instance degrades to UNBOUND (routes via preferred_targets,
   * byte-identical pre-FAC-1) with an advisory here rather than a
   * hard-fail; (2) the OPR.0.4.6.FAC3 member-exists probe — a declared
   * preferred_target naming a registered rig but a nonexistent member.
   * Always present (empty when nothing to say); route + CLI surface it
   * loudly.
   */
  advisories: string[];
  replayed?: boolean;
}

/**
 * T011 — does `taskId` satisfy a dependency, following handoff custody?
 *
 * A `done` task satisfies only with validated evidence: an exit code or a
 * completed process is not a result (R18). A `handed-off` task satisfies
 * nothing by itself — it names a successor, and the successor's own validated
 * completion is what counts, followed hop by hop. The visited set is the cycle
 * guard for a chain that closes on itself, which is unsatisfied rather than an
 * infinite walk.
 */
export function dependencySatisfied(
  db: Database.Database,
  queueRepo: Pick<QueueRepository, "getById">,
  validated: (qitemId: string) => boolean,
  runId: string,
  taskId: string,
): boolean {
  // Resolve the task to its queue row once; every hop after that is queue
  // custody, because a handoff successor is a row, not necessarily a task.
  const rows = db.prepare("SELECT qitem_id AS id FROM team_queue_authority WHERE run_id = ? AND task_id = ?").all(runId, taskId) as { id: string }[];
  if (rows.length !== 1) return false;
  const seen = new Set<string>();
  let current: string | null = rows[0]!.id;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const item = queueRepo.getById(current);
    if (!item) return false;
    if (item.state === "done") return validated(item.qitemId);
    if (item.state !== "handed-off" || !item.handedOffTo) return false;
    const successor = db.prepare("SELECT qitem_id AS id FROM queue_items WHERE handed_off_from = ? AND destination_session = ?")
      .all(item.qitemId, item.handedOffTo) as { id: string }[];
    current = successor.length === 1 ? successor[0]!.id : null;
  }
  return false;
}

/**
 * T011 — the run's declared work graph, checked before any task launches.
 *
 * Three rejections KTD4 needs up front, because each one otherwise surfaces as
 * work that can never finish: an edge to a task the run does not contain, a
 * dependency cycle, and two tasks that claim the same write path. Paths are
 * directories or files in the binding, so a claim overlaps when it is the same
 * path or when one contains the other; disjoint files under one directory do
 * not conflict.
 */
export interface GraphTask {
  taskId: string;
  role: string;
  paths: readonly string[];
  dependencies: readonly string[];
}
export type GraphVerdict = { ok: true } | { ok: false; reason: string; taskIds: string[] };

/** The managed run's task ceiling, matching the admission limit `createTask` enforces. */
const MANAGED_TASK_LIMIT = 100;

/** One spelling per claimed path, so `./src/api`, `src/api/` and `src\api` cannot hide an overlap. */
const normalizeClaim = (path: string): string => path.replace(/\\/g, "/").split("/")
  .reduce<string[]>((segments, segment) => {
    // `.` and empty segments (from `src//api`) name the same path as their absence.
    if (segment === "" || segment === ".") return segments;
    if (segment === "..") segments.pop();
    else segments.push(segment);
    return segments;
  }, []).join("/");

export function validateDependencyGraph(tasks: readonly GraphTask[]): GraphVerdict {
  // The 100-task admission limit bound the run, not one createTask call: a run
  // that admits more than this cannot be prepared as one plan.
  if (tasks.length > MANAGED_TASK_LIMIT) return { ok: false, reason: `run declares ${tasks.length} tasks, above the ${MANAGED_TASK_LIMIT}-task limit`, taskIds: [] };
  const byId = new Map<string, GraphTask>();
  for (const task of tasks) {
    if (byId.has(task.taskId)) return { ok: false, reason: `duplicate task ${task.taskId}`, taskIds: [task.taskId] };
    byId.set(task.taskId, task);
  }
  for (const task of tasks) {
    const missing = task.dependencies.filter(dependency => !byId.has(dependency));
    if (missing.length) return { ok: false, reason: `${task.taskId} depends on unknown task(s) ${missing.join(", ")}`, taskIds: [task.taskId, ...missing] };
  }
  // Iterative DFS: a back edge to a node still on the stack is a cycle.
  const state = new Map<string, "visiting" | "visited">();
  for (const root of tasks) {
    if (state.get(root.taskId) === "visited") continue;
    const stack: Array<{ taskId: string; next: number }> = [{ taskId: root.taskId, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const task = byId.get(frame.taskId)!;
      if (frame.next === 0) state.set(frame.taskId, "visiting");
      if (frame.next === task.dependencies.length) {
        state.set(frame.taskId, "visited");
        stack.pop();
        continue;
      }
      const dependency = task.dependencies[frame.next]!;
      frame.next += 1;
      if (state.get(dependency) === "visiting") {
        const cycle = stack.slice(stack.findIndex(entry => entry.taskId === dependency)).map(entry => entry.taskId);
        return { ok: false, reason: `dependency cycle ${[...cycle, dependency].join(" -> ")}`, taskIds: cycle };
      }
      if (state.get(dependency) !== "visited") stack.push({ taskId: dependency, next: 0 });
    }
  }
  const claimed = new Map<string, string>();
  for (const task of tasks) {
    // C3 — the lead writes no assigned tree: its permission vocabulary has no
    // `write-assigned-tree`, and its one output is its own decomposition. C2's reviewer is
    // exempt for the same reason, so neither contributes a claim another task could conflict
    // with; their dependency edges still count.
    if (task.role === "reviewer" || task.role === "lead") continue;
    for (const path of task.paths) {
      const normalized = normalizeClaim(path);
      for (const [owned, owner] of claimed) {
        if (owned === normalized || normalized.startsWith(`${owned}/`) || owned.startsWith(`${normalized}/`)) {
          return { ok: false, reason: `write path ${path} of ${task.taskId} overlaps ${owner}'s ${owned}`, taskIds: [task.taskId, owner] };
        }
      }
      claimed.set(normalized, task.taskId);
    }
  }
  return { ok: true };
}

/** Read an existing projection's entries back as descriptors, for a resumed attempt. */
function readProjectedDescriptors(root: string, frameworkFiles: readonly { path: string; source: string }[]): ContextFile[] {
  // Each projected framework copy is matched back to the pinned source it came from by
  // its projected name, so the rebuilt descriptor points at the source the manifest
  // re-verifies rather than at the copy inside the attempt root. The rule must be the
  // same one `frameworkName` applies when creating, or a resume would map a path the
  // create path refuses onto a sanitized name.
  const projectedName = (path: string) => `framework/${path}`;
  const sourceOf = new Map(frameworkFiles.map(file => [projectedName(file.path), file.source]));
  const files: ContextFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      const relative = path.slice(root.length + 1);
      const kind: ContextFile["kind"] | undefined = relative === "plan" ? "plan" : relative === "role" ? "role"
        : relative === "core" ? "core" : relative === "charter" ? "charter"
        : relative === "protocol" ? "protocol" : relative === "roster" ? "roster"
        : relative === "run" ? "run" : sourceOf.has(relative) ? "framework" : undefined;
      if (!kind) continue;
      const source = sourceOf.get(relative);
      files.push({ path, hash: hashBytes(readFileSync(path)), kind, readOnly: true, ...(source ? { source } : {}) });
    }
  };
  walk(root);
  return files;
}

/**
 * Create the part of a path this producer owns, from `anchor` down, and check it.
 *
 * The anchor and everything above it belong to the installed control, which provisions
 * them for the worker; re-creating them here would invent a second owner for
 * directories the policy already describes. Only the segment below the anchor is ours.
 *
 * The group is a parameter because the two chains differ on purpose, and each difference
 * is enforced by a validator on the other side of the boundary:
 *
 * - The **context** chain carries what the worker must read, so `privateProjection`
 *   requires every directory from the attempt root up to the worker root to carry the
 *   **worker's** gid. `<context_root>/<worker>` is installed setgid for exactly this, so
 *   a child created beneath it inherits the worker group rather than the daemon's.
 * - The **mailbox** chain is control-private, and the launcher's ancestry walk requires
 *   the control's own gid.
 *
 * One predicate for both would make the context chain unsatisfiable on a real host: the
 * setgid directory hands the child the worker group, and a check demanding the daemon's
 * group would throw on every produce.
 */
function ensureOwnedDirectory(path: string, anchor: string, mode: number, gid: number): void {
  // Both ends must be canonical absolute paths before anything walks between them. A
  // relative anchor would pass `within` yet never be reached by the loop below, which
  // would then chmod its way to `/` and spin there — a write primitive and a hang from
  // one malformed policy field.
  for (const candidate of [anchor, path]) {
    if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
      throw new Error("Managed attempt directory must be a canonical absolute path");
    }
  }
  if (!within(anchor, path) || path === anchor) throw new Error("Managed attempt directory is outside the policy root");
  mkdirSync(path, { recursive: true, mode });
  // Under a setgid parent the child already carries the parent's group; the explicit
  // chmod keeps the mode exact without touching that group.
  for (let p = path; p !== anchor; p = dirname(p)) chmodSync(p, mode);
  const stat = statSync(path);
  // A directory that is not what was asked for is refused rather than repaired:
  // repairing it would be this code deciding what another owner's data should look like.
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || stat.gid !== gid
    || (stat.mode & 0o7777) !== mode) {
    throw new Error("Managed attempt directory is not owned as the policy requires");
  }
}

/** Seal every directory in a projection: the launcher refuses any its owner could write. */
function sealProjectionTree(root: string): void {
  const seal = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) seal(join(directory, entry.name));
    }
    // 0550, not 0700: the worker reads this tree through its group, and the launcher
    // rejects any directory below the worker root that still carries an owner write bit.
    chmodSync(directory, 0o550);
  };
  seal(root);
}

/** Remove a projection this producer created and failed to finish, so the attempt id is reusable. */
function removeAttemptRoot(root: string): void {
  try {
    const writable = (path: string): void => {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) writable(child); else chmodSync(child, 0o600);
      }
    };
    if (existsSync(root)) { writable(root); rmSync(root, { recursive: true, force: true }); }
  } catch { /* A projection that cannot be removed is evidence, not a second failure. */ }
}

/**
 * The projection root, created below the worker's own context directory.
 *
 * Group searchable for the worker and grouped to it, because the manifest requires both;
 * the root is sealed by the caller once its entries exist, so nothing can be added to a
 * projection after it was hashed.
 */
function ensureAttemptRoot(path: string, roots: { contextRoot: string; worker: string; workerGid: number }): void {
  ensureOwnedDirectory(path, join(roots.contextRoot, roots.worker), 0o2750, roots.workerGid);
}

/**
 * The mailbox directory, which is control-private rather than worker-readable.
 *
 * The bridge and the privileged launcher both re-check this 0700, control-gid shape, so
 * it is created to exactly that here instead of being loosened for the worker.
 */
function ensureMailboxDirectory(path: string, roots: { mailboxRoot: string; worker: string; controlStateDir: string },
  sameIdentity = false): void {
  // The launcher anchors its ancestry walk on `control_state_dir` and requires the
  // mailbox root to sit directly under it, so an inconsistent roots object is refused
  // here rather than discovered as a launch refusal later. An unisolated host has no such
  // launcher, and keeps its mailbox root shallow so the socket path fits AF_UNIX.
  if (!sameIdentity && roots.mailboxRoot !== join(roots.controlStateDir, "mailboxes")) {
    throw new Error("Managed mailbox root is not beneath the control state directory");
  }
  ensureOwnedDirectory(path, join(roots.mailboxRoot, roots.worker), 0o700, process.getgid!());
}

export class WorkflowRuntime {
  /**
   * T039 / KTD8 — one candidate tree per task, created or resumed exactly once.
   *
   * The candidate is resolved before the launch preflight, because the control
   * reads the assigned tree out of the policy's `assignment_root` and refuses a
   * tree anywhere else. A resumed attempt reuses the recorded workspace rather
   * than creating a second one, so re-entering the launch cannot fork a task's
   * work across two trees.
   *
   * The source repository is only read: `createCandidateWorkspace` fingerprints
   * it and materializes the base elsewhere. Refusals are raised, never returned,
   * so a caller cannot proceed on a workspace it did not get.
   */
  candidateFor(runId: string, taskId: string, worker?: string, options?: { adoptOnly?: boolean }): CandidateWorkspace {
    const key = `${runId}\u0000${taskId}`;
    // An invalidated candidate stays recorded so its owners can still release it,
    // but no caller may enter it again.
    if (this.invalidCandidates.has(key)) throw new Error("Source checkout changed while the candidate was staged");
    const existing = this.candidates.get(key);
    if (existing) {
      // A candidate lives in one worker's assignment directory, and only that
      // worker's launches can mount it. Handing it to another worker would produce
      // a tree the kernel refuses, so the mismatch cannot be papered over.
      //
      // Which way it resolves depends on whether anybody is using the tree. A
      // *claimed* candidate belongs to its attempts and a launch on another worker
      // is refused: staging a second tree would fork one task's work across two,
      // which is exactly what one-candidate-per-task forbids. An *unclaimed* one is
      // only a path a reader guessed at, because the packet and identity accessors
      // name no worker and fall back to the default; re-homing it is safe and is
      // what keeps a reader from deciding where a later launch has to run.
      //
      // A record with no worker can also sit in *this* worker's directory: the reader
      // fell back to the same worker the launch is about to use. That is not a
      // disagreement to re-home — re-homing would delete the very tree the launch
      // asks for — so the tree is kept.
      const owner = this.candidateWorker.get(key);
      const samePlace = owner === undefined && this.candidateRoot !== undefined
        && worker !== undefined && existing.root === this.candidateRoot(runId, taskId, worker);
      if (worker !== undefined && (owner !== undefined ? owner !== worker : !samePlace)) {
        // Re-homing is a mutation: it drops the record and asks for the tree's removal. An
        // adopt-only caller is a reader that must never destroy state — a review launch
        // refused here would otherwise deregister and remove the very candidate it was
        // asked to review, so it refuses without touching anything. The tree stays
        // accounted for, and the worker that does own it can still launch into it.
        if (options?.adoptOnly) throw new Error("Reviewed candidate belongs to a different worker");
        // A record with no worker was staged by a reader that names none (packet,
        // identity, source check) in the default worker's directory. It belongs to
        // no attempt, so it is re-homed rather than allowed to decide where the
        // real launch runs.
        const claimed = (this.candidateOwners.get(key)?.size ?? 0) > 0;
        if (claimed) throw new Error("Candidate belongs to a different worker");
        this.candidates.delete(key);
        this.candidateWorker.delete(key);
        this.removeWorkspace(existing);
      } else {
        // Recording an owner is bookkeeping for a tree about to be launched into. An
        // adopt-only caller is not launching yet, so it leaves the record as it found it
        // and the real launch does the recording.
        if (samePlace && !options?.adoptOnly) this.candidateWorker.set(key, worker!);
        // T039: a candidate is only usable while the source checkout it was staged
        // from is unmoved. Handing one back after the owner's tree changed would
        // present a tree as evidence of work the source no longer supports, so this
        // refuses rather than returning it — and every packet, identity and delivery
        // path goes through here.
        if (!verifySourceUnchanged(existing).unchanged) {
          // The record is *kept*: the tree still exists on disk and the attempts that
          // hold it are the only ones who can release it, so dropping it here would
          // leave `releaseCandidate` with nothing to remove and strand the bytes.
          // It is refused rather than returned, so no launch can enter it again.
          this.invalidCandidates.add(key);
          throw new Error("Source checkout changed while the candidate was staged");
        }
        return this.scopedCandidate(runId, taskId, existing);
      }
    }
    if (!this.candidateRoot || !this.assignmentRoot) throw new Error("Candidate isolation is not configured");
    const run = new PlanGovernance(this.db, this.eventBus, this.queueRepo).getRun(runId);
    const owner = worker ?? this.defaultWorkerName();
    const workspaceRoot = this.candidateRoot(runId, taskId, owner);
    // A candidate outside the kernel's assignment root could never be mounted, so
    // refusing here is the difference between an isolated launch and a lost tree.
    if (!within(this.assignmentRoot(), workspaceRoot)) throw new Error("Candidate root is outside the assignment root");
    // A restart forgets the in-memory record but not the tree. Re-entering a task
    // whose candidate is already on disk must adopt that tree, not stage a second
    // one over it: `git worktree add` refuses an existing path, so the alternative
    // is that every resumed task is unlaunchable after a restart, and its work is
    // stranded in a directory nothing can name. Adoption re-derives the same
    // workspace shape from the recorded base and re-fingerprints the source, so the
    // adopted tree is held to exactly the checks a created one is.
    //
    // A caller that names no worker is not adopting: it is only reading (packet,
    // identity, source check), and it has no way to know which worker the task
    // belongs to. Recording `defaultWorker` for it would pin the task to that
    // worker and refuse the real launch on any other one.
    // Adoption decides provenance from control-owned records only: the source repository's
    // worktree registry for the commit lane, and the creation record the control wrote under its
    // own state directory for the snapshot lane. Nothing on or in the candidate is consulted.
    //
    // U7 — the delivery base is the run's integration worktree once it has one. That worktree
    // carries exactly the commits earlier tasks landed, so a later task builds on their work;
    // the binding's own root is the base before the first integration.
    const sourceRoot = this.deliverySource(run);
    const base = resolveWorkspaceBase(sourceRoot);
    const recordPath = base.kind === "snapshot" ? this.snapshotRecordPath(runId, taskId) : undefined;
    const integratedSource = (checkedOutBranch(sourceRoot) ?? "").startsWith(TEAM_BRANCH_PREFIX);
    const adopted = this.adoptCandidate(runId, taskId, workspaceRoot, base, recordPath, sourceRoot);
    // A delivery turn keeps its starting base even if integration advanced before a restart.
    const leadBasePath = this.candidateRecordsRoot && this.leadTurnBasePath(runId, taskId);
    if (adopted && leadBasePath && existsSync(leadBasePath)) {
      adopted.base = JSON.parse(readFileSync(leadBasePath, "utf8")) as WorkspaceBase;
    }
    // T043: a review launch may adopt the tree a restart left behind, but must never
    // create one. Staging here would hand the reviewer a checkout nobody wrote — the
    // defect this task exists to close — so absence is a refusal, not a cue to build.
    if (options?.adoptOnly) {
      if (!adopted) throw new Error("Reviewed task has no candidate");
      // The record is written only so a later caller in this process sees the same tree;
      // the launch that actually enters it records the owner, exactly as a non-review
      // launch does. Refusing above leaves everything untouched.
      const workspace = { ...adopted, integrationSource: integratedSource };
      this.candidates.set(key, workspace);
      return this.scopedCandidate(runId, taskId, workspace);
    }
    if (run.state !== "approved") throw new Error("Run is not approved for this assignment");
    let workspace: CandidateWorkspace;
    if (adopted) workspace = adopted;
    else {
      // Anything at the candidate path the control cannot account for is moved aside, never
      // deleted and never adopted. The path is under the worker's own assignment directory, so
      // leaving the entry in place would block this task on every retry — a directory or a plain
      // file alike, since `git worktree add` refuses any occupied path. The quarantine name is
      // chosen here and keeps whatever was in it.
      if (this.present(workspaceRoot)) this.quarantineCandidate(workspaceRoot);
      try {
        workspace = createCandidateWorkspace({ root: sourceRoot, base, workspaceRoot, label: taskId });
      } catch (error) {
        // A creation that failed partway is no more accounted for than a planted entry, and the
        // next retry has to be able to try again.
        if (this.present(workspaceRoot)) this.quarantineCandidate(workspaceRoot);
        throw error;
      }
      if (recordPath) {
        // The record has to exist before this call returns: a candidate the control cannot account
        // for is one a restart would have to refuse, and its work would strand. A record that
        // cannot be written removes the tree again rather than leaving it unexplained.
        try {
          recordSnapshotCandidate(recordPath, { runId, taskId, root: workspace.root });
        } catch (error) {
          removeCandidateWorkspace(workspace);
          throw error;
        }
        workspace = { ...workspace, recordPath };
      }
    }
    workspace = { ...workspace, integrationSource: integratedSource };
    // Only a caller that named a worker tells us who owns the task's tree.
    if (worker !== undefined) this.candidateWorker.set(key, worker);
    this.candidates.set(key, workspace);
    return this.scopedCandidate(runId, taskId, workspace);
  }

  /**
   * T039 — re-enter a candidate this runtime already staged, before a restart.
   *
   * A directory at the candidate path is adopted only when a control-owned record accounts for it:
   * the source's worktree registry for the commit lane, the creation record under the control state
   * directory for the snapshot lane. Anything that is not a directory — a file, a symlink — is left
   * to `createCandidateWorkspace`, which refuses it loudly. The base is resolved from the current
   * source, so the source-moved check downstream still applies to the adopted tree.
   */
  private adoptCandidate(runId: string, taskId: string, workspaceRoot: string, base: WorkspaceBase,
    recordPath: string | undefined, source: string): CandidateWorkspace | undefined {
    let stats;
    try { stats = lstatSync(workspaceRoot); } catch { return undefined; }
    if (!stats.isDirectory()) return undefined;
    const sourceRoot = realpathSync(source);
    const accounted = base.kind === "commit"
      ? isSourceWorktree(sourceRoot, workspaceRoot)
      : recordPath !== undefined && snapshotCandidateRecorded(recordPath, { runId, taskId, root: workspaceRoot });
    if (!accounted) return undefined;
    return { root: workspaceRoot, sourceRoot, base, source: sourceFingerprint(sourceRoot),
      ...(recordPath ? { recordPath } : {}) };
  }

  /**
   * U7 — where a task's candidate is staged from.
   *
   * Once the run has an integration worktree, that worktree is the delivery base: it carries
   * exactly the commits earlier tasks landed, so a later task builds on their work. Before the
   * first integration — and for a run whose recorded worktree has gone — the binding's own root
   * is the base, which is where the run's plan was read.
   */
  private deliverySource(run: Pick<import("../contracts/team-control.js").TeamRun, "id" | "binding">): string {
    const recorded = new PlanGovernance(this.db, this.eventBus, this.queueRepo).integrationRecord(run.id).worktree;
    return recorded !== null && existsSync(recorded) ? recorded : run.binding.repository.root;
  }

  /**
   * T048 — move an unaccounted directory off a candidate path, keeping everything in it.
   *
   * The candidate path sits under `assignments/<worker>`, which the worker owns, so a worker can
   * put a directory of its choosing there before its task launches. Leaving it in place would
   * refuse that task on every retry — the `EEXIST` wedge the card forbids, wearing a different
   * error — and deleting it could destroy genuine work whose record was lost. It is therefore
   * renamed, never removed: the sibling name is chosen here from the control's own counter, so
   * nothing about the worker's directory decides where it goes, and the bytes stay for the owner
   * to inspect. The task then creates its own candidate at the path it was given.
   */
  private quarantineCandidate(workspaceRoot: string): void {
    this.quarantineSeq += 1;
    renameSync(workspaceRoot, `${workspaceRoot}.rejected-${Date.now()}-${this.quarantineSeq}`);
  }

  /** T048 — whether anything occupies a path. A broken link counts: it still blocks creation. */
  private present(path: string): boolean {
    try { lstatSync(path); return true; } catch { return false; }
  }

  /** T048 — the control-owned record path for one task's snapshot candidate. */
  private snapshotRecordPath(runId: string, taskId: string): string {
    const root = this.candidateRecordsRoot?.();
    if (!root) throw new Error("Snapshot candidate provenance is not configured");
    return join(root, `${runId}-${taskId}.json`);
  }

  /**
   * T039 — the identity a candidate contributes to the T012 review packet.
   *
   * The candidate's own manifest is the identity; nothing about the launch can
   * name a different tree afterward.
   */
  private scopedCandidate(runId: string, taskId: string, workspace: CandidateWorkspace): CandidateWorkspace {
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo);
    // Provenance inspection can precede task registration; only a recorded task has an effective scope.
    if (governance.findTask(runId, taskId)) workspace.checkScope = evidence => governance.stageCandidateScope(runId, taskId, evidence);
    return workspace;
  }

  /** Browsing observes existing records only; it never acquires or validates a workspace. */
  existingCandidate(runId: string, taskId: string): Pick<CandidateWorkspace, "root" | "sourceRoot" | "base"> | null {
    const key = `${runId}\u0000${taskId}`;
    const candidate = this.invalidCandidates.has(key) ? undefined : this.candidates.get(key);
    return candidate ? { root: candidate.root, sourceRoot: candidate.sourceRoot, base: candidate.base } : null;
  }

  candidateIdentityFor(runId: string, taskId: string): CandidateIdentity {
    return candidateIdentity(candidateManifest(this.candidateFor(runId, taskId)));
  }

  /**
   * MVP slice 3 — the candidate's own manifest and patch, for the owner's result read.
   *
   * The result endpoint needs the patch `candidateManifest` already computes; this is the
   * one place that hands it out, so the route never reaches into the file reader itself.
   *
   * Adopt-only on purpose: this is a read, and a read must never stage a tree. A candidate
   * that is not on disk throws instead of producing a patch of the base against itself, and
   * one a restart left behind is adopted from its recorded provenance rather than refused.
   *
   * The scope hook is dropped here. `candidateFor` attaches it so a *launch* can stage the
   * scope extensions a candidate's edits need; a read that ran it would either write an
   * approval as a side effect of reading, or refuse to show work the owner has already been
   * told about. The owner is reading the result, not admitting the work.
   */
  candidateManifestFor(runId: string, taskId: string): ReturnType<typeof candidateManifest> {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    return candidateManifest({ ...workspace, checkScope: undefined });
  }

  /** Read only the report assigned to this run and worker attempt through the existing file boundary. */
  taskReportFor(runId: string, attemptId: string, turnStateRoot: string): TaskReport | null {
    const attempt = this.db.prepare("SELECT role FROM team_attempts WHERE id = ? AND run_id = ?").get(attemptId, runId) as
      { role: string } | undefined;
    if (!attempt || !["implementer", "reviewer"].includes(attempt.role)
      || !attemptId || /[/\\\x00-\x1f]/.test(attemptId) || [".", ".."].includes(attemptId)) {
      throw new Error("Task report requires this run's worker attempt");
    }
    const read = readWorkspacePath(turnStateRoot, "turns/" + attemptId + "/report/task-report.json", () => false);
    if (read.kind === "missing") return null;
    if (read.kind !== "file") throw new Error("Task report is not a regular file");
    let value: unknown;
    try { value = JSON.parse(read.content); } catch { throw new Error("Task report is not valid JSON"); }
    return parseTaskReport(value);
  }

  /**
   * C3 — the decomposition a lead wrote, read at the boundary that owns worker-written data.
   *
   * The lead's only output is this one file in its own candidate tree, so the read goes
   * through `readWorkspacePath` — the same pinned, no-follow, size-bounded reader every other
   * read of worker output uses — and never through a second reader of the tree. A lead that
   * wrote nothing, or wrote something that is not the shape the protocol states, refuses here
   * with a reason the owner can act on. What the caller does with the batch is not this
   * method's decision: the governance owner validates it against the approved binding and
   * records an owner decision.
   */

  leadProposalFor(runId: string, taskId: string): LeadTask[] {
    return this.leadProposalWithSeatsFor(runId, taskId).tasks;
  }

  leadProposalWithSeatsFor(runId: string, taskId: string): LeadProposal {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    const read = readWorkspacePath(workspace.root, LEAD_PROPOSAL_PATH, () => false);
    if (read.kind !== "file") throw new LeadProposalMissingError();
    let value: unknown;
    try { value = JSON.parse(read.content); } catch { throw new Error("The lead's proposal is not valid JSON"); }
    return parseLeadProposalFile(value);
  }

  /**
   * U6 — the decision a lead asked the owner for, read at the same boundary as its proposal.
   *
   * One file, one reader: the escalation goes through `readWorkspacePath` exactly as the
   * proposal does, so a lead cannot reach the owner with anything but bytes the daemon itself
   * read. Null means the turn wrote no escalation, which is every ordinary turn; a file the
   * boundary refuses refuses here with a reason the turn-end owner can log.
   */
  leadEscalationFor(runId: string, taskId: string): LeadEscalation | null {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    const read = readWorkspacePath(workspace.root, LEAD_ESCALATION_PATH, () => false);
    if (read.kind !== "file") return null;
    let value: unknown;
    try { value = JSON.parse(read.content); } catch { throw new Error("The lead's escalation is not valid JSON"); }
    return parseLeadEscalation(value);
  }

  /**
   * U5 — the plan the lead wrote, read at the same boundary as its proposal.
   *
   * A planning lead's one deliverable is the plan file in its own candidate tree, so the owner's
   * approval reads it through `readWorkspacePath` like every other read of worker output. The
   * path is the run's recorded plan path: the candidate and the binding cannot name different
   * files, because the approval is what makes the binding real.
   */
  rosterFor(runId: string, taskId: string, planRef: string): LeadRosterEvidence {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    const read = readWorkspacePath(workspace.root, leadRosterPath(planRef), () => false);
    if (read.kind !== "file") throw new Error("The lead wrote no readable lead-roster.json beside the plan.");
    let value: unknown;
    try { value = JSON.parse(read.content); } catch { throw new Error("The lead's roster is not valid JSON."); }
    return { seats: parseLeadRoster(value), digest: read.hash };
  }

  planFor(runId: string, taskId: string, planRef: string): { content: string; hash: string } {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    const read = readWorkspacePath(workspace.root, planRef, () => false);
    if (read.kind !== "file") throw new Error("The lead wrote no plan at " + planRef);
    return { content: read.content, hash: read.hash };
  }

  /**
   * U5 — let a task's candidate be adopted again after its source moved.
   *
   * Approving a plan commits those bytes to the run's own branch, which moves the source
   * worktree's HEAD. The tree the lead worked in is untouched, but the source-moved check reads
   * the *recorded* fingerprint and would refuse it from then on. The tree is still the same
   * task's candidate and still registered in the source's own worktree registry, so dropping the
   * in-memory record lets the next launch adopt it — the same path a restart already takes — at
   * the commit the plan was approved at. No bytes are moved, and nothing is released: the tree
   * keeps every file the lead wrote.
   */
  forgetCandidate(runId: string, taskId: string): void {
    const key = `${runId}\u0000${taskId}`;
    this.candidates.delete(key);
    this.candidateWorker.delete(key);
    this.invalidCandidates.delete(key);
  }

  /** Start a delivery lead's next management turn from the integration head. */
  prepareDeliveryLeadTurn(runId: string, taskId: string): boolean {
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo);
    const run = governance.getRun(runId);
    if (run.phase !== "delivery" || run.state !== "approved"
      || governance.findTask(runId, taskId)?.assignment.role !== "lead") return false;
    const basePath = this.leadTurnBasePath(runId, taskId);
    const previous = this.candidateFor(runId, taskId);
    this.removeWorkspace(previous);
    this.forgetCandidate(runId, taskId);
    this.candidateOwners.delete(`${runId}\u0000${taskId}`);
    rmSync(basePath, { force: true });
    const candidate = this.candidateFor(runId, taskId);
    mkdirSync(dirname(basePath), { recursive: true });
    writeFileSync(basePath, JSON.stringify(candidate.base), { mode: 0o600 });
    // Native sessions can resume after a tree refresh when their cwd stays the same.
    return candidate.root !== previous.root;
  }

  private leadTurnBasePath(runId: string, taskId: string): string {
    const root = this.candidateRecordsRoot?.();
    if (!root) throw new Error("Candidate provenance is not configured");
    return join(root, `${runId}-${taskId}.lead-base.json`);
  }

  /**
   * T039 — the read-only packet a reviewer receives for the exact candidate.
   *
   * `destination` must not overlap the candidate or the source checkout; the
   * packet builder enforces that itself rather than trusting this call site.
   */
  reviewPacketFor(runId: string, taskId: string, destination: string) {
    return createReviewPacket(this.candidateFor(runId, taskId), destination);
  }

  /**
   * T039 — proof that staging the candidate did not move the owner's checkout.
   *
   * Called by the delivery boundary: a candidate whose source tree changed while
   * the task ran is not evidence that the task's own work is complete.
   */
  candidateSourceUnchanged(runId: string, taskId: string) {
    return verifySourceUnchanged(this.candidateFor(runId, taskId));
  }

  /**
   * T039 — release one candidate tree, but only when this caller still owns it.
   *
   * A candidate is shared by every attempt that launches into it: a resume reuses
   * the recorded tree, and a second attempt for the same task must not delete work
   * a live one owns. So release is reference-counted by attempt. `retain` is called
   * once admission hands an attempt a candidate; `release` is called once that
   * attempt is finished with it. The tree goes away only when the last owner does.
   *
   * An unretained release is a no-op rather than a guess: an attempt that never
   * obtained the candidate has nothing to give back. A review attempt is exactly that
   * case — it reads the implementer's tree and never owns it, so this is the no-op that
   * keeps a refused review from deleting the work it was asked to review.
   */
  releaseCandidate(runId: string, taskId: string, attemptId: string): void {
    const key = `${runId}\u0000${taskId}`, owners = this.candidateOwners.get(key);
    if (!owners?.delete(attemptId) || owners.size > 0) return;
    this.candidateOwners.delete(key);
    this.invalidCandidates.delete(key);
    const workspace = this.candidates.get(key);
    if (!workspace) return;
    this.candidates.delete(key);
    this.candidateWorker.delete(key);
    this.removeWorkspace(workspace);
  }

  /** T039 — record that this attempt holds the task's candidate. Idempotent per attempt. */
  private retainCandidate(key: string, attemptId: string): void {
    const owners = this.candidateOwners.get(key);
    if (owners) owners.add(attemptId);
    else this.candidateOwners.set(key, new Set([attemptId]));
  }

  /**
   * T039 — admit one assignment for launch and place its candidate.
   *
   * The launcher must know the assigned tree before the control preflights it,
   * because the control reads that tree out of the policy's `assignment_root` and
   * refuses a tree anywhere else. Doing that in the wrong order would either
   * create a candidate for an assignment that is then refused, or launch into a
   * tree the kernel will not mount.
   *
   * So every refusal is decided first — the run is approved, the binding still
   * matches, the role and paths sit inside the approval, dependencies hold with
   * validated evidence, and the graph admits the task — and only then is exactly
   * one candidate materialized. An ineligible assignment therefore leaves no tree
   * behind. The full `prepareTeamAssignment` still runs after preflight with the
   * real observation; this is not a substitute for it.
   */
  admitForLaunch(runId: string, input: {
    attemptId: string;
    /** The attempt's own worker: the candidate must sit in that worker's assignment directory. */
    worker: string;
    assignment: AssignmentInput["assignment"];
    outputs: readonly string[];
    permissions: readonly string[];
    context: ContextManifest;
  }): { candidate: string; manifestDigest: string } {
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo), run = governance.getRun(runId);
    if (run.state !== "approved" || input.context.runId !== runId
      || hashBinding(run.binding) !== hashBinding(input.context.binding)) throw new Error("Run is not approved for this assignment");
    const binding = run.binding, assignment = input.assignment;
    if (assignment.role !== input.context.role || !binding.roles.includes(assignment.role)) throw new Error("Assignment role is outside the approval");
    // Plan U5: the link is checked against the run's own recorded rows, never against the
    // launch's claim. A reviewer naming a task this run did not record as an implementer is
    // refused before any tree is touched. The role gate is repeated here rather than left to
    // `parseAssignment`, because admission is what decides which tree a launch enters and what
    // access it gets: an implementer carrying a link would be handed another task's candidate
    // and mounted writable.
    if (assignment.reviewOf !== undefined && (assignment.role !== "reviewer" || !this.isRunImplementer(runId, assignment.reviewOf))) {
      throw new Error("Review target is not this run's implementer");
    }
    const allowed = assignment.role === "reviewer" ? [...binding.readPaths, ...binding.writePaths] : binding.writePaths;
    const covered = (path: string) => allowed.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
    for (const path of [...assignment.paths, ...input.outputs]) if (!covered(path)) throw new Error("Assignment or output expands the approved scope");
    // T053: the task's own record is the store for outputs and permissions, so admission is
    // where a caller's claim is checked — both the producer and a direct launch pass through
    // here, and neither should be able to declare production inputs the run never recorded.
    // A row that predates the record has nothing to disagree with.
    const task = governance.findTask(runId, assignment.taskId);
    if (!task && assignment.role !== "reviewer") throw new Error("Task not found in this run");
    const differs = (claimed: readonly string[], stored: string[] | null) =>
      stored !== null && canonicalJson([...claimed].sort()) !== canonicalJson([...stored].sort());
    if (task && (differs(input.outputs, task.outputs) || differs(input.permissions, task.permissions))) {
      throw new Error("Assignment inputs disagree with the recorded task");
    }
    if (assignment.dependencies.some(id => !this.dependencySatisfied(governance, runId, id))) throw new Error("Dependency lacks validated success");
    // T039's done signal requires a cyclic or over-limit graph and overlapping write
    // claims to refuse the launch, so the graph is derived from the run's own
    // authority rows rather than taken from the caller. A caller cannot skip this by
    // omitting an argument: the run is the only source of what its tasks claim.
    const verdict = validateDependencyGraph(this.runGraph(runId, assignment));
    if (!verdict.ok) throw new Error(`Dependency graph refused: ${verdict.reason}`);
    // T043: a reviewer enters the candidate under review; every other assignment gets its own.
    // The reviewer path is lookup-only on purpose — see `reviewedCandidateFor`.
    const candidate = assignment.reviewOf === undefined
      ? this.candidateFor(runId, assignment.taskId, input.worker)
      : this.reviewedCandidateFor(runId, assignment.reviewOf, input.worker);
    // Only an attempt that is actually handed the candidate owns it. Recording
    // ownership here is what lets a later refusal tell "my tree" from "someone
    // else's live tree" instead of guessing. The digest is read first on purpose: a
    // manifest failure after the claim was taken would leave an owner that never
    // received anything, and the reference count would then hold the tree forever
    // because nothing knows to release it.
    //
    // T043: a review attempt takes no claim. It reads a tree another task owns, so a
    // claim from it would make the reviewer the owner — a refused review would then be
    // allowed to delete the implementer's work, and a completed one would keep the tree
    // alive past the implementer's own release. Its release is the no-op that ownership
    // never existed, which is exactly the behaviour a reader wants.
    const manifestDigest = candidateManifest(candidate).manifestDigest;
    if (assignment.reviewOf === undefined) this.retainCandidate(`${runId}\u0000${assignment.taskId}`, input.attemptId);
    return { candidate: candidate.root, manifestDigest };
  }

  /**
   * T043 — the tree a managed launch of this assignment mounts.
   *
   * The production composition asks this before the control's policy check sees the path,
   * so it is the one place that decides "my own candidate" versus "the candidate I review".
   * Kept as a runtime method rather than inline in `startup.ts` so the decision the launch
   * actually uses is the one under test; the composition stays a call site.
   *
   * A review launch never creates here: the adopt-only path refuses an absent candidate,
   * which is what stops a reviewer being handed a checkout nobody wrote.
   */
  assignedTreeFor(runId: string, assignment: { taskId: string; reviewOf?: string }): string {
    return (assignment.reviewOf === undefined
      ? this.candidateFor(runId, assignment.taskId)
      : this.reviewedCandidateFor(runId, assignment.reviewOf)).root;
  }

  /** T043 — whether this run recorded the task as an implementer. */
  private isRunImplementer(runId: string, taskId: string): boolean {
    const row = this.db.prepare(
      `SELECT assignment_json AS assignment FROM team_queue_authority WHERE run_id = ? AND task_id = ?`)
      .get(runId, taskId) as { assignment: string } | undefined;
    if (!row) return false;
    return (JSON.parse(row.assignment) as { role?: string }).role === "implementer";
  }

  /**
   * T043 — enter the candidate a reviewer reviews, or refuse.
   *
   * The reviewed tree is the one its own task would enter, so this goes through the same
   * lookup-and-adopt path `candidateFor` owns. It differs in exactly one way: it passes
   * `adoptOnly`, so a tree a restart left behind is adopted from its control-owned record
   * while a missing one is refused. Staging would hand the reviewer a checkout nobody
   * wrote, which is the defect this task closes.
   */
  private reviewedCandidateFor(runId: string, reviewedTaskId: string, worker?: string): CandidateWorkspace {
    return this.candidateFor(runId, reviewedTaskId, worker, { adoptOnly: true });
  }

  /** T039 — the worker a non-launch accessor falls back to when it has no attempt. */
  private defaultWorkerName(): string {
    if (!this.defaultWorker) throw new Error("Candidate isolation is not configured");
    return this.defaultWorker();
  }

  /**
   * T042 — produce the attempt an admitted assignment launches from.
   *
   * Composes the three things the composed launch chain expects but nothing produced:
   * the KTD24 context projection under the policy's `context_root`, the per-attempt
   * mailbox endpoint in the control-private `mailbox_root`, and the bootstrap the
   * privileged launcher binds beside that socket. T047 attaches the result to a seat.
   *
   * Order matters for the same reason it does in `admitForLaunch`. Admission is the
   * only thing that may say no, and it is asked first: a refused assignment must
   * leave no projection, no endpoint and no attempt, because a projection on disk is
   * evidence of work that never started and an endpoint is a channel a worker could
   * be pointed at. Only after admission is the projection built, then the endpoint —
   * the projection directory's private ancestry is what the bridge's own
   * `checkDirectory` proves, so it has to exist first.
   *
   * One projection per attempt, not per task: an attempt id is the projection's final
   * path component, so a resume asks for the attempt it recorded and gets the bytes
   * that attempt was reviewed under, never today's source.
   */
  async produceManagedAttempt(runId: string, input: ProduceManagedAttemptInput): Promise<ProducedManagedAttempt> {
    // One production per attempt id, including while it is still starting. An attempt is
    // published as soon as it exists so a sibling retirement can see it, which means a duplicate
    // caller must wait for that production rather than receive a half-built endpoint: returning
    // the record while `listen` is still pending would hand out an endpoint that may never
    // listen, and a failed start would then delete the entry under the duplicate's feet.
    //
    // `producing` is the only gate for "one production per attempt id". `managedAttempts` holds
    // only endpoints that finished listening, so a duplicate can never receive a half-started one.
    const inFlight = this.producing.get(input.attemptId);
    if (inFlight) return inFlight;
    const settled = this.managedAttempts.get(input.attemptId);
    if (settled) return settled;
    const production = this.produceManagedAttemptOnce(runId, input);
    this.producing.set(input.attemptId, production);
    try {
      return await production;
    } finally {
      this.producing.delete(input.attemptId);
    }
  }

  private async produceManagedAttemptOnce(runId: string, input: ProduceManagedAttemptInput): Promise<ProducedManagedAttempt> {
    const roots = this.managedAttemptRoots?.();
    if (!roots) throw new Error("Managed attempt production is not configured");
    const { attemptId, worker } = input;
    // An attempt id reaches a filesystem path, so it is validated before admission
    // rather than trusted from whoever supplied it.
    if (![worker, runId, attemptId].every(id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))) {
      throw new Error("Invalid managed attempt identity");
    }
    // T053: the composition is the authority for every input it owns. A caller may still name
    // them, as T042's contract allows, but only a value that agrees with the owner is accepted:
    // silently preferring either side would let a caller pick a seat, capability or identity the
    // run never recorded, which is exactly the grant this task exists to stop issuing twice.
    const owned = this.managedAttemptInputs;
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo);
    const recorded = governance.findTask(runId, input.assignment.taskId);
    if (owned && !recorded) throw new Error("Managed attempt task is not recorded");
    // A seat is a recorded fact, not a caller's claim: the capability and the credential are
    // keyed on `(run, seat)`, so a produce for any other session would mint authority for a
    // seat this task does not have.
    if (recorded) {
      const item = this.queueRepo.getById(recorded.qitemId);
      if (!item || item.destinationSession !== input.sessionId) throw new Error("Managed attempt seat is not the task's destination");
    }
    // The endpoint's mailbox scope is the attempt's task, so the caller cannot name a different
    // one: a task id here that the recorded assignment does not have would register a mailbox
    // for a task this run never admitted.
    if (input.taskId !== input.assignment.taskId) throw new Error("Managed attempt task is not the assignment's task");
    /** The owner's value when it exists; a caller value that disagrees is refused. */
    const agree = <T>(field: string, claimed: T | undefined, owner: T | undefined): T | undefined => {
      if (claimed !== undefined && owner !== undefined && canonicalJson(claimed) !== canonicalJson(owner)) {
        throw new Error(`Managed attempt ${field} disagrees with the composition`);
      }
      return claimed ?? owner;
    };
    if (owned && input.readCredentials) throw new Error("Managed attempt credentials come from the composition");
    // The bridge reads this list on every request, so the token must be live before `listen`
    // writes the bootstrap. Issuance happens inside the try below, where a failure can revoke.
    const readCredentials = owned ? owned.readCredentials : input.readCredentials;
    if (!readCredentials) throw new Error("Managed attempt credentials are not configured");
    const mailboxCapability = agree("mailbox capability", input.mailboxCapability, owned?.mailboxCapability(runId, input.sessionId));
    if (mailboxCapability === undefined) throw new Error("Managed attempt mailbox capability is not configured");
    if (!/^mailbox:[A-Za-z0-9_-]{43}$/.test(mailboxCapability)) throw new Error("Invalid mailbox capability");
    // The identity owner answers the ownership questions a caller cannot: the gid the
    // projection and mailbox are created under, and the uid/groups the manifest uses to prove
    // the projection is worker-readable without being worker-writable.
    const identity = owned?.workerIdentity(worker);
    const workerGid = agree("worker gid", input.workerGid, identity?.gid);
    const workerUid = agree("worker uid", input.context.workerUid, identity?.uid);
    const workerGroups = agree("worker groups", input.context.workerGroups, identity?.groupIds);
    if (workerGid === undefined || workerUid === undefined || workerGroups === undefined) {
      throw new Error("Managed attempt worker identity is not configured");
    }
    const context = { ...input.context, workerUid, workerGroups };
    // The pinned native policy is part of the projection from revision 5 on, and a
    // provisioned host ships revision 5. It is built before admission so a host missing
    // the pinned clients refuses without leaving a claimed candidate behind.
    const nativePolicy = roots.policyRevision >= 5
      ? await buildManagedNativePolicy(input.client, roots.toolchainDir) : undefined;

    const admitted = this.admitForLaunch(runId, { attemptId, worker, assignment: input.assignment,
      outputs: input.outputs, permissions: input.permissions,
      context: { binding: this.managedBinding(runId), runId, role: input.role } as ContextManifest });
    const binding = governance.getRun(runId).binding;
    const root = resolve(roots.contextRoot, worker, runId, attemptId);
    // Declared outside the try because the failure path needs it: only a projection this
    // call created may be removed.
    let resumed = false;
    try {
      // Read before anything else can throw. The failure path below removes only a
      // projection this call created, and an earlier attempt's projection is run
      // evidence that must survive a later refusal — including one decided before the
      // projection work starts, such as a candidate mismatch.
      resumed = existsSync(root);
      // The tree the caller named has to be the one admission just handed this attempt.
      // Admission already resolved it — for a review launch that is the candidate under
      // review — so this compares against its answer rather than re-resolving here, which
      // would let the two disagree about whether a reviewer may create a tree.
      if (admitted.candidate !== input.candidate) {
        // The projection names the tree the worker will work in, so a caller that names
        // another tree would produce a context describing work that cannot happen.
        throw new Error("Managed attempt candidate mismatch");
      }
      // A projection already on disk belongs to the attempt that made it, so it is used
      // as it stands. A new one is created and sealed below.
      if (!resumed) ensureAttemptRoot(root, { contextRoot: roots.contextRoot, worker, workerGid });
      const manifest = this.projectAttemptContext({ runId, root, worker, attemptId, roots, binding,
        role: input.role, client: input.client, assignment: input.assignment, outputs: [...input.outputs],
        permissions: [...input.permissions], context,
        nativePolicy, workerGid, frameworkFiles: input.frameworkFiles, resume: resumed,
        previousContextHash: input.previous?.attemptId === attemptId ? input.previous.contextHash : undefined });

      // An endpoint's path has to fit AF_UNIX's 108 bytes, and it is built from two UUIDs. A
      // provisioned host installs its mailbox root deep enough to afford that; the unisolated
      // root sits under the user's home, where two UUIDs do not. An attempt id is already unique
      // per attempt, so the run segment is what an unisolated endpoint can leave out — nothing
      // else reaches this directory, and the launcher that requires the four-segment shape is
      // not composed on this host.
      const mailboxDirectory = this.sameIdentity
        ? resolve(roots.mailboxRoot, worker, attemptId)
        : resolve(roots.mailboxRoot, worker, runId, attemptId);
      const socketPath = resolve(mailboxDirectory, "mailbox.sock");
      ensureMailboxDirectory(mailboxDirectory,
        { mailboxRoot: roots.mailboxRoot, worker, controlStateDir: roots.controlStateDir }, this.sameIdentity);
      // A socket left by a daemon that died is still a file; the bridge refuses to
      // listen over one, so it is removed first. It can only ever be this attempt's,
      // because the path is built from the attempt id.
      if (existsSync(socketPath)) rmSync(socketPath);
      // Issued once, immediately before the endpoint that authenticates with it, and inside
      // the try so every later failure revokes it below. A token minted and then abandoned
      // would stay live for that seat with no endpoint to bound it.
      if (owned && !owned.hasCredential(runId, input.sessionId)) owned.issueCredential(runId, input.sessionId);
      const bridge = new WorkerMailboxBridge({ socketPath, workerId: worker, sessionId: input.sessionId,
        runId, attemptId, rigId: input.rigId, taskId: input.taskId, recipients: input.recipients,
        capability: mailboxCapability },
      input.delivery, input.chat, readCredentials, input.isCurrent);
      // Claimed for this seat before the endpoint awaits anything, so a sibling attempt retiring
      // during `listen` sees that this seat's credential is in use and does not revoke it. This
      // is a separate record from `managedAttempts` on purpose: that map is what a caller is
      // handed, and an attempt is only published there once its endpoint actually listens. A
      // half-started record in that map is what a duplicate caller would receive.
      const starting = { runId, sessionId: input.sessionId };
      this.startingAttempts.set(attemptId, starting);
      try {
        await bridge.listen();
      } catch (error) {
        this.startingAttempts.delete(attemptId);
        throw error;
      }
      const attempt: ManagedAttempt = { attemptId, deadline: input.deadline, context: manifest,
        ...(input.previous ? { previous: input.previous } : {}) };
      const produced = Object.freeze({ attempt, bridge, candidate: admitted.candidate, manifestDigest: admitted.manifestDigest });
      this.managedAttempts.set(attemptId, produced);
      this.startingAttempts.delete(attemptId);
      return produced;
    } catch (error) {
      // Admission retained the candidate claim when it handed this attempt its tree, so
      // every later failure has to give it back: a claim nobody releases would hold the
      // task's tree for the life of the daemon. A review launch took no claim, so this is
      // the no-op `releaseCandidate` documents — it releases the implementation attempt's
      // own owner key only.
      this.releaseCandidate(runId, input.assignment.taskId, attemptId);
      // A half-written projection would also wedge the attempt id for good: the next
      // produce would find the directory, treat it as a resume, and be refused for an
      // owner-writable root. Only a projection this call created is removed; one that
      // was already there belongs to an earlier attempt and is left as evidence.
      if (!resumed) removeAttemptRoot(root);
      // A credential for an attempt that never started is revoked here: the attempt has no
      // endpoint and no retirement path, so nothing else would ever bound it. The helper only
      // revokes when no sibling attempt of the seat remains, which is what keeps this from
      // taking a token a live attempt is using — including one a *sibling* minted.
      this.revokeSeatCredential(runId, input.sessionId, attemptId);
      throw error;
    }
  }

  /**
   * T053 — revoke a seat's credential only when no other produced attempt of that seat remains.
   *
   * A seat has one credential, so a retirement or a failed production must not take the token a
   * live attempt is authenticating with. `except` names the attempt being removed, which is still
   * in the map while another attempt of the seat may be finishing its own endpoint.
   */
  private revokeSeatCredential(runId: string, sessionId: string, except: string): void {
    const held = (id: string, run: string, session: string) => id !== except && run === runId && session === sessionId;
    const shared = [...this.managedAttempts.entries()].some(([id, other]) =>
      held(id, other.bridge.binding.runId, other.bridge.binding.sessionId))
      || [...this.startingAttempts.entries()].some(([id, other]) => held(id, other.runId, other.sessionId));
    if (!shared) this.onManagedAttemptRetired?.({ runId, sessionId });
  }

  /**
   * T042 — retire a produced attempt: close its endpoint and forget the projection.
   *
   * Closing is what removes the bootstrap and unlinks the socket, so a retired
   * attempt cannot be relaunched against a stale endpoint. The projection stays on
   * disk as run evidence, exactly as `projectContext` documents for failed attempts.
   */
  async retireManagedAttempt(attemptId: string): Promise<void> {
    const produced = this.managedAttempts.get(attemptId);
    if (!produced) return;
    this.managedAttempts.delete(attemptId);
    try {
      await produced.bridge.close();
    } finally {
      // T053: the attempt's worker credential is revoked on the same retirement that closes its
      // endpoint, so the two never outlive each other. In `finally` because a throwing close
      // must not strand the token: by here the entry is gone and nothing else can reach it.
      this.revokeSeatCredential(produced.bridge.binding.runId, produced.bridge.binding.sessionId, attemptId);
    }
  }

  /** T042 — the attempt a seat's launch should attach, if this daemon produced one. */
  managedAttemptFor(attemptId: string): ProducedManagedAttempt | undefined {
    return this.managedAttempts.get(attemptId);
  }

  /**
   * T042 — close every endpoint this daemon owns; a restart owns none of the old ones.
   *
   * T053: a production that is still inside `listen` is not in `managedAttempts` yet, so it has
   * to be drained first — otherwise this returns while an endpoint is still coming up, and that
   * endpoint then publishes and keeps its credential alive past a close that reported success.
   * Awaiting each production settles it either way: a success lands in `managedAttempts` and the
   * loop below retires it; a failure has already cleaned itself up. Retiring before the await,
   * or in parallel with it, would let a success publish after its own retirement had run.
   */
  async closeManagedAttempts(): Promise<void> {
    await Promise.allSettled([...this.producing.values()]);
    await Promise.all([...this.managedAttempts.keys()].map(id => this.retireManagedAttempt(id)));
  }

  /** The approved binding, re-read so a producer call cannot be admitted against a stale one. */
  private managedBinding(runId: string) {
    return new PlanGovernance(this.db, this.eventBus, this.queueRepo).getRun(runId).binding;
  }

  /** Build the attempt's manifest; every entry is written private, read-only and hash-pinned. */
  private projectAttemptContext(input: {
    runId: string; root: string; worker: string; attemptId: string; workerGid: number;
    roots: NonNullable<ReturnType<NonNullable<WorkflowRuntimeDeps["managedAttemptRoots"]>>>;
    binding: PlanBinding; role: TeamRole; client: "claude-code" | "codex";
    assignment: AssignmentInput["assignment"]; outputs: string[]; permissions: string[];
    context: Omit<ContextInput, "root" | "projection" | "runId" | "files" | "binding" | "assignment"
      | "outputs" | "permissions" | "role" | "frameworkRoot" | "frameworkRevision" | "nativePolicy">;
    /** The pinned native policy, present from policy revision 5 on. */
    nativePolicy?: ContextInput["nativePolicy"];
    /** The pinned framework files this attempt loads, already resolved from the pin. */
    frameworkFiles: readonly { path: string; source: string }[];
    /** True when the projection root already exists: rebuild from its own recorded bytes. */
    resume: boolean;
    previousContextHash?: string;
  }): ContextManifest {
    const { roots, root, role, client } = input;
    const frameworkRoot = roots.frameworkRoot;
    // The projection holds more than instructions: the plan the approval bound, the
    // role configuration, the pinned framework entries, and — KTD28 — the shared core
    // and this role's own charter. `createContextManifest` refuses a projection missing
    // any of them, which is the point: the producer cannot quietly omit what a worker
    // is supposed to follow, or substitute today's bytes for the approved ones.
    const write = (name: string, content: string, kind: ContextFile["kind"], source?: string): ContextFile => {
      const path = join(root, name);
      writeFileSync(path, content, { mode: 0o440 });
      chmodSync(path, 0o440);
      return { path, hash: hashBytes(content), kind, readOnly: true as const, ...(source ? { source } : {}) };
    };
    // The projected name keeps the framework entry's own relative path: the catalog is
    // `skills/<name>/SKILL.md`, so a basename would map every entry onto one file. The
    // name is confined to the attempt root, and the source to the pinned framework tree:
    // a caller-named path would otherwise be a write primitive into the boundary this
    // projection sits inside.
    const frameworkName = (path: string) => {
      const normalized = normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");
      if (normalized !== path || normalized.startsWith("../") || isAbsolute(normalized)
        || !/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error("Invalid pinned framework entry path");
      return `framework/${normalized}`;
    };
    const frameworkEntries = () => input.frameworkFiles.flatMap(file => {
      if (!within(frameworkRoot, file.source) || realpathSync(file.source) !== resolve(file.source)) {
        throw new Error("Framework source is outside the pinned framework tree");
      }
      const name = frameworkName(file.path);
      mkdirSync(dirname(join(root, name)), { recursive: true, mode: 0o750 });
      return [write(name, readFileSync(file.source, "utf8"), "framework", file.source)];
    });
    let files: ContextFile[];
    if (input.resume) {
      // An existing projection is adopted as it stands. Rewriting it would fail: the
      // root is sealed and every entry is 0440. Descriptors are rebuilt from the bytes
      // that projection already recorded, and each framework entry keeps pointing at
      // the pinned framework source it was copied from — the manifest re-verifies that
      // source, so a projection copied into the attempt root could not stand in for it.
      files = readProjectedDescriptors(root, input.frameworkFiles);
      // The native policy's expected paths and hashes come from the policy itself, so a
      // resumed projection supplies the same descriptors the creating produce did.
      for (const file of input.nativePolicy?.files ?? []) {
        const path = resolve(root, relative("/context", file.workerPath));
        files.push({ path, hash: file.hash, kind: "native-policy", readOnly: true });
      }
    } else {
      // The pinned native policy is projected like any other entry from revision 5 on:
      // the manifest re-derives the expected paths and hashes from `nativePolicy` and
      // refuses a projection that does not carry exactly those descriptors.
      const nativeEntries = (input.nativePolicy?.files ?? []).map(file => {
        const path = resolve(root, relative("/context", file.workerPath));
        mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
        writeFileSync(path, file.content, { mode: 0o440 });
        chmodSync(path, 0o440);
        return { path, hash: file.hash, kind: "native-policy" as const, readOnly: true as const };
      });
      files = [
        ...frameworkEntries(),
        ...nativeEntries,
        write("plan", readFileSync(join(input.binding.repository.root, input.binding.planRef), "utf8"), "plan"),
        write("role", canonicalJson(roleConfiguration), "role"),
        ...roleInstructionEntries(role).map(([kind, content]) => write(kind, content, kind)),
        // C3 — a lead activation's roster and run instructions. The protocol entry is already
        // written above: `roleInstructionEntries("lead")` projects it as this role's charter,
        // and the manifest requires exactly one. A member role adds nothing here.
        ...(input.context.lead ? [
          write("roster", canonicalJson(input.context.lead.roster), "roster"),
          write("run", input.context.lead.instructions, "run"),
        ] : []),
      ];
      // Sealed only after the entries exist: the manifest refuses a projection root its
      // own owner could still write to, which is what stops anything being added to a
      // projection after it was hashed.
      chmodSync(root, 0o550);
    }
    // The launcher re-checks the whole projection read-only, and it refuses any directory
    // below the worker root that its owner can still write. Sealing only the attempt root
    // would leave every subdirectory (`framework/`, `native/`, …) writable, and the launch
    // would be refused as an unverified context source at the only policy revision a
    // provisioned host carries. So the seal covers everything this producer created.
    sealProjectionTree(root);
    // A resumed attempt is held to the bytes its own projection recorded; a new one must
    // also match today's pinned source. That difference is `recordedContextManifest`'s
    // whole purpose, and it is what keeps a later charter edit from breaking a resume.
    const build = input.resume ? recordedContextManifest : createContextManifest;
    // Sorted so a resumed attempt, whose descriptors come back in directory order, hashes
    // to the same manifest as the one that created it. The hash covers the file list, so
    // an order that depended on how the entries were produced would make every resume
    // look like a changed context.
    files.sort((left, right) => left.path.localeCompare(right.path));
    const input_ = {
      ...input.context,
      // Revision 5 and later requires the pinned native policy, and the manifest also
      // checks that its files are actually projected, so the producer supplies both.
      ...(input.nativePolicy ? { nativePolicy: input.nativePolicy } : {}),
      ...(this.sameIdentity ? { sameIdentity: true } : {}),
      runId: input.runId,
      role,
      client,
      binding: input.binding,
      assignment: { ...input.assignment, role },
      outputs: input.outputs,
      permissions: input.permissions,
      root,
      frameworkRoot,
      frameworkRevision: roots.frameworkRevision,
      projection: { worker: input.worker, attemptId: input.attemptId, controlUid: process.getuid!(),
        workerGid: input.workerGid,
        policy: { policy_revision: roots.policyRevision, worker_identities: [...roots.workerIdentities],
          paths: { context_root: roots.contextRoot, framework_dir: frameworkRoot },
          sandbox: { context: "/context", framework: "/framework" } } },
      files,
    } as ContextInput;
    const manifest = build(input_);
    if (input.resume && input.previousContextHash && manifest.generatedHash !== input.previousContextHash
      && input_.lead?.phase !== undefined && input_.lead.roster.length) {
      // Legacy attempts did not record phase. Adopt that representation only when
      // the complete hash matches this same attempt's receipt; all other checks stand.
      const lead = { ...input_.lead };
      delete lead.phase;
      const legacy = recordedContextManifest({ ...input_, lead });
      if (legacy.generatedHash === input.previousContextHash) return legacy;
    }
    return manifest;
  }

  /** T039 — release a workspace this runtime owns, whichever path handed it back. */
  private removeWorkspace(workspace: CandidateWorkspace): void {
    try { removeCandidateWorkspace(workspace); } catch { /* A removed tree is already released. */ }
  }

  /**
   * T039 — the run's declared work graph, read from its own authority rows.
   *
   * The task being admitted contributes its approved assignment; every other task
   * the run recorded contributes what its row says it claims. A run with more than
   * the managed task limit therefore refuses at admission instead of being
   * discovered unusable later.
   *
   * Only **live** tasks can conflict on a write path. A finished task's claim is
   * history: the work is over, and a later task may legitimately re-touch the same
   * file. Its row still contributes its dependency edges — cycle detection and the
   * task limit are properties of the whole run, not of its live fringe — but it
   * contributes no claim. This is the same "other live tasks" contract
   * `admitTeamAssignment` states for its caller-supplied graph.
   */
  private runGraph(runId: string, admitted: AssignmentInput["assignment"]): GraphTask[] {
    const rows = this.db.prepare(
      `SELECT a.task_id AS taskId, a.assignment_json AS assignment, q.state AS state
       FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
       WHERE a.run_id = ?`)
      .all(runId) as { taskId: string; assignment: string; state: string }[];
    // The repository already names this set: `blocked` is still in play (it can
    // resume), while `handed-off` is terminal, so a local list would both miss a
    // live claim and keep a finished one.
    const live = (state: string) => (ACTIVE_QUEUE_STATES as readonly string[]).includes(state);
    const extensions = new ScopeExtensions(this.db), bindingDigest = new PlanGovernance(this.db, this.eventBus, this.queueRepo).getRun(runId).bindingDigest;
    const extended = (taskId: string) => extensions.records(runId, taskId)
      .filter(record => record.state === "approved" && record.bindingDigest === bindingDigest)
      .flatMap(record => record.paths.flatMap(path => [path.path, path.canonicalPath]));
    const tasks = rows.map(row => {
      const assignment = JSON.parse(row.assignment) as { role?: string; paths?: string[]; dependencies?: string[] };
      return { taskId: row.taskId, role: assignment.role ?? admitted.role,
        // A settled task keeps its edges but drops its claim.
        paths: live(row.state) ? [...(assignment.paths ?? []), ...extended(row.taskId)] : [],
        dependencies: [...(assignment.dependencies ?? [])] };
    });
    // The admitted assignment wins over its stored row: a stale row would otherwise
    // let an earlier, narrower claim stand in for the one about to launch.
    return [...tasks.filter(task => task.taskId !== admitted.taskId),
      { taskId: admitted.taskId, role: admitted.role, paths: [...admitted.paths, ...extended(admitted.taskId)], dependencies: [...admitted.dependencies] }];
  }

  /**
   * T039 — the launcher's full preparation path.
   *
   * The launcher holds the post-preflight assignment, but it must not call
   * `prepareTeamAssignment` itself: the runtime is what supplies the approved
   * binding and the validated-evidence dependency check. This is the same
   * method the lead-activation path uses, so a managed launch cannot observe a
   * different set of rules than any other production caller.
   */
  prepareLaunchAssignment(input: Omit<AssignmentInput, "binding" | "dependencySatisfied">) {
    return this.prepareTeamAssignment(input.context.runId, input);
  }

  prepareTeamAssignment(runId: string, input: Omit<AssignmentInput, "binding" | "dependencySatisfied">) {
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo), run = governance.getRun(runId);
    if (run.state !== "approved" || input.context.runId !== runId || hashBinding(run.binding) !== hashBinding(input.currentBinding)) throw new Error("Run is not approved for this assignment");
    const dependencySatisfied = (taskId: string) => this.dependencySatisfied(governance, runId, taskId);
    return prepareTeamAssignment({ ...input, binding: run.binding, dependencySatisfied });
  }

  /**
   * T011 — admit a task onto the run's work graph.
   *
   * The caller declares what this task claims and depends on plus the claims of
   * the run's other live tasks. The merged graph must hold before the task is
   * prepared, so an unknown edge, a cycle, or a write path two tasks both claim
   * is refused here rather than discovered as work that cannot finish.
   *
   * A caller that supplies no `graph` keeps the previous behavior; the graph is
   * an addition to the launch boundary, not a new precondition on every caller.
   */
  async admitTeamAssignment(runId: string, input: Omit<AssignmentInput, "binding" | "dependencySatisfied" | "taskPack"> & {
    taskPack?: AssignmentInput["taskPack"];
    graph?: { claimedBy: readonly GraphTask[]; declared: { paths: readonly string[]; dependencies: readonly string[] } };
  }) {
    if (input.graph) {
      const { declared, claimedBy } = input.graph;
      const verdict = validateDependencyGraph([...claimedBy.filter(task => task.taskId !== input.assignment.taskId), {
        taskId: input.assignment.taskId,
        role: input.assignment.role,
        paths: [...declared.paths],
        dependencies: [...declared.dependencies],
      }]);
      if (!verdict.ok) throw new Error(`Dependency graph refused: ${verdict.reason}`);
    }
    return this.prepareTeamAssignment(runId, input);
  }

  /**
   * T011 — a dependency is satisfied only by evidence-backed completion.
   *
   * `done` needs validated evidence, the same test the queue gate applies before
   * it unparks a waiter. A `handed-off` task satisfies nothing by itself: it
   * moves responsibility to the successor it names, and that successor's own
   * validated completion is what counts, followed hop by hop. The visited set is
   * the cycle guard, so a handoff chain that closes on itself is unsatisfied
   * rather than an infinite walk.
   */
  private dependencySatisfied(governance: PlanGovernance, runId: string, taskId: string): boolean {
    return dependencySatisfied(this.db, this.queueRepo, qitemId => governance.getTask(qitemId)?.evidence?.validated === true, runId, taskId);
  }
  /**
   * T012 — who the run recorded for a queue item.
   *
   * Identity for review is read from the run's own rows, never from a caller's
   * string. The role comes from the task's authority assignment and the session
   * from the queue item's destination, so naming a different implementer cannot
   * make a self-review look independent (R17).
   */
  private resolveAssignee(runId: string, qitemId: string): AssigneeFacts | null {
    const row = this.db.prepare(`SELECT a.assignment_json AS assignment, q.destination_session AS session
      FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
      WHERE a.run_id = ? AND a.qitem_id = ?`).get(runId, qitemId) as { assignment: string; session: string } | undefined;
    if (!row) return null;
    const assignment = JSON.parse(row.assignment) as { taskId?: unknown; role?: unknown };
    if (typeof assignment.taskId !== "string") return null;
    return { session: row.session, taskId: assignment.taskId, role: assignment.role as TeamRole };
  }

  /** T012 — the review record for a task, folded from the durable team log. */
  reviewState(runId: string, taskId: string) {
    return this.reviewEvidence.state(runId, taskId);
  }

  /** T012 — record the candidate the daemon issued; the only writer that moves the current candidate. */
  issueReviewCandidate(runId: string, rigId: string, taskId: string, identity: CandidateIdentity) {
    return this.events.withNotifyEnvelope(register => this.reviewEvidence.issue({ runId, rigId, taskId, identity, register }));
  }

  /**
   * T012 — record a reviewer's findings.
   *
   * The reviewer is named by its queue item and resolved against the run's own
   * authority rows. The write itself consults the progress gate, so a round the
   * gate refuses is not recorded rather than merely advised against.
   */
  recordReviewEvidence(runId: string, rigId: string, input: Omit<Parameters<ReviewEvidenceLedger["record"]>[0], "runId" | "rigId" | "register">) {
    // Limits and the run clock are read from run state by the ledger's own deps,
    // so no clock figure reaches the write path from a request.
    return this.events.withNotifyEnvelope(register => this.reviewEvidence.record({ ...input, runId, rigId, register }));
  }

  /** T012 — record integrated acceptance for the candidate the task currently holds. */
  recordReviewAcceptance(runId: string, rigId: string, taskId: string, manifestDigest: string, passed: boolean, reason: string) {
    return this.events.withNotifyEnvelope(register =>
      this.reviewEvidence.accept({ runId, rigId, taskId, manifestDigest, passed, reason, register }));
  }

  /** T012 — record that the candidate moved, retiring every earlier review. */
  recordReviewRework(runId: string, rigId: string, taskId: string, identity: CandidateIdentity) {
    return this.events.withNotifyEnvelope(register => this.reviewEvidence.rework({ runId, rigId, taskId, identity, register }));
  }

  /** T012 — KTD9's single diagnosed recoverable retry, counted from durable state. */
  recordReviewRetry(runId: string, rigId: string, taskId: string, reasonCode: string, resumeSafe: boolean) {
    return this.events.withNotifyEnvelope(register => this.reviewEvidence.retry({ runId, rigId, taskId, reasonCode, resumeSafe, register }));
  }

  /**
   * T012 — the two decisions a task's delivery depends on: may another review
   * round start, and is the task deliverable at all. Both are computed here so a
   * caller cannot take a lenient answer from one and cite the other.
   *
   * The remaining clock is read from the run's own binding rather than accepted
   * from the caller, so the time check cannot be switched off by omission.
   */
  reviewProgress(runId: string, taskId: string) {
    const state = this.reviewEvidence.state(runId, taskId);
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo);
    const scope = governance.findTask(runId, taskId) ? governance.scopeForTask(runId, taskId) : undefined;
    return { state, gate: this.progressGate(runId, state), delivery: { ...deliveryVerdict({ state }), ...(scope ? { scope } : {}) } };
  }

  /**
   * T012 — the gate, with its clock derived from the run's own accounting.
   *
   * `active_ms` advances only when a control command runs, so the interval since
   * the last accounting point must be deducted too; otherwise a live attempt
   * would make the run look slower than it is and over-report the time left.
   */
  private progressGate(runId: string, state: ReturnType<ReviewEvidenceLedger["state"]>) {
    const run = new PlanGovernance(this.db, this.eventBus, this.queueRepo).getRun(runId);
    const live = run.accountedAt === null ? 0 : Math.max(0, this.now().getTime() - Date.parse(run.accountedAt));
    const remainingActiveMs = Math.max(0, run.binding.limits.maxActiveMs - run.activeMs - live);
    return evaluateProgressGate({ state, maxRounds: run.binding.limits.maxReviewRounds, remainingActiveMs,
      longestRoundMs: state.longestRoundMs });
  }

  async startLeadActivation(manifest: ContextManifest, observed: ContextObservation, currentBinding: AssignmentInput["currentBinding"]) {
    await this.prepareTeamAssignment(manifest.runId, { currentBinding, assignment: manifest.assignment, outputs: manifest.outputs, permissions: manifest.permissions, context: manifest, observed });
    return new LeadActivation(manifest, observed);
  }

  readonly specCache: WorkflowSpecCache;
  readonly instanceStore: WorkflowInstanceStore;
  readonly trailLog: WorkflowStepTrailLog;
  readonly validator: WorkflowValidator;
  readonly projector: WorkflowProjector;

  private readonly guidanceLibrary?: GuidanceInput["library"];
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly queueRepo: QueueRepository;
  private readonly now: () => Date;
  private readonly watchdogJobsRepo: WatchdogJobsRepository | undefined;
  private readonly exceptionDial?: WorkflowRuntimeDeps["exceptionDial"];
  private readonly events: EventBus;
  private readonly reviewEvidence: ReviewEvidenceLedger;
  /** T039: candidate trees this runtime materialized, keyed by run and task. */
  private readonly candidates = new Map<string, CandidateWorkspace>();
  /** T039 — which attempts still hold each candidate; the tree survives until this is empty. */
  private readonly candidateOwners = new Map<string, Set<string>>();
  /** T039 — the worker whose assignment directory holds each candidate, so reuse cannot cross workers. */
  private readonly candidateWorker = new Map<string, string>();
  /** T039 — candidates refused because the source moved; kept so their owners can still release them. */
  private readonly invalidCandidates = new Set<string>();
  /** T048 — keeps two quarantined directories at one candidate path from colliding. */
  private quarantineSeq = 0;
  private readonly candidateRoot?: WorkflowRuntimeDeps["candidateRoot"];
  private readonly assignmentRoot?: () => string;
  private readonly candidateRecordsRoot?: () => string;
  private readonly defaultWorker?: () => string;
  /** T042 — the roots the producer writes into, read from the installed policy at call time. */
  private readonly managedAttemptRoots?: WorkflowRuntimeDeps["managedAttemptRoots"];
  private readonly managedAttemptInputs?: WorkflowRuntimeDeps["managedAttemptInputs"];
  private readonly onManagedAttemptRetired?: WorkflowRuntimeDeps["onManagedAttemptRetired"];
  /** MVP: the worker is the daemon's own user, so the private-ownership checks are skipped. */
  private readonly sameIdentity: boolean;
  /** T042 — attempt projections and endpoints this daemon produced, keyed by attempt id. */
  private readonly managedAttempts = new Map<string, ProducedManagedAttempt>();
  /** T053 — productions still starting, so a duplicate caller awaits the same one. */
  private readonly producing = new Map<string, Promise<ProducedManagedAttempt>>();
  /**
   * T053 — attempts whose endpoint is still listening, and the seat each will hold. A sibling
   * retirement consults this so it does not revoke a credential an in-flight endpoint needs;
   * it is deliberately not `managedAttempts`, which is the published record a caller receives.
   */
  private readonly startingAttempts = new Map<string, { runId: string; sessionId: string }>();

  constructor(deps: WorkflowRuntimeDeps) {
    this.guidanceLibrary = deps.guidanceLibrary;
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.queueRepo = deps.queueRepo;
    this.now = deps.now ?? (() => new Date());
    this.watchdogJobsRepo = deps.watchdogJobsRepo;
    this.exceptionDial = deps.exceptionDial;
    this.events = deps.eventBus;
    this.candidateRoot = deps.candidateRoot;
    this.assignmentRoot = deps.assignmentRoot;
    this.candidateRecordsRoot = deps.candidateRecordsRoot;
    this.defaultWorker = deps.defaultWorker;
    this.managedAttemptRoots = deps.managedAttemptRoots;
    this.managedAttemptInputs = deps.managedAttemptInputs;
    this.onManagedAttemptRetired = deps.onManagedAttemptRetired;
    this.sameIdentity = deps.sameIdentity === true;
    this.reviewEvidence = new ReviewEvidenceLedger({ db: this.db, events: deps.eventBus, now: this.now,
      resolveAssignee: (runId, qitemId) => this.resolveAssignee(runId, qitemId),
      // The approved binding's limits and the run's own clock, read at write time.
      limits: runId => {
        const run = new PlanGovernance(this.db, deps.eventBus, deps.queueRepo).getRun(runId);
        return { maxRetries: run.binding.limits.maxRetries, maxReviewRounds: run.binding.limits.maxReviewRounds };
      },
      clock: runId => {
        const run = new PlanGovernance(this.db, deps.eventBus, deps.queueRepo).getRun(runId);
        const live = run.accountedAt === null ? 0 : Math.max(0, this.now().getTime() - Date.parse(run.accountedAt));
        return { remainingActiveMs: Math.max(0, run.binding.limits.maxActiveMs - run.activeMs - live) };
      } });
    this.specCache = new WorkflowSpecCache(this.db, this.now);
    this.instanceStore = new WorkflowInstanceStore(this.db, this.now);
    this.trailLog = new WorkflowStepTrailLog(this.db);
    this.validator = new WorkflowValidator();
    this.projector = new WorkflowProjector(
      this.db,
      this.eventBus,
      this.queueRepo,
      this.instanceStore,
      this.trailLog,
      this.specCache,
      this.now,
      this.watchdogJobsRepo,
      deps.exceptionDial,
      deps.guidanceLibrary,
    );
    this.queueRepo.attachWorkflowGuidance(packetId => {
      const packet = this.queueRepo.getById(packetId);
      const instanceId = packet?.tags?.find(tag => tag.startsWith("instance:"))?.slice(9);
      if (!instanceId) return [];
      const guidance = this.guidance(instanceId, {packetId});
      return guidance.state === "unselected" ? [] : guidance.lines;
    });
  }

  inspectGraph(instanceId: string) { return inspectGraph(this.db, instanceId); }
  recoverOperation(key: string) { return recoverGraphOperation(this.db, key); }
  reviseGraph(input: Parameters<typeof reviseGraph>[2]) { return reviseGraph(this.db, this.eventBus, input); }

  compileLifecycle(missionPath: string, operationKey?: string): LifecycleCompilation & { exceptionReadiness?: ExceptionReadiness } {
    const compiled = compileProjectLifecycle({ missionPath, operationKey });
    return { ...compiled, ...(compiled.workflowSpec ? { exceptionReadiness: this.readExceptionReadiness(compiled.workflowSpec,
      exceptionConfigurationSource(compiled.sources.find(s => s.kind === "mission")!.path, compiled.graphSource)) } : {}) };
  }

  private readExceptionReadiness(spec: WorkflowSpec, source: string, boundRig?: string | null, instanceId?: string) {
    return inspectExceptionReadiness({ db: this.db, spec, source, boundRig, instanceId,
      hostDefault: () => this.exceptionDial?.hostDefault() ?? null, humanFallbackSeat: this.exceptionDial?.humanFallbackSeat });
  }

  guidance(instanceId: string, options: Pick<GuidanceInput, "packetId" | "component" | "full"> = {}) {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const spec = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion)?.spec;
    const packetId = options.packetId ?? (instance.currentFrontier.length === 1 ? instance.currentFrontier[0] : undefined);
    if (packetId && !instance.currentFrontier.includes(packetId)) throw new WorkflowProjectorError("packet_not_on_frontier", "Guidance needs a current frontier packet; inspect workflow show first.");
    const packet = packetId ? this.queueRepo.getById(packetId) : null;
    const stepId = packetId ? this.instanceStore.getFrontierBinding(instanceId, packetId)?.stepId ?? (instance.currentFrontier.length === 1 ? instance.currentStepId : null) : null;
    return readWorkflowGuidance({instanceId, contextRefs: spec?.context_refs, binding: instance.lifecycleBinding,
      stepId: stepId ?? undefined, ownerSession: packet?.destinationSession, library: this.guidanceLibrary, ...options, packetId});
  }

  exceptionReadiness(instanceId: string): ExceptionReadiness | null {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const row = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
    if (!row) return null;
    return this.readExceptionReadiness(row.spec, exceptionConfigurationSource(row.sourcePath,
      instance.lifecycleBinding?.graphSource as LifecycleCompilation["graphSource"] | undefined), instance.boundRig, instanceId);
  }

  exceptionObligations(instanceId: string) {
    return (this.db.prepare(`SELECT qitem_id FROM queue_items WHERE json_valid(tags)
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?) ORDER BY ts_created, qitem_id`)
      .all(`instance:${instanceId}`) as Array<{ qitem_id: string }>).map(row => {
        const q = this.queueRepo.getById(row.qitem_id)!;
        return { qitemId: q.qitemId, ownerSession: q.destinationSession, state: q.state,
          evidenceRef: q.evidenceRef, tags: q.tags, handedOffFrom: q.handedOffFrom,
          inspectCommand: "rig queue show " + q.qitemId + " --full --json" };
      });
  }

  async instantiateLifecycle(input: {
    missionPath: string;
    operationKey: string;
    rootObjective: string;
    createdBySession: string;
    entryOwnerSession?: string;
    targetRig?: string;
  }): Promise<InstantiateResult & { compilation: LifecycleCompilation }> {
    if (this.recoverOperation(input.operationKey)?.kind === "revision") {
      throw new WorkflowProjectorError("lifecycle_operation_conflict", "This key already records a graph revision; inspect workflow operation before choosing a new creation key.");
    }
    const compilation = this.compileLifecycle(input.missionPath, input.operationKey);
    if (!compilation.eligible || !compilation.workflowSpec) {
      throw new WorkflowProjectorError(
        "lifecycle_not_eligible",
        "compiled lifecycle is inspectable but not eligible for instantiation",
        { missionPath: input.missionPath, unknowns: compilation.unknowns },
      );
    }
    const result = await this.instantiate({
      specPath: input.missionPath,
      rootObjective: input.rootObjective,
      createdBySession: input.createdBySession,
      entryOwnerSession: input.entryOwnerSession,
      targetRig: input.targetRig,
      compiledLifecycle: compilation,
      lifecycle: {
        operationKey: input.operationKey,
        compiledInputDigest: compilation.compiledInputDigest,
        binding: {
          identity: compilation.identity,
          sources: compilation.sources,
          dependencies: compilation.dependencies,
          graphSource: compilation.graphSource,
          initialInputDigest: compilation.compiledInputDigest,
        },
      },
    });
    return { ...result, compilation };
  }

  /**
   * OPR.0.4.6.WF5 FR-2: resolve the maturity dial for a CACHED spec —
   * the class-(b) detection paths (sweep/keepalive) call this through
   * the startup-injected closure. null = spec not cached (the caller's
   * registered-human selection applies). Uses the SAME preferred_targets[0]
   * string-pick as step-owner resolution (arch Seam-A uniformity).
   */
  resolveExceptionRouteFor(
    workflowName: string,
    workflowVersion: string,
    exceptionClass: WorkflowExceptionClass,
    /** OPR.0.4.6.FAC1 (arch Q3): the instance's bound rig — dial
     *  position 3 (orchestrator-role) then resolves capability-aware
     *  on that rig when the role declares no preferred_targets.
     *  Absent/null = the shipped fleet-blind string-pick only. */
    boundRig?: string | null,
  ): ExceptionRoute | null {
    const specRow = this.specCache.getByNameVersion(workflowName, workflowVersion);
    if (!specRow) return null;
    const spec = specRow.spec;
    const roleCtx = roleResolutionContext(this.db, boundRig ?? null);
    return resolveExceptionRoute({
      exceptionClass,
      spec,
      hostDialDefault: this.exceptionDial?.hostDefault() ?? null,
      resolveRoleTarget: (role) =>
        spec.roles?.[role]?.preferred_targets?.[0] ??
        tryResolveRoleByCapability(roleCtx, role),
      humanFallbackSeat: this.exceptionDial?.humanFallbackSeat,
    });
  }

  /**
   * OPR.0.4.6.WF2 FR-3: the production host-registry probe for the
   * validator — built on the daemon hosts-registry reader (read-only
   * twin of the CLI registry). An unreadable/missing registry reports
   * every id as unregistered with an empty id list (fail-loud at the
   * validator's host_not_registered issue, never a silent pass).
   */
  private hostRegistryLookup: HostRegistryLookupFn = (hostId: string) => {
    const loaded = loadHostRegistry();
    if (!loaded.ok) return { registered: false, registeredIds: [] };
    const ids = loaded.registry.hosts.map((h) => h.id);
    return { registered: ids.includes(hostId), registeredIds: ids };
  };

  /** P19 A4 (finding graduated): the runtime OWNS the default liveness probe —
   *  the hostRegistryLookup sibling precedent. A preferred target is live iff a
   *  session with that exact name is currently `running` in this daemon's DB.
   *  Callers may still inject a custom check (tests, remote-aware futures). */
  private seatLivenessCheck: SeatLivenessCheckFn = (sessionRef: string) => {
    // ADVISORY-NEVER-THROW (the member-advisory precedent): a partial-schema DB
    // (bare fixtures without the sessions table) means the probe cannot vouch
    // EITHER way — report alive so no warning fires, and never let an advisory
    // path fail validate/instantiate.
    try {
      const row = this.db
        .prepare(
          `SELECT s.status AS status FROM sessions s WHERE s.session_name = ? ORDER BY s.created_at DESC LIMIT 1`,
        )
        .get(sessionRef) as { status: string } | undefined;
      if (!row) return { alive: false, reason: "no_session_with_this_name" };
      return row.status === "running" ? { alive: true } : { alive: false, reason: `session_status_${row.status}` };
    } catch {
      return { alive: true };
    }
  };

  validate(specPath: string, seatLivenessCheck?: SeatLivenessCheckFn): ValidationResult & { exceptionReadiness: ExceptionReadiness } {
    const specRow = this.specCache.readThrough(specPath);
    return { ...this.validator.validate(specRow.spec, seatLivenessCheck ?? this.seatLivenessCheck, this.hostRegistryLookup),
      exceptionReadiness: this.readExceptionReadiness(specRow.spec, exceptionConfigurationSource(specRow.sourcePath)) };
  }

  /**
   * Create a workflow instance + first-step qitem. The entry qitem is
   * created in the same transaction as the instance row; subscribers
   * see the workflow.instantiated + queue.created events together.
   */
  async instantiate(input: InstantiateInput): Promise<InstantiateResult> {
    // Replay/conflict classification must precede every cache or queue write.
    // The operation key is the durable outer identity; an exact replay reads
    // the already-cached spec and entry row, while changed bytes refuse with
    // zero mutation.
    if (input.lifecycle) {
      if (!input.lifecycle.operationKey || !input.lifecycle.compiledInputDigest) {
        throw new WorkflowProjectorError(
          "lifecycle_identity_invalid",
          "lifecycle instantiation requires non-empty operationKey and compiledInputDigest",
        );
      }
      const existing = this.instanceStore.getByLifecycleOperationKey(input.lifecycle.operationKey);
      if (existing) {
        if ((existing.lifecycleBinding?.initialInputDigest ?? existing.compiledInputDigest) !== input.lifecycle.compiledInputDigest) {
          throw new WorkflowProjectorError(
            "lifecycle_operation_conflict",
            `lifecycle operation key ${input.lifecycle.operationKey} already binds different compiled input bytes`,
            {
              operationKey: input.lifecycle.operationKey,
              expectedDigest: existing.lifecycleBinding?.initialInputDigest ?? existing.compiledInputDigest,
              attemptedDigest: input.lifecycle.compiledInputDigest,
              instanceId: existing.instanceId,
            },
          );
        }
        const spec = this.specCache.getByNameVersion(existing.workflowName, existing.workflowVersion);
        const entryQitemId = typeof existing.lifecycleBinding?.entryQitemId === "string"
          ? existing.lifecycleBinding.entryQitemId
          : null;
        const entryPacket = entryQitemId ? this.queueRepo.getById(entryQitemId) : null;
        if (!spec || !entryQitemId || !entryPacket) {
          throw new WorkflowProjectorError(
            "lifecycle_replay_indeterminate",
            `lifecycle operation ${input.lifecycle.operationKey} exists but its cached spec or entry packet cannot be resolved`,
            { operationKey: input.lifecycle.operationKey, instanceId: existing.instanceId, entryQitemId },
          );
        }
        return {
          instance: existing,
          spec,
          entryQitemId,
          entryOwnerSession: entryPacket.destinationSession,
          advisories: [],
          replayed: true,
        };
      }
    }
    // OPR.0.3.3.04.1 (AC-3 reachability): a fresh operator runs
    // `workflow instantiate <discovered-name>` (e.g. `conveyor`), not a hidden
    // file path. Resolve the identifier against the seeded spec cache BY NAME
    // first (using the cache's already-resolved stored sourcePath), falling back
    // to treating it as a literal sourcePath only when no named spec matches (an
    // operator-authored spec at an explicit path). Before this, instantiate fed
    // the bare name straight to readThrough -> spec_file_missing.
    const resolvedSpecPath = this.specCache.resolveSourcePathByName(input.specPath) ?? input.specPath;
    const generatedSpec = input.compiledLifecycle?.workflowSpec;
    const specRow = generatedSpec
      ? this.specCache.putGenerated(
          generatedSpec,
          input.compiledLifecycle!.sources.find((source) => source.kind === "mission")?.path ?? resolvedSpecPath,
          input.compiledLifecycle!.compiledInputDigest,
        )
      : this.specCache.readThrough(resolvedSpecPath);
    const validation = this.validator.validate(specRow.spec, this.seatLivenessCheck, this.hostRegistryLookup);
    if (!validation.ok) {
      throw new WorkflowProjectorError(
        "spec_invalid",
        `cannot instantiate: spec ${specRow.name}@${specRow.version} has ${validation.issues.filter((i) => i.severity === "error").length} validation error(s); run validate to inspect`,
        { specPath: input.specPath, issues: validation.issues },
      );
    }
    const entryStep = specRow.spec.steps[0];
    if (!entryStep) {
      throw new WorkflowProjectorError(
        "spec_no_steps",
        `cannot instantiate: spec ${specRow.name}@${specRow.version} has no steps[]`,
        { specPath: input.specPath },
      );
    }


    // OPR.0.4.6.WF2 FR-3: THE v1 execution boundary (the slice-11
    // pattern). A REMOTE host pin is legal LANGUAGE (it validated
    // above) but fails loud HERE — the queue is local-only until MH-3
    // (cross-host queue routing); minting a qitem into a queue that
    // cannot route it, or silently running the step locally, are both
    // forbidden. Checked for EVERY step at instantiate (the earliest
    // knowable moment — a mid-run surprise would strand the instance).
    for (const step of specRow.spec.steps) {
      if (step.host && step.host !== "local") {
        throw new WorkflowProjectorError(
          "host_pin_remote_unsupported",
          `cannot instantiate: step "${step.id}" pins host "${step.host}". Remote-step execution requires MH-3 (cross-host queue routing), which has not shipped — the queue is local-only today. Workaround: run that step's seat on this host (host: local, or drop the pin), or wait for MH-3.`,
          { specPath: input.specPath, stepId: step.id, host: step.host, boundary: "MH-3" },
        );
      }
    }

    // OPR.0.4.6.FAC1 (AC-1) + arch ruling 2026-07-07 (target-rig
    // zero-regression, "Option A refined by PROVENANCE"): resolve the
    // instance's rig binding by SPLITTING on the provenance of the rig
    // name, because the two sources carry different intent:
    //
    //   - Operator `input.targetRig` (explicit `--rig X`) is AUTHORITATIVE:
    //     an explicit instantiation demand. Unknown X → `bound_rig_unknown`
    //     HARD-FAIL, loud, before any mutation (unchanged built behavior).
    //   - Spec-default `spec.target.rig` is ADVISORY: the spec author's
    //     default HINT, authored under the pre-FAC-1 regime where the field
    //     was IGNORED at runtime (display-only). Unknown → DEGRADE to
    //     UNBOUND + a LOUD advisory (not silent, not a hard-fail). This
    //     preserves AC-1 zero-regression for shipped/example specs (e.g.
    //     `conveyor` declares `target.rig: conveyor` AND routes every step
    //     via preferred_targets — degrading to unbound routes exactly as
    //     pre-FAC-1). A spec that genuinely needs a bound rig still fails
    //     loudly, per-step, at the right granularity (entry →
    //     `entry_owner_unresolved` at instantiate; later role-only step →
    //     `next_owner_unresolved` at projection). Nothing degrades to
    //     silence — it degrades to per-step honest failure with a heads-up.
    //   - Neither set → unbound (byte-identical today's behavior).
    //
    // name→id re-resolves fresh at each later resolution site, so a rig
    // vanishing mid-run fails loud there (WF-5 catches it).
    const registeredRigNames = (): string[] =>
      (this.db.prepare(`SELECT DISTINCT name FROM rigs ORDER BY name`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
    const rigIsRegistered = (name: string): boolean =>
      this.db.prepare(`SELECT id FROM rigs WHERE name = ? LIMIT 1`).get(name) !== undefined;

    const advisories: string[] = [];
    let boundRig: string | null;
    if (input.targetRig != null) {
      // AUTHORITATIVE path: honor the operator's explicit demand or fail loud.
      if (!rigIsRegistered(input.targetRig)) {
        const registered = registeredRigNames();
        throw new WorkflowProjectorError(
          "bound_rig_unknown",
          `cannot instantiate: target rig "${input.targetRig}" is not a registered rig on this daemon. Registered rigs: ${
            registered.length > 0 ? registered.join(", ") : "(none)"
          }. Check \`rig ps\`, create/import the rig first, or instantiate with a different --rig.`,
          { specPath: input.specPath, targetRig: input.targetRig, registeredRigs: registered },
        );
      }
      boundRig = input.targetRig;
    } else if (specRow.spec.target?.rig != null) {
      // ADVISORY path: the spec author's DEFAULT hint. Unknown → degrade
      // to unbound with a loud advisory (never a hard-fail on a default).
      const specDefaultRig = specRow.spec.target.rig;
      if (!rigIsRegistered(specDefaultRig)) {
        const registered = registeredRigNames();
        boundRig = null;
        advisories.push(
          `workflow spec default target.rig "${specDefaultRig}" is not a registered rig on this daemon — instantiating UNBOUND. ` +
            `Steps route via their declared preferred_targets; any role-only step (no preferred_targets) will fail per-role at the right time ` +
            `(entry at instantiate, later steps at projection). Pass --rig <name> to bind explicitly. ` +
            `Registered rigs: ${registered.length > 0 ? registered.join(", ") : "(none)"}.`,
        );
      } else {
        boundRig = specDefaultRig;
      }
    } else {
      boundRig = null;
    }

    // OPR.0.4.6.WF2 FR-2: static harness-pin reconciliation for EVERY
    // pinned step at instantiate (the earliest knowable moment against
    // current inventory); projection re-checks at each route (runtimes
    // can change mid-flight).
    //
    // OPR.0.4.6.FAC1 (ARCH Q2 = GUARD B1, binding): this eager loop
    // does NO live role resolution and RECORDS NOTHING. It keeps the
    // shipped harness/preferred-target reconciliation for steps whose
    // role DECLARES targets (spec-only facts — sound to check now); a
    // BOUND instance's role-only step (zero declared targets) is
    // deliberately SKIPPED here — a factory rig warms up, and that
    // step's liveness is its own projection-time concern where
    // loud-with-candidates + WF-5 own the failure. The structural
    // zero-role-coverage check below is the only instantiate-time
    // hard-fail for role-only steps. Unbound specs keep today's
    // behavior byte-identically (a pinned no-target step still fails
    // "(none declared)" at instantiate — nothing could ever resolve it).
    const runtimeOf = (session: string) => nodeRuntimeOf(this.db, session);
    const declaredTargetsOf = (roleName: string): number =>
      (specRow.spec.roles?.[roleName]?.preferred_targets ?? []).length;
    for (const step of specRow.spec.steps) {
      if (step.harness) {
        // rev1-r2 blocker fix: gated steps are NOT excluded — a pinned
        // gated step reconciles through its gate compile (human gates
        // resolve the step owner pin-aware; handler gates match the pin
        // against the handler role's targets). Both throw
        // harness_pin_unsatisfied when no candidate matches.
        if (step.gate) {
          const gateIsHuman = isHumanSeatSession(step.gate.target);
          const gateRoleTargets = gateIsHuman
            ? declaredTargetsOf(step.actor_role)
            : declaredTargetsOf(step.gate.target);
          if (boundRig !== null && gateRoleTargets === 0) continue; // role-only on a bound rig: projection resolves
          compileGate(specRow.spec, step, runtimeOf);
        } else if (!(step === entryStep && input.entryOwnerSession)) {
          if (boundRig !== null && declaredTargetsOf(step.actor_role) === 0) continue;
          resolveDefaultOwner(specRow.spec, step, runtimeOf);
        }
      }
    }

    // OPR.0.4.6.FAC1 (ARCH Q2): the STRUCTURAL role-coverage check for
    // a BOUND instance — hard-fail ONLY when a step's role (or a
    // handler-gate's target role) with zero declared preferred_targets
    // is declared by ZERO seats on the bound rig, at ANY lifecycle
    // state. Existence, not liveness: catches typos and missing role
    // attributes at instantiate WITHOUT eager live resolution. The
    // entry step is included — it resolves live below anyway, but a
    // structural miss reads better as this named error.
    if (boundRig !== null) {
      for (const step of specRow.spec.steps) {
        const rolesToCover: string[] = [];
        if (declaredTargetsOf(step.actor_role) === 0) rolesToCover.push(step.actor_role);
        if (step.gate && !isHumanSeatSession(step.gate.target) && declaredTargetsOf(step.gate.target) === 0) {
          rolesToCover.push(step.gate.target);
        }
        for (const roleName of rolesToCover) {
          if (!rigDeclaresRole(this.db, boundRig, roleName)) {
            throw new WorkflowProjectorError(
              "bound_rig_role_uncovered",
              `cannot instantiate: step "${step.id}" needs role "${roleName}" but NO seat on rig "${boundRig}" declares that role (at any lifecycle state). Add a member with role ${roleName} to rig ${boundRig} (rig add), declare role: ${roleName} on an existing member, or add preferred_targets to the role in the spec. (A declared-but-not-yet-running seat is fine — liveness is checked when the step projects.)`,
              { specPath: input.specPath, stepId: step.id, role: roleName, boundRig },
            );
          }
        }
      }
    }

    // OPR.0.4.6.FAC3 (FR-5): the member-exists instantiate ADVISORY —
    // catch a mis-routed destination (a typo'd/stale member on a rig
    // this daemon DOES know) loudly at the earliest knowable moment,
    // never silently orphaned. ADVISORY-NEVER-DENY: instantiate always
    // proceeds, and the queue transport gate stays rig-exists-only —
    // hardening it to member-exists would gate EVERY queue write and
    // break legitimate non-managed destinations (adopted seats, human
    // seats, MH-3-forwarded items). A read-only pre-txn pass over
    // spec-declared targets; sync SQL only.
    //
    // Scope = roles REFERENCED BY STEPS (actor_role + a handler gate's
    // target role — the same reference set the structural coverage
    // check above walks): the advisory must name a declaring step, and
    // an unreferenced role's targets never route. Skip order per the
    // queue-gate archetype: human-seat classifier BEFORE parse (the
    // identical predicate the transport uses) → non-canonical
    // (raw/adopted destinations are legitimate; the inventory cannot
    // vouch for them) → unregistered rig (the transport already rejects
    // those loudly at queue-write — no double advisory) → member probe
    // (existence at ANY lifecycle state/kind; liveness is projection's
    // business). ONE aggregated advisory per unique unknown target,
    // naming every declaring step/role pair.
    {
      const unknownTargets = new Map<
        string,
        { rig: string; declaredBy: Array<{ stepId: string; role: string }> }
      >();
      const seenPairs = new Set<string>();
      const probeRoleTargets = (roleName: string, stepId: string): void => {
        for (const target of specRow.spec.roles?.[roleName]?.preferred_targets ?? []) {
          if (isHumanSeatSession(target)) continue;
          const parsed = parseSessionName(target);
          if (parsed.kind !== "canonical") continue;
          if (!rigIsRegistered(parsed.rig)) continue;
          let memberExists: boolean;
          try {
            memberExists = rigMemberExists(this.db, parsed.rig, target);
          } catch {
            // ADVISORY-NEVER-THROW (VM-caught, run-1): the probe rides the
            // full inventory projection, which can error on a
            // partial-schema DB (e.g. a test fixture without the snapshots
            // table). A probe error means the inventory cannot vouch
            // EITHER way — skip silently; an advisory path must never be
            // able to fail the instantiate.
            continue;
          }
          if (memberExists) continue;
          const pairKey = JSON.stringify([target, stepId, roleName]);
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);
          const entry = unknownTargets.get(target) ?? { rig: parsed.rig, declaredBy: [] };
          entry.declaredBy.push({ stepId, role: roleName });
          unknownTargets.set(target, entry);
        }
      };
      for (const step of specRow.spec.steps) {
        probeRoleTargets(step.actor_role, step.id);
        if (step.gate && !isHumanSeatSession(step.gate.target)) {
          probeRoleTargets(step.gate.target, step.id);
        }
      }
      for (const [target, { rig, declaredBy }] of unknownTargets) {
        const declares = declaredBy
          .map((d) => `step "${d.stepId}" (role "${d.role}")`)
          .join(", ");
        advisories.push(
          `preferred target "${target}" names rig "${rig}" (registered) but NO member of that rig has this coordinate — declared by ${declares}. ` +
            `Work routed there will not be claimed; it will surface as a stuck exception. ` +
            `Check the member name against \`rig ps\`, or add the member to rig "${rig}".`,
        );
      }
    }

    // OPR.0.4.6.WF2 FR-5: a gated ENTRY step compiles to the gate item
    // (human-routed or handler-routed) and the instance parks waiting
    // from birth — same socket as a mid-flow gate.
    // OPR.0.4.6.FAC1 (ARCH Q2/call-site row 3): the ENTRY step gets
    // FULL live resolution at instantiate and is RECORDED — the entry
    // packet is actually created now (the first routing decision), so
    // this is resolve-once, not eager pre-resolution. A tier-3 failure
    // here re-throws under the entry error code, candidates preserved.
    const entryRoleCtx = roleResolutionContext(this.db, boundRig);
    let entryGate: GateCompileResult | null;
    let entryOwner: string | null;
    try {
      entryGate = entryStep.gate
        ? compileGate(specRow.spec, entryStep, runtimeOf, entryRoleCtx)
        : null;
      if (entryGate) {
        entryOwner = entryGate.destinationSession;
      } else if (input.entryOwnerSession) {
        reconcileExplicitOwnerHarness(entryStep, input.entryOwnerSession, runtimeOf);
        entryOwner = input.entryOwnerSession;
      } else {
        entryOwner = resolveDefaultOwner(specRow.spec, entryStep, runtimeOf, entryRoleCtx);
      }
    } catch (err) {
      if (err instanceof WorkflowProjectorError && err.code === "next_owner_unresolved") {
        // entry_owner_unresolved SPEAKS CANDIDATES: same structured
        // details, the entry site's error-code contract preserved.
        throw new WorkflowProjectorError(
          "entry_owner_unresolved",
          `cannot instantiate: ${err.message}`,
          { specPath: input.specPath, entryStepId: entryStep.id, entryRole: entryStep.actor_role, ...(err.details ?? {}) },
        );
      }
      throw err;
    }
    if (!entryOwner) {
      throw new WorkflowProjectorError(
        "entry_owner_unresolved",
        `cannot instantiate: entry step "${entryStep.id}" (role "${entryStep.actor_role}") has no preferred_targets and no entryOwnerSession was supplied`,
        { specPath: input.specPath, entryStepId: entryStep.id, entryRole: entryStep.actor_role },
      );
    }

    const createdAt = this.now().toISOString();
    const preallocatedEntryQitemId = newQitemId();
    let entryQitemId: string | undefined;
    let entryQitemDestinationSession: string | undefined;
    let entryQitemNudge: boolean | undefined;
    let instanceId: string | undefined;
    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.create({
        workflowName: specRow.name,
        workflowVersion: specRow.version,
        createdBySession: input.createdBySession,
        initialFrontier: [],
        // R2 fix: set durable current_step_id at instantiate so the
        // projector resolves the correct step on the first project()
        // call without any trail-based inference.
        currentStepId: entryStep.id,
        // OPR.0.4.6.FAC1: the resolved rig binding persists with the
        // instance row (same txn as the entry packet).
        boundRig,
        lifecycle: input.lifecycle
          ? {
              ...input.lifecycle,
              binding: { ...input.lifecycle.binding, entryQitemId: preallocatedEntryQitemId },
            }
          : undefined,
      });
      instanceId = instance.instanceId;

      // Create entry qitem in the same txn (gate-aware: a gated entry
      // rides the shipped human-route / handler-route write path).
      // OPR.0.4.6.WF5 FR-1 class (c) (guard code-review fold — the entry
      // twin of the projector's mid-flow stamp): a HUMAN-gated ENTRY
      // carries the class-(c) exception identity on the WF-2 item
      // itself, occurrence = the preallocated packet id. Handler-role
      // entries stay negative.
      const entryGateQitemId = preallocatedEntryQitemId;
      const entryGateException =
        entryGate && entryGateQitemId
          ? classifyGateTrip({
              workflowName: specRow.name,
              instanceId: instance.instanceId,
              gatedStepId: entryStep.id,
              gateKind: entryGate.kind,
              gatePacketId: entryGateQitemId,
              parkOn: entryGate.parkOn,
            })
          : null;
      const created = this.queueRepo.createWithinTransaction({
        qitemId: entryGateQitemId,
        sourceSession: input.createdBySession,
        destinationSession: entryOwner,
        body: workflowInstantiateBody({
          binding: instance.lifecycleBinding,
          library: this.guidanceLibrary,
          spec: specRow.spec,
          instanceId: instance.instanceId,
          entryStep,
          rootObjective: input.rootObjective,
          gate: entryGate,
          packetId: entryGateQitemId,
          ownerSession: entryOwner,
        }),
        priority: "routine",
        tier: entryGate?.tier ?? "mode2",
        tags: [
          "workflow",
          entryGate ? "gate" : "entry",
          `workflow:${specRow.name}`,
          `instance:${instance.instanceId}`,
          ...(entryGateException ? workflowExceptionTags(entryGateException.identity).filter((t) => !t.startsWith("workflow:") && !t.startsWith("instance:")) : []),
        ],
        summary: entryGate?.summary ?? undefined,
        evidenceRef: entryGate?.evidenceRef ?? undefined,
      });
      entryQitemId = created.qitemId;
      entryQitemDestinationSession = created.destinationSession;
      entryQitemNudge = created.nudge;
      register(created.persistedEvent);

      const packetAddressed = specRow.spec.steps.some((step) => step.depends_on !== undefined);
      if (packetAddressed) {
        this.instanceStore.bindFrontierPacket({
          instanceId: instance.instanceId,
          packetId: created.qitemId,
          stepId: entryStep.id,
        });
      }

      // OPR.0.4.6.WF2 FR-5 (guard blocker 1): a HUMAN-gated ENTRY parks
      // in the same txn — the leg-1 blocked_on human-seat shape the
      // shipped resolve verb acts on (same as the projector's mid-flow
      // gate park).
      if (entryGate?.parkOn) {
        const parked = this.queueRepo.updateWithinTransaction({
          qitemId: created.qitemId,
          actorSession: input.createdBySession,
          state: "blocked",
          closureReason: "blocked_on",
          closureTarget: entryGate.parkOn,
          blockedOn: entryGate.parkOn,
          transitionNote: `workflow gate: parked on ${entryGate.parkOn} pending sign-off`,
        });
        register(parked.persistedEvent);
      }

      this.instanceStore.updateFrontier(instance.instanceId, [created.qitemId], entryGate ? "waiting" : "active", {
        // FR-5: guarded even here — the instance was created in this
        // txn at version 0; uniformity keeps every advance guarded.
        expectedVersion: instance.version,
      });

      // FR-3: arm the packet-addressed keepalive (or legacy instance job)
      // INSIDE the same txn that creates the entry packet. This covers the
      // commit-then-crash-before-nudge window from the very first step.
      if (this.watchdogJobsRepo) {
        ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
          instanceId: instance.instanceId,
          targetSession: entryOwner,
          registeredBySession: input.createdBySession,
          packetId: packetAddressed ? created.qitemId : undefined,
        });
      }

      register(
        this.eventBus.persistWithinTransaction({
          type: "workflow.instantiated",
          instanceId: instance.instanceId,
          workflowName: specRow.name,
          workflowVersion: specRow.version,
          createdBy: input.createdBySession,
        }),
      );
    });
    if (entryQitemId && entryQitemDestinationSession) {
      await this.queueRepo.maybeNudge(entryQitemId, entryQitemDestinationSession, entryQitemNudge);
    }

    const finalInstance = this.instanceStore.getByIdOrThrow(instanceId!);
    return {
      instance: finalInstance,
      spec: specRow,
      entryQitemId: entryQitemId!,
      entryOwnerSession: entryOwner,
      advisories,
      replayed: false,
    };
  }

  async project(input: ProjectStepInput): Promise<ProjectStepResult> {
    const result = await this.projector.project(input);
    this.reconcileStuckExceptions(input.instanceId);
    return result;
  }

  /** Recheck each recorded overdue packet, never a sibling's verdict. The
   * decision and closure share a transaction; boot repairs a crash after project. */
  reconcileStuckExceptions(instanceId?: string): number {
    let closed = 0;
    this.eventBus.withNotifyEnvelope((register) => {
      const rows = this.db.prepare(`SELECT qitem_id, tags FROM queue_items
        WHERE state IN ('pending','in-progress','blocked') AND json_valid(tags)
          AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
          AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'exception:stuck_overdue')
          AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?))`
      ).all(instanceId ?? null, `instance:${instanceId}`) as Array<{ qitem_id: string; tags: string }>;
      for (const row of rows) {
        const tags: unknown = JSON.parse(row.tags);
        if (!Array.isArray(tags)) continue;
        const one = (prefix: string): string | undefined => {
          const values = tags.filter((tag) => typeof tag === "string" && tag.startsWith(prefix));
          return values.length === 1 ? values[0]!.slice(prefix.length) : undefined;
        };
        const id = one("instance:");
        const packetId = one("occurrence:");
        if (!id || !packetId) continue;
        const instance = this.instanceStore.getById(id);
        const packet = this.queueRepo.getById(packetId);
        // Unknown or conflicting provenance cannot certify recovery.
        if (!instance || !packet || one("workflow:") !== instance.workflowName
          || !packet.tags?.includes(`instance:${id}`)
          || !packet.tags?.includes(`workflow:${instance.workflowName}`)) continue;
        if (!["active", "waiting", "completed", "failed", "aborted"].includes(instance.status)) continue;
        const live = instance.currentFrontier.includes(packetId)
          && (instance.status === "active" || instance.status === "waiting");
        if (live) {
          const anchor = packet.state === "in-progress"
            ? packet.closureRequiredAt ?? packet.claimedAt ?? packet.tsCreated : packet.tsCreated;
          if (!Number.isFinite(Date.parse(anchor))) continue;
          const binding = this.instanceStore.getFrontierBinding(id, packetId);
          const verdict = evaluateStepDeadline({ ...instance, currentFrontier: [packetId],
            currentStepId: binding?.stepId ?? instance.currentStepId }, [packet], this.now());
          if (verdict.state !== "healthy") continue;
        }
        const updated = this.queueRepo.updateWithinTransaction({
          qitemId: row.qitem_id, actorSession: instance.createdBySession,
          state: "done", closureReason: "no-follow-on",
          transitionNote: `workflow overdue occurrence resolved: instance ${id}, packet ${packetId}; ${live ? `packet is ${packet.state} and no longer overdue` : "packet is no longer an active frontier obligation"}`,
        });
        register(updated.persistedEvent);
        closed += 1;
      }
    });
    return closed;
  }

  inspect(instanceId: string): {
    instance: WorkflowInstance;
    frontier: Array<{
      packetId: string;
      stepId: string | null;
      ownerSession: string | null;
      queueState: string | null;
      blockedOn: string | null;
      targetedAction: "project" | "route" | "indeterminate";
      dependsOn: string[];
      gate: WorkflowStepSpec["gate"] | null;
      acceptance: WorkflowStepSpec["acceptance"] | null;
      receiptRequired: boolean;
      deadline: WorkflowDeadlineVerdict;
      waiting: import("./queue-waiting.js").WaitingView | null;
    }>;
    failures: Array<WorkflowFailureOccurrence & { targetedAction: "resume" | "none" }>;
    unknowns: string[];
    boundaryObligations: LifecycleObligation[];
  } {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const unknowns: string[] = [];
    const spec = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion)?.spec;
    const frontier = instance.currentFrontier.map((packetId) => {
      const binding = this.instanceStore.getFrontierBinding(instanceId, packetId);
      const packet = this.queueRepo.getById(packetId);
      const stepId = binding?.stepId ?? (instance.currentFrontier.length === 1 ? instance.currentStepId : null);
      const step = stepId ? spec?.steps.find((candidate) => candidate.id === stepId) : undefined;
      if (!binding && instance.currentFrontier.length > 1) unknowns.push(`frontier packet ${packetId} has no unique step binding`);
      if (!packet) unknowns.push(`frontier packet ${packetId} has no queue row`);
      return {
        packetId,
        stepId,
        ownerSession: packet?.destinationSession ?? null,
        queueState: packet?.state ?? null,
        blockedOn: packet?.blockedOn ?? null,
        waiting: packet?.waiting ?? null,
        targetedAction: stepId && packet ? "project" as const : "indeterminate" as const,
        dependsOn: step?.depends_on ?? [],
        gate: step?.gate ?? null,
        acceptance: step?.acceptance ?? null,
        receiptRequired: stepId !== null && requiredLifecycleSteps(instance.lifecycleBinding).includes(stepId),
        deadline: evaluateStepDeadline(
          { ...instance, currentFrontier: [packetId], currentStepId: stepId },
          packet ? [packet] : [],
          this.now(),
        ),
      };
    });
    const failureResumeAvailable = instance.status !== "completed" && instance.status !== "aborted";
    const failures = this.instanceStore.listFailureOccurrences(instanceId).map((failure) => ({
      ...failure,
      targetedAction: failure.status === "unresolved" && failureResumeAvailable
        ? "resume" as const
        : "none" as const,
    }));
    return { instance, frontier, failures, unknowns, boundaryObligations: lifecycleObligations(this.db, instanceId, instance.lifecycleBinding, spec?.steps ?? [], instance.currentFrontier) };
  }

  async abort(input: { instanceId: string; reason: string; actorSession: string }): Promise<{
    instanceId: string;
    closedPacketIds: string[];
    status: "aborted";
  }> {
    if (!input.reason.trim()) {
      throw new WorkflowProjectorError("abort_reason_required", "workflow abort requires a non-empty reason");
    }
    const closedPacketIds: string[] = [];
    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status === "completed" || instance.status === "aborted") {
        throw new WorkflowProjectorError("instance_not_abortable", `instance ${instance.instanceId} is ${instance.status}`, { instanceId: instance.instanceId, status: instance.status });
      }
      const spec = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion)?.spec;
      const bindingByPacket = new Map(this.instanceStore.listFrontierBindings(instance.instanceId).map((binding) => [binding.packetId, binding]));
      const closedAt = this.now().toISOString();
      for (const packetId of instance.currentFrontier) {
        const packet = this.queueRepo.getById(packetId);
        if (!packet) throw new WorkflowProjectorError("packet_not_found", `frontier packet ${packetId} not found`, { instanceId: instance.instanceId, packetId });
        const binding = bindingByPacket.get(packetId);
        const stepId = binding?.stepId ?? (instance.currentFrontier.length === 1 ? instance.currentStepId : null);
        if (!stepId) throw new WorkflowProjectorError("frontier_binding_indeterminate", `cannot abort: packet ${packetId} has no step binding`, { instanceId: instance.instanceId, packetId });
        const step = spec?.steps.find((candidate) => candidate.id === stepId);
        const closed = this.queueRepo.updateWithinTransaction({
          qitemId: packetId,
          actorSession: input.actorSession,
          viaWorkflowVerb: true,
          state: "canceled",
          transitionNote: `workflow abort by ${input.actorSession}: ${input.reason}`,
        });
        register(closed.persistedEvent);
        this.trailLog.record({
          instanceId: instance.instanceId,
          stepId,
          stepRole: step?.actor_role ?? "unknown",
          closedAt,
          closureReason: "failed",
          closureEvidence: { abort: { reason: input.reason, actorSession: input.actorSession } },
          actorSession: input.actorSession,
          nextQitemId: null,
          priorQitemId: packetId,
        });
        this.instanceStore.removeFrontierBinding(instance.instanceId, packetId);
        closedPacketIds.push(packetId);
      }
      this.instanceStore.updateFrontier(instance.instanceId, [], "aborted", {
        currentStepId: "clear",
        completedAt: closedAt,
        expectedVersion: instance.version,
        lastContinuationDecision: { action: "abort", actorSession: input.actorSession, reason: input.reason, closedPacketIds },
      });
      if (this.watchdogJobsRepo) disarmAllWorkflowKeepalives(this.watchdogJobsRepo, instance.instanceId, `workflow_aborted: ${input.reason}`);
      register(this.eventBus.persistWithinTransaction({ type: "workflow.failed", instanceId: instance.instanceId, workflowName: instance.workflowName, reason: `aborted: ${input.reason}` }));
    });
    return { instanceId: input.instanceId, closedPacketIds, status: "aborted" };
  }

  /**
   * OPR.0.4.6.WF3 FR-4 — `route`: re-target the CURRENT FRONTIER step
   * of a live instance to a new owner. THE ADJUDICATED MECHANISM
   * (arch, formal, on the advance-authority ground): CLOSE + RECREATE
   * + FRONTIER REBIND in ONE scribe transaction. Revocation is
   * STRUCTURAL: the old packet leaves the frontier inside this txn, so
   * a zombie old owner's stale `project` hits the shipped
   * `packet_not_on_frontier` 409 — zero new validation machinery on
   * the hot advance path (the weighed-and-rejected alternative).
   *
   * The observable contract (PRD FR-4 (1)-(8)):
   *   (1) owner = target after route      (5) frontier non-dangling
   *   (2) current_step_id UNCHANGED       (6) additive event detail
   *   (3) actor+reason+old→new durable    (7) pin + version guard held
   *   (4) NO forged completion closure    (8) zombie structurally 409'd
   * Route is NOT an advance: hop_count does not bump (max_hops counts
   * steps, not re-targets); BR-3 — `project` stays the sole advance.
   */
  /**
   * OPR.0.4.6.WF5 FR-4 — RESUME from where it stopped (redrive
   * semantics, the one engine extension). One scribe transaction:
   * failed → active REBOUND to the failed step, a FRESH frontier packet
   * to the step's RE-RESOLVED owner, the trail preserved and extended
   * (completed steps never re-run), the livelock rail re-baselined
   * (hops-since-resume — exactly one more bounded window), the redrive
   * count recorded, open exception items for THIS occurrence closed
   * (resolve+resume closes the occurrence; a later re-failure is a NEW
   * occurrence), keepalive re-armed, additive workflow.resumed event.
   *
   * THE ARCH PIN (plan Rev-2, binding): the owner is RE-RESOLVED
   * through the SAME resolution path projection uses
   * (resolveDefaultOwner — preferred_targets + harness reconciliation),
   * NEVER copied from the closed packet's recorded destination: a dead
   * seat is a common CAUSE of the exception, and resume is the one
   * sanctioned re-resolution point (FAC-1 R1) the binding layer later
   * upgrades uniformly.
   */
  async resume(input: {
    instanceId: string;
    occurrenceId?: string;
    decision?: string;
    actorSession: string;
  }): Promise<{
    instanceId: string;
    stepId: string;
    newPacketId: string;
    ownerSession: string;
    resumeCount: number;
    exceptionItemsClosed: number;
    absorbedReplay?: boolean;
  }> {
    const occurrences = this.instanceStore.listFailureOccurrences(input.instanceId);
    if (input.occurrenceId || occurrences.length > 0) {
      return this.resumeFailureOccurrence(input);
    }
    let result!: {
      instanceId: string;
      stepId: string;
      newPacketId: string;
      ownerSession: string;
      resumeCount: number;
      exceptionItemsClosed: number;
    };
    let nudgeTo: { qitemId: string; session: string; nudge: boolean | undefined } | null = null;

    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status !== "failed") {
        throw new WorkflowProjectorError(
          "instance_not_failed",
          `instance ${instance.instanceId} is ${instance.status}; resume re-drives FAILED instances only (a waiting instance resumes via the shipped project path; an active instance needs no resume)` ,
          { instanceId: instance.instanceId, status: instance.status, expectedStatus: "failed" },
        );
      }
      const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
      if (!specRow) {
        throw new WorkflowProjectorError(
          "spec_not_cached",
          `workflow spec ${instance.workflowName}@${instance.workflowVersion} is not in the spec cache; re-run validate to refresh it before resuming`,
          { workflowName: instance.workflowName, workflowVersion: instance.workflowVersion },
        );
      }
      const spec = specRow.spec;
      const decision = (instance.lastContinuationDecision ?? {}) as {
        currentStep?: string;
        closedPacket?: string;
      };
      const failedStepId = decision.currentStep;
      const failedPacketId = decision.closedPacket;
      if (!failedStepId) {
        throw new WorkflowProjectorError(
          "resume_step_unrecoverable",
          `instance ${instance.instanceId} carries no recorded failed step (pre-R2 row without lastContinuationDecision.currentStep); cannot rebind — instantiate a fresh run`,
          { instanceId: instance.instanceId },
        );
      }
      const step = spec.steps.find((st) => st.id === failedStepId);
      if (!step) {
        throw new WorkflowProjectorError(
          "resume_step_missing_from_spec",
          `failed step "${failedStepId}" no longer exists in ${instance.workflowName}@${instance.workflowVersion}; fix the spec (the cached version is authoritative for in-flight instances) or instantiate a fresh run`,
          { instanceId: instance.instanceId, stepId: failedStepId },
        );
      }

      // THE ARCH PIN: re-resolve, never copy.
      // OPR.0.4.6.FAC1 (call-site row 5): resume is the ONE sanctioned
      // re-resolution point and now runs the full tier stack — a bound
      // instance's role-only failed step re-resolves capability-aware
      // against CURRENT inventory (a dead seat is a common CAUSE of the
      // exception; the redrive picks the seat that is eligible NOW).
      const owner = resolveDefaultOwner(
        spec,
        step,
        (session) => nodeRuntimeOf(this.db, session),
        roleResolutionContext(this.db, instance.boundRig),
      );
      if (!owner) {
        throw new WorkflowProjectorError(
          "next_owner_unresolved",
          `cannot resolve an owner for failed step "${step.id}" (role "${step.actor_role}"); add preferred_targets to the role before resuming`,
          { instanceId: instance.instanceId, stepId: step.id, role: step.actor_role },
        );
      }

      // Fresh frontier packet — the redrive delivery. The --decision
      // text lands durably in the packet body (the resumer’s
      // instruction reaches the step owner).
      const redrivePacketId = newQitemId();
      const created = this.queueRepo.createWithinTransaction({
        qitemId: redrivePacketId,
        sourceSession: input.actorSession,
        destinationSession: owner,
        body: withWorkflowContinuation({
          binding: instance.lifecycleBinding,
          library: this.guidanceLibrary,
          body:
            `WORKFLOW RESUME (redrive)\n` +
            `workflow: ${instance.workflowName} v${instance.workflowVersion}\n` +
            `instance: ${instance.instanceId}\n` +
            `step: ${step.id} (role ${step.actor_role}) — re-driven from the recorded failure; completed steps are NOT re-run\n` +
            `resumed by: ${input.actorSession} (redrive #${(instance.resumeCount ?? 0) + 1})\n` +
            (input.decision ? `decision: ${input.decision}\n` : "") +
            `history: rig workflow trace ${instance.instanceId}`,
          instanceId: instance.instanceId,
          packetId: redrivePacketId,
          ownerSession: owner,
          step,
          contextRefs: specRow.spec.context_refs,
        }),
        priority: "routine",
        tier: "mode2",
        tags: [
          "workflow",
          "resume",
          `workflow:${instance.workflowName}`,
          `instance:${instance.instanceId}`,
        ],
        chainOfRecord: failedPacketId ? [failedPacketId] : undefined,
      });
      register(created.persistedEvent);
      nudgeTo = { qitemId: created.qitemId, session: created.destinationSession, nudge: created.nudge };
      // P34: stage the redrive packet's wake intent inside this transaction.
      this.queueRepo.stageWakeIntent(
        created.qitemId,
        input.actorSession,
        created.destinationSession,
        null,
        created.nudge,
      );

      // Resolve+resume CLOSES the occurrence: open exception items for
      // THIS episode close honestly with resume provenance. A later
      // re-failure mints a NEW packet id = a NEW occurrence (never
      // hidden behind this resolved past).
      const exceptionItemsClosed = failedPacketId
        ? this.closeFailureExceptions(instance.instanceId, failedPacketId, step.id, input, register)
        : 0;

      // Frontier rebind + status + THE LIVELOCK RAIL: hops_baseline =
      // hopCount at resume (one fresh bounded window under the same
      // max_hops), resume_count recorded, version guard held
      // (concurrent resumes: exactly one commits).
      this.instanceStore.updateFrontier(instance.instanceId, [created.qitemId], "active", {
        currentStepId: step.id,
        expectedVersion: instance.version,
        resumeStamp: {
          resumeCount: (instance.resumeCount ?? 0) + 1,
          hopsBaseline: instance.hopCount,
        },
      });

      // Keepalive re-arm for the redriven owner (in-txn, WF-1 FR-3).
      if (this.watchdogJobsRepo) {
        ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
          instanceId: instance.instanceId,
          targetSession: owner,
          registeredBySession: input.actorSession,
        });
      }

      register(
        this.eventBus.persistWithinTransaction({
          type: "workflow.resumed",
          instanceId: instance.instanceId,
          workflowName: instance.workflowName,
          stepId: step.id,
          resumedBy: input.actorSession,
          decision: input.decision ?? null,
          resumeCount: (instance.resumeCount ?? 0) + 1,
        }),
      );

      result = {
        instanceId: instance.instanceId,
        stepId: step.id,
        newPacketId: created.qitemId,
        ownerSession: owner,
        resumeCount: (instance.resumeCount ?? 0) + 1,
        exceptionItemsClosed,
      };

      // P34 (site :791) — NO SEAM ASSERT HERE, deliberately.
      //
      // Canonical correction, transition 5764 on qitem-20260809175537-8e25384f:
      // "Intent goes on :791; the assert runs only where a real source->successor
      // pair exists." This transaction has no such pair. The N exception closes
      // above are terminal closes with NO successor of their own (`no-follow-on`),
      // and the redrive packet's own predecessor — the failed packet — was closed
      // in an EARLIER transaction, not this one.
      //
      // Anchoring the seam on one of those closes against this packet would pair a
      // close with a successor that is not its own: the assert would pass because
      // the intent for an UNRELATED successor exists, so it could never fail. That
      // is the exact pairing 5764 forbids, and a prior revision of this file did
      // it once rather than N times, which made it no less vacuous.
      //
      // The redrive packet's wake is still DURABLE — stageWakeIntent above commits
      // it atomically with this transaction. What is absent is a paired close for
      // the seam to roll back against, and inventing one would buy a green check
      // that asserts nothing.
    });
    // Closure-assignment cast (the shipped post-commit idiom): TS cannot
    // track the txn-closure write, so narrow via the cast.
    const resumeNudge = nudgeTo as { qitemId: string; session: string; nudge: boolean | undefined } | null;
    if (resumeNudge) {
      // P34: deliver via the SHARED staged-intent path (claims + finalizes the
      // row staged in the txn, so recovery cannot re-send it); falls back to the
      // best-effort nudge when no intent store is attached.
      await this.queueRepo.deliverWakeForSuccessor(
        resumeNudge.qitemId,
        resumeNudge.session,
        resumeNudge.nudge,
        input.actorSession,
      );
    }
    return result;
  }

  /** Called inside the redrive transaction; only this instance's failed packet is resolved. */
  private closeFailureExceptions(
    instanceId: string,
    failedPacketId: string,
    stepId: string,
    input: { actorSession: string; decision?: string },
    register: (event: PersistedEvent) => void,
  ): number {
    const openItems = this.db.prepare(
      `SELECT qitem_id FROM queue_items
       WHERE state IN ('pending','in-progress','blocked')
         AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
         AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
         AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`,
    ).all(`instance:${instanceId}`, `occurrence:${failedPacketId}`) as Array<{ qitem_id: string }>;
    for (const row of openItems) {
      const closed = this.queueRepo.updateWithinTransaction({
        qitemId: row.qitem_id,
        actorSession: input.actorSession,
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: `workflow resume: occurrence resolved by ${input.actorSession} redriving step ${stepId}${input.decision ? ` — ${input.decision}` : ""}`,
      });
      register(closed.persistedEvent);
    }
    return openItems.length;
  }

  private async resumeFailureOccurrence(input: {
    instanceId: string;
    occurrenceId?: string;
    decision?: string;
    actorSession: string;
  }): Promise<{
    instanceId: string;
    stepId: string;
    newPacketId: string;
    ownerSession: string;
    resumeCount: number;
    exceptionItemsClosed: number;
    absorbedReplay?: boolean;
  }> {
    const all = this.instanceStore.listFailureOccurrences(input.instanceId);
    const selected = input.occurrenceId
      ? all.find((occurrence) => occurrence.occurrenceId === input.occurrenceId)
      : undefined;
    if (selected?.status === "resolved" && selected.redrivePacketId) {
      if (selected.resumeDecision !== (input.decision ?? null)) {
        throw new WorkflowProjectorError(
          "failure_occurrence_replay_conflict",
          `failure occurrence ${selected.occurrenceId} was already resumed with different decision bytes`,
          {
            instanceId: input.instanceId,
            occurrenceId: selected.occurrenceId,
            expectedDecision: selected.resumeDecision,
            attemptedDecision: input.decision ?? null,
          },
        );
      }
      const packet = this.queueRepo.getById(selected.redrivePacketId);
      if (!packet) {
        throw new WorkflowProjectorError("failure_occurrence_replay_indeterminate", `resolved occurrence ${selected.occurrenceId} points to missing redrive packet ${selected.redrivePacketId}`, { instanceId: input.instanceId, occurrenceId: selected.occurrenceId });
      }
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      return { instanceId: input.instanceId, stepId: selected.stepId, newPacketId: selected.redrivePacketId, ownerSession: packet.destinationSession, resumeCount: instance.resumeCount, exceptionItemsClosed: 0, absorbedReplay: true };
    }
    const unresolved = all.filter((occurrence) => occurrence.status === "unresolved");
    if (!input.occurrenceId && unresolved.length !== 1) {
      throw new WorkflowProjectorError("failure_occurrence_required", `instance ${input.instanceId} has ${unresolved.length} unresolved failure occurrences; --occurrence is required`, { instanceId: input.instanceId, candidates: unresolved });
    }
    const occurrence = input.occurrenceId ? selected : unresolved[0];
    if (!occurrence || occurrence.status !== "unresolved") {
      throw new WorkflowProjectorError("failure_occurrence_not_unresolved", `failure occurrence ${input.occurrenceId ?? "(unspecified)"} is not unresolved`, { instanceId: input.instanceId, occurrenceId: input.occurrenceId ?? null });
    }

    let output!: {
      instanceId: string;
      stepId: string;
      newPacketId: string;
      ownerSession: string;
      resumeCount: number;
      exceptionItemsClosed: number;
    };
    let wake: { qitemId: string; session: string; nudge: boolean | undefined } | null = null;
    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status === "completed" || instance.status === "aborted") {
        throw new WorkflowProjectorError("instance_not_resumable", `instance ${instance.instanceId} is ${instance.status}`, { instanceId: instance.instanceId, status: instance.status });
      }
      const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
      if (!specRow) throw new WorkflowProjectorError("spec_not_cached", `workflow spec ${instance.workflowName}@${instance.workflowVersion} is not cached`);
      const step = specRow.spec.steps.find((candidate) => candidate.id === occurrence.stepId);
      if (!step) throw new WorkflowProjectorError("resume_step_missing_from_spec", `failed step "${occurrence.stepId}" no longer exists`, { instanceId: instance.instanceId, stepId: occurrence.stepId });
      const owner = resolveDefaultOwner(specRow.spec, step, (session) => nodeRuntimeOf(this.db, session), roleResolutionContext(this.db, instance.boundRig));
      if (!owner) throw new WorkflowProjectorError("next_owner_unresolved", `cannot resolve owner for failed step "${step.id}"`);
      const redrivePacketId = newQitemId();
      const created = this.queueRepo.createWithinTransaction({
        qitemId: redrivePacketId,
        sourceSession: input.actorSession,
        destinationSession: owner,
        body: withWorkflowContinuation({
          binding: instance.lifecycleBinding,
          library: this.guidanceLibrary,
          body: `WORKFLOW RESUME (packet redrive)\nworkflow: ${instance.workflowName} v${instance.workflowVersion}\ninstance: ${instance.instanceId}\noccurrence: ${occurrence.occurrenceId}\nstep: ${step.id}\n${input.decision ? `decision: ${input.decision}\n` : ""}`,
          instanceId: instance.instanceId,
          packetId: redrivePacketId,
          ownerSession: owner,
          step,
          contextRefs: specRow.spec.context_refs,
        }),
        priority: "routine",
        tier: "mode2",
        tags: ["workflow", "resume", `workflow:${instance.workflowName}`, `instance:${instance.instanceId}`, `occurrence:${occurrence.occurrenceId}`],
        chainOfRecord: [occurrence.failedPacketId],
      });
      register(created.persistedEvent);
      this.queueRepo.stageWakeIntent(created.qitemId, input.actorSession, created.destinationSession, null, created.nudge);
      this.instanceStore.bindFrontierPacket({
        instanceId: instance.instanceId,
        packetId: created.qitemId,
        stepId: occurrence.stepId,
        branchDrive: occurrence.branchDrive + 1,
        hopCount: occurrence.hopCount,
        hopsBaseline: occurrence.hopCount,
      });
      this.instanceStore.resolveFailureOccurrence(instance.instanceId, occurrence.occurrenceId, created.qitemId, input.decision);
      const exceptionItemsClosed = this.closeFailureExceptions(instance.instanceId, occurrence.failedPacketId, step.id, input, register);
      const nextFrontier = [...instance.currentFrontier, created.qitemId];
      const bindings = this.instanceStore.listFrontierBindings(instance.instanceId);
      this.instanceStore.updateFrontier(instance.instanceId, nextFrontier, "active", {
        currentStepId: bindings.length === 1 ? bindings[0]!.stepId : "clear",
        expectedVersion: instance.version,
        resumeStamp: { resumeCount: instance.resumeCount + 1, hopsBaseline: instance.hopCount },
        lastContinuationDecision: { action: "resume_occurrence", occurrenceId: occurrence.occurrenceId, redrivePacketId: created.qitemId, actorSession: input.actorSession, decision: input.decision ?? null },
      });
      if (this.watchdogJobsRepo) ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
        instanceId: instance.instanceId,
        packetId: created.qitemId,
        targetSession: owner,
        registeredBySession: input.actorSession,
      });
      register(this.eventBus.persistWithinTransaction({ type: "workflow.resumed", instanceId: instance.instanceId, workflowName: instance.workflowName, stepId: step.id, occurrenceId: occurrence.occurrenceId, resumedBy: input.actorSession, decision: input.decision ?? null, resumeCount: instance.resumeCount + 1 }));
      wake = { qitemId: created.qitemId, session: created.destinationSession, nudge: created.nudge };
      output = { instanceId: instance.instanceId, stepId: step.id, newPacketId: created.qitemId, ownerSession: owner, resumeCount: instance.resumeCount + 1, exceptionItemsClosed };
    });
    const nudge = wake as { qitemId: string; session: string; nudge: boolean | undefined } | null;
    if (nudge) await this.queueRepo.deliverWakeForSuccessor(nudge.qitemId, nudge.session, nudge.nudge, input.actorSession);
    return output;
  }

  async route(input: {
    instanceId: string;
    packetId?: string;
    toSession: string;
    actorSession: string;
    reason?: string;
  }): Promise<{
    instanceId: string;
    stepId: string | null;
    closedPacketId: string;
    newPacketId: string;
    fromSession: string;
    toSession: string;
    instanceStatus: WorkflowInstance["status"];
  }> {
    let result!: {
      instanceId: string;
      stepId: string | null;
      closedPacketId: string;
      newPacketId: string;
      fromSession: string;
      toSession: string;
      instanceStatus: WorkflowInstance["status"];
    };
    let nudgeTo: { qitemId: string; session: string; nudge: boolean | undefined } | null = null;

    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status !== "active" && instance.status !== "waiting") {
        throw new WorkflowProjectorError(
          "instance_not_active",
          `instance ${instance.instanceId} is ${instance.status}; only a live (active|waiting) instance can be re-routed`,
          { instanceId: instance.instanceId, status: instance.status },
        );
      }
      let oldPacketId = input.packetId;
      if (!oldPacketId) {
        if (instance.currentFrontier.length !== 1) {
          if (instance.currentFrontier.length === 0) {
            throw new WorkflowProjectorError(
              "packet_not_found",
              `instance ${instance.instanceId} has an empty frontier; nothing to re-route`,
              { instanceId: instance.instanceId },
            );
          }
          const candidates = instance.currentFrontier.map((packetId) => {
            const binding = this.instanceStore.getFrontierBinding(instance.instanceId, packetId);
            const packet = this.queueRepo.getById(packetId);
            return { packetId, stepId: binding?.stepId ?? null, ownerSession: packet?.destinationSession ?? null };
          });
          throw new WorkflowProjectorError(
            "frontier_packet_required",
            `instance ${instance.instanceId} has ${instance.currentFrontier.length} live packets; --packet is required`,
            { instanceId: instance.instanceId, candidates },
          );
        }
        [oldPacketId] = instance.currentFrontier;
      }
      if (!oldPacketId) {
        throw new WorkflowProjectorError(
          "packet_not_found",
          `instance ${instance.instanceId} has no selectable frontier packet`,
          { instanceId: instance.instanceId },
        );
      }
      if (!instance.currentFrontier.includes(oldPacketId)) {
        throw new WorkflowProjectorError(
          "packet_not_on_frontier",
          `qitem ${oldPacketId} is not in workflow instance ${instance.instanceId} frontier`,
          { instanceId: instance.instanceId, packetId: oldPacketId, frontier: instance.currentFrontier },
        );
      }
      const oldPacket = this.queueRepo.getById(oldPacketId);
      if (!oldPacket) {
        throw new WorkflowProjectorError(
          "packet_not_found",
          `frontier packet ${oldPacketId} not found`,
          { instanceId: instance.instanceId, packetId: oldPacketId },
        );
      }
      const fromSession = oldPacket.destinationSession;

      // (7) harness pin: the SAME reconciliation the projector applies
      // to explicit --next-owner overrides — an explicit route target
      // never silently defeats a declared pin.
      const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
      const oldBinding = this.instanceStore.getFrontierBinding(instance.instanceId, oldPacketId);
      const selectedStepId = oldBinding?.stepId ?? (instance.currentFrontier.length === 1 ? instance.currentStepId : null);
      const step =
        selectedStepId && specRow
          ? specRow.spec.steps.find((s) => s.id === selectedStepId) ?? null
          : null;
      if (step) {
        reconcileExplicitOwnerHarness(step, input.toSession, (session) =>
          nodeRuntimeOf(this.db, session),
        );
      }

      // (3)+(4) close the old packet HONESTLY: handed_off_to with full
      // provenance in the transition — never a forged completion.
      const closed = this.queueRepo.updateWithinTransaction({
        qitemId: oldPacketId,
        actorSession: input.actorSession,
        viaWorkflowVerb: true,
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: input.toSession,
        handedOffTo: input.toSession,
        transitionNote: `workflow route: ${input.actorSession} re-routed step ${selectedStepId ?? "?"} from ${fromSession} to ${input.toSession}${input.reason ? ` — ${input.reason}` : ""}`,
      });
      register(closed.persistedEvent);

      // Recreate the SAME step for the new owner (step identity is the
      // work's continuity — the qitem id is a storage artifact of the
      // append-only design). chainOfRecord threads the lineage.
      // FULL-FIDELITY FIELD CARRY (rev1-r2 BLOCKING fold): the
      // successor IS the same work item, so it keeps the source
      // packet's priority/tier/summary/evidenceRef/targetRepo — a
      // human-gated packet (blocked on a human seat) MUST keep
      // summary + evidence_ref or the shipped human-park validator
      // rejects the repark below (human_route_fields_required) and
      // the waiting-on-human class — the one route most exists for —
      // becomes un-routable.
      const routedPacketId = newQitemId();
      const created = this.queueRepo.createWithinTransaction({
        qitemId: routedPacketId,
        sourceSession: input.actorSession,
        destinationSession: input.toSession,
        body: withWorkflowContinuation({
          binding: instance.lifecycleBinding,
          library: this.guidanceLibrary,
          body: oldPacket.body,
          instanceId: instance.instanceId,
          packetId: routedPacketId,
          ownerSession: input.toSession,
          step: step ?? undefined,
          contextRefs: specRow?.spec.context_refs,
        }),
        priority: oldPacket.priority ?? "routine",
        tier: oldPacket.tier ?? "mode2",
        // OPR.0.4.6.WF5 (rev1-r2 B1 fold): the successor IS the same work
        // item — tags carry VERBATIM (+ re-route) so a routed class-(c)
        // gate item keeps its exception identity on the live frontier
        // packet (workflow-exception/step:/exception:human_gate_trip/
        // occurrence:<ORIGINAL gate packet id> — the occurrence is the
        // EPISODE, which route does not end; chainOfRecord links the
        // packet lineage). The WF-3 full-fidelity-carry lesson, extended
        // to the tag dimension.
        tags: Array.from(
          new Set([
            ...(oldPacket.tags ?? []),
            "workflow",
            "re-route",
            `workflow:${instance.workflowName}`,
            `instance:${instance.instanceId}`,
          ]),
        ),
        chainOfRecord: [oldPacketId],
        summary: oldPacket.summary ?? undefined,
        evidenceRef: oldPacket.evidenceRef ?? undefined,
        targetRepo: oldPacket.targetRepo ?? undefined,
      });
      register(created.persistedEvent);
      nudgeTo = { qitemId: created.qitemId, session: created.destinationSession, nudge: created.nudge };
      // P34 (site :992): stage the re-routed packet's wake intent in the same
      // transaction that closed the old frontier packet.
      this.queueRepo.stageWakeIntent(
        created.qitemId,
        input.actorSession,
        created.destinationSession,
        null,
        created.nudge,
      );

      // A parked (waiting) frontier packet keeps its park on the
      // successor — route changes the owner, never the recorded state.
      // OPR.0.5.1 slice-51-06 D2: summary/evidenceRef are NOT re-supplied
      // here. The create above (create-side carry) already put them on the
      // successor, and validateHumanPark evaluates the EFFECTIVE values
      // (input ?? item), so a human re-park still validates from the
      // carried fields. Re-supplying them made this a non-park metadata
      // update, which the D2 guard rejects for a NON-human blocker —
      // rolling back a valid route with HTTP 500. Dropping the redundant
      // re-submission keeps the metadata (from create) without tripping D2.
      if (oldPacket.state === "blocked" && oldPacket.blockedOn) {
        const reparked = this.queueRepo.updateWithinTransaction({
          qitemId: created.qitemId,
          actorSession: input.actorSession,
          state: "blocked",
          closureReason: "blocked_on",
          closureTarget: oldPacket.blockedOn,
          blockedOn: oldPacket.blockedOn,
          transitionNote: `workflow route: park preserved (${oldPacket.blockedOn})`,
          wakeAfterSeconds: step?.re_present_after_seconds,
          wakeMaxSeconds: step?.re_present_max_seconds,
          wakeMessage:
            step?.re_present_after_seconds !== undefined
              ? workflowWaitWakeMessage({
                  spec: specRow!.spec,
                  instance,
                  step,
                  packetId: routedPacketId,
                  ownerSession: input.toSession,
                })
              : undefined,
        });
        register(reparked.persistedEvent);
      }

      // (2)+(5)+(7) frontier REBIND: same step, new packet, version
      // guard held; NO hop bump (not an advance).
      const nextFrontier = instance.currentFrontier.map((packetId) => packetId === oldPacketId ? created.qitemId : packetId);
      if (oldBinding) {
        this.instanceStore.removeFrontierBinding(instance.instanceId, oldPacketId);
        this.instanceStore.bindFrontierPacket({
          instanceId: instance.instanceId,
          packetId: created.qitemId,
          stepId: oldBinding.stepId,
          branchDrive: oldBinding.branchDrive,
          hopCount: oldBinding.hopCount,
          hopsBaseline: oldBinding.hopsBaseline,
        });
      }
      const rebound = this.instanceStore.listFrontierBindings(instance.instanceId);
      this.instanceStore.updateFrontier(instance.instanceId, nextFrontier, instance.status, {
        currentStepId: rebound.length === 1 ? rebound[0]!.stepId : rebound.length > 1 ? "clear" : "preserve",
        expectedVersion: instance.version,
      });

      // Keepalive re-target IN-TXN (arch n3: covers route's lost-nudge
      // window — the armed job re-nudges the new owner).
      if (this.watchdogJobsRepo) {
        disarmWorkflowKeepalive(
          this.watchdogJobsRepo,
          instance.instanceId,
          `workflow route: re-targeted to ${input.toSession}`,
          oldBinding ? oldPacketId : undefined,
        );
        ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
          instanceId: instance.instanceId,
          packetId: oldBinding ? created.qitemId : undefined,
          targetSession: input.toSession,
          registeredBySession: input.actorSession,
        });
      }

      // (6) the shipped event shape {rigName, cause} extended ADDITIVELY.
      register(
        this.eventBus.persistWithinTransaction({
          type: "workflow.routing_table_changed",
          // OPR.0.4.6.FAC1 (display-only): the instance's actual bound
          // rig wins over the spec's default label.
          rigName: instance.boundRig ?? specRow?.targetRig ?? "",
          cause: "workflow_route",
          instanceId: instance.instanceId,
          stepId: selectedStepId,
          from: fromSession,
          to: input.toSession,
        }),
      );

      result = {
        instanceId: instance.instanceId,
        stepId: selectedStepId,
        closedPacketId: oldPacketId,
        newPacketId: created.qitemId,
        fromSession,
        toSession: input.toSession,
        instanceStatus: instance.status,
      };

      // P34 (site :992): the W1 seam, LAST statement of this transaction. Route
      // always closes the old frontier packet terminally (handed-off) and always
      // creates its successor, so the pairing here is unconditional.
      this.queueRepo.assertTerminalClosureHasIntent(oldPacketId, created.qitemId, created.nudge);
    });
    if (nudgeTo) {
      const n = nudgeTo as { qitemId: string; session: string; nudge: boolean | undefined };
      // P34: shared staged-intent delivery (see the resume path above).
      await this.queueRepo.deliverWakeForSuccessor(n.qitemId, n.session, n.nudge, input.actorSession);
    }
    return result;
  }

  /**
   * Continue: idempotent inspector for the current frontier of an
   * instance. v1 is read-only — returns the current state. POC's
   * mechanical advance is folded into project() for v1; continue() is
   * the audit/inspect entrypoint.
   */
  continue(instanceId: string): {
    instance: WorkflowInstanceWithDeadline;
    trail: WorkflowStepTrailEntry[];
    guidance: ReturnType<WorkflowRuntime["guidance"]>;
    reconciliation: ReturnType<typeof inspectGraph>;
    frontier: ReturnType<WorkflowRuntime["inspect"]>["frontier"];
    failures: ReturnType<WorkflowRuntime["inspect"]>["failures"];
    unknowns: string[];
    boundaryObligations: LifecycleObligation[];
  } {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const trail = this.trailLog.listForInstance(instanceId);
    const inspected = this.inspect(instanceId);
    return {
      instance: this.withDeadline(instance),
      trail,
      guidance: this.guidance(instanceId),
      reconciliation: this.inspectGraph(instanceId),
      frontier: inspected.frontier,
      failures: inspected.failures,
      unknowns: inspected.unknowns,
      boundaryObligations: inspected.boundaryObligations,
    };
  }

  /**
   * OPR.0.4.6.WF1 FR-2 COMPLETION FIXBACK (build-vs-ratified-AC debt,
   * qitem-20260706211220-279039f5): the ratified FR-2 AC requires the
   * stuck classification to be "queryable via list/show/trace … with
   * the evidence (step, owner, deadline, age)". The merged WF-1 build
   * surfaced it only through the boot sweep + keepalive nudges; this
   * closes the queryability clause by deriving the SAME evaluator
   * verdict (one threshold home — workflow-deadline.ts) at read time.
   *
   * DERIVED, NEVER STORED: recomputed per read from (instance,
   * frontier packets, now) — a normal re-projection self-clears it,
   * exactly like every other evaluator consumer. Exposes the FULL
   * classification tuple (state + evidence{step, owner, anchor,
   * anchorAt, overdueBySeconds, ageSeconds}) so BOTH consumers (WF-3's
   * status rollup and WF-5's FR-3 ▲ source) read one shape — no
   * boolean flattening, no second path.
   */
  deadlineFor(instance: WorkflowInstance): WorkflowDeadlineVerdict {
    const packets = instance.currentFrontier
      .map((id) => this.queueRepo.getById(id))
      .filter((p): p is NonNullable<typeof p> => p != null);
    return evaluateStepDeadline(instance, packets, this.now());
  }

  /** The additive read enrichment consumed by list/show/trace routes. */
  withDeadline(instance: WorkflowInstance): WorkflowInstanceWithDeadline {
    return { ...instance, deadline: this.deadlineFor(instance) };
  }

  /** List instances (optionally filtered) with the deadline verdict attached. */
  listInstancesWithDeadline(
    status?: "active" | "waiting" | "completed" | "failed" | "aborted",
  ): WorkflowInstanceWithInspection[] {
    const rows = status ? this.instanceStore.listByStatus(status) : this.instanceStore.listAll();
    return rows.map((row) => {
      const inspected = this.inspect(row.instanceId);
      return {
        ...this.withDeadline(row),
        frontierPackets: inspected.frontier,
        failureOccurrences: inspected.failures,
        unknowns: inspected.unknowns,
        boundaryObligations: inspected.boundaryObligations,
      };
    });
  }
}

/** WorkflowInstance + the derived FR-2 deadline verdict (additive read shape). */
export type WorkflowInstanceWithDeadline = WorkflowInstance & {
  deadline: WorkflowDeadlineVerdict;
};

export type WorkflowInstanceWithInspection = WorkflowInstanceWithDeadline & {
  frontierPackets: ReturnType<WorkflowRuntime["inspect"]>["frontier"];
  failureOccurrences: ReturnType<WorkflowRuntime["inspect"]>["failures"];
  boundaryObligations: LifecycleObligation[];
  unknowns: string[];
};

function workflowInstantiateBody(input: {
  binding?: GuidanceInput["binding"];
  library?: GuidanceInput["library"];
  spec: Pick<WorkflowSpec, "id" | "version" | "context_refs">;
  instanceId: string;
  entryStep: WorkflowStepSpec;
  rootObjective: string;
  gate?: GateCompileResult | null;
  packetId: string;
  ownerSession: string;
}): string {
  const lines = [
    `### Workflow entry: ${input.spec.id}@${input.spec.version} step ${input.entryStep.id}`,
    "",
    `Workflow instance: ${input.instanceId}`,
    `Entry step: ${input.entryStep.id} (${input.entryStep.actor_role})`,
    "",
    `Root objective: ${input.rootObjective}`,
  ];
  if (input.gate) {
    lines.push(
      "",
      `Gate: ${input.gate.kind === "human" ? "human sign-off" : "handler-role check"} — the workflow is PARKED (waiting) until this item is resolved/closed; the flow then continues from this step.`,
    );
    if (input.gate.summary) lines.push(`Ask: ${input.gate.summary}`);
    if (input.gate.evidenceRef) lines.push(`Evidence: ${input.gate.evidenceRef}`);
  }
  if (input.entryStep.objective) {
    lines.push("", `Step objective: ${input.entryStep.objective}`);
  }
  return withWorkflowContinuation({
    body: lines.join("\n"),
    contextRefs: input.spec.context_refs,
    binding: input.binding,
    library: input.library,
    instanceId: input.instanceId,
    packetId: input.packetId,
    ownerSession: input.ownerSession,
    step: input.entryStep,
  });
}

export {
  WorkflowInstanceError,
  WorkflowProjectorError,
  WorkflowSpecError,
};
