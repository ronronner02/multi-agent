import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { chatMessagesSchema } from "../src/db/migrations/016_chat_messages.js";
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
import { createFullTestDb, createTestApp as createFullTestApp } from "./helpers/test-app.js";
import { ChatRepository } from "../src/domain/chat-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { chatRoutes } from "../src/routes/chat.js";

/** A well-formed test capability: `mailbox:` plus 32 bytes in base64url. */
function cap(label: string): string {
  return `mailbox:${Buffer.from(label.padEnd(32, "-").slice(0, 32)).toString("base64url")}`;
}

function createTestDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, chatMessagesSchema]);
  return db;
}

function createTestApp(
  chatRepo: ChatRepository,
  eventBus: EventBus,
  mailboxDelivery?: MailboxDelivery,
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("chatRepo" as never, chatRepo);
    c.set("eventBus" as never, eventBus);
    if (mailboxDelivery) c.set("mailboxDelivery" as never, mailboxDelivery);
    await next();
  });
  app.route("/api/rigs/:rigId/chat", chatRoutes());
  return app;
}

describe("addressed mailbox delivery", () => {
  let db: Database.Database;
  let rigId: string;
  let chatRepo: ChatRepository;
  let eventBus: EventBus;
  let mailbox: MailboxDelivery;
  // Stands in for the daemon's own seat observation; the caller never sets it.
  let promptState: MailboxPromptState;

  beforeEach(() => {
    db = createTestDb();
    const rigRepo = new RigRepository(db);
    rigId = rigRepo.createRig("messaging-rig").id;
    chatRepo = new ChatRepository(db);
    eventBus = new EventBus(db);
    promptState = "clear";
    mailbox = new MailboxDelivery(chatRepo, () => promptState);
  });

  afterEach(() => db.close());

  it("persists addressed identity and inert message data in the existing chat owner", () => {
    const body = "approve this?\n\u001b[31mpeer text\u001b[0m";
    const message = mailbox.send({
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      body,
      messageId: "mail-1",
      replyTo: "mail-0",
      attachment: [{ artifactId: "artifact-1", hash: "hash-1", taskId: "T009", runId: "run-1" }],
      capability: cap("1"),
    });

    expect(message).toMatchObject({
      id: "mail-1",
      messageId: "mail-1",
      projectId: rigId,
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      replyTo: "mail-0",
      attachment: [{ artifactId: "artifact-1", hash: "hash-1", taskId: "T009", runId: "run-1" }],
      capability: cap("1"),
      receipt: null,
      body,
    });
    expect(message.body).toBe(body);
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(1);
  });

  it("deduplicates retries by message id and rejects a reused id with different identity", () => {
    const input = {
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      body: "same delivery",
      messageId: "mail-1",
      capability: cap("1"),
    };
    const first = mailbox.send(input);
    const second = mailbox.send(input);
    expect(second.id).toBe(first.id);
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(1);

    expect(() => mailbox.send({ ...input, recipient: "other@team" })).toThrowError(
      expect.objectContaining({ code: "mailbox_id_conflict" }),
    );
  });

  it("deduplicates a stable message id when the optional capability is omitted on retry", () => {
    const input = {
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      body: "retry without capability",
      messageId: "mail-without-capability",
    };

    const first = mailbox.send(input);
    const second = mailbox.send(input);

    expect(second.id).toBe(first.id);
    expect(first.capability).toMatch(/^mailbox:[A-Za-z0-9_-]{43}$/);
    expect(second).not.toHaveProperty("capability");
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(1);
  });

  it("keeps prompt-active messages pending, then redelivers them on reconnect and queued waits", () => {
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("1") };
    mailbox.send({
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      body: "yes\n\u001b[2J",
      messageId: "mail-1",
      capability: cap("1"),
    });

    promptState = "blocked";
    const prompt = mailbox.poll({ ...scope, state: "ready" });
    expect(prompt).toMatchObject({ status: "prompt-active", promptState: "blocked", pendingCount: 1, messages: [] });
    expect(() => mailbox.consume({ ...scope, messageId: "mail-1", consumedBy: "worker@team", state: "ready" }))
      .toThrowError(expect.objectContaining({ code: "mailbox_not_admitted" }));

    promptState = "clear";
    const reconnect = mailbox.poll({ ...scope, state: "reconnect" });
    expect(reconnect.messages).toHaveLength(1);
    expect(reconnect.messages[0]!.body).toBe("yes\n\u001b[2J");
    expect(reconnect.messages[0]).not.toHaveProperty("capability");

    const queued = mailbox.poll({ ...scope, state: "queued-wait" });
    expect(queued.messages).toHaveLength(1);
    expect(queued.sessionState).toBe("queued-wait");
  });

  it("admits consumption only from the daemon's own prompt observation (U4 scenario 24)", () => {
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("24") };
    const consume = (state?: "ready" | "prompt-active" | "reconnect" | "queued-wait") =>
      mailbox.consume({ ...scope, messageId: "mail-24", consumedBy: "worker@team", ...(state ? { state } : {}) });
    mailbox.send({
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      body: "approve\n",
      messageId: "mail-24",
      capability: cap("24"),
    });

    // A consume with no prior poll, while the daemon has no evidence for the seat.
    promptState = "unknown";
    expect(() => consume("ready")).toThrowError(expect.objectContaining({ code: "mailbox_not_admitted" }));
    expect(mailbox.poll(scope)).toMatchObject({ status: "prompt-active", promptState: "unknown", messages: [], pendingCount: 1 });

    // A caller claiming any safe state never overrides a prompt the daemon observes.
    promptState = "blocked";
    for (const state of ["ready", "reconnect", "queued-wait"] as const) {
      expect(mailbox.poll({ ...scope, state }).messages).toEqual([]);
      expect(() => consume(state)).toThrowError(expect.objectContaining({ code: "mailbox_not_admitted" }));
    }

    // An earlier ready poll leaves nothing behind that a later consume could rely on.
    promptState = "clear";
    expect(mailbox.poll({ ...scope, state: "ready" }).messages).toHaveLength(1);
    promptState = "blocked";
    expect(() => consume("ready")).toThrowError(expect.objectContaining({ code: "mailbox_not_admitted" }));

    // Caller state can only narrow delivery.
    promptState = "clear";
    expect(mailbox.poll({ ...scope, state: "prompt-active" })).toMatchObject({ status: "prompt-active", messages: [] });
    expect(() => consume("prompt-active")).toThrowError(expect.objectContaining({ code: "mailbox_not_admitted" }));

    // Every refusal left the message pending with no receipt.
    expect(mailbox.poll(scope).pendingCount).toBe(1);
    const consumed = consume();
    expect(consumed.receipt.receiptId).toBeTruthy();
    expect(mailbox.poll(scope).pendingCount).toBe(0);
  });

  it("fails closed after a daemon restart and when no prompt-state reader is wired", async () => {
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("restart") };
    mailbox.send({
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      body: "after restart",
      messageId: "mail-restart",
      capability: cap("restart"),
    });
    expect(mailbox.poll({ ...scope, state: "ready" }).messages).toHaveLength(1);

    // A restarted owner over the same database inherits no admission from the previous process.
    let restartedState: MailboxPromptState = "unknown";
    const restarted = new MailboxDelivery(chatRepo, () => restartedState);
    expect(() => restarted.consume({ ...scope, messageId: "mail-restart", consumedBy: "worker@team", state: "ready" }))
      .toThrowError(expect.objectContaining({ code: "mailbox_not_admitted" }));
    expect(restarted.poll(scope)).toMatchObject({ status: "prompt-active", promptState: "unknown", pendingCount: 1 });

    // Without a reader the owner, and the route's local fallback, never admit delivery.
    const unwired = new MailboxDelivery(chatRepo);
    expect(unwired.poll(scope)).toMatchObject({ status: "prompt-active", promptState: "unknown", messages: [] });
    const app = createTestApp(chatRepo, eventBus);
    const routed = await app.request(`/api/rigs/${rigId}/chat/mailbox/mail-restart/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@team" },
      body: JSON.stringify({ taskId: "T009", runId: "run-1", capability: cap("restart"), state: "ready" }),
    });
    expect(routed.status).toBe(409);
    expect(await routed.json()).toMatchObject({ error: "mailbox_not_admitted" });

    restartedState = "clear";
    expect(restarted.consume({ ...scope, messageId: "mail-restart", consumedBy: "worker@team" }).receipt.receiptId).toBeTruthy();
  });

  it("uses one idempotent consumption receipt and allows safe later polling without an owner relay", () => {
    const message = mailbox.send({
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      body: "data only",
      messageId: "mail-1",
      capability: cap("1"),
    });
    const scope = {
      rigId,
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      capability: cap("1"),
    };

    const first = mailbox.consume({ ...scope, messageId: message.id, consumedBy: "worker@team", state: "ready" });
    const second = mailbox.consume({ ...scope, messageId: message.id, consumedBy: "worker@team", state: "queued-wait" });
    expect(second.receipt).toEqual(first.receipt);
    expect(second.message.receipt).toEqual(first.receipt);
    expect(first.message).not.toHaveProperty("capability");
    expect(second.message).not.toHaveProperty("capability");
    expect(mailbox.poll({ ...scope, state: "ready" }).messages).toEqual([]);
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(1);
  });

  it("keeps pending mailbox rows and consumption receipts when generic chat is cleared", () => {
    const scope = {
      rigId,
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      capability: cap("clear"),
    };
    const pending = mailbox.send({
      ...scope,
      sender: "lead@team",
      body: "pending after clear",
      messageId: "mail-clear-pending",
    });
    const consumed = mailbox.send({
      ...scope,
      sender: "lead@team",
      body: "consumed before clear",
      messageId: "mail-clear-consumed",
    });
    const firstReceipt = mailbox.consume({ ...scope, messageId: consumed.id, consumedBy: "worker@team", state: "ready" });
    chatRepo.send(rigId, "lead@team", "public chat");

    expect(chatRepo.clear(rigId).deleted).toBe(1);
    expect(chatRepo.history(rigId)).toEqual([]);
    expect(mailbox.poll({ ...scope, state: "ready" }).messages).toEqual([
      expect.objectContaining({ id: pending.id, body: "pending after clear" }),
    ]);
    const retry = mailbox.consume({ ...scope, messageId: consumed.id, consumedBy: "worker@team", state: "queued-wait" });
    expect(retry.receipt).toEqual(firstReceipt.receipt);
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(2);
  });

  it("keeps capabilities and attachments task-scoped", () => {
    expect(() => mailbox.send({
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      body: "cross-task attachment",
      attachment: [{ artifactId: "artifact-2", hash: "hash-2", taskId: "T010", runId: "run-1" }],
      capability: cap("1"),
    })).toThrowError(expect.objectContaining({ code: "attachment_scope_mismatch" }));

    mailbox.send({
      rigId,
      sender: "lead@team",
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      body: "scoped",
      messageId: "mail-1",
      capability: cap("1"),
    });
    expect(mailbox.poll({
      rigId,
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      capability: "other-capability",
    }).messages).toEqual([]);
    expect(() => mailbox.consume({
      rigId,
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      capability: "other-capability",
      messageId: "mail-1",
      consumedBy: "worker@team",
      state: "ready",
    })).toThrowError(expect.objectContaining({ code: "mailbox_scope_mismatch" }));
  });

  it("exposes send, poll and consume without a terminal or approval path", async () => {
    const app = createTestApp(chatRepo, eventBus, mailbox);
    const emit = vi.spyOn(eventBus, "emit");
    const body = "permission prompt answer\n\u001b[6n";
    const send = await app.request(`/api/rigs/${rigId}/chat/mailbox/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@team" },
      body: JSON.stringify({
        recipient: "worker@team",
        taskId: "T009",
        runId: "run-1",
        body,
        messageId: "mail-route-1",
        capability: cap("route"),
        attachment: [{ artifactId: "artifact-route", hash: "hash-route", taskId: "T009", runId: "run-1" }],
      }),
    });
    expect(send.status).toBe(201);
    const sent = await send.json() as { body: string; recipient: string; taskId: string; runId: string; capability: string };
    expect(sent).toMatchObject({ body, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("route") });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "chat.message", kind: "mailbox", body: "" }));

    promptState = "blocked";
    const prompt = await app.request(`/api/rigs/${rigId}/chat/mailbox/poll?taskId=T009&runId=run-1&capability=${cap("route")}&state=ready`, {
      headers: { "X-OpenRig-Session": "worker@team" },
    });
    expect(prompt.status).toBe(200);
    expect(await prompt.json()).toMatchObject({ status: "prompt-active", promptState: "blocked", pendingCount: 1, messages: [] });

    const blockedConsume = await app.request(`/api/rigs/${rigId}/chat/mailbox/mail-route-1/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@team" },
      body: JSON.stringify({ taskId: "T009", runId: "run-1", capability: cap("route"), state: "ready" }),
    });
    expect(blockedConsume.status).toBe(409);
    expect(await blockedConsume.json()).toMatchObject({ error: "mailbox_not_admitted" });

    promptState = "clear";

    const poll = await app.request(`/api/rigs/${rigId}/chat/mailbox/poll?taskId=T009&runId=run-1&capability=${cap("route")}&state=reconnect`, {
      headers: { "X-OpenRig-Session": "worker@team" },
    });
    const polled = await poll.json() as { messages: Array<{ id: string; body: string }> };
    expect(poll.status).toBe(200);
    expect(polled.messages).toEqual([expect.objectContaining({ id: "mail-route-1", body })]);
    expect(polled.messages[0]).not.toHaveProperty("capability");
    expect(JSON.stringify(polled)).not.toContain(cap("route"));

    const consume = await app.request(`/api/rigs/${rigId}/chat/mailbox/mail-route-1/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@team" },
      body: JSON.stringify({ taskId: "T009", runId: "run-1", capability: cap("route"), state: "reconnect" }),
    });
    expect(consume.status).toBe(200);
    const receipt = await consume.json() as { receipt: { receiptId: string } };
    expect(receipt.receipt.receiptId).toBeTruthy();
    expect(JSON.stringify(receipt)).not.toContain(cap("route"));

    const later = await app.request(`/api/rigs/${rigId}/chat/mailbox/poll?taskId=T009&runId=run-1&capability=${cap("route")}&state=queued-wait`, {
      headers: { "X-OpenRig-Session": "worker@team" },
    });
    expect(await later.json()).toMatchObject({ status: "queued-wait", messages: [], pendingCount: 0 });
  });

  it("excludes mailbox rows before generic chat pagination and search", () => {
    const first = chatRepo.send(rigId, "lead@team", "public first");
    const sent = mailbox.send({
      rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009",
      runId: "run-1", body: "private needle", capability: cap("private"),
    });
    const last = chatRepo.send(rigId, "lead@team", "public last");
    expect(chatRepo.history(rigId).map(message => message.id)).toEqual([first.id, last.id]);
    expect(chatRepo.history(rigId, { after: first.id, limit: 1 })).toEqual([last]);
    expect(chatRepo.latest(rigId, 2)).toEqual([first, last]);
    expect(chatRepo.searchChat(rigId, "private needle")).toEqual([]);
    expect(JSON.stringify(chatRepo.history(rigId))).not.toContain(sent.capability);
  });

  it("keeps mailbox data out of history, replay, buffered and live watch events", async () => {
    const app = createTestApp(chatRepo, eventBus);
    const history = chatRepo.send(rigId, "lead@team", "public history");
    const emit = vi.spyOn(eventBus, "emit");
    const sendPeer = async (messageId: string) => {
      const response = await app.request(`/api/rigs/${rigId}/chat/mailbox/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@team" },
        body: JSON.stringify({ recipient: "worker@team", taskId: "T009", runId: "run-1",
          messageId, body: "private needle", capability: cap("private") }),
      });
      expect(response.status).toBe(201);
    };
    await sendPeer("mail-before-watch");
    const sendPublic = (body: string) => {
      const message = chatRepo.send(rigId, "lead@team", body);
      eventBus.emit({ type: "chat.message", rigId, messageId: message.id,
        sender: message.sender, kind: message.kind, body: message.body });
      return message;
    };
    const original = SSEStreamingApi.prototype.writeSSE;
    let replayInjected = false;
    const writes = vi.spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(async function (frame) {
      if (!replayInjected) {
        replayInjected = true;
        await sendPeer("mail-during-replay");
        sendPublic("public buffered");
      }
      return original.call(this, frame);
    });
    const before = eventBus.subscriberCount;
    const response = await app.request(`/api/rigs/${rigId}/chat/watch`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      await vi.waitFor(() => expect(writes.mock.calls.length).toBeGreaterThanOrEqual(2));
      await sendPeer("mail-live");
      const live = sendPublic("public live");
      while (!output.includes(live.id)) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        output += decoder.decode(chunk.value, { stream: true });
      }
      const frames = output.split("\n\n").filter(Boolean)
        .map(frame => JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
      expect(frames.map(frame => frame.body)).toEqual(["public history", "public buffered", "public live"]);
      expect(output).not.toContain("mail-");
      expect(output).not.toContain("private needle");
      expect(output).not.toContain(cap("private"));
      const generic = await app.request(`/api/rigs/${rigId}/chat/history`);
      expect((await generic.json() as Array<{ id: string }>)[0]!.id).toBe(history.id);
      const peerEvents = emit.mock.calls.map(([event]) => event)
        .filter(event => event.type === "chat.message" && event.kind === "mailbox");
      expect(peerEvents).toHaveLength(3);
      expect(JSON.stringify(peerEvents)).not.toContain(cap("private"));
      expect(JSON.stringify(peerEvents)).not.toContain("private needle");
      const eventRows = db.prepare("SELECT * FROM events").all();
      expect(JSON.stringify(eventRows)).not.toContain(cap("private"));
      expect(JSON.stringify(eventRows)).not.toContain("private needle");
    } finally {
      await reader.cancel();
      reader.releaseLock();
      writes.mockRestore();
      emit.mockRestore();
      await vi.waitFor(() => expect(eventBus.subscriberCount).toBe(before));
    }
  });

  it.each([undefined, null, [], [
    { taskId: "T009", runId: "run-1", artifactId: "artifact-1", hash: "hash-1" },
    { taskId: "T009", runId: "run-1", artifactId: "artifact-2", hash: "hash-2" },
  ]])("persists only exact scoped artifact references (attachment: %j)", attachment => {
    const sent = mailbox.send({
      rigId, sender: "lead@team", recipient: "worker@team", taskId: "T009",
      runId: "run-1", body: "artifact data", attachment, capability: cap("artifact"),
    });
    const polled = mailbox.poll({
      rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("artifact"),
    });
    expect(sent.attachment).toEqual(attachment ?? null);
    expect(polled.messages[0]!.attachment).toEqual(attachment ?? null);
  });

  const artifact = { taskId: "T009", runId: "run-1", artifactId: "artifact-1", hash: "hash-1" };
  it.each([
    ["plain object", artifact, "invalid_mailbox_input"],
    ["string", "artifact-1", "invalid_mailbox_input"],
    ["boolean", false, "invalid_mailbox_input"],
    ["number", 0, "invalid_mailbox_input"],
    ["string array", ["artifact-1"], "invalid_mailbox_input"],
    ["null entry", [null], "invalid_mailbox_input"],
    ["nested array", [[artifact]], "invalid_mailbox_input"],
    ["missing field", [{ taskId: "T009", runId: "run-1", artifactId: "artifact-1" }], "invalid_mailbox_input"],
    ["non-string field", [{ ...artifact, hash: 1 }], "invalid_mailbox_input"],
    ["extra field", [{ ...artifact, extra: "value" }], "invalid_mailbox_input"],
    ["nested field", [{ ...artifact, hash: { value: "hash-1" } }], "invalid_mailbox_input"],
    ["extra nested keys", [{ ...artifact, metadata: { taskId: "T009" } }], "invalid_mailbox_input"],
    ["mixed entries", [artifact, "artifact-2"], "invalid_mailbox_input"],
    ["foreign task", [{ ...artifact, taskId: "T010" }], "attachment_scope_mismatch"],
    ["foreign run", [{ ...artifact, runId: "run-2" }], "attachment_scope_mismatch"],
    ["mixed scopes", [artifact, { ...artifact, taskId: "T010" }], "attachment_scope_mismatch"],
  ])("rejects %s attachments before any persistence", async (_name, attachment, code) => {
    const input = { recipient: "worker@team", taskId: "T009", runId: "run-1",
      body: "invalid attachment", attachment, capability: cap("invalid") };
    expect(() => chatRepo.sendMailbox(rigId, "lead@team", input))
      .toThrowError(expect.objectContaining({ code }));
    expect(() => mailbox.send({ rigId, sender: "lead@team", ...input }))
      .toThrowError(expect.objectContaining({ code }));
    const app = createTestApp(chatRepo, eventBus);
    const response = await app.request(`/api/rigs/${rigId}/chat/mailbox/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@team" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: code });
    expect((db.prepare("SELECT count(*) AS count FROM chat_messages").get() as { count: number }).count).toBe(0);
    expect(db.prepare("SELECT * FROM events").all()).toEqual([]);
  });

  it("returns an internal error for unexpected mailbox failures", async () => {
    const failingMailbox = new MailboxDelivery(chatRepo);
    vi.spyOn(failingMailbox, "send").mockImplementation(() => {
      throw new MailboxDeliveryError("storage_failure", "storage unavailable");
    });
    const app = createTestApp(chatRepo, eventBus, failingMailbox);

    const response = await app.request("/api/rigs/" + rigId + "/chat/mailbox/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@team" },
      body: JSON.stringify({
        recipient: "worker@team",
        taskId: "T009",
        runId: "run-1",
        body: "unavailable",
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "storage_failure", message: "internal error" });
  });

  it("refuses mailbox reads and receipts without the recipient's transport identity", async () => {
    const app = createTestApp(chatRepo, eventBus, mailbox);
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("claimed") };
    mailbox.send({ ...scope, sender: "lead@team", body: "only for the worker", messageId: "mail-claimed" });
    const base = `/api/rigs/${rigId}/chat/mailbox`;

    const claimedPoll = await app.request(`${base}/poll?recipient=worker@team&taskId=T009&runId=run-1&capability=${cap("claimed")}`);
    expect(claimedPoll.status).toBe(403);
    expect(await claimedPoll.json()).toMatchObject({ error: "mailbox_transport_identity_required" });
    const claimedConsume = await app.request(`${base}/mail-claimed/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: "worker@team", taskId: "T009", runId: "run-1", capability: cap("claimed") }),
    });
    expect(claimedConsume.status).toBe(403);
    expect(mailbox.poll(scope).pendingCount).toBe(1);

    const consumed = await app.request(`${base}/mail-claimed/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@team" },
      body: JSON.stringify({ taskId: "T009", runId: "run-1", capability: cap("claimed") }),
    });
    expect(consumed.status).toBe(200);
    expect(await consumed.json()).toMatchObject({
      receipt: { consumedBy: "worker@team", consumedByProvenance: "transport:v1" },
    });
  });

  it("tells a foreign or weak capability nothing about the recipient seat", async () => {
    const scope = { rigId, recipient: "worker@team", taskId: "T009", runId: "run-1" };
    mailbox.send({ ...scope, sender: "lead@team", body: "secret", messageId: "mail-foreign", capability: cap("owner") });
    promptState = "blocked";

    expect(mailbox.poll({ ...scope, capability: cap("foreign") }))
      .toMatchObject({ promptState: "unknown", pendingCount: 0, messages: [] });
    expect(() => mailbox.consume({ ...scope, capability: cap("foreign"), messageId: "mail-foreign", consumedBy: "worker@team" }))
      .toThrowError(expect.objectContaining({ code: "mailbox_scope_mismatch" }));
    const app = createTestApp(chatRepo, eventBus, mailbox);
    const routed = await app.request(`/api/rigs/${rigId}/chat/mailbox/mail-foreign/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@team" },
      body: JSON.stringify({ taskId: "T009", runId: "run-1", capability: cap("foreign") }),
    });
    expect(routed.status).toBe(404);
    expect(await routed.json()).toEqual({ error: "mailbox_not_found", message: "mailbox message not found" });

    expect(() => mailbox.send({ ...scope, sender: "lead@team", body: "weak", messageId: "mail-weak", capability: "x" }))
      .toThrowError(expect.objectContaining({ code: "invalid_mailbox_input" }));
    expect(() => mailbox.poll({ ...scope, capability: cap("owner"), state: "bogus" as never }))
      .toThrowError(expect.objectContaining({ code: "invalid_mailbox_state" }));
  });

  it("rejects a missing capability and never turns peer data into approval", () => {
    expect(() => mailbox.poll({
      rigId,
      recipient: "worker@team",
      taskId: "T009",
      runId: "run-1",
      capability: "",
    })).toThrowError(MailboxDeliveryError);
  });
});

describe("daemon-observed mailbox prompt state", () => {
  const sessionName = "dev-qa@test-rig";
  let db: Database.Database;
  let clock: Date;
  let store: AgentActivityStore;
  let seatState: Pick<ArbitratedSeatState, "activity" | "needsInput" | "needsInputEvidence"> | null;
  let read: (recipient: string) => MailboxPromptState;

  const at = (minutesAgo: number) => new Date(clock.getTime() - minutesAgo * 60_000).toISOString();
  const hook = (hookEvent: string, subtype: string | null, minutesAgo: number, generation: string | null = "gen-1") => {
    expect(store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent,
      subtype,
      occurredAt: at(minutesAgo),
      generation,
    }).ok).toBe(true);
  };

  beforeEach(() => {
    db = createFullTestDb();
    clock = new Date("2026-10-17T08:00:00.000Z");
    const rigRepo = new RigRepository(db);
    const node = rigRepo.addNode(rigRepo.createRig("test-rig").id, "dev.qa", { runtime: "claude-code" });
    new SessionRegistry(db).registerSession(node.id, sessionName);
    store = new AgentActivityStore({
      db,
      eventBus: new EventBus(db),
      now: () => clock,
      resolveOccupantGeneration: () => "gen-1",
    });
    seatState = null;
    read = createMailboxPromptStateReader({
      db,
      seatActivity: { getSeatState: () => seatState as ArbitratedSeatState | null },
      agentActivityStore: store,
      observedSince: at(2),
      now: () => clock,
    });
  });

  afterEach(() => db.close());

  it("reads unknown without seat or hook evidence, including right after a restart", () => {
    expect(read(sessionName)).toBe("unknown");
    expect(read("missing@test-rig")).toBe("unknown");
    seatState = { activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, needsInputEvidence: null };
    expect(read(sessionName)).toBe("unknown");
  });

  it("reads clear only from fresh evidence that the seat moved on", () => {
    hook("PreToolUse", null, 1);
    expect(read(sessionName)).toBe("clear");
    clock = new Date(clock.getTime() + 10 * 60_000);
    expect(read(sessionName)).toBe("unknown");
  });

  it("never reads clear from evidence recorded before the daemon started", () => {
    hook("PreToolUse", null, 3);
    expect(read(sessionName)).toBe("unknown");
    hook("Stop", null, 1);
    expect(read(sessionName)).toBe("clear");
  });

  it("reads blocked while a prompt waits on a person, even past the freshness window", () => {
    hook("Notification", "permission_prompt", 1);
    expect(read(sessionName)).toBe("blocked");
    clock = new Date(clock.getTime() + 60 * 60_000);
    expect(read(sessionName)).toBe("blocked");
  });

  it("lets the seat oracle block, but needs a fresh hook from this occupant to read clear", () => {
    hook("PreToolUse", null, 1);
    seatState = {
      activity: "working",
      needsInput: { count: 1, reason: "permission_prompt" },
      needsInputEvidence: { rung: "needs-input-chrome", observedAt: at(0) },
    };
    expect(read(sessionName)).toBe("blocked");

    hook("Notification", "permission_prompt", 0);
    seatState = {
      activity: "idle-at-prompt",
      needsInput: { count: 0, reason: null },
      needsInputEvidence: { rung: "lifecycle-hooks", observedAt: at(0) },
    };
    expect(read(sessionName)).toBe("unknown");
    hook("PreToolUse", null, 0);
    expect(read(sessionName)).toBe("clear");
  });

  it("never reads clear from an oracle clear alone or from pre-start, future-dated or unverifiable hooks", () => {
    seatState = {
      activity: "idle-at-prompt",
      needsInput: { count: 0, reason: null },
      needsInputEvidence: { rung: "lifecycle-hooks", observedAt: at(0) },
    };
    expect(read(sessionName)).toBe("unknown");
    hook("Stop", null, 3);
    expect(read(sessionName)).toBe("unknown");
    hook("Stop", null, -10);
    expect(read(sessionName)).toBe("unknown");
    hook("Stop", null, 1, null);
    expect(read(sessionName)).toBe("unknown");
    hook("Stop", null, 1);
    expect(read(sessionName)).toBe("clear");
  });
});

describe("mailbox admission through the production app", () => {
  it("wires the daemon's prompt-state evidence into the mailbox routes", async () => {
    const db = createFullTestDb();
    try {
      const built = createFullTestApp(db, { appDeps: { chatRepo: new ChatRepository(db) } });
      const rig = built.rigRepo.createRig("wired-rig");
      const node = built.rigRepo.addNode(rig.id, "dev.qa", { runtime: "claude-code" });
      const recipient = "dev-qa@wired-rig";
      built.sessionRegistry.registerSession(node.id, recipient);
      const generation = built.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null;
      const base = `/api/rigs/${rig.id}/chat/mailbox`;
      const query = `taskId=T009&runId=run-1&capability=${cap("wired")}&state=ready`;

      const send = await built.app.request(`${base}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@wired-rig" },
        body: JSON.stringify({ recipient, taskId: "T009", runId: "run-1", body: "data", messageId: "mail-wired", capability: cap("wired") }),
      });
      expect(send.status).toBe(201);

      const consume = () => built.app.request(`${base}/mail-wired/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": recipient },
        body: JSON.stringify({ taskId: "T009", runId: "run-1", capability: cap("wired"), state: "ready" }),
      });
      const held = await built.app.request(`${base}/poll?${query}`, { headers: { "X-OpenRig-Session": recipient } });
      expect(await held.json()).toMatchObject({ status: "prompt-active", promptState: "unknown", pendingCount: 1, messages: [] });
      expect((await consume()).status).toBe(409);

      const hook = (occurredAt: Date) => expect(built.agentActivityStore.recordHookEvent({
        runtime: "claude-code",
        sessionName: recipient,
        hookEvent: "PreToolUse",
        occurredAt: occurredAt.toISOString(),
        generation,
      }).ok).toBe(true);
      hook(new Date(Date.now() - 60_000));
      const stale = await built.app.request(`${base}/poll?${query}`, { headers: { "X-OpenRig-Session": recipient } });
      expect(await stale.json()).toMatchObject({ status: "prompt-active", promptState: "unknown", pendingCount: 1 });
      expect((await consume()).status).toBe(409);

      hook(new Date(Date.now() + 1_000));
      const ready = await built.app.request(`${base}/poll?${query}`, { headers: { "X-OpenRig-Session": recipient } });
      expect(await ready.json()).toMatchObject({ status: "ready", promptState: "clear", pendingCount: 1 });
      const consumed = await consume();
      expect(consumed.status).toBe(200);
    } finally {
      db.close();
    }
  });
});

describe("managed mailbox route isolation", () => {
  it("admits only an authenticated recipient-scoped worker poll and consume while legacy chat stays closed", async () => {
    const db = createFullTestDb();
    fixDaemonMode(db, true);
    try {
      const chatRepo = new ChatRepository(db);
      const recipient = "dev-qa@managed-mailbox";
      const workerToken = "managed-worker-token";
      const ownerToken = "managed-owner-token";
      const built = createFullTestApp(db, {
        appDeps: {
          chatRepo,
          teamControl: {
            credentials: {
              ownerToken,
              workers: [
                { token: workerToken, sessionId: recipient, runId: "managed-run" },
                { token: "foreign-worker-token", sessionId: "other@managed-mailbox", runId: "other-run" },
              ],
            },
          },
        },
      });
      const rig = built.rigRepo.createRig("managed-mailbox");
      const node = built.rigRepo.addNode(rig.id, "dev.qa", { runtime: "claude-code" });
      built.sessionRegistry.registerSession(node.id, recipient);
      const generation = built.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null;
      const message = new MailboxDelivery(chatRepo).send({ rigId: rig.id, sender: "lead@managed-mailbox", recipient,
        taskId: "T010", runId: "managed-run", body: "private peer data", messageId: "managed-mail", capability: cap("managed") });
      expect(built.agentActivityStore.recordHookEvent({ runtime: "claude-code", sessionName: recipient, hookEvent: "PreToolUse",
        occurredAt: new Date(Date.now() + 1_000).toISOString(), generation }).ok).toBe(true);
      const base = "/api/rigs/" + rig.id + "/chat/mailbox";
      const query = "?taskId=T010&runId=managed-run";
      const authHeaders = {
        Authorization: "Bearer " + workerToken,
        "X-OpenRig-Session": recipient,
        "x-openrig-mailbox-capability": cap("managed"),
      };
      const request = (path: string, init: Parameters<typeof built.app.request>[1] = {}) =>
        built.app.request(path, init, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

      for (const suffix of ["", "/poll"]) {
        const poll = await request(base + suffix + query, { headers: authHeaders });
        expect(poll.status).toBe(200);
        const body = await poll.json();
        expect(body).toMatchObject({ status: "ready", pendingCount: 1, messages: [{ id: message.id, body: "private peer data" }] });
        expect(JSON.stringify(body)).not.toContain(cap("managed"));
      }
      const missingCredential = await request(base + query, {
        headers: { "X-OpenRig-Session": recipient, "x-openrig-mailbox-capability": cap("managed") },
      });
      expect(missingCredential.status).toBe(401);
      expect(await missingCredential.json()).toMatchObject({ code: "control_auth_required" });
      const ownerCredential = await request(base + query, {
        headers: { ...authHeaders, Authorization: "Bearer " + ownerToken },
      });
      expect(ownerCredential.status).toBe(403);
      expect(await ownerCredential.json()).toMatchObject({ code: "managed_control_required" });
      const wrongRun = await request(base + "?taskId=T010&runId=other-run", { headers: authHeaders });
      expect(wrongRun.status).toBe(403);
      expect(await wrongRun.json()).toMatchObject({ code: "managed_control_required" });
      const spoofed = await request(base + query, {
        headers: { ...authHeaders, "X-OpenRig-Session": "other@managed-mailbox" },
      });
      expect(spoofed.status).toBe(403);
      expect(await spoofed.json()).toMatchObject({ code: "managed_control_required" });
      const foreignWorker = await request(base + query, {
        headers: { ...authHeaders, Authorization: "Bearer foreign-worker-token", "X-OpenRig-Session": "other@managed-mailbox" },
      });
      expect(foreignWorker.status).toBe(403);
      expect(await foreignWorker.json()).toMatchObject({ code: "managed_control_required" });
      const foreignCapability = await request(base + query, {
        headers: { ...authHeaders, "x-openrig-mailbox-capability": cap("foreign") },
      });
      expect(await foreignCapability.json()).toMatchObject({ messages: [], pendingCount: 0 });

      const consume = (capability: string, overrides: Record<string, string> = {}, runId = "managed-run") => request(base + "/" + message.id + "/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders, ...overrides },
        body: JSON.stringify({ taskId: "T010", runId, capability }),
      });
      expect((await consume(cap("foreign"))).status).toBe(404);
      expect((await consume(cap("managed"), {}, "other-run")).status).toBe(403);
      const consumed = await consume(cap("managed"));
      expect(consumed.status).toBe(200);
      expect(JSON.stringify(await consumed.json())).not.toContain(cap("managed"));
      expect((await consume(cap("managed"))).status).toBe(200);
      for (const [path, method] of [
        ["/api/rigs/" + rig.id + "/chat/history", "GET"],
        ["/api/rigs/" + rig.id + "/chat/send", "POST"], [base + "/send", "POST"], [base, "POST"],
      ]) {
        const denied = await request(path!, { method, headers: authHeaders, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ code: "managed_control_required" });
      }
    } finally { db.close(); }
  });
});
