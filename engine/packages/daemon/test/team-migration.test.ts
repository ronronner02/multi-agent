import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const previousMigrations = ALL_MIGRATIONS.filter((migration) => migration.name < "104_");
const databases: Database.Database[] = [];
const directories: string[] = [];
const open = (file?: string) => {
  const db = createDb(file);
  databases.push(db);
  return db;
};
const tables = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("team governance migration", () => {
  it("adds the authority tables at migration 104 without another task-state store", () => {
    const db = open();
    migrate(db, ALL_MIGRATIONS);
    expect(tables(db)).toEqual(expect.arrayContaining([
      "team_runs", "team_approvals", "team_approval_consumptions", "team_control_requests",
      "team_queue_authority", "team_attempts",
    ]));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE name = '104_team_governance.sql'").get()).toBeDefined();
    const columns = db.prepare("PRAGMA table_info(team_queue_authority)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("state");
    expect(tables(db)).not.toContain("team_tasks");
  });

  it("preserves old chat rows and applies the additive migration once", () => {
    const db = open();
    migrate(db, previousMigrations);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'existing')").run();
    db.prepare("INSERT INTO chat_messages (id, rig_id, sender, body) VALUES ('message-1', 'rig-1', 'owner', 'keep this message')").run();
    const before = db.prepare("SELECT * FROM chat_messages").all();
    migrate(db, ALL_MIGRATIONS);
    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT * FROM chat_messages").all()).toEqual(before);
    expect(db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE name = '104_team_governance.sql'").get()).toEqual({ count: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("rolls back the complete new schema if an unexpected pre-existing table collides", () => {
    const db = open();
    migrate(db, previousMigrations);
    db.exec("CREATE TABLE team_approvals (unrelated TEXT)");
    expect(() => migrate(db, ALL_MIGRATIONS)).toThrow();
    expect(tables(db)).not.toContain("team_runs");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE name = '104_team_governance.sql'").get()).toBeUndefined();
    expect(db.prepare("PRAGMA table_info(team_approvals)").all()).toEqual([expect.objectContaining({ name: "unrelated" })]);
  });

  it("restores a pre-migration SQLite backup with the matching old migration set", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "team-migration-"));
    directories.push(directory);
    const db = open(path.join(directory, "current.db"));
    migrate(db, previousMigrations);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'existing')").run();
    db.prepare("INSERT INTO chat_messages (id, rig_id, sender, body) VALUES ('message-1', 'rig-1', 'owner', 'preserved')").run();
    const backup = path.join(directory, "before-104.db");
    await db.backup(backup);
    migrate(db, ALL_MIGRATIONS);
    expect(tables(db)).toContain("team_runs");
    const restored = open(backup);
    migrate(restored, previousMigrations);
    expect(tables(restored)).not.toContain("team_runs");
    expect(restored.prepare("SELECT body FROM chat_messages WHERE id = 'message-1'").get()).toEqual({ body: "preserved" });
    expect(restored.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });
});
