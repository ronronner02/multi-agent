import type { Migration } from "../migrate.js";

export const projectDocumentsSchema: Migration = {
  name: "120_project_documents.sql",
  sql: `
    CREATE TABLE team_document_workflows (
      run_id TEXT PRIMARY KEY REFERENCES team_runs(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK (stage IN ('exploration', 'requirements', 'plan')),
      confirmed_brainstorm TEXT,
      confirmed_requirements TEXT,
      confirmed_plan TEXT,
      pending_stage TEXT CHECK (pending_stage IN ('exploration', 'requirements', 'plan')),
      error TEXT
    );
    CREATE TABLE team_document_versions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('brainstorm', 'requirements', 'plan')),
      version INTEGER NOT NULL CHECK (version > 0),
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,
      requirements_version_id TEXT REFERENCES team_document_versions(id),
      source_attempt_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      confirmed_by TEXT,
      UNIQUE (run_id, kind, version),
      UNIQUE (run_id, kind, source_attempt_id)
    );
    CREATE INDEX team_document_versions_run ON team_document_versions(run_id, kind, version DESC);
    CREATE TABLE team_document_captures (
      run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      PRIMARY KEY (run_id, attempt_id)
    );
    ALTER TABLE team_queue_authority ADD COLUMN document_versions_json TEXT
      CHECK (document_versions_json IS NULL OR json_valid(document_versions_json));
  `,
};
