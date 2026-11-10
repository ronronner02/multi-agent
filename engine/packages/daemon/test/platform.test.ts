import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPrivateDirectory, isRedirectingEntry, isWindows, normalizeCreationTime, pathWithin,
  processOwnerIds, queryWindowsProcesses, samePath, setHostPlatformForTests, treeKillArgv,
  windowsProcessQueryScript,
} from "../src/domain/platform.js";

/**
 * U1 — the platform boundary.
 *
 * These are the facts the kept team path reads from the host: the process owner, whether an entry
 * is a link, how two paths compare, what ends a process tree, and how a Windows process identity is
 * read. The Windows branches run on any host through the module's own override, and the parts that
 * need the real OS (CIM, junctions) are pinned to Windows.
 */

const directories: string[] = [];
const temporary = (): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "u1-platform-")));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  setHostPlatformForTests(null);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("U1 platform boundary", () => {
  it("reports no process owner on Windows and the real uid/gid on POSIX", () => {
    setHostPlatformForTests("win32");
    expect(isWindows()).toBe(true);
    // Windows has no numeric owner; the caller must take its own branch rather than read a
    // substituted constant.
    if (typeof process.getuid !== "function") expect(processOwnerIds()).toBeNull();
    setHostPlatformForTests("posix");
    expect(isWindows()).toBe(false);
    if (typeof process.getuid === "function") {
      expect(processOwnerIds()).toEqual({ uid: process.getuid(), gid: process.getgid!() });
    }
  });

  it("refuses a reparse point as a private root on Windows and accepts a real directory", () => {
    const directory = temporary();
    setHostPlatformForTests("win32");
    const real = join(directory, "real");
    mkdirSync(real);
    expect(() => assertPrivateDirectory(real, null)).not.toThrow();
    if (process.platform === "win32") {
      // A junction is a reparse point: the boundary refuses it instead of trusting the mode bits.
      const target = join(directory, "target");
      mkdirSync(target);
      const link = join(directory, "link");
      symlinkSync(target, link, "junction");
      expect(isRedirectingEntry(link)).toBe(true);
      expect(() => assertPrivateDirectory(link, null)).toThrow("reparse point");
    }
  });

  it("reports a directory entry that would redirect a read", () => {
    const directory = temporary();
    const file = join(directory, "ordinary.txt");
    writeFileSync(file, "bytes\n");
    expect(isRedirectingEntry(file)).toBe(false);
    expect(isRedirectingEntry(join(directory, "missing.txt"))).toBe(false);
    if (process.platform === "win32") {
      const link = join(directory, "redirect");
      symlinkSync(directory, link, "junction");
      expect(isRedirectingEntry(link)).toBe(true);
    }
  });

  it("compares paths case-insensitively on Windows only", () => {
    setHostPlatformForTests("win32");
    expect(samePath("C:\\Repo\\Src", "c:\\repo\\src")).toBe(true);
    expect(pathWithin("C:\\Repo", "c:\\repo\\src\\a.ts")).toBe(true);
    expect(pathWithin("C:\\Repo", "C:\\Repository\\a.ts")).toBe(false);
    setHostPlatformForTests("posix");
    expect(samePath("/repo/Src", "/repo/src")).toBe(false);
    expect(pathWithin("/repo", "/repo/src/a.ts")).toBe(true);
    expect(pathWithin("/repo", "/repository/a.ts")).toBe(false);
  });

  it("names the Windows tree kill and not a signal", () => {
    expect(treeKillArgv(4242)).toEqual({ command: "taskkill", args: ["/PID", "4242", "/T", "/F"] });
  });

  it("normalizes a CIM creation time to the millisecond form both sides compare", () => {
    // CIM reports 100 ns ticks; the recorded identity and a later query must agree exactly.
    expect(normalizeCreationTime("2026-11-09T23:35:19.0464840Z")).toBe("2026-11-09T23:35:19.046Z");
    expect(normalizeCreationTime(null)).toBeNull();
    expect(normalizeCreationTime("not a date")).toBeNull();
  });

  it("builds one bounded query for the whole batch", () => {
    const script = windowsProcessQueryScript([12, 13]);
    expect(script).toContain("$ids = @(12,13)");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("CIM_ERROR");
    // Only the ids it was asked about ever reach the script.
    expect(script).not.toContain("ProcessId=14");
  });
});

describe.skipIf(process.platform !== "win32")("U1 Windows process identity", () => {
  it("answers a real pid with its creation time and an unknown pid as absent", async () => {
    const rows = await queryWindowsProcesses([process.pid, 4_194_303]);
    expect(rows.get(process.pid)?.state).toBe("present");
    expect(rows.get(4_194_303)?.state).toBe("absent");
    const present = rows.get(process.pid);
    expect(present?.state === "present" && present.creationTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 30_000);
});
