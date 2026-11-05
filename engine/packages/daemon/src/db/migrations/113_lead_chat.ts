import type { Migration } from "../migrate.js";

/**
 * U5 — the planning phase a run can start in, and its owner↔lead conversation.
 *
 * Two facts, both owned here because they are written together: the phase the run is in, and
 * the messages the owner and the lead exchange.
 *
 * `phase` is a column rather than a new run state on purpose. Every gate in the managed engine —
 * dispatch, attempt admission, eligibility — already reads `state = 'approved'`, and a planning
 * lead turn is ordinary managed work: it launches the same way, on the same seat, under the same
 * approval. A seventh state would have to be threaded through every one of those gates to mean
 * "approved work that is not delivery yet", and any gate that forgot it would refuse the lead's
 * turn. The column says what the run is doing without changing what it is allowed to do.
 *
 * `team_chat_messages` is run-scoped and small. The durable `chat_messages` table is the rig
 * mailbox: one row per rig, no run, no ordering promise between an owner and an agent, and its
 * readers are the mailbox endpoints a managed daemon keeps off the legacy surface. A run's
 * conversation is a different owner with a different reader, so it gets its own table.
 *
 * `delivered_attempt` records which lead attempt's prompt already carried an owner message. That
 * is what makes a message sent while a turn is running wait for the next turn instead of being
 * answered from a prompt it never reached or, worse, read as answered because a later reply
 * landed after it.
 */
export const leadChatSchema: Migration = {
  name: "113_lead_chat.sql",
  sql: `
    ALTER TABLE team_runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'delivery' CHECK (phase IN ('planning', 'delivery'));
    CREATE TABLE team_chat_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      sender TEXT NOT NULL CHECK (sender IN ('owner', 'lead')),
      body TEXT NOT NULL CHECK (length(body) <= 65536),
      attempt_id TEXT,
      delivered_attempt TEXT,
      created_at TEXT NOT NULL,
      CHECK ((sender = 'lead') = (attempt_id IS NOT NULL)),
      CHECK (sender = 'owner' OR delivered_attempt IS NULL)
    );
    CREATE INDEX idx_team_chat_messages_run ON team_chat_messages (run_id);
    CREATE UNIQUE INDEX idx_team_chat_messages_lead_attempt ON team_chat_messages (run_id, attempt_id) WHERE sender = 'lead';
  `,
};