import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listProjectDirectories } from "../src/domain/project-bootstrap.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("owner project folder browser", () => {
  let directory: string, home: string, outside: string;
  beforeEach(() => {
    // The long form: a Windows `%TEMP%` may be an 8.3 short name and the browser reports the
    // long spelling the daemon canonicalised to.
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "team-fs-")));
    home = join(directory, "home");
    outside = join(directory, "outside");
    mkdirSync(join(home, "project"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(home, "file.txt"), "not a directory\n");
    symlinkSync(outside, join(home, "escape"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("lists selectable roots, then only contained directories", () => {
    expect(listProjectDirectories(undefined, [home])).toEqual({
      roots: [home], path: null, directories: [{ name: "home", path: home }],
    });
    expect(listProjectDirectories(home, [home])).toEqual({
      roots: [home], path: home, directories: [{ name: "project", path: join(home, "project") }],
    });
  });

  it("rejects paths outside the roots and symlinks that leave them", () => {
    for (const path of [outside, join(home, "escape"), directory, "relative"]) {
      expect(() => listProjectDirectories(path, [home])).toThrow(expect.objectContaining({ code: "team_folder_refused" }));
    }
  });
});

describe("folder browser route", () => {
  it("requires the paired owner and keeps listing on the managed team-control surface", async () => {
    const db = createFullTestDb();
    try {
      fixDaemonMode(db, true);
      const app = createTestApp(db, { appDeps: { teamControl: { credentials: { ownerToken: "owner-fs-fixture",
        workers: [{ token: "worker-fs-fixture", sessionId: "worker@fixture", runId: "other" }] } } } }).app;
      const call = (path: string, token?: string) => app.request("/api/team-control/fs/dirs" + path,
        { headers: token ? { Authorization: "Bearer " + token } : {} },
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
      expect((await call("", "worker-fs-fixture")).status).toBe(403);
      expect((await call("")).status).toBe(401);
      const roots = await call("", "owner-fs-fixture");
      expect(roots.status).toBe(200);
      expect(roots.headers.get("Cache-Control")).toBe("no-store");
      expect(await roots.json()).toMatchObject({ protocolVersion: "1.0", roots: expect.arrayContaining([homedir()]), path: null });
      expect((await call("?path=%2F", "owner-fs-fixture")).status).toBe(400);
    } finally { db.close(); }
  });
});
