import type { Migration } from "../migrate.js";

export const teamGovernanceSchema: Migration = {
  name: "104_team_governance.sql",
  sql: `
    CREATE TABLE team_runs (
      id TEXT PRIMARY KEY,
      rig_id TEXT NOT NULL REFERENCES rigs(id),
      binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
      binding_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'cancel_requested', 'invalidated', 'blocked')),
      state_reason TEXT,
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
      accounted_at TEXT,
      retries_used INTEGER NOT NULL DEFAULT 0 CHECK (retries_used >= 0),
      review_rounds_used INTEGER NOT NULL DEFAULT 0 CHECK (review_rounds_used >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE team_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      kind TEXT NOT NULL CHECK (kind IN ('orchestrator', 'native')),
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      payload_digest TEXT NOT NULL,
      target_digest TEXT NOT NULL,
      binding_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      expires_at TEXT NOT NULL,
      decision_actor TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (id, run_id)
    );
    CREATE INDEX idx_team_approvals_run_state ON team_approvals(run_id, state);
    CREATE TABLE team_control_requests (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, idempotency_key)
    );
    CREATE TABLE team_queue_authority (
      qitem_id TEXT PRIMARY KEY REFERENCES queue_items(qitem_id),
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      task_id TEXT NOT NULL,
      assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json)),
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
      UNIQUE (run_id, task_id),
      UNIQUE (qitem_id, run_id)
    );
    CREATE TABLE team_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      qitem_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('lead', 'implementer', 'reviewer')),
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      identity_json TEXT CHECK (identity_json IS NULL OR json_valid(identity_json)),
      unknown_reason TEXT,
      state TEXT NOT NULL CHECK (state IN ('running', 'stopped', 'unknown')),
      usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
      active_ms INTEGER NOT NULL CHECK (active_ms >= 0),
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (id, run_id),
      FOREIGN KEY (qitem_id, run_id) REFERENCES team_queue_authority(qitem_id, run_id),
      CHECK ((state = 'unknown' AND unknown_reason IS NOT NULL) OR
        (state <> 'unknown' AND identity_json IS NOT NULL AND unknown_reason IS NULL))
    );
    CREATE INDEX idx_team_attempts_run_state ON team_attempts(run_id, state);
    CREATE TABLE team_approval_consumptions (
      approval_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'confirmed', 'ambiguous')),
      receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (approval_id, run_id) REFERENCES team_approvals(id, run_id),
      FOREIGN KEY (attempt_id, run_id) REFERENCES team_attempts(id, run_id)
    );
  `,
};
