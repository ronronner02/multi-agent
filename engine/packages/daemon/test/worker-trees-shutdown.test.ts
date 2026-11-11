import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { endRunningWorkerTrees } from "../src/domain/process-termination.js";

/**
 * U12 — what a desktop-owned daemon does at shutdown.
 *
 * The Electron app owns the daemon and stops it when the app quits, so the workers the daemon
 * started have to end with it. Every attempt's own process pair is the target, and a tree that
 * cannot be proved gone is reported rather than claimed as stopped.
 */
describe("U12 ending the worker trees of a desktop-owned daemon", () => {
  let db: ReturnType<typeof createDb>;
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "u12-worker-trees-"));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    // One rig and one run: every attempt row references them.
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, phase, created_at, updated_at)
      VALUES ('run-1', 'rig', '{}', 'digest', 'approved', 'planning', '2026-11-10', '2026-11-10')`).run();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** Insert one running attempt with a recorded identity, in the shape a launch receipt writes. */
  const runningAttempt = (id: string, identity: { processId: number; processStart: string }, state = "running"): void => {
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, state, identity_json, unknown_reason,
        usage_json, active_ms, entity_version, created_at, updated_at)
      VALUES (?, ?, NULL, 'implementer', 'codex', ?, ?, ?, '{}', 0, 1, ?, ?)`)
      .run(id, "run-1", state, JSON.stringify(identity),
        state === "unknown" ? "identity_unresolved" : null, new Date().toISOString(), new Date().toISOString());
  };

  it("ends every running attempt's recorded identity through the identity-checked tree kill", async () => {
    const a = { processId: 111, processStart: "2026-11-10T00:00:00.000Z" };
    const b = { processId: 222, processStart: "2026-11-10T00:01:00.000Z" };
    runningAttempt("attempt-a", a);
    runningAttempt("attempt-b", b);
    // A stopped attempt's process is already gone and must not be signalled again.
    runningAttempt("attempt-c", { processId: 333, processStart: "2026-11-10T00:02:00.000Z" }, "stopped");
    // An `unknown` attempt is a fact about identity, not a live process: boot recovery owns it.
    runningAttempt("attempt-d", { processId: 444, processStart: "2026-11-10T00:03:00.000Z" }, "unknown");

    const aimedAt: Array<{ processId: number; processStart: string }> = [];
    const result = await endRunningWorkerTrees(db, async identity => {
      aimedAt.push(identity);
      return { outcome: "stopped", escalated: true, waitedMs: 5 };
    });

    expect(aimedAt).toEqual([a, b]);
    expect(result).toEqual({ attempted: 2, stopped: 2, unresolved: 0 });
  });

  it("treats a client that already exited as ended and counts a survivor as unresolved", async () => {
    runningAttempt("attempt-a", { processId: 111, processStart: "t1" });
    runningAttempt("attempt-b", { processId: 222, processStart: "t2" });
    runningAttempt("attempt-c", { processId: 333, processStart: "t3" });
    const outcomes = new Map<number, "not-running" | "unresolved">([[111, "not-running"], [222, "unresolved"], [333, "unresolved"]]);
    const result = await endRunningWorkerTrees(db, async identity => ({
      outcome: outcomes.get(identity.processId)!, escalated: false, waitedMs: 1,
    }));
    // 111 was already gone; the other two are not proved gone, so the daemon does not claim a stop.
    expect(result).toEqual({ attempted: 3, stopped: 1, unresolved: 2 });
  });

  it("counts a termination that threw as unresolved rather than crashing the shutdown", async () => {
    runningAttempt("attempt-a", { processId: 111, processStart: "t1" });
    const result = await endRunningWorkerTrees(db, async () => { throw new Error("identity query denied"); });
    expect(result).toEqual({ attempted: 1, stopped: 0, unresolved: 1 });
  });

  it("does nothing when no attempt is running", async () => {
    const result = await endRunningWorkerTrees(db, async () => { throw new Error("nothing should be signalled"); });
    expect(result).toEqual({ attempted: 0, stopped: 0, unresolved: 0 });
  });

  // Windows has no process groups: the tree kill is `taskkill /T /F`, aimed at the recorded pair.
  // A real child is started here so the proof is a process that is actually gone afterwards.
  it.skipIf(process.platform !== "win32")("ends a real running worker and its grandchild", async () => {
    const { spawn } = await import("node:child_process");
    const { readSpawnCreationTime } = await import("../src/adapters/child-process-supervisor.js");
    const { observeIdentity } = await import("../src/domain/process-termination.js");

    // A parent that starts a grandchild and waits: the grandchild is what a plain `child.kill()`
    // leaves behind, and `taskkill /T` is what reaches it.
    const script = `const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('grandchild=' + grandchild.pid);
setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    try {
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the worker printed no grandchild pid")), 15_000);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", chunk => {
          const match = /grandchild=(\d+)/.exec(String(chunk));
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        child.once("error", reject);
      });
      const processStart = await readSpawnCreationTime(child.pid!);
      expect(processStart, "the worker's creation time is the identity recovery uses").toBeTruthy();
      const identity = { processId: child.pid!, processStart: processStart! };
      expect(await observeIdentity(identity), "the worker is alive before the shutdown").toBe("alive");
      runningAttempt("attempt-live", identity);

      const result = await endRunningWorkerTrees(db);

      expect(result).toEqual({ attempted: 1, stopped: 1, unresolved: 0 });
      expect(await observeIdentity(identity), "the worker is gone after the shutdown").toBe("dead");
      // The grandchild is the one a plain kill would have leaked.
      expect(await observeIdentity({ processId: grandchildPid, processStart: "unobserved" })).not.toBe("alive");
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  }, 60_000);
});