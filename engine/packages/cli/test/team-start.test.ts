import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../src/index.js";
import { teamCommand, type TeamStartDeps } from "../src/commands/team.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";

/**
 * MVP slice 2 — `rig team start "<goal>"`.
 *
 * Drives the registered verb through the real Commander program, with the daemon answered by
 * an injected fetch. What matters is the contract with the endpoint: the goal and the named
 * options travel as one body, the owner credential authenticates it, and the printed run id is
 * the one the daemon returned.
 */

const state: DaemonState = { pid: 42, port: 7433, db: "test.sqlite", startedAt: "2026-10-31T00:00:00Z" };
const receipt = { protocolVersion: "1.0", runId: "run-1", rigId: "rig", approvalId: "approval-1",
  taskId: "task-1", qitemId: "qitem-1", seat: "dev@demo", state: "approved" };

function deps(fetchImpl: typeof fetch, ownerToken: string | null = "owner-token"): TeamStartDeps {
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true), readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
  return { lifecycleDeps, ownerToken, fetchImpl };
}

async function run(argv: string[], startDeps: TeamStartDeps): Promise<{ lines: string[]; code: number | undefined }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = createProgram({ teamStartDeps: startDeps });
    program.exitOverride();
    program.commands.find(command => command.name() === "team")!.commands
      .find(command => command.name() === "start")!;
    await program.parseAsync(["node", "rig", ...argv]);
    return { lines, code: process.exitCode };
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = saved;
  }
}

afterEach(() => { vi.restoreAllMocks(); });

describe("rig team start", () => {
  it("posts the goal with the named options and prints the run to watch", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 })) as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint", "--rig", "demo", "--seat", "dev@demo",
      "--repository", "/work/repo", "--plan", "docs/plan.md", "--write", "src", "docs"], deps(fetchImpl));

    expect(result.code).toBeUndefined();
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7433/api/team-control/runs");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer owner-token");
    expect(JSON.parse(String(init.body))).toEqual({ goal: "Add a health endpoint", rig: "demo", seat: "dev@demo",
      repository: { root: "/work/repo", planRef: "docs/plan.md" }, writePaths: ["src", "docs"] });
    expect(result.lines).toContain("Run:  run-1");
    expect(result.lines).toContain("Task: task-1 on dev@demo");
    expect(result.lines.join("\n")).toContain("http://127.0.0.1:7433/team?run=run-1");
  });

  it("uses the owner token ./setup.sh wrote when this shell has none", async () => {
    // The README's quick start: start.sh loads owner.env into the daemon only, so a fresh
    // shell has the daemon running and no credential of its own.
    const configHome = mkdtempSync(join(tmpdir(), "mvp2-owner-"));
    mkdirSync(join(configHome, "multi-agent"));
    writeFileSync(join(configHome, "multi-agent", "owner.env"),
      "MULTI_AGENT_MODE=managed\nMULTI_AGENT_OWNER_TOKEN=token-from-owner-env\n");
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 })) as unknown as typeof fetch;
      const result = await run(["team", "start", "Add a health endpoint"], { ...deps(fetchImpl, null), ownerToken: undefined });
      expect(result.code).toBeUndefined();
      const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1];
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer token-from-owner-env");
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved;
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("refuses to start without an owner credential, before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint"], deps(fetchImpl, null));
    expect(result.code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.lines.join("\n")).toMatch(/no owner credential.*Run \.\/setup\.sh/);
  });

  it("reports the daemon's refusal instead of printing a run", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "start_refused", error: "Implementation approval is not active" }),
      { status: 409 })) as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint"], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toMatch(/the start was refused: Implementation approval is not active/);
    expect(result.lines.join("\n")).not.toMatch(/team\?run=/);
  });
});

describe("rig team continue", () => {
  it("reads the current version and continues the named task with the owner credential", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(
      init?.method === "POST" ? { ok: true, startupStatus: "ready", message: "Delivered existing context" } : { run: { entityVersion: 7 } },
    ), { status: 200 })) as unknown as typeof fetch;
    const result = await run(["team", "continue", "run/1", "--task", "task/1", "--json"], deps(fetchImpl));
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:7433/api/team-control/runs/run%2F1",
      "http://127.0.0.1:7433/api/team-control/runs/run%2F1/tasks/task%2F1/continue",
    ]);
    expect(calls.every(([, init]) => new Headers(init.headers).get("authorization") === "Bearer owner-token")).toBe(true);
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ protocolVersion: "1.0", expectedEntityVersion: 7 });
    expect(JSON.parse(result.lines[0]!)).toMatchObject({ ok: true, startupStatus: "ready" });
  });

  it("resolves the run's only implementer task without a legacy request", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(
      String(url).endsWith("/read") ? { read: { tasks: [{ taskId: "task-1", role: "implementer" }] } }
        : init?.method === "POST" ? { ok: true, message: "Delivered" } : { run: { entityVersion: 3 } },
    ), { status: 200 })) as unknown as typeof fetch;
    const result = await run(["team", "continue", "run-1"], deps(fetchImpl));
    expect(result.lines).toContain("Delivered");
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.every(([url]) => url.includes("/api/team-control/"))).toBe(true);
    expect(calls[2]![0]).toContain("/tasks/task-1/continue");
  });

  it("reports a refused continuation without retrying or restarting the seat", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(
      init?.method === "POST" ? { code: "control_conflict", error: "The run changed" } : { run: { entityVersion: 3 } },
    ), { status: init?.method === "POST" ? 409 : 200 })) as unknown as typeof fetch;
    await expect(run(["team", "continue", "run-1", "--task", "task-1"], deps(fetchImpl))).rejects.toMatchObject({ code: "control_conflict" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("team command registration", () => {
  it("is reachable as `rig team start` and takes the goal as its one argument", () => {
    const command = teamCommand(deps(vi.fn() as unknown as typeof fetch));
    const start = command.commands.find(entry => entry.name() === "start")!;
    expect(start.description()).toMatch(/create a run and a task/);
    expect(start.registeredArguments.map(argument => argument.name())).toEqual(["goal"]);
  });
});
