import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { Command } from "commander";
import { ConfigStore, VALID_KEYS } from "../src/config-store.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState } from "../src/daemon-lifecycle.js";

// Defaults capture the canonical state home at module load.
const { savedMultiAgentHome } = vi.hoisted(() => {
  const savedMultiAgentHome = process.env.MULTI_AGENT_HOME;
  delete process.env.MULTI_AGENT_HOME;
  return { savedMultiAgentHome };
});
afterAll(() => {
  if (savedMultiAgentHome === undefined) delete process.env.MULTI_AGENT_HOME;
  else process.env.MULTI_AGENT_HOME = savedMultiAgentHome;
});

describe("ConfigStore", () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
    // Save env vars we'll modify
    savedEnv = {
      MULTI_AGENT_PORT: process.env["MULTI_AGENT_PORT"],
      MULTI_AGENT_HOST: process.env["MULTI_AGENT_HOST"],
      MULTI_AGENT_DB: process.env["MULTI_AGENT_DB"],
      MULTI_AGENT_TRANSCRIPTS_ENABLED: process.env["MULTI_AGENT_TRANSCRIPTS_ENABLED"],
      MULTI_AGENT_TRANSCRIPTS_PATH: process.env["MULTI_AGENT_TRANSCRIPTS_PATH"],
    };
    // Clear env vars for clean tests
    delete process.env["MULTI_AGENT_PORT"];
    delete process.env["MULTI_AGENT_HOST"];
    delete process.env["MULTI_AGENT_DB"];
    delete process.env["MULTI_AGENT_TRANSCRIPTS_ENABLED"];
    delete process.env["MULTI_AGENT_TRANSCRIPTS_PATH"];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // Test 1
  it("resolve() returns defaults when no config file and no env", () => {
    const store = new ConfigStore(join(tmpDir, "config.json"));
    const config = store.resolve();
    expect(config.daemon.port).toBe(7433);
    expect(config.daemon.host).toBe("127.0.0.1");
    expect(config.db.path).toContain(".multi-agent/multi-agent.sqlite");
    expect(config.transcripts.enabled).toBe(true);
    expect(config.transcripts.path).toContain(".multi-agent/transcripts");
  });

  // Test 2
  it("resolve() reads config file values", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ daemon: { port: 8888 }, transcripts: { enabled: false } }));
    const store = new ConfigStore(configPath);
    const config = store.resolve();
    expect(config.daemon.port).toBe(8888);
    expect(config.transcripts.enabled).toBe(false);
    // Unset keys still get defaults
    expect(config.daemon.host).toBe("127.0.0.1");
  });

  // Test 3
  it("resolve() env vars override config file", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ daemon: { port: 8888 } }));
    process.env["MULTI_AGENT_PORT"] = "9999";
    const store = new ConfigStore(configPath);
    const config = store.resolve();
    expect(config.daemon.port).toBe(9999);
  });

  // Test 4
  it("get() returns resolved value for dotted key", () => {
    const store = new ConfigStore(join(tmpDir, "config.json"));
    expect(store.get("daemon.port")).toBe(7433);
  });

  // Test 5
  it("set() persists value and is readable", () => {
    const configPath = join(tmpDir, "config.json");
    const store = new ConfigStore(configPath);
    store.set("daemon.port", "7434");
    expect(store.get("daemon.port")).toBe(7434);
    // Verify file was written
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.daemon.port).toBe(7434);
  });

  // Test 6
  it("set() with invalid key throws listing valid keys", () => {
    const store = new ConfigStore(join(tmpDir, "config.json"));
    expect(() => store.set("invalid.key", "value")).toThrow(/valid keys/i);
    expect(() => store.set("invalid.key", "value")).toThrow(/daemon\.port/);
  });

  // Test 7
  it("resolve() with malformed config.json throws with fix/reset guidance", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, "not valid json{{{");
    const store = new ConfigStore(configPath);
    expect(() => store.resolve()).toThrow(/malformed/i);
    expect(() => store.resolve()).toThrow(/reset/i);
  });
});

describe("DaemonClient config integration", () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "client-config-"));
    savedEnv = {
      MULTI_AGENT_PORT: process.env["MULTI_AGENT_PORT"],
      MULTI_AGENT_HOST: process.env["MULTI_AGENT_HOST"],
      MULTI_AGENT_DB: process.env["MULTI_AGENT_DB"],
    };
    delete process.env["MULTI_AGENT_PORT"];
    delete process.env["MULTI_AGENT_HOST"];
    delete process.env["MULTI_AGENT_DB"];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("ConfigStore resolves non-default host/port from config file", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ daemon: { port: 9876, host: "10.0.0.5" } }));
    const { ConfigStore: CS } = await import("../src/config-store.js");
    const config = new CS(configPath).resolve();
    expect(config.daemon.port).toBe(9876);
    expect(config.daemon.host).toBe("10.0.0.5");
  });
});

describe("DaemonClient config-aware baseUrl", () => {
  it("new DaemonClient() without args resolves baseUrl from config env vars", async () => {
    const saved = {
      MULTI_AGENT_URL: process.env["MULTI_AGENT_URL"],
      MULTI_AGENT_PORT: process.env["MULTI_AGENT_PORT"],
      MULTI_AGENT_HOST: process.env["MULTI_AGENT_HOST"],
    };
    delete process.env["MULTI_AGENT_URL"];
    process.env["MULTI_AGENT_PORT"] = "9999";
    process.env["MULTI_AGENT_HOST"] = "10.0.0.5";
    try {
      const { DaemonClient } = await import("../src/client.js");
      const client = new DaemonClient();
      expect(client.baseUrl).toBe("http://10.0.0.5:9999");
    } finally {
      if (saved.MULTI_AGENT_URL !== undefined) process.env["MULTI_AGENT_URL"] = saved.MULTI_AGENT_URL;
      else delete process.env["MULTI_AGENT_URL"];
      if (saved.MULTI_AGENT_PORT !== undefined) process.env["MULTI_AGENT_PORT"] = saved.MULTI_AGENT_PORT;
      else delete process.env["MULTI_AGENT_PORT"];
      if (saved.MULTI_AGENT_HOST !== undefined) process.env["MULTI_AGENT_HOST"] = saved.MULTI_AGENT_HOST;
      else delete process.env["MULTI_AGENT_HOST"];
    }
  });
});

describe("getDaemonStatus host preservation", () => {
  it("preserves non-localhost host from MULTI_AGENT_URL", async () => {
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    const savedUrl = process.env["MULTI_AGENT_URL"];
    process.env["MULTI_AGENT_URL"] = "http://10.0.0.5:8080";
    try {
      const mockDeps = {
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
      const status = await getDaemonStatus(mockDeps);
      expect(status.host).toBe("10.0.0.5");
      expect(status.port).toBe(8080);
    } finally {
      if (savedUrl !== undefined) process.env["MULTI_AGENT_URL"] = savedUrl;
      else delete process.env["MULTI_AGENT_URL"];
    }
  });
});

describe("getDaemonUrl", () => {
  it("constructs URL from status host and port", async () => {
    const { getDaemonUrl } = await import("../src/daemon-lifecycle.js");
    expect(getDaemonUrl({ state: "running", port: 8080, host: "192.168.1.5" })).toBe("http://192.168.1.5:8080");
  });

  it("defaults to 127.0.0.1 when host is undefined", async () => {
    const { getDaemonUrl } = await import("../src/daemon-lifecycle.js");
    expect(getDaemonUrl({ state: "running", port: 7433 })).toBe("http://127.0.0.1:7433");
  });
});

// CLI command tests
function mockLifecycleDeps() {
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
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}
