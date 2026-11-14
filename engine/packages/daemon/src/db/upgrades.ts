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

/** Plan KTD12 — the GitHub items a run's source has already delivered. Shared by the baseline and step 6→7. */
export const TEAM_GITHUB_SEEN_SQL = `CREATE TABLE team_github_seen (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      item TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (run_id, item)
    )`;

/**
 * Plan KTD14 — a team's versioned intake policy, the GitHub items it has seen, and where each
 * team's polling resumes. Shared by the baseline and step 7→8.
 */
export const TEAM_INTAKE_SQL = [`CREATE TABLE team_intake_policies (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      mode TEXT NOT NULL CHECK (mode IN ('off', 'observe', 'auto')),
      rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, revision)
    )`, `CREATE TABLE team_intake_items (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      item TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('issue', 'comment', 'ci')),
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      explicit INTEGER NOT NULL CHECK (explicit IN (0, 1)),
      state TEXT NOT NULL CHECK (state IN ('pending', 'would_start', 'started', 'skipped', 'unavailable', 'dismissed')),
      matched_json TEXT NOT NULL CHECK (json_valid(matched_json)),
      policy_revision INTEGER,
      run_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, item)
    )`, `CREATE TABLE team_intake_sources (
      rig_id TEXT PRIMARY KEY REFERENCES rigs(id) ON DELETE CASCADE,
      repository TEXT NOT NULL,
      since TEXT NOT NULL
    )`].join(";\n");

/**
 * Plan R19 — a GitHub review comment a task took, and the reply its outcome owes: a resolved
 * thread once the fix is pushed, or one sentence of reason. Shared by the baseline and step 8→9.
 */
export const TEAM_GITHUB_THREADS_SQL = `CREATE TABLE team_github_threads (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      message_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL CHECK (number > 0),
      comment_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('fixed', 'declined')),
      reason TEXT,
      head_sha TEXT,
      state TEXT NOT NULL CHECK (state IN ('open', 'done', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, message_id)
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
  { from: 6, to: 7, sql: TEAM_GITHUB_SEEN_SQL },
  { from: 7, to: 8, sql: TEAM_INTAKE_SQL },
  { from: 8, to: 9, sql: TEAM_GITHUB_THREADS_SQL },
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
