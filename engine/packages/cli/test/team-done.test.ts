import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../src/index.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { TeamStartDeps } from "../src/commands/team.js";

/**
 * MVP — `rig team done <run-id> <task-id>`.
 *
 * An agent cannot complete a task, so this is the owner's one action: it reads what the daemon
 * observed and forwards exactly that to `tasks/outcome`. What matters here is that it invents no
 * evidence — an unvalidated candidate is refused before the write, and a reviewer's completion
 * cannot be recorded without its findings.
 */

const state: DaemonState = { pid: 42, port: 7433, db: "test.sqlite", startedAt: "2026-10-31T00:00:00Z" };

const evidence = { validated: true, manifestDigest: "sha256:" + "a".repeat(64), base: "commit",
  baseIdentifier: "b".repeat(40), fileCount: 3, changedPaths: ["src/result.ts"], outsideAssignment: [], reasons: [] };

const completion = (overrides: Record<string, unknown> = {}) => ({
  taskId: "task", qitemId: "qitem-1", role: "implementer", subjectTaskId: "task", queueState: "in-progress", taskVersion: 2,
  actorSession: "builder@rig", attempt: { attemptId: "attempt-1", entityVersion: 1, state: "stopped", observed: true },
  openAttempts: 0, blockedReason: null, findingsRequired: false, evidence, ...overrides,
});

function deps(fetchImpl: typeof fetch): TeamStartDeps {
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true), readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
  return { lifecycleDeps, ownerToken: "owner-token", fetchImpl };
}

/** A daemon answering the completion read, the run read and the outcome write. */
function daemon(value: unknown, outcome: { status?: number; body?: unknown } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/completion")) return new Response(JSON.stringify({ protocolVersion: "1.0", completion: value }), { status: 200 });
    if (method === "POST" && url.endsWith("/tasks/outcome")) {
      return new Response(JSON.stringify(outcome.body ?? { status: "observed", reviewTaskId: "task-review-1" }),
        { status: outcome.status ?? 200 });
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
  } catch (error) {
    // Commander's exitOverride turns a thrown command error into a rejection; the CLI prints
    // its message, so that is the line under test.
    return { lines: [...lines, (error as Error).message], code: process.exitCode };
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = saved;
  }
}

afterEach(() => { vi.restoreAllMocks(); });

describe("rig team done", () => {
  it("forwards the daemon's own observation and evidence to the outcome command", async () => {
    const fetchImpl = daemon(completion());
    const result = await run(["team", "done", "run-1", "task"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    const [url, init] = calls.find(([path, request]) => request.method === "POST")!;
    expect(url).toBe("http://127.0.0.1:7433/api/team-control/runs/run-1/tasks/outcome");
    // The outcome command addresses the task by its queue row. Sending the run's task id
    // instead is refused as an unknown entity, so the owner action could never record anything.
    expect(JSON.parse(String(init.body))).toMatchObject({ runId: "run-1", actionId: "qitem-1", expectedEntityVersion: 7,
      payload: { expectedTaskVersion: 2, state: "done", closureReason: "no-follow-on", actorSession: "builder@rig",
        attemptId: "attempt-1", expectedAttemptVersion: 1, evidence } });
    expect(result.lines.join("\n")).toContain("Recorded task as done.");
    expect(result.lines.join("\n")).toContain("task-review-1 was created");
  });

  it("records a failure, which needs no validated candidate", async () => {
    const fetchImpl = daemon(completion({ evidence: { ...evidence, validated: false, reasons: ["The candidate moves no path"] } }),
      { body: { status: "observed" } });
    const result = await run(["team", "done", "run-1", "task", "--failed"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    const body = JSON.parse(String(calls.find(([, request]) => request.method === "POST")![1].body));
    expect(body.payload).toMatchObject({ state: "failed", evidence: { validated: false } });
    expect(body.payload.closureReason).toBeUndefined();
  });

  it("refuses an unvalidated completion before writing anything", async () => {
    const fetchImpl = daemon(completion({ evidence: { ...evidence, validated: false, reasons: ["1 changed path(s) fall outside the assignment"] } }));
    const result = await run(["team", "done", "run-1", "task"], deps(fetchImpl));
    expect(result.lines.join("\n")).toContain("is not validated: 1 changed path(s) fall outside the assignment");
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls.some(([, request]) => request.method === "POST")).toBe(false);
  });

  it("requires a reviewer's findings before recording its review", async () => {
    const fetchImpl = daemon(completion({ taskId: "task-review-1", role: "reviewer", findingsRequired: true }));
    const missing = await run(["team", "done", "run-1", "task-review-1"], deps(fetchImpl));
    expect(missing.lines.join("\n")).toContain("is a reviewer task; pass its report with --findings");

    // With the report supplied, it travels as the evidence the loop acts on.
    const directory = mkdtempSync(join(tmpdir(), "team-done-"));
    try {
      const path = join(directory, "findings.json");
      writeFileSync(path, JSON.stringify({ findings: [] }));
      const withReport = await run(["team", "done", "run-1", "task-review-1", "--findings", path], deps(fetchImpl));
      expect(withReport.code).toBeUndefined();
      const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
      const body = JSON.parse(String(calls.find(([, request]) => request.method === "POST")![1].body));
      expect(body.payload.evidence).toMatchObject({ validated: true, findings: { findings: [] } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports the daemon's own blocked reason instead of writing", async () => {
    const fetchImpl = daemon(completion({ blockedReason: "The attempt has not been observed to stop" }));
    const result = await run(["team", "done", "run-1", "task"], deps(fetchImpl));
    expect(result.lines.join("\n")).toContain("The attempt has not been observed to stop");
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls.some(([, request]) => request.method === "POST")).toBe(false);
  });
});
