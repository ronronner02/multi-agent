/**
 * C4 acceptance — seed the four Claude Code seats a recorded run uses.
 *
 * The seats are rows only: a rig, one lead node, two implementer nodes and one reviewer node,
 * each with its registered session. Nothing is started here; the daemon opens each seat's
 * terminal and launches its client when the run puts work on it, exactly as a fresh install
 * does. The cwd is the demo repository, so the plan a start approves is the one the run reads.
 *
 * Usage, from `engine/` after `npm run build`:
 *   npx tsx demo/team/scripts/acceptance-seats.ts <repository> [rig-name]
 * Prints the rig id and each seat.
 */
import type Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { createDb } from "../../../packages/daemon/src/db/connection.js";
import { migrate } from "../../../packages/daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../../packages/daemon/src/db/all-migrations.js";
import { resolveDaemonDbPath } from "../../../packages/daemon/src/daemon-db-path.js";
import { OPENRIG_HOME } from "../../../packages/cli/src/openrig-compat.js";
import { RigRepository } from "../../../packages/daemon/src/domain/rig-repository.js";
import { SessionRegistry } from "../../../packages/daemon/src/domain/session-registry.js";

export const ACCEPTANCE_RIG_NAME = "acceptance";

/** The four seats, in the order a run meets them. */
export const ACCEPTANCE_SEATS = [
  { logicalId: "acceptance.lead", role: "lead" as const, seat: "lead@acceptance" },
  { logicalId: "acceptance.one", role: "implementer" as const, seat: "one@acceptance" },
  { logicalId: "acceptance.two", role: "implementer" as const, seat: "two@acceptance" },
  { logicalId: "acceptance.review", role: "reviewer" as const, seat: "review@acceptance" },
];

/** Idempotent: a second call finds the rig and leaves it alone. */
export function seedAcceptanceSeats(db: Database.Database, repository: string,
  rigName = ACCEPTANCE_RIG_NAME): { rigId: string; created: boolean } {
  const root = realpathSync(repository);
  const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
  const existing = rigs.findRigsByName(rigName)[0];
  if (existing) return { rigId: existing.id, created: false };
  const rig = rigs.createRig(rigName, root);
  for (const seat of ACCEPTANCE_SEATS) {
    const node = rigs.addNode(rig.id, seat.logicalId, { role: seat.role, runtime: "claude-code", cwd: root });
    sessions.registerSession(node.id, seat.seat);
  }
  return { rigId: rig.id, created: true };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
  const repository = process.argv[2];
  if (!repository) throw new Error("usage: acceptance-seats.ts <repository> [rig-name]");
  const db = createDb(resolveDaemonDbPath(process.env.OPENRIG_DB, OPENRIG_HOME));
  try {
    migrate(db, ALL_MIGRATIONS);
    const { rigId, created } = seedAcceptanceSeats(db, repository, process.argv[3]);
    console.log(created ? `Created rig "${ACCEPTANCE_RIG_NAME}" (${rigId}).` : `Rig already exists (${rigId}); left alone.`);
    for (const seat of ACCEPTANCE_SEATS) console.log(`  ${seat.role.padEnd(12)} ${seat.seat}`);
  } finally {
    db.close();
  }
}
