import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

describe("RigRepository", () => {
  let db: Database.Database;
  let repo: RigRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new RigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("createRig persists and returns typed Rig with id", () => {
    const rig = repo.createRig("test-rig");
    expect(rig.id).toBeDefined();
    expect(typeof rig.id).toBe("string");
    expect(rig.id.length).toBeGreaterThan(0);
    expect(rig.name).toBe("test-rig");
    expect(rig.createdAt).toBeDefined();
  });

  it("addNode persists with rig FK, returns typed Node", () => {
    const rig = repo.createRig("test-rig");
    const node = repo.addNode(rig.id, "orchestrator", {
      role: "orchestrator",
      runtime: "claude-code",
      model: "opus",
    });
    expect(node.id).toBeDefined();
    expect(node.rigId).toBe(rig.id);
    expect(node.logicalId).toBe("orchestrator");
    expect(node.role).toBe("orchestrator");
    expect(node.runtime).toBe("claude-code");
    expect(node.model).toBe("opus");
  });

  it("addNode to nonexistent rig throws", () => {
    expect(() => repo.addNode("nonexistent", "worker")).toThrow();
  });

  it("addNode with duplicate logical_id in same rig throws", () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker");
    expect(() => repo.addNode(rig.id, "worker")).toThrow();
  });

  it("addEdge validates both nodes exist and belong to same rig", () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator");
    const n2 = repo.addNode(rig.id, "worker");
    const edge = repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");
    expect(edge.id).toBeDefined();
    expect(edge.sourceId).toBe(n1.id);
    expect(edge.targetId).toBe(n2.id);
    expect(edge.kind).toBe("delegates_to");
  });

  it("addEdge cross-rig rejected", () => {
    const rig1 = repo.createRig("rig-one");
    const rig2 = repo.createRig("rig-two");
    const n1 = repo.addNode(rig1.id, "worker-a");
    const n2 = repo.addNode(rig2.id, "worker-b");
    expect(() =>
      repo.addEdge(rig1.id, n1.id, n2.id, "delegates_to")
    ).toThrow(/same rig/);
  });

  it("getRig returns full graph with nodes, edges, and bindings", () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(rig.id, "worker", { role: "worker" });
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    // Add a binding to n1 only
    db.prepare(
      "INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)"
    ).run("bind-1", n1.id, "r01-orch1-lead");

    const full = repo.getRig(rig.id);
    expect(full).not.toBeNull();
    expect(full!.rig.name).toBe("test-rig");
    expect(full!.nodes).toHaveLength(2);
    expect(full!.edges).toHaveLength(1);
    expect(full!.edges[0]!.kind).toBe("delegates_to");

    // n1 has a binding
    const orchNode = full!.nodes.find((n) => n.logicalId === "orchestrator");
    expect(orchNode!.binding).not.toBeNull();
    expect(orchNode!.binding!.tmuxSession).toBe("r01-orch1-lead");
  });

  it("getRig: unbound nodes have binding: null (not undefined/omitted)", () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker");

    const full = repo.getRig(rig.id);
    const workerNode = full!.nodes.find((n) => n.logicalId === "worker");
    // Must be explicitly null, not undefined
    expect(workerNode).toHaveProperty("binding");
    expect(workerNode!.binding).toBeNull();
  });

  it("listRigs returns all rigs", () => {
    repo.createRig("rig-a");
    repo.createRig("rig-b");
    repo.createRig("rig-c");
    const rigs = repo.listRigs();
    expect(rigs).toHaveLength(3);
    const names = rigs.map((r) => r.name);
    expect(names).toContain("rig-a");
    expect(names).toContain("rig-b");
    expect(names).toContain("rig-c");
  });

  it("finds an older live project when a later generation was re-archived", () => {
    const live = repo.createRig("same-name");
    const predecessor = repo.createRig("same-name");
    db.prepare("UPDATE rigs SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00Z", live.id);
    db.prepare("UPDATE rigs SET created_at = ? WHERE id = ?").run("2026-01-02T00:00:00Z", predecessor.id);
    for (const rig of [live, predecessor]) {
      repo.setServicesRecord(rig.id, {
        kind: "compose",
        specJson: "{}",
        rigRoot: "/tmp",
        composeFile: "compose.yaml",
        projectName: "shared-project",
      });
    }
    expect(repo.archiveRig(predecessor.id)).toBe(true);

    expect(repo.getLiveServicesSuccessor(predecessor.id, "shared-project")).toEqual({ id: live.id, name: "same-name" });
  });

  it("retains governance history on deletion and permits reversible archive", () => {
    const rig = repo.createRig("governed");
    // Even a partially recoverable ledger must prevent destructive deletion.
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
      VALUES ('retained-run', ?, '{}', 'retained-binding', 'blocked', 'now', 'now')`).run(rig.id);
    expect(() => repo.deleteRig(rig.id)).toThrow(/governance history/);
    expect(repo.getRig(rig.id)).not.toBeNull();
    expect(db.prepare("SELECT id FROM team_runs").all()).toEqual([{ id: "retained-run" }]);
    expect(repo.archiveRig(rig.id)).toBe(true);
    expect(repo.unarchiveRig(rig.id)).toBe(true);
    expect(() => repo.deleteRig(rig.id)).toThrow(/governance history/);
  });

  it("binds deletion and reservation release to the current operation and publishes only after commit", () => {
    const rig = repo.createRig("reserved-deletion");
    const events = new EventBus(db);
    const notifications: Array<{ phase: string; inTransaction: boolean }> = [];
    events.subscribe((event) => {
      if (event.type === "rig.deletion_fence") notifications.push({ phase: event.phase, inTransaction: db.inTransaction });
    });
    const first = repo.reserveRigDeletion(rig.id, "release", events);
    expect(() => repo.reserveRigDeletion(rig.id, "teardown", events)).toThrow(/deletion is in progress/);
    expect(() => repo.deleteRig(rig.id)).toThrow(/deletion is in progress/);
    expect(() => repo.deleteRig(rig.id, "wrong-operation")).toThrow(/deletion is in progress/);
    expect(() => repo.finishRigDeletion(rig.id, "wrong-operation", events)).toThrow(/deletion is in progress/);
    expect(repo.getRig(rig.id)).not.toBeNull();
    repo.finishRigDeletion(rig.id, first, events);
    const second = repo.reserveRigDeletion(rig.id, "teardown", events);
    expect(second).not.toBe(first);
    expect(() => repo.finishRigDeletion(rig.id, first, events)).toThrow(/deletion is in progress/);
    expect(() => repo.deleteRig(rig.id, first)).toThrow(/deletion is in progress/);
    repo.deleteRig(rig.id, second);
    repo.finishRigDeletion(rig.id, second, events);
    expect(repo.getRig(rig.id)).toBeNull();
    expect(notifications).toEqual(["reserved", "released", "reserved", "released"].map((phase) => ({ phase, inTransaction: false })));
  });

  it("retains an unfinished reservation when its release fails to persist", () => {
    const rig = repo.createRig("reservation-release-failure");
    const events = new EventBus(db);
    const reservation = repo.reserveRigDeletion(rig.id, "teardown", events);
    db.exec(`CREATE TRIGGER fail_reservation_release BEFORE INSERT ON events
      WHEN NEW.type = 'rig.deletion_fence' AND json_extract(NEW.payload, '$.phase') = 'released'
      BEGIN SELECT RAISE(ABORT, 'reservation release failed'); END;`);
    expect(() => repo.finishRigDeletion(rig.id, reservation, events)).toThrow(/reservation release failed/);
    expect(() => repo.assertNoPendingDeletion(rig.id)).toThrow(/deletion is in progress/);
    expect(db.prepare("SELECT json_extract(payload, '$.phase') AS phase FROM events WHERE type = 'rig.deletion_fence'").all()).toEqual([{ phase: "reserved" }]);
    db.exec("DROP TRIGGER fail_reservation_release");
    repo.finishRigDeletion(rig.id, reservation, events);
    expect(() => repo.assertNoPendingDeletion(rig.id)).not.toThrow();
  });

  it("rejects an outer transaction before publishing a deletion reservation", () => {
    const rig = repo.createRig("nested-reservation");
    const events = new EventBus(db);
    expect(() => db.transaction(() => repo.reserveRigDeletion(rig.id, "release", events))()).toThrow(/own its notification transaction/);
    expect(db.prepare("SELECT * FROM events WHERE type = 'rig.deletion_fence'").all()).toEqual([]);
  });

  it.each(["malformed-json", "unknown-version", "unknown-phase"])("blocks deletion when the durable reservation has %s", (kind) => {
    const rig = repo.createRig("invalid-reservation");
    const payload = kind === "malformed-json" ? "not-json" : JSON.stringify({
      type: "rig.deletion_fence", version: kind === "unknown-version" ? 2 : 1, rigId: rig.id,
      reservationId: "unresolved", operation: "teardown", phase: kind === "unknown-phase" ? "unknown" : "reserved",
    });
    db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'rig.deletion_fence', ?)").run(rig.id, payload);
    expect(() => repo.assertNoPendingDeletion(rig.id)).toThrow(/deletion is in progress/);
    expect(() => repo.reserveRigDeletion(rig.id, "release", new EventBus(db))).toThrow(/deletion is in progress/);
    expect(() => repo.deleteRig(rig.id)).toThrow(/deletion is in progress/);
    expect(repo.getRig(rig.id)).not.toBeNull();
  });

  it("deleteRig cascades — nodes and edges gone", () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator");
    const n2 = repo.addNode(rig.id, "worker");
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    repo.deleteRig(rig.id);

    expect(repo.getRig(rig.id)).toBeNull();
    expect(repo.listRigs()).toHaveLength(0);
  });

  // -- P3-T00: Extended node fields --

  it("addNode persists extended fields", () => {
    const rig = repo.createRig("test-rig");
    const node = repo.addNode(rig.id, "worker", {
      role: "worker",
      runtime: "claude-code",
      surfaceHint: "tab:workers",
      workspace: "review",
      restorePolicy: "checkpoint_only",
      packageRefs: ["github:example/pkg@v1", "local:./my-pkg"],
    });

    expect(node.surfaceHint).toBe("tab:workers");
    expect(node.workspace).toBe("review");
    expect(node.restorePolicy).toBe("checkpoint_only");
    expect(node.packageRefs).toEqual(["github:example/pkg@v1", "local:./my-pkg"]);
  });

  it("getRig returns nodes with extended fields (parsed packageRefs)", () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker", {
      surfaceHint: "tab:main",
      packageRefs: ["pkg-a", "pkg-b"],
    });

    const full = repo.getRig(rig.id);
    const node = full!.nodes[0]!;
    expect(node.surfaceHint).toBe("tab:main");
    expect(node.packageRefs).toEqual(["pkg-a", "pkg-b"]);
    expect(Array.isArray(node.packageRefs)).toBe(true);
  });

  it("addNode with no extended fields: surfaceHint=null, workspace=null, restorePolicy=null, packageRefs=[]", () => {
    const rig = repo.createRig("test-rig");
    const node = repo.addNode(rig.id, "worker");

    expect(node.surfaceHint).toBeNull();
    expect(node.workspace).toBeNull();
    expect(node.restorePolicy).toBeNull();
    expect(node.packageRefs).toEqual([]);
  });
});

describe("Wiring regression", () => {
  it("createFullTestDb schema includes 007 columns", async () => {
    const { createFullTestDb } = await import("./helpers/test-app.js");
    const db = createFullTestDb();
    const cols = db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("surface_hint");
    expect(names).toContain("workspace");
    expect(names).toContain("restore_policy");
    expect(names).toContain("package_refs");
    db.close();
  });
});
