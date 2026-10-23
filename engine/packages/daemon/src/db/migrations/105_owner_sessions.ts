import type { Migration } from "../migrate.js";

export const ownerSessionsSchema: Migration = {
  name: "105_owner_sessions.sql",
  sql: `
    CREATE TABLE owner_pairing_codes (
      code_hash TEXT PRIMARY KEY, owner_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER
    );
    CREATE TABLE owner_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL,
      owner_hash TEXT NOT NULL, origin TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE INDEX idx_owner_sessions_expiry ON owner_sessions(expires_at);
  `,
};
