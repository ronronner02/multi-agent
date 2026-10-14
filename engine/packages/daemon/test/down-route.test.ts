import { describe, it, expect, vi } from "vitest";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { createApp } from "../src/server.js";
import { DeliveryGuardError } from "../src/domain/seat-delivery-guard.js";
import { RigNotFoundError } from "../src/domain/errors.js";

describe("POST /api/down route", () => {
  it("returns committed teardown details and warnings when deletion finalization fails", async () => {
    const db = createFullTestDb();
    try {
      const { app, rigRepo, sessionRegistry } = createTestApp(db);
      const rig = rigRepo.createRig("finalization-warning");
      const node = rigRepo.addNode(rig.id, "n1");
      const session = sessionRegistry.registerSession(node.id, "r01-finalization");
      sessionRegistry.updateStatus(session.id, "running");
      db.exec(`CREATE TRIGGER fail_reservation_release BEFORE INSERT ON events
        WHEN NEW.type = 'rig.deletion_fence' AND json_extract(NEW.payload, '$.phase') = 'released'
        BEGIN SELECT RAISE(ABORT, 'reservation release failed'); END;`);
      const response = await app.request("/api/down", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rigId: rig.id, delete: true }),
      });
      expect(rigRepo.getRig(rig.id)).toBeNull();
      expect(() => rigRepo.assertNoPendingDeletion(rig.id)).toThrow(/deletion is in progress/);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ deleted: true, sessionsKilled: 1,
        deletionFinalization: { error: "reservation release failed" }, errors: [expect.stringMatching(/reservation release failed/)] });
    } finally { db.close(); }
  });

  it.each([
    ["internal", new Error("native stop failed"), 500, "rig_deletion_finalization_failed"],
    ["delivery guard", new DeliveryGuardError("guard_target_changed", "seat changed"), 409, "guard_target_changed"],
    ["not found", new RigNotFoundError("missing-during-stop"), 404, "rig_deletion_finalization_failed"],
  ] as const)("preserves the %s response and both errors when deletion finalization fails", async (_kind, primaryError, status, code) => {
    const db = createFullTestDb();
    try {
      const tmux = mockTmuxAdapter();
      (tmux.killSession as ReturnType<typeof vi.fn>).mockRejectedValue(primaryError);
      const { app, rigRepo, sessionRegistry } = createTestApp(db, { tmux });
      const rig = rigRepo.createRig("dual-failure");
      const node = rigRepo.addNode(rig.id, "n1");
      const session = sessionRegistry.registerSession(node.id, "r01-dual-failure");
      sessionRegistry.updateStatus(session.id, "running");
      db.exec(`CREATE TRIGGER fail_reservation_release BEFORE INSERT ON events
        WHEN NEW.type = 'rig.deletion_fence' AND json_extract(NEW.payload, '$.phase') = 'released'
        BEGIN SELECT RAISE(ABORT, 'reservation release failed'); END;`);
      const response = await app.request("/api/down", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rigId: rig.id, delete: true }),
      });
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ code, deletionFinalization: { error: "reservation release failed" } });
      expect(body.error).toContain(primaryError.message);
      expect(body.error).toContain("reservation release failed");
      expect(rigRepo.getRig(rig.id)).not.toBeNull();
      expect(() => rigRepo.assertNoPendingDeletion(rig.id)).toThrow(/deletion is in progress/);
    } finally { db.close(); }
  });

  // R1: missing rigId -> 400
  it("returns 400 when rigId is missing", async () => {
    const { app } = createTestApp(createFullTestDb());
    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/rigId/);
  });

  // R2: nonexistent rig -> 404
  it("returns 404 for nonexistent rig", async () => {
    const { app } = createTestApp(createFullTestDb());
    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: "nonexistent-rig" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  // R3: --delete blocked by kill failure -> 409
  it("returns 409 when delete is blocked by kill failures", async () => {
    const tmux = mockTmuxAdapter();
    (tmux.killSession as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, message: "kill failed" });
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { tmux });

    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "n1");
    const session = sessionRegistry.registerSession(node.id, "r01-dev1");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, delete: true }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.deleteBlocked).toBe(true);
    expect(body.deleted).toBe(false);
  });

  // R4: same-db-handle invariant
  it("throws if teardownOrchestrator uses a different db", () => {
    const db1 = createFullTestDb();
    const { app: _ignore, ...testApp1 } = createTestApp(db1);

    // Build a valid RigTeardownOrchestrator on a separate db
    const db2 = createFullTestDb();
    const { teardownOrchestrator: foreignTeardown } = createTestApp(db2);

    expect(() => {
      createApp({
        ...testApp1,
        teardownOrchestrator: foreignTeardown,
      });
    }).toThrow(/teardownOrchestrator must share the same db handle/);
  });

  // R5: internal delete failure -> 500 (via route catch, not TeardownResult)
  it("returns 500 for internal delete failure (not 409)", async () => {
    const tmux = mockTmuxAdapter();
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { tmux });

    const rig = rigRepo.createRig("test-rig-2");
    const node = rigRepo.addNode(rig.id, "n1");
    const session = sessionRegistry.registerSession(node.id, "r01-dev1");
    sessionRegistry.updateStatus(session.id, "running");

    // Kill succeeds but deleteRig throws (internal failure during atomicDelete)
    const origDelete = rigRepo.deleteRig.bind(rigRepo);
    rigRepo.deleteRig = () => { throw new Error("disk full"); };

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, delete: true }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    // Route returns TeardownResult when orchestrator catches internally
    // but this path propagates via the non-alreadyStopped branch's try-catch
    expect(body.deleted).toBe(false);
    expect(body.deleteBlocked).toBe(false);

    rigRepo.deleteRig = origDelete;
  });

  // R6: --delete + snapshot failure + successful delete -> 200
  it("returns 200 when delete succeeds despite snapshot warnings", async () => {
    const tmux = mockTmuxAdapter();
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry, snapshotCapture } = createTestApp(db, { tmux });

    const rig = rigRepo.createRig("test-rig-3");
    const node = rigRepo.addNode(rig.id, "n1");
    const session = sessionRegistry.registerSession(node.id, "r01-dev1");
    sessionRegistry.updateStatus(session.id, "running");

    // Sabotage snapshot to produce an error
    const origCapture = snapshotCapture.captureSnapshot.bind(snapshotCapture);
    snapshotCapture.captureSnapshot = () => { throw new Error("snapshot disk full"); };

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, delete: true, snapshot: true }),
    });
    // Snapshot failure → errors[], but delete still succeeds → 200
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);

    snapshotCapture.captureSnapshot = origCapture;
  });

  // NS-T06: auto-snapshot on down
  it("auto-snapshots before teardown (auto-pre-down)", async () => {
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("auto-snap-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Auto-snapshot should have been created
    expect(body.snapshotId).toBeTruthy();
    // Verify snapshot kind
    const snap = db.prepare("SELECT kind FROM snapshots WHERE id = ?").get(body.snapshotId) as { kind: string } | undefined;
    expect(snap?.kind).toBe("auto-pre-down");
    db.close();
  });

  // NS-T06: down response includes rig name for handoff
  it("response includes rigName for post-command handoff", async () => {
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("handoff-test");
    const node = rigRepo.addNode(rig.id, "impl");
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });
    const body = await res.json();
    expect(body.rigName).toBe("handoff-test");
    db.close();
  });
});
