import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-11T00:00:00.000Z";
const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function database() {
  const db = createDb();
  databases.push(db);
  initializeDatabase(db);
  return db;
}
function seed(db: ReturnType<typeof createDb>, id: string, state = "done", parent: string | null = null) {
  db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session,
    destination_session, state, priority, body, handed_off_from)
    VALUES (?, ?, ?, 'sender@rig-a', 'owner@rig-a', ?, 'routine', 'archive test', ?)`).run(id, OLD, OLD, state, parent);
  const log = new QueueTransitionLog(db);
  for (const identityProvenance of ["transport:v1", "claimed:v1", null]) {
    log.append({ qitemId: id, state, actorSession: "owner@rig-a", identityProvenance,
      transitionNote: "slack-owner-notification-posted notification_key=fixture:key",
      closureReason: state === "done" ? "no-follow-on" : undefined,
      ownerNotificationKind: "human-decision-resolved", ownerNotificationLevel: "NOTICE" });
  }
  db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(OLD, id);
  return log;
}

describe("archived audit identity — baseline, writer and history readers", () => {

  it("retains complete transition values through archival, public history and bounded readers", async () => {
    const db = database();
    const log = seed(db, "archived");
    seed(db, "child", "handed-off", "archived");
    const repo = new QueueRepository(db, new EventBus(db));
    const before = repo.listTransitions("archived");
    const actorBefore = log.listForActor("owner@rig-a");
    const recentBefore = log.listRecent({ kind: "rig", rig: "rig-a" });
    const familyBefore = log.listForHandoffWindow("archived", OLD, NOW, 100);
    expect(before.map((t) => t.identityProvenance)).toEqual(["transport:v1", "claimed:v1", null]);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW })).toEqual({ archivedQitems: 2, archivedRows: 6 });
    expect(repo.listTransitions("archived")).toEqual(before);
    expect(log.listForActor("owner@rig-a")).toEqual(actorBefore);
    expect(log.listRecent({ kind: "rig", rig: "rig-a" })).toEqual(recentBefore);
    expect(log.listForQitemWindow("archived", OLD, NOW, 2)).toEqual(before.slice(0, 2));
    expect(log.listForHandoffWindow("archived", OLD, NOW, 100)).toEqual(familyBefore);
    expect(log.latestOwnerNotificationForQitem("archived")).toEqual(before.at(-1));
    expect(log.hasOwnerNotificationReceipt("archived", "fixture:key")).toBe(true);
    expect(log.hasOwnerNotificationReceipt("archived", "different:key")).toBe(false);
    // A newer live row and an archived row must share one ordering/limit.
    const newer = log.append({ qitemId: "archived", state: "done", actorSession: "owner@rig-a", identityProvenance: "transport:v1" });
    expect(log.listForQitem("archived")).toEqual([...before, newer]);
    expect(log.listForActor("owner@rig-a", 1)).toEqual([newer]);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW }).archivedRows).toBe(0);
  });

  it("keeps nonterminal, recent and live-frontier history; normal retention resumes after frontier closure", () => {
    const db = database();
    seed(db, "active", "in-progress");
    seed(db, "recent");
    seed(db, "frontier");
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = 'recent'").run(NOW);
    db.prepare(`INSERT INTO workflow_instances (instance_id, workflow_name, status, current_frontier_json, workflow_version, created_by_session, created_at)
      VALUES ('wi', 'fixture', 'waiting', '["frontier"]', '1', 'owner@rig-a', ?)`).run(OLD);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW }).archivedRows).toBe(0);
    db.prepare("UPDATE workflow_instances SET status='completed', current_frontier_json='[]'").run();
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW })).toEqual({ archivedQitems: 1, archivedRows: 3 });
    expect(new QueueTransitionLog(db).listForQitem("frontier").map((t) => t.identityProvenance))
      .toEqual(["transport:v1", "claimed:v1", null]);
    expect((db.prepare("SELECT COUNT(*) n FROM queue_transitions").get() as { n: number }).n).toBe(6);
  });

  it("rolls back the archive insert when deletion fails inside the same transaction", () => {
    const db = database();
    seed(db, "rollback");
    const before = db.prepare("SELECT * FROM queue_transitions").all();
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON queue_transitions BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END");
    expect(() => archiveAgedTerminalTransitions(db, { nowIso: NOW })).toThrow("fixture delete failure");
    expect(db.prepare("SELECT * FROM queue_transitions").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM queue_transitions_archive").all()).toEqual([]);
  });
});
