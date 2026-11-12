// 51-06 atom D2 — non-persistable queue update metadata (summary/evidence_ref) must HARD-REJECT
// BEFORE any mutation, per the Guard-bound design (no post-commit marker; reject-before-write).
// Migration-faithful: the canonical queue set PLUS 044 (summary) + 048 (evidence_ref) so a drop is
// provably the non-park rule, NOT a missing column (the test-suite parity gap this atom flags).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";

const REJECT_CODE = "summary_evidence_not_persistable";

describe("51-06 D2 — non-park queue update metadata reject", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    initializeDatabase(db);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
  });
  afterEach(() => db.close());

  const mkItem = async () => (await repo.create({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "d2 item" })).qitemId;
  const txnCount = (id: string) => (db.prepare("SELECT count(*) c FROM queue_transitions WHERE qitem_id = ?").get(id) as { c: number }).c;
  const eventCount = () => (db.prepare("SELECT count(*) c FROM events").get() as { c: number }).c;

  async function expectRejectZeroMutation(input: Record<string, unknown>, invalidFields: string[]) {
    const id = await mkItem();
    const beforeState = repo.getByIdOrThrow(id).state;
    const beforeTxns = txnCount(id);
    const beforeEvents = eventCount();
    let err: unknown;
    try { repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", ...input }); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe(REJECT_CODE);
    expect((err as QueueRepositoryError).meta?.invalidFields).toEqual(invalidFields);
    // zero mutation: no UPDATE (state), no log (transition), no event
    expect(repo.getByIdOrThrow(id).state).toBe(beforeState);
    expect(txnCount(id)).toBe(beforeTxns);
    expect(eventCount()).toBe(beforeEvents);
  }

  it("rejects --summary on a non-park transition, before any mutation", async () => {
    await expectRejectZeroMutation({ summary: "DROPME" }, ["summary"]);
  });
  it("rejects --evidence-ref on a non-park transition, before any mutation", async () => {
    await expectRejectZeroMutation({ evidenceRef: "/proof/x.md" }, ["evidenceRef"]);
  });
  it("rejects BOTH, naming both invalidFields, before any mutation", async () => {
    await expectRejectZeroMutation({ summary: "S", evidenceRef: "/e" }, ["summary", "evidenceRef"]);
  });
  it("treats empty-string as PRESENT (null=absent, ''=present) -> rejects", async () => {
    await expectRejectZeroMutation({ summary: "" }, ["summary"]);
  });

  it("also rejects on a terminal non-park transition (in-progress -> done + closure)", async () => {
    const id = await mkItem();
    repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress" }); // claim (metadata-free, ok)
    let err: unknown;
    try { repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "done", closureReason: "no-follow-on", summary: "S" }); }
    catch (e) { err = e; }
    expect((err as QueueRepositoryError).code).toBe(REJECT_CODE);
    expect(repo.getByIdOrThrow(id).state).toBe("in-progress"); // unchanged by the rejected close
  });

  it("metadata-free non-park update is UNCHANGED (null=absent, no reject)", async () => {
    const id = await mkItem();
    const res = repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", summary: null, evidenceRef: null });
    expect(res.state).toBe("in-progress");
  });

  it("CONTROL: human-seat park still PERSISTS summary + evidence byte-for-byte", async () => {
    const id = await mkItem();
    const res = repo.update({ qitemId: id, actorSession: "orch@rig", state: "blocked", blockedOn: "human@kernel", summary: "PARK-KEEP", evidenceRef: "/proof/park.md" });
    expect(res.summary).toBe("PARK-KEEP");
    expect(res.evidenceRef).toBe("/proof/park.md");
  });

});
