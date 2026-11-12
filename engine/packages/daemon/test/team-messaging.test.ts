import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import {
  MailboxDelivery,
  MailboxDeliveryError,
  createMailboxPromptStateReader,
  type MailboxPromptState,
} from "../src/domain/mailbox-delivery.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { ChatRepository } from "../src/domain/chat-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatMailboxCapabilities } from "../src/domain/seat-mailbox-capability.js";

/** A well-formed test capability: `mailbox:` plus 32 bytes in base64url. */
function cap(label: string): string {
  return `mailbox:${Buffer.from(label.padEnd(32, "-").slice(0, 32)).toString("base64url")}`;
}

function createTestDb(): Database.Database {
  const db = createDb();
  initializeDatabase(db);
  return db;
}

describe("addressed mailbox delivery", () => {
  let db: Database.Database;
  let rigId: string;
  let chatRepo: ChatRepository;
  let eventBus: EventBus;
  let mailbox: MailboxDelivery;
  let promptState: MailboxPromptState;

  beforeEach(() => {
    db = createTestDb();
    rigId = new RigRepository(db).createRig("messaging-rig").id;
    chatRepo = new ChatRepository(db);
    eventBus = new EventBus(db);
    promptState = "clear";
    mailbox = new MailboxDelivery(chatRepo, () => promptState);
  });

  afterEach(() => db.close());

  it("persists addressed identity and inert message data in the existing chat owner", () => {
    const body = "approve this?\n\u001b[31mpeer text\u001b[0m";
    const message = mailbox.send({
      rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009", runId: "run-1", body,
      messageId: "mail-1", replyTo: "mail-0", attachment: [{ artifactId: "artifact-1", hash: "hash-1", taskId: "T009", runId: "run-1" }], capability: cap("1"),
    });
    expect(message).toMatchObject({ id: "mail-1", messageId: "mail-1", projectId: rigId, rigId,
      sender: "lead@team", recipient: "worker@team", taskId: "T009", runId: "run-1", replyTo: "mail-0",
      attachment: [{ artifactId: "artifact-1", hash: "hash-1", taskId: "T009", runId: "run-1" }], capability: cap("1"), receipt: null, body });
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(1);
  });

  it("deduplicates retries by message id and rejects a reused id with different identity", () => {
    const input = { rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009", runId: "run-1", body: "same delivery", messageId: "mail-1", capability: cap("1") };
    const first = mailbox.send(input);
    expect(mailbox.send(input).id).toBe(first.id);
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(1);
    expect(() => mailbox.send({ ...input, recipient: "other@team" })).toThrowError(expect.objectContaining({ code: "mailbox_id_conflict" }));
  });

  it("deduplicates a stable message id when the optional capability is omitted on retry", () => {
    const input = { rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009", runId: "run-1", body: "retry without capability", messageId: "mail-without-capability" };
    const first = mailbox.send(input);
    expect(mailbox.send(input).id).toBe(first.id);
    expect(first.capability).toMatch(/^mailbox:[A-Za-z0-9_-]{43}$/);
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(1);
  });

  it("keeps prompt-active messages pending, then redelivers them on reconnect and queued waits", () => {
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("1") };
    mailbox.send({ ...scope, sender: "lead@team", body: "yes\n\u001b[2J", messageId: "mail-1" });
    promptState = "blocked";
    expect(mailbox.poll({ ...scope, state: "ready" })).toMatchObject({ status: "prompt-active", promptState: "blocked", pendingCount: 1, messages: [] });
    expect(() => mailbox.consume({ ...scope, messageId: "mail-1", consumedBy: "worker@team", state: "ready" })).toThrowError(expect.objectContaining({ code: "mailbox_not_admitted" }));
    promptState = "clear";
    expect(mailbox.poll({ ...scope, state: "reconnect" }).messages[0]!.body).toBe("yes\n\u001b[2J");
    expect(mailbox.poll({ ...scope, state: "queued-wait" }).sessionState).toBe("queued-wait");
  });

  it("admits consumption only from the daemon's own prompt observation", () => {
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("24") };
    mailbox.send({ ...scope, sender: "lead@team", body: "approve\n", messageId: "mail-24" });
    promptState = "unknown";
    expect(() => mailbox.consume({ ...scope, messageId: "mail-24", consumedBy: "worker@team", state: "ready" })).toThrowError(expect.objectContaining({ code: "mailbox_not_admitted" }));
    expect(mailbox.poll(scope)).toMatchObject({ status: "prompt-active", promptState: "unknown", pendingCount: 1 });
    promptState = "blocked";
    expect(mailbox.poll({ ...scope, state: "ready" }).messages).toEqual([]);
    promptState = "clear";
    const consumed = mailbox.consume({ ...scope, messageId: "mail-24", consumedBy: "worker@team" });
    expect(consumed.receipt.receiptId).toBeTruthy();
    expect(mailbox.poll(scope).pendingCount).toBe(0);
  });

  it("fails closed after a daemon restart and when no prompt-state reader is wired", () => {
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("restart") };
    mailbox.send({ ...scope, sender: "lead@team", body: "after restart", messageId: "mail-restart" });
    expect(mailbox.poll({ ...scope, state: "ready" }).messages).toHaveLength(1);
    let restartedState: MailboxPromptState = "unknown";
    const restarted = new MailboxDelivery(chatRepo, () => restartedState);
    expect(() => restarted.consume({ ...scope, messageId: "mail-restart", consumedBy: "worker@team", state: "ready" })).toThrowError(expect.objectContaining({ code: "mailbox_not_admitted" }));
    expect(restarted.poll(scope)).toMatchObject({ status: "prompt-active", promptState: "unknown", pendingCount: 1 });
    const unwired = new MailboxDelivery(chatRepo);
    expect(unwired.poll(scope)).toMatchObject({ status: "prompt-active", promptState: "unknown", messages: [] });
    restartedState = "clear";
    expect(restarted.consume({ ...scope, messageId: "mail-restart", consumedBy: "worker@team" }).receipt.receiptId).toBeTruthy();
  });

  it("uses one idempotent consumption receipt and allows safe later polling", () => {
    const message = mailbox.send({ rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009", runId: "run-1", body: "data only", messageId: "mail-1", capability: cap("1") });
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("1") };
    const first = mailbox.consume({ ...scope, messageId: message.id, consumedBy: "worker@team", state: "ready" });
    const second = mailbox.consume({ ...scope, messageId: message.id, consumedBy: "worker@team", state: "queued-wait" });
    expect(second.receipt).toEqual(first.receipt);
    expect(first.message).not.toHaveProperty("capability");
    expect(mailbox.poll({ ...scope, state: "ready" }).messages).toEqual([]);
  });

  it("keeps pending mailbox rows and consumption receipts when generic chat is cleared", () => {
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("clear") };
    const pending = mailbox.send({ ...scope, sender: "lead@team", body: "pending after clear", messageId: "mail-clear-pending" });
    const consumed = mailbox.send({ ...scope, sender: "lead@team", body: "consumed before clear", messageId: "mail-clear-consumed" });
    const firstReceipt = mailbox.consume({ ...scope, messageId: consumed.id, consumedBy: "worker@team", state: "ready" });
    chatRepo.send(rigId, "lead@team", "public chat");
    expect(chatRepo.clear(rigId).deleted).toBe(1);
    expect(chatRepo.history(rigId)).toEqual([]);
    expect(mailbox.poll({ ...scope, state: "ready" }).messages).toEqual([expect.objectContaining({ id: pending.id, body: "pending after clear" })]);
    expect(mailbox.consume({ ...scope, messageId: consumed.id, consumedBy: "worker@team", state: "queued-wait" }).receipt).toEqual(firstReceipt.receipt);
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(2);
  });

  it("keeps capabilities and attachments task-scoped", () => {
    expect(() => mailbox.send({ rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009", runId: "run-1", body: "cross-task attachment", attachment: [{ artifactId: "artifact-2", hash: "hash-2", taskId: "T010", runId: "run-1" }], capability: cap("1") })).toThrowError(expect.objectContaining({ code: "attachment_scope_mismatch" }));
    mailbox.send({ rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009", runId: "run-1", body: "scoped", messageId: "mail-1", capability: cap("1") });
    expect(mailbox.poll({ rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: "other-capability" }).messages).toEqual([]);
    expect(() => mailbox.consume({ rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: "other-capability", messageId: "mail-1", consumedBy: "worker@team", state: "ready" })).toThrowError(expect.objectContaining({ code: "mailbox_scope_mismatch" }));
  });

  it.each([undefined, null, [], [{ taskId: "T009", runId: "run-1", artifactId: "artifact-1", hash: "hash-1" }, { taskId: "T009", runId: "run-1", artifactId: "artifact-2", hash: "hash-2" }]])("persists only exact scoped artifact references (attachment: %j)", attachment => {
    const sent = mailbox.send({ rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009", runId: "run-1", body: "artifact data", attachment, capability: cap("artifact") });
    const polled = mailbox.poll({ rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("artifact") });
    expect(sent.attachment).toEqual(attachment ?? null);
    expect(polled.messages[0]!.attachment).toEqual(attachment ?? null);
  });

  const artifact = { taskId: "T009", runId: "run-1", artifactId: "artifact-1", hash: "hash-1" };
  it.each([["plain object", artifact, "invalid_mailbox_input"], ["string", "artifact-1", "invalid_mailbox_input"], ["boolean", false, "invalid_mailbox_input"], ["number", 0, "invalid_mailbox_input"], ["string array", ["artifact-1"], "invalid_mailbox_input"], ["null entry", [null], "invalid_mailbox_input"], ["nested array", [[artifact]], "invalid_mailbox_input"], ["missing field", [{ taskId: "T009", runId: "run-1", artifactId: "artifact-1" }], "invalid_mailbox_input"], ["non-string field", [{ ...artifact, hash: 1 }], "invalid_mailbox_input"], ["extra field", [{ ...artifact, extra: "value" }], "invalid_mailbox_input"], ["nested field", [{ ...artifact, hash: { value: "hash-1" } }], "invalid_mailbox_input"], ["extra nested keys", [{ ...artifact, metadata: { taskId: "T009" } }], "invalid_mailbox_input"], ["mixed entries", [artifact, "artifact-2"], "invalid_mailbox_input"], ["foreign task", [{ ...artifact, taskId: "T010" }], "attachment_scope_mismatch"], ["foreign run", [{ ...artifact, runId: "run-2" }], "attachment_scope_mismatch"], ["mixed scopes", [artifact, { ...artifact, taskId: "T010" }], "attachment_scope_mismatch"]] as const)("rejects %s attachments before any persistence", async (_name, attachment, code) => {
    const input = { recipient: "worker@team", taskId: "T009", runId: "run-1", body: "invalid attachment", attachment, capability: cap("invalid") };
    expect(() => chatRepo.sendMailbox(rigId, "lead@team", input)).toThrowError(expect.objectContaining({ code }));
    expect(() => mailbox.send({ rigId, sender: "lead@team", ...input })).toThrowError(expect.objectContaining({ code }));
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(0);
  });

  it("tells a foreign or weak capability nothing about the recipient seat", () => {
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1" };
    mailbox.send({ ...scope, sender: "lead@team", body: "secret", messageId: "mail-foreign", capability: cap("owner") });
    promptState = "blocked";
    expect(mailbox.poll({ ...scope, capability: cap("foreign") })).toMatchObject({ promptState: "unknown", pendingCount: 0, messages: [] });
    expect(() => mailbox.consume({ ...scope, capability: cap("foreign"), messageId: "mail-foreign", consumedBy: "worker@team" })).toThrowError(expect.objectContaining({ code: "mailbox_scope_mismatch" }));
    expect(() => mailbox.send({ ...scope, sender: "lead@team", body: "weak", messageId: "mail-weak", capability: "x" })).toThrowError(expect.objectContaining({ code: "invalid_mailbox_input" }));
    expect(() => mailbox.poll({ ...scope, capability: cap("owner"), state: "bogus" as never })).toThrowError(expect.objectContaining({ code: "invalid_mailbox_state" }));
  });

  it("mints one capability per seat, and a managed send reuses the seat's value", () => {
    // The tmux removal deleted the minting owner and left the composition returning "". The
    // producer then refused every managed attempt with `Invalid mailbox capability`, so no seat
    // could launch at all. Two properties make this the right owner: one value per (run, seat),
    // and a send that names none stores under the value the seat's own poll will match.
    const capabilities = new SeatMailboxCapabilities(db);
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
      VALUES ('run-cap', ?, '{}', 'digest', 'approved', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z')`).run(rigId);
    const first = capabilities.forSeat("run-cap", "worker@team");
    expect(first).toMatch(/^mailbox:[A-Za-z0-9_-]{43}$/);
    expect(capabilities.forSeat("run-cap", "worker@team")).toBe(first);
    expect(capabilities.find("run-cap", "worker@team")).toBe(first);
    // A seat with no record is null rather than a fresh value: a send must never mint.
    expect(capabilities.find("run-cap", "other@team")).toBeNull();
    // The managed send stores under the recorded value, so the seat's poll finds it.
    const managed = new MailboxDelivery(chatRepo, () => "ready", () => null,
      (runId, sessionId) => capabilities.find(runId, sessionId));
    managed.send({ rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009", runId: "run-cap", body: "managed" });
    expect(managed.poll({ rigId, recipient: "worker@team", taskId: "T009", runId: "run-cap", capability: first }).pendingCount).toBe(1);
  });

  it("rejects a missing capability and never turns peer data into approval", () => {
    expect(() => mailbox.poll({ rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: "" })).toThrowError(MailboxDeliveryError);
  });
});
