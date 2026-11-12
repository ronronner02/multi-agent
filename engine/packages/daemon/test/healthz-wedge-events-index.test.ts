import { initializeDatabase } from "../src/db/baseline.js";
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { deriveOriented } from "../src/domain/startup-proof.js";

/** Prove startup-event reads use bounded indexes and retain their semantics. */

// The two hot queries, VERBATIM from the derive functions (must stay in sync).
const ORIENTED_SQL =
  "SELECT type, payload, seq FROM events WHERE node_id = ? AND type IN ('node.startup_challenged','node.startup_proof_skipped','node.startup_proof_verified','node.startup_proof_rejected') ORDER BY seq DESC";
const RESTORE_SQL =
  "SELECT type, payload, seq FROM events WHERE rig_id = ? AND type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled') ORDER BY seq DESC";

function mkDb(withIndex: boolean): Database.Database {
  const db = new Database(":memory:");
  initializeDatabase(db);
  if (!withIndex) {
    for (const row of db.prepare("PRAGMA index_list(events)").all() as Array<{name: string}>) {
      db.exec(`DROP INDEX "${row.name}"`);
    }
  }
  return db;
}

function insertEvent(
  db: Database.Database,
  ev: { rigId: string | null; nodeId: string | null; type: string; payload: unknown },
): void {
  db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(
    ev.rigId,
    ev.nodeId,
    ev.type,
    JSON.stringify(ev.payload),
  );
}

function planFor(db: Database.Database, sql: string, param: string): string {
  const rows = db.prepare("EXPLAIN QUERY PLAN " + sql).all(param) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(" | ");
}

describe("startup event indexes", () => {
  describe("query plan: full SCAN (the wedge) → bounded indexed SEEK", () => {
    it("WITHOUT the index, deriveOriented's query is a full-table SCAN of events (the wedge)", () => {
      const db = mkDb(false);
      const plan = planFor(db, ORIENTED_SQL, "node-x");
      expect(plan).toMatch(/SCAN events/i);
      expect(plan).not.toMatch(/idx_events_node_type_seq/);
      db.close();
    });

    it("WITH the baseline, deriveOriented's query uses a node index (no full SCAN)", () => {
      const db = mkDb(true);
      const plan = planFor(db, ORIENTED_SQL, "node-x");
      expect(plan).toMatch(/idx_events_(node_type_seq|startup_node_seq)/);
      expect(plan).not.toMatch(/SCAN events/i); // a SEARCH via index, never a full-table SCAN
      db.close();
    });

    it("keeps restore outcome reads bounded by rig", () => {
      const db = mkDb(true);
      const plan = planFor(db, RESTORE_SQL, "rig-x");
      expect(plan).toMatch(/idx_events_restore_rig_seq/); // rig-bounded seek, not a full-table SCAN
      expect(plan).not.toMatch(/SCAN events/i);
      db.close();
    });
  });

  describe("deriveOriented correctness is unchanged (index-only fix) — even buried under many other-node events", () => {
    const RIG = "rig-1";
    const TARGET = "node-target";

    function seedNoise(db: Database.Database, n: number): void {
      // Many newer agent.activity events for OTHER nodes — the rows that made
      // the pre-index reverse scan walk the whole table for a silent target.
      for (let i = 0; i < n; i++) {
        insertEvent(db, { rigId: RIG, nodeId: `other-${i % 7}`, type: "agent.activity", payload: { state: "running" } });
      }
    }

    it("returns 'n-a' when the node was never challenged", () => {
      const db = mkDb(true);
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("n-a");
      db.close();
    });

    it("returns 'missing' when challenged but never proven (buried under 300 newer events)", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("missing");
      db.close();
    });

    it("returns 'verified' for a verified proof of the current challenge (buried)", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_verified", payload: { challengeId: "c1" } });
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("verified");
      db.close();
    });

    it("returns 'rejected' for a rejected proof of the current challenge", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_rejected", payload: { challengeId: "c1" } });
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("rejected");
      db.close();
    });

    it("a later verify overrides an earlier reject for the same challenge", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_rejected", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_verified", payload: { challengeId: "c1" } });
      expect(deriveOriented(db, TARGET)).toBe("verified");
      db.close();
    });

    it("the LATEST challenge governs — a proof for an older challenge does not count", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_verified", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c2" } });
      // c2 is the current challenge and has no proof → missing (the older c1 verify must not leak through).
      expect(deriveOriented(db, TARGET)).toBe("missing");
      db.close();
    });
  });
});
