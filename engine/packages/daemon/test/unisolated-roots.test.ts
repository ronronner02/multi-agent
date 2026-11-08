import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { unisolatedWorkerRoots } from "../src/domain/unisolated-roots.js";

describe("unisolated mailbox roots", () => {
  let directory: string;
  const fallbackRoots = new Set<string>();
  beforeEach(() => { directory = realpathSync(mkdtempSync("/tmp/roots-")); });
  afterEach(() => {
    for (const root of fallbackRoots) rmSync(root, { recursive: true, force: true });
    fallbackRoots.clear();
    rmSync(directory, { recursive: true, force: true });
  });
  const rootsFor = (home: string) => {
    const roots = unisolatedWorkerRoots(home);
    if (roots.mailboxRoot !== join(home, "sock")) fallbackRoots.add(roots.mailboxRoot);
    return roots;
  };
  const endpoint = (root: string) => join(root, "local", "12345678-1234-1234-1234-123456789012", "mailbox.sock");

  it("preserves the existing mailbox location when the full endpoint fits", () => {
    const home = join(directory, "home");
    const roots = rootsFor(home);
    expect(roots.mailboxRoot).toBe(join(home, "sock"));
    expect(roots.assignmentRoot).toBe(join(home, "state/workers/assignments"));
  });

  it("opens a real socket for a deep profile without moving its worktrees or database", async () => {
    const home = join(directory, "nested-profile-".repeat(8));
    const roots = rootsFor(home);
    const path = endpoint(roots.mailboxRoot);
    expect(Buffer.byteLength(path)).toBeLessThan(108);
    expect(rootsFor(home).mailboxRoot).toBe(roots.mailboxRoot);
    expect(rootsFor(home + "-other").mailboxRoot).not.toBe(roots.mailboxRoot);
    expect(roots.assignmentRoot).toBe(join(home, "state/workers/assignments"));
    expect(lstatSync(roots.mailboxRoot).mode & 0o777).toBe(0o700);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
      expect(lstatSync(path).isSocket()).toBe(true);
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("counts UTF-8 bytes rather than characters against the socket limit", () => {
    const home = join(directory, "界".repeat(14));
    const roots = rootsFor(home);
    expect(roots.mailboxRoot).not.toBe(join(home, "sock"));
    expect(Buffer.byteLength(endpoint(roots.mailboxRoot))).toBeLessThan(108);
  });

  it("rejects a substituted fallback symlink without writing inside its target", () => {
    const home = join(directory, "deep-profile-".repeat(8));
    const root = rootsFor(home).mailboxRoot;
    expect(root).not.toBe(join(home, "sock"));
    const target = join(directory, "foreign-target");
    mkdirSync(target);
    rmSync(root, { recursive: true });
    symlinkSync(target, root);
    expect(() => rootsFor(home)).toThrow("Local mailbox root must be private and canonical");
    expect(readdirSync(target)).toEqual([]);
  });

  it("rejects a permissive fallback instead of changing its ownership or permissions", () => {
    const home = join(directory, "deep-profile-".repeat(8));
    const root = rootsFor(home).mailboxRoot;
    expect(root).not.toBe(join(home, "sock"));
    chmodSync(root, 0o777);
    expect(() => rootsFor(home)).toThrow("Local mailbox root must be private and canonical");
    expect(lstatSync(root).mode & 0o777).toBe(0o777);
  });
});
