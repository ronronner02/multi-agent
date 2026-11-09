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
  it.each([false, true])("sends the selected workflow with read-only set to %s", async readOnly => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 }));
    const result = await run(["team", "start", "Inspect the current plan", "--workflow", "spec-plan",
      ...(readOnly ? ["--read-only"] : [])], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    expect(JSON.parse(String(init.body))).toEqual({ goal: "Inspect the current plan", workflow: { entrypoint: "spec-plan", readOnly } });
  });

  it("rejects --read-only without a selected workflow before contacting the daemon", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 }));
    const result = await run(["team", "start", "Inspect the current plan", "--read-only"], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("--read-only requires --workflow");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

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

  it("names the reviewer seat so the run's review rounds have somewhere to go", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 })) as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint", "--seat", "dev@demo", "--reviewer", "rev@demo"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1];
    expect(JSON.parse(String(init.body))).toMatchObject({ seat: "dev@demo", reviewerSeat: "rev@demo" });
  });

  // C3 — the lead is opt-in, and a start with one points the owner at the proposal verb.
  it("names the lead seat and points at the proposal the owner has to decide", async () => {
    const withLead = { ...receipt, leadSeat: "lead@demo" };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(withLead), { status: 201 })) as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint", "--lead", "lead@demo"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1];
    expect(JSON.parse(String(init.body))).toEqual({ goal: "Add a health endpoint", lead: "lead@demo" });
    expect(result.lines.join("\n")).toContain("rig team proposal run-1 task-1");
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


describe("rig team pair-browser", () => {
  it("sends a bodyless owner-authenticated POST and prints only the pairing code", async () => {
    const pairing = { code: "A".repeat(43), expiresAt: 1_800_000_000_000 };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(pairing), { status: 200 })) as unknown as typeof fetch;
    const result = await run(["team", "pair-browser"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    expect(result.lines).toEqual([pairing.code]);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7433/api/team-control/owner-session/pairing");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer owner-token");
    expect(new Headers(init.headers).get("content-type")).toBeNull();
  });

  it("prints the complete receipt in JSON mode", async () => {
    const pairing = { code: "B".repeat(43), expiresAt: 1_800_000_000_000 };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(pairing), { status: 200 })) as unknown as typeof fetch;
    const result = await run(["team", "pair-browser", "--json"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    expect(JSON.parse(result.lines[0]!)).toEqual(pairing);
  });

  it("fails before contacting the daemon when the owner credential is missing", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await run(["team", "pair-browser"], deps(fetchImpl, null));
    expect(result.code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.lines.join("\n")).toMatch(/no owner credential.*Run \.\/setup\.sh/);
  });

  it("reports the daemon refusal and exits nonzero", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: "owner_control_required", error: "The owner bearer was refused",
    }), { status: 403 })) as unknown as typeof fetch;
    const result = await run(["team", "pair-browser"], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("owner_control_required");
    expect(result.lines.join("\n")).toContain("The owner bearer was refused");
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

describe("rig team resume", () => {
  it("reads the current run version and posts one Resume action with budget increases", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(
      init?.method === "POST"
        ? { status: "observed", runId: "run-1", effectMayStart: true, reason: null, resumeTaskIds: ["task-1"] }
        : { run: { entityVersion: 8 } },
    ), { status: 200 })) as unknown as typeof fetch;
    const result = await run(["team", "resume", "run-1", "--add-minutes", "5", "--add-retries", "2", "--add-review-rounds", "1", "--json"], deps(fetchImpl));
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:7433/api/team-control/runs/run-1",
      "http://127.0.0.1:7433/api/team-control/runs/run-1/resume",
    ]);
    expect(JSON.parse(String(calls[1]![1].body))).toMatchObject({
      protocolVersion: "1.0", runId: "run-1", actionId: "run-1", expectedEntityVersion: 8,
      payload: { addMinutes: 5, addRetries: 2, addReviewRounds: 1 },
    });
    expect(JSON.parse(result.lines[0]!)).toMatchObject({ status: "observed", effectMayStart: true, resumeTaskIds: ["task-1"] });
  });
});

describe("rig team proposal", () => {
  const proposal = { tasks: [
    { taskId: "task-2", seat: "a@demo", paths: ["src/a.ts"], dependencies: [], body: "First" },
    { taskId: "task-3", seat: "b@demo", paths: ["src/b.ts"], dependencies: ["task-2"], body: "Second" } ] };
  /** A daemon answering the proposal read, the run read, the proposal write and the decision. */
  const daemon = (decision = "approved") => vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/proposal")) {
      return new Response(JSON.stringify({ status: "accepted", runId: "run-1", entityVersion: 9, replayed: false,
        effectMayStart: false, reason: null, value: { id: "proposal-1", entityVersion: 1 } }), { status: 200 });
    }
    if (init?.method === "POST" && url.endsWith("/approvals/decide")) {
      return new Response(JSON.stringify({ status: "accepted", runId: "run-1", entityVersion: 10, replayed: false,
        effectMayStart: true, reason: null, value: { addedTasks: decision === "approved" ? ["task-2", "task-3"] : [] } }), { status: 200 });
    }
    if (url.endsWith("/proposal")) return new Response(JSON.stringify({ protocolVersion: "1.0", proposal }), { status: 200 });
    return new Response(JSON.stringify({ protocolVersion: "1.0", run: { entityVersion: 8 } }), { status: 200 });
  }) as unknown as typeof fetch;

  it("reads the batch and admits nothing without --decide", async () => {
    const fetchImpl = daemon();
    const result = await run(["team", "proposal", "run-1", "task-1"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    expect(result.lines.join("\n")).toContain("The lead proposed 2 implementer task(s)");
    expect(result.lines.join("\n")).toContain("--decide approved");
    // One read only: a proposal that has not been decided is not written anywhere.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records the owner decision for the batch the daemon read", async () => {
    const fetchImpl = daemon();
    const result = await run(["team", "proposal", "run-1", "task-1", "--decide", "approved"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    expect(result.lines.join("\n")).toContain("2 task(s) admitted and dispatched: task-2, task-3");
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    const decision = JSON.parse(String(calls.at(-1)![1].body)) as { actionId: string; payload: { approvalVersion: number; decision: string } };
    expect(calls.at(-1)![0]).toContain("/approvals/decide");
    expect(decision).toMatchObject({ actionId: "proposal-1", payload: { approvalVersion: 1, decision: "approved" } });
    // The proposal write carries the expiry the daemon's contract requires. An empty payload is
    // refused as a malformed request, so a decision that never states one can never be recorded.
    const proposalWrite = calls.find(([url, init]) => init?.method === "POST" && url.endsWith("/proposal"))!;
    const written = JSON.parse(String(proposalWrite[1].body)) as { payload: { leadProposal?: { expiresAt?: string } } };
    const expiresAt = written.payload.leadProposal?.expiresAt;
    expect(typeof expiresAt).toBe("string");
    expect(new Date(expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects --decide values other than approved and rejected, before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(run(["team", "proposal", "run-1", "task-1", "--decide", "maybe"], deps(fetchImpl)))
      .rejects.toMatchObject({ code: "lead_decision_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("team command registration", () => {
  it("is reachable as `rig team start` and takes the goal as its one argument", () => {
    const command = teamCommand(deps(vi.fn() as unknown as typeof fetch));
    const start = command.commands.find(entry => entry.name() === "start")!;
    expect(start.description()).toMatch(/create a run and a task/);
    expect(start.registeredArguments.map(argument => argument.name())).toEqual(["goal"]);
  });

  it("registers `rig team pair-browser` for owner-side browser pairing", () => {
    const command = teamCommand(deps(vi.fn() as unknown as typeof fetch));
    const pairBrowser = command.commands.find(entry => entry.name() === "pair-browser")!;
    expect(pairBrowser.description()).toMatch(/one-time code/);
    expect(pairBrowser.options.map(option => option.long)).toContain("--json");
  });

  it("registers `rig team proposal` as the owner's read and decision of a lead's batch", () => {
    const command = teamCommand(deps(vi.fn() as unknown as typeof fetch));
    const proposal = command.commands.find(entry => entry.name() === "proposal")!;
    expect(proposal.registeredArguments.map(argument => argument.name())).toEqual(["run-id", "task-id"]);
    expect(proposal.options.map(option => option.long)).toContain("--decide");
  });
});
