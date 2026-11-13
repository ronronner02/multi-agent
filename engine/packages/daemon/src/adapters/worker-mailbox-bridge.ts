import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { object, text } from "../contracts/team-control.js";
import { ChatRepository, ChatRepositoryError } from "../domain/chat-repository.js";
import { MailboxDelivery, MailboxDeliveryError } from "../domain/mailbox-delivery.js";
import { mailboxEndpoint } from "../domain/mailbox-endpoint.js";
import { hostPlatform, type HostPlatform } from "../domain/platform.js";
import { resolveTeamControlCredential, type TeamControlCredentials } from "../middleware/auth-bearer-token.js";

export interface WorkerMailboxBinding {
  /**
   * The attempt's control-private mailbox directory. The endpoint this bridge serves is derived
   * from it: a `mailbox.sock` file on POSIX, a named pipe on Windows.
   */
  directory: string;
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
  readonly generation: string;
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((socket) => this.accept(socket));
  private readonly transport: HostPlatform;
  private readonly descriptor: ReturnType<typeof mailboxEndpoint>;
  private socketIdentity: { dev: number; ino: number; uid: number; gid: number } | null = null;
  private closed = false;
  private invalid = false;
  private bootstrapped = false;
  private closing: Promise<void> | null = null;

  constructor(
    readonly binding: WorkerMailboxBinding,
    private readonly delivery: MailboxDelivery,
    private readonly chat: ChatRepository,
    private readonly readCredentials: () => TeamControlCredentials,
    private readonly isCurrent: () => boolean,
    private readonly legacyTokens: readonly (string | null | undefined)[] = [],
    /** The host's transport and generation are overridable so a test can drive either branch. */
    transport: HostPlatform = hostPlatform(),
    generation: string = randomUUID(),
  ) {
    this.binding = Object.freeze({ ...binding, recipients: Object.freeze([...binding.recipients]) });
    this.transport = transport;
    this.generation = generation;
    this.descriptor = mailboxEndpoint(binding.directory, this.generation, transport);
    this.server.on("error", () => { void this.close(); });
  }

  async listen(): Promise<void> {
    this.checkDirectory();
    if (this.closed || this.server.listening) throw new Error("mailbox_endpoint_invalid");
    const target = this.descriptor.path;
    // A Windows pipe name is global to the machine, so a name that is already served may belong
    // to another process entirely. Node refuses such a listen with `EADDRINUSE` (a Node server)
    // or `EBUSY` (any other pipe server), and either is a collision: nothing here retries,
    // unlinks or writes over it. The probe below is what turns "somebody else answers" into a
    // refusal instead of a rotation the caller could mistake for a fresh endpoint.
    if (this.descriptor.transport === "pipe" && await this.pipeIsServed(target)) {
      throw new Error("mailbox_endpoint_in_use");
    }
    // Node's own listen reports a collision asynchronously through the server's `error` event,
    // which the constructor already turns into `close()`; a duplicate would otherwise resolve
    // `listen()` on a name another bridge owns. The generation makes that comparison exact.
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(target, () => {
        this.server.removeListener("error", reject);
        if (this.closed) { this.server.close(() => reject(new Error("mailbox_endpoint_invalid"))); return; }
        resolve();
      });
    });
    try {
      if (this.transport === "posix") {
        // The private control-owned directory prevents host-side discovery and replacement.
        // Only the individually bound socket is exposed inside this attempt's namespace.
        chmodSync(target, 0o666);
        const stat = lstatSync(target);
        if (!stat.isSocket() || stat.uid !== process.getuid!() || stat.gid !== process.getgid!()) {
          throw new Error("mailbox_endpoint_invalid");
        }
        this.socketIdentity = { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid };
      }
      this.endpoint();
      this.writeBootstrap();
      this.delivery.invalidateNativeChannel({ rigId: this.binding.rigId, recipient: this.binding.sessionId,
        taskId: this.binding.taskId, runId: this.binding.runId });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * The endpoint the launcher and the worker are told to reach.
   *
   * A POSIX endpoint carries the socket file's dev/ino and owner, re-read on every call, so a
   * replaced socket or a loosened mode closes this bridge. A pipe has no file to stat: its
   * identity is the name, and the name stays bound to this server for as long as it listens,
   * so a server that is still listening (and neither closed nor invalidated) owns it.
   */
  endpoint() {
    if (this.descriptor.transport === "pipe") {
      if (!this.closed && !this.invalid && this.server.listening) {
        return Object.freeze({ transport: "pipe" as const, path: this.descriptor.path, generation: this.generation });
      }
      this.invalid = true;
      void this.close();
      throw new Error("mailbox_endpoint_invalid");
    }
    try {
      this.checkDirectory();
      const stat = lstatSync(this.descriptor.path);
      if (this.closed || this.invalid || !this.server.listening || !stat.isSocket() || !this.socketIdentity
        || stat.dev !== this.socketIdentity.dev || stat.ino !== this.socketIdentity.ino
        || stat.uid !== this.socketIdentity.uid || stat.gid !== this.socketIdentity.gid || (stat.mode & 0o7777) !== 0o666) {
        throw new Error("mailbox_endpoint_invalid");
      }
      return Object.freeze({ transport: "unix" as const, path: this.descriptor.path, ...this.socketIdentity,
        generation: this.generation });
    } catch {
      this.invalid = true;
      void this.close();
      throw new Error("mailbox_endpoint_invalid");
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Only the bridge that wrote the bootstrap may remove it. A bridge refused before it ever
    // listened — an endpoint already served by another one, most importantly — shares the
    // directory of the bridge that is live there, and cleaning up unconditionally would take
    // that one's bootstrap away from its worker.
    if (this.bootstrapped) this.removeBootstrap();
    this.delivery.invalidateNativeChannel({ rigId: this.binding.rigId, recipient: this.binding.sessionId,
      taskId: this.binding.taskId, runId: this.binding.runId });
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    // Closing the server is the whole cleanup on both transports: libuv unlinks the socket file
    // it created, and a pipe stops existing when its server closes.
    this.closing = this.server.listening
      ? new Promise<void>((resolve) => this.server.close(() => resolve()))
      : Promise.resolve();
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
   * `endpoint` is the transport-specific connect target: a socket path on POSIX, a pipe name
   * on Windows. A client connects to this value verbatim, so a worker on either host reaches
   * the same mailbox without deriving a path of its own.
   *
   * `authorization` is the worker credential the endpoint authenticates with, not a
   * placeholder: the relay copies it verbatim into the request and `dispatch` hands it to
   * `resolveTeamControlCredential`, which accepts only `Bearer <token>` for a token this
   * daemon was configured with. The plan requires transport bootstrap material to use the
   * existing worker-credential authority, so the value comes from the caller's own
   * credential source and never from a constant this file chooses.
   */
  private writeBootstrap(): void {
    const source = this.descriptor.bootstrapPath;
    const token = this.workerToken();
    if (!token) throw new Error("mailbox_bootstrap_credential_unavailable");
    // A Windows worker connects to the pipe named here. The POSIX file keeps exactly the seven
    // fields the privileged launcher requires (`worker-launch.mjs` refuses any other count), and
    // its worker-visible endpoint is the sandbox's fixed mount target rather than a host path.
    const body = JSON.stringify({ authorization: `Bearer ${token}`,
      ...(this.descriptor.transport === "pipe" ? { endpoint: this.descriptor.path } : {}),
      sessionId: this.binding.sessionId, runId: this.binding.runId, attemptId: this.binding.attemptId,
      generation: this.generation, taskId: this.binding.taskId, capability: this.binding.capability });
    // Written 0600 from the start: a create-then-chmod would leave one window in
    // which the file is readable by whatever shares this directory.
    writeFileSync(source, body, { mode: 0o600, flag: "w" });
    this.bootstrapped = true;
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_192
      || (this.transport === "posix" && (stat.uid !== process.getuid!() || stat.gid !== process.getgid!()
        || (stat.mode & 0o7777) !== 0o600))) {
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
    try { unlinkSync(this.descriptor.bootstrapPath); } catch { /* Absent is already closed. */ }
  }

  /**
   * Whether some process already serves a pipe of this name.
   *
   * A `net` client answers `ENOENT` when nothing serves the name and connects when something
   * does; that is the only portable question a Node process can ask about a pipe another
   * process owns. Every other answer counts as taken: a refusal this cannot explain must not
   * become a listen over somebody else's pipe.
   */
  private pipeIsServed(target: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection(target);
      const settle = (served: boolean) => {
        socket.removeAllListeners();
        socket.on("error", () => { /* A socket finished with by the answer is done either way. */ });
        socket.destroy();
        resolve(served);
      };
      socket.once("connect", () => settle(true));
      socket.once("error", (error: NodeJS.ErrnoException) => settle(error.code !== "ENOENT"));
      socket.setTimeout(2_000, () => settle(true));
    });
  }

  /**
   * The mailbox directory this endpoint's bootstrap lives in.
   *
   * POSIX keeps the original contract exactly: a canonical, control-owned, 0700 directory,
   * which is what the privileged launcher walks and checks. Windows can prove only that the
   * entry is a real directory and not a reparse point — a junction would redirect the bootstrap
   * somewhere else — because it has no uid/gid or permission bits to compare.
   */
  private checkDirectory(): void {
    const directory = this.binding.directory, stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("mailbox_endpoint_invalid");
    if (this.transport === "posix") {
      if (realpathSync(directory) !== directory || stat.uid !== process.getuid!() || stat.gid !== process.getgid!()
        || (stat.mode & 0o7777) !== 0o700) throw new Error("mailbox_endpoint_invalid");
    }
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