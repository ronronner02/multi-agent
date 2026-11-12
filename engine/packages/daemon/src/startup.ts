import { documentDispatchRefusal } from "./domain/project-documents.js";
import { managedModelRefusal } from "./domain/team-model-policy.js";
import { discoverTailscaleSelfNames } from "./middleware/browser-boundary.js";
import { configureShadowCapture } from "./domain/shadow-capture.js";
import { queueRecoveryOwnsWake } from "./domain/queue-wake-ladder.js";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDatabase } from "./db/connection.js";
import { RigRepository } from "./domain/rig-repository.js";
import { SessionRegistry } from "./domain/session-registry.js";
import { deriveCanonicalSessionName, isHumanSeatSessionRef, parseSessionName } from "./domain/session-name.js";
import { resolveExternal } from "./domain/queue-routing/external-admission.js";
import { loadHumanRegistry } from "./domain/queue-routing/human-registry.js";
import { EventBus } from "./domain/event-bus.js";
import { codexDaemonSupportProbe } from "./domain/codex-daemon-support.js";
import { codexNetworkDefaultReader } from "./domain/codex-network-default.js";
import { codexUsageReader } from "./domain/provider/codex-usage-reader.js";
import { prepareCodexTeamWorkspace } from "./domain/codex-team-workspace.js";
// TODO: AS-T12 — migrate to pod-aware bundle source resolver
import { setSelfHostId, setSelfHostIdSource } from "./domain/host-identity/fanout-contract.js";
import { DaemonLifecycleStore } from "./domain/daemon-lifecycle-store.js";
import { randomUUID } from "node:crypto";
import { TranscriptStore } from "./domain/transcript-store.js";
import { AgentActivityStore } from "./domain/agent-activity-store.js";
import { ChatRepository } from "./domain/chat-repository.js";
import { StreamStore } from "./domain/stream-store.js";
import { SlowOpRecorder, type SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";
import { configureSyncSiteRecorder } from "./domain/sync-site-wrap.js";
import { RequestPhaseObserver } from "./domain/request-phase-observer.js";
import { QueueRepository, isBlockerLive } from "./domain/queue-repository.js";
import { createWorkflowFrontierPredicate } from "./domain/workflow-frontier-guard.js";
import { InboxHandler } from "./domain/inbox-handler.js";
import { OutboxHandler } from "./domain/outbox-handler.js";
import { ProjectClassifier } from "./domain/project-classifier.js";
import { ClassifierLeaseManager } from "./domain/classifier-lease-manager.js";
import { ClassificationAttemptLedger } from "./domain/classification-attempts.js";
import { ViewProjector } from "./domain/view-projector.js";
import { wireViewEventBridge } from "./domain/view-event-bridge.js";
import { WatchdogJobsRepository } from "./domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "./domain/watchdog-history-log.js";
import { WorkflowRuntime, dependencySatisfied } from "./domain/workflow-runtime.js";
import { resolveWorkflowHumanDestination } from "./domain/workflow-human-destination.js";
import { makeWorkflowKeepalivePolicy } from "./domain/policies/workflow-keepalive.js";
import { makeIdleGateQitemPolicy } from "./domain/policies/idle-gate-qitem.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME } from "./domain/policies/parked-owner-consumer.js";
import { diagnoseRigParked } from "./domain/parked-query.js";
// Phase 3a slice 3.3 — plugin discovery service.
// Slice 28 Checkpoint C-3 — skill-library discovery (SC-29 #11 cumulative).
import { SettingsStore as ContextPackSettingsStore } from "./domain/user-settings/settings-store.js";
import { SettingsStore } from "./domain/user-settings/settings-store.js";
import { WhoamiService } from "./domain/whoami-service.js";
import { createApp, type AppDeps } from "./server.js";
import { PlanGovernance, fixDaemonMode, hashBytes } from "./domain/plan-governance.js";
import { refreshPlanBinding, unisolatedPolicyCapability } from "./routes/team-start.js";
import { leadActivation } from "./domain/lead-proposal.js";
import { planningRosterRequired } from "./domain/lead-roster.js";
import { composeLeadTurnEnd } from "./domain/lead-chat.js";
// T053 — the managed attempt's production inputs, composed here beside the candidate roots.
import { WorkerControlAccess } from "./domain/worker-control-access.js";
import { SeatMailboxCapabilities } from "./domain/seat-mailbox-capability.js";
import { WorkerIdentities } from "./domain/worker-identity.js";
import { FRAMEWORK_PIN } from "./integrations/framework/catalog.js";
import { resolveTeamSoul } from "./domain/team-souls.js";
import { recordWorkflowOutcome, workflowCapabilityRefusal } from "./domain/team-workflows.js";
import { prepareFrameworkInvocation } from "./integrations/framework/invocation.js";
import { frameworkInstructionSources } from "./integrations/framework/source.js";
import { createSystemHealthReader, attemptsFromManagedWorkerEvidence, attemptsFromRecords, type SystemHealthProbeResult } from "./domain/system-health.js";
import { parseAttemptClassification } from "./domain/attempt-failure.js";
import { TeamReadModel } from "./team-control-surface.js";
import { canonicalJson } from "./contracts/team-control.js";
import type { ManagedWorkerHealthEvidence, TeamSystemHealth } from "./contracts/team-control.js";
import { workerEventNotification } from "./domain/worker-event-notification.js";
import { ManagedNativeChannelEvidence } from "./domain/mailbox-delivery.js";
import { DirectWorkerLauncher, type DirectLaunchFacts } from "./adapters/direct-worker-launch.js";
import { readSupervisorExit } from "./adapters/child-process-supervisor.js";
import type { WorkerClient } from "./adapters/worker-launch.js";
import type { WorkerEvent } from "./contracts/worker-events.js";
import { unisolatedWorkerRoots, type ManagedWorkerRoots } from "./domain/unisolated-roots.js";
import { defaultWorktreeRoot } from "./domain/worktree-policy.js";
import fs, { readFileSync as readFileSyncNamed } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
// Slice 11 (release-0.3.1 workflow-spec-folder-discovery) — adds
// status + error_message columns to workflow_specs so the scanner
// can record diagnostic rows. SC-29 #10 declared verbatim in commit body.
import { RigModeStore } from "./domain/rig-mode/rig-mode-store.js";
import { OperatingPostureService, configuredCatalogPath } from "./domain/rig-mode/operating-posture.js";
import { MULTI_AGENT_HOME } from "./data-paths.js";
import { ensureActivityHookToken, writeActivityEndpointFile, deriveActivityUrl, readActivityEndpointFile } from "./domain/activity-endpoint.js";

interface DaemonOptions {
  dbPath?: string;
  /** KTD22: start in managed mode. Existing managed authority forces it regardless. */
  managedMode?: boolean;
  teamControl?: AppDeps["teamControl"];
  /** S20 — the effective bind plan (mode/hosts/tailscaleDetected/ignoredRoutingHost),
   *  computed once in index.ts and exposed on /healthz so adoption gates verify
   *  listeners by binding evidence. Absent (tests/legacy) = healthz body unchanged. */
  bindPlan?: import("./domain/bind-plan.js").BindPlan;
  slowOpRecorder?: SlowOperationInstrumentation;
  /**
   * PL-005 Phase B: bearer token for Mission Control write verbs.
   * When null, the auth-bearer-token middleware passes through (the
   * index.ts startup-side check ensures this is only valid when bound
   * on loopback). When set, the middleware enforces constant-time
   * comparison + 401 on missing/mismatch.
   */
  bearerToken?: string | null;
  /** Overrides the `ui.enabled` setting (tests). */
  webUiEnabled?: boolean;
  /** MVP: overrides the `workers.isolation` setting, which is otherwise read from config. */
  workersIsolation?: "none" | "hardened";
  /** MVP: the client command an unisolated launch starts (tests use the stub runner). */
  directLaunchCommand?: (facts: DirectLaunchFacts) => string[];
  /** U3: the real client executable an unisolated launch starts, when a test or an operator names it. */
  directLaunchExecutable?: (client: WorkerClient) => string | undefined;
  /** U3: a stand-in for the supervised child, so a test can drive the launch without spawning. */
  directLaunchSupervise?: (launch: import("./adapters/child-process-supervisor.js").SupervisorLaunch,
    deps: { onEvent: (event: WorkerEvent) => void }) => import("./adapters/child-process-supervisor.js").SupervisedTurn;
}

interface DaemonResult {
  app: Hono;
  db: Database.Database;
  deps: AppDeps;
  contextMonitor: import("./domain/context-monitor.js").ContextMonitor;
  // OPR.0.4.3.21 — returned so index.ts can stop() it on graceful shutdown.
  eventLoopMonitor: import("./domain/event-loop-monitor.js").EventLoopMonitor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}

const KNOWN_PROVIDER_AUTH_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // The Claude-side counterpart of OPENAI_BASE_URL: a key or token issued by an
  // Anthropic-compatible gateway is only valid together with that gateway's
  // endpoint, so both must be able to reach the seat.
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  // Issue #194: the bearer token of a Codex Amazon Bedrock provider
  // (`env_key = "AWS_BEARER_TOKEN_BEDROCK"`). Still forwarded only when the
  // operator names it in recovery.provider_auth_env_allowlist.
  "AWS_BEARER_TOKEN_BEDROCK",
]);

export function collectAllowlistedProviderAuthEnv(
  raw: string | null | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (raw ?? "").split(",")) {
    const name = item.trim();
    if (!name) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    if (!KNOWN_PROVIDER_AUTH_ENV.has(name)) continue;
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * MVP — the managed launch chain when `workers.isolation: none`.
 *
 * The chain is the same one the hardened path composes: the attempt is still produced by the
 * runtime, the mailbox still authenticates, and the seat still resolves to its own pane and
 * candidate. What changes is the launch itself — the client starts as this daemon's user
 * rather than through the privileged launcher — so the pieces that exist only to serve that
 * launcher (the sudo transport, the installed-policy preflight, the sandbox observation) are
 * not built at all.
 */
function composeDirectLaunch(dependencies: {
  governance: PlanGovernance;
  rigRepo: RigRepository;
  /** The workflow runtime a managed launch must be admitted through. Read at launch, not at composition. */
  workflowRuntime: () => WorkflowRuntime | undefined;
  /** The client command the unisolated launch starts. A test injects a stub here. */
  command?: (facts: DirectLaunchFacts) => string[];
  /** An explicit client executable, which a fixture names and an operator may override. */
  executablePath?: (client: WorkerClient) => string | undefined;
  /** Publish a normalized worker event, where this daemon records attempt facts. */
  onEvent?: (facts: DirectLaunchFacts, event: WorkerEvent) => void;
  /** U4 — the durable lifecycle recorder the launch writes its facts through. */
  lifecycle?: import("./adapters/direct-worker-launch.js").DirectWorkerLaunchDeps["lifecycle"];
  /** A stand-in for the supervised child, so a test can drive the launch without spawning. */
  supervise?: (launch: import("./adapters/child-process-supervisor.js").SupervisorLaunch,
    deps: { onEvent: (event: WorkerEvent) => void }) => import("./adapters/child-process-supervisor.js").SupervisedTurn;
}) {
  const { rigRepo } = dependencies;
  const endpoints: NonNullable<AppDeps["managedLaunch"]>["endpoints"] = new Map();
  const launcher = new DirectWorkerLauncher({
    modelRefusal: input => managedModelRefusal(rigRepo.db, input),
    documentRefusal: input => {
      const { runId, assignment, binding } = input.attempt.context;
      const run = dependencies.governance.getRun(runId);
      return documentDispatchRefusal(rigRepo.db, run, assignment.role, assignment.taskId, binding);
    },
    // U3 — the turn runs in the tree the runtime admitted, as a direct child process. The seat's
    // terminal is no longer the transport, so no pane is resolved and none is recorded.
    resolveAssignedTree: (runId, assignment) => {
      const runtime = dependencies.workflowRuntime();
      if (!runtime) throw new Error("direct_launch_runtime_unavailable");
      return runtime.assignedTreeFor(runId, assignment);
    },
    ...(dependencies.command ? { command: dependencies.command } : {}),
    ...(dependencies.executablePath ? { executablePath: dependencies.executablePath } : {}),
    ...(dependencies.onEvent ? { onEvent: dependencies.onEvent } : {}),
    ...(dependencies.lifecycle ? { lifecycle: dependencies.lifecycle } : {}),
    ...(dependencies.supervise ? { supervise: dependencies.supervise } : {}),
  });
  return { launcher, endpoints, readHealthEvidence: undefined };
}

/**
 * T047 — the exact receipt a native-token resume must present again.
 *
 * The launcher compares this receipt's hash with the one recorded on the attempt's running
 * launch intent (U5), so the bytes are read back verbatim from the launch event rather than
 * reconstructed. A receipt for another run, task or client is treated as absent, and the
 * launch refuses instead of resuming under an attempt it does not own.
 */
function recordedManagedReceipt(dependencies: { db: Database.Database; governance: PlanGovernance }, input: {
  seat: string; nativeToken: string; runId: string; qitemId: string; client: "claude-code" | "codex";
}): import("./domain/runtime-adapter.js").ManagedSessionReceipt | undefined {
  const row = dependencies.db.prepare(`
    SELECT payload FROM events
    WHERE type = 'managed.attempt.receipt'
      AND json_extract(payload, '$.sessionName') = ?
      AND json_extract(payload, '$.receipt.identity.nativeSessionId') = ?
      AND json_extract(payload, '$.receipt.runId') = ?
    ORDER BY seq DESC LIMIT 1`).get(input.seat, input.nativeToken, input.runId) as
    { payload: string } | undefined;
  if (!row) return undefined;
  const receipt = (JSON.parse(row.payload) as
    { receipt?: import("./domain/runtime-adapter.js").ManagedSessionReceipt }).receipt;
  const prior = receipt ? dependencies.governance.getAttempt(receipt.attemptId) : null;
  return receipt && receipt.client === input.client && prior?.qitemId === input.qitemId
    && prior.identity && canonicalJson(prior.identity) === canonicalJson(receipt.identity)
    ? receipt : undefined;
}

/**
 * T047 — the attempt a managed seat launches under.
 *
 * A seat is managed when its queue destination names it and the run is approved. That lookup —
 * not the daemon's mode — is the authority: a personal seat in a managed daemon resolves to no
 * task and keeps its personal launch, while an admitted assignment cannot reach the privileged
 * launcher without the attempt produced for it. The endpoint is registered before this returns,
 * which is the moment the launcher's `mailbox` seam becomes resolvable for the attempt.
 */
function composeManagedAttemptAttachment(dependencies: {
  readMaxSeats?: () => number;
  db: Database.Database;
  governance: PlanGovernance;
  endpoints: NonNullable<AppDeps["managedLaunch"]>["endpoints"];
  runtime: () => WorkflowRuntime | undefined;
  owners: () => { chat?: AppDeps["chatRepo"]; delivery?: AppDeps["mailboxDelivery"] };
  /** The roots in force for this daemon: the installed policy, or the unisolated state tree. */
  roots: () => ManagedWorkerRoots;
  /** True when the worker is the daemon's own user, so identity comes from the process. */
  currentUser: boolean;
  /** True when no framework tree is installed, so the attempt binds no pinned entry. */
  unisolated: boolean;
}) {
  return async (input: import("./domain/startup-orchestrator.js").StartupInput):
    Promise<import("./domain/runtime-adapter.js").ManagedAttempt | undefined> => {
    const client = input.adapter.runtime;
    if (client !== "claude-code" && client !== "codex") return undefined;
    const seat = input.sessionName ?? input.binding.tmuxSession;
    if (!seat) return undefined;
    // A seat may be the destination of at most one live task. Two is not a choice this
    // composition may make: attaching either would hand one assignment another's binding.
    // The dispatcher already made that choice, so a launch it started names its task and the
    // row is checked against it rather than the seat being refused outright.
    const rows = dependencies.db.prepare(`
      SELECT a.qitem_id AS qitemId, a.run_id AS runId, a.task_id AS taskId,
        q.source_session AS sourceSession
      FROM team_queue_authority a
      JOIN queue_items q ON q.qitem_id = a.qitem_id
      JOIN team_runs r ON r.id = a.run_id
      WHERE q.destination_session = ? AND q.state IN ('pending', 'in-progress') AND r.state = 'approved'
        AND (? IS NULL OR a.run_id = ?) AND (? IS NULL OR a.task_id = ?)
      LIMIT 2`).all(seat, input.runId ?? null, input.runId ?? null, input.taskId ?? null, input.taskId ?? null) as
        Array<{ qitemId: string; runId: string; taskId: string; sourceSession: string | null }>;
    if (rows.length === 0 && input.runId === undefined && input.taskId === undefined) return undefined;
    if (rows.length !== 1) throw new Error("Managed launch task is ambiguous");
    const row = rows[0]!;
    const task = dependencies.governance.getTask(row.qitemId);
    // T053 made the task record the store for outputs and permissions; a row without one
    // predates it and cannot describe an attempt this composition may produce.
    if (!task) throw new Error("Managed attempt task is not recorded");
    const assignment = task.assignment;
    const runtime = dependencies.runtime();
    if (!runtime) throw new Error("Managed launch runtime is unavailable");
    const roots = dependencies.roots();
    const worker = roots.worker;
    // The unisolated worker is this daemon's own user, so its identity comes from the process
    // rather than from an account provisioning created.
    const identity = new WorkerIdentities(() => ({ workerRoot: roots.workerRoot,
      assignmentRoot: roots.assignmentRoot, identities: roots.workerIdentities }),
    undefined, dependencies.currentUser).resolve(worker);
    const run = dependencies.governance.getRun(row.runId);
    // The destination session names a seat on the run's own rig; a row that resolves to a
    // seat elsewhere would attach this attempt to a binding it never authorized.
    if (run.rigId !== input.rigId) throw new Error("Managed attempt seat is not on the task's rig");
    const remainingMs = run.binding.limits.maxActiveMs - run.activeMs;
    if (remainingMs <= 0) throw new Error("Managed run active-time limit is exhausted");
    const { chat, delivery } = dependencies.owners();
    if (!chat || !delivery) throw new Error("Managed attempt mailbox owners are unavailable");
    // A native-token resume re-enters the attempt it recorded, so the projection is reused
    // and the launcher receives the exact previous receipt. A token with no recorded receipt
    // refuses: resuming outside the worker boundary is never the fallback.
    const previous = input.resumeToken
      ? recordedManagedReceipt({ db: dependencies.db, governance: dependencies.governance }, {
          seat, nativeToken: input.resumeToken, runId: row.runId, qitemId: row.qitemId, client })
      : undefined;
    if (input.resumeToken && !previous) throw new Error("Managed resume receipt is not recorded");
    const attemptId = previous?.attemptId ?? randomUUID();
    const outputs = task.outputs ?? [], permissions = task.permissions ?? [];
    const remainingDeadline = Date.now() + remainingMs;
    if (previous && previous.deadline <= Date.now()) throw new Error("Managed resume deadline has expired");
    // The launcher refuses a resume whose deadline exceeds the previous receipt's, so the
    // resumed attempt stays inside the run clock the first attempt was given.
    const deadline = previous ? Math.min(previous.deadline, remainingDeadline) : remainingDeadline;
    // Admission is asked first so the candidate exists exactly where the producer will be
    // told to look, and a refusal leaves no tree. `produceManagedAttempt` repeats the same
    // admission for this attempt, which is idempotent and re-takes the same claim.
    const admitted = runtime.admitForLaunch(row.runId, { attemptId, worker, assignment,
      outputs, permissions,
      context: { binding: run.binding, runId: row.runId, role: assignment.role, workflow: task.workflow } as
        unknown as import("./integrations/framework/context-manifest.js").ContextManifest });
    let produced: Awaited<ReturnType<WorkflowRuntime["produceManagedAttempt"]>>;
    try {
      const selected = task.workflow;
      if (selected && selected.revision !== FRAMEWORK_PIN.revision) throw new Error("The task's workflow source revision changed");
      const workflow = selected ? prepareFrameworkInvocation({ client, entrypoint: selected.entrypoint,
        origin: selected.origin, binding: run.binding, input: selected.input ??
          (dependencies.db.prepare("SELECT body FROM queue_items WHERE qitem_id = ?").get(task.qitemId) as { body: string }).body,
        readOnly: selected.readOnly }) : undefined;
      if (workflow && "status" in workflow) throw new Error(workflow.reason);
      const capabilityError = selected ? workflowCapabilityRefusal(selected.entrypoint) : null;
      if (capabilityError) throw new Error(capabilityError);
      if (workflow?.readOnly && !dependencies.unisolated && assignment.role !== "reviewer") {
        throw new Error("The hardened policy has no read-only candidate mount for this seat role.");
      }
      const frameworkFiles = frameworkInstructionSources(roots.frameworkRoot,
        selected?.entrypoint ?? (dependencies.unisolated ? undefined : "using-spec-first"));
      // C3 — a lead activation carries its protocol, roster and run instructions, and nothing
      // else does. The roster is the rig's seats whose role the approval covers, and the
      // instructions are the daemon's own words about where the decomposition goes; both are
      // read-only entries the manifest projects, so the lead cannot rewrite what it must obey.
      const lead = assignment.role === "lead" ? leadActivation(dependencies.db, {
        rigId: run.rigId, runId: run.id, roles: run.binding.roles, seat, activationId: attemptId,
        goal: (dependencies.db.prepare("SELECT body FROM queue_items WHERE qitem_id = ?").get(task.qitemId) as { body: string }).body,
        // U5 — a planning run's lead agrees a plan with the owner first; every other lead
        // activation is the decomposition protocol C3 already had.
        phase: run.phase, planRef: run.binding.planRef, buildRoster: planningRosterRequired(run.binding),
        maxSeats: dependencies.readMaxSeats?.() ?? 6,
      }) : undefined;
      produced = await runtime.produceManagedAttempt(row.runId, {
        attemptId, worker, assignment, outputs, permissions,
        role: assignment.role, client, candidate: admitted.candidate, sessionId: seat,
        rigId: run.rigId, taskId: row.taskId, recipients: row.sourceSession ? [row.sourceSession] : [],
        deadline, isCurrent: () => true, ...(previous ? { previous } : {}),
        delivery, chat, context: { client, discoveryRoots: [], mutableStateRoot: identity.scratch,
          ...(workflow ? { workflow } : {}),
          soul: resolveTeamSoul(dependencies.db, run.rigId, assignment.role,
            (dependencies.db.prepare(`SELECT n.soul_id AS id FROM nodes n JOIN sessions s ON s.node_id = n.id
              WHERE n.rig_id = ? AND s.session_name = ? ORDER BY s.rowid DESC LIMIT 1`).get(run.rigId, seat) as { id: string | null } | undefined)?.id ?? undefined),
          ...(lead ? { lead } : {}) },
        frameworkFiles,
      });    } catch (error) {
      if (task.workflow) recordWorkflowOutcome(dependencies.db, {
        // A refused resume did not start its next native generation. Keep its launch block
        // separate so retrying that generation can still record the actual native result.
        attemptId: previous ? randomUUID() : attemptId, qitemId: task.qitemId, generation: 1, workflow: task.workflow,
        outcome: { status: "blocked", artifacts: [], reason: (error instanceof Error ? error.message : "Workflow launch failed").slice(0, 16_384) },
      });
      // A fresh failed admission gives its claim back. An exact resume reuses an earlier
      // owner's claim and must preserve that attempt's work for a later retry.
      if (!previous) runtime.releaseCandidate(row.runId, assignment.taskId, attemptId);
      throw error;
    }
    dependencies.endpoints.set(attemptId, produced.bridge);
    return produced.attempt;
  };
}

/**
 * T039: the roots the workflow runtime isolates candidates with.
 *
 * All come from the installed worker policy — the same bytes the privileged
 * launcher validates — so a candidate is created exactly where the kernel will
 * mount it. Reading the same source is what keeps "created" and "mountable" from
 * drifting apart. An unreadable or incomplete policy is a configuration failure,
 * not a reason to launch without isolation.
 *
 * T048 adds `control_state_dir`: the snapshot lane has no git registry, so its
 * creation record is written under the control state directory, the one location the
 * plan keeps outside every worker-writable tree.
 */
function managedWorkerRoots(): ManagedWorkerRoots {
  const policy = JSON.parse(readFileSyncNamed("/etc/multi-agent/worker-policy.json", "utf8")) as
    { paths?: Record<string, unknown>; worker_identities?: unknown; policy_revision?: unknown };
  // Every root below is one the launcher validates, so each is read from the same bytes and
  // held to the same standard: an absolute, already-resolved path.
  const installed = (key: string): string | null => {
    const value = policy.paths?.[key];
    return typeof value === "string" && nodePath.isAbsolute(value) && nodePath.resolve(value) === value ? value : null;
  };
  const assignmentRoot = installed("assignment_root"), controlStateDir = installed("control_state_dir");
  const workerRoot = installed("worker_root"), contextRoot = installed("context_root");
  const mailboxRoot = installed("mailbox_root"), frameworkRoot = installed("framework_dir");
  const toolchainDir = installed("toolchain_dir");
  const workers = Array.isArray(policy.worker_identities) ? policy.worker_identities : [];
  // The producer refuses a mailbox root that is not `<control_state_dir>/mailboxes`, so an
  // inconsistent policy is a configuration failure here rather than a refused launch later.
  if (!assignmentRoot || !controlStateDir || !workerRoot || !contextRoot || !mailboxRoot || !frameworkRoot || !toolchainDir
    || !Number.isInteger(policy.policy_revision) || (policy.policy_revision as number) < 1
    || !workers.length || typeof workers[0] !== "string"
    || mailboxRoot !== nodePath.join(controlStateDir, "mailboxes")) throw new Error("managed_candidate_policy_unavailable");
  return { assignmentRoot, controlStateDir, worker: workers[0], workerRoot, contextRoot, mailboxRoot,
    policyRevision: policy.policy_revision as number, workerIdentities: workers as string[], frameworkRoot, toolchainDir };
}

/** One tree per task, under the policy's assignment root, addressed the way the launcher expects. */
function managedCandidateRoot(assignmentRoot: string, worker: string, runId: string, taskId: string): string {
  return nodePath.join(assignmentRoot, worker, `${runId}-${taskId}`);
}

/** Native managed health: no terminal control plane remains. */
export function composeSystemHealthReader(dependencies: { db: Database.Database; queue: QueueRepository; evidence?: () => ManagedWorkerHealthEvidence }): () => Promise<TeamSystemHealth> {
  return createSystemHealthReader({
    isolation: "hardened",
    database: () => ({ state: "ok", evidenceRef: "database:schema_version:" + String(dependencies.db.prepare("PRAGMA schema_version").pluck().get()) }),
    queueMailbox: () => ({ state: "ok", evidenceRef: "queue:active:" + dependencies.queue.list({ activeOnly: true, compact: true }).length }),
    controlTmux: async () => ({ state: "unknown", evidenceRef: "native:direct-child", reason: "terminal_control_removed" }),
    workerBoundary: () => ({ state: "unknown", evidenceRef: "native:direct-child", reason: "hardened_boundary_deferred" }),
    sandboxNetwork: () => ({ state: "unknown", evidenceRef: "native:direct-child", reason: "hardened_boundary_deferred" }),
    clients: () => ({ state: "unknown", evidenceRef: "native:direct-child", reason: "hardened_boundary_deferred" }),
    ...(dependencies.evidence ? { latestAttempts: () => attemptsFromManagedWorkerEvidence(() => new Date(), dependencies.evidence!()) } : {}),
  });
}

export function composeUnisolatedHealthReader(dependencies: { db: Database.Database; queue: QueueRepository }): () => Promise<TeamSystemHealth> {
  const unknown = () => ({ state: "unknown" as const, evidenceRef: "workers.isolation:none", reason: "workers_isolation_none" });
  return createSystemHealthReader({
    isolation: "none",
    database: () => ({ state: "ok", evidenceRef: "database:schema_version:" + String(dependencies.db.prepare("PRAGMA schema_version").pluck().get()) }),
    queueMailbox: () => ({ state: "ok", evidenceRef: "queue:active:" + dependencies.queue.list({ activeOnly: true, compact: true }).length }),
    controlTmux: async () => ({ state: "unknown", evidenceRef: "native:direct-child", reason: "terminal_control_removed" }),
    workerBoundary: unknown, sandboxNetwork: unknown, clients: unknown,
    latestAttempts: () => attemptsFromRecords(() => new Date(), (dependencies.db.prepare(`SELECT id, run_id AS runId, provider, state, failure_json AS failureJson FROM team_attempts ORDER BY updated_at DESC, id DESC LIMIT 100`).all() as Array<{ id: string; runId: string; provider: "claude" | "codex"; state: string; failureJson: string | null }>).map(row => ({ id: row.id, runId: row.runId, provider: row.provider, state: row.state, failure: storedFailure(row.failureJson) }))),
  });
}

/**
 * MVP — read `workers.isolation` once, at startup.
 *
 * The value decides whether anything in this process may read `/etc/multi-agent` or call
 * sudo, so it is resolved before the managed chain is composed and never re-read. An
 * unreadable setting is a configuration failure, not a reason to fall back: guessing
 * "none" would silently run an unisolated worker on a host that asked for a sandbox.
 */
export function selectIsolation(override: DaemonOptions["workersIsolation"]): "none" | "hardened" {
  const raw = override ?? new SettingsStore().resolveOne("workers.isolation").value;  if (raw !== "none" && raw !== "hardened") throw new Error(`workers.isolation must be "none" or "hardened", got "${String(raw)}"`);
  return raw;
}

/** The recorded classification of an attempt, or null when it has none or the row is unusable. */
function storedFailure(json: string | null): { reasonCode: string; resumeSafe: boolean } | null {
  if (json === null) return null;
  try { return parseAttemptClassification(JSON.parse(json)); } catch { return null; }
}

export async function createDaemon(opts?: DaemonOptions): Promise<DaemonResult> {
  // Direct callers share the same pre-spawn credential boundary as startServer.
  const ownerToken = process.env.MULTI_AGENT_OWNER_TOKEN?.trim() || null;
  delete process.env.MULTI_AGENT_OWNER_TOKEN;
  const teamControl = opts?.teamControl ?? { credentials: { ownerToken } };
  const daemonHome = os.homedir();
  const configuredCodexHome = process.env.CODEX_HOME || undefined;
  if (configuredCodexHome && !nodePath.isAbsolute(configuredCodexHome)) {
    throw new Error(`CODEX_HOME must be an absolute path for managed seats: ${configuredCodexHome}`);
  }
  const codexHome = configuredCodexHome || nodePath.join(daemonHome, ".codex");
  // Only the explicit selection overrides a pane rc or the legacy PID-home
  // reader. The resolved default remains the writer/network-reader/session root.
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = openDatabase(dbPath);
  // KTD22: fixed before any service is built. Managed mode runs no legacy boot effect below.
  const managed = fixDaemonMode(db, opts?.managedMode === true) === "managed";
  // MVP — how a managed worker runs: as this daemon's own user (`none`, the default), or
  // through the provisioned sandbox (`hardened`). Fixed at startup like the daemon mode, so
  // every launch in this process agrees about which one it is.
  const isolation = managed ? selectIsolation(opts?.workersIsolation) : "none";
  const unisolated = isolation === "none";
  // T053: the worker control credential owner, built before the managed launch chain is
  // composed because that chain captures the credentials object it authenticates with.
  // `reconcile` revokes every row a previous process left: the plaintext is never durable,
  // so an inherited digest can only name a token this daemon cannot honour.
  const workerControl = managed ? new WorkerControlAccess(db, teamControl.credentials) : undefined;
  workerControl?.reconcile();

  setSelfHostId(null);
  setSelfHostIdSource("generated");

  // P7 — the daemon's LIFECYCLE record (distinct from the 059 identity record).
  // A new boot mints a fresh epoch, stamps started_at, and clears any prior run's
  // stopped_at/heartbeat. The heartbeat (index.ts post-bind) advances last-seen
  // while running; a clean shutdown (index.ts shutdown, AFTER stopping the timer)
  // stamps stopped_at for THIS epoch.
  const daemonLifecycleStore = new DaemonLifecycleStore(db);
  const daemonBootEpoch = randomUUID();
  daemonLifecycleStore.recordBoot(daemonBootEpoch, new Date().toISOString());

  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const streamStore = new StreamStore(db, eventBus);
  // Explicit source opt-in only. No sink I/O until a separate drain request.
  const shadow = configureShadowCapture(process.env.MULTI_AGENT_SHADOW_CAPTURE);
  const slowOpRecorder = opts?.slowOpRecorder ?? (dbPath === ":memory:"
    ? undefined
    : new SlowOpRecorder({
        logPath: nodePath.join(MULTI_AGENT_HOME, "logs", "slow-operations.jsonl"),
      }));
  configureSyncSiteRecorder(slowOpRecorder);
  // Instrumentation wiring is observe-only: neither a throwing registration
  // call nor a throwing callback body (streamStore.emit) may abort createDaemon
  // or later wrapped work. Guard both boundaries.
  try {
    slowOpRecorder?.setDegradedHandler?.(({ reason, site }) => {
      try {
        streamStore.emit({
          sourceSession: "daemon@kernel",
          body: `slow-operation instrumentation degraded: ${reason} at ${site}`,
          hintType: "observation",
          hintUrgency: "high",
          hintTags: ["daemon", "slow-operation", "observability-degraded"],
        });
      } catch (error) {
        console.error("[slow-operation] degradation notification failed", error);
      }
    });
  } catch (error) {
    console.error("[slow-operation] setDegradedHandler registration failed", error);
  }
  // PL-004 Phase A revision (R1): topology-backed validateRig.
  // Reject `<member>@<unknown-rig>` shapes against the rig registry.
  // Bare ids without `@` are also rejected
  // (no canonical rig binding).
  // OPR.0.4.6.MH1 FR-8: this gate is the ARCHETYPE consumer of the shared
  // parse contract — human-seat classification BEFORE parse, then the
  // greedy first-@ rig (so "member@rig@x" looks up rig "rig@x", misses,
  // and rejects with the same unknown_destination_rig as ever — BR-1).
  const topologyValidateRig = (sessionRef: string): boolean => {
    const parsed = parseSessionName(sessionRef);
    // M1 A4b — @external entity-admission (checked BEFORE the human-CLASS bare-admit,
    // which A2 also makes true for <local>@external): a queue row destinationed to
    // <local>@external is admitted ONLY if the human is REGISTERED (or it is a literal
    // scheme address); an unregistered entity is REFUSED (the 4b site carries the
    // entity-level teaching via externalAdmissionTeaching). Admission is the gateway's
    // job, never the classifier's (arch 8cd30094).
    if (parsed.kind === "external") {
      const reg = loadHumanRegistry();
      const entities = reg.ok ? reg.entities.map((e) => ({ entityId: e.entityId, address: e.address })) : [];
      return resolveExternal(parsed.local, entities).kind !== "unregistered";
    }
    if (isHumanSeatSessionRef(sessionRef)) return true;
    if (parsed.kind !== "canonical") return false;
    return rigRepo.findRigsByName(parsed.rig).length > 0;
  };
  // Seat absence in positively known local topology is advice, never admission
  // authority. Keep every typed destination intact, including adopted aliases.
  const topologyDestinationAdvisory = (sessionRef: string) => {
    const parsed = parseSessionName(sessionRef);
    if (isHumanSeatSessionRef(sessionRef) || parsed.kind !== "canonical") return null;
    const rigs = rigRepo.findUnarchivedRigsByName(parsed.rig);
    if (rigs.length === 0) return null;
    // Membership needs only registered names and logical seat coordinates,
    // not the full inventory projection (activity and lifecycle history).
    for (const rig of rigs) {
      if (db.prepare(`SELECT 1 FROM sessions s JOIN nodes n ON n.id = s.node_id
        WHERE n.rig_id = ? AND s.session_name = ? LIMIT 1`).get(rig.id, sessionRef)) return null;
      if (db.prepare(`SELECT 1 FROM nodes WHERE rig_id = ? AND
        CASE WHEN instr(logical_id, '.') = 0 THEN logical_id
          WHEN instr(logical_id, '.') > 1 AND instr(logical_id, '.') < length(logical_id)
          THEN substr(logical_id, 1, instr(logical_id, '.') - 1) || '-' || substr(logical_id, instr(logical_id, '.') + 1)
        END = ? LIMIT 1`).get(rig.id, parsed.member)) return null;
    }
    const names = rigs.flatMap((rig) => db.prepare(`SELECT n.logical_id, s.session_name
      FROM nodes n LEFT JOIN sessions s ON s.id =
        (SELECT id FROM sessions WHERE node_id = n.id ORDER BY id DESC LIMIT 1)
      WHERE n.rig_id = ?`).all(rig.id) as Array<{ logical_id: string; session_name: string | null }>);
    const canonicalName = (logicalId: string) => {
      const dot = logicalId.indexOf(".");
      if (dot < 0) return `${logicalId}@${parsed.rig}`;
      return dot > 0 && dot < logicalId.length - 1
        ? deriveCanonicalSessionName(logicalId.slice(0, dot), logicalId.slice(dot + 1), parsed.rig) : null;
    };
    const availableDestinations = [...new Set(names.flatMap((entry) => [
      entry.session_name, canonicalName(entry.logical_id),
    ]).filter((destination): destination is string => !!destination && parseSessionName(destination).kind === "canonical"))].sort();
    return {
      code: "unmatched_destination_seat" as const,
      destinationSession: sessionRef,
      availableDestinations,
      message: `Suspected seat typo: '${sessionRef}' matches no session address of locally known rig '${parsed.rig}'. `
        + `Available destinations: ${availableDestinations.join(", ") || "(none)"}. `
        + "The row keeps the exact destination as typed; this warning does not guarantee pickup or delivery.",
    };
  };
  // PL-004 Phase A — shared coordination services. Constructed early so
  // both the queueRepo dep slot and inboxHandler can share one instance.
  // Transport is wired after SessionTransport instantiation below via
  // attachTransport().
  const queueRepoInstance = new QueueRepository(db, eventBus, {
    validateRig: topologyValidateRig,
    destinationAdvisory: topologyDestinationAdvisory,
    // OPR.0.4.6.WF3 FR-6 — the frontier close-path guard's predicate,
    // INJECTED here (arch layering pin: the queue never imports the
    // workflow domain; startup wires them — the validateRig precedent).
    workflowFrontierPredicate: createWorkflowFrontierPredicate(db),
    // GHOST-STAGE (h): resolve the source seat's atom-B generation for the handoff-nudge Sent: line
    // (same injected-predicate layering — the queue never imports the session domain).
    resolveOccupantGeneration: (sessionName) => sessionRegistry.currentOccupantGenerationForSession(sessionName),
  });
  // W1 (transactional closure): ONE OutboxHandler shared between the deps slot
  // (sender-side audit surface) and the queue repo's durable wake-intent
  // staging. Same `db`, so a stageWakeIntent() call inside a terminal
  // db.transaction commits atomically with the close + successor create.
  const outboxHandlerInstance = new OutboxHandler(db);
  queueRepoInstance.attachOutbox(outboxHandlerInstance);
  // PL-004 Phase B — classifier lease manager. Constructed early so both
  // the leaseManager dep slot and project-classifier can share one instance.
  // isAlive is post-attached after whoami-service is constructed.
  const classifierLeaseManagerInstance = new ClassifierLeaseManager(db, eventBus);
  // PL-004 Phase B — view-projector. Constructed early so both the
  // viewProjector dep slot and the view-event-bridge can share one instance.
  const viewProjectorInstance = new ViewProjector(db, eventBus);
  // PL-004 Phase B R1 (closes guard BLOCKER 2): wire the view event bridge
  // so queue/inbox/project mutations emit view.changed for affected built-in
  // views. SSE consumers on /api/views/:name/sse now receive change events
  // when underlying state mutates.
  if (!managed) wireViewEventBridge(eventBus, viewProjectorInstance);

  // PL-004 Phase C — watchdog supervision tree. Repository + history-log
  // are constructed early; the policy engine + scheduler are constructed
  // after SessionTransport is available so the engine can wire delivery.
  const watchdogJobsRepoInstance = new WatchdogJobsRepository(
    db,
    undefined, // now (default clock)
    // GHOST-STAGE (e/Class-B): stamp the arming occupant's generation so a swap can drop its armed jobs.
    (sessionName) => sessionRegistry.currentOccupantGenerationForSession(sessionName),
  );
  queueRepoInstance.attachWatchdogJobsRepository(watchdogJobsRepoInstance);
  const watchdogHistoryLogInstance = new WatchdogHistoryLog(db);

  const launchPath = process.env.PATH ?? "";
  const startupSettings = new ContextPackSettingsStore().resolveConfig();
  // KTD22: one governance owner serves the app and the managed launch chain, which only managed attempts reach.
  // MVP slice 2 — what a new run's binding is approved against. Under `hardened` that is the
  // caller's own reader, unchanged. Under `workers.isolation: none` nothing is installed, so
  // the daemon states the unisolated roots' revision instead of reading a policy file that
  // does not exist on such a host; dispatch then refuses a binding built for any other mode.
  const runPolicyCapability = teamControl.readPolicyCapability
    ?? (unisolated ? () => unisolatedPolicyCapability(unisolatedWorkerRoots(MULTI_AGENT_HOME).policyRevision) : undefined);
  // Governance checks each task against the same reader the start route approved the run with.
  const teamGovernance = new PlanGovernance(db, eventBus, queueRepoInstance, undefined, runPolicyCapability);
  // MVP — the roots in force for this daemon. Under `hardened` they are the installed policy's,
  // read at use so a re-provisioned host is picked up; under `none` they are the daemon's own
  // state tree, so nothing in the launch path ever reads `/etc/multi-agent`.
  const rootsNow = unisolated
    ? (() => {
        const roots = unisolatedWorkerRoots(MULTI_AGENT_HOME);
        return () => roots;
      })()
    : managedWorkerRoots;
  const lastWorkerHeartbeat = new Map<string, number>();
  const managedLaunch = managed ? composeDirectLaunch({ governance: teamGovernance, rigRepo,
        workflowRuntime: () => workflowRuntime,
        // U4 — every supervised turn records its durable lifecycle facts through governance.
        lifecycle: fact => teamGovernance.recordAttemptLifecycle(fact),
        onEvent: (facts, event) => {
          // The lifecycle recorder owns acknowledgment; notifications only wake live projections.
          if (event.type === "attempt.acknowledged") return;
          if (event.type === "heartbeat") {
            const now = Date.now(), last = lastWorkerHeartbeat.get(facts.attemptId);
            if (last !== undefined && now - last < 15_000) return;
            lastWorkerHeartbeat.set(facts.attemptId, now);
          }
          const run = teamGovernance.getRun(facts.runId);
          eventBus.emit({ type: "team.control", protocolVersion: "1.0", eventId: randomUUID(), rigId: run.rigId,
            runId: run.id, taskId: facts.taskId, attemptId: facts.attemptId, entityId: facts.attemptId,
            entityVersion: run.entityVersion, action: `worker.${event.type}`, payload: workerEventNotification(event) });
        },
        ...(opts?.directLaunchCommand ? { command: opts.directLaunchCommand } : {}),
        ...(opts?.directLaunchExecutable ? { executablePath: opts.directLaunchExecutable } : {}),
        ...(opts?.directLaunchSupervise ? { supervise: opts.directLaunchSupervise } : {}) }) : undefined;
  const workerLauncher = managedLaunch ? { workerLauncher: managedLaunch.launcher } : {};
  // T047 — the attachment every managed launch path resolves through. Assigned once the runtime
  // exists below; a wrapper that reads it at launch time is the only correct shape, because the
  // runtime is constructed later in this function and no managed launch precedes it.
  let managedAttempt: ((input: import("./domain/startup-orchestrator.js").StartupInput) =>
    Promise<import("./domain/runtime-adapter.js").ManagedAttempt | undefined>) | undefined;
  // T047-H1: the KTD26 reader, composed from the owners above, injected through the one teamControl options object.
  // `evidence` is the control's own verified observation, so it exists only when the launch chain does. A caller that
  // supplied its own reader keeps it: that is the injection seam the tests and any embedding host use.
  const teamControlOptions: NonNullable<AppDeps["teamControl"]> = { ...teamControl, readSystemHealth: teamControl.readSystemHealth
    ?? (unisolated
      // MVP — three of the six lights describe the hardened boundary. With `workers.isolation:
      // none` that boundary genuinely does not exist, so each says so instead of reading an
      // installed file nothing enforces. The other three are unchanged.
      ? composeUnisolatedHealthReader({ db, queue: queueRepoInstance })
      : composeSystemHealthReader({ db, queue: queueRepoInstance,
          ...(managedLaunch ? { evidence: managedLaunch.readHealthEvidence } : {}) })),
    // MVP slice 2 — the capability a start request approves its binding against.
    ...(runPolicyCapability ? { readPolicyCapability: runPolicyCapability } : {}),
    // U5 / KTD10 — where a planning run's plan worktree lives. The default is the short root
    // the worktree policy names (`%LOCALAPPDATA%\Multi-Agent\wt` on Windows, `~/.multi-agent/wt`
    // elsewhere), because Git for Windows refuses a worktree path above a measured ceiling. The
    // policy preflights every path against that ceiling, so a root that is too deep is refused
    // by name rather than failing inside Git.
    planWorktreeRoot: teamControl.planWorktreeRoot ?? defaultWorktreeRoot,
    ...(unisolated && !teamControl.resolveBinding && runPolicyCapability ? { resolveBinding: run => {
      const policy = runPolicyCapability();
      if (!policy) throw new Error("Current policy capability is unavailable");
      return refreshPlanBinding(run.binding, policy);
    } } : {}) };
  // T053 — the seat capability a managed send must reuse. `createApp` builds the mailbox
  // owner when none is supplied, so this rides the deps slot rather than constructing it
  // twice: one owner, one seat table.
  // The mailbox owner `createApp` builds reads this slot (through `deps`), so a managed send
  // reuses the seat's recorded value instead of minting a second one.
  const seatCapabilities = new SeatMailboxCapabilities(db);
  const readSeatMailboxCapability = (runId: string, sessionId: string) => seatCapabilities.find(runId, sessionId);
  // T052 — the managed owner read projection, composed over the same owners the
  // daemon already built. A caller that supplied one keeps it: that is the
  // injection seam the tests and any embedding host use.
  if (!teamControlOptions.readModel) {
    teamControlOptions.readModel = new TeamReadModel({
      db,
      governance: teamGovernance,
      events: eventBus,
      readTaskWorkspace: (runId, taskId) => {
        const candidate = workflowRuntime?.existingCandidate(runId, taskId);
        return candidate ? { root: candidate.root, sourceRoot: candidate.sourceRoot,
          baseCommit: candidate.base.kind === "commit" ? candidate.base.commit : null } : null;
      },
      readTaskRows: (runId: string) => (db.prepare(
        `SELECT a.qitem_id AS qitemId, a.task_id AS taskId,
          json_extract(a.assignment_json, '$.role') AS role,
          q.state AS queueState, q.destination_session AS session
          FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
          WHERE a.run_id = ? ORDER BY a.task_id`).all(runId) as Array<{
            qitemId: string; taskId: string; role: string; queueState: string; session: string | null }>),
    });
  }
  // #275: one reader for both Codex launch adapters, with the PATH, HOME and CODEX_HOME a seat session gets.
  const { StartupOrchestrator } = await import("./domain/startup-orchestrator.js");
  const { ClaudeCodeAdapter } = await import("./adapters/claude-code-adapter.js");
  const { CodexRuntimeAdapter } = await import("./adapters/codex-runtime-adapter.js");
  const { ProjectionManifestStore } = await import("./domain/projection-manifest-store.js");
  const { hashContent } = await import("./domain/conflict-detector.js");
  const projectionManifestStore = new ProjectionManifestStore(db);
  const fsOps = {
    readFile: (file: string) => fs.readFileSync(file, "utf8"),
    writeFile: (file: string, content: string) => fs.writeFileSync(file, content, "utf8"),
    exists: (file: string) => fs.existsSync(file),
    mkdirp: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
    copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    listFiles: (dir: string) => fs.readdirSync(dir),
    readdir: (dir: string) => fs.readdirSync(dir),
    statMode: (file: string) => fs.statSync(file).mode,
    chmod: (file: string, mode: number) => fs.chmodSync(file, mode),
    homedir: daemonHome,
  };
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus,
    managedAttempt: input => managedAttempt?.(input) ?? Promise.resolve(undefined) });
  const claudeAdapter = new ClaudeCodeAdapter({ fsOps, ...workerLauncher,
    recordProjection: (targetPath: string, content: string) => projectionManifestStore.record({ targetPath, lastHash: hashContent(content), writtenAt: new Date().toISOString() }) });
  const codexAdapter = new CodexRuntimeAdapter({ fsOps, ...workerLauncher });
  const { ContextUsageStore } = await import("./domain/context-usage-store.js");
  const contextUsageStore = new ContextUsageStore(db, { stateDir: MULTI_AGENT_HOME, codexHome: configuredCodexHome,
    resolveOccupantBootAt: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.bootAt ?? null });
  const agentActivityStore = new AgentActivityStore({ db, eventBus,
    resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) => sessionRegistry.isOccupantGenerationRegistered(nodeId, generation) });
  const deps: AppDeps = {
    teamControl: teamControlOptions,
    teamGovernance,
    readSeatMailboxCapability,
    ...(managedLaunch ? { managedLaunch } : {}),
    rigRepo, sessionRegistry, daemonLifecycleStore, daemonBootEpoch, eventBus,
    startupOrchestrator,
    runtimeAdapters: { "claude-code": claudeAdapter, codex: codexAdapter },
    chatRepo: new ChatRepository(db),
    slowOpRecorder,
    queueRepo: queueRepoInstance,
    inboxHandler: new InboxHandler(db, eventBus, queueRepoInstance),
    outboxHandler: outboxHandlerInstance,
    shadowCapture: shadow.capture,
    shadowCaptureError: shadow.error,
    classifierLeaseManager: classifierLeaseManagerInstance,
    projectClassifier: new ProjectClassifier(db, eventBus, classifierLeaseManagerInstance),
    classificationAttemptLedger: new ClassificationAttemptLedger(db, classifierLeaseManagerInstance),
    viewProjector: viewProjectorInstance,
    watchdogJobsRepo: watchdogJobsRepoInstance,
    watchdogHistoryLog: watchdogHistoryLogInstance,
    agentActivityStore,
    contextUsageStore,
  };

  // PL-004 Phase C — watchdog policy engine + scheduler. Wired here
  // (after deps construction) so the engine can dispatch deliveries
  // through the live SessionTransport. Scheduler is started by
  // index.ts after listen() so the daemon's HTTP surface is ready
  // before the scheduler's first tick.
  // PL-004 Phase D — workflow runtime + workflow-keepalive policy.
  // Workflow runtime is constructed first; then the watchdog policy
  // engine is constructed with workflow-keepalive injected via
  // additionalPolicies (orch-ratified Phase D extension point per
  // slice IMPL § Write Set / § Driver Handoff Contract).
  const queueRepoForWorkflow = deps.queueRepo;
  let workflowRuntime: WorkflowRuntime | undefined;
  let workflowExceptionEnsurer:
    | import("./domain/workflow-exception-escalation.js").EnsureStuckExceptionItem
    | undefined;
  if (queueRepoForWorkflow) {
    // T039: in managed mode the runtime is the isolation owner, so it gets the roots
    // the kernel mounts from. They come from the installed policy — the same bytes the
    // privileged launcher validates — so a candidate is created exactly where the launcher
    // will look for it. An unreadable policy throws rather than silently launching without
    // isolation.
    //
    // T053: every callback below re-reads the policy at use instead of capturing it here. A
    // host that re-provisions while the daemon runs would otherwise leave the producer writing
    // into the old roots and the launcher validating new ones, which is the disagreement this
    // composition exists to prevent.
    const policyNow = managed ? rootsNow() : undefined;
    // T053: the producer's remaining inputs, from owners this composition already holds —
    // the installed policy for identity and roots, the control database for the seat's
    // capability, and the credential owner above for the token its endpoint authenticates with.
    const managedInputs = policyNow && workerControl ? {
      identities: new WorkerIdentities(() => {
        const policy = rootsNow();
        return { workerRoot: policy.workerRoot, assignmentRoot: policy.assignmentRoot, identities: policy.workerIdentities };
      }, undefined, unisolated),
      capabilities: seatCapabilities,
      credentials: workerControl,
    } : undefined;
    workflowRuntime = new WorkflowRuntime({
      db,
      eventBus,
      queueRepo: queueRepoForWorkflow,
      ...(policyNow ? {
        assignmentRoot: () => rootsNow().assignmentRoot,
        defaultWorker: () => rootsNow().worker,
        candidateRoot: (runId: string, taskId: string, worker: string) =>
          managedCandidateRoot(rootsNow().assignmentRoot, worker, runId, taskId),
        candidateRecordsRoot: () => nodePath.join(rootsNow().controlStateDir, "candidates"),
        // T053: where the producer writes what the launcher mounts, read from the same
        // installed policy bytes at the moment of use; and the ownership facts it cannot
        // derive itself.
        managedAttemptRoots: () => {
          const roots = rootsNow();
          return { contextRoot: roots.contextRoot, mailboxRoot: roots.mailboxRoot,
            controlStateDir: roots.controlStateDir, policyRevision: roots.policyRevision,
            workerIdentities: roots.workerIdentities, frameworkRoot: roots.frameworkRoot,
            frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir: roots.toolchainDir };
        },
        // MVP — when the worker is the daemon's own user the projection's private-ownership
        // checks prove nothing (there is one identity), so they are skipped by name rather
        // than satisfied by construction.
        ...(unisolated ? { sameIdentity: true } : {}),
        ...(managedInputs ? {
          managedAttemptInputs: {
            issueCredential: (runId: string, sessionId: string) => managedInputs.credentials.issue(runId, sessionId),
            hasCredential: (runId: string, sessionId: string) => managedInputs.credentials.has(runId, sessionId),
            // A read, never a mint: the endpoint authenticates every request through this, and a
            // request against a revoked seat must not bring its credential back.
            readCredentials: () => managedInputs.credentials.readCredentials(),
            mailboxCapability: (runId: string, sessionId: string) => managedInputs.capabilities.forSeat(runId, sessionId),
            workerIdentity: (worker: string) => managedInputs.identities.resolve(worker),
          },
          onManagedAttemptRetired: (attempt: { runId: string; sessionId: string }) =>
            managedInputs.credentials.retire(attempt.runId, attempt.sessionId),
        } : {}),
      } : {}),
      // OPR.0.4.6.WF1 FR-3: instantiate/handoff auto-arm the
      // per-instance workflow-keepalive job in-txn; terminal disarms.
      watchdogJobsRepo: watchdogJobsRepoInstance,
      // OPR.0.4.6.WF5 FR-2: the maturity dial — host default read LIVE
      // per exception from the settings twin (dial flips affect future
      // items only, never retroactive re-routing).
      exceptionDial: {
        hostDefault: () => {
          const v = new ContextPackSettingsStore().resolveOne("workflow.exception_routing")
            .value as string | undefined;
          return v === "orchestrator" || v === "human_only" ? v : null;
        },
        humanFallbackSeat: resolveWorkflowHumanDestination,
      },
    });
    deps.workflowRuntime = workflowRuntime;
    // U7 — the run's integration branch. The worktree root is the one U5's plan worktree lives
    // under, and the patch is the runtime's own candidate read, so what lands is exactly the
    // work the reviewer approved and `multi-agent team apply` would have applied.
    {
      const { composeIntegration } = await import("./domain/integration-branch.js");
      deps.integration = composeIntegration({
        db, governance: teamGovernance,
        worktreeRoot: () => teamControlOptions.planWorktreeRoot!(),
        candidateManifest: (runId: string, taskId: string) => {
          if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
          return workflowRuntime.candidateManifestFor(runId, taskId);
        },
        sourceRefMoved: (repository, move) => workflowRuntime?.acceptOwnerMerge(repository, move),
        // The binding every other command reads: the plan at the worktree's current head. A
        // commit the daemon just landed moves that head, and the recorded binding has to move
        // with it or the next dispatch would see a run whose plan changed under it.
        ...(runPolicyCapability ? { currentBinding: (runId: string) => {
          const run = teamGovernance.getRun(runId), policy = runPolicyCapability();
          return policy ? refreshPlanBinding(run.binding, policy) : run.binding;
        } } : {}),
      });
      teamControlOptions.integrateTask = (runId: string, taskId: string) => deps.integration!.integrate(runId, taskId);
    }
    // T047 — assigned here, after the runtime it produces through exists and before the app
    // serves: every seat launch that could reach a worker happens after this point.
    managedAttempt = managedLaunch ? composeManagedAttemptAttachment({
      readMaxSeats: () => Number(deps.settingsStore?.resolveOne("team.maxSeats").value ?? 6),
      db, governance: teamGovernance, endpoints: managedLaunch.endpoints,
      runtime: () => workflowRuntime,
      owners: () => ({ chat: deps.chatRepo, delivery: deps.mailboxDelivery }),
      roots: rootsNow, currentUser: unisolated, unisolated,
    }) : undefined;

    // OPR.0.4.6.WF5 FR-2 class (b): the shared detection-time exception
    // ensurer — sweep + keepalive both call it; dedup by occurrence tags.
    {
      const { makeEnsureStuckExceptionItem } = await import(
        "./domain/workflow-exception-escalation.js"
      );
      workflowExceptionEnsurer = makeEnsureStuckExceptionItem({
        db,
        queueRepo: queueRepoForWorkflow,
        resolveRoute: (name, version, cls, boundRig) =>
          workflowRuntime!.resolveExceptionRouteFor(name, version, cls, boundRig),
        humanFallbackSeat: resolveWorkflowHumanDestination,
        log: (line) => console.log(line),
      });
    }

    // Seed built-in starter workflow_specs into the cache. Idempotent
    // + workspace-surface-respecting — operator
    // overrides at workspace paths are preserved (skip-if-cached).
    // Errors are collected into the result for diagnostic logging but
    // do NOT block startup; a malformed bundled spec should not bring
    // the daemon down.
    const { loadStarterWorkflowSpecs, defaultBuiltinSpecsDir } = await import(
      "./domain/workflow/starter-spec-loader.js"
    );
    const builtinSpecsDir = defaultBuiltinSpecsDir();
    const starterResult = !managed ? loadStarterWorkflowSpecs({
      cache: workflowRuntime.specCache,
      builtinDir: builtinSpecsDir,
    }) : undefined;
    // OPR.0.3.2.22 Bug 4 — one-time prune of cache rows whose source_path
    // lives in noise directories (.worktrees, node_modules, etc.). The
    // post-Bug-4 walkYamlFiles SKIP_DIRS guard prevents NEW rows from
    // those locations, but legacy rows from prior daemon versions (or
    // operators who hand-imported a spec via path-form before SKIP_DIRS
    // shipped) would persist without this prune. Cheap (single DELETE
    // with bounded LIKE patterns) and safe (matches only the same
    // directories the walker now refuses to enter).
    //
    // installRoot guard: shipped built-in workflow specs live at
    // `<pkg>/dist/builtins/workflow-specs/` in production. Without the
    // install-root preservation clause, the `%/dist/%` pattern would
    // delete them on every boot (then loadStarterWorkflowSpecs re-seeds
    // — wasteful at best, broken if the loader ever skips re-seeding).
    // Pass the resolved install root so rows under it are preserved.
    const { getMultiAgentInstallRoot } = await import("./domain/cwd-resolution.js");
    if (!managed) workflowRuntime.specCache.pruneNoiseDirRows(getMultiAgentInstallRoot());

    if (starterResult && starterResult.errors.length > 0) {
      console.warn(
        `[starter-spec-loader] ${starterResult.errors.length} spec(s) failed to load:`,
        starterResult.errors,
      );
    }
  }

  deps.legacyBearerToken = opts?.bearerToken ?? null;

  const settingsStore = new SettingsStore();
  deps.settingsStore = settingsStore;



  // Context monitor is retained for runtime readiness telemetry used by the
  // managed launch path. It no longer owns compaction or snapshot behavior.
  const { ContextMonitor } = await import("./domain/context-monitor.js");
  const contextMonitor = new ContextMonitor(db, contextUsageStore, undefined, undefined, {
    "claude-code": claudeAdapter,
    codex: codexAdapter,
  });

  // GHOST-STAGE (e/Class-B) — construct the canonical OccupantInvalidator now that both Class-A deps
  // exist (the enforcer's in-mem maps 1a-1f + the context sidecar 2a). Injected into SeatHandoverService
  // via the app context so commit()'s re-key call FIRES (it was a no-op until wired). An absent enforcer
  // (degraded boot, no sessionTransport) falls back to a sidecar-only invalidator — never throws.
  const { DefaultOccupantInvalidator } = await import("./domain/occupant-invalidator.js");
  deps.occupantInvalidator = new DefaultOccupantInvalidator({
    enforcer: { invalidateOccupant: () => {} },
    contextUsage: contextUsageStore,
    // (e/Class-B) watchdog store — armed jobs registered by the retiring generation stop at swap.
    watchdog: watchdogJobsRepoInstance,
    // (e/Class-B) queue store — in-progress items claimed by the retiring generation release to pending.
    queue: queueRepoInstance,
    log: (msg) => console.warn(msg),
  });

  // MVP — what a new task starts. Under `workers.isolation: none` nothing else ever launches
  // the agent a start request puts work on, so the start request dispatches it. Under hardened
  // isolation an agent starts through the privileged launcher, and the start keeps its
  // existing behaviour.
  if (managed && unisolated) {
    const { composeTaskDispatch } = await import("./domain/task-dispatch.js");
    // MVP — the run's live-session count and its limit, asked before a client starts. Both are
    // read from the run's own rows and binding, so the dispatcher cannot disagree with the
    // governance gate that enforces the same limit when the launch's receipt is registered.
    const liveSessions = (runId: string) => (db.prepare(
      "SELECT count(*) AS count FROM team_attempts WHERE run_id = ? AND state IN ('running', 'unknown')")
      .get(runId) as { count: number }).count;
    const maxSessions = (runId: string) => teamGovernance.getRun(runId).binding.limits.maxSessions;
    deps.teamControl!.dispatch = composeTaskDispatch({ rigRepo, sessions: sessionRegistry, startupOrchestrator, runtimeAdapters: deps.runtimeAdapters ?? {},
      prepareDeliveryLeadTurn: (runId, taskId) => {
        if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
        return workflowRuntime.prepareDeliveryLeadTurn(runId, taskId);
      },
      liveSessions, maxSessions, renewApproval: runId => teamGovernance.renewImplementationApproval(runId) });
    // MVP — a task admitted while the run was at its limit used to wait forever: nothing tried
    // it again. A freed slot now starts the run's next pending task through the same dispatch,
    // as internal scheduling over the durable queue rather than an owner verb.
    const { composePendingDispatch } = await import("./domain/pending-dispatch.js");
    const dispatchPending = composePendingDispatch({ db, dispatch: () => deps.teamControl?.dispatch,
      liveSessions, maxSessions });
    // MVP — the other end of that dispatch. A direct launch's receipt names the client process
    // the seat runs, and nothing wrote or closed the attempt from it, so a task could never be
    // observed to finish. This path admits the attempt when its receipt lands, records it stopped
    // when the process it named is gone, and records the daemon-verifiable outcome.
    const { composeAttemptCompletion } = await import("./domain/attempt-completion.js");
    const { AttemptTelemetry } = await import("./domain/attempt-telemetry.js");
    // U6 — the lead as manager: what its turn delivered, and what its team did since it spoke.
    // It runs on this sweep's cadence (one owner of "the queue as it is now") and asks the same
    // dispatch every other launch uses, so nothing here starts a client of its own.
    const { composeLeadManager } = await import("./domain/lead-manager.js");
    // The run's current binding, read the way every control command reads it.
    const currentBinding = (runId: string) => {
      const run = teamGovernance.getRun(runId), policy = runPolicyCapability?.();
      return policy ? refreshPlanBinding(run.binding, policy) : run.binding;
    };
    const leadManager = composeLeadManager({ db, governance: teamGovernance,
      readLeadProposal: (runId, taskId) => {
        if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
        return workflowRuntime.leadProposalWithSeatsFor(runId, taskId);
      },
      readMaxSeats: () => Number(deps.settingsStore?.resolveOne("team.maxSeats").value ?? 6),
      currentBinding, dispatch: () => deps.teamControl?.dispatch });
    // The direct worker's mutable state root: each attempt's prompt, its captured Codex thread
    // id and its final message live under it. One value, so the readers of a turn's end cannot
    // disagree about where.
    const turnStateRoot = nodePath.join(rootsNow().workerRoot, rootsNow().worker, "scratch");
    const telemetry = new AttemptTelemetry(db, { turnStateRoot });
    deps.attemptTelemetry = telemetry;
    // U4 — a restart reconciles the attempts its predecessor left running before the first sweep.
    const { bootReconcileAttempts } = await import("./domain/boot-recovery.js");
    deps.attemptCompletion = composeAttemptCompletion({ db, governance: teamGovernance, sessions: sessionRegistry,
      turnStateRoot, telemetry,
      reconcileOnBoot: () => bootReconcileAttempts({ db, governance: teamGovernance }),
      // U3 — a native turn's own end: the supervisor writes what it observed to the attempt's
      // output, and that is the classifier's evidence now that no pane holds an exit status.
      turnExit: attemptId => readSupervisorExit(turnStateRoot, attemptId),
      captureTurnDocuments: attempt => {
        if (attempt.role !== "lead" || !teamGovernance.documents(attempt.runId)) return;
        const run = teamGovernance.getRun(attempt.runId), lead = teamGovernance.leadTask(attempt.runId);
        try {
          if (!lead || !workflowRuntime) throw new Error("The document reader is not available.");
          teamGovernance.captureLeadDocuments(attempt.runId, attempt.id,
            workflowRuntime.documentsFor(attempt.runId, lead.taskId, run.binding.planRef));
        } catch {
          teamGovernance.captureLeadDocuments(attempt.runId, attempt.id, {}, "The lead's document files could not be saved. Ask the lead to repair them.");
        }
      },
      readTaskReport: (runId, attemptId) => {
        if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
        return workflowRuntime.taskReportFor(runId, attemptId, turnStateRoot);
      },
      candidateManifestFor: (runId, taskId) => {
        if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
        return workflowRuntime.candidateManifestFor(runId, taskId);
      },
      readLeadProposal: (runId, taskId) => {
        if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
        return workflowRuntime.leadProposalFor(runId, taskId);
      },
      // U6 — a delivery lead's second deliverable is the question only the owner can answer.
      readLeadEscalation: (runId, taskId) => {
        if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
        const escalation = workflowRuntime.leadEscalationFor(runId, taskId);
        return escalation === null ? null : { optionCount: escalation.options.length };
      },
      // T033 — the exit evidence a direct launch leaves behind. The seat's pane is where the
      // client ran, so tmux's own record of that pane ending (its dead flag and exit status)
      // and the last lines it held are the only structured evidence available without a
      // wrapper around the native client. Both reads are read-only; a pane this daemon cannot
      // see yields no evidence, which the classifier treats as "not classified", never a retry.
      // The launch stamps the task it starts into the pane, so a seat with two live tasks — two
      // completed implementers are two pending reviews on the same reviewer seat — still admits
      // the attempt the receipt names.
      // U5 — the end of a lead's turn is the lead's reply in the run's chat, and a message that
      // waited for that turn is the next turn's prompt. The conversation owner reads the turn's
      // recorded final message and asks the same dispatch for the next turn. U6 adds the one
      // other thing the turn can say: the decision it asked the owner for.
      onAttemptStopped: async attempt => {
        await composeLeadTurnEnd({ db, governance: teamGovernance, turnStateRoot,
          readEscalation: (runId, taskId) => workflowRuntime ? workflowRuntime.leadEscalationFor(runId, taskId) : null,
          dispatch: () => deps.teamControl?.dispatch })(attempt);
        // The decomposition is admitted at the turn's end, after the turn's message is stored,
        // so the owner reads what the lead said before the tasks it admitted appear.
        await leadManager.turnEnd(attempt);
      },
      // U7 — an approving review is the run's signal to deliver: the implementer's task lands as
      // one commit on the run's branch, through the same owner the merge route reads.
      ...(deps.integration ? { integrateTask: (runId: string, taskId: string) => deps.integration!.integrate(runId, taskId) } : {}),
      // U6 — the facts no single attempt produces — a failed retry, an exhausted review, an
      // integration conflict, every task done — are read once per tick, after the attempts.
      onSweep: () => leadManager.sweep(),
      dispatchPending,
      currentBinding });
    // T017 (cancellation half) — the owner's cancel stops the work. Dispatch closure is the
    // governance eligibility check that already refuses every command outside `approved`;
    // this owner adds the two things nothing did: end the processes the run launched, and
    // record the observation once the sweep above has seen them end.
    const { composeCancellation } = await import("./domain/team-cancellation.js");
    deps.teamControl!.cancellation = composeCancellation({ db, governance: teamGovernance });
  }

  // OPR.0.4.3.21 — daemon event-loop health instrumentation. Constructed once
  // per daemon and wired into deps so `/healthz` can surface wedge evidence
  // (loop lag / last-tick age) and the expensive topology routes are timed.
  const { EventLoopMonitor } = await import("./domain/event-loop-monitor.js");
  const { RouteTimingRecorder } = await import("./domain/route-timing-recorder.js");
  const requestPhaseObserver = slowOpRecorder?.recordDiagnostic ? new RequestPhaseObserver(slowOpRecorder) : undefined;
  deps.requestPhaseObserver = requestPhaseObserver;
  const eventLoopMonitor = new EventLoopMonitor({ onTick: (at, previous) => requestPhaseObserver?.tick(at, previous) });
  const routeTimingRecorder = new RouteTimingRecorder();
  deps.eventLoopMonitor = eventLoopMonitor;
  deps.routeTimingRecorder = routeTimingRecorder;
  // S20 — bind provenance rides the health surface (absent = legacy healthz body).
  deps.bindPlan = opts?.bindPlan;

  // `ui.enabled` (default off): read once at start.
  deps.webUiEnabled = opts?.webUiEnabled ?? new ContextPackSettingsStore().resolveOne("ui.enabled").value === true;
  // /api browser boundary: this machine's exact Tailscale MagicDNS name, looked up on demand.
  deps.selfNameDiscovery = () => discoverTailscaleSelfNames({ timeoutMs: 1500 });
  const app = createApp(deps);

  return { app, db, deps, contextMonitor, eventLoopMonitor };
}
