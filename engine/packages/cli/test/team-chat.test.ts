import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import type { TeamStartDeps } from "../src/commands/team.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";

/**
 * U5 — `rig team chat` and `rig team approve-plan`.
 *
 * The verbs are thin: the conversation, the turn and the approval are the daemon's work. What is
 * worth pinning is the contract — the owner credential, the exact paths, the control request a
 * message becomes, and the honest report of a queued message versus a started turn.
 */

const state: DaemonState = { pid: 42, port: 7433, db: "test.sqlite", startedAt: "2026-10-31T00:00:00Z" };

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
    await program.parseAsync(["node", "rig", ...argv]);
    return { lines, code: process.exitCode };
  } catch (thrown) {
    return { lines: [...lines, (thrown as Error).message], code: process.exitCode ?? 1 };
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = saved;
  }
}

/** One fetch answer per call, in the order the verb asks. */
function answering(...answers: Array<{ status: number; body: unknown }>): typeof fetch {
  const queue = [...answers];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("the verb asked for more answers than this test gave");
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
}

const calls = (fetchImpl: typeof fetch) => (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;

afterEach(() => { vi.restoreAllMocks(); });

describe("rig team chat", () => {
  it("sends the owner's message as one control request and reports the turn it starts", async () => {
    const fetchImpl = answering(
      { status: 200, body: { run: { entityVersion: 4 } } },
      { status: 200, body: { status: "accepted", value: { messageId: "chat-1", queued: false } } });
    const result = await run(["team", "chat", "run-1", "What would you build first?"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const [runUrl] = calls(fetchImpl)[0]!;
    expect(runUrl).toBe("http://127.0.0.1:7433/api/team-control/runs/run-1");
    const [url, init] = calls(fetchImpl)[1]!;
    expect(url).toBe("http://127.0.0.1:7433/api/team-control/runs/run-1/chat");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer owner-token");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ protocolVersion: "1.0", runId: "run-1",
      expectedEntityVersion: 4, payload: { body: "What would you build first?" } });
    expect(body.actionId).toEqual(expect.any(String));
    expect(result.lines.join("\n")).toContain("the lead's next turn answers it");
  });

  it("says a message was queued when a lead turn is already running", async () => {
    const fetchImpl = answering(
      { status: 200, body: { run: { entityVersion: 2 } } },
      { status: 200, body: { status: "accepted", value: { messageId: "chat-2", queued: true } } });
    const result = await run(["team", "chat", "run-1", "Also add tests."], deps(fetchImpl));
    expect(result.lines.join("\n")).toContain("Queued: a lead turn is already running");
  });

  it("prints the conversation in order when no message is given", async () => {
    const fetchImpl = answering({ status: 200, body: { phase: "planning", runId: "run-1", messages: [
      { id: "m1", sender: "lead", body: "I would add a health endpoint.", createdAt: "2026-11-05T10:00:00.000Z" },
      { id: "m2", sender: "owner", body: "Also cover it with a test.", createdAt: "2026-11-05T10:01:00.000Z" },
    ] } });
    const result = await run(["team", "chat", "run-1"], deps(fetchImpl));
    expect(calls(fetchImpl)).toHaveLength(1);
    expect(calls(fetchImpl)[0]![0]).toBe("http://127.0.0.1:7433/api/team-control/runs/run-1/chat");
    const printed = result.lines.join("\n");
    expect(printed).toContain("Phase: planning");
    expect(printed.indexOf("I would add a health endpoint.")).toBeLessThan(printed.indexOf("Also cover it with a test."));
    expect(printed).toContain("Lead · 2026-11-05T10:00:00.000Z");
    expect(printed).toContain("Owner · 2026-11-05T10:01:00.000Z");
  });

  it("surfaces the daemon's refusal instead of pretending the message landed", async () => {
    const fetchImpl = answering({ status: 200, body: { run: { entityVersion: 2 } } },
      { status: 403, body: { status: "denied", reason: "Run is closed; the lead is not reading messages" } });
    const result = await run(["team", "chat", "run-1", "hello?"], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("Run is closed");
  });
});

describe("rig team approve-plan", () => {
  it("posts the owner's approval and reports the run in delivery", async () => {
    const fetchImpl = answering({ status: 200, body: { run: { entityVersion: 7, phase: "planning" } } },
      { status: 200, body: { status: "accepted", value: { phase: "delivery", planRef: "plan.md" } } });
    const result = await run(["team", "approve-plan", "run-1"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const [url, init] = calls(fetchImpl)[1]!;
    expect(url).toBe("http://127.0.0.1:7433/api/team-control/runs/run-1/plan/approve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ runId: "run-1", expectedEntityVersion: 7, payload: {} });
    expect(result.lines.join("\n")).toContain("Approved plan.md; the run is delivery.");
    expect(result.lines.join("\n")).toContain("rig team proposal <run> <task>");
  });

  it("names the refusal when there is no plan to approve", async () => {
    const fetchImpl = answering({ status: 200, body: { run: { entityVersion: 3 } } },
      { status: 409, body: { code: "plan_missing", error: "The lead wrote no plan at plan.md" } });
    const result = await run(["team", "approve-plan", "run-1"], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("The lead wrote no plan at plan.md");
  });
});