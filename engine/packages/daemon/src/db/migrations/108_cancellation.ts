import type { Migration } from "../migrate.js";

/**
 * T017 (cancellation half) — a run the daemon observed come to rest.
 *
 * `cancel_requested` is the owner's intent: the command that records it says in its own reason
 * that termination has not been observed. Nothing could say what came after, so a canceled run
 * stayed in that state for good and no client could tell "stopping" from "stopped". `canceled`
 * is the observation that closes it: every attempt the run recorded has ended, and no launch is
 * outstanding.
 *
 * A `CHECK` constraint cannot be widened in place, so the table is rebuilt. It has five
 * referencing children (`team_approvals`, `team_control_requests`, `team_queue_authority`,
 * `team_attempts`, `team_scope_extensions`), which is why the migration runs with foreign-key
 * enforcement off: with it on, SQLite refuses the `DROP TABLE` while a child row still points
 * at the old table. Every row is copied unchanged and the runner checks the result before
 * committing.
 */
export const cancellationSchema: Migration = {
  name: "108_cancellation.sql",
  foreignKeysOff: true,
  sql: `
    CREATE TABLE team_runs_next (
      id TEXT PRIMARY KEY,
      rig_id TEXT NOT NULL REFERENCES rigs(id),
      binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
      binding_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'cancel_requested', 'canceled', 'invalidated', 'blocked')),
      state_reason TEXT,
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
      accounted_at TEXT,
      retries_used INTEGER NOT NULL DEFAULT 0 CHECK (retries_used >= 0),
      review_rounds_used INTEGER NOT NULL DEFAULT 0 CHECK (review_rounds_used >= 0),
      reviewer_seat TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO team_runs_next (id, rig_id, binding_json, binding_digest, state, state_reason, entity_version,
      active_ms, accounted_at, retries_used, review_rounds_used, reviewer_seat, created_at, updated_at)
      SELECT id, rig_id, binding_json, binding_digest, state, state_reason, entity_version,
        active_ms, accounted_at, retries_used, review_rounds_used, reviewer_seat, created_at, updated_at
      FROM team_runs;
    DROP TABLE team_runs;
    ALTER TABLE team_runs_next RENAME TO team_runs;
  `,
};
