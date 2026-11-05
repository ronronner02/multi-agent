import type { Migration } from "../migrate.js";

/**
 * U7 — the branch a run's approved work lands on, and the commits it landed.
 *
 * The branch and its worktree are properties of the run, not of a process: a restart has to
 * find them again from the run alone, and two runs must never share either. They are recorded
 * the first time the daemon integrates something, so a run that never reaches delivery keeps
 * no rows it does not need. `integration_repository` is the owner's checkout the team was
 * created for — the branch lives in that repository, and the merge goes back into it.
 *
 * `team_integration_commits` is the task-to-commit mapping the integration read publishes. The
 * mapping is duplication of what a commit message could say, and it is deliberate: a reader
 * must be able to name which task a commit carries without parsing text an agent could have
 * written, and the primary key is what makes a replayed integration a no-op.
 */
export const integrationBranchSchema: Migration = {
  name: "114_integration_branch.sql",
  sql: `
    ALTER TABLE team_runs ADD COLUMN integration_branch TEXT;
    ALTER TABLE team_runs ADD COLUMN integration_worktree TEXT;
    ALTER TABLE team_runs ADD COLUMN integration_repository TEXT;
    CREATE TABLE team_integration_commits (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      task_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      subject TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      PRIMARY KEY (run_id, task_id)
    );
  `,
};