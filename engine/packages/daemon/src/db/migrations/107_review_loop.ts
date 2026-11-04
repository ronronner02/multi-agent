import type { Migration } from "../migrate.js";

/**
 * MVP slice C2 — the seat a run routes its reviewer tasks to.
 *
 * A run's plan binding already names `reviewer` among its roles, but a role is not an
 * address. The owner names the reviewer seat once, at start, and every review round for the
 * run routes there; it is nullable because a start that names none keeps the pre-C2
 * behaviour exactly — an implementer task that completes without a review.
 */
export const reviewLoopSchema: Migration = {
  name: "107_review_loop.sql",
  sql: `
    ALTER TABLE team_runs ADD COLUMN reviewer_seat TEXT;
  `,
};
