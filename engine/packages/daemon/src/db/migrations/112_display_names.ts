import type { Migration } from "../migrate.js";

/**
 * U9 / KTD8 — the readable name a run and a task carry, stored when they are created.
 *
 * KTD8 puts names in the storage rows beside the ids, so a reader never has to derive a name
 * from an id and the logs and commit messages that use a task's name read the same text. The
 * column is nullable because rows recorded before this migration have none: the read model
 * derives one for those by running the same naming rules over the rows they do have.
 *
 * Nothing is backfilled here. A backfill would freeze today's derivation into rows that the
 * derivation owner (`domain/display-names.ts`) may refine, and the read already covers them.
 */
export const displayNamesSchema: Migration = {
  name: "112_display_names.sql",
  sql: `
    ALTER TABLE team_runs ADD COLUMN display_name TEXT;
    ALTER TABLE team_queue_authority ADD COLUMN display_name TEXT;
  `,
};