import { Command } from "commander";
import fs from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { acquireDaemonStartLock } from "../daemon-start-lock.js";
import { DaemonClient } from "../client.js";
import { execFileSync, spawn } from "node:child_process";
import { fetchWithTimeout } from "../fetch-with-timeout.js";
import {
  startDaemon,
  stopDaemon,
  type LifecycleDeps,
  type ProcessLiveness,
  OPENRIG_DIR,
  STATE_FILE,
  resolveBindIntent,
} from "../daemon-lifecycle.js";

interface ProcessAliveDeps {
  signalCheck: (pid: number) => boolean;
  readProcessState: (pid: number) => string | null;
}

export function createIsProcessAlive(deps: ProcessAliveDeps): (pid: number) => boolean {
  return (pid: number) => {
    if (!deps.signalCheck(pid)) return false;

    const state = deps.readProcessState(pid)?.trim();
    if (!state) return false;
    if (state.startsWith("Z")) return false;
    return true;
  };
}

export type SignalOutcome = "sent" | "missing" | "not-permitted";

/** kill(pid, 0) as an outcome. POSIX: only ESRCH means no such process; EPERM means the process
 *  EXISTS but this shell may not signal it (another user's process, or a sandbox such as Codex's). */
export function signalProbe(pid: number, kill: (pid: number, signal: 0) => unknown = process.kill): SignalOutcome {
  try {
    kill(pid, 0);
    return "sent";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "not-permitted" : "missing";
  }
}

/** #275 — three-state liveness for status reads. Only a missing process (ESRCH) or a zombie is
 *  dead. A process that exists but cannot be inspected (EPERM, or `ps` cannot run, as inside
 *  Codex's macOS sandbox) is UNKNOWN, never dead: calling it dead turned a running daemon into
 *  `stale` before any health probe. The boolean createIsProcessAlive (start/stop) is unchanged. */
export function createProcessLiveness(deps: {
  signal: (pid: number) => SignalOutcome;
  readProcessState: (pid: number) => string | null;
}): (pid: number) => ProcessLiveness {
  return (pid: number) => {
    if (deps.signal(pid) === "missing") return "dead";
    const state = deps.readProcessState(pid)?.trim();
    if (!state) return "unknown";
    return state.startsWith("Z") ? "dead" : "alive";
  };
}

type ExecFile = (file: string, args: string[], options: { encoding: "utf-8" }) => string;

// Windows has no ps(1) and no zombie state, so the signal probe alone decides liveness there.
export function readProcessState(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: ExecFile = execFileSync,
): string | null {
  if (platform === "win32") return "R";
  try {
    return run("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf-8" });
  } catch {
    return null;
  }
}

export function realDeps(): LifecycleDeps {
  const isProcessAlive = createIsProcessAlive({
    signalCheck: (pid) => signalProbe(pid) === "sent",
    readProcessState: (pid) => readProcessState(pid),
  });
  const processLiveness = createProcessLiveness({
    signal: (pid) => signalProbe(pid),
    readProcessState: (pid) => readProcessState(pid),
  });

  return {
    processLiveness,
    acquireStartLock: () => acquireDaemonStartLock(OPENRIG_DIR),
    spawn: (cmd, args, opts) => spawn(cmd, args, opts as Parameters<typeof spawn>[2]),
    fetch: async (url) => {
      const res = await fetchWithTimeout(globalThis.fetch, url, {}, {
        timeoutMs: 1_500,
        timeoutMessage: `Daemon health probe timed out for ${url}`,
      });
      // OPR.0.4.3.21 — expose json() so getDaemonStatus can read the enriched
      // /healthz event-loop evidence. Bound to this Response instance.
      return { ok: res.ok, json: () => res.json() };
    },
    isPortOccupied: (host, port) => new Promise((resolve) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"));
      try {
        server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(false)));
      } catch { resolve(false); }
    }),
    fileSize: (p) => { try { return fs.statSync(p).size; } catch { return 0; } },
    readFileFrom: (p, offset) => {
      let fd: number | undefined;
      try {
        fd = fs.openSync(p, "r");
        const size = fs.fstatSync(fd).size;
        const start = size < offset ? 0 : offset; // The log may have been truncated.
        const buffer = Buffer.alloc(size - start);
        const read = fs.readSync(fd, buffer, 0, buffer.length, start);
        return buffer.toString("utf-8", 0, read);
      } catch { return null; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    },
    kill: (pid, signal) => { process.kill(pid, signal as NodeJS.Signals); return true; },
    readFile: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
    writeFile: (p, content) => {
      if (p !== STATE_FILE) { fs.writeFileSync(p, content, "utf-8"); return; }
      const temporary = `${p}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, content, { encoding: "utf-8", flag: "wx" });
        fs.renameSync(temporary, p);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    },
    removeFile: (p) => { try { fs.unlinkSync(p); } catch { /* ignore */ } },
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    pathKind: (p) => {
      try {
        const value = fs.lstatSync(p);
        if (value.isDirectory()) return "directory";
        if (value.isFile()) return "file";
        return "other";
      } catch {
        return "missing";
      }
    },
    openForAppend: (p) => fs.openSync(p, "a"),
    closeFile: (fd) => fs.closeSync(fd),
    isProcessAlive,
    // RULING 1ae863d2 — sibling-home scan (home-resolution honesty).
    listDir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  };
}

export function daemonCommand(depsOverride?: LifecycleDeps, httpDeps?: { baseUrl?: string; fetchImpl?: typeof fetch }): Command {
  const getDeps = () => depsOverride ?? realDeps();
  const cmd = new Command("daemon").description("Manage the OpenRig daemon");

  cmd
    .command("start")
    .description("Start the daemon")
    .addHelpText("after", "\nStartup reserves this local instance before initialization and verifies the spawned child PID on every required listener.\nMissing/mismatched identity or child exit fails startup; failed publication withdraws only this launch's matching state. Use a matching CLI/daemon installation.\nA concurrent start fails without spawning another child. Inspect daemon-start.lock for launcher/child PIDs after an interrupted start;\nonly archive an abandoned reservation after proving both processes absent. A failed cleanup retains it and reports the child PID.\n")
    .option("--port <port>", "Port to listen on")
    .option("--host <host>", "Host to bind on")
    .option("--db <path>", "Database path")
    .action(async (opts: { port?: string; host?: string; db?: string }) => {
      try {
        const { ConfigStore } = await import("../config-store.js");
        const configStore = new ConfigStore();
        const config = configStore.resolve();
        const effectivePort = opts.port ? parseInt(opts.port, 10) : config.daemon.port;
        // --port abc or --port 99999 reached the preflight port check and died
        // with Node's raw ERR_SOCKET_BAD_PORT. Refuse only ports that cannot be
        // bound, with the same parseInt and range as the daemon.port config key,
        // so every --port value that starts a daemon today still does.
        if (Number.isNaN(effectivePort) || effectivePort < 0 || effectivePort > 65535) {
          throw new Error(`Invalid --port: must be an integer in [0, 65535], got "${opts.port}"`);
        }
        // bug-fix slice auth-bearer-tailscale-trust: distinguish
        // user-explicit from default-fallback so the daemon can
        // multi-bind (loopback + tailscale auto-detect) when the operator
        // never opted in to a specific host.
        const hostResolution = configStore.resolveWithSource("daemon.host");
        // S20 — bind intent comes ONLY from the dedicated surfaces: the --host flag,
        // a FILE-sourced daemon.host, or OPENRIG_BIND_HOST. An env-sourced daemon.host
        // is the overloaded routing channel (ENV_MAP maps it from OPENRIG_HOST — the
        // exact injected state a managed environment carries) and never creates intent.
        const intent = resolveBindIntent({
          flagHost: opts.host,
          envBindHost: process.env["OPENRIG_BIND_HOST"],
          configSource: hostResolution.source,
          configHost: config.daemon.host,
        });
        const hostForDaemon = intent.host;

        const state = await startDaemon(
          {
            port: effectivePort,
            host: hostForDaemon,
            db: opts.db ?? config.db.path,
            transcriptsEnabled: config.transcripts.enabled,
            transcriptsPath: config.transcripts.path,
          },
          getDeps(),
        );
        console.log(`Daemon started on port ${state.port} (pid ${state.pid})`);

      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cmd
    .command("stop")
    .description("Stop the daemon (10s shutdown budget; 12s process wait; incomplete drain exits nonzero)")
    .addHelpText("after", "\nSends at most one SIGTERM to a live target and verifies the original PID and listener. Repeated signals join shutdown.\nFor a recorded target, missing/stale receipts and incomplete drains exit nonzero, including retries.\nTarget state is retained until a matching clean receipt; status reads preserve unverified state.\nNo target is a distinct no-op, never clean-drain certification; unbound incomplete evidence stays unverified.\nInspect OPENRIG_HOME/daemon-shutdown.json and daemon.log for the phase and outcome.\nThe bound covers asynchronous shutdown; an event-loop wedge still requires operator recovery.\n")
    .action(async () => {
      try {
        const outcome = await stopDaemon(getDeps());
        console.log(outcome === "stopped" ? "Daemon stopped" : "No daemon target recorded; listener refused. Nothing to stop; prior drain not certified.");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cmd
    .command("status")
    .description("Show daemon status over HTTP")
    .option("--json", "Print daemon health as JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = new DaemonClient(httpDeps?.baseUrl, { fetchImpl: httpDeps?.fetchImpl, senderIdentity: false });
      const response = await client.waitForReady();
      if (opts.json) console.log(JSON.stringify(response.data));
      else console.log(`Daemon running at ${client.baseUrl}${response.data.pid ? ` (pid ${response.data.pid})` : ""}`);
    });

  return cmd;
}
