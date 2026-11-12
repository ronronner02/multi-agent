// The stop path's Windows exit semantics. Windows `SIGTERM` terminates the process outright: the
// daemon never runs its drain, so it writes no shutdown receipt, and the just-killed listener
// answers the post-kill probe with a reset of the socket it was holding rather than a refusal.
// These cases inject the platform, so they run on every OS.
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { daemonCommand } from "../src/commands/daemon.js";
import { STATE_FILE, getDaemonStatus, stopDaemon, type LifecycleDeps } from "../src/daemon-lifecycle.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

const RECEIPT = path.join(path.dirname(STATE_FILE), "daemon-shutdown.json");
type AfterKill = "reset-then-refused" | "refused" | "responding";
function fixture(opts: { platform: NodeJS.Platform; survives?: boolean; cleanup?: "stale" | "clean" | "none"; afterKill?: AfterKill }) {
  let killed = false;
  let removed = false;
  const state = { pid: 987, host: "127.0.0.1", port: 17434, db: "private.db", startedAt: "2026-01-01T00:00:00Z" };
  let probesAfterKill = 0;
  const receiptPresent = opts.cleanup === "stale" || opts.cleanup === "clean";
  const receipt = opts.cleanup === "clean" ? JSON.stringify({
    schema: "multi-agent.daemon-shutdown/v1", pid: 987, startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(), outcome: "clean", phase: "complete", failures: [],
  }) : null;
  const deps = {
    platform: opts.platform,
    exists: (p: string) => (p === STATE_FILE && !removed) || (p === RECEIPT && receiptPresent),
    readFile: (p: string) => p === STATE_FILE ? (removed ? null : JSON.stringify(state))
      : p === RECEIPT ? receipt : null,
    removeFile: () => { removed = true; },
    isProcessAlive: vi.fn(() => !killed || opts.survives === true),
    kill: vi.fn(() => { killed = true; return true; }),
    fetch: vi.fn(async (url: string) => {
      if (!url.includes(":17434/")) return { ok: true }; // unrelated configured listener
      if (!killed) return { ok: true };
      probesAfterKill++;
      if (opts.afterKill === "responding") return { ok: true };
      // Windows: the killed process resets the pooled connection it was holding, then the port refuses.
      if (opts.afterKill !== "refused" && probesAfterKill === 1) {
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }),
  } as unknown as LifecycleDeps;
  return { deps, removed: () => removed };
}

/** Fake timers drive the kill-wait and the win32 listener settle; pump them before awaiting. */
async function settle<T>(work: Promise<T>): Promise<T> {
  const outcome = work.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ("error" in result) throw result.error;
  return result.value;
}

async function stop(deps: LifecycleDeps) {
  process.exitCode = undefined;
  const out = vi.spyOn(console, "log").mockImplementation(() => {}).mockClear();
  const err = vi.spyOn(console, "error").mockImplementation(() => {}).mockClear();
  await settle(new Command().addCommand(daemonCommand(deps)).parseAsync(["node", "multi-agent", "daemon", "stop"]));
  return { out: out.mock.calls.flat().join(" "), err: err.mock.calls.flat().join(" "), code: process.exitCode };
}

/** `daemon status` over the injected HTTP fetch, with the injected platform for its classification. */
async function status(platform: NodeJS.Platform, fetchImpl: typeof fetch) {
  vi.useFakeTimers();
  process.exitCode = undefined;
  const out = vi.spyOn(console, "log").mockImplementation(() => {}).mockClear();
  const err: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { err.push(args.join(" ")); });
  try {
    await settle(new Command().addCommand(daemonCommand({ platform } as LifecycleDeps,
      { baseUrl: "http://127.0.0.1:17434", fetchImpl })).parseAsync(["node", "multi-agent", "daemon", "status"]));
  } catch (error) {
    // The real CLI entry renders this and exits; a bare parse rethrows it.
    err.push(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  return { out: out.mock.calls.flat().join(" "), err: err.join(" "), code: process.exitCode };
}

it("win32: terminates without a drain, reports it honestly, removes the state, and exits zero", async () => {
  vi.useFakeTimers();
  const { deps, removed } = fixture({ platform: "win32" });
  await expect(settle(stopDaemon(deps))).resolves.toBe("terminated");
  expect(deps.kill).toHaveBeenCalledTimes(1);
  expect(removed()).toBe(true);

  const result = await stop(fixture({ platform: "win32" }).deps);
  expect(result.code).toBeUndefined();
  expect(result.err).toBe("");
  expect(result.out).toContain("Daemon terminated without a graceful drain; it reconciles interrupted work at its next start.");
  expect(result.out).not.toContain("Daemon stopped");
});

it("win32: a surviving PID keeps the existing error and preserves the state", async () => {
  vi.useFakeTimers();
  const { deps, removed } = fixture({ platform: "win32", survives: true });
  await expect(settle(stopDaemon(deps))).rejects.toThrow(/did not exit/i);
  expect(removed()).toBe(false);
});

it("win32: a still-responding listener keeps the unverified error", async () => {
  vi.useFakeTimers();
  const { deps, removed } = fixture({ platform: "win32", afterKill: "responding" });
  await expect(settle(stopDaemon(deps))).rejects.toThrow(/unverified.*listener responding/i);
  expect(removed()).toBe(false);
});

it("win32: after the stop, daemon status reports the stopped state rather than a connection error", async () => {
  vi.useFakeTimers();
  const { deps } = fixture({ platform: "win32" });
  await settle(stopDaemon(deps));
  // Nothing listens on the recorded endpoint any more. With the matching state removed, a status
  // read probes the configured target and gets a refusal — positive evidence for "stopped" —
  // instead of the removed recorded endpoint.
  (deps.fetch as ReturnType<typeof vi.fn>).mockClear();
  (deps.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
    Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
  expect((await settle(getDaemonStatus(deps))).state).toBe("stopped");
  expect(vi.mocked(deps.fetch).mock.calls.every(([url]) => !String(url).includes(":17434/"))).toBe(true);

  const refused = vi.fn(async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  const seen = await status("win32", refused);
  expect(seen.code).toBeUndefined();
  expect(seen.out).toBe("Daemon stopped");
});

it("win32: status keeps the connection error for anything but a refusal", async () => {
  const refused = vi.fn(async () => { throw Object.assign(new Error("blocked"), { cause: { code: "EPERM" } }); });
  const result = await status("win32", refused);
  expect(result.code).toBe(1);
  expect(result.err).toMatch(/Cannot connect/);
});

it("posix: status keeps the existing connection error on refusal", async () => {
  const refused = vi.fn(async () => { throw Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } }); });
  const result = await status("linux", refused);
  expect(result.code).toBe(1);
  expect(result.err).toMatch(/Cannot connect/);
});

it("posix: an absent PID with a refused listener still demands the matching receipt", async () => {
  vi.useFakeTimers();
  const { deps, removed } = fixture({ platform: "linux", cleanup: "none", afterKill: "refused" });
  await expect(settle(stopDaemon(deps))).rejects.toThrow(/unverified.*no matching shutdown receipt/i);
  expect(removed()).toBe(false);

  // And the same platform removes the state only with that receipt.
  const clean = fixture({ platform: "linux", cleanup: "clean", afterKill: "refused" });
  await expect(settle(stopDaemon(clean.deps))).resolves.toBe("stopped");
  expect(clean.removed()).toBe(true);
});