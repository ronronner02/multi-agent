import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// T038 — installed-client acceptance through the daemon-mediated lane.
//
// `worker-control-isolation.test.ts` proves the privileged launcher's boundary directly, with a
// hand-built request. This suite proves the *other* half: that the production composition can
// reach that launcher at all — `createDaemon` in managed mode, `WorkflowRuntime` producing the
// context projection and the mailbox endpoint, the adapter's launch preflight, and the
// privileged launcher's own inspection — with every step running as the daemon's own identity.
//
// That distinction is not academic. The producer runs as the control identity, which is
// deliberately not a member of any worker group and cannot traverse a worker-owned 0700 path.
// Three separate defects in that lane (a setgid chmod, a realpath of the worker's scratch, and
// a realpath of the worker's home) each failed every live produce before any client started,
// and none of them is reachable from a suite that constructs the launcher request by hand.
//
// PROVIDER CALLS. The `fresh` phase below starts a real native client and therefore spends the
// inherited allowance. It runs only when `MA_T038_LIVE=1`, and refuses rather than skips when
// the allowance record is missing or has no room. `produce` and `restart` spend nothing: they
// stop before any native client is spawned, which is what makes them usable as an ordinary gate.

const NODE = "/opt/multi-agent/toolchain/node/bin/node";
const SUDO = "/usr/bin/sudo";
const POLICY = "/etc/multi-agent/worker-policy.json";
const LOCK = "/etc/multi-agent/client-lock.json";
const LAUNCHER = "/usr/local/libexec/multi-agent/worker-launch";
const GATEWAY = "/etc/multi-agent/provider-gateway.json";
const CONTROL = "ma-control";
const ACCEPTANCE = process.env.MA_T038_ACCEPTANCE === "1";
const LIVE = process.env.MA_T038_LIVE === "1";
/** The allowance record the owner provisions beside the spent T010 one (AGENTS.md, 2026-10-30). */
const ALLOWANCE = ".spec-first/workflows/spec-work/multi-agent/20261029T162000Z-t038-live-acceptance/live-allowance-t038-reacceptance.json";

const installed = existsSync(POLICY) && existsSync(LOCK) && existsSync(LAUNCHER);
const repoRoot = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

/** A receipt is required here, so a missing prerequisite is a failure, never a skip. */
function requireInstalled(): void {
  if (installed) return;
  if (ACCEPTANCE || LIVE) {
    throw new Error("acceptance requires the installed policy, launcher and client lock; set them up or unset MA_T038_ACCEPTANCE");
  }
}

interface Allowance {
  native_invocations_attempted: number; maximum_native_invocations: number;
  reported_tokens: number; maximum_reported_tokens: number; deadline: string | null;
}

/** The allowance as recorded, or undefined when the owner has not provisioned it. */
function allowance(): Allowance | undefined {
  const path = join(repoRoot, ALLOWANCE);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Allowance;
}

/**
 * The lane's phases, driven as the control identity in a child process.
 *
 * `produce` stops after the producer returns, so it exercises every control-side step — the
 * projection, the mailbox endpoint, the candidate — and starts no client. `fresh` continues
 * through the composed adapter into a real native launch. `restart` opens a second daemon on
 * the same database and re-reads the recorded session state, which is the restart claim
 * without a second provider call.
 */
function phase(name: "produce" | "fresh" | "resume" | "restart", client: "claude-code" | "codex", home: string): {
  status: number | null; result: Record<string, unknown>; raw: string } {
  const daemon = join(repoRoot, "engine/packages/daemon");
  const script = join(daemon, "test/fixtures/t038-live-daemon.mjs");
  // The fixture imports the rebuilt dist tree; it never mixes source and stale emitted modules.
  const run = spawnSync(SUDO, ["-n", "-u", CONTROL, "--", "/usr/bin/env", "HOME=" + home,
    "PATH=/opt/multi-agent/toolchain/node/bin:/usr/bin:/bin",
    NODE, script, name, client],
  { encoding: "utf8", timeout: 900_000, cwd: daemon, stdio: ["ignore", "pipe", "pipe"] });
  const raw = (run.stdout ?? "") + (run.stderr ?? "");
  const line = raw.split("\n").find(entry => entry.startsWith("T038-RESULT "));
  if (!line) return { status: run.status, result: {}, raw };
  return { status: run.status, result: JSON.parse(line.slice("T038-RESULT ".length)) as Record<string, unknown>, raw };
}

describe("daemon-mediated acceptance prerequisites", () => {
  it(`${ACCEPTANCE ? "requires" : "reports"} the installed launcher, policy and lock`, () => {
    if (ACCEPTANCE) expect(installed, "installed launcher, policy and lock must exist").toBe(true);
    else expect(typeof installed).toBe("boolean");
  });

  it("reports the allowance the owner recorded, and never resets it", () => {
    const recorded = allowance();
    if (ACCEPTANCE || LIVE) {
      expect(recorded, "the re-acceptance allowance record must exist").toBeDefined();
      expect(recorded!.native_invocations_attempted).toBeLessThan(recorded!.maximum_native_invocations);
    } else expect(recorded === undefined || Number.isInteger(recorded.native_invocations_attempted)).toBe(true);
  });
});

describe.skipIf(!installed)("the daemon-mediated lane", () => {
  /**
   * A home the control identity owns.
   *
   * It cannot be made by this process: `mkdtemp` creates 0700 owned by the runner, and the
   * harness then fails to create its own work directory inside it. The directory is created
   * through sudo instead, so the identity that will write to it is the one that owns it.
   */
  const home = (): string => {
    const made = spawnSync(SUDO, ["-n", "-u", CONTROL, "--", "/usr/bin/mktemp", "-d", "-p", tmpdir(), "t038-live-XXXXXX"],
      { encoding: "utf8" });
    if (made.status !== 0) throw new Error("could not create the control-owned home: " + (made.stderr ?? ""));
    return made.stdout.trim();
  };
  const clean = (path: string) => {
    spawnSync(SUDO, ["-n", "-u", CONTROL, "--", "/usr/bin/rm", "-rf", path]);
    try { rmSync(path, { recursive: true, force: true }); } catch { /* already gone */ }
  };

  it("produces an attempt through the production composition as the control identity", () => {
    requireInstalled();
    const directory = home();
    try {
      const produced = phase("produce", "claude-code", directory);
      // A produce that failed reports the producer's own error, which is what names the defect.
      expect(produced.result.error).toBeUndefined();
      expect(produced.result.attempt).toMatchObject({ attemptId: expect.any(String), contextHash: expect.stringMatching(/^sha256:/) });
      expect(produced.result.candidate).toEqual(expect.stringContaining("/assignments/"));
    } finally { clean(directory); }
  }, 900_000);

  const liveHomes = new Map<string, string>();
  let priorLiveFailure = false;
  it.skipIf(!LIVE).each([
    ["fresh", "claude-code"], ["fresh", "codex"],
    ["resume", "claude-code"], ["resume", "codex"],
  ] as const)("%s %s through the production chain with an exact receipt", (name, client) => {
    requireInstalled();
    expect(priorLiveFailure, "stop the matrix after a failed live phase").toBe(false);
    expect(existsSync(GATEWAY), "a provider gateway or per-worker sign-in must be installed").toBe(true);
    const recorded = allowance()!;
    expect(recorded.native_invocations_attempted, "the allowance must have room for this call")
      .toBeLessThan(recorded.maximum_native_invocations);
    expect(recorded.reported_tokens).toBeLessThan(recorded.maximum_reported_tokens);
    expect(recorded.deadline, "the live runner must open the owner-approved window").toBeTruthy();
    expect(Date.parse(recorded.deadline!)).toBeGreaterThan(Date.now());
    let directory = process.env.T038_LIVE_HOME ?? liveHomes.get(client);
    if (!directory) {
      expect(name, "resume requires the home retained by its fresh phase").toBe("fresh");
      directory = home();
      liveHomes.set(client, directory);
    }
    // Retain live homes and receipts until the owner-controlled stop and cleanup, not while clients still run.
    try {
      const previous = name === "resume" ? JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) : undefined;
      const result = phase(name, client, directory);
      expect(result.result.error).toBeUndefined();
      expect(result.result.launch).toMatchObject({ ok: true, managedSession: expect.anything() });
      if (previous) {
        expect(result.result.launch).toMatchObject({ resumeToken: previous.resumeToken,
          managedSession: { identity: { nativeSessionId: previous.receipt.identity.nativeSessionId,
            generation: previous.receipt.identity.generation + 1 } } });
      }
    } catch (error) { priorLiveFailure = true; throw error; }
  }, 900_000);

  it.skipIf(!LIVE).each(["claude-code", "codex"] as const)("restarts the daemon with a live %s session", client => {
    expect(priorLiveFailure, "stop the matrix after a failed live phase").toBe(false);
    const directory = process.env.T038_LIVE_HOME ?? liveHomes.get(client);
    expect(directory, "restart requires a retained live home").toBeDefined();
    const restarted = phase("restart", client, directory!);
    expect(restarted.result.error).toBeUndefined();
    expect(restarted.result.restart).toMatchObject({ sameAttempt: true, liveIdentityObserved: true });
  }, 900_000);
});
