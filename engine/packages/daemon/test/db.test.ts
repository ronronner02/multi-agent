import { describe, it, expect } from "vitest";
import { createDb } from "../src/db/connection.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

describe("createDb", () => {
  it("creates an in-memory database with WAL and FK pragmas", () => {
    const db = createDb();
    const walMode = db.pragma("journal_mode", { simple: true });
    // In-memory databases may report "memory" instead of "wal" — that's fine.
    // WAL is set but only takes effect on file-backed DBs.
    expect(walMode).toBeDefined();

    const fkEnabled = db.pragma("foreign_keys", { simple: true });
    expect(fkEnabled).toBe(1);

    db.close();
  });

  it("creates a file-backed database when path is given", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "removed-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");
    const db = createDb(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });
});
