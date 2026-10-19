import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ChatRepository } from "../src/domain/chat-repository.js";
import { MailboxDelivery, type MailboxPromptState, type NativeChannelSeatState } from "../src/domain/mailbox-delivery.js";
import { WorkerMailboxBridge } from "../src/adapters/worker-mailbox-bridge.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  resolveTeamControlCredential, teamControlAuthentication,
  type TeamControlCredentials, type TeamControlEnv,
} from "../src/middleware/auth-bearer-token.js";

const worker = { token: "worker-fixture", sessionId: "worker-session", runId: "run" };
const credentials: TeamControlCredentials = { ownerToken: "owner-fixture", workers: [worker] };

describe("mailbox transport credential resolution", () => {
  it("resolves the existing owner and run-bound worker roles without transport assertions", () => {
    expect(resolveTeamControlCredential("Bearer owner-fixture", credentials)).toEqual({
      ok: true, actor: { kind: "owner", sessionId: "owner-control" }, runId: null,
    });
    expect(resolveTeamControlCredential("Bearer worker-fixture", credentials)).toEqual({
      ok: true, actor: { kind: "worker", sessionId: "worker-session" }, runId: "run",
    });
  });

  it.each([undefined, "", "Basic worker-fixture", "Bearer", "Bearer  worker-fixture",
    "Bearer worker-fixture,owner-fixture", "Bearer worker-fixture extra", "Bearer unknown"])(
    "rejects missing, malformed or unknown credentials: %s", (header) => {
      expect(resolveTeamControlCredential(header, credentials)).toEqual({
        ok: false, status: 401, code: "control_auth_required",
        error: "A dedicated control credential is required.",
      });
    },
  );

  it("preserves case-insensitive scheme parsing and worker-only configuration", () => {
    expect(resolveTeamControlCredential("bEaReR worker-fixture", { ownerToken: null, workers: [worker] })).toEqual({
      ok: true, actor: { kind: "worker", sessionId: "worker-session" }, runId: "run",
    });
    expect(resolveTeamControlCredential("Bearer owner-fixture", { ownerToken: null }).ok).toBe(false);
  });

  it.each([
    { name: "owner/worker overlap", value: { ...credentials, ownerToken: worker.token } },
    { name: "duplicate workers", value: { ...credentials, workers: [worker, { ...worker, sessionId: "other" }] } },
    { name: "empty worker token", value: { ...credentials, workers: [{ ...worker, token: "" }] } },
    { name: "blank worker token", value: { ...credentials, workers: [{ ...worker, token: " " }] } },
    { name: "blank session", value: { ...credentials, workers: [{ ...worker, sessionId: " " }] } },
    { name: "blank run", value: { ...credentials, workers: [{ ...worker, runId: " " }] } },
  ])("rejects credential conflicts before authentication: $name", ({ value }) => {
    expect(resolveTeamControlCredential(undefined, value)).toEqual({
      ok: false, status: 503, code: "control_credentials_conflict",
      error: "Control credentials must have distinct roles.",
    });
  });

  it.each(["owner-fixture", "worker-fixture"])("rejects legacy-token overlap: %s", (legacy) => {
    expect(resolveTeamControlCredential("Bearer worker-fixture", credentials, [null, undefined, "", legacy])).toMatchObject({
      ok: false, status: 503, code: "control_credentials_conflict",
    });
  });

  it("matches the resolver on actual HTTP loopback requests and observes revocation", async () => {
    let active = credentials;
    const app = new Hono<TeamControlEnv>();
    app.use("*", teamControlAuthentication(() => active, ["legacy-fixture"]));
    app.get("/", (c) => c.json({ ok: true, actor: c.get("controlActor"), runId: c.get("controlRunId") }));
    let server: ReturnType<typeof serve> | undefined;
    const url = await new Promise<string>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        (info) => resolve(`http://127.0.0.1:${info.port}/`));
    });
    try {
      for (const header of [undefined, "Basic worker-fixture", "Bearer unknown", "Bearer owner-fixture", "Bearer worker-fixture"]) {
        const expected = resolveTeamControlCredential(header, active, ["legacy-fixture"]);
        const response = await fetch(url, { headers: header ? { Authorization: header } : {} });
        expect(response.status).toBe(expected.ok ? 200 : expected.status);
        expect(await response.json()).toEqual(expected.ok ? expected : { code: expected.code, error: expected.error });
        if (expected.ok) expect(response.headers.get("cache-control")).toBe("no-store");
      }
      active = { ...credentials, workers: [] };
      const revoked = await fetch(url, { headers: { Authorization: "Bearer worker-fixture" } });
      expect(revoked.status).toBe(401);
      expect(await revoked.json()).toEqual({ code: "control_auth_required", error: "A dedicated control credential is required." });
      active = { ...credentials, ownerToken: "legacy-fixture" };
      const conflicted = await fetch(url, { headers: { Authorization: "Bearer worker-fixture" } });
      expect(conflicted.status).toBe(503);
      expect(await conflicted.json()).toEqual({ code: "control_credentials_conflict", error: "Control credentials must have distinct roles." });
    } finally {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([undefined, "192.0.2.10"])("retains HTTP rejection without a loopback socket peer: %s", async (peer) => {
    let reads = 0;
    const app = new Hono<TeamControlEnv>();
    app.use("*", teamControlAuthentication(() => { reads += 1; return credentials; }));
    app.get("/", (c) => c.json({ reached: true }));
    const response = await app.request("http://localhost/", {
      headers: { Authorization: "Bearer worker-fixture", "X-Forwarded-For": "127.0.0.1" },
    }, peer ? { incoming: { socket: { remoteAddress: peer } } } : {});
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "local_control_required", error: "A loopback control connection is required." });
    expect(reads).toBe(0);
  });
});

describe("authenticated per-attempt Unix mailbox transport", () => {
  let directory: string, db: ReturnType<typeof createDb>, chat: ChatRepository, bridge: WorkerMailboxBridge;
  let current: boolean, prompt: "clear" | "blocked";
  let delivery: MailboxDelivery, channel: NativeChannelSeatState | null, promptReader: () => MailboxPromptState;
  let active: TeamControlCredentials;
  const capability = `mailbox:${"a".repeat(43)}`;
  const ownScope = { rigId: "rig", recipient: worker.sessionId, taskId: "task", runId: "run", capability };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "t010-mailbox-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'mailbox fixture')").run();
    chat = new ChatRepository(db); current = true; prompt = "clear"; active = credentials;
    channel = null; promptReader = () => prompt;
    delivery = new MailboxDelivery(chat, () => promptReader(), () => channel);
    bridge = new WorkerMailboxBridge({ socketPath: join(directory, "mailbox.sock"), workerId: "worker",
      sessionId: worker.sessionId, runId: "run", attemptId: "attempt", rigId: "rig", taskId: "task", recipients: ["peer"] },
    delivery, chat, () => active, () => current);
    await bridge.listen();
  });
  afterEach(async () => {
    await bridge?.close(); db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const frame = (fields: Record<string, unknown> = {}) => ({
    authorization: "Bearer worker-fixture", sessionId: worker.sessionId, runId: "run", attemptId: "attempt",
    generation: bridge.generation, taskId: "task", capability, operation: "poll", ...fields,
  });
  const request = (fields: Record<string, unknown>) => new Promise<{ ok: boolean; result?: unknown; code?: string }>((resolve, reject) => {
    const socket = createConnection(bridge.binding.socketPath, () => socket.write(JSON.stringify(frame(fields)) + "\n"));
    let output = "";
    socket.setTimeout(3_000, () => { socket.destroy(); reject(new Error("fixture response timeout")); });
    socket.on("data", chunk => { output += chunk; });
    socket.once("error", reject);
    socket.once("end", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
  const pending = () => chat.countPendingMailbox(ownScope);
  const incoming = () => chat.sendMailbox("rig", "peer", { messageId: "parent", recipient: worker.sessionId,
    taskId: "task", runId: "run", body: "peer context", capability });

  it("uses authenticated sender identity for durable idempotent sends and scoped replies", async () => {
    const send = { operation: "send", recipient: "peer", messageId: "outgoing", body: "first line\nsecond line" };
    expect((await request(send)).result).toMatchObject({ sender: worker.sessionId, recipient: "peer", capability });
    expect((await request(send)).result).not.toHaveProperty("capability");
    expect(chat.countPendingMailbox({ ...ownScope, recipient: "peer" })).toBe(1);
    incoming();
    expect((await request({ operation: "reply", recipient: "peer", messageId: "reply", replyTo: "parent", body: "response" })).result)
      .toMatchObject({ sender: worker.sessionId, replyTo: "parent", recipient: "peer" });
    expect(pending()).toBe(1);
    expect(chat.getMailbox({ ...ownScope, messageId: "parent" }).receipt).toBeNull();
  });

  it("leaves prompt-blocked messages pending and exposes them only through the own capability scope", async () => {
    incoming(); prompt = "blocked";
    expect((await request({})).result).toMatchObject({ status: "prompt-active", messages: [], pendingCount: 1 });
    prompt = "clear";
    const delivered = await request({});
    expect(delivered.result).toMatchObject({ messages: [{ body: "peer context" }] });
    expect(delivered.result).not.toHaveProperty("messages.0.capability");
    expect((await request({ capability: `mailbox:${"b".repeat(43)}` })).result).toMatchObject({ messages: [] });
    expect(pending()).toBe(1);
  });

  it.each([
    { authorization: "Bearer owner-fixture" }, { runId: "other" }, { attemptId: "other" },
    { sessionId: "other" }, { taskId: "other" }, { generation: "old" }, { recipient: "peer" },
    { sender: "peer" }, { capability: "" },
  ])("rejects cross-scope or caller-asserted authority without changing pending state: %j", async (fields) => {
    incoming();
    expect((await request(fields)).ok).toBe(false);
    expect(pending()).toBe(1);
    expect(chat.getMailbox({ ...ownScope, messageId: "parent" }).receipt).toBeNull();
  });

  it("rechecks current credentials and control admission on every request", async () => {
    incoming(); active = { ...credentials, workers: [] };
    expect(await request({})).toEqual({ ok: false, code: "control_auth_required" });
    active = credentials; current = false;
    expect(await request({})).toEqual({ ok: false, code: "mailbox_not_admitted" });
    expect(pending()).toBe(1);
  });
  const rawRequest = (payload: string | Buffer) => new Promise<string>((resolve, reject) => {
    const socket = createConnection(bridge.binding.socketPath, () => socket.write(payload));
    let output = "";
    socket.setTimeout(3_000, () => { socket.destroy(); reject(new Error("fixture response timeout")); });
    socket.on("data", chunk => { output += chunk; });
    socket.once("error", error => (error as NodeJS.ErrnoException).code === "ECONNRESET" ? resolve(output) : reject(error));
    socket.once("close", () => resolve(output));
  });

  it.each(["{broken}\n", "[]\n", "\u00ff\n"])("rejects malformed frames without creating a message: %s", async (payload) => {
    incoming();
    expect(JSON.parse(await rawRequest(payload))).toEqual({ ok: false, code: "mailbox_request_denied" });
    expect(pending()).toBe(1);
  });

  it("bounds frame size and rejects multiple operations in one connection", async () => {
    incoming();
    expect(await rawRequest(Buffer.alloc(65_537, 65))).toBe("");
    const send = JSON.stringify(frame({ operation: "send", recipient: "peer", messageId: "smuggled", body: "payload" }));
    expect(JSON.parse(await rawRequest(send + "\n" + send + "\n"))).toEqual({ ok: false, code: "mailbox_request_denied" });
    expect(chat.countPendingMailbox({ ...ownScope, recipient: "peer" })).toBe(0);
    expect(pending()).toBe(1);
  });

  it.each([
    { operation: "send", recipient: "foreign", messageId: "out", body: "payload" },
    { operation: "reply", recipient: "peer", messageId: "out", body: "payload", replyTo: "missing" },
    { operation: "reply", recipient: "peer", messageId: "out", body: "payload", replyTo: "parent", capability: `mailbox:${"b".repeat(43)}` },
    { operation: "send", recipient: "peer", messageId: "out", body: "payload", attachment: [{ taskId: "other", runId: "run", artifactId: "x", hash: "sha256:x" }] },
    { limit: 101 }, { ready: true }, { promptState: "clear" }, { socketPath: "/tmp/other.sock" },
  ])("preserves durable state after a rejected operation: %j", async (fields) => {
    incoming();
    expect((await request(fields)).ok).toBe(false);
    expect(pending()).toBe(1);
    expect(chat.countPendingMailbox({ ...ownScope, recipient: "peer" })).toBe(0);
    expect(chat.getMailbox({ ...ownScope, messageId: "parent" }).receipt).toBeNull();
  });

  it("invalidates the endpoint after control admission is revoked", async () => {
    incoming(); current = false;
    expect(await request({})).toEqual({ ok: false, code: "mailbox_not_admitted" });
    current = true;
    expect(() => bridge.endpoint()).toThrow("mailbox_endpoint_invalid");
    expect(pending()).toBe(1);
  });

  it("does not readmit a socket after observing changed endpoint permissions", async () => {
    incoming(); chmodSync(bridge.binding.socketPath, 0o600);
    expect(() => bridge.endpoint()).toThrow("mailbox_endpoint_invalid");
    if (existsSync(bridge.binding.socketPath)) chmodSync(bridge.binding.socketPath, 0o666);
    expect(() => bridge.endpoint()).toThrow("mailbox_endpoint_invalid");
    expect(pending()).toBe(1);
  });

  it("rejects replaced endpoints and closes already-connected sockets on explicit revocation", async () => {
    incoming();
    const socket = createConnection(bridge.binding.socketPath);
    await once(socket, "connect");
    renameSync(bridge.binding.socketPath, bridge.binding.socketPath + ".replaced");
    writeFileSync(bridge.binding.socketPath, "not a socket");
    expect(() => bridge.endpoint()).toThrow("mailbox_endpoint_invalid");
    const closed = once(socket, "close");
    await bridge.close(); await closed;
    expect(pending()).toBe(1);
  });

  it("uses a new generation on rebind and rejects the previous request identity", async () => {
    incoming(); const old = frame(), binding = bridge.binding;
    await bridge.close();
    bridge = new WorkerMailboxBridge(binding, new MailboxDelivery(chat, () => prompt), chat, () => active, () => current);
    await bridge.listen();
    expect(bridge.generation).not.toBe(old.generation);
    expect(JSON.parse(await rawRequest(JSON.stringify(old) + "\n"))).toEqual({ ok: false, code: "mailbox_not_admitted" });
    expect(pending()).toBe(1);
  });

  it("bounds concurrent incomplete connections", async () => {
    const sockets = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const socket = createConnection(bridge.binding.socketPath);
        sockets.push(socket); await once(socket, "connect");
      }
      const extra = createConnection(bridge.binding.socketPath);
      sockets.push(extra);
      await once(extra, "close");
      expect(extra.destroyed).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  const prepareChannel = () => {
    channel = { client: "claude-code", clientVersion: "2.1.296",
      installedChannelDigest: "observed-fixture-digest", observedChannelDigest: "observed-fixture-digest" };
    incoming();
  };

  it("delivers context without consuming it and acknowledges only a previous handout", async () => {
    prepareChannel();
    expect((await request({ operation: "channel" })).result).toMatchObject({
      status: "delivered", messageIds: ["parent"], receipts: [],
      hookOutput: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: expect.stringContaining("peer context") } },
    });
    expect(pending()).toBe(1);
    expect((await request({ operation: "ack", acknowledgedMessageIds: ["parent"] })).result)
      .toMatchObject({ receipts: [{ messageId: "parent", consumedBy: worker.sessionId,
        consumedByProvenance: `worker-mailbox:${bridge.binding.attemptId}:${bridge.generation}` }], pendingCount: 0 });
    const receiptId = chat.getMailbox({ ...ownScope, messageId: "parent" }).receipt!.receiptId;
    expect((await request({ operation: "ack", acknowledgedMessageIds: ["parent"] })).result).toMatchObject({ rejectedMessageIds: ["parent"] });
    expect(chat.getMailbox({ ...ownScope, messageId: "parent" }).receipt!.receiptId).toBe(receiptId);
  });

  it("rejects fabricated acknowledgments and reissues unacknowledged context", async () => {
    prepareChannel();
    expect((await request({ operation: "ack", acknowledgedMessageIds: ["parent"] })).result)
      .toMatchObject({ receipts: [], rejectedMessageIds: ["parent"], messageIds: ["parent"] });
    expect((await request({ operation: "channel" })).result).toMatchObject({ receipts: [], messageIds: ["parent"] });
    expect(pending()).toBe(1);
  });

  it("drops handout rights when the same mailbox owner is rebound to a new endpoint generation", async () => {
    prepareChannel();
    await request({ operation: "channel" });
    const binding = bridge.binding;
    await bridge.close();
    bridge = new WorkerMailboxBridge(binding, delivery, chat, () => active, () => current);
    await bridge.listen();
    expect((await request({ operation: "ack", acknowledgedMessageIds: ["parent"] })).result)
      .toMatchObject({ receipts: [], rejectedMessageIds: ["parent"], messageIds: ["parent"] });
    expect(pending()).toBe(1);
  });

  it.each(["absent", "altered", "unadopted"])("holds native-channel messages when control configuration is %s", async (state) => {
    prepareChannel();
    if (state === "absent") channel = null;
    if (state === "altered") channel!.observedChannelDigest = "changed";
    if (state === "unadopted") channel!.clientVersion = "unknown";
    expect((await request({ operation: "channel" })).result).toMatchObject({ status: "pending", hookOutput: null, receipts: [] });
    expect(pending()).toBe(1);
  });

  it("rechecks the prompt at acknowledgment and holds a prompt race pending", async () => {
    prepareChannel(); await request({ operation: "channel" });
    let reads = 0;
    promptReader = () => ++reads === 1 ? "clear" : "blocked";
    expect((await request({ operation: "ack", acknowledgedMessageIds: ["parent"] })).result)
      .toMatchObject({ status: "pending", reason: "prompt_not_clear", receipts: [] });
    expect(chat.getMailbox({ ...ownScope, messageId: "parent" }).receipt).toBeNull();
    expect(pending()).toBe(1);
  });

  it.each([null, "parent", [42], Array(101).fill("parent")])("rejects malformed or oversized acknowledgment lists: %j", async (ids) => {
    prepareChannel(); await request({ operation: "channel" });
    expect((await request({ operation: "ack", acknowledgedMessageIds: ids })).ok).toBe(false);
    expect(pending()).toBe(1);
  });

  const relayPath = fileURLToPath(new URL("../assets/managed-native-channel-relay.cjs", import.meta.url));
  const relayRoot = () => join(directory, "home", ".multi-agent", "mailbox");
  const prepareRelay = () => {
    mkdirSync(relayRoot(), { recursive: true, mode: 0o700 });
    const { operation: _operation, ...bootstrap } = frame();
    writeFileSync(join(relayRoot(), "bootstrap.json"), JSON.stringify(bootstrap), { mode: 0o600 });
  };
  const runRelay = (event: unknown = { hook_event_name: "PostToolUse" }, interruptOutput = false) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/home", "--bind", join(directory, "home"), "/home/worker",
        "--tmpfs", "/run", "--dir", "/run/multi-agent", "--ro-bind", bridge.binding.socketPath, "/run/multi-agent/mailbox.sock",
        "--ro-bind", relayPath, "/run/multi-agent/channel-relay.cjs",
        "--", process.execPath, "/run/multi-agent/channel-relay.cjs"], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("relay fixture timed out")); }, 4_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      if (interruptOutput) child.stdout.destroy();
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(event));
      child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });

  it("runs the fixed-path relay and acknowledges context only at the next tool boundary", async () => {
    prepareChannel(); prepareRelay();
    const first = await runRelay();
    expect(first.code).toBe(0); expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: "PostToolUse", additionalContext: expect.stringContaining("peer context"),
    } });
    expect(pending()).toBe(1);
    const statePath = join(relayRoot(), "handouts.json");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ generation: bridge.generation, messageIds: ["parent"] });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const second = await runRelay();
    expect(second).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    expect(pending()).toBe(0);
    expect(chat.getMailbox({ ...ownScope, messageId: "parent" }).receipt?.consumedBy).toBe(worker.sessionId);
    expect(readFileSync(statePath, "utf8")).not.toContain("worker-fixture");
    expect(readFileSync(statePath, "utf8")).not.toContain("peer context");
  });

  it("redelivers after the relay stdout pipe is interrupted without recording an acknowledgment", async () => {
    prepareChannel(); prepareRelay();
    const interrupted = await runRelay(undefined, true);
    expect(interrupted.code).toBe(0);
    expect(interrupted.stderr).toBe("Mailbox context remains pending.\n");
    expect(existsSync(join(relayRoot(), "handouts.json"))).toBe(false);
    expect(chat.getMailbox({ ...ownScope, messageId: "parent" }).receipt).toBeNull();
    const retry = await runRelay();
    expect(retry.code).toBe(0); expect(retry.stdout).toContain("peer context");
    expect(pending()).toBe(1);
    await runRelay();
    expect(pending()).toBe(0);
  });

  it("retains prior relay handouts through a prompt race instead of consuming or approving", async () => {
    prepareChannel(); prepareRelay(); await runRelay();
    let reads = 0;
    promptReader = () => ++reads === 1 ? "clear" : "blocked";
    const held = await runRelay();
    expect(held).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    expect(JSON.parse(readFileSync(join(relayRoot(), "handouts.json"), "utf8")).messageIds).toEqual(["parent"]);
    expect(chat.getMailbox({ ...ownScope, messageId: "parent" }).receipt).toBeNull();
    promptReader = () => "clear";
    expect((await runRelay()).stdout).toBe("{}\n");
    expect(pending()).toBe(0);
  });

  it.each(["malformed", "public", "stale-generation"])("keeps messages pending with %s relay bootstrap", async kind => {
    prepareChannel(); prepareRelay();
    const bootstrapPath = join(relayRoot(), "bootstrap.json");
    if (kind === "malformed") writeFileSync(bootstrapPath, "{");
    if (kind === "public") chmodSync(bootstrapPath, 0o644);
    if (kind === "stale-generation") writeFileSync(bootstrapPath, JSON.stringify(frame({ generation: "retired" })));
    const result = await runRelay();
    expect(result).toEqual({ code: 0, stdout: "", stderr: "Mailbox context remains pending.\n" });
    expect(existsSync(join(relayRoot(), "handouts.json"))).toBe(false);
    expect(pending()).toBe(1);
  });

  it("does not acknowledge stale consumer state even when this daemon has handed out that message", async () => {
    prepareChannel(); prepareRelay(); await request({ operation: "channel" });
    writeFileSync(join(relayRoot(), "handouts.json"), JSON.stringify({ generation: "retired", messageIds: ["parent"] }), { mode: 0o600 });
    expect((await runRelay()).stdout).toContain("peer context");
    expect(pending()).toBe(1);
  });

  it("ignores non-tool events without reading the bootstrap or emitting a user turn", async () => {
    prepareChannel(); prepareRelay();
    rmSync(join(relayRoot(), "bootstrap.json"));
    expect(await runRelay({ hook_event_name: "PermissionRequest", prompt: "approve" }))
      .toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    expect(existsSync(join(relayRoot(), "handouts.json"))).toBe(false);
    expect(pending()).toBe(1);
  });

});
