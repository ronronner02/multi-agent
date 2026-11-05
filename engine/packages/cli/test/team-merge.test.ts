import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { TeamStartDeps } from "../src/commands/team.js";

/**
 * U7 — `rig team merge <run-id>`.
 *
 * The daemon does the merge into the repository the team was created for, so this verb's job is
 * to send the one request and report what came back: how the branch joined the owner's branch,
 * or the named reason it did not. It must never print a merge as done when the daemon refused
 * it, and the refusal's code and reason have to reach the owner unchanged.
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

/** A daemon answering the run read and the merge write with the given answer. */
function daemon(merge: { status?: number; body: unknown }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST" && url.endsWith("/merge")) {
      return new Response(JSON.stringify(merge.body), { status: merge.status ?? 200 });
    }
    return new Response(JSON.stringify({ protocolVersion: "1.0", run: { entityVersion: 9 } }), { status: 200 });
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

describe("rig team merge", () => {
  it("posts the run's current version and reports a fast-forward", async () => {
    const fetchImpl = daemon({ body: { status: "merged", code: null, reason: null,
      branch: "team/add-a-health-endpoint-run-1", mode: "fast-forward", head: "0123456789abcdef0123456789abcdef01234567" } });
    const result = await run(["team", "merge", "run-1"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    const [url, init] = calls.find(([, request]) => request.method === "POST")!;
    expect(url).toBe("http://127.0.0.1:7433/api/team-control/runs/run-1/merge");
    expect(JSON.parse(String(init.body))).toMatchObject({ protocolVersion: "1.0", runId: "run-1", actionId: "run-1",
      expectedEntityVersion: 9, payload: {} });
    expect(result.lines.join("\n")).toContain("Merged team/add-a-health-endpoint-run-1 (fast-forwarded) at 0123456.");
  });

  it("says a merge commit was made, and that an unchanged branch was already up to date", async () => {
    const mergeCommit = await run(["team", "merge", "run-1"], deps(daemon({ body: { status: "merged",
      branch: "team/add-a-health-endpoint-run-1", mode: "merge-commit", head: "abcdef0123456789abcdef0123456789abcdef01" } })));
    expect(mergeCommit.lines.join("\n")).toContain("(merged with one commit)");
    const upToDate = await run(["team", "merge", "run-1"], deps(daemon({ body: { status: "merged",
      branch: "team/add-a-health-endpoint-run-1", mode: "up-to-date", head: "abcdef0123456789abcdef0123456789abcdef01" } })));
    expect(upToDate.lines.join("\n")).toContain("(already up to date)");
  });

  it("prints a named refusal instead of claiming a merge", async () => {
    const result = await run(["team", "merge", "run-1"], deps(daemon({ status: 409, body: { status: "refused",
      code: "merge_checkout_dirty", reason: "The owner's checkout has uncommitted changes; commit or stash them and merge again.",
      branch: "team/add-a-health-endpoint-run-1", mode: null, head: null } })));
    const printed = result.lines.join("\n");
    expect(printed).toContain("commit or stash them and merge again");
    expect(printed).not.toContain("Merged team/");
  });

  it("prints the daemon's answer as JSON when asked", async () => {
    const result = await run(["team", "merge", "run-1", "--json"], deps(daemon({ body: { status: "merged",
      branch: "team/add-a-health-endpoint-run-1", mode: "fast-forward", head: "0123456789abcdef0123456789abcdef01234567" } })));
    const printed = JSON.parse(result.lines.join("\n")) as Record<string, unknown>;
    expect(printed).toMatchObject({ status: "merged", mode: "fast-forward" });
  });
});