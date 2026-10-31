import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(result.lines).toContain("  rig tui --team --run run-1");
  });

  it("refuses to start without an owner credential, before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint"], deps(fetchImpl, null));
    expect(result.code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.lines.join("\n")).toMatch(/no owner credential/);
  });

  it("reports the daemon's refusal instead of printing a run", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "start_refused", error: "Implementation approval is not active" }),
      { status: 409 })) as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint"], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toMatch(/the start was refused: Implementation approval is not active/);
    expect(result.lines.join("\n")).not.toMatch(/rig tui --team/);
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
