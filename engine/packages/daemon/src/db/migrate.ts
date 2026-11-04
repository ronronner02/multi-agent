import type Database from "better-sqlite3";

export interface Migration {
  name: string;
  sql: string;
  /**
   * Run this migration with foreign-key enforcement off, then turn it back on.
   *
   * SQLite cannot add a value to a `CHECK` in place, so a table that other tables reference has
   * to be rebuilt. With enforcement on, `DROP TABLE` refuses while a child row still points at
   * the old table, and the rebuild's own `ALTER TABLE ... RENAME` rewrites the children's
   * references to the temporary name. Turning enforcement off for the rebuild leaves both
   * intact, and the runner verifies the result with `foreign_key_check` before committing.
   */
  foreignKeysOff?: boolean;
}

/**
 * Run migrations against a database.
 * Tracks applied migrations in a schema_migrations table.
 * Skips already-applied migrations. Applies new ones in order.
 */
export function migrate(db: Database.Database, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (
      db
        .prepare("SELECT name FROM schema_migrations")
        .all() as { name: string }[]
    ).map((r) => r.name)
  );

  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));

  const applyOne = db.transaction((migration: Migration) => {
    // `PRAGMA foreign_keys` is a no-op inside a transaction, so a rebuild that needs it off is
    // run by its caller outside one; this function only ever runs with enforcement as it found it.
    db.exec(migration.sql);
    if (migration.foreignKeysOff) {
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`${migration.name} left ${violations.length} foreign-key violation(s)`);
    }
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(
      migration.name
    );
  });

  for (const migration of sorted) {
    if (applied.has(migration.name)) continue;
    if (!migration.foreignKeysOff) {
      applyOne(migration);
      continue;
    }
    db.pragma("foreign_keys = OFF");
    try {
      applyOne(migration);
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
}
