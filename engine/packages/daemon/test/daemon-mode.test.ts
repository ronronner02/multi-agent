// KTD22 — the daemon's mode is fixed once at startup. A managed-mode daemon runs no
// legacy boot effect and serves no legacy route, so no legacy work can be in flight
// when managed authority exists. These cases drive the real createDaemon composition.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, daemonModeOf, fixDaemonMode, isManagedMode } from "../src/domain/plan-governance.js";
import { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { GatewaySubsystem } from "../src/domain/gateway/gateway-subsystem.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { WatchdogAutoRegistration } from "../src/domain/watchdog-auto-registration.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { ModelDivergenceMonitor } from "../src/domain/model-divergence/model-divergence-monitor.js";
import { ClaudePermissionModeCache } from "../src/domain/permission-drift-observer.js";
import * as transcriptCapture from "../src/domain/transcript-capture.js";
import * as starterSpecLoader from "../src/domain/workflow/starter-spec-loader.js";
import * as proofSourceWatch from "../src/domain/proof/source-watch.js";
import * as activityEndpoint from "../src/domain/activity-endpoint.js";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ExecFn } from "../src/domain/tmux-adapter.js";
import type { PlanBinding } from "../src/contracts/team-control.js";

const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: `sha256:${"a".repeat(64)}`,
  repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 1, policyFingerprint: `sha256:${"c".repeat(64)}`,
  limits: { maxSessions: 3, maxActiveMs: 3600000, maxRetries: 1, maxReviewRounds: 2 },
};

const freshDb = () => {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('mode-rig', 'mode')").run();
  return db;
};

const tableRowCounts = (db: ReturnType<typeof createDb>): Record<string, number> => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => {
    const row = db.prepare(`SELECT count(*) AS count FROM "${name.replace(/"/g, '""')}"`).get() as { count: number };
    return [name, row.count];
  }));
};

const managedBootWritableTables = new Set([
  "self_host_identity", // reconcileSelfHostIdentity mints the durable host identity on first boot.
  "daemon_lifecycle", // recordBoot records a fresh daemon epoch in either mode.
]);

describe("daemon mode fixed at startup (real composition)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let scratch: string;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-mode-"));
    for (const key of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL", "OPENRIG_SLICES_ROOT"]) savedEnv[key] = process.env[key];
    delete process.env.OPENRIG_URL;
    delete process.env.OPENRIG_PORT;
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const boot = async (mode: "legacy" | "managed") => {
    const home = path.join(scratch, mode);
    process.env.OPENRIG_HOME = home;
    const slicesRoot = path.join(scratch, `${mode}-workspace`, "missions");
    fs.mkdirSync(slicesRoot, { recursive: true });
    process.env.OPENRIG_SLICES_ROOT = slicesRoot;
    const dbPath = path.join(scratch, `${mode}.sqlite`);
    process.env.OPENRIG_DB = dbPath;
    // A registered rig makes reconciliation and per-rig watchdog registration observable.
    const seed = createDb(dbPath);
    migrate(seed, ALL_MIGRATIONS);
    seed.prepare("INSERT INTO rigs (id, name) VALUES ('seeded-rig', 'seeded')").run();
    const beforeRows = tableRowCounts(seed);
    seed.close();
    const spies = {
      gateway: vi.spyOn(GatewaySubsystem.prototype, "start"),
      guardRecovery: vi.spyOn(SeatDeliveryGuard.prototype, "recoverActivation"),
      reconcile: vi.spyOn(Reconciler.prototype, "reconcile"),
      vendoring: vi.spyOn(PluginVendorService.prototype, "ensureLatest"),
      wakeDrain: vi.spyOn(QueueRepository.prototype, "drainPendingWakeIntents"),
      waitReminders: vi.spyOn(QueueRepository.prototype, "startWaitReminders"),
      watchdogObserver: vi.spyOn(SessionRegistry.prototype, "setWatchdogRegistrationObserver"),
      watchdogCoverage: vi.spyOn(WatchdogAutoRegistration.prototype, "assertLiveSeatCoverage"),
      watchdogJobs: vi.spyOn(WatchdogJobsRepository.prototype, "ensureAutoRegistration"),
      cmux: vi.spyOn(CmuxAdapter.prototype, "connect"),
      transcriptCapture: vi.spyOn(transcriptCapture, "resumeRunningTranscriptCaptures"),
      starterSpecs: vi.spyOn(starterSpecLoader, "loadStarterWorkflowSpecs"),
      proofWatch: vi.spyOn(proofSourceWatch, "watchProofSources"),
      modelPolling: vi.spyOn(ModelDivergenceMonitor.prototype, "startPolling"),
      permissionProbe: vi.spyOn(ClaudePermissionModeCache.prototype, "warm"),
      activityToken: vi.spyOn(activityEndpoint, "ensureActivityHookToken"),
    };
    const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); };
    const tmuxExec: ExecFn = async () => "";
    const result = await createDaemon({ cmuxFactory, tmuxExec, dbPath, managedMode: mode === "managed" });
    return { ...result, spies, home, beforeRows };
  };

  it("runs the legacy boot effects in a legacy-mode daemon (control case)", async () => {
    const { db, deps, spies } = await boot("legacy");
    try {
      expect(daemonModeOf(db)).toBe("legacy");
      for (const [name, spy] of Object.entries(spies)) expect(spy, name).toHaveBeenCalled();
      expect(deps.eventBus.subscriberCount).toBeGreaterThan(0);
      expect(deps.rigRepo.onRigCreated).toBeTypeOf("function");
    } finally { deps.proofSourceWatch?.close(); deps.modelDivergenceMonitor?.stop(); deps.gatewaySubsystem?.stop(); db.close(); }
  }, 60000);

  it("runs none of the legacy boot effects and refuses every legacy route in a managed-mode daemon", async () => {
    const { app, db, deps, spies, home, beforeRows } = await boot("managed");
    try {
      expect(daemonModeOf(db)).toBe("managed");
      const afterRows = tableRowCounts(db);
      const changedTables = [...new Set([...Object.keys(beforeRows), ...Object.keys(afterRows)])]
        .filter(table => !managedBootWritableTables.has(table) && beforeRows[table] !== afterRows[table])
        .map(table => ({ table, before: beforeRows[table], after: afterRows[table] }));
      expect(changedTables, "managed boot must not write legacy tables").toEqual([]);
      expect(afterRows).toMatchObject({ self_host_identity: 1, daemon_lifecycle: 1 });
      for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
      expect(deps.eventBus.subscriberCount).toBe(0);
      expect(deps.rigRepo.onRigCreated).toBeUndefined();
      expect(deps.proofSourceWatch).toBeUndefined();
      expect(fs.existsSync(path.join(home, "plugins"))).toBe(false);
      const routes = [...new Set(app.routes.filter(route => route.method !== "ALL"
        && route.path.startsWith("/api/") && !route.path.startsWith("/api/team-control"))
        .map(route => `${route.method} ${route.path}`))];
      expect(routes.length).toBeGreaterThan(50);
      for (const entry of routes) {
        const [method, pattern] = entry.split(" ");
        const requestPath = pattern!.replace(/:[^/]+/g, "fixture").replace(/\*/g, "fixture");
        const response = await app.request(`http://localhost${requestPath}`, {
          method, headers: { Host: "localhost", "Content-Type": "application/json" },
          ...(["GET", "HEAD"].includes(method!) ? {} : { body: "{}" }),
        }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
        expect(response.status, entry).toBe(403);
        if (method !== "HEAD") expect(await response.json(), entry).toMatchObject({ code: "managed_control_required" });
      }
    } finally { deps.proofSourceWatch?.close(); deps.modelDivergenceMonitor?.stop(); deps.gatewaySubsystem?.stop(); db.close(); }
  }, 60000);
});

describe("daemon mode transitions and owner checks", () => {
  it.each(["legacy", "managed"] as const)("uses the fixed %s mode without querying managed authority", mode => {
    const db = freshDb();
    fixDaemonMode(db, mode === "managed");
    const prepare = vi.spyOn(db, "prepare");
    try {
      expect(isManagedMode(db)).toBe(mode === "managed");
      expect(prepare).not.toHaveBeenCalled();
    } finally { prepare.mockRestore(); db.close(); }
  });

  it("refuses managed-authority registration in a legacy-mode daemon and keeps legacy writes working", async () => {
    const db = freshDb();
    try {
      expect(fixDaemonMode(db, false)).toBe("legacy");
      const bus = new EventBus(db);
      const queue = new QueueRepository(db, bus);
      expect(() => new PlanGovernance(db, bus, queue).createRun({ id: "run", rigId: "mode-rig", binding }))
        .toThrow(/legacy-mode daemon cannot register/);
      await queue.create({ sourceSession: "lead@mode", destinationSession: "worker@mode", body: "legacy work", nudge: false });
      expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT count(*) AS count FROM team_runs").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it("starts in managed mode when the database already holds managed authority", () => {
    const db = freshDb();
    try {
      expect(daemonModeOf(db)).toBeUndefined();
      expect(isManagedMode(db)).toBe(false);
      const bus = new EventBus(db);
      new PlanGovernance(db, bus, new QueueRepository(db, bus)).createRun({ id: "run", rigId: "mode-rig", binding });
      expect(isManagedMode(db)).toBe(true);
      expect(fixDaemonMode(db, false)).toBe("managed");
    } finally { db.close(); }
  });

  it("requires a restart to switch the mode of a running process", () => {
    const db = freshDb();
    try {
      expect(fixDaemonMode(db, false)).toBe("legacy");
      expect(fixDaemonMode(db, false)).toBe("legacy");
      expect(() => fixDaemonMode(db, true)).toThrow(/restart to switch modes/);
    } finally { db.close(); }
  });

  it("refuses tmux input and lifecycle effects without a managed-control grant in managed mode", async () => {
    const db = freshDb();
    try {
      fixDaemonMode(db, true);
      const commands: string[] = [];
      const tmux = new TmuxAdapter(async command => { commands.push(command); return ""; });
      tmux.deliveryGuard = new SeatDeliveryGuard(db, () => null);
      expect(await tmux.createProbeSession("probe")).toMatchObject({ ok: false, code: "managed_control_required" });
      expect(await tmux.createSession("probe", undefined, { OPENRIG_NODE_ID: "probe" })).toMatchObject({ ok: false, code: "managed_control_required" });
      expect(await tmux.sendKeys("probe", ["Enter"])).toMatchObject({ ok: false, code: "managed_control_required" });
      expect(await tmux.killSession("probe")).toMatchObject({ ok: false, code: "managed_control_required" });
      expect(commands.filter(command => /tmux (new-session|send-keys|kill-session|detach-client)/.test(command))).toEqual([]);
    } finally { db.close(); }
  });

  it("refuses owner-level queue mutators without a managed-control grant", async () => {
    const db = freshDb();
    try {
      const bus = new EventBus(db);
      const queue = new QueueRepository(db, bus);
      const item = await queue.create({
        sourceSession: "lead@mode",
        destinationSession: "worker@mode",
        body: "legacy setup",
        nudge: false,
      });
      fixDaemonMode(db, true);

      expect(() => queue.routeToFallback(item.qitemId, "fallback@mode", "ungranted")).toThrow(/managed/i);
      expect(() => queue.releaseClaimsByGeneration("retired-generation")).toThrow(/managed/i);
      await expect(queue.drainPendingWakeIntents()).rejects.toMatchObject({ code: "managed_control_required" });
    } finally {
      db.close();
    }
  });

  it("allows tmux session creation under a lifecycle grant in managed mode", async () => {
    const db = freshDb();
    try {
      fixDaemonMode(db, true);
      const commands: string[] = [];
      const target = { nodeId: "node-a", session: "session-a", occupant: null, pane: null };
      const guard = new SeatDeliveryGuard(db, name => name === "node-a" || name === "session-a" ? target : null);
      const tmux = new TmuxAdapter(async command => {
        commands.push(command);
        return command.startsWith("tmux new-session") ? "%1\\n" : "";
      });
      tmux.deliveryGuard = guard;

      const result = await guard.lifecycle(["node-a"], () => tmux.createSession(
        "session-a",
        undefined,
        { OPENRIG_NODE_ID: "node-a" },
      ));

      expect(result).toEqual({ ok: true });
      expect(commands[0]).toContain("tmux new-session");
    } finally {
      db.close();
    }
  });

  it("allows tmux input and session kill inside a lifecycle grant in managed mode", async () => {
    const db = freshDb();
    try {
      fixDaemonMode(db, true);
      const commands: string[] = [];
      const target = { nodeId: "node-a", session: "session-a", occupant: null, pane: "%1" };
      const guard = new SeatDeliveryGuard(db, name => name === "node-a" || name === "session-a" ? target : null);
      const tmux = new TmuxAdapter(async command => {
        commands.push(command);
        return command.includes("display-message") ? "$7\n" : "";
      });
      tmux.deliveryGuard = guard;
      vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);

      const input = await guard.lifecycle(["node-a"], () => tmux.sendKeys("session-a", ["Enter"]));
      const killed = await guard.lifecycle(["node-a"], () => tmux.killSession("session-a"));

      expect(input).toEqual({ ok: true });
      expect(killed).toEqual({ ok: true });
      expect(commands.some(command => command.includes("tmux send-keys"))).toBe(true);
      expect(commands.some(command => command.includes("tmux kill-session -t '$7'"))).toBe(true);
    } finally {
      db.close();
    }
  });

});
