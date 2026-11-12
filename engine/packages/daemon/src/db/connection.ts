import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { assertSupportedDatabase, initializeDatabase } from "./baseline.js";

/** Create a connection. In-memory connections are useful for isolated fixtures. */
export function createDb(filePath?: string): Database.Database {
  const db = new Database(filePath ?? ":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Inspect existing files read-only before journal configuration or schema writes. */
export function openDatabase(filePath: string): Database.Database {
  if (filePath !== ":memory:" && existsSync(filePath)) {
    const existing = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      assertSupportedDatabase(existing, filePath);
    } finally {
      existing.close();
    }
  }
  const db = createDb(filePath);
  try {
    initializeDatabase(db, filePath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
