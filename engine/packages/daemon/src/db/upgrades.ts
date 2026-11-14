/**
 * One additive step that carries a database marked `from` to `to`. The SQL runs in one
 * transaction with the new marker, after a copy of the database is written beside it.
 */
export interface SchemaUpgrade { from: number; to: number; sql: string }

/**
 * Steps from the first shipped baseline (version 2) to today's. A schema change edits
 * BASELINE_SQL for fresh installs, bumps BASELINE_VERSION, and appends the step that brings
 * the previous version to the same schema. The parity test in `db-upgrades.test.ts` holds
 * the chain to the baseline.
 */
/** Plan KTD9 — one immutable revision of a team's prompt section overrides. Shared by the baseline and step 4→5. */
export const TEAM_PROMPT_VERSIONS_SQL = `CREATE TABLE team_prompt_versions (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      overrides_json TEXT NOT NULL CHECK (json_valid(overrides_json)),
      bases_json TEXT NOT NULL CHECK (json_valid(bases_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, revision)
    )`;

/** Plan KTD13 — the pull request a run's branch is delivered through. Shared by the baseline and step 5→6. */
export const TEAM_PULL_REQUESTS_SQL = `CREATE TABLE team_pull_requests (
      run_id TEXT PRIMARY KEY REFERENCES team_runs(id),
      repository TEXT NOT NULL,
      number INTEGER NOT NULL CHECK (number > 0),
      url TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
      updated_at TEXT NOT NULL
    )`;

export const SCHEMA_UPGRADES: readonly SchemaUpgrade[] = [
  // Plan KTD3: a lead message that needs no owner attention is kept as run activity.
  { from: 2, to: 3, sql: "ALTER TABLE team_chat_messages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'chat' CHECK (visibility IN ('chat', 'activity'))" },
  // Plan KTD5/KTD6/R10: an owner comment on a task, a task hold, and a follow-up's original task.
  { from: 3, to: 4, sql: ["ALTER TABLE team_chat_messages ADD COLUMN task_id TEXT",
    "ALTER TABLE team_queue_authority ADD COLUMN held_at TEXT",
    "ALTER TABLE team_queue_authority ADD COLUMN follow_up_of TEXT"].join(";\n") },
  { from: 4, to: 5, sql: TEAM_PROMPT_VERSIONS_SQL },
  { from: 5, to: 6, sql: TEAM_PULL_REQUESTS_SQL },
];

/** The steps from `from` to `to`, in order, or null when the chain does not reach. */
export function upgradePath(steps: readonly SchemaUpgrade[], from: number, to: number): SchemaUpgrade[] | null {
  const path: SchemaUpgrade[] = [];
  let version = from;
  while (version < to) {
    const step = steps.find(candidate => candidate.from === version);
    if (!step || step.to <= version) return null;
    path.push(step);
    version = step.to;
  }
  return version === to ? path : null;
}
