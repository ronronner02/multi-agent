import type { Migration } from "../migrate.js";

export const workflowSoulsSchema: Migration = {
  name: "121_workflow_souls.sql",
  sql: `
    -- Only the generated initial workflow request reserves space for its command header.
    -- Ordinary owner and lead messages retain their existing storage limit and row order.
    CREATE TABLE team_chat_messages_workflow (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      sender TEXT NOT NULL CHECK (sender IN ('owner', 'lead')),
      body TEXT NOT NULL CHECK (length(body) <= 65536 OR
        (sender = 'owner' AND id IS (run_id || ':initial') AND length(body) <= 65536 + 256)),
      attempt_id TEXT,
      delivered_attempt TEXT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      options_json TEXT,
      answered_by TEXT,
      CHECK ((sender = 'lead') = (attempt_id IS NOT NULL)),
      CHECK (sender = 'owner' OR delivered_attempt IS NULL)
    );
    INSERT INTO team_chat_messages_workflow
      (rowid, id, run_id, sender, body, attempt_id, delivered_attempt, created_at, kind, options_json, answered_by)
      SELECT rowid, id, run_id, sender, body, attempt_id, delivered_attempt, created_at, kind, options_json, answered_by
      FROM team_chat_messages;
    DROP TABLE team_chat_messages;
    ALTER TABLE team_chat_messages_workflow RENAME TO team_chat_messages;
    CREATE INDEX idx_team_chat_messages_run ON team_chat_messages (run_id);
    CREATE UNIQUE INDEX idx_team_chat_messages_lead_attempt ON team_chat_messages (run_id, attempt_id) WHERE sender = 'lead';
    CREATE TABLE team_soul_versions (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      soul_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      name TEXT NOT NULL,
      roles_json TEXT NOT NULL CHECK (json_valid(roles_json)),
      content TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, soul_id, version)
    );
    ALTER TABLE nodes ADD COLUMN soul_id TEXT;
    ALTER TABLE team_queue_authority ADD COLUMN workflow_json TEXT
      CHECK (workflow_json IS NULL OR json_valid(workflow_json));
    CREATE UNIQUE INDEX team_workflow_owner_request ON team_queue_authority(json_extract(workflow_json, '$.ownerMessageId'))
      WHERE json_extract(workflow_json, '$.ownerMessageId') IS NOT NULL;
    CREATE TABLE team_workflow_outcomes (
      attempt_id TEXT NOT NULL,
      qitem_id TEXT NOT NULL REFERENCES team_queue_authority(qitem_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      entrypoint TEXT NOT NULL,
      revision TEXT NOT NULL,
      outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (attempt_id, generation)
    );
  `,
};
