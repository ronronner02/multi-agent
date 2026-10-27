import type { Migration } from "../migrate.js";

/**
 * T053 — the durable half of the managed attempt's production inputs.
 *
 * The task's declared outputs and permissions sit beside its assignment rather than inside
 * `assignment_json`: the assignment is the approved scope the launch compares byte-for-byte,
 * and adding fields there would change every recorded row's identity. Nullable because a row
 * created before this migration recorded neither, and the read maps that to `[]` — "not
 * recorded", never an implicit grant.
 */
export const managedAttemptInputsSchema: Migration = {
  name: "106_managed_attempt_inputs.sql",
  sql: `
    ALTER TABLE team_queue_authority ADD COLUMN outputs_json TEXT
      CHECK (outputs_json IS NULL OR json_valid(outputs_json));
    ALTER TABLE team_queue_authority ADD COLUMN permissions_json TEXT
      CHECK (permissions_json IS NULL OR json_valid(permissions_json));
    CREATE TABLE team_worker_credentials (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      session_id TEXT NOT NULL,
      token_digest TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      PRIMARY KEY (run_id, session_id)
    );
    CREATE TABLE team_seat_mailbox_capabilities (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      session_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, session_id)
    );
  `,
};