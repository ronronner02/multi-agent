import { getStatePath } from "./data-paths.js";
import { requireLocalTarget } from "./middleware/local-target.js";
import { Hono } from "hono";
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { stampFields } from "./build-info.js";
import type { RigRepository } from "./domain/rig-repository.js";
import type { SessionRegistry } from "./domain/session-registry.js";
import type { DaemonLifecycleStore } from "./domain/daemon-lifecycle-store.js";
import type { EventBus } from "./domain/event-bus.js";
import { teamEventsRoutes } from "./routes/events.js";
import type { TranscriptStore } from "./domain/transcript-store.js";
import type { AgentActivityStore } from "./domain/agent-activity-store.js";
import { jsonBodyErrorHandler, trackJsonBodyParseErrors } from "./middleware/json-body-error.js";
import { getSelfHostId, getSelfHostIdSource } from "./domain/host-identity/fanout-contract.js";
import type { ChatRepository } from "./domain/chat-repository.js";
import { MailboxDelivery, createMailboxPromptStateReader, type ManagedNativeChannelEvidence, type NativeChannelStateReader } from "./domain/mailbox-delivery.js";
import { workspaceBrowseRoutes } from "./routes/workspace.js";
import { createSlowOpRequestMiddleware, type SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";
import { QueueRepository } from "./domain/queue-repository.js";
import type { InboxHandler } from "./domain/inbox-handler.js";
import type { OutboxHandler } from "./domain/outbox-handler.js";
import type { ProjectClassifier } from "./domain/project-classifier.js";
import type { ClassifierLeaseManager } from "./domain/classifier-lease-manager.js";
import type { ClassificationAttemptLedger } from "./domain/classification-attempts.js";
import type { ViewProjector } from "./domain/view-projector.js";
import type { WatchdogJobsRepository } from "./domain/watchdog-jobs-repository.js";
import type { WatchdogHistoryLog } from "./domain/watchdog-history-log.js";
import type { WorkflowRuntime } from "./domain/workflow-runtime.js";
import { createRouteTimingMiddleware } from "./domain/route-timing-recorder.js";
import { browserBoundary, type BrowserBoundaryOptions } from "./middleware/browser-boundary.js";
import { teamControlAuthentication, resolvePairedOwnerCookie } from "./middleware/auth-bearer-token.js";
import { transportSenderSession } from "./routes/require-sender-identity.js";
import { PlanGovernance, daemonModeOf } from "./domain/plan-governance.js";
import { TeamReadModel } from "./team-control-surface.js";
import { teamControlRoutes, type TeamControlOptions } from "./routes/team-control.js";
import { teamStartRoutes } from "./routes/team-start.js";
import { teamSetupRoutes } from "./routes/team-setup.js";
import { teamGithubRoutes } from "./routes/team-github.js";
import { teamSettingsRoutes } from "./routes/team-settings.js";
import { GithubCli } from "./domain/github-cli.js";
import { teamLeadRoutes } from "./routes/team-lead.js";
import { teamResultRoutes } from "./routes/team-result.js";
import { teamMergeRoutes } from "./routes/team-merge.js";
import { teamCompletionRoutes } from "./routes/team-completion.js";
import { teamTelemetryRoutes } from "./routes/team-telemetry.js";
import { AttemptTelemetry } from "./domain/attempt-telemetry.js";

import { OwnerSessions } from "./domain/owner-session.js";
import { ownerSessionRoutes } from "./routes/owner-session.js";
import { isIP } from "node:net";

/** KTD22: the only `/api` paths a managed-mode daemon serves. */
const MANAGED_ROUTE_PREFIXES = ["/api/team-control"] as const;

export interface AppDeps {
  teamControl?: TeamControlOptions;
  github?: GithubCli;
  /** Plan KTD10 — the dedicated agent account, signed in to its own gh config directory. */
  githubAgent?: GithubCli;
  /** Plan KTD13 — the pull-request delivery for GitHub projects, composed once both GitHub accounts exist. */
  pullRequestDelivery?: import("./domain/pull-request-delivery.js").PullRequestDelivery;
  ownerSessions?: OwnerSessions;
  /** The one governance owner, shared with the managed launch control when startup composes it. */
  teamGovernance?: PlanGovernance;
  attemptTelemetry?: AttemptTelemetry;
  /** KTD19 channel state from the launch control's own verified observations; absent means never adopted. */
  nativeChannelState?: NativeChannelStateReader;
  /** The single mailbox owner. Built by createApp when absent and published here for endpoint registration. */
  mailboxDelivery?: MailboxDelivery;
  /**
   * T053 — the persisted per-seat mailbox capability. When supplied, a send that names no
   * capability uses the seat's recorded value instead of minting a second one, which is what
   * keeps a managed seat's poll and its senders agreeing on one value. Absent in legacy
   * callers, where a send keeps minting as before.
   */
  readSeatMailboxCapability?: (runId: string, sessionId: string) => string | null;
  /** The managed launch chain injected into both fresh and both resume adapters (managed mode only). */
  managedLaunch?: {
    launcher: import("./adapters/worker-launch.js").WorkerLauncher;
    channel?: ManagedNativeChannelEvidence;
    /** Per-attempt mailbox endpoints; an unregistered attempt cannot launch. */
    endpoints: Map<string, Pick<import("./adapters/worker-mailbox-bridge.js").WorkerMailboxBridge, "binding" | "endpoint">>;
  };
  /** S20 — effective bind plan for the health surface (absent = legacy body). */
  bindPlan?: { mode: "explicit" | "default"; hosts: string[]; tailscaleDetected: boolean; ignoredRoutingHost?: string };
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  /** P7 — daemon lifecycle record store + this boot's epoch (heartbeat + clean-shutdown). */
  daemonLifecycleStore: DaemonLifecycleStore;
  daemonBootEpoch: string;
  eventBus: EventBus;
  /** Retained route dependencies are composed by startup; the old seat/terminal launch services are gone. */
  runtimeAdapters?: Record<string, import("./domain/runtime-adapter.js").RuntimeAdapter>;
  startupOrchestrator?: import("./domain/startup-orchestrator.js").StartupOrchestrator;
  transcriptStore?: TranscriptStore;
  chatRepo?: ChatRepository;
  slowOpRecorder?: SlowOperationInstrumentation;
  requestPhaseObserver?: import("./domain/request-phase-observer.js").RequestPhaseObserver;
  queueRepo?: QueueRepository;
  /** S02 — the standing stuck sweep's observable heartbeat (ADDITIVE on healthz;
   *  absent = legacy body). Set by the index.ts scheduler when the loop starts. */
  stuckSweepStatus?: import("./domain/queue-stuck-sweep.js").StuckSweepStatus;
  /** S01 — the wake-or-escalate ladder's heartbeat + open-escalations count (ADDITIVE on
   *  healthz; absent = legacy body). Part of the operator rung's stated delivery floor. */
  wakeLadderStatus?: import("./domain/queue-wake-ladder.js").WakeLadderStatus;
  inboxHandler?: InboxHandler;
  outboxHandler?: OutboxHandler;
  shadowCapture?: import("./domain/shadow-capture.js").ShadowCapture;
  shadowCaptureError?: string;
  projectClassifier?: ProjectClassifier;
  classifierLeaseManager?: ClassifierLeaseManager;
  /** 0.6.0 S02 P1: durable classification attempt ledger. */
  classificationAttemptLedger?: ClassificationAttemptLedger;
  viewProjector?: ViewProjector;
  watchdogJobsRepo?: WatchdogJobsRepository;
  watchdogHistoryLog?: WatchdogHistoryLog;
  workflowRuntime?: WorkflowRuntime;
  /**
   * MVP — the owner of "an attempt ended". A direct launch records a receipt and nothing closed
   * the attempt, so no task could be observed to finish. Startup composes it; index.ts starts
   * its sweep after the HTTP surface is ready. Absent (tests, legacy callers) leaves attempts
   * exactly as they were recorded.
   */
  attemptCompletion?: import("./domain/attempt-completion.js").AttemptCompletion;
  /**
   * U7 — the run's integration branch and the owner's merge. Startup composes it when a
   * managed run can be delivered; absent leaves the read and the merge unavailable rather
   * than answering as if nothing had landed.
   */
  integration?: import("./domain/integration-branch.js").Integration;
  /**
   * Absolute path to the daemon's bundled built-in workflow-specs
   * directory. Used by `GET /api/workflow/specs` to
   * compute the per-row `isBuiltIn` flag (source_path under this dir
   * → built-in; otherwise → operator-authored). Optional: when unset,
   * the route returns isBuiltIn=false for every spec (graceful — the
   * surface still works, just without the indicator).
   */
  /** User Settings v0 — daemon-side settings store (env > file > default). */
  settingsStore?: import("./domain/user-settings/settings-store.js").SettingsStore;
  /**
   * PL-005 Phase B: bearer token (or null for loopback-only mode).
   * Retained routes accept the daemon bearer token alongside their scoped credentials.
   */
  legacyBearerToken?: string | null;
  /** `ui.enabled`: serve the web UI pages; /api routes are unaffected. */
  webUiEnabled?: boolean;
  /** This machine's own extra names for the /api browser boundary (createDaemon wires the
   *  Tailscale MagicDNS self-name lookup). Absent: loopback, IP literals and OS names only. */
  selfNameDiscovery?: () => Promise<string[]>;
  /** Test hook: one call per /api browser-boundary decision. */
  browserBoundaryObserver?: BrowserBoundaryOptions["onDecision"];
  contextUsageStore?: import("./domain/context-usage-store.js").ContextUsageStore;
  contextMonitor?: { pollOnce(): Promise<void> };
  /**
   * GHOST-STAGE (e/Class-B) — the canonical OccupantInvalidator, constructed once in startup and
   * injected so SeatHandoverService.commit()'s re-key call actually FIRES (dev-driver's fold added
   * the optional call but no concrete impl was wired — the invalidation was dead until this).
   */
  occupantInvalidator?: import("./domain/occupant-invalidator.js").OccupantInvalidator;
  agentActivityStore?: AgentActivityStore;
  uiDistDir?: string | null;
  /**
   * OPR.0.4.3.21 — daemon event-loop health monitor. Optional: when absent
   * (e.g. direct-construction test harnesses) `/healthz` keeps its exact
   * `{ status: "ok" }` body. Constructed once per daemon in startup.ts and
   * surfaced on the enriched `/healthz` payload as the wedge-detection
   * evidence (loop lag / last-tick age / utilization / healthy verdict).
   */
  eventLoopMonitor?: import("./domain/event-loop-monitor.js").EventLoopMonitor;
  /**
   * OPR.0.4.3.21 — request-duration recorder for the expensive topology
   * routes. Optional (same rationale). When present, one timing middleware is
   * registered and the rolling last/max per route is surfaced on `/healthz`.
   */
  routeTimingRecorder?: import("./domain/route-timing-recorder.js").RouteTimingRecorder;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveDefaultUiDistDir(): string {
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}

export const WEB_UI_OFF_MESSAGE =
  "The Multi-Agent web UI is off. To turn it on, run `multi-agent config set ui.enabled true`, then stop and start the daemon (`multi-agent daemon stop`, `multi-agent daemon start`).\n";

function safeResolveUiPath(uiDistDir: string, requestPath: string): string | null {
  const relativePath = requestPath.replace(/^\/+/, "") || "index.html";
  const resolvedPath = nodePath.resolve(uiDistDir, relativePath);
  const normalizedRoot = uiDistDir.endsWith(nodePath.sep) ? uiDistDir : `${uiDistDir}${nodePath.sep}`;
  if (resolvedPath !== uiDistDir && !resolvedPath.startsWith(normalizedRoot)) {
    return null;
  }
  return resolvedPath;
}

function fileResponse(filePath: string, rangeHeader?: string): Response {
  const ext = nodePath.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const body = fs.readFileSync(filePath);
  const headers: Record<string, string> = { "content-type": contentType };
  // Browsers need a seekable response to skip the skin's entrance on later playback.
  if (ext === ".mp4") {
    const size = body.length;
    headers["accept-ranges"] = "bytes";
    headers["content-length"] = String(size);
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      const start = match && match[1] !== "" ? Number(match[1])
        : match && match[2] !== "" ? Math.max(0, size - Number(match[2])) : NaN;
      const end = match && match[1] !== "" && match[2] !== "" ? Number(match[2]) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        return new Response(null, { status: 416,
          headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" } });
      }
      const boundedEnd = Math.min(end, size - 1);
      headers["content-range"] = `bytes ${start}-${boundedEnd}/${size}`;
      headers["content-length"] = String(boundedEnd - start + 1);
      return new Response(new Uint8Array(body.subarray(start, boundedEnd + 1)), { status: 206, headers });
    }
  }
  return new Response(body, { headers });
}

function isUiAssetRequestPath(requestPath: string): boolean {
  const relativePath = requestPath.replace(/^\/+/, "");
  return relativePath.startsWith("assets/")
    || relativePath === "skins/shuimo-danqing/shuimo-danqing-loop.mp4"
    || relativePath === "skins/shuimo-danqing/shuimo-danqing-still.webp"
    || relativePath === "favicon.ico"
    || relativePath === "robots.txt"
    || relativePath === "manifest.webmanifest";
}

/**
 * KTD22 keeps legacy pages out of managed mode, but the managed team view ships in the same
 * bundle. Only what that view needs is reachable: its own route and the bundle's assets.
 * Every other page, `/` and `/index.html` included, keeps the managed-mode refusal.
 */
function isManagedUiRequestPath(requestPath: string): boolean {
  return requestPath === "/team" || requestPath.startsWith("/team/") || isUiAssetRequestPath(requestPath);
}

export function createApp(deps: AppDeps): Hono {
  // Hard runtime invariant: all domain services must share the same db handle.
  if (deps.rigRepo.db !== deps.eventBus.db) {
    throw new Error("createApp: rigRepo and eventBus must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.sessionRegistry.db) {
    throw new Error("createApp: rigRepo and sessionRegistry must share the same db handle");
  }

  const pairedOwners = daemonModeOf(deps.rigRepo.db) === "managed";
  const teamOptions: TeamControlOptions = deps.teamControl ?? { credentials: { ownerToken: null } };
  if (pairedOwners && deps.bindPlan?.hosts.some(host => !(host === "localhost" || host === "::1"
    || (isIP(host) === 4 && host.startsWith("127."))))) {
    throw new Error("Managed owner surfaces require a loopback-only listener.");
  }
  const ownerSessions = pairedOwners ? deps.ownerSessions ?? new OwnerSessions(deps.rigRepo.db) : undefined;
  if (ownerSessions && ownerSessions.db !== deps.rigRepo.db) throw new Error("Owner sessions must use the control database.");
  deps.ownerSessions = ownerSessions;
  const github = deps.github ?? new GithubCli();
  const githubAgent = deps.githubAgent ?? new GithubCli({ env: { ...process.env, GH_CONFIG_DIR: getStatePath("github-agent") } });
  deps.githubAgent = githubAgent;
  deps.github = github;
  // U9 (R18): the owner's proxy setting is read at each gh/git spawn, so a change applies to the next
  // upload without a restart; an empty setting falls back to the daemon environment.
  const settingsStore = deps.settingsStore;
  if (settingsStore) for (const cli of [github, githubAgent]) cli.setProxySource(() => {
    const value = settingsStore.resolveOne("github.proxy").value;
    return typeof value === "string" ? value : undefined;
  });
  const app = new Hono();
  if (ownerSessions) app.use("/api/*", async (c, next) => { c.set("ownerSessions" as never, ownerSessions); await next(); });
  if (deps.requestPhaseObserver) app.use("*", deps.requestPhaseObserver.middleware());
  // A malformed request body is a 400, not the default 500.
  app.use("*", trackJsonBodyParseErrors);
  app.onError(jsonBodyErrorHandler);
  // Inject dependencies into context for all routes
  // One mailbox owner per daemon, admitted only by the daemon's own seat evidence (KTD11).
  if (deps.mailboxDelivery && deps.nativeChannelState) throw new Error("A supplied mailbox owner already fixes its channel reader");
  // A managed daemon resolves the seat's recorded capability; a legacy one reads none, so a
  // send keeps its existing mint-on-omit behaviour byte for byte.
  const managedSeatCapability = deps.readSeatMailboxCapability;
  const mailboxDelivery = deps.mailboxDelivery ?? (deps.chatRepo
    ? new MailboxDelivery(deps.chatRepo, createMailboxPromptStateReader({
        db: deps.rigRepo.db,
        agentActivityStore: deps.agentActivityStore,
        observedSince: new Date().toISOString(),
      }), deps.nativeChannelState, managedSeatCapability)
    : undefined);
  deps.mailboxDelivery = mailboxDelivery;
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, deps.rigRepo);
    c.set("sessionRegistry" as never, deps.sessionRegistry);
    c.set("eventBus" as never, deps.eventBus);
    c.set("runtimeAdapters" as never, deps.runtimeAdapters ?? {});
    c.set("transcriptStore" as never, deps.transcriptStore);
    c.set("chatRepo" as never, deps.chatRepo);
    c.set("mailboxDelivery" as never, mailboxDelivery);
    c.set("queueRepo" as never, deps.queueRepo);
    c.set("inboxHandler" as never, deps.inboxHandler);
    c.set("outboxHandler" as never, deps.outboxHandler);
    c.set("shadowCapture" as never, deps.shadowCapture);
    c.set("shadowCaptureError" as never, deps.shadowCaptureError);
    c.set("projectClassifier" as never, deps.projectClassifier);
    c.set("classifierLeaseManager" as never, deps.classifierLeaseManager);
    c.set("classificationAttemptLedger" as never, deps.classificationAttemptLedger);
    c.set("viewProjector" as never, deps.viewProjector);
    c.set("watchdogJobsRepo" as never, deps.watchdogJobsRepo);
    c.set("watchdogHistoryLog" as never, deps.watchdogHistoryLog);
    c.set("workflowRuntime" as never, deps.workflowRuntime);
    c.set("settingsStore" as never, deps.settingsStore);
    c.set("contextUsageStore" as never, deps.contextUsageStore);
    c.set("contextMonitor" as never, deps.contextMonitor);
    c.set("occupantInvalidator" as never, deps.occupantInvalidator);
    c.set("agentActivityStore" as never, deps.agentActivityStore);
    c.set("db" as never, deps.rigRepo.db);
    await next();
  });

  // OPR.0.4.3.21 — ONE request-duration middleware for the expensive topology
  // routes (rigs summary/graph, nodes, ps). Registered only when a recorder is
  // wired (production); the internal expensiveRouteLabel gate makes it a no-op
  // for every other path, so cheap routes pay nothing.
  if (deps.routeTimingRecorder) {
    app.use("*", createRouteTimingMiddleware(deps.routeTimingRecorder));
  }

  // The request-timing observer, wired via the exported seam (createSlowOpRequestMiddleware) so the
  // middleware contract is unit-tested hermetically and this line is the pinned enable path. Registered
  // only when a recorder is wired (production); measurement-only + isolated (a throw never becomes a 500).
  if (deps.slowOpRecorder?.recordRequest) {
    app.use("*", createSlowOpRequestMiddleware(deps.slowOpRecorder));
  }

  // Browser boundary: target name and browser Origin, checked once per /api request
  // (WebSocket upgrades included), before the remote read-through and every route.
  app.use("/api/*", browserBoundary({
    webUiEnabled: deps.webUiEnabled === true,
    pairedOwnerBoundary: pairedOwners,
    authenticateOwnerCookie: c => {
      const resolved = resolvePairedOwnerCookie(c, teamOptions.credentials, [deps.legacyBearerToken]);
      return resolved.ok ? null : c.json({ code: resolved.code, error: resolved.error }, resolved.status);
    },
    bearerTokens: [deps.legacyBearerToken],
    allowedOrigins: process.env.MULTI_AGENT_ALLOWED_ORIGINS,
    allowedHosts: process.env.MULTI_AGENT_ALLOWED_HOSTS,
    discoverSelfNames: deps.selfNameDiscovery,
    onDecision: deps.browserBoundaryObserver,
  }));

  const managedMailboxAuthentication = teamControlAuthentication(
    () => teamOptions.credentials,
    [deps.legacyBearerToken],
  );

  // KTD22: in managed mode this is the only route gate. Each managed route a later unit adds
  // joins this allowlist with its own authenticated managed-control check.
  app.use("/api/*", async (c, next) => {
    if (daemonModeOf(deps.rigRepo.db) === "managed"
      && !MANAGED_ROUTE_PREFIXES.some(prefix => c.req.path === prefix || c.req.path.startsWith(prefix + "/"))
    ) {
      const poll = c.req.method === "GET" && /^\/api\/rigs\/[^/]+\/chat\/mailbox(?:\/poll)?$/.test(c.req.path);
      const consume = c.req.method === "POST" && /^\/api\/rigs\/[^/]+\/chat\/mailbox\/[^/]+\/consume$/.test(c.req.path);
      const body: unknown = consume ? await c.req.json().catch(() => null) : null;
      const capability = poll ? c.req.query("capability") ?? c.req.header("x-multi-agent-mailbox-capability")
        : body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).capability : null;
      const requestedRunId = poll ? c.req.query("runId")
        : body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).runId === "string"
          ? (body as Record<string, unknown>).runId as string
          : null;
      // The route owner still verifies the recipient/task/run capability and daemon-observed prompt state.
      // Sending and all legacy chat paths remain outside this managed allowlist.
      if ((!poll && !consume) || !transportSenderSession(c) || typeof capability !== "string" || !/^mailbox:[A-Za-z0-9_-]{43}$/.test(capability)) {
        return c.json({ code: "managed_control_required", error: "Legacy interfaces are inactive in a managed-mode daemon." }, 403);
      }
      let denied: Response | undefined;
      const authenticated = await managedMailboxAuthentication(c as never, async () => {
        const actor = c.get("controlActor" as never) as { kind: "owner" | "worker"; sessionId: string };
        const controlRunId = c.get("controlRunId" as never) as string | null;
        const session = transportSenderSession(c);
        if (actor.kind !== "worker" || !session || actor.sessionId !== session || controlRunId !== requestedRunId) {
          denied = c.json({ code: "managed_control_required", error: "An authenticated worker bound to this mailbox run is required." }, 403);
          return;
        }
        await next();
      });
      return denied ?? authenticated;
    }
    await next();
  });
  const teamGovernance = deps.teamGovernance ?? new PlanGovernance(deps.rigRepo.db, deps.eventBus,
    deps.queueRepo ?? new QueueRepository(deps.rigRepo.db, deps.eventBus), undefined, teamOptions.readPolicyCapability);
  // T052 — the managed owner read projections. Composed here from the owners the
  // daemon already holds: governance for run/task/attempt authority, the queue
  // for each task's destination seat, and the event bus for the committed
  // review and exit evidence.
  //
  // The composed options are a prototype-linked view of the caller's object
  // rather than a spread copy: a host that supplies `teamControl` owns a live
  // object (tests and embedders replace `resolveBinding` or `readSystemHealth`
  // after construction), and a snapshot would freeze the old callbacks. The
  // view only ever adds `readModel`, so every caller-supplied value still wins.
  let teamOptionsWithRead: TeamControlOptions = teamOptions;
  if (!teamOptions.readModel) {
    const composed = new TeamReadModel({
      db: deps.rigRepo.db,
      governance: teamGovernance,
      events: deps.eventBus,
      // The queue owns the task's seat; the read model joins through its rows
      // rather than re-deriving an assignment from the queue item body.
      readTaskRows: (runId: string) => (deps.rigRepo.db.prepare(
        `SELECT a.qitem_id AS qitemId, a.task_id AS taskId,
          json_extract(a.assignment_json, '$.role') AS role,
          q.state AS queueState, q.destination_session AS session
          FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
          WHERE a.run_id = ? ORDER BY a.task_id`).all(runId) as Array<{
            qitemId: string; taskId: string; role: string; queueState: string; session: string | null }>),
    });
    teamOptionsWithRead = Object.create(teamOptions, {
      readModel: { value: composed, enumerable: true, writable: true, configurable: true },
    }) as TeamControlOptions;
  }

  app.use("/api/team-control/*", requireLocalTarget);
  if (ownerSessions) app.route("/api/team-control/owner-session", ownerSessionRoutes(ownerSessions, () => teamOptions.credentials,
    [deps.legacyBearerToken]));
  app.route("/api/team-control", teamControlRoutes(teamGovernance, teamOptionsWithRead,
    [deps.legacyBearerToken]));
  // T052 — the managed replay transport. Mounted separately from the legacy
  // `/api/events` stream so legacy admission and behaviour stay exactly as they
  // were while managed reads get owner authentication and run scoping.
  app.route("/api/team-control", workspaceBrowseRoutes(teamGovernance, {
    credentials: teamOptions.credentials, legacyTokens: [deps.legacyBearerToken],
    ...(deps.workflowRuntime ? { runtime: deps.workflowRuntime } : {}),
    orchestratorRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
  }));
  // MVP slice 3 — the finished task's patch, served to the owner so `multi-agent team apply` and the
  // Web UI can hand the result back. Absent a runtime there are no candidate trees to read.
  app.route("/api/team-control", teamResultRoutes(teamGovernance, {
    credentials: teamOptions.credentials, legacyTokens: [deps.legacyBearerToken],
    ...(deps.workflowRuntime ? { runtime: deps.workflowRuntime } : {}),
  }));
  // MVP — the owner's completion read: the attempt the daemon observed stop, and the evidence it
  // could verify about the candidate. The owner action forwards both to `tasks/outcome`, so the
  // write contract is the one C2 already owns.
  app.route("/api/team-control", teamCompletionRoutes(teamGovernance, {
    credentials: teamOptions.credentials, legacyTokens: [deps.legacyBearerToken],
    ...(deps.workflowRuntime ? { runtime: deps.workflowRuntime,
      readLeadProposal: (runId: string, taskId: string) => deps.workflowRuntime!.leadProposalFor(runId, taskId),
      // U6 — a delivery lead's turn may ask the owner for a decision instead of proposing work.
      readLeadEscalation: (runId: string, taskId: string) => {
        const escalation = deps.workflowRuntime!.leadEscalationFor(runId, taskId);
        return escalation === null ? null : { optionCount: escalation.options.length };
      } } : {}),
  }));
  app.route("/api/team-control", teamTelemetryRoutes(teamGovernance,
    deps.attemptTelemetry ?? new AttemptTelemetry(deps.rigRepo.db), {
      credentials: teamOptions.credentials, legacyTokens: [deps.legacyBearerToken],
    }));
  app.route("/api/team-control", teamEventsRoutes({
    credentials: teamOptions.credentials,
    legacyTokens: [deps.legacyBearerToken],
    ...(teamOptionsWithRead.readModel ? { readModel: teamOptionsWithRead.readModel } : {}),
  }));
  // U3 — the owner's teams: the rig and seats a repository's team runs on. Same surface and the
  // same owner credential as the start below, because a team is what a start routes work to.
  app.route("/api/team-control", teamGithubRoutes(github, githubAgent, teamOptions.credentials,
    [deps.legacyBearerToken]));
  app.route("/api/team-control", teamSettingsRoutes(deps.settingsStore, teamOptions.credentials,
    [deps.legacyBearerToken]));
  app.route("/api/team-control", teamSetupRoutes(deps.rigRepo, { credentials: teamOptions.credentials, github,
    ...(deps.settingsStore ? { settingsStore: deps.settingsStore } : {}) },
    [deps.legacyBearerToken]));
  // MVP slice 2 — the owner's run collection: list the runs, and start one from a goal.
  app.route("/api/team-control", teamStartRoutes(teamGovernance, deps.rigRepo, {
    credentials: teamOptions.credentials,
    ...(deps.settingsStore ? { settingsStore: deps.settingsStore } : {}),
    ...(teamOptions.readPolicyCapability ? { readPolicyCapability: teamOptions.readPolicyCapability } : {}),
    ...(teamOptions.dispatch ? { dispatch: teamOptions.dispatch } : {}),
    ...(teamOptions.planWorktreeRoot ? { planWorktreeRoot: teamOptions.planWorktreeRoot } : {}),
  }, [deps.legacyBearerToken]));
  // MVP slice C3 — the owner's read of a lead's decomposition and the decision it becomes. The
  // read is the daemon's own reading of the file the lead wrote; the write records an owner
  // decision, never an admission.
  app.route("/api/team-control", teamLeadRoutes(teamGovernance, {
    ...(deps.settingsStore ? { settingsStore: deps.settingsStore } : {}),
    ...(deps.attemptTelemetry ? { telemetry: deps.attemptTelemetry } : {}),
    credentials: teamOptions.credentials, legacyTokens: [deps.legacyBearerToken],
    ...(teamOptions.readPolicyCapability ? { readPolicyCapability: teamOptions.readPolicyCapability } : {}),
    // U5 — the chat and plan routes start the lead's next turn through the same dispatch a
    // start and a growth use, so a chat message and a plan approval launch exactly as they do.
    ...(teamOptions.dispatch ? { dispatch: teamOptions.dispatch } : {}),
    ...(deps.workflowRuntime ? { runtime: deps.workflowRuntime } : {}),
  }));
  // U7 — the run's integration branch: what landed on it, and the owner's one merge.
  app.route("/api/team-control", teamMergeRoutes({
    credentials: teamOptions.credentials,
    legacyTokens: [deps.legacyBearerToken],
    ...(deps.integration ? { integration: deps.integration } : {}),
    delivery: () => deps.pullRequestDelivery,
  }));

  app.get("/healthz", (c) => {
    // OPR.0.4.3.21 — enrich the health surface with event-loop wedge evidence
    // when the monitor is wired. Absent monitor keeps the exact legacy body so
    // existing probes / tests that assert `{ status: "ok" }` are unchanged.
    // OPR.0.4.4.11 FR-7 — a STAMPED build additionally carries
    // {semver, commit, dirty, builtAt}; dev runs add NOTHING (stampFields is
    // {} without a stamp — no invented identity, legacy bodies preserved).
    const stamp = stampFields();
    // 51-09 increment 3 (arch ruling 2e1b737f; local always-suffix rendering since
    // superseded by the 2026-08-27 root invariant) — expose the daemon's boot-reconciled
    // self-host id so the CLI edge can detect cross-host targets, self-resolve a
    // self-suffixed reply hint, and construct the origin triple at the FORWARDING
    // boundary (ONE identity source). ADDITIVE
    // on the FR-7 stamp precedent: ABSENT before the boot reconcile (getSelfHostId
    // is null → {} → no invented identity, legacy bodies byte-preserved). NEVER
    // ownName/host.name (display-only, DP4 — the conflation this slice kills).
    const self = getSelfHostId();
    // Slice 14 §2c — legibility BEFORE the cross-machine failure. A host running a generated id is
    // in a materially different state from one running its registered name (remote callers cannot
    // resolve it), and until now nothing said which state you were in until a message failed.
    const selfHost = self
      ? {
          selfHostId: self,
          selfHostIdSource: getSelfHostIdSource(),
        }
      : {};
    const monitor = deps.eventLoopMonitor;
    const slowOperations = deps.slowOpRecorder?.snapshot
      ? { slowOperations: deps.slowOpRecorder.snapshot() }
      : {};
    // S20 — bind provenance on the health surface (ADDITIVE; absent = legacy body):
    // adoption gates derive the REQUIRED listener set from this and then prove each
    // host by probing it — binding evidence, never config echo.
    const bind = deps.bindPlan ? { bind: deps.bindPlan } : {};
    // S02 — quiet is cheap but observable: the standing stuck sweep's heartbeat rides
    // healthz (ADDITIVE; absent = legacy body), so a clean sweep needs no row and a
    // failing sweep is loud without one.
    const stuckSweep = deps.stuckSweepStatus ? { stuckSweep: deps.stuckSweepStatus.snapshot() } : {};
    // S01 — the wake ladder's heartbeat is half of the operator rung's honest delivery
    // floor (escalation view + daemon-health); same additive contract.
    const wakeLadder = deps.wakeLadderStatus ? { wakeLadder: deps.wakeLadderStatus.snapshot() } : {};
    // U5 — running attempt count for the Electron desktop close confirmation.
    // Query is cheap: the running-state index on team_attempts is a narrow lookup.
    let runningAttempts: number | undefined;
    try {
      const row = deps.rigRepo.db.prepare("SELECT count(*) AS count FROM team_attempts WHERE state = 'running'").get() as { count: number } | undefined;
      runningAttempts = row ? row.count : 0;
    } catch { runningAttempts = undefined; }
    if (!monitor) {
      return c.json({ status: "ok", pid: process.pid, ...stamp, ...selfHost, ...slowOperations, ...bind, ...stuckSweep, ...wakeLadder, ...(runningAttempts !== undefined ? { runningAttempts } : {}) });
    }
    const eventLoop = monitor.snapshot();
    return c.json({
      status: "ok",
      pid: process.pid,
      ...stamp,
      ...selfHost,
      eventLoop,
      routeTimings: deps.routeTimingRecorder?.snapshot() ?? {},
      ...slowOperations,
      ...bind,
      ...stuckSweep,
      ...wakeLadder,
    });
  });

  app.all("/api/*", async (c, next) => {
    if (c.req.path === "/api") return next();
    return c.json({ error: "not_found", path: c.req.path }, 404);
  });

  const uiDistDir = deps.uiDistDir ?? resolveDefaultUiDistDir();
  const uiIndexPath = nodePath.join(uiDistDir, "index.html");
  const hasUiBundle = !!uiDistDir && fs.existsSync(uiIndexPath);

  app.get("*", (c) => {
    const requestPath = c.req.path;

    if (requestPath === "/healthz" || requestPath.startsWith("/api/")) {
      return c.notFound();
    }

    if (daemonModeOf(deps.rigRepo.db) === "managed" && !isManagedUiRequestPath(requestPath)) {
      c.header("X-Multi-Agent-Web-UI", "off");
      return c.text("Legacy pages are inactive in a managed-mode daemon.", 404);
    }

    if (deps.webUiEnabled !== true) {
      c.header("X-Multi-Agent-Web-UI", "off");
      return c.text(WEB_UI_OFF_MESSAGE, 404);
    }

    if (!hasUiBundle) {
      return c.notFound();
    }

    const requestedFile = safeResolveUiPath(uiDistDir, requestPath);
    if (requestedFile && fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
      return fileResponse(requestedFile, c.req.header("Range"));
    }

    if (isUiAssetRequestPath(requestPath)) {
      return c.notFound();
    }

    const indexHtml = fs.readFileSync(uiIndexPath, "utf-8");
    return c.html(indexHtml);
  });

  return app;
}
