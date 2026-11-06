import type { Migration } from "../migrate.js";

export const teamBootstrapAndRetirementSchema: Migration = {
  name: "117_team_bootstrap_and_retirement.sql",
  sql: `
    CREATE TABLE team_bootstraps (
      repository TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lead_client TEXT NOT NULL CHECK (lead_client IN ('claude-code', 'codex')),
      github_login TEXT NOT NULL,
      step TEXT NOT NULL CHECK (step IN ('pending', 'folder', 'init', 'ignore', 'commit', 'repo', 'push')),
      commit_oid TEXT,
      branch_ref TEXT,
      remote_url TEXT,
      team_id TEXT REFERENCES rigs(id) ON DELETE CASCADE,
      last_error_code TEXT
    );
    ALTER TABLE nodes ADD COLUMN retired_at TEXT;
  `,
};
