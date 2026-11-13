import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_VERSION, initializeDatabase, LegacyDatabaseError, NewerDatabaseError, UpgradeFailedError } from "../src/db/baseline.js";
import { openDatabase } from "../src/db/connection.js";
import { SCHEMA_UPGRADES, type SchemaUpgrade } from "../src/db/upgrades.js";

/**
 * A database the shipped app created must open on every later daemon. A schema change is a
 * baseline edit plus one additive upgrade step, so a user's data is carried forward instead of
 * being refused as `legacy_database`.
 */

const roots: string[] = [];
const connections: Database.Database[] = [];
const directory = () => { const root = mkdtempSync(join(tmpdir(), "team-upgrade-")); roots.push(root); return root; };
const track = (db: Database.Database) => { connections.push(db); return db; };
const schema = (db: Database.Database) => db.prepare(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all();
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A database marked one version below the daemon, holding a row the upgrade must keep. */
function previousVersion(file: string): Database.Database {
  const db = track(new Database(file));
  db.pragma("journal_mode = WAL");
  initializeDatabase(db, file);
  db.exec("INSERT INTO rigs (id, name) VALUES ('team', 'Project')");
  db.exec("DROP TABLE team_soul_versions");
  db.pragma(`user_version = ${BASELINE_VERSION - 1}`);
  return db;
}

/** The step that brings `previousVersion` back to today's schema. */
function restoreSouls(db: Database.Database): SchemaUpgrade {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'team_soul_versions'").get() as { sql?: string } | undefined)?.sql;
  const fresh = track(new Database(":memory:"));
  initializeDatabase(fresh);
  const table = (fresh.prepare("SELECT sql FROM sqlite_master WHERE name = 'team_soul_versions'").get() as { sql: string }).sql;
  const indexes = (fresh.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'team_soul_versions' AND type = 'index' AND sql IS NOT NULL").all() as { sql: string }[])
    .map(row => row.sql);
  expect(sql).toBeUndefined();
  return { from: BASELINE_VERSION - 1, to: BASELINE_VERSION, sql: [table, ...indexes].join(";\n") };
}

afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("schema upgrades from a shipped baseline", () => {
  it("upgrades an older marked database in place, keeps its rows and leaves a backup beside it", () => {
    const root = directory(), file = join(root, "multi-agent.sqlite");
    const db = previousVersion(file);
    const step = restoreSouls(db);
    initializeDatabase(db, file, { upgrades: [step] });
    expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
    expect(db.prepare("SELECT id, name FROM rigs").all()).toEqual([{ id: "team", name: "Project" }]);
    const fresh = track(new Database(":memory:")); initializeDatabase(fresh);
    expect(schema(db)).toEqual(schema(fresh));
    const backups = readdirSync(root).filter(name => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    const backup = track(new Database(join(root, backups[0]!), { readonly: true }));
    expect(backup.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION - 1);
    expect(backup.prepare("SELECT id FROM rigs").all()).toEqual([{ id: "team" }]);
  });

  it("leaves the older version intact and names the backup when a step fails", () => {
    const root = directory(), file = join(root, "multi-agent.sqlite");
    const db = previousVersion(file);
    const step = restoreSouls(db);
    let caught: unknown;
    try {
      initializeDatabase(db, file, { upgrades: [step], injectFailure: () => { throw new Error("injected upgrade failure"); } });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(UpgradeFailedError);
    const failure = caught as UpgradeFailedError;
    expect(failure.code).toBe("upgrade_failed");
    expect(existsSync(failure.backupPath)).toBe(true);
    expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION - 1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'team_soul_versions'").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM rigs").all()).toEqual([{ id: "team" }]);
  });

  it("refuses a database from a newer daemon without changing its bytes", () => {
    const file = join(directory(), "multi-agent.sqlite");
    const newer = new Database(file);
    newer.exec("CREATE TABLE rigs (id TEXT PRIMARY KEY)");
    newer.pragma(`user_version = ${BASELINE_VERSION + 1}`);
    newer.close();
    const before = fileHash(file);
    expect(() => openDatabase(file)).toThrow(NewerDatabaseError);
    expect(() => openDatabase(file)).toThrow(`newer_database: version ${BASELINE_VERSION + 1}`);
    expect(fileHash(file)).toBe(before);
  });

  it("still refuses an older version no upgrade step reaches", () => {
    const file = join(directory(), "multi-agent.sqlite");
    const old = track(new Database(file));
    old.exec("CREATE TABLE rigs (id TEXT PRIMARY KEY)");
    old.pragma(`user_version = ${BASELINE_VERSION - 1}`);
    expect(() => initializeDatabase(old, file, { upgrades: [] })).toThrow(LegacyDatabaseError);
  });

  it("brings the first shipped schema to today's baseline through the recorded steps", () => {
    // The shipped schema is frozen in this fixture. Editing the baseline without adding the
    // step that carries a shipped database forward makes the two schemas differ here.
    // A Windows checkout may turn the fixture's line endings into CRLF; SQLite stores the SQL
    // text as written, so normalize it to the LF the baseline source uses.
    const shipped = readFileSync(new URL("./fixtures/schema-v2.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const db = track(new Database(":memory:"));
    db.exec(shipped);
    db.pragma("user_version = 2");
    initializeDatabase(db, ":memory:", { upgrades: SCHEMA_UPGRADES });
    const fresh = track(new Database(":memory:")); initializeDatabase(fresh);
    expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
    expect(schema(db)).toEqual(schema(fresh));
  });
});
