// PL-007 Workspace Primitive v0 — queue_items.target_repo round-trip
// tests.
//
// Pins:
//   - create with targetRepo persists + roundtrips through getById
//   - list filters by targetRepo
//   - handoff inherits source's targetRepo when not overridden
//   - handoff-and-complete inherits source's targetRepo when not
//     overridden; explicit override wins
//   - target_repo column present in the baseline

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";

let db: Database.Database;
let repo: QueueRepository;

beforeEach(() => {
  db = createDb();
  initializeDatabase(db);
  repo = new QueueRepository(db, new EventBus(db));
  // W1 MF2: a nudge-intended terminal handoff requires an attached wake-intent store.
  repo.attachOutbox(new OutboxHandler(db));
});

describe("queue target_repo (PL-007)", () => {
  it("baseline includes target_repo column", () => {
    const cols = db.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "target_repo")).toBe(true);
  });

  it("create persists target_repo and getById roundtrips it", async () => {
    const created = await repo.create({
      sourceSession: "alice@rigA",
      destinationSession: "bob@rigA",
      body: "test",
      targetRepo: "multi-agent",
    });
    expect(created.targetRepo).toBe("multi-agent");
    const fetched = repo.getById(created.qitemId);
    expect(fetched?.targetRepo).toBe("multi-agent");
  });

  it("create without targetRepo persists null", async () => {
    const created = await repo.create({
      sourceSession: "alice@rigA",
      destinationSession: "bob@rigA",
      body: "test",
    });
    expect(created.targetRepo).toBeNull();
  });

  it("list filters by targetRepo", async () => {
    await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", targetRepo: "multi-agent" });
    await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "y", targetRepo: "internal" });
    await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "z" });
    const filtered = repo.list({ targetRepo: "multi-agent" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.targetRepo).toBe("multi-agent");
  });

  it("handoff inherits source's targetRepo when not overridden", async () => {
    const src = await repo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "multi-agent",
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@r",
      toSession: "c@r",
    });
    expect(result.created.targetRepo).toBe("multi-agent");
  });

  it("handoff explicit targetRepo overrides source", async () => {
    const src = await repo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "multi-agent",
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@r",
      toSession: "c@r",
      targetRepo: "internal",
    });
    expect(result.created.targetRepo).toBe("internal");
  });

  it("handoffAndComplete inherits source's targetRepo when not overridden", async () => {
    const src = await repo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "multi-agent",
    });
    const result = await repo.handoffAndComplete({
      qitemId: src.qitemId,
      fromSession: "b@r",
      toSession: "c@r",
    });
    expect(result.created.targetRepo).toBe("multi-agent");
    expect(result.closed.state).toBe("done");
  });
});
