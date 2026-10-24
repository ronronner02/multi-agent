import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface OwnerTerminalSubscriber {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface OwnerTerminalAttachment {
  sendInput(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface OwnerTerminalRelay {
  isAvailable(): Promise<boolean>;
  attach(subscriber: OwnerTerminalSubscriber): Promise<OwnerTerminalAttachment>;
}

export interface OwnerTerminalTransport {
  start(onOutput: (data: string) => void, onClose: (reason?: string) => void): Promise<void>;
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface OwnerTerminalHostOptions {
  socketPath: string;
  token?: string;
  ownerUid: number;
  transportFactory?: () => OwnerTerminalTransport;
  mode?: number;
}

type HostFrame =
  | { type: "hello"; token: string }
  | { type: "input"; data: string }
  | { type: "close" };

type ClientFrame =
  | { type: "ready" }
  | { type: "output"; data: string }
  | { type: "unavailable"; reason: string }
  | { type: "closed"; reason?: string };

function encode(frame: ClientFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

function decodeLine(line: string): HostFrame | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type === "hello" && typeof value.token === "string") return { type: "hello", token: value.token };
    if (value.type === "input" && typeof value.data === "string") return { type: "input", data: value.data };
    if (value.type === "close") return { type: "close" };
  } catch { /* malformed frames are closed by the caller */ }
  return null;
}

function decodeClientFrame(line: string): ClientFrame | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type === "ready") return { type: "ready" };
    if (value.type === "output" && typeof value.data === "string") return { type: "output", data: value.data };
    if (value.type === "unavailable" && typeof value.reason === "string") return { type: "unavailable", reason: value.reason };
    if (value.type === "closed") return { type: "closed", ...(typeof value.reason === "string" ? { reason: value.reason } : {}) };
  } catch { /* malformed frames are ignored */ }
  return null;
}

/**
 * Owner-account process endpoint. It only relays to a transport supplied by
 * the owner process; it never imports child_process or creates a fallback
 * shell. The socket and token live outside daemon storage.
 */
export class OwnerTerminalHost {
  readonly socketPath: string;
  readonly token: string;
  private readonly ownerUid: number;
  private readonly transportFactory?: () => OwnerTerminalTransport;
  private readonly mode: number;
  private server: Server | null = null;
  private activeTransport: OwnerTerminalTransport | null = null;

  constructor(options: OwnerTerminalHostOptions) {
    this.socketPath = options.socketPath;
    this.token = options.token ?? randomBytes(32).toString("base64url");
    this.ownerUid = options.ownerUid;
    this.transportFactory = options.transportFactory;
    this.mode = options.mode ?? 0o600;
  }

  get running(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (!Number.isSafeInteger(this.ownerUid) || typeof process.getuid !== "function" || process.getuid() !== this.ownerUid) {
      throw new Error("owner_terminal_owner_identity_mismatch");
    }
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await this.removeStaleSocket();

    const server = createServer(socket => { void this.handle(socket); });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
    await chmod(this.socketPath, this.mode);
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    await this.activeTransport?.close().catch(() => {});
    this.activeTransport = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(this.socketPath).catch(() => {});
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      const info = await lstat(this.socketPath);
      if (!info.isSocket()) throw new Error("owner_terminal_socket_path_not_socket");
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async handle(socket: Socket): Promise<void> {
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    let transport: OwnerTerminalTransport | null = null;
    const send = (frame: ClientFrame) => { try { socket.write(encode(frame)); } catch { /* closed */ } };
    const close = async (reason = "owner terminal closed") => {
      await transport?.close().catch(() => {});
      if (this.activeTransport === transport) this.activeTransport = null;
      send({ type: "closed", reason });
      socket.end();
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const frame = decodeLine(line);
        if (!frame) { void close("invalid owner terminal frame"); return; }
        if (!authenticated) {
          if (frame.type !== "hello" || frame.token !== this.token) { void close("owner terminal authentication failed"); return; }
          if (!this.transportFactory) { send({ type: "unavailable", reason: "owner terminal host transport unavailable" }); void close("owner terminal unavailable"); return; }
          authenticated = true;
          transport = this.transportFactory();
          this.activeTransport = transport;
          void transport.start(data => send({ type: "output", data }), reason => { void close(reason); })
            .then(() => send({ type: "ready" }))
            .catch(() => { send({ type: "unavailable", reason: "owner terminal transport unavailable" }); void close("owner terminal unavailable"); });
          continue;
        }
        if (frame.type === "input") { void transport?.write(frame.data); }
        else if (frame.type === "close") { void close(); }
      }
    });
    socket.on("error", () => { void transport?.close().catch(() => {}); });
    socket.on("close", () => { void transport?.close().catch(() => {}); });
  }
}

export interface OwnerTerminalHostClientOptions {
  socketPath: string;
  token: string;
  connectTimeoutMs?: number;
}

/** Daemon-side relay client. It carries only owner terminal bytes over the private socket. */
export class OwnerTerminalHostClient implements OwnerTerminalRelay {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly connectTimeoutMs: number;

  constructor(options: OwnerTerminalHostClientOptions) {
    this.socketPath = options.socketPath;
    this.token = options.token;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 1000;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const info = await lstat(this.socketPath);
      return info.isSocket();
    } catch {
      return false;
    }
  }

  async attach(subscriber: OwnerTerminalSubscriber): Promise<OwnerTerminalAttachment> {
    const socket = await this.open();
    let buffer = "";
    let ready = false;
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;
    const readyPromise = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    socket.setEncoding("utf8");
    const close = (code: number, reason: string) => {
      try { subscriber.close(code, reason); } catch { /* closed */ }
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const frame = decodeClientFrame(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        if (!frame) continue;
        if (frame.type === "ready") { ready = true; readyResolve?.(); }
        else if (frame.type === "output") { subscriber.send(frame.data); }
        else if (frame.type === "unavailable") { readyReject?.(new Error(frame.reason)); close(1013, frame.reason); }
        else if (frame.type === "closed") { if (!ready) readyReject?.(new Error(frame.reason ?? "owner terminal closed")); close(1000, frame.reason ?? "owner terminal closed"); }
      }
    });
    socket.on("error", error => { if (!ready) readyReject?.(error); else close(1011, "owner terminal host disconnected"); });
    socket.write(`${JSON.stringify({ type: "hello", token: this.token })}\n`);
    await readyPromise;

    let closed = false;
    return {
      sendInput: async (data: string) => {
        if (closed) return;
        socket.write(`${JSON.stringify({ type: "input", data })}\n`);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        socket.write(`${JSON.stringify({ type: "close" })}\n`);
        socket.end();
      },
    };
  }

  private open(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("owner_terminal_unavailable")); }, this.connectTimeoutMs);
      timer.unref?.();
      socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
      socket.once("error", error => {
        clearTimeout(timer);
        reject(Object.assign(new Error("owner_terminal_unavailable"), { cause: error }));
      });
    });
  }
}
