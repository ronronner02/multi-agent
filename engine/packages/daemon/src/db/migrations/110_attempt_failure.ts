import type { Migration } from "../migrate.js";

/**
 * T033 — the KTD20 classification of an attempt that ended, stored with the attempt.
 *
 * KTD20 says each failed attempt records one reason code and a `resume_safe` flag, and that
 * every consumer reads that one decision instead of re-deriving eligibility. The row is the
 * attempt itself, so the classification belongs on it: a reader that already loads the attempt
 * (the owner read, the health projection, the retry command) gets the decision with it, and
 * there is no second store to fall out of step with the attempt's own state.
 *
 * A nullable JSON column is enough — the value is written once, when the attempt is recorded
 * stopped, and never updated — so this is an `ALTER TABLE` with no rebuild, no copy and no
 * foreign-key dance. The `CHECK` keeps a non-JSON value out at the storage boundary; the shape
 * is validated when it is written and again when it is read.
 */
export const attemptFailureSchema: Migration = {
  name: "110_attempt_failure.sql",
  sql: `ALTER TABLE team_attempts ADD COLUMN failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json));`,
};
