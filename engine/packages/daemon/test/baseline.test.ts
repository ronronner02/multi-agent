import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_VERSION, initializeDatabase, LegacyDatabaseError } from "../src/db/baseline.js";
import { createDb, openDatabase } from "../src/db/connection.js";
import { createDaemon } from "../src/startup.js";

const tables = [
  "applied_launch_observation_invalidations",
  "applied_launch_observations",
  "attempt_telemetry",
  "bindings",
  "chat_messages",
  "classification_attempts",
  "classifier_leases",
  "context_usage",
  "daemon_lifecycle",
  "edges",
  "events",
  "inbox_entries",
  "mission_control_actions",
  "node_permission_selections",
  "nodes",
  "occupant_tenures",
  "operator_context_mode_bindings",
  "outbox_entries",
  "owner_pairing_codes",
  "owner_sessions",
  "pods",
  "project_classifications",
  "projection_manifest",
  "queue_items",
  "queue_transition_wakes",
  "queue_transitions",
  "queue_transitions_archive",
  "rig_services",
  "rigs",
  "sessions",
  "stream_items",
  "team_approval_consumptions",
  "team_approvals",
  "team_attempts",
  "team_bootstraps",
  "team_chat_messages",
  "team_control_requests",
  "team_document_captures",
  "team_document_versions",
  "team_document_workflows",
  "team_integration_commits",
  "team_queue_authority",
  "team_runs",
  "team_scope_extensions",
  "team_soul_versions",
  "team_worker_credentials",
  "team_workflow_outcomes",
  "usage_samples",
  "views_custom",
  "watchdog_history",
  "watchdog_jobs",
  "workflow_failure_occurrences",
  "workflow_frontier_bindings",
  "workflow_instances",
  "workflow_specs",
  "workflow_step_trails"
];
const roots: string[] = [];
const connections: Database.Database[] = [];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (file: string) => hash(readFileSync(file));
const open = (file?: string) => { const db = file ? openDatabase(file) : createDb(); connections.push(db); return db; };
const directory = () => { const root = mkdtempSync(join(tmpdir(), "team-baseline-")); roots.push(root); return root; };
const schema = (db: Database.Database) => db.prepare(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all();

afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fresh team baseline", () => {
  it("creates exactly the retained schema with the former chain's types, constraints, indexes and trigger", () => {
    const db = open();
    initializeDatabase(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(row => (row as {name: string}).name)).toEqual(tables);
    // Captured from the replaced chain, restricted to the retained tables and their objects.
    // This also pins every column type, default, CHECK, UNIQUE and FK declaration.
    expect(hash(JSON.stringify(schema(db)))).toBe("f1fe6faaf7060e34bc1efee19931c5ce5d2ca46dba9b69db3356344d8fb62694");
    expect(schema(db).filter(row => (row as {type: string}).type === "index")).toHaveLength(80);
    expect(schema(db).filter(row => (row as {type: string}).type === "trigger")).toHaveLength(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
  });

  it("enforces foreign keys and the cross-team edge trigger", () => {
    const db = open(); initializeDatabase(db);
    db.exec("INSERT INTO rigs (id, name) VALUES ('a', 'A'), ('b', 'B')");
    db.exec("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('na', 'a', 'worker'), ('nb', 'b', 'worker')");
    expect(() => db.exec("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('bad', 'missing', 'worker')"))
      .toThrow(/FOREIGN KEY/);
    expect(() => db.exec("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('edge', 'a', 'na', 'nb', 'peer')"))
      .toThrow("edge source and target must belong to the same rig");
    db.exec("INSERT INTO sessions (id, node_id, session_name) VALUES ('s', 'na', 'worker@A')");
    db.exec("DELETE FROM rigs WHERE id = 'a'");
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("opens a fresh file with WAL and preserves marked data across reopen", () => {
    const file = join(directory(), "openrig.sqlite");
    const db = open(file);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.exec("INSERT INTO rigs (id, name) VALUES ('team', 'Project')");
    const before = schema(db); db.close();
    const reopened = open(file);
    expect(schema(reopened)).toEqual(before);
    expect(reopened.prepare("SELECT id, name FROM rigs").all()).toEqual([{ id: "team", name: "Project" }]);
    expect(reopened.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
  });

  it.each(["DELETE", "WAL"])("refuses an unmarked %s database without changing its bytes", journal => {
    const file = join(directory(), "openrig.sqlite");
    const legacy = new Database(file); connections.push(legacy);
    legacy.pragma("journal_mode = " + journal);
    legacy.exec("CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('preserve me')");
    if (journal === "DELETE") legacy.close();
    const before = fileHash(file);
    const walBefore = journal === "WAL" ? fileHash(file + "-wal") : null;
    expect(() => openDatabase(file)).toThrow(LegacyDatabaseError);
    expect(() => openDatabase(file)).toThrow("legacy_database: " + file);
    expect(fileHash(file)).toBe(before);
    if (walBefore) expect(fileHash(file + "-wal")).toBe(walBefore);
  });

  it("propagates legacy_database and the filename from daemon startup", async () => {
    const file = join(directory(), "openrig.sqlite");
    const legacy = new Database(file);
    legacy.exec("CREATE TABLE schema_migrations (name TEXT); CREATE TABLE rigs (id TEXT)"); legacy.close();
    const before = fileHash(file);
    await expect(createDaemon({ dbPath: file, managedMode: true, workersIsolation: "none" }))
      .rejects.toMatchObject({ code: "legacy_database", databasePath: file });
    expect(fileHash(file)).toBe(before);
  });

  it("rolls back every schema object and the marker after an injected creation failure", () => {
    const db = createDb(join(directory(), "failed.sqlite"));
    connections.push(db);
    expect(() => initializeDatabase(db, db.name, { injectFailure: () => {
      expect(schema(db)).toHaveLength(137);
      expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
      throw new Error("injected baseline failure");
    } })).toThrow("injected baseline failure");
    expect(schema(db)).toEqual([]);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    const file = db.name;
    db.close();
    const reopened = new Database(file);
    connections.push(reopened);
    expect(schema(reopened)).toEqual([]);
    expect(reopened.pragma("user_version", { simple: true })).toBe(0);
    initializeDatabase(reopened);
    expect(schema(reopened)).toHaveLength(137);
    expect(reopened.pragma("foreign_key_check")).toEqual([]);
  });
});
