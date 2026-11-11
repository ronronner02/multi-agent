import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { USAGE_LIMIT_BLOCKER_TAG } from "../src/domain/queue-wake-repository.js";
import { isDue } from "../src/domain/watchdog-due.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";

// S03 R25 RED-FIRST fixture: this is the contract shape migration 073 will ship.
// Keeping the table local in the RED commit lets every behavior fail on its own
// assertion at the old base instead of one missing-module error masking the set.
function createWakeContractTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE queue_transition_wakes (
      transition_id INTEGER PRIMARY KEY,
      qitem_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      wake_kind TEXT NOT NULL,
      wake_ref TEXT NOT NULL,
      delivery_status TEXT
    );
    CREATE INDEX idx_queue_transition_wakes_qitem
      ON queue_transition_wakes(qitem_id, transition_id);
    CREATE INDEX idx_queue_transition_wakes_ref
      ON queue_transition_wakes(wake_ref, phase);
  `);
}

describe("S03 R25 — a park records its wake on the append-only transition", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let jobs: WatchdogJobsRepository;
  let sent: Array<{ session: string; text: string }>;
  let transportResult: Awaited<ReturnType<QueueNudgeTransport["send"]>>;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      outboxEntriesSchema,
      watchdogJobsSchema,
      watchdogHistorySchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
    ]);
    createWakeContractTable(db);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    repo.attachOutbox(new OutboxHandler(db));
    sent = [];
    transportResult = { ok: true, verified: true };
    repo.attachTransport({
      async send(session, text) {
        sent.push({ session, text });
        return transportResult;
      },
    });
    jobs = new WatchdogJobsRepository(db);
  });

  afterEach(() => db.close());

  async function item(destinationSession = "worker@rig") {
    return repo.create({ sourceSession: "orch@rig", destinationSession, body: "work", nudge: false });
  }

  function wakes(qitemId: string): Array<Record<string, unknown>> {
    return db.prepare(
      "SELECT transition_id, qitem_id, phase, wake_kind, wake_ref, delivery_status FROM queue_transition_wakes WHERE qitem_id = ? ORDER BY transition_id",
    ).all(qitemId) as Array<Record<string, unknown>>;
  }

  it("records an existing active watchdog id on the park transition", async () => {
    const row = await item();
    const job = jobs.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: worker@rig\nmessage: resume\n",
      targetSession: "worker@rig",
      intervalSeconds: 60,
      registeredBySession: "orch@rig",
    });

    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:vendor-window",
      transitionNote: "continuation: resume when the vendor window opens",
      wakeWatchdogId: job.jobId,
    } as never);

    expect(wakes(row.qitemId)).toEqual([
      expect.objectContaining({ phase: "armed", wake_kind: "watchdog", wake_ref: job.jobId }),
    ]);
  });

  it("arms a timer atomically and records its generated watchdog id", async () => {
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:cooldown",
      transitionNote: "continuation: retry after cooldown",
      wakeAfterSeconds: 90,
    } as never);

    const wake = wakes(row.qitemId)[0] as { wake_kind: string; wake_ref: string } | undefined;
    expect(wake?.wake_kind).toBe("timer");
    const job = wake ? jobs.getById(wake.wake_ref) : null;
    expect(job).toMatchObject({ state: "active", targetSession: "worker@rig", intervalSeconds: 90 });
    // AMENDED by OPR.0.5.8.1 S1. This test's subject — a park arms a timer
    // ATOMICALLY and records its generated watchdog id — is unchanged and still
    // asserted above. Only these two incidental lines described behaviour that
    // was a defect: an unseeded `last_evaluation_at` made `isDue` true at
    // registration, so a 90s timer (like the measured 20m and 2h ones) fired on
    // the scheduler's first pass. The interval now starts at registration for
    // every explicit `--wake-after`, as it already did for provider-limit parks.
    expect(job?.lastEvaluationAt).toBe(job?.registeredAt);
    const armedAt = Date.parse(job!.registeredAt);
    expect(isDue(job!, armedAt)).toBe(false);              // not due the instant it is armed
    expect(isDue(job!, armedAt + 89_999)).toBe(false);     // nor one tick early
    expect(isDue(job!, armedAt + 90_000)).toBe(true);      // due at the requested 90s
    // Unchanged and deliberately still asserted: this repair does not add an
    // expiry field to ordinary timer parks (no new per-wake bookkeeping).
    expect(repo.getParkWakeStatus(row.qitemId)).not.toHaveProperty("expiresAt");
  });

  it("OPR.0.5.8.1 S1 — two materially different --wake-after durations do NOT converge on one latency", async () => {
    // The SPEC's own contract line. Measured on the base build through the real
    // public seam: a requested 20m fired 0.69s after arming and a requested 2h
    // fired 0.77s — a 6x difference in request collapsing to a shared sub-second
    // latency, because `isDue` treats a job with no `last_evaluation_at` as due.
    // Each duration must now be measured against its own arming instant.
    const short = await item("worker@rig");
    const long = await item("worker@rig");
    await repo.update({
      qitemId: short.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: short", wakeAfterSeconds: 120,
    } as never);
    await repo.update({
      qitemId: long.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: long", wakeAfterSeconds: 7200,
    } as never);

    const shortJob = jobs.getById((wakes(short.qitemId)[0] as { wake_ref: string }).wake_ref)!;
    const longJob = jobs.getById((wakes(long.qitemId)[0] as { wake_ref: string }).wake_ref)!;
    expect(shortJob.intervalSeconds).toBe(120);
    expect(longJob.intervalSeconds).toBe(7200);

    const shortArmed = Date.parse(shortJob.registeredAt);
    const longArmed = Date.parse(longJob.registeredAt);

    // Neither fires on the scheduler's first pass.
    expect(isDue(shortJob, shortArmed + 1_000)).toBe(false);
    expect(isDue(longJob, longArmed + 1_000)).toBe(false);

    // At two minutes the short one is due and the long one is emphatically not:
    // the durations separate instead of converging.
    expect(isDue(shortJob, shortArmed + 120_000)).toBe(true);
    expect(isDue(longJob, longArmed + 120_000)).toBe(false);

    // And the long one comes due only at its own requested time.
    expect(isDue(longJob, longArmed + 7_199_999)).toBe(false);
    expect(isDue(longJob, longArmed + 7_200_000)).toBe(true);
  });

  it("OPR.0.5.8.1 S1b — a park timer is ONE-SHOT: firing ends it, no second wake", async () => {
    // `periodic-reminder` repeats every intervalSeconds forever. An unstopped
    // park timer therefore wakes its owner again at +2 intervals, +3, forever.
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: one-shot", wakeAfterSeconds: 90,
    } as never);
    const ref = (wakes(row.qitemId)[0] as { wake_ref: string }).wake_ref;
    expect(jobs.getById(ref)!.state).toBe("active");

    repo.recordWatchdogWakeAttempt(ref, "verified");

    // Ended by the fire itself, so the scheduler can never pick it up again.
    expect(jobs.getById(ref)!.state).not.toBe("active");
  });

  it("OPR.0.5.8.1 S1b — leaving the park ends the timer: a terminal row cannot be woken", async () => {
    // Specimen: job 01M1E6F3QG41N76Y1CDX48P766 fired at 10:18:07Z for a row that
    // went handed-off at 10:02:03Z — sixteen minutes terminal, and the wake still
    // instructed the seat to resume it. Done must never read as owed.
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: lifetime", wakeAfterSeconds: 7200,
    } as never);
    const ref = (wakes(row.qitemId)[0] as { wake_ref: string }).wake_ref;
    expect(jobs.getById(ref)!.state).toBe("active");

    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "done",
      closureReason: "no-follow-on", transitionNote: "row closed while parked",
    } as never);

    // The timer is gone at the moment the park ended — long before its 2h due
    // time — so no clock advance can produce a wake for a closed row.
    expect(jobs.getById(ref)!.state).not.toBe("active");
    expect(repo.recordWatchdogWakeAttempt(ref, "verified")).toBeUndefined();
    expect(wakes(row.qitemId).some((w) => (w as { phase: string }).phase === "fired")).toBe(false);
  });

});
