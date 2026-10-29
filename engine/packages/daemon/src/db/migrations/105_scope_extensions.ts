import type { Migration } from "../migrate.js";

export const scopeExtensionsSchema: Migration = {
  name: "105_scope_extensions.sql",
  sql: `
    CREATE TABLE team_scope_extensions (
      approval_id TEXT PRIMARY KEY REFERENCES team_approvals(id),
      task_id TEXT NOT NULL,
      chain_head TEXT,
      automatic INTEGER NOT NULL CHECK (automatic IN (0, 1))
    );
    CREATE INDEX team_scope_extensions_task ON team_scope_extensions(task_id);
  `,
};
