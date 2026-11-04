import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { TeamStartDeps } from "../src/commands/team.js";

/**
 * T017 (cancellation half) — `rig team cancel <run-id>`.
 *
 * The daemon does the stopping, so this verb's whole job is to send the one exact request and
 * print what came back. What matters is that it never turns a stop the daemon could not
 * observe into a success: an unresolved attempt is printed as unresolved, with the run left
 * in `cancel_requested` rather than reported as canceled.
 */

const state: DaemonState = { pid: 42, port: 7433, db: "test.sqlite", startedAt: "2026-10-31T00:00:00Z" };

function deps(fetchImpl: typeof fetch): TeamStartDeps {
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true), readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
  return { lifecycleDeps, ownerToken: "owner-token", fetchImpl };
}

/** A daemon answering the run read and the cancel write with the given receipt. */
function daemon(cancel: { status?: number; body: unknown }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST" && url.endsWith("/cancel")) {
      return new Response(JSON.stringify(cancel.body), { status: cancel.status ?? 200 });
    }
    return new Response(JSON.stringify({ protocolVersion: "1.0", run: { entityVersion: 7 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function run(argv: string[], teamDeps: TeamStartDeps): Promise<{ lines: string[]; code: number | undefined }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = createProgram({ teamStartDeps: teamDeps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", ...argv]);
    return { lines, code: process.exitCode };
  } catch (thrown) {
    return { lines: [...lines, (thrown as Error).message], code: process.exitCode };
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = saved;
  }
}

afterEach(() => { vi.restoreAllMocks(); });

describe("rig team cancel", () => {
  it("sends the run's version and reason, and reports the observed stop", async () => {
    const fetchImpl = daemon({ body: { status: "observed", reason: null, value: { state: "canceled",
      attempts: [{ processId: 4242, processStart: "77", outcome: "stopped", escalated: false, waitedMs: 90 }],
      unresolvedAttempts: [], canceledTasks: ["task-1"] } } });
    const result = await run(["team", "cancel", "run-1"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    const [url, init] = calls.find(([, request]) => request.method === "POST")!;
    expect(url).toBe("http://127.0.0.1:7433/api/team-control/runs/run-1/cancel");
    expect(JSON.parse(String(init.body))).toMatchObject({ runId: "run-1", actionId: "run-1", expectedEntityVersion: 7,
      payload: { reason: "Owner requested cancellation from the CLI" } });
    const printed = result.lines.join("\n");
    expect(printed).toContain("Canceled run-1.");
    expect(printed).toContain("process 4242:77 stopped");
    expect(printed).toContain("task task-1 canceled");
    expect(printed).toContain("the candidate and its evidence are kept");
  });

  it("shows the escalation when the client had to be killed", async () => {
    const fetchImpl = daemon({ body: { status: "observed", reason: null, value: { state: "canceled",
      attempts: [{ processId: 4242, processStart: "77", outcome: "stopped", escalated: true, waitedMs: 5_100 }],
      unresolvedAttempts: [], canceledTasks: [] } } });
    const result = await run(["team", "cancel", "run-1"], deps(fetchImpl));
    expect(result.lines.join("\n")).toContain("SIGKILL after the grace period");
  });

  it("says what is still alive instead of reporting a stop it did not see", async () => {
    const fetchImpl = daemon({ status: 202, body: { status: "pending-execution",
      reason: "Termination was not observed for 1 attempt(s): attempt-1",
      value: { state: "cancel_requested", unresolvedAttempts: ["attempt-1"], canceledTasks: [] } } });
    const result = await run(["team", "cancel", "run-1"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const printed = result.lines.join("\n");
    expect(printed).toContain("is recorded but not yet observed");
    expect(printed).toContain("still alive: attempt-1");
    expect(printed).toContain("run 'rig team cancel' again");
  });

  it("reports a refused cancellation as the daemon's own reason", async () => {
    const fetchImpl = daemon({ status: 403, body: { status: "denied", reason: "Run is already canceled" } });
    const result = await run(["team", "cancel", "run-1"], deps(fetchImpl));
    expect(result.lines.join("\n")).toContain("Run is already canceled");
  });

  it("prints the receipt itself with --json", async () => {
    const body = { status: "observed", reason: null, value: { state: "canceled", attempts: [], unresolvedAttempts: [], canceledTasks: [] } };
    const result = await run(["team", "cancel", "run-1", "--json"], deps(daemon({ body })));
    expect(JSON.parse(result.lines.join("\n"))).toEqual(body);
  });
});
