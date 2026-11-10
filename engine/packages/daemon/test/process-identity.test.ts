import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { queryWindowsProcesses, setHostPlatformForTests } from "../src/domain/platform.js";
import {
  identityAlive, observeIdentity, processIdentityAlive, terminateProcessGroup,
} from "../src/domain/process-termination.js";

/**
 * U1 / KTD5 — a recorded process identity is pid *plus* a start marker, and an unproved identity is
 * never dead and never signalled.
 *
 * The POSIX path reads `/proc`; the Windows path asks CIM for the pid's creation time. Both are
 * pinned through the platform override, and the two cases that need the real Windows OS run only
 * there: a real creation time, and a real child-plus-grandchild tree ended with `taskkill /T /F`.
 */

afterEach(() => { setHostPlatformForTests(null); });

const POSIX = { platform: "posix" } as const;

describe("U1 recorded process identity", () => {
  it("treats a live POSIX process as alive, a moved start as not-ours, and a missing pid as dead", async () => {
    setHostPlatformForTests("posix");
    if (process.platform === "win32") return;
    const { readFileSync } = await import("node:fs");
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]!;
    expect(await observeIdentity({ processId: process.pid, processStart: start })).toBe("alive");
    expect(await observeIdentity({ processId: process.pid, processStart: "not-the-start" })).toBe("not-ours");
    expect(await observeIdentity({ processId: 2 ** 22 + 12345, processStart: "x" })).toBe("dead");
    expect(await processIdentityAlive({ processId: process.pid, processStart: start })).toBe(true);
    expect(await identityAlive({ processId: process.pid, processStart: "moved" })).toBe(true);
  });

  it("answers unknown, not dead, when the Windows query cannot be made", async () => {
    setHostPlatformForTests("win32");
    // A denied or timed-out query is unknown: no caller may record an end from it.
    expect(await observeIdentity({ processId: -1, processStart: "x" })).toBe("unknown");
  });

  it("never signals or claims a stop for a Windows identity that is not ours", async () => {
    setHostPlatformForTests("win32");
    let killed = false;
    const result = await terminateProcessGroup({ processId: 4242, processStart: "recorded" }, {
      observeWindows: async () => "not-ours",
      killTree: async () => { killed = true; },
      now: (() => { let t = 0; return () => (t += 1_000); })(),
      limitMs: 5_000,
    });
    expect(killed).toBe(false);
    expect(result).toMatchObject({ outcome: "unresolved", escalated: false });
  });

  it("kills a Windows tree, then proves the stop from the recorded identity", async () => {
    setHostPlatformForTests("win32");
    const seen: string[] = [];
    let state: "alive" | "dead" = "alive";
    const result = await terminateProcessGroup({ processId: 4242, processStart: "recorded" }, {
      observeWindows: async () => { seen.push(state); return state; },
      killTree: async (command, args) => { expect([command, ...args]).toEqual(["taskkill", "/PID", "4242", "/T", "/F"]); state = "dead"; },
      now: (() => { let t = 0; return () => (t += 100); })(),
      limitMs: 5_000,
    });
    expect(result).toMatchObject({ outcome: "stopped", escalated: true });
    expect(seen).toEqual(["alive", "dead"]);
  });

  it("reports unresolved when the tree survives the kill", async () => {
    setHostPlatformForTests("win32");
    const result = await terminateProcessGroup({ processId: 4242, processStart: "recorded" }, {
      observeWindows: async () => "alive",
      killTree: async () => {},
      sleep: async () => {},
      now: (() => { let t = 0; return () => (t += 6_000); })(),
      limitMs: 5_000,
    });
    expect(result).toMatchObject({ outcome: "unresolved", escalated: true });
  });
});

describe.skipIf(process.platform !== "win32")("U1 Windows identity on the real OS", () => {
  it("reads a real creation time and ends a child and its grandchild with the tree kill", async () => {
    const rows = await queryWindowsProcesses([process.pid]);
    const self = rows.get(process.pid);
    expect(self?.state).toBe("present");
    if (self?.state !== "present") return;
    expect(await observeIdentity({ processId: process.pid, processStart: self.creationTime })).toBe("alive");
    expect(await observeIdentity({ processId: process.pid, processStart: "2020-01-01T00:00:00.000Z" })).toBe("not-ours");

    // A parent that spawns a grandchild: `child.kill()` leaves the grandchild running on Windows,
    // and `taskkill /T /F` is what reaches it.
    const child = spawn(process.execPath, ["-e",
      "const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(g.pid); setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    try {
      const grandchild = await new Promise<number>(resolve => child.stdout!.once("data", data => resolve(Number(String(data).trim()))));
      const childRows = await queryWindowsProcesses([child.pid!]);
      const identity = childRows.get(child.pid!);
      expect(identity?.state).toBe("present");
      if (identity?.state !== "present") return;
      const result = await terminateProcessGroup({ processId: child.pid!, processStart: identity.creationTime });
      expect(result.outcome).toBe("stopped");
      const after = await queryWindowsProcesses([grandchild]);
      expect(after.get(grandchild)?.state).toBe("absent");
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 60_000);
});
