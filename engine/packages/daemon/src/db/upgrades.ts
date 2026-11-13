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
export const SCHEMA_UPGRADES: readonly SchemaUpgrade[] = [];

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
