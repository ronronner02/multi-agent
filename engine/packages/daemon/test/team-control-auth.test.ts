import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamControlOptions } from "../src/routes/team-control.js";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, fixDaemonMode, hashBinding } from "../src/domain/plan-governance.js";
import { createTestApp } from "./helpers/test-app.js";
import type { PlanBinding } from "../src/contracts/team-control.js";

const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: `sha256:${"a".repeat(64)}`,
  repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 1, policyFingerprint: `sha256:${"c".repeat(64)}`,
  limits: { maxSessions: 3, maxActiveMs: 3600000, maxRetries: 1, maxReviewRounds: 2 },
};
const ownerToken = "owner-control-fixture";
const workerToken = "worker-control-fixture";
const capability = { policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint,
  verifiedProviders: ["claude", "codex"] as const };

describe("managed control authority on the shared application", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let governance: PlanGovernance;
  let app: ReturnType<typeof createTestApp>["app"];
  let key: number;
  let options: TeamControlOptions;
  beforeEach(() => {
    db = createDb(); initializeDatabase(db);
    fixDaemonMode(db, true);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('managed-rig', 'managed')").run();
    const bus = new EventBus(db);
    queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => capability);
    governance.createRun({ id: "run", rigId: "managed-rig", binding });
    options = { credentials: { ownerToken, workers: [{ token: workerToken, sessionId: "worker-session", runId: "run" }] },
      resolveBinding: () => binding, readPolicyCapability: () => capability };
    app = createTestApp(db, { appDeps: {
      queueRepo: queue, eventBus: bus, legacyBearerToken: "legacy-control-fixture",
      terminalBearerToken: "terminal-control-fixture", teamControl: options,
    } }).app;
    key = 0;
  });
  afterEach(() => { vi.unstubAllEnvs(); db.close(); });

  const command = (payload: unknown, actionId = "approval") => ({
    protocolVersion: "1.0", runId: "run", actionId, expectedEntityVersion: governance.getRun("run").entityVersion,
    idempotencyKey: `key-${++key}`, payload,
  });
  const request = (path: string, body?: unknown, token = ownerToken, headers: Record<string, string> = {}, peer = "127.0.0.1") =>
    app.request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Host: "localhost", Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { incoming: { socket: { remoteAddress: peer } } });
  const approvalRequest = () => command({ kind: "orchestrator", action: "implementation",
    payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding),
    expiresAt: new Date(Date.now() + 3600000).toISOString() });

  it("returns an empty approval list as a successful result", async () => {
    const response = await request("/api/team-control/runs/run/approvals");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ protocolVersion: "1.0", approvals: [] });
  });

  it("does not source shared-app authority from an ambient owner token", async () => {
    vi.stubEnv("MULTI_AGENT_OWNER_TOKEN", ownerToken);
    app = createTestApp(db, { appDeps: { queueRepo: queue } }).app;
    expect((await request("/api/team-control/runs/run/approvals")).status).toBe(401);
  });

  it("allows a run-bound worker to request a decision but never to grant it", async () => {
    expect((await request("/api/team-control/runs/run/approvals/request", approvalRequest(), workerToken)).status).toBe(200);
    const forged = { ...command({ decision: "approved", approvalVersion: 1 }), actor: { kind: "owner", sessionId: "owner" } };
    const response = await request("/api/team-control/runs/run/approvals/decide", forged, workerToken);
    expect(response.status).toBe(403);
    expect(governance.getApproval("approval")?.state).toBe("pending");
    expect((await request("/api/team-control/runs/run/approvals/decide",
      command({ decision: "rejected", approvalVersion: 1 }))).status).toBe(200);
    expect(governance.getApproval("approval")?.decisionActor).toBe("owner-control");
  });

  it.each([ownerToken, workerToken])("denies native prompt approval requests from %s", async (token) => {
    const response = await request("/api/team-control/runs/run/approvals/request", command({
      kind: "native", action: "native-tool", payload: { command: "fixture" },
      targetDigest: hashBinding(binding), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }), token);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ status: "denied", effectMayStart: false,
      reason: expect.stringMatching(/native prompt.*configuration fault/i) });
    expect(governance.getApproval("approval")).toBeNull();
    expect(governance.getRun("run").state).toBe("pending");
  });

  it("keeps historical native approvals readable without allowing decisions or effects", async () => {
    await request("/api/team-control/runs/run/approvals/request", approvalRequest());
    await request("/api/team-control/runs/run/approvals/decide", command({ decision: "approved", approvalVersion: 1 }));
    db.prepare(`INSERT INTO team_approvals
      (id, run_id, kind, action, payload_json, payload_digest, target_digest, binding_digest, state, expires_at, created_at, updated_at)
      VALUES ('historical-native', 'run', 'native', 'native-tool', '{}', ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(`sha256:${createHash("sha256").update("{}").digest("hex")}`, hashBinding(binding), hashBinding(binding),
        new Date(Date.now() + 3600000).toISOString(), new Date().toISOString(), new Date().toISOString());
    const response = await request("/api/team-control/runs/run/approvals/decide",
      command({ decision: "approved", approvalVersion: 1 }, "historical-native"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ status: "denied", effectMayStart: false,
      reason: expect.stringMatching(/native prompt.*configuration fault/i) });
    expect(governance.getApproval("historical-native")?.state).toBe("pending");
    db.prepare("UPDATE team_approvals SET state = 'approved' WHERE id = 'historical-native'").run();
    const reservation = governance.reserveApproval(command({ kind: "native", action: "native-tool", payload: {},
      targetDigest: hashBinding(binding), attemptId: "historical-attempt" }, "historical-native"), binding);
    expect(reservation).toMatchObject({ status: "denied", effectMayStart: false,
      reason: expect.stringMatching(/native prompt.*configuration fault/i) });
    expect(governance.getConsumption("historical-native")).toBeNull();
    const approvals = await request("/api/team-control/runs/run/approvals");
    expect((await approvals.json()).approvals).toContainEqual(expect.objectContaining({ id: "historical-native", state: "approved" }));
  });

  it("persists rejection and replays the same decision without another effect", async () => {
    await request("/api/team-control/runs/run/approvals/request", approvalRequest(), workerToken);
    const decision = command({ decision: "rejected", approvalVersion: 1 });
    const first = await request("/api/team-control/runs/run/approvals/decide", decision);
    const retry = await request("/api/team-control/runs/run/approvals/decide", decision);
    expect(first.status).toBe(200);
    expect(await retry.json()).toMatchObject({ replayed: true, effectMayStart: false });
    expect(governance.getApproval("approval")?.state).toBe("rejected");
  });

  it.each(["", "unknown", "legacy-control-fixture", "terminal-control-fixture"])("does not treat %j as an owner credential", async (token) => {
    expect((await request("/api/team-control/runs/run/approvals", undefined, token)).status).toBe(401);
  });

  it.each([{ Origin: "http://localhost" }, { Cookie: "owner=claimed" }, { "Sec-Fetch-Site": "same-origin" }])(
    "does not turn browser credentials into owner authority: %j", async (headers) => {
      expect((await request("/api/team-control/runs/run/approvals/request", approvalRequest(), ownerToken, headers)).status).toBe(403);
      expect(governance.getApproval("approval")).toBeNull();
    });

  it("checks the socket peer rather than forwarded headers or the Host", async () => {
    expect((await request("/api/team-control/runs/run/approvals", undefined, ownerToken,
      { "X-Forwarded-For": "127.0.0.1" }, "192.0.2.1")).status).toBe(403);
  });

  it("rejects an incompatible protocol and conflicting run identity before a mutation", async () => {
    const invalid = { ...approvalRequest(), protocolVersion: "2.0" };
    expect((await request("/api/team-control/runs/run/approvals/request", invalid)).status).toBe(400);
    expect((await request("/api/team-control/runs/other/approvals/request", approvalRequest(), workerToken)).status).toBe(403);
    expect(governance.getRun("run").entityVersion).toBe(1);
  });

  it("closes legacy WebSocket and read-with-side-effect paths as well", async () => {
    expect((await request("/api/terminal/ws?token=terminal-control-fixture")).status).toBe(403);
    expect((await request("/api/terminal/open")).status).toBe(403);
  });


  it.each(["managed", "legacy"] as const)("serves legacy pages only in a legacy-mode daemon: %s", async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "team-control-ui-"));
    const localDb = createDb(); initializeDatabase(localDb);
    try {
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "index.html"), "<html><head></head><body>Legacy administration</body></html>");
      writeFileSync(join(dir, "assets", "app.js"), "legacyAdministration();");
      fixDaemonMode(localDb, mode === "managed");
      const bus = new EventBus(localDb);
      const localApp = createTestApp(localDb, { appDeps: {
        queueRepo: new QueueRepository(localDb, bus), eventBus: bus, webUiEnabled: true, uiDistDir: dir,
        terminalBearerToken: "legacy-page-secret",
      } }).app;
      for (const path of ["/", "/index.html", "/assets/app.js"]) {
        const response = await localApp.request(path);
        const body = await response.text();
        if (mode === "legacy") {
          expect(response.status, path).toBe(200);
          continue;
        }
        // The managed team view is built from the same bundle and is served at /team, so the
        // bundle's assets are reachable in managed mode. The pages are not: `/` and every
        // legacy route still refuse, and no page body carries the legacy surface or a token.
        if (path.startsWith("/assets/")) {
          expect(response.status, path).toBe(200);
          expect(body, path).not.toContain("legacy-page-secret");
          continue;
        }
        expect(response.status, path).toBe(404);
        expect(body, path).not.toContain("Legacy administration");
        expect(body, path).not.toContain("legacyAdministration");
        expect(body, path).not.toContain("legacy-page-secret");
      }
    } finally { localDb.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("accepts dedicated owner authentication on an actual loopback socket", async () => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/team-control/runs/run/approvals`,
        { headers: { Authorization: `Bearer ${ownerToken}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ approvals: [] });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("rejects an incompatible read protocol, query token and absent socket identity", async () => {
    expect((await request("/api/team-control/runs/run", undefined, ownerToken, { "X-Team-Control-Version": "2.0" })).status).toBe(400);
    expect((await request(`/api/team-control/runs/run?token=${ownerToken}`, undefined, "")).status).toBe(401);
    expect((await app.request("http://localhost/api/team-control/runs/run",
      { headers: { Authorization: `Bearer ${ownerToken}` } })).status).toBe(403);
  });

  it("fails closed when credentials are absent, revoked or shared across roles", async () => {
    options.credentials.ownerToken = null;
    expect((await request("/api/team-control/runs/run")).status).toBe(401);
    options.credentials.ownerToken = workerToken;
    expect((await request("/api/team-control/runs/run", undefined, workerToken)).status).toBe(503);
    options.credentials.ownerToken = "legacy-control-fixture";
    expect((await request("/api/team-control/runs/run", undefined, "legacy-control-fixture")).status).toBe(503);
  });

  it("permits a limit decision request without permitting a worker to apply it", async () => {
    const original = governance.getRun("run").binding.limits;
    const pending = command({ kind: "orchestrator", action: "limit-increase", payload: { maxSessions: 30 },
      targetDigest: hashBinding(binding), expiresAt: new Date(Date.now() + 3600000).toISOString() });
    expect((await request("/api/team-control/runs/run/approvals/request", pending, workerToken)).status).toBe(200);
    expect((await request("/api/team-control/runs/run/approvals/decide",
      command({ decision: "approved", approvalVersion: 1 }), workerToken)).status).toBe(403);
    expect((await request("/api/team-control/runs/run/tasks/outcome",
      command({ state: "done", actorSession: "owner-control" }), workerToken)).status).toBe(403);
    expect(governance.getRun("run").binding.limits).toEqual(original);
  });

  it("keeps cancellation owner-only and reports intent rather than a stopped outcome", async () => {
    const cancel = command({ reason: "Stop requested", owner: true });
    expect((await request("/api/team-control/runs/run/cancel", cancel, workerToken)).status).toBe(403);
    const response = await request("/api/team-control/runs/run/cancel", cancel);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "pending-execution", effectMayStart: false });
    expect(governance.getRun("run").state).toBe("cancel_requested");
  });

  it("denies stale bindings and records invalidation before acknowledging a decision", async () => {
    await request("/api/team-control/runs/run/approvals/request", approvalRequest(), workerToken);
    options.resolveBinding = () => ({ ...binding, policyRevision: binding.policyRevision + 1 });
    const response = await request("/api/team-control/runs/run/approvals/decide", command({ decision: "approved", approvalVersion: 1 }));
    expect(response.status).toBe(403);
    expect(governance.getRun("run").state).toBe("invalidated");
    expect(governance.getApproval("approval")?.state).toBe("invalidated");
  });

  it("does not substitute the registered binding when current evidence is unavailable", async () => {
    await request("/api/team-control/runs/run/approvals/request", approvalRequest(), workerToken);
    options.resolveBinding = undefined;
    expect((await request("/api/team-control/runs/run/approvals/decide",
      command({ decision: "approved", approvalVersion: 1 }))).status).toBe(503);
    expect(governance.getApproval("approval")?.state).toBe("pending");
  });

  it("does not reinterpret a remote target envelope as a local owner action", async () => {
    const response = await request("/api/team-control/runs/run/approvals/request?host=peer", approvalRequest());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(governance.getApproval("approval")).toBeNull();
    expect(governance.getRun("run").entityVersion).toBe(1);
  });

  it("returns version and idempotency conflicts without granting additional authority", async () => {
    const original = approvalRequest();
    await request("/api/team-control/runs/run/approvals/request", original, workerToken);
    const conflict = { ...original, payload: { reason: "different operation" } };
    expect((await request("/api/team-control/runs/run/approvals/request", conflict, workerToken)).status).toBe(409);
    expect((await request("/api/team-control/runs/run/cancel", { ...command({ reason: "stop" }), expectedEntityVersion: 1 })).status).toBe(409);
    expect(governance.getRun("run").state).toBe("pending");
  });

  it("acknowledges no action when receipt persistence fails", async () => {
    db.exec("CREATE TRIGGER fail_control_receipt BEFORE INSERT ON team_control_requests BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
    const response = await request("/api/team-control/runs/run/approvals/request", approvalRequest(), workerToken);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "control_persistence_failed" });
    expect(governance.getApproval("approval")).toBeNull();
    expect(governance.getRun("run").entityVersion).toBe(1);
  });

  it("refuses direct queue writes without a managed-control grant", async () => {
    await expect(queue.create({ sourceSession: "lead@managed", destinationSession: "worker@managed", body: "unapproved", nudge: false }))
      .rejects.toThrow(/managed/i);
    expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 0 });
  });
});
