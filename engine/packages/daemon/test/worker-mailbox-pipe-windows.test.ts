import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { ChatRepository } from "../src/domain/chat-repository.js";
import { MailboxDelivery } from "../src/domain/mailbox-delivery.js";
import { WorkerMailboxBridge } from "../src/adapters/worker-mailbox-bridge.js";
import { MAILBOX_PIPE_PREFIX, mailboxEndpoint } from "../src/domain/mailbox-endpoint.js";
import type { TeamControlCredentials } from "../src/middleware/auth-bearer-token.js";

/**
 * WINPIPE — the managed mailbox over a Windows named pipe.
 *
 * measured: `net.Server.listen` refuses any filesystem path on Windows with `EACCES`, which is
 * where every managed attempt used to end before it could publish an endpoint. This drives the
 * real bridge on the real pipe: a worker-shaped client connects with the value the bootstrap
 * names, the right capability is served, a wrong one is refused, a second bridge on one endpoint
 * is refused, and closing removes the pipe so nothing is left behind.
 */
const windows = process.platform === "win32";

describe.skipIf(!windows)("Windows mailbox transport", () => {
  const worker = { token: "winpipe-worker-fixture", sessionId: "worker-session", runId: "run" };
  const credentials: TeamControlCredentials = { ownerToken: "winpipe-owner-fixture", workers: [worker] };
  const capability = `mailbox:${"a".repeat(43)}`;
  const ownScope = { rigId: "rig", recipient: worker.sessionId, taskId: "task", runId: "run", capability };
  let directory: string, db: ReturnType<typeof createDb>, chat: ChatRepository, bridge: WorkerMailboxBridge;

  const open = () => new WorkerMailboxBridge({ directory, workerId: "worker", sessionId: worker.sessionId,
    runId: "run", attemptId: "attempt", rigId: "rig", taskId: "task", recipients: ["peer"] },
  new MailboxDelivery(chat, () => "clear", () => null), chat, () => credentials, () => true);

  /** A frame the daemon's own worker would send, over the endpoint the bootstrap names. */
  const ask = (target: string, fields: Record<string, unknown>) => new Promise<{ ok: boolean; result?: unknown; code?: string }>((resolve, reject) => {
    const socket = createConnection(target, () => socket.end(JSON.stringify(fields) + "\n"));
    let output = "";
    socket.setTimeout(3_000, () => { socket.destroy(); reject(new Error("pipe response timeout")); });
    socket.on("data", (chunk) => { output += chunk; });
    socket.once("error", reject);
    socket.once("end", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
  const frame = (fields: Record<string, unknown> = {}) => ({ authorization: "Bearer " + worker.token,
    sessionId: worker.sessionId, runId: "run", attemptId: "attempt", generation: bridge.generation,
    taskId: "task", capability, operation: "poll", ...fields });

  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "winpipe-")));
    db = createDb(); initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'pipe fixture')").run();
    chat = new ChatRepository(db);
    bridge = open();
  });
  afterEach(async () => {
    await bridge?.close();
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("listens on a named pipe beside the bootstrap the worker reads", async () => {
    await bridge.listen();
    const endpoint = bridge.endpoint();
    expect(endpoint.transport).toBe("pipe");
    expect(endpoint.path.startsWith(MAILBOX_PIPE_PREFIX)).toBe(true);
    expect(endpoint.path).toBe(mailboxEndpoint(directory, bridge.generation).path);
    // The bootstrap names the pipe as the connect target. A filesystem path here is what fails
    // on Windows, so the value itself is the assertion.
    const bootstrap = JSON.parse(readFileSync(join(directory, "bootstrap.json"), "utf8")) as Record<string, string>;
    expect(bootstrap.endpoint).toBe(endpoint.path);
    expect(bootstrap.generation).toBe(bridge.generation);
    expect(bootstrap.authorization).toBe("Bearer " + worker.token);
    expect(existsSync(join(directory, "mailbox.sock"))).toBe(false);
  });

  it("serves a message carrying the bootstrap's capability and refuses a wrong one", async () => {
    await bridge.listen();
    const target = bridge.endpoint().path;
    chat.sendMailbox("rig", "peer", { messageId: "parent", recipient: worker.sessionId,
      taskId: "task", runId: "run", body: "peer context", capability });
    expect(await ask(target, frame())).toMatchObject({ ok: true, result: { messages: [{ body: "peer context" }] } });
    // The same frame with a capability the seat does not own is refused rather than served, and
    // the message stays pending for the seat that does own it.
    expect(await ask(target, frame({ capability: `mailbox:${"b".repeat(43)}` })))
      .toMatchObject({ ok: true, result: { messages: [] } });
    expect(chat.countPendingMailbox(ownScope)).toBe(1);
    expect(await ask(target, frame({ authorization: "Bearer not-a-worker-token" })))
      .toEqual({ ok: false, code: "control_auth_required" });
    expect(await ask(target, frame({ generation: "previous" })))
      .toEqual({ ok: false, code: "mailbox_not_admitted" });
    expect(chat.countPendingMailbox(ownScope)).toBe(1);
  });

  it("refuses a second bridge on the same endpoint and removes the pipe when the first closes", async () => {
    await bridge.listen();
    const target = bridge.endpoint().path;
    // The duplicate replays this bridge's generation: a fresh bridge would name its own pipe,
    // so a replayed name is exactly the collision a squatter or a duplicate daemon creates.
    const duplicate = new WorkerMailboxBridge({ directory, workerId: "worker", sessionId: worker.sessionId,
      runId: "run", attemptId: "attempt", rigId: "rig", taskId: "task", recipients: ["peer"] },
    new MailboxDelivery(chat, () => "clear", () => null), chat, () => credentials, () => true,
    [], "win32", bridge.generation);
    try {
      await expect(duplicate.listen()).rejects.toThrow(/mailbox_endpoint_in_use|EADDRINUSE|EBUSY/);
    } finally {
      await duplicate.close();
    }
    // The refused duplicate listens on nothing, so it must never have taken the name: the first
    // bridge still answers on it.
    expect(await ask(target, frame())).toEqual({ ok: true, result: expect.objectContaining({ status: expect.any(String) }) });
    // And its close must not have removed the live bridge's bootstrap.
    expect(existsSync(join(directory, "bootstrap.json"))).toBe(true);
    await bridge.close();
    // The pipe is the server: once it closes, nothing answers that name any more.
    await expect(new Promise<void>((resolve, reject) => {
      const socket = createConnection(target);
      socket.once("connect", () => { socket.destroy(); reject(new Error("pipe still served after close")); });
      socket.once("error", (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? resolve() : reject(error));
    })).resolves.toBeUndefined();
    expect(existsSync(join(directory, "bootstrap.json"))).toBe(false);
  });

  it("refuses to listen over a pipe another process already holds", async () => {
    // A squatter that knows the name exactly as the generation replays it. A server this
    // daemon did not create must never be replaced, retried or written through: the bridge
    // refuses, and whatever answered keeps answering.
    const { createServer } = await import("node:net");
    const squatted = mailboxEndpoint(directory, bridge.generation, "win32").path;
    const squatter = createServer((socket) => socket.end("squatter\n"));
    try {
      await new Promise<void>((resolve, reject) => { squatter.once("error", reject); squatter.listen(squatted, resolve); });
      await expect(bridge.listen()).rejects.toThrow("mailbox_endpoint_in_use");
      // Nothing of this daemon's leaked into the squatter's directory either.
      expect(existsSync(join(directory, "bootstrap.json"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});