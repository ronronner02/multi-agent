import { serve, type ServerType } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeHttpServer, createDaemonShutdown, DAEMON_SHUTDOWN_RECEIPT, trackHttpServerResponses } from "./daemon-shutdown.js";
import { readOpenRigEnv, OPENRIG_HOME } from "./openrig-compat.js";
import { resolveDaemonDbPath } from "./daemon-db-path.js";
import { createDaemon } from "./startup.js";
import { resolveClientDependencies } from "./domain/executable-resolver.js";
import { endRunningWorkerTrees } from "./domain/process-termination.js";
import { resolveBindPlan } from "./domain/bind-plan.js";
import { isManagedMode } from "./domain/plan-governance.js";
import type { TeamControlCredentials } from "./middleware/auth-bearer-token.js";
import { runQueueRetentionSweep, RETENTION_DEFAULTS } from "./domain/queue-retention.js";
import {
  createStuckSweepStatus,
  resolveStuckSweepIntervalSeconds,
  runStuckSweep,
} from "./domain/queue-stuck-sweep.js";
import {
  createWakeLadderStatus,
  makePromptStateReader,
  resolveWakeRetryIntervalSeconds,
  runWakeLadderTick,
  WakeLadderScheduler,
} from "./domain/queue-wake-ladder.js";
import {
  assertBindAuthInvariant,
  detectTailscaleInterface,
} from "./middleware/auth-bearer-token.js";
import type { SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";
import type { ProviderService } from "./domain/provider/provider-service.js";
import { SettingsStore } from "./domain/user-settings/settings-store.js";
import {
  ensureOpenRigInstance,
  formatInstanceInitializationConflicts,
} from "./domain/instance-initialization.js";

/** OPR.0.4.3.21 (51elv2) — bound the graceful-shutdown recorder drain. */
export const SLOW_OP_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
/** P7 — lifecycle heartbeat cadence; last-seen granularity = this interval. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * OPR.0.4.3.21 (51elv2) — drain + close the slow-operation recorder on graceful
 * shutdown and report the process exit code. Returns 0 when the recorder closes
 * cleanly (or is absent), 1 when the drain rejects, times out, or the recorder
 * is in a terminal-failure state — an unproven/lost drain must never look like a
 * clean exit. Bounded by ONE finite timer that stays REFERENCED until the drain
 * settles or times out — it is the only handle that can enforce the bound once
 * the servers and recorder Worker are unreferenced — and is cleared after
 * settlement; adds no retry, queue repair, migration, or supervisor machinery.
 */
export async function drainSlowOpRecorderOnShutdown(
  recorder: Pick<SlowOperationInstrumentation, "flush" | "close"> | undefined,
  opts?: { timeoutMs?: number; log?: (message: string, error?: unknown) => void },
): Promise<number> {
  const drain = recorder?.close ?? recorder?.flush;
  if (!recorder || !drain) return 0;
  const log = opts?.log ?? ((message: string, error?: unknown) => console.error(message, error));
  const timeoutMs = opts?.timeoutMs ?? SLOW_OP_SHUTDOWN_DRAIN_TIMEOUT_MS;

  let drainError: unknown;
  // Track rejection independently of its value: a Promise may reject with a
  // falsey value (undefined / null / false / 0 / ""), which is still a failure.
  let rejected = false;
  let settled = false;
  const drainPromise = Promise.resolve()
    .then(() => drain.call(recorder))
    .then(
      () => { settled = true; },
      (error) => { drainError = error; rejected = true; settled = true; },
    );

  // This finite timer is the ONLY thing keeping shutdown alive long enough to
  // enforce the bound once the servers + recorder Worker are unreferenced, so
  // it must stay referenced (do NOT unref it); it is cleared after settlement.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  await Promise.race([drainPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (!settled) {
    log("[slow-operation] shutdown drain timed out; instrumentation records may be lost");
    return 1;
  }
  if (rejected) {
    log("[slow-operation] shutdown drain failed; instrumentation records may be lost", drainError);
    return 1;
  }
  return 0;
}

/** OPR.0.4.6.FS-1 W2 — start the queue-retention maintenance sweep (arch D3): a
 *  boot sweep + a daily tick that archives aged terminal `queue_transitions`
 *  (never-delete) and prunes `watchdog_history`, both in bounded batches with
 *  event-loop yields. Reads the `retention.*` settings (baked defaults via
 *  RETENTION_DEFAULTS). Fire-and-forget with error logging — a sweep failure must
 *  never crash the daemon. Returns the daily interval handle (cleared on
 *  shutdown), or null when disabled. */
export function startQueueRetentionScheduler(deps: {
  rigRepo: { db: import("better-sqlite3").Database };
  settingsStore?: { resolveOne(key: string): { value: unknown } };
}): ReturnType<typeof setInterval> | null {
  const store = deps.settingsStore;
  const enabled = store ? store.resolveOne("retention.enabled").value === true : true;
  if (!enabled) return null;
  const db = deps.rigRepo.db;
  const num = (key: string, fallback: number): number => {
    const v = store ? store.resolveOne(key).value : fallback;
    return typeof v === "number" ? v : fallback;
  };
  const runOnce = (): void => {
    void runQueueRetentionSweep(db, {
      nowIso: new Date().toISOString(),
      transitionsRetentionDays: num("retention.transitions_days", RETENTION_DEFAULTS.transitionsRetentionDays),
      watchdogRetentionDays: num("retention.watchdog_days", RETENTION_DEFAULTS.watchdogRetentionDays),
      watchdogKeepPerJob: num("retention.watchdog_keep_per_job", RETENTION_DEFAULTS.watchdogKeepPerJob),
      usageSamplesRetentionDays: num("retention.usage_samples_days", RETENTION_DEFAULTS.usageSamplesRetentionDays),
      batchSize: num("retention.batch_size", RETENTION_DEFAULTS.batchSize),
    }).catch((err: unknown) => {
      console.error(`[queue-retention] sweep error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  runOnce(); // boot sweep (fire-and-forget)
  const DAILY_MS = 24 * 60 * 60 * 1000;
  return setInterval(runOnce, DAILY_MS);
}

/** S02 (OPR.0.5.5.2) — start the STANDING STUCK SWEEP: both halves of "is anything
 *  silently stuck" (claimed-never-closed; sender-believed-delivered-never-woken) plus the
 *  unclaimed-obligation net and the dangling-closure custody class, on the config-keyed
 *  cadence (`queue.stuck_sweep_interval_seconds`). Findings route as durable rows to the
 *  owning seats; a clean sweep records only the healthz heartbeat; a failing sweep is loud
 *  on that surface and the log, never a silent skip. Boot sweep + interval, retention
 *  pattern. Returns the interval handle (cleared on shutdown), or null when the queue
 *  repository is absent (direct-construction harnesses). */
export function startStuckSweepScheduler(deps: {
  rigRepo: { db: import("better-sqlite3").Database };
  queueRepo?: import("./domain/queue-repository.js").QueueRepository;
  stuckSweepStatus?: import("./domain/queue-stuck-sweep.js").StuckSweepStatus;
}): ReturnType<typeof setInterval> | null {
  const queueRepo = deps.queueRepo;
  if (!queueRepo) return null;
  const status = createStuckSweepStatus();
  deps.stuckSweepStatus = status; // healthz reads this snapshot
  const db = deps.rigRepo.db;
  const runOnce = (): void => {
    // runStuckSweep never throws (failure is recorded loudly on the status surface);
    // the catch is the never-crash-the-daemon belt for the promise chain itself.
    void runStuckSweep({ db, queueRepo, status }).catch((err: unknown) => {
      console.error(`[stuck-sweep] scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  runOnce(); // boot sweep (fire-and-forget)
  return setInterval(runOnce, resolveStuckSweepIntervalSeconds() * 1000);
}

/** S01 (OPR.0.5.5.1) — start the WAKE-OR-ESCALATE ladder: batons whose wake failed retry
 *  on the config-keyed cadence up to the cap, then escalate through recorded rungs
 *  (destination's orchestrator — aggregated per destination — then the operator surface).
 *  Ladder state derives entirely from the row's transitions, so a daemon restart resumes
 *  every ladder at its exact position with no recovery step. Returns the scheduler
 *  (stopped on shutdown), or null when the queue repository is absent. */
export function startWakeLadderScheduler(deps: {
  rigRepo: { db: import("better-sqlite3").Database };
  queueRepo?: import("./domain/queue-repository.js").QueueRepository;
  wakeLadderStatus?: import("./domain/queue-wake-ladder.js").WakeLadderStatus;
  providerService?: Pick<ProviderService, "getReadModel">;
  usageLimitJitterSeconds?: number;
  agentActivityStore?: Pick<import("./domain/agent-activity-store.js").AgentActivityStore, "getLatestForNode">;
}): WakeLadderScheduler | null {
  const queueRepo = deps.queueRepo;
  if (!queueRepo) return null;
  const status = createWakeLadderStatus();
  deps.wakeLadderStatus = status; // healthz reads this snapshot
  const db = deps.rigRepo.db;
  const scheduler = new WakeLadderScheduler({
    runTick: () => runWakeLadderTick({
      db,
      queueRepo,
      status,
      readPromptState: makePromptStateReader({
        db,
        getSeatState: () => null,
        getLatestHook: (sessionName) => deps.agentActivityStore?.getLatestForNode({ sessionName }),
      }),
      ...(deps.providerService
        ? { getProviderReadModel: () => deps.providerService!.getReadModel() }
        : {}),
      ...(deps.usageLimitJitterSeconds !== undefined
        ? { usageLimitJitterSeconds: deps.usageLimitJitterSeconds }
        : {}),
    }),
    tickIntervalMs: resolveWakeRetryIntervalSeconds() * 1000,
  });
  scheduler.start();
  return scheduler;
}

export async function startServer(port?: number) {
  // Consume control credentials before bootstrap or discovery can spawn a child.
  const ownerToken = process.env.MULTI_AGENT_OWNER_TOKEN?.trim() || null;
  delete process.env.MULTI_AGENT_OWNER_TOKEN;
  // KTD22: the owner chooses the mode at start; switching requires a restart.
  const requestedMode = process.env.MULTI_AGENT_MODE?.trim() || "legacy";
  if (requestedMode !== "legacy" && requestedMode !== "managed") {
    throw new Error(`MULTI_AGENT_MODE must be "legacy" or "managed", got "${requestedMode}"`);
  }
  // U6 — a managed daemon hosted by the desktop (Electron's utility process, which has a
  // parent port) starts with no configured owner token. Pairing still needs a stable owner
  // identity inside this process, so mint one in memory. It never leaves the daemon: the
  // desktop mints a one-time code over the private parent channel instead, and nothing here
  // persists, logs, or hands this value to Electron. A daemon with no parent port has no
  // channel to mint a code on, so it gets no invented token.
  const hostedByDesktop = (process as { parentPort?: unknown }).parentPort !== undefined;
  const resolvedOwnerToken = ownerToken
    ?? (requestedMode === "managed" && hostedByDesktop ? randomBytes(32).toString("base64url") : null);
  const p = port ?? parseInt(readOpenRigEnv("OPENRIG_PORT", "RIGGED_PORT") ?? "7433", 10);
  // D15 — anchor the default db under OPENRIG_HOME, never a bare CWD-relative
  // filename (which could open the shared fleet db). Explicit OPENRIG_DB wins.
  const dbPath = resolveDaemonDbPath(readOpenRigEnv("OPENRIG_DB", "RIGGED_DB"), OPENRIG_HOME);
  const instanceConfig = new SettingsStore().resolveConfig();
  const initialization = ensureOpenRigInstance({
    home: OPENRIG_HOME,
    workspaceRoot: instanceConfig.workspaceRoot,
    contextRoot: instanceConfig.contextRoot,
    skillsRoot: instanceConfig.skillsRoot,
    topologyRoot: instanceConfig.topologyRoot,
  });
  if (!initialization.ok) {
    throw new Error(`OpenRig instance initialization blocked: ${formatInstanceInitializationConflicts(initialization)}`);
  }

  // bug-fix slice auth-bearer-tailscale-trust: distinguish "explicit
  // operator opt-in" from "default" by treating an undefined env as
  // default. When explicit, the operator takes responsibility (and the
  // bearer invariant applies to their chosen host). When default, the
  // daemon always binds loopback and ALSO binds the active tailscale
  // interface (if present) — both accepted paths in the invariant.
  // OPR.0.5.5.20 — bind intent rides ONLY the dedicated OPENRIG_BIND_HOST surface.
  // The overloaded routing env (OPENRIG_HOST/RIGGED_HOST) is observed for the
  // provenance line below and NEVER selects the bind branch: a managed environment's
  // injected endpoint is byte-indistinguishable from opt-in, and the parent daemon
  // silently lost its Tailscale listener to exactly that (operator baton
  // qitem-20260827070400). The auth-bearer-tailscale-trust ruling rides the new
  // surface unchanged.
  const bindPlan = resolveBindPlan({
    bindHostEnv: process.env.OPENRIG_BIND_HOST,
    routingHostEnv: readOpenRigEnv("OPENRIG_HOST", "RIGGED_HOST"),
    tailscaleIp: detectTailscaleInterface(),
  });
  if (bindPlan.ignoredRoutingHost) {
    console.error(
      `[bind-provenance] OPENRIG_HOST=${bindPlan.ignoredRoutingHost} is ROUTING env and was ignored for bind policy — ` +
      `binding default ${bindPlan.hosts.join(" + ")}. Declare bind intent via --host, the daemon.host config key (file), or OPENRIG_BIND_HOST.`,
    );
  }
  const explicitHost = bindPlan.mode === "explicit" ? bindPlan.hosts[0] : undefined;
  // PL-005 Phase B: bearer token for Mission Control write verbs.
  // No legacy alias (this env var is new in Phase B).
  const bearerToken = process.env.OPENRIG_AUTH_BEARER_TOKEN ?? null;

  let bindHosts: string[];
  if (explicitHost) {
    // Operator opt-in path — invariant enforces bearer requirement for
    // genuinely public/LAN binds; loopback/tailscale binds short-circuit.
    await assertBindAuthInvariant({ host: explicitHost, bearerToken });
    bindHosts = [explicitHost];
  } else {
    // Default path — the plan already computed loopback + tailscale-when-active.
    bindHosts = bindPlan.hosts;
  }

  // T053: the process entry holds the one credential object the daemon fills. Startup
  // writes its `workers` list in place as attempts are admitted, so every holder — control
  // routes, the managed launch chain and the mailbox endpoint — reads the same tokens, and
  // the owner credential it started with is never replaced by a second copy.
  const teamControlCredentials: TeamControlCredentials = { ownerToken: resolvedOwnerToken };
  const { app, contextMonitor, deps, eventLoopMonitor } = await createDaemon({
    dbPath,
    managedMode: requestedMode === "managed",
    teamControl: { credentials: teamControlCredentials },
    bearerToken,
    // S20 — the effective bind plan rides the health surface so adoption gates verify
    // listeners from BINDING EVIDENCE (probe each host) instead of config echo.
    bindPlan,
  });

  // Multi-bind via N serve() instances sharing the same Hono app.
  // Hono's serve() targets a single host:port; for multi-bind we spawn
  // one per host. The contextMonitor and seat schedulers only start
  // once after the first successful bind callback fires.
  let monitorsStarted = false;
  // P7 — lifecycle heartbeat: advance last-seen every tick while running.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const servers: ServerType[] = [];
  // KTD22: a managed-mode daemon starts none of the legacy schedulers and monitors below.
  const managed = isManagedMode(deps.rigRepo.db);
  for (const host of bindHosts) {
    const srv = serve({ fetch: app.fetch, port: p, hostname: host }, (info) => {
      console.log(`OpenRig daemon listening on http://${host}:${info.port}`);
      // U5 — report readiness to the Electron parent process over parentPort.
      // Only the loopback bind reports (not a secondary tailscale bind).
      if (host === "127.0.0.1") {
        try {
          (process as { parentPort?: { postMessage: (msg: unknown) => void } }).parentPort?.postMessage({
            type: "ready", port: info.port, pid: process.pid,
          });
        } catch { /* parentPort may be closed during fast shutdown */ }
      }
      if (!monitorsStarted && !managed) {
        contextMonitor.start();
      }
      if (!monitorsStarted) {
        monitorsStarted = true;
        // MVP — observe the end of a direct-launched attempt. The sweep admits each launch
        // receipt's attempt and records it stopped when the process it named is gone; it never
        // decides an outcome, which stays the owner's action. A managed daemon composes it too,
        // because `workers.isolation: none` is the mode a managed daemon runs this path under.
        deps.attemptCompletion?.start();
        // P7 — lifecycle heartbeat (advances last-seen). A write failure logs and
        // continues (the render degrades to an older last-seen honestly); the
        // store guards not-stopped so a tick can never pass stopped_at.
        heartbeatTimer = setInterval(() => {
          try {
            deps.daemonLifecycleStore.recordHeartbeat(new Date().toISOString());
          } catch (err) {
            console.error("[lifecycle-heartbeat] write failed (non-fatal)", err);
          }
        }, HEARTBEAT_INTERVAL_MS);
      }
    });
    trackHttpServerResponses(srv, deps.requestPhaseObserver?.observeRequest);
    servers.push(srv);
  }

  // Multi-bind: close every serve() instance in parallel.
  const shutdownPhases: Array<[string, () => unknown]> = [
    ["timers", () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }],
    ["attempt-completion", () => deps.attemptCompletion?.stop()],
    ["github-login", () => deps.github?.stop()],
    ["event-loop-monitor", () => eventLoopMonitor.stop()],
    ["connections", () => Promise.all(servers.map((srv) => closeHttpServer(srv)))],
    ["recorder", async () => {
      deps.requestPhaseObserver?.close();
      if (await drainSlowOpRecorderOnShutdown(deps.slowOpRecorder) !== 0) {
        throw new Error("slow-operation recorder drain incomplete; records may be lost");
      }
    }],
  ];
  const shutdown = createDaemonShutdown({
    receiptPath: path.join(OPENRIG_HOME, DAEMON_SHUTDOWN_RECEIPT),
    phases: shutdownPhases,
    // A service failure, open connection, or lost recorder drain is never clean.
    markClean: () => deps.daemonLifecycleStore.recordStop(deps.daemonBootEpoch, new Date().toISOString()),
  });
  // Repeated signals join the first shutdown instead of bypassing its evidence.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  /** U5 — parent-port bridge for Electron utility-process hosting. */
  // parentPort is injected by Electron's utilityProcess runtime; it is not
  // a standard Node.js Process property, so we access it via cast. Electron's
  // MessagePortMain delivers `{ data }`; worker_threads delivers the value.
  const parentPort = (process as {
    parentPort?: {
      on: (event: string, listener: (message: unknown) => void) => void;
      postMessage: (message: unknown) => void;
    };
  }).parentPort;
  /**
   * U12 — ending the workers of a desktop-owned daemon.
   *
   * The desktop app owns this daemon's lifetime, so when it asks for a shutdown the agents it
   * started must not survive it. Each live attempt recorded its own process pair, and the same
   * tree kill cancellation and boot recovery use ends them: `taskkill /T /F` on Windows, the
   * process group on POSIX. An identity that cannot be proved is never signalled as if it were
   * dead; a tree that survives makes this phase fail, so the shutdown receipt does not claim a
   * clean stop and the next boot reconciles what is left.
   *
   * A daemon that was not started by the desktop keeps its workers: the legacy path treats
   * agents as durable across daemon restarts, and recovery reconciles them on the next boot.
   */
  const endWorkerChildren = async (): Promise<void> => {
    const result = await endRunningWorkerTrees(deps.rigRepo.db);
    if (result.unresolved > 0) {
      throw new Error(`${result.unresolved} of ${result.attempted} worker process tree(s) could not be proved stopped`);
    }
  };
  // The phase joins the existing bounded shutdown so its receipt says how it ended.
  if (parentPort) shutdownPhases.push(["worker-processes", endWorkerChildren]);
  if (parentPort) {
    parentPort.on("message", (message: unknown) => {
      const envelope = message as { data?: unknown };
      const msg = (envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : message) as Record<string, unknown> | null;
      if (msg?.type === "shutdown") shutdown("parent");
      // U6 — native pairing. The desktop mints a one-time code over this private port
      // instead of holding an owner token, then exchanges it over HTTP like a browser
      // would. Only the parent process can reach this listener, so no HTTP route changes.
      // The code goes back over the port and is never logged or written anywhere.
      if (msg?.type === "mint-pairing") replyToMintPairing(deps.ownerSessions, resolvedOwnerToken, parentPort);
      // U12 — first-run dependency status. The desktop asks the daemon that will launch the
      // workers, so the resolved paths it shows are the paths a launch will use.
      if (msg?.type === "dependencies") replyToDependencies(parentPort);
    });
  }

  // Backward-compatible single-server return (callers that just need a
  // handle reference; multi-bind shutdown is wired via signal handlers).
  return servers[0]!;
}

/** U6 — answer one `mint-pairing` request over the parent port. */
export function replyToMintPairing(
  sessions: import("./domain/owner-session.js").OwnerSessions | undefined,
  ownerToken: string | null,
  port: { postMessage: (message: unknown) => void },
): void {
  const reply = (message: unknown): void => replyOnParentPort(port, message);
  if (!sessions || !ownerToken) return reply({ type: "pairing-error", error: "owner_session_unavailable" });
  try {
    const { code } = sessions.mint(ownerToken);
    reply({ type: "pairing-code", code });
  } catch {
    // Never echo the code or the underlying error: a failed mint is a failed mint.
    reply({ type: "pairing-error", error: "pairing_mint_failed" });
  }
}

/** Post one answer on the parent port; a closed port is not an error worth raising. */
function replyOnParentPort(port: { postMessage: (message: unknown) => void }, message: unknown): void {
  try { port.postMessage(message); } catch { /* parentPort may be closed */ }
}

/**
 * U12 — answer one `dependencies` request over the parent port.
 *
 * The answer is U1's resolver output for `claude`, `codex`, `git` and `gh`, unchanged: the
 * desktop's first-run page shows what this daemon resolved, so its paths are the paths a launch
 * will use. A resolver failure is reported as a named error, never as an empty "all good" list.
 */
export function replyToDependencies(port: { postMessage: (message: unknown) => void }): void {
  try {
    replyOnParentPort(port, { type: "dependencies", resolutions: resolveClientDependencies() });
  } catch (error) {
    replyOnParentPort(port, { type: "dependencies-error", error: error instanceof Error ? error.message : String(error) });
  }
}

// Only start the server when this file is executed directly (not imported).
// pathToFileURL normalizes argv[1] (backslash paths on Windows) into the same
// shape as import.meta.url — a plain `file://${argv[1]}` never matches on win32,
// which made the daemon exit silently with code 0.
const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer();
}
