import type { Hono } from "hono";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { constantTimeEqual } from "../middleware/auth-bearer-token.js";
import {
  TerminalBrokerRegistry,
  type BrokerTmux,
  type TerminalSessionBroker,
  type TerminalSubscriber,
} from "../terminal/TerminalSessionBroker.js";
import type { TeamControlCredentials } from "../middleware/auth-bearer-token.js";
import { TerminalTakeoverManager } from "../domain/terminal-takeover.js";
import type { OwnerTerminalRelay, OwnerTerminalAttachment } from "../terminal/owner-terminal-host.js";

const MAX_EARLY_TERMINAL_FRAMES = 32;
const MAX_EARLY_TERMINAL_FRAME_BYTES = 256 * 1024;

/** Terminal bearer authentication; server.ts applies the shared browser boundary before this route. */
export interface TerminalActor {
  kind: "owner" | "worker" | "terminal";
  sessionId: string;
  runId?: string | null;
}

export interface TerminalAuthOptions {
  bearerToken: string | null;
  managed?: boolean;
  credentials?: TeamControlCredentials;
  allowPairedOwner?: boolean;
}

function contextActor(c: { get?: (key: string) => unknown }): TerminalActor | null {
  const actor = c.get?.("ownerCookieActor") as { kind?: string; sessionId?: string } | undefined;
  return actor?.kind === "owner" && actor.sessionId ? { kind: "owner", sessionId: actor.sessionId } : null;
}

function bearerActor(token: string, opts: TerminalAuthOptions): TerminalActor | null {
  if (opts.bearerToken && constantTimeEqual(token, opts.bearerToken)) return { kind: "terminal", sessionId: "terminal-bearer" };
  const credentials = opts.credentials;
  if (!credentials) return null;
  if (credentials.ownerToken && constantTimeEqual(token, credentials.ownerToken)) return { kind: "owner", sessionId: "owner-control" };
  const worker = credentials.workers?.find(candidate => constantTimeEqual(token, candidate.token));
  return worker ? { kind: "worker", sessionId: worker.sessionId, runId: worker.runId } : null;
}

export function terminalAuthMiddleware(opts: TerminalAuthOptions) {
  return async (c: { get?: (key: string) => unknown; set?: (key: string, value: unknown) => void; req: { header(name: string): string | undefined; query(name: string): string | undefined }; json(data: unknown, status: number): unknown }, next: () => Promise<void>) => {
    const token = opts.bearerToken;
    if (opts.allowPairedOwner) {
      const paired = contextActor(c);
      if (paired) {
        c.set?.("terminalActor", paired);
        await next();
        return;
      }
    }
    const header = c.req.header("Authorization") ?? c.req.header("authorization");
    if (header) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      const actor = match ? bearerActor(match[1]!.trim(), opts) : null;
      if (actor) {
        c.set?.("terminalActor", actor);
        await next();
        return;
      }
      return c.json({ error: "unauthorized" }, 401);
    }
    const queryToken = c.req.query("token");
    if (!opts.managed && queryToken && token && constantTimeEqual(queryToken.trim(), token)) {
      c.set?.("terminalActor", { kind: "terminal", sessionId: "terminal-bearer" });
      await next();
      return;
    }
    const hasDedicatedCredentials = !!opts.credentials?.ownerToken || (opts.credentials?.workers?.length ?? 0) > 0;
    if (!opts.managed && !token && !hasDedicatedCredentials) { await next(); return; }
    return c.json({ error: "unauthorized", hint: "Pass terminal token via Authorization header" }, 401);
  };
}

/** With the web UI off the WebSocket is not registered, but this same guard still runs in front of the HTTP
 *  terminal routes it matched before (GET /api/terminal/views, /preview, /status), so their behaviour is unchanged. */
export function registerTerminalAuthOnly(app: Hono, opts: TerminalAuthOptions): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get("/api/terminal/:sessionName", terminalAuthMiddleware(opts));
}

export function registerTerminalWs(
  app: Hono,
  upgradeWebSocket: Parameters<typeof import("@hono/node-ws").createNodeWebSocket>[0] extends { app: infer _A } ? never : never,
  opts: TerminalAuthOptions & {
    livenessIntervalMs?: number;
    takeoverManager?: TerminalTakeoverManager;
    ownerTerminalHost?: OwnerTerminalRelay;
  },
): void;
export function registerTerminalWs(
  app: Hono,
  upgradeWebSocket: (createHandler: (c: unknown) => unknown) => unknown,
  opts: TerminalAuthOptions & {
    livenessIntervalMs?: number;
    takeoverManager?: TerminalTakeoverManager;
    ownerTerminalHost?: OwnerTerminalRelay;
  },
): void {
  const terminalAuth = terminalAuthMiddleware(opts);
  const takeovers = opts.takeoverManager ?? new TerminalTakeoverManager();

  // One daemon-owned broker registry shared across every WebSocket connection,
  // created lazily from the first connection's tmux adapter (a daemon
  // singleton). This is what makes many viewers of one seat share ONE pipe and
  // a fanned-out stream instead of fighting over per-connection pipes.
  let registry: TerminalBrokerRegistry | null = null;
  const getRegistry = (tmux: BrokerTmux): TerminalBrokerRegistry => {
    if (!registry) {
      registry = new TerminalBrokerRegistry(tmux, { livenessMs: opts.livenessIntervalMs });
    }
    return registry;
  };

  const createOwnerTerminalHandler = (c: any) => {
    let attachment: OwnerTerminalAttachment | null = null;
    let closed = false;
    return {
      async onOpen(_evt: unknown, ws: { send(data: string): void; close(code: number, reason: string): void }) {
        const actor = c.get("terminalActor") as TerminalActor | undefined;
        if (actor?.kind !== "owner") { ws.close(1008, "owner control required"); return; }
        const host = opts.ownerTerminalHost;
        if (!host || !(await host.isAvailable())) {
          try { ws.send(JSON.stringify({ type: "status", status: "unavailable" })); } catch { /* closed */ }
          ws.close(1013, "owner terminal unavailable");
          return;
        }
        const subscriber: TerminalSubscriber = {
          send: data => { try { ws.send(JSON.stringify({ type: "output", data })); } catch { /* closed */ } },
          close: (code, reason) => { try { ws.close(code, reason); } catch { /* closed */ } },
        };
        try {
          attachment = await host.attach(subscriber);
          if (!closed) ws.send(JSON.stringify({ type: "status", status: "ready" }));
        } catch {
          ws.close(1013, "owner terminal unavailable");
        }
      },
      async onMessage(evt: { data: unknown }, ws: { close(code: number, reason: string): void }) {
        if (closed || !attachment) return;
        const raw = typeof evt.data === "string" ? evt.data : "";
        try {
          const frame = JSON.parse(raw) as Record<string, unknown>;
          if (frame.type === "input" && typeof frame.data === "string") await attachment.sendInput(frame.data);
        } catch { ws.close(1003, "invalid owner terminal frame"); }
      },
      async onClose() {
        closed = true;
        await attachment?.close().catch(() => {});
        attachment = null;
      },
    };
  };

  // Owner terminal is a separate private relay. It never uses the broker and
  // therefore cannot accidentally become a daemon-spawned fallback shell.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/api/terminal/owner",
    terminalAuth,
    (upgradeWebSocket as any)(createOwnerTerminalHandler),
  );

  const createAgentHandler = (c: any) => {
      const sessionName = c.req.param("sessionName")!;
      const framed = c.req.query("format") === "framed", nonce = c.req.query("nonce") ?? null;
      const controlFrame = (value: Record<string, unknown>) => JSON.stringify(framed ? { ...value, nonce } : value);
      let broker: TerminalSessionBroker | null = null;
      let subscriber: TerminalSubscriber | null = null;
      // The WebSocket can close DURING the async attach (before the broker
      // reference resolves). Without this flag, onClose would find broker===null
      // and skip detach, leaving a phantom subscriber + a leaked pipe once attach
      // finally resolves. The flag lets onOpen re-detach after the fact.
      let closed = false;
      // A client is allowed to send the moment its ws.onopen fires (the CHAT
      // initialText frame does exactly that — OPR.0.4.4.20 delta-C), which can
      // land here while onOpen is still awaiting attach. Buffer those frames and
      // drain them once the broker resolves; dropping them loses the one
      // pre-populated CHAT frame every time attach is slower than the client.
      const earlyFrames: string[] = [];
      let earlyFrameBytes = 0;

      const handleFrame = async (data: string, ws?: { send(data: string): void }): Promise<void> => {
        if (!broker) return;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          const actor = c.get("terminalActor") as TerminalActor | undefined;
          if (msg.type === "takeover") {
            if (!actor || actor.kind === "worker" || actor.kind === "terminal") {
              takeovers.authorizeInput(actor?.sessionId ?? "unknown", sessionName);
              ws?.send(controlFrame({ type: "error", code: "owner_control_required" }));
              return;
            }
            const result = takeovers.begin(actor.sessionId, sessionName);
            ws?.send(controlFrame(result.ok
              ? { type: "takeover", status: "active", session: sessionName }
              : { type: "error", code: result.code }));
          } else if (msg.type === "release") {
            if (actor?.kind !== "owner") { ws?.send(controlFrame({ type: "error", code: "owner_control_required" })); return; }
            const released = takeovers.release(actor.sessionId, sessionName);
            ws?.send(controlFrame({ type: "takeover", status: released ? "released" : "inactive", session: sessionName }));
          } else if ((msg.type === "keys" && Array.isArray(msg.keys)) || (msg.type === "text" && typeof msg.text === "string")) {
            if (opts.managed && (actor?.kind !== "owner" || !takeovers.authorizeInput(actor.sessionId, sessionName))) {
              ws?.send(controlFrame({ type: "error", code: "takeover_required" }));
              return;
            }
            if (msg.type === "keys") {
            await broker.input({ type: "keys", keys: msg.keys as string[] });
            } else {
              await broker.input({ type: "text", text: msg.text as string });
            }
          } else if (msg.type === "scroll" && typeof msg.offset === "number") {
            // OPR.0.4.0.39: per-subscriber scroll-back (tmux capture-pane window).
            // offset = lines above the live bottom; 0 = live. Per-connection so each
            // viewer scrolls independently (read-only on the shared pane).
            if (subscriber) await broker.scroll(subscriber, msg.offset);
          }
          // FR-7: there is intentionally NO resize branch. The broker owns the
          // fixed canonical geometry; a client-driven resize is ignored so
          // multiple viewers cannot shrink the shared pane.
        } catch { /* ignore malformed frames */ }
      };

      return {
        async onOpen(_evt: unknown, ws: { send(data: string): void; close(code: number, reason: string): void }) {
          const tmux = c.get("tmuxAdapter") as TmuxAdapter | undefined;
          if (!tmux) { ws.close(1011, "tmux adapter unavailable"); return; }
          // Adapt the WebSocket to a broker subscriber. The broker owns the pipe,
          // the seed, the fanout, honest session-death close, and cleanup.
          const sub: TerminalSubscriber = {
            send: (data: string) => { try { ws.send(framed ? controlFrame({ type: "output", session: sessionName, data }) : data); } catch { /* closed socket */ } },
            close: (code: number, reason: string) => { try { ws.close(code, reason); } catch { /* already closed */ } },
          };
          subscriber = sub;
          let b: TerminalSessionBroker;
          try {
            b = await getRegistry(tmux as unknown as BrokerTmux).attach(sessionName, sub);
          } catch {
            // The WebSocket adapter does not await onOpen. Contain attach failures
            // here; the registry disposes the failed broker before rejecting.
            closed = true;
            earlyFrames.length = 0;
            earlyFrameBytes = 0;
            subscriber = null;
            sub.close(1011, "terminal attach failed");
            return;
          }
          broker = b;
          if (framed && !closed) ws.send(controlFrame({ type: "ready", session: sessionName }));
          // If the socket closed while attach was in flight, detach now so the
          // broker does not retain a dead subscriber (detach is idempotent).
          if (closed) { b.detach(sub); return; }
          // Drain any frames that arrived while attach was in flight, in order.
          while (earlyFrames.length > 0 && !closed) {
            const next = earlyFrames.shift()!;
            earlyFrameBytes -= Buffer.byteLength(next, "utf8");
            await handleFrame(next, ws);
          }
        },

        async onMessage(evt: { data: unknown }, ws: { close(code: number, reason: string): void; send(data: string): void }) {
          if (closed) return;
          const data = typeof evt.data === "string" ? evt.data : "";
          if (!data) return;
          if (!broker) {
            const bytes = Buffer.byteLength(data, "utf8");
            if (
              earlyFrames.length >= MAX_EARLY_TERMINAL_FRAMES
              || earlyFrameBytes + bytes > MAX_EARLY_TERMINAL_FRAME_BYTES
            ) {
              closed = true;
              try { ws.close(1009, "terminal input before ready exceeded buffer limit"); } catch { /* already closed */ }
              return;
            }
            earlyFrames.push(data);
            earlyFrameBytes += bytes;
            return;
          }
          await handleFrame(data, ws);
        },

        async onClose() {
          closed = true;
          const actor = c.get("terminalActor") as TerminalActor | undefined;
          if (actor?.kind === "owner") {
            try { takeovers.disconnect(actor.sessionId); } catch { /* closure audit still blocks readmission */ }
          }
          if (broker && subscriber) {
            broker.detach(subscriber);
          }
        },
      };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/api/terminal/:sessionName",
    terminalAuth,
    (upgradeWebSocket as any)(createAgentHandler),
  );
}
