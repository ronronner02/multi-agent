// A row a human closed by a direct Slack reply read deliveryOutcome=never-posted although its
// ALERT was posted. The close writes a human-decision-resolved owner notification; the Slack outbound lists ACTIVE rows
// only, so that notice is never posted, yet the ledger took it as the current episode and, finding no receipt for it,
// reported never-posted after the post window.
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { HumanFragment } from "../src/domain/queue-routing/human-registry.js";

const FOUNDER = { entityId: "human-founder", class: "human", displayName: "F", address: "human-founder@external",
  connectorBindings: [{ connector: "slack", ref: "U0F", primary: true }], prefs: {} } as unknown as HumanFragment;

describe("delivery outcome: a resolved notice on a closed row opens no delivery episode", () => {
  let db: ReturnType<typeof createDb>, repo: QueueRepository;
  beforeEach(() => {
    db = createDb();
    initializeDatabase(db);
    repo = new QueueRepository(db, new EventBus(db), { transport: { send: async () => ({ ok: true, verified: true }) },
      loadHumanRegistry: () => ({ ok: true as const, entities: [FOUNDER] }) });
    repo.attachOutbox(new OutboxHandler(db));
  });
  const age = () => db.prepare("UPDATE queue_transitions SET ts = datetime('now', '-1 hour')").run();
  const latestKey = (id: string) => `${id}:${repo.transitionLog.latestOwnerNotificationForQitem(id)!.transitionId}`;
  async function askHuman() {
    const item = await repo.create({ sourceSession: "lead@rig", destinationSession: "human-founder@external", body: "decide?",
      summary: "decision", priority: "routine" as never, humanIntent: "decision" as never } as never);
    const id = (item as unknown as { qitemId: string }).qitemId;
    expect(repo.transitionLog.latestOwnerNotificationForQitem(id)?.ownerNotificationKind).toBe("human-required");
    return id;
  }
  const posted = (id: string, key: string) => repo.update({ qitemId: id, actorSession: "daemon@kernel",
    transitionNote: `slack-owner-notification-posted notification_key=${key} level=ALERT message_ts=1.2` });
  const directReplyClose = (id: string) => repo.update({ qitemId: id, actorSession: "human-founder@external", state: "done",
    closureReason: "no-follow-on", transitionNote: "direct human reply received", ownerNotificationKind: "human-decision-resolved" } as never);

  it("the reported case: ALERT posted, then the human's direct reply closes the row -> posted (not never-posted)", async () => {
    const id = await askHuman();
    posted(id, latestKey(id));
    directReplyClose(id);
    age();
    expect(repo.transitionLog.latestOwnerNotificationForQitem(id)?.ownerNotificationKind).toBe("human-decision-resolved");
    expect(repo.deliveryOutcomeFor(id)?.outcome).toBe("posted");
  });

  it("an ALERT that was never posted still reads never-posted after the human closes the row", async () => {
    const id = await askHuman();
    directReplyClose(id);
    age();
    expect(repo.deliveryOutcomeFor(id)?.outcome).toBe("never-posted");
  });

  it("unchanged while the row is active: a resolved notice on an active row is its own episode (posted when delivered)", async () => {
    const id = await askHuman();
    posted(id, latestKey(id));
    repo.update({ qitemId: id, actorSession: "human-founder@external", state: "in-progress", transitionNote: "resolved",
      ownerNotificationKind: "human-decision-resolved" } as never);
    age();
    expect(repo.deliveryOutcomeFor(id)?.outcome, "no receipt yet for the active resolved notice").toBe("never-posted");
    posted(id, latestKey(id));
    expect(repo.deliveryOutcomeFor(id)?.outcome).toBe("posted");
  });

  it("notice posted while active, then the agent closes the row: the notice keeps its outcome (posted / transport-failed)", async () => {
    for (const receipt of ["posted", "transport-failed"] as const) {
      const id = await askHuman();
      posted(id, latestKey(id));
      repo.update({ qitemId: id, actorSession: "human-founder@external", state: "in-progress", transitionNote: "resolved",
        ownerNotificationKind: "human-decision-resolved" } as never);
      const resolvedKey = latestKey(id);
      repo.update({ qitemId: id, actorSession: "daemon@kernel",
        transitionNote: `slack-owner-notification-${receipt} notification_key=${resolvedKey} level=NOTICE${receipt === "posted" ? " message_ts=1.3" : " detail=http-500"}` });
      repo.update({ qitemId: id, actorSession: "lead@rig", state: "done", closureReason: "no-follow-on", transitionNote: "agent closed" } as never);
      age();
      expect(latestKey(id), "the resolved notice is still the latest owner notification").toBe(resolvedKey);
      expect(repo.deliveryOutcomeFor(id)?.outcome, receipt).toBe(receipt);
    }
  });

  it("an agent's row parked on the human: ALERT posted, then the human's reply closes it -> posted, to that human", async () => {
    const item = await repo.create({ sourceSession: "lead@rig", destinationSession: "dev@rig", body: "build it",
      summary: "work", priority: "routine" as never } as never);
    const id = (item as unknown as { qitemId: string }).qitemId;
    repo.update({ qitemId: id, actorSession: "dev@rig", state: "blocked", blockedOn: "human-founder@external",
      transitionNote: "needs the owner" } as never);
    expect(repo.transitionLog.latestOwnerNotificationForQitem(id)?.ownerNotificationKind).toBe("human-required");
    posted(id, latestKey(id));
    directReplyClose(id);
    age();
    expect(repo.deliveryOutcomeFor(id)?.outcome).toBe("posted");
  });
});
