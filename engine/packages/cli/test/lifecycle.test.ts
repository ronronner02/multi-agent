import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import { createProgram } from "../src/index.js";
import { launchCommand } from "../src/commands/launch.js";
import type { StatusDeps } from "../src/status-deps.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

describe("Lifecycle CLI commands", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/sessions/session-123/unclaim") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          rigId: "rig-1",
          nodeId: "node-1",
          logicalId: "external.helper",
          sessionId: "session-123",
          sessionName: "manual-helper",
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/rigs/rig-1/release") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          status: "ok",
          rigId: "rig-1",
          deleted: true,
          released: [
            { nodeId: "node-1", logicalId: "external.helper", sessionId: "session-123", sessionName: "manual-helper" },
            { nodeId: "node-2", logicalId: "external.qa", sessionId: "session-456", sessionName: "manual-qa" },
          ],
          failed: [],
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/rigs/rig-finalization-failed/release") {
        res.writeHead(207, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true, status: "partial", rigId: "rig-finalization-failed", deleted: true,
          released: [{ nodeId: "node-1", logicalId: "external.helper", sessionId: "session-123", sessionName: "manual-helper" }],
          failed: [],
          warnings: ["Deletion reservation reservation-1 finalization failed: reservation release failed. Reservation state requires reconciliation."],
          deletionFinalization: { reservationId: "reservation-1", error: "reservation release failed" },
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/rigs/rig-launched/release") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          code: "contains_launched_nodes",
          error: "Rig contains launched nodes and cannot be released safely.",
          launchedLogicalIds: ["dev.impl"],
        }));
        return;
      }

      if (req.method === "DELETE" && req.url === "/api/rigs/rig-1/nodes/dev.impl") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          rigId: "rig-1",
          nodeId: "node-1",
          logicalId: "dev.impl",
          sessionsKilled: 1,
        }));
        return;
      }

      if (req.method === "DELETE" && req.url === "/api/rigs/rig-1/nodes/dev.impl?fallback=ops-fallback%40rig-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          rigId: "rig-1",
          nodeId: "node-1",
          logicalId: "dev.impl",
          sessionsKilled: 1,
          fallbackDestination: "ops-fallback@rig-1",
          reroutedQitemIds: ["qitem-remove-1"],
        }));
        return;
      }

      if (req.method === "DELETE" && req.url === "/api/rigs/rig-1/pods/dev") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          rigId: "rig-1",
          podId: "pod-1",
          namespace: "dev",
          removedLogicalIds: ["dev.impl", "dev.qa"],
          sessionsKilled: 2,
        }));
        return;
      }

      if (req.method === "DELETE" && req.url === "/api/rigs/rig-1/pods/dev?fallback=ops-fallback%40rig-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          status: "ok",
          rigId: "rig-1",
          podId: "pod-1",
          namespace: "dev",
          removedLogicalIds: ["dev.impl", "dev.qa"],
          sessionsKilled: 2,
          fallbackDestination: "ops-fallback@rig-1",
          reroutedQitemIds: ["qitem-shrink-1", "qitem-shrink-2"],
        }));
        return;
      }

      if (req.method === "DELETE" && req.url === "/api/rigs/rig-1/pods/dev-partial") {
        res.writeHead(207, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          status: "partial",
          rigId: "rig-1",
          podId: "pod-1",
          namespace: "dev",
          removedLogicalIds: ["dev.impl"],
          sessionsKilled: 1,
          nodes: [
            { logicalId: "dev.impl", nodeId: "node-1", status: "removed", sessionsKilled: 1 },
            { logicalId: "dev.qa", nodeId: "node-2", status: "failed", sessionsKilled: 0, error: "tmux timeout" },
          ],
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/rigs/rig-1/nodes/dev.qa/launch") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          nodeId: "node-2",
          logicalId: "dev.qa",
          sessionName: "dev-qa@test",
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/rigs/rig-1/nodes/dev.pod/launch") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          code: "pod_aware_launch_unsupported",
          error: "Pod-aware node launch via this route bypasses startup orchestration. Use rig up, rig import --instantiate, or rig restore instead.",
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/sessions/missing/unclaim") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Claimed session 'missing' not found." }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
  });

  function runningDeps(): StatusDeps {
    return {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => {
          if (p === STATE_FILE) {
            return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-07T00:00:00Z" } as DaemonState);
          }
          return null;
        }),
        fetch: vi.fn(async () => ({ ok: true })),
      },
      clientFactory: (url) => new DaemonClient(url),
    };
  }

  it("launch prints relaunched node details", async () => {
    const program = new Command();
    program.exitOverride();
    program.addCommand(launchCommand(runningDeps()));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "launch", "rig-1", "dev.qa"]);
    });

    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Launched node dev.qa in rig rig-1");
    expect(logs.join("\n")).toContain("dev-qa@test");
  });

  it("launch surfaces honest pod-aware rejection and exits non-zero", async () => {
    const program = new Command();
    program.exitOverride();
    program.addCommand(launchCommand(runningDeps()));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "launch", "rig-1", "dev.pod"]);
    });

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("bypasses startup orchestration");
    expect(logs.join("\n")).toContain("rig import --instantiate");
  });
});
