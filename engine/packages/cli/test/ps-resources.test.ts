import { afterEach, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
import { DaemonClient } from "../src/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); });

async function remoteFixture(status: 200 | 401 | 403 | 404 | 429 | 500, maxIdleIntervalMs: number | null = 6000) {
  vi.stubEnv("OPENRIG_RESOURCE_TEST_BEARER", "public-fixture-token");
  let authorization: string | undefined;
  const app = new Hono();
  app.get("/api/ps/resources", (c) => {
    authorization = c.req.header("authorization");
    if (status === 200) return c.json({ cpuCount: 4, runningSeats: 2, loadAverage: null, loadPerCpu: null,
      capture: { rotatingSeats: 2, idleSeats: 1, captures: 4, failures: 0, capturedBytes: 100,
        captureDurationMs: 10, activeIntervalMs: 2000, maxIdleIntervalMs, lines: 1000 } });
    return c.json({ error: "fixture failure" }, status);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const port = (server.address() as { port: number }).port;
  close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const command = new Command().addCommand(psCommand({
    clientFactory: (url) => new DaemonClient(url),
    lifecycleDeps: { exists: () => false, readFile: () => null } as never,
    hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "fixture-host", transport: "http", url: `http://127.0.0.1:${port}`, bearer_env: "OPENRIG_RESOURCE_TEST_BEARER" }] } }),
  }));
  return { command, authorization: () => authorization };
}

it("renders JSON and explicit human resource semantics when capture statistics are unavailable", async () => {
  const { command } = await remoteFixture(200, null);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources", "--json"]);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ runningSeats: 2 });
  log.mockClear();
  await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources"]);
  expect(log.mock.calls.flat().join("\n")).toContain("unavailable on this platform");
  expect(log.mock.calls.flat().join("\n")).toContain("not daemon CPU time");
  expect(log.mock.calls.flat().join("\n")).toContain("unavailable ms idle ceiling");
  expect(log.mock.calls.flat().join("\n")).not.toContain("0 ms idle ceiling");
});

it("names the registered remote host in successful human resource output", async () => {
  const { command } = await remoteFixture(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources"]);
  expect(log.mock.calls[0]![0]).toBe("Host: fixture-host · 4 available CPUs · 2 running seats");
  expect(log.mock.calls.flat().join("\n")).toContain("6000 ms idle ceiling");
});

it.each([401, 403, 429, 500] as const)("preserves remote resource HTTP %s JSON classification and exit status through actual bearer transport", async (status) => {
  const { command, authorization } = await remoteFixture(status);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources", "--json"]);
    expect(authorization()).toBe("Bearer public-fixture-token");
    expect(process.exitCode).toBe(1);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      ok: false, cross_host: { host: "fixture-host" },
      failedStep: status === 401 || status === 403 ? "permission-gate" : "remote-command-failed",
      error: `HTTP ${status}`,
    });
  } finally { process.exitCode = previousExitCode; vi.unstubAllEnvs(); }
});

it("names the remote host for a human permission failure", async () => {
  const { command } = await remoteFixture(403);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources"]);
    expect(process.exitCode).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("cross-host (host=fixture-host): HTTP 403");
  } finally { process.exitCode = previousExitCode; vi.unstubAllEnvs(); }
});

it.each([false, true])("retains the older-daemon HTTP404 diagnostic and exit2 with json=%s", async (json) => {
  const { command } = await remoteFixture(404);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources", ...(json ? ["--json"] : [])]);
    expect(process.exitCode).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Host resource measurements unavailable (HTTP 404); this host may need a newer daemon.");
  } finally { process.exitCode = previousExitCode; vi.unstubAllEnvs(); }
});
