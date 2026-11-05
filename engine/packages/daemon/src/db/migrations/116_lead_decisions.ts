import type { Migration } from "../migrate.js";

/**
 * U6 — the lead's escalations as decisions in the run's chat.
 *
 * Three columns, because a decision is a message with one extra fact and one answer:
 *
 * - `kind` separates an ordinary message from a decision. Everything U5 wrote keeps `text`.
 * - `options_json` is the two-to-four choices the lead offered, in the order it offered them.
 *   It is JSON rather than rows because the options are one message's render, never queried
 *   across messages, and the run's chat is the only reader.
 * - `answered_by` is the owner message that answered a decision. A null on a decision row is
 *   exactly what "the run is waiting on this" means, so the pending state is derived rather
 *   than stored a second time.
 *
 * The existing CHECK constraints are untouched: a decision the lead writes carries the attempt
 * whose turn produced it, the same as the reply it replaces, so it satisfies
 * `(sender = 'lead') = (attempt_id IS NOT NULL)` and the one-lead-row-per-attempt index.
 */
export const leadDecisionsSchema: Migration = {
  name: "116_lead_decisions.sql",
  sql: `
    ALTER TABLE team_chat_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
    ALTER TABLE team_chat_messages ADD COLUMN options_json TEXT;
    ALTER TABLE team_chat_messages ADD COLUMN answered_by TEXT;
  `,
};