import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, remoteDaemonClient } from "../src/client.js";
import { allowFetchTarget, resetFetchAllowlist } from "./fetch-guard.js";

describe("default client endpoint selection", () => {
  let root: string;
  let home: string;
  const servers: http.Server[] = [];
  const fallback = "http://configured.invalid:28123";
  const state = (port = 27451, extra = {}) => ({ pid: process.pid, port, host: "127.0.0.1", ...extra });
  const writeState = (value: unknown, target = home) => fs.writeFileSync(path.join(target, "daemon.json"), JSON.stringify(value));
  const configure = (target = home) => fs.writeFileSync(path.join(target, "config.json"), JSON.stringify({ daemon: { host: "configured.invalid", port: 28123 } }));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "client-endpoint-"));
    home = path.join(root, "a");
    fs.mkdirSync(home);
    for (const key of ["MULTI_AGENT_URL", "MULTI_AGENT_HOST", "MULTI_AGENT_PORT", "MULTI_AGENT_SESSION_NAME", "MULTI_AGENT_TERMINAL_BEARER_TOKEN"]) vi.stubEnv(key, undefined);
    vi.stubEnv("MULTI_AGENT_HOME", home);
    configure();
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
    vi.restoreAllMocks();
    resetFetchAllowlist();
    vi.unstubAllEnvs();
    process.exitCode = 0;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses the actual live-home endpoint ahead of configured startup defaults without rewriting either file", () => {
    writeState(state());
    const before = fs.readFileSync(path.join(home, "daemon.json"));
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
    expect(fs.readFileSync(path.join(home, "daemon.json"))).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).daemon.port).toBe(28123);
  });

  it("uses the new URL override and ignores a former URL selector", () => {
    writeState(state());
    vi.stubEnv(("RIG" + "GED") + "_URL", "http://legacy.invalid:28001");
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
    vi.stubEnv("MULTI_AGENT_URL", "http://explicit.invalid:28002");
    expect(new DaemonClient().baseUrl).toBe("http://explicit.invalid:28002");
    expect(new DaemonClient("http://argument.invalid:28003").baseUrl).toBe("http://argument.invalid:28003");
  });

  it("uses host/port config and its env overrides when no state exists", () => {
    expect(new DaemonClient().baseUrl).toBe(fallback);
    vi.stubEnv("MULTI_AGENT_HOST", "env.invalid");
    vi.stubEnv("MULTI_AGENT_PORT", "28004");
    expect(new DaemonClient().baseUrl).toBe("http://env.invalid:28004");
    vi.stubEnv("MULTI_AGENT_HOST", undefined);
    vi.stubEnv("MULTI_AGENT_PORT", undefined);
    vi.stubEnv(("RIG" + "GED") + "_HOST", "legacy-config.invalid");
    vi.stubEnv(("RIG" + "GED") + "_PORT", "28005");
    expect(new DaemonClient().baseUrl).toBe("http://configured.invalid:28123");
  });

  it("uses the existing default when both state and config are absent (no network request)", () => {
    fs.unlinkSync(path.join(home, "config.json"));
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:7433");
  });

  it("keeps a live endpoint when startup host/port configuration changes", () => {
    writeState(state());
    vi.stubEnv("MULTI_AGENT_PORT", "28004");
    vi.stubEnv("MULTI_AGENT_HOST", "future.invalid");
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
  });

  it("keeps the recorded endpoint for a dead PID without rewriting state", () => {
    writeState(state());
    const before = fs.readFileSync(path.join(home, "daemon.json"));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
    expect(fs.readFileSync(path.join(home, "daemon.json"))).toEqual(before);
  });

  it("does not mistake a permission-denied liveness check for a dead endpoint", () => {
    writeState(state());
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
  });

  it.each([null, [], {}, { pid: -1, port: 27451 }, { pid: "12", port: 27451 }, { pid: process.pid, port: "27451" }, { pid: process.pid, port: 0 }, { pid: process.pid, port: 65536 }, { pid: process.pid, port: 1.5 }, { pid: process.pid, port: 27451, host: 12 }])("falls back on unusable state shape: %j", value => {
    writeState(value);
    expect(new DaemonClient().baseUrl).toBe(fallback);
  });

  it("falls back on malformed JSON", () => {
    fs.writeFileSync(path.join(home, "daemon.json"), "{");
    expect(new DaemonClient().baseUrl).toBe(fallback);
  });

  it("supports old state without a host and honors a persisted custom host", () => {
    writeState({ pid: process.pid, port: 27451 });
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
    writeState(state(27451, { host: "custom.invalid" }));
    expect(new DaemonClient().baseUrl).toBe("http://custom.invalid:27451");
  });

  it("resolves home per construction, ignores the former home selector, and never discovers a sibling", () => {
    writeState(state());
    const first = new DaemonClient();
    const other = path.join(root, "b");
    fs.mkdirSync(other);
    configure(other);
    vi.stubEnv("MULTI_AGENT_HOME", other);
    expect(new DaemonClient().baseUrl).toBe(fallback);
    writeState(state(27452), other);
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27452");
    expect(first.baseUrl).toBe("http://127.0.0.1:27451");
    vi.stubEnv("MULTI_AGENT_HOME", undefined);
    vi.stubEnv(("RIG" + "GED") + "_HOME", home);
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:7433");
  });

  it("preserves remote destination and origin identity while local state exists", async () => {
    writeState(state());
    vi.stubEnv("MULTI_AGENT_SESSION_NAME", "author@fixture");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}"));
    const client = remoteDaemonClient(url => new DaemonClient(url, { fetchImpl }), "http://remote.invalid:28006", "origin-fixture");
    await client.post("/api/proof/judge", { fixture: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual(["http://remote.invalid:28006/api/proof/judge", expect.objectContaining({ headers: expect.objectContaining({ "X-Multi-Agent-Session": "author@fixture@origin-fixture" }) })]);
  });
});
