/**
 * Create the demo team rig: one rig, one implementer node, and that node's session.
 *
 * `rig up` boots agents; the MVP demo wants only the rows a managed start reads — the rig
 * `rig team start` routes to, the node whose cwd is the repository, and the seat session a
 * launch resolves its pane from. Nothing is started here, so nothing needs a provider
 * account or a live token.
 *
 * Usage, from `engine/`: npx tsx demo/team/scripts/start-team-demo.ts
 */
import type Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../../packages/daemon/src/db/connection.js";
import { migrate } from "../../../packages/daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../../packages/daemon/src/db/all-migrations.js";
import { resolveDaemonDbPath } from "../../../packages/daemon/src/daemon-db-path.js";
import { OPENRIG_HOME } from "../../../packages/cli/src/openrig-compat.js";
import { RigRepository } from "../../../packages/daemon/src/domain/rig-repository.js";
import { SessionRegistry } from "../../../packages/daemon/src/domain/session-registry.js";

export const DEMO_RIG_NAME = "team-demo";
export const DEMO_SEAT = `dev-impl@${DEMO_RIG_NAME}`;

/** The demo rig's own directory: the seat's cwd, so its `plan.md` is the plan a run approves. */
export function demoRoot(): string {
  return realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
}

/** Idempotent: a second call finds the rig and leaves it alone. */
export function seedDemoRig(db: Database.Database): { rigId: string; created: boolean } {
  const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
  const existing = rigs.findRigsByName(DEMO_RIG_NAME)[0];
  if (existing) return { rigId: existing.id, created: false };
  const rig = rigs.createRig(DEMO_RIG_NAME, demoRoot());
  const node = rigs.addNode(rig.id, "dev.impl", { role: "implementer", runtime: "claude-code", cwd: demoRoot() });
  sessions.registerSession(node.id, DEMO_SEAT);
  return { rigId: rig.id, created: true };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = createDb(resolveDaemonDbPath(process.env.OPENRIG_DB, OPENRIG_HOME));
  try {
    migrate(db, ALL_MIGRATIONS);
    const { rigId, created } = seedDemoRig(db);
    console.log(created ? `Created rig "${DEMO_RIG_NAME}" (${rigId}) at ${demoRoot()}.`
      : `Rig "${DEMO_RIG_NAME}" already exists (${rigId}); leaving it as it is.`);
    console.log(`Seat: ${DEMO_SEAT}`);
    console.log("");
    console.log('Next: rig team start "Say hello from the demo team"');
  } finally {
    db.close();
  }
}
