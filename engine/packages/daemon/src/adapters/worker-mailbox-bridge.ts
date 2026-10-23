import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createServer, type Socket } from "node:net";
import { object, text } from "../contracts/team-control.js";
import { ChatRepository, ChatRepositoryError } from "../domain/chat-repository.js";
import { MailboxDelivery, MailboxDeliveryError } from "../domain/mailbox-delivery.js";
import { resolveTeamControlCredential, type TeamControlCredentials } from "../middleware/auth-bearer-token.js";

export interface WorkerMailboxBinding {
  socketPath: string;
  workerId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
  rigId: string;
  taskId: string;
  recipients: readonly string[];
  /**
   * The recipient's own mailbox capability — the secret its poll and consume are scoped
   * by, not a per-endpoint nonce. `poll` matches on `message.capability === scope.capability`,
   * and a message's capability is whatever its sender chose, so minting a fresh one here
   * would leave the worker's mailbox permanently unreadable.
   */
  capability: string;
}

const MAX_FRAME_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_CONNECTIONS = 8;
const REQUEST_FIELDS = new Set(["authorization", "sessionId", "runId", "attemptId", "generation",
  "operation", "taskId", "recipient", "capability", "body", "messageId", "replyTo", "attachment", "limit", "acknowledgedMessageIds"]);

export class WorkerMailboxBridge {
  readonly generation = randomUUID();
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((socket) => this.accept(socket));
  private socketIdentity: { dev: number; ino: number; uid: number; gid: number } | null = null;
  private closed = false;
  private invalid = false;
  private closing: Promise<void> | null = null;

  constructor(
    readonly binding: WorkerMailboxBinding,
    private readonly delivery: MailboxDelivery,
    private readonly chat: ChatRepository,
    private readonly readCredentials: () => TeamControlCredentials,
    private readonly isCurrent: () => boolean,
    private readonly legacyTokens: readonly (string | null | undefined)[] = [],
  ) {
    this.binding = Object.freeze({ ...binding, recipients: Object.freeze([...binding.recipients]) });
    this.server.on("error", () => { void this.close(); });
  }

  async listen(): Promise<void> {
    this.checkDirectory();
    if (this.closed || this.server.listening) throw new Error("mailbox_endpoint_invalid");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.binding.socketPath, () => {
        this.server.removeListener("error", reject);
        if (this.closed) { this.server.close(() => reject(new Error("mailbox_endpoint_invalid"))); return; }
        resolve();
      });
    });
    try {
      // The private control-owned directory prevents host-side discovery and replacement.
      // Only the individually bound socket is exposed inside this attempt's namespace.
      chmodSync(this.binding.socketPath, 0o666);
      const stat = lstatSync(this.binding.socketPath);
      if (!stat.isSocket() || stat.uid !== process.getuid!() || stat.gid !== process.getgid!()) {
        throw new Error("mailbox_endpoint_invalid");
      }
      this.socketIdentity = { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid };
      this.endpoint();
      this.writeBootstrap();
      this.delivery.invalidateNativeChannel({ rigId: this.binding.rigId, recipient: this.binding.sessionId,
        taskId: this.binding.taskId, runId: this.binding.runId });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  endpoint() {
    try {
      this.checkDirectory();
      const stat = lstatSync(this.binding.socketPath);
      if (this.closed || this.invalid || !this.server.listening || !stat.isSocket() || !this.socketIdentity
        || stat.dev !== this.socketIdentity.dev || stat.ino !== this.socketIdentity.ino
        || stat.uid !== this.socketIdentity.uid || stat.gid !== this.socketIdentity.gid || (stat.mode & 0o7777) !== 0o666) {
        throw new Error("mailbox_endpoint_invalid");
      }
      return Object.freeze({ path: this.binding.socketPath, ...this.socketIdentity, generation: this.generation });
    } catch {
      this.invalid = true;
      void this.close();
      throw new Error("mailbox_endpoint_invalid");
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.removeBootstrap();
    this.delivery.invalidateNativeChannel({ rigId: this.binding.rigId, recipient: this.binding.sessionId,
      taskId: this.binding.taskId, runId: this.binding.runId });
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.closing = this.server.listening ? new Promise<void>((resolve) => this.server.close(() => resolve())) : Promise.resolve();
    return this.closing;
  }

  /**
   * T042 — the private bootstrap the privileged launcher binds into the attempt.
   *
   * The launcher will not mount a mailbox without it: `worker-launch.mjs` requires
   * `bootstrap.json` beside the socket, mode 0600, at most 8192 bytes, carrying exactly
   * these seven string fields, with the socket directory already proven control-owned and
   * 0700. So the writer lives here, where that directory has just been checked.
   *
   * `authorization` is the worker credential the endpoint authenticates with, not a
   * placeholder: the relay copies it verbatim into the request and `dispatch` hands it to
   * `resolveTeamControlCredential`, which accepts only `Bearer <token>` for a token this
   * daemon was configured with. The plan requires transport bootstrap material to use the
   * existing worker-credential authority, so the value comes from the caller's own
   * credential source and never from a constant this file chooses.
   */
  private writeBootstrap(): void {
    const source = join(dirname(this.binding.socketPath), "bootstrap.json");
    const token = this.workerToken();
    if (!token) throw new Error("mailbox_bootstrap_credential_unavailable");
    const body = JSON.stringify({ authorization: `Bearer ${token}`, sessionId: this.binding.sessionId,
      runId: this.binding.runId, attemptId: this.binding.attemptId, generation: this.generation,
      taskId: this.binding.taskId, capability: this.binding.capability });
    // Written 0600 from the start: a create-then-chmod would leave one window in
    // which the file is readable by whatever shares this directory.
    writeFileSync(source, body, { mode: 0o600, flag: "w" });
    chmodSync(source, 0o600);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.gid !== process.getgid!()
      || (stat.mode & 0o7777) !== 0o600 || stat.size > 8_192) {
      this.removeBootstrap();
      throw new Error("mailbox_bootstrap_invalid");
    }
  }

  /** The credential this attempt's seat is registered with, if the daemon has one. */
  private workerToken(): string | null {
    try {
      const worker = this.readCredentials().workers?.find(candidate =>
        candidate.sessionId === this.binding.sessionId && candidate.runId === this.binding.runId);
      return worker?.token?.trim() ? worker.token : null;
    } catch { return null; }
  }

  private removeBootstrap(): void {
    try { unlinkSync(join(dirname(this.binding.socketPath), "bootstrap.json")); } catch { /* Absent is already closed. */ }
  }

  private checkDirectory(): void {
    const path = this.binding.socketPath, parent = dirname(path), stat = lstatSync(parent);
    if (!isAbsolute(path) || basename(path) !== "mailbox.sock" || realpathSync(parent) !== parent
      || !stat.isDirectory() || stat.uid !== process.getuid!() || stat.gid !== process.getgid!()
      || (stat.mode & 0o7777) !== 0o700) throw new Error("mailbox_endpoint_invalid");
  }

  private accept(socket: Socket): void {
    if (this.closed || this.invalid || this.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
    let pending: Buffer = Buffer.alloc(0), handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) { socket.destroy(); return; }
      if (pending.length + chunk.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(10);
      if (newline < 0) return;
      handled = true;
      let response: unknown;
      try {
        if (newline !== pending.length - 1) throw new Error("mailbox_frame_invalid");
        const frame = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline));
        response = { ok: true, result: this.dispatch(JSON.parse(frame)) };
      } catch (error) {
        const code = error instanceof MailboxDeliveryError || error instanceof ChatRepositoryError
          ? error.code : "mailbox_request_denied";
        response = { ok: false, code };
      }
      pending = Buffer.alloc(0);
      const output = JSON.stringify(response) + "\n";
      if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES) { socket.destroy(); return; }
      socket.end(output, () => { if (this.invalid) void this.close(); });
    });
  }

  private dispatch(raw: unknown): unknown {
    const request = object(raw, "mailbox.request");
    const auth = resolveTeamControlCredential(typeof request.authorization === "string" ? request.authorization : undefined,
      this.readCredentials(), this.legacyTokens);
    if (!auth.ok) throw new MailboxDeliveryError(auth.code, auth.error);
    const binding = this.binding;
    if (auth.actor.kind !== "worker" || auth.actor.sessionId !== binding.sessionId || auth.runId !== binding.runId
      || request.sessionId !== binding.sessionId || request.runId !== binding.runId || request.attemptId !== binding.attemptId
      || request.taskId !== binding.taskId || request.generation !== this.generation) {
      throw new MailboxDeliveryError("mailbox_not_admitted", "The active worker attempt must match.");
    }
    let current = false;
    try { current = this.isCurrent(); } catch { /* Missing control evidence closes this generation. */ }
    if (!current) {
      this.invalid = true;
      throw new MailboxDeliveryError("mailbox_not_admitted", "The active worker attempt must match.");
    }
    this.endpoint();
    if (Object.keys(request).some(key => !REQUEST_FIELDS.has(key))) throw new Error("mailbox_request_invalid");
    const capability = text(request.capability, "capability");
    const scope = { rigId: binding.rigId, recipient: binding.sessionId, taskId: binding.taskId, runId: binding.runId, capability };
    if (request.operation === "poll" || request.operation === "channel" || request.operation === "ack") {
      if (request.recipient !== undefined && request.recipient !== binding.sessionId) throw new Error("mailbox_request_invalid");
      if (request.operation === "poll") {
        if (request.acknowledgedMessageIds !== undefined) throw new Error("mailbox_request_invalid");
        return this.delivery.poll({ ...scope, limit: request.limit as number | undefined });
      }
      const ids = request.acknowledgedMessageIds === undefined ? [] : request.acknowledgedMessageIds;
      if (!Array.isArray(ids) || ids.length > 100) throw new Error("mailbox_request_invalid");
      const acknowledgedMessageIds = ids.map(id => text(id, "acknowledgedMessageId"));
      return this.delivery.deliverToNativeChannel({ ...scope, deliveryGeneration: this.generation,
        acknowledgedMessageIds, consumedBy: auth.actor.sessionId,
        consumedByProvenance: `worker-mailbox:${binding.attemptId}:${this.generation}`,
        limit: request.limit as number | undefined });
    }
    if (request.operation !== "send" && request.operation !== "reply") throw new Error("mailbox_operation_invalid");
    const recipient = text(request.recipient, "recipient");
    if (!binding.recipients.includes(recipient)) throw new MailboxDeliveryError("mailbox_not_admitted", "Recipient is outside the assignment.");
    const replyTo = request.operation === "reply" ? text(request.replyTo, "replyTo") : undefined;
    if (replyTo) {
      const parent = this.chat.getMailbox({ ...scope, messageId: replyTo });
      if (parent.sender !== recipient) throw new MailboxDeliveryError("mailbox_not_admitted", "Reply recipient must match the original sender.");
    } else if (request.replyTo !== undefined) throw new Error("mailbox_request_invalid");
    return this.delivery.send({ rigId: binding.rigId, sender: auth.actor.sessionId, recipient, taskId: binding.taskId,
      runId: binding.runId, body: request.body as string, messageId: text(request.messageId, "messageId"),
      replyTo, attachment: request.attachment, capability });
  }
}
