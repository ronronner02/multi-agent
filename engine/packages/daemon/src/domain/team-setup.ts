import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { TeamRole } from "../contracts/team-control.js";
import { RigRepository } from "./rig-repository.js";
import { SessionRegistry } from "./session-registry.js";

/**
 * U3 — one team for one repository.
 *
 * A team is a rig whose nodes are the seats a managed run needs: a lead, one or more
 * implementers and a reviewer. Every seat is a row only, exactly as the demo seeds wrote them
 * before this module existed: nothing is launched here, so creating a team needs no provider
 * account, and the first start opens each seat's terminal as it always has.
 *
 * The daemon, the CLI and the demo seeds all create teams through `createTeam`, so a seat the
 * owner creates from the terminal and one a demo seeds cannot differ in shape.
 */

export const TEAM_ROLES: readonly TeamRole[] = ["lead", "implementer", "reviewer"];
const TEAM_CLIENTS = ["claude-code", "codex"] as const;
export type TeamClient = typeof TEAM_CLIENTS[number];

export interface TeamSeatInput {
  role: TeamRole;
  client: TeamClient;
  /** The one per-launch setting this slice passes through (KTD6: everything else is local config). */
  model?: string;
}

/** What a team looks like to its owner: roles and clients, never the internal seat names. */
export interface TeamSeat {
  role: TeamRole;
  client: TeamClient;
  model?: string;
}

export interface Team {
  id: string;
  name: string;
  /** The canonical repository root the team works on. */
  repository: string;
  seats: TeamSeat[];
  kind?: "project" | "test";
}

export type TeamSetupCode =
  | "team_repository_unreadable"
  | "team_repository_not_git"
  | "team_repository_no_commit"
  | "team_exists"
  | "team_name_taken"
  | "team_seats_invalid";

/** A refusal the owner can act on: a path that is not a git repository, a duplicate team, or seats. */
export class TeamSetupError extends Error {
  constructor(readonly code: TeamSetupCode, message: string) {
    super(message);
    this.name = "TeamSetupError";
  }
}

/** `claude` is the shorthand the owner types; the stored and reported client is the runtime name. */
export function parseTeamClient(value: string): TeamClient | null {
  const client = value.trim() === "claude" ? "claude-code" : value.trim();
  return (TEAM_CLIENTS as readonly string[]).includes(client) ? client as TeamClient : null;
}

/**
 * Create the team for a repository, or refuse.
 *
 * The repository is refused rather than guessed at: a path that is not a git repository, or one
 * with no commit, has no identity a plan can be approved against, and a second team on the same
 * root would put two sets of seats on one repository with nothing distinguishing them.
 */
export function createTeam(db: Database.Database, input: {
  repository: string;
  seats?: readonly TeamSeatInput[];
  leadClient?: TeamClient;
  /** An explicit name. The seeds keep theirs; the CLI and the route derive one from the folder. */
  name?: string;
}): Team {
  const seats = validatedSeats(input.seats ?? [{ role: "lead", client: input.leadClient ?? "claude-code" }]);
  const root = repositoryRoot(input.repository);
  const rigs = new RigRepository(db);
  const name = availableTeamName(db, root, input.name);
  const rig = rigs.createRig(name, root);
  addTeamSeats(db, rig.id, seats);
  // Read back through the same projection the list uses, so a create and a later read of the
  // same team cannot report its seats in different orders.
  return { id: rig.id, name, repository: root, seats: recordedSeats(db, rig.id), kind: "project" };
}

/** Allocate above every recorded index, including retired seats and earlier session names. */
export function nextTeamSeatNames(db: Database.Database, rigId: string, seats: readonly TeamSeatInput[]): string[] {
  const rig = new RigRepository(db).getRig(rigId)?.rig;
  if (!rig) throw new Error("Rig not found");
  const rows = db.prepare(`SELECT n.logical_id AS logicalId, s.session_name AS member FROM nodes n
    LEFT JOIN sessions s ON s.node_id = n.id WHERE n.rig_id = ?`).all(rigId) as
    Array<{ logicalId: string; member: string | null }>;
  const counted: Record<TeamRole, number> = { lead: 0, implementer: 0, reviewer: 0 };
  for (const role of TEAM_ROLES) {
    const prefix = SEAT_PREFIX[role] + "-";
    for (const row of rows) {
      for (const name of [row.logicalId.startsWith(rig.name + ".") ? row.logicalId.slice(rig.name.length + 1) : "",
        row.member?.endsWith("@" + rig.name) ? row.member.slice(0, -rig.name.length - 1) : ""]) {
        const index = name.startsWith(prefix) ? name.slice(prefix.length) : "";
        if (/^[1-9]\d*$/.test(index)) counted[role] = Math.max(counted[role], Number(index));
      }
    }
  }
  return seats.map(seat => `${SEAT_PREFIX[seat.role]}-${++counted[seat.role]}@${rig.name}`);
}

/** Only writes seat rows; the caller owns the enclosing approval/admission transaction. */
export function addTeamSeats(db: Database.Database, rigId: string, seats: readonly TeamSeatInput[]): Array<TeamSeatInput & { member: string }> {
  const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
  const rig = rigs.getRig(rigId)?.rig;
  if (!rig) throw new Error("Rig not found");
  const root = rigs.getRigInstallRoot(rigId) ?? repositoryOf(db, rigId);
  if (!root) throw new Error("The team's repository is unavailable");
  const names = nextTeamSeatNames(db, rigId, seats);
  return seats.map((seat, index) => {
    const member = names[index]!;
    const node = rigs.addNode(rigId, `${rig.name}.${member.slice(0, -rig.name.length - 1)}`, {
      role: seat.role, runtime: seat.client, cwd: root, ...(seat.model === undefined ? {} : { model: seat.model }),
    });
    sessions.registerSession(node.id, member);
    return { ...seat, member };
  });
}

/** Check local identity before project creation has any external side effects. */
export function availableTeamName(db: Database.Database, root: string, requested?: string): string {
  const existing = teamAt(db, root);
  if (existing) throw new TeamSetupError("team_exists",
    `The repository ${root} already has a team, rig "${existing}". Use it, or create the team for another checkout.`);
  return rigName(db, requested, root);
}

export function isRetiredTeamNode(db: Database.Database, nodeId: string): boolean {
  const row = db.prepare("SELECT retired_at FROM nodes WHERE id = ?").get(nodeId) as { retired_at: string | null } | undefined;
  return row?.retired_at != null;
}

/** The teams that exist, in the order they were created, so no client has to type a rig name. */
export function listTeams(db: Database.Database): Team[] {
  return new RigRepository(db).listRigs().flatMap(rig => {
    const seats = recordedSeats(db, rig.id);
    if (!seats.length) return [];
    const metadata = db.prepare("SELECT team_kind AS kind FROM rigs WHERE id = ?").get(rig.id) as { kind: "project" | "test" };
    return [{ id: rig.id, name: rig.name, repository: repositoryOf(db, rig.id) ?? "", seats, kind: metadata.kind }];
  });
}

const SEAT_PREFIX: Record<TeamRole, string> = { lead: "lead", implementer: "impl", reviewer: "review" };

function validatedSeats(seats: readonly TeamSeatInput[]): TeamSeat[] {
  if (!seats.length) throw new TeamSetupError("team_seats_invalid", "A team needs at least one seat.");
  const seen = new Map<TeamRole, number>();
  return seats.map(seat => {
    if (!TEAM_ROLES.includes(seat.role)) {
      throw new TeamSetupError("team_seats_invalid", `Unknown seat role "${String(seat.role)}"; a seat is a lead, an implementer or a reviewer.`);
    }
    const client = parseTeamClient(seat.client);
    if (!client) {
      throw new TeamSetupError("team_seats_invalid", `Unknown client "${String(seat.client)}" for the ${seat.role} seat; a client is claude-code or codex.`);
    }
    const count = (seen.get(seat.role) ?? 0) + 1;
    // A lead or a reviewer is resolved by its role when a start names none, so two of either
    // would make that default ambiguous. Implementers are a list by nature.
    if (count > 1 && seat.role !== "implementer") {
      throw new TeamSetupError("team_seats_invalid", `A team has at most one ${seat.role} seat.`);
    }
    seen.set(seat.role, count);
    const model = seat.model?.trim();
    return model ? { role: seat.role, client, model } : { role: seat.role, client };
  });
}

/** The canonical root of the repository the path belongs to, if it is one with a commit. */
function repositoryRoot(repository: string): string {
  let path: string;
  try {
    path = realpathSync(repository);
  } catch {
    throw new TeamSetupError("team_repository_unreadable", `The repository path "${repository}" could not be read.`);
  }
  let toplevel: string;
  try {
    toplevel = git(path, "rev-parse", "--show-toplevel");
  } catch {
    throw new TeamSetupError("team_repository_not_git", `${path} is not a git repository.`);
  }
  const root = realpathSync(toplevel);
  try {
    git(root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  } catch {
    throw new TeamSetupError("team_repository_no_commit", `${root} has no commit; a team's plan is approved against one.`);
  }
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * The team whose repository this root already is.
 *
 * A rig counts as a team when it carries a seat with a team role and a managed client, which is
 * the same rule `listTeams` applies, so "a team already exists" and "the teams" can never
 * disagree. A rig of plain seats with no roles is not one.
 */
function teamAt(db: Database.Database, root: string): string | null {
  for (const rig of new RigRepository(db).listRigs()) {
    if (!recordedSeats(db, rig.id).length) continue;
    const rows = db.prepare("SELECT cwd FROM nodes WHERE rig_id = ? AND cwd IS NOT NULL").all(rig.id) as Array<{ cwd: string }>;
    if (rows.some(row => samePath(row.cwd, root))) return rig.name;
  }
  return null;
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === right;
  } catch {
    return false;
  }
}

/**
 * The rig name, from the repository folder unless the caller names one.
 *
 * A name has to be unique on the daemon rather than only among active rigs: it is the rig leg of
 * every seat's session name, and two identical session names made the dispatcher refuse a launch
 * in the C4 acceptance run. A derived name is made unique with a numeric suffix; an explicitly
 * requested name is refused instead, so a demo cannot silently attach itself to another rig.
 */
function rigName(db: Database.Database, requested: string | undefined, root: string): string {
  const taken = (name: string) => (db.prepare("SELECT count(*) AS count FROM rigs WHERE name = ?").get(name) as { count: number }).count > 0;
  const base = sanitiseName(requested ?? basename(root));
  if (!taken(base)) return base;
  if (requested !== undefined) throw new TeamSetupError("team_name_taken", `A rig is already named "${base}".`);
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Seat names allow a-z, A-Z, 0-9, -, _, . and @; anything else becomes a dash. */
function sanitiseName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9\-_.@]/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100);
  return cleaned || "team";
}

/** The seats a rig records: the team's own order, lead first and reviewer last, then by seat. */
function recordedSeats(db: Database.Database, rigId: string): TeamSeat[] {
  const rows = db.prepare(
    `SELECT role, runtime, model FROM nodes WHERE rig_id = ? AND retired_at IS NULL AND runtime IN ('claude-code', 'codex')
      ORDER BY CASE role WHEN 'lead' THEN 0 WHEN 'implementer' THEN 1 WHEN 'reviewer' THEN 2 ELSE 3 END,
        logical_id`).all(rigId) as Array<{ role: string | null; runtime: string; model: string | null }>;
  return rows.flatMap(row => TEAM_ROLES.includes(row.role as TeamRole)
    ? [{ role: row.role as TeamRole, client: row.runtime as TeamClient, ...(row.model ? { model: row.model } : {}) }]
    : []);
}

/** The repository a rig's seats work on: the root it was created against, else a seat's own cwd. */
function repositoryOf(db: Database.Database, rigId: string): string | null {
  const rig = db.prepare("SELECT install_root FROM rigs WHERE id = ?").get(rigId) as { install_root: string | null } | undefined;
  if (rig?.install_root) return rig.install_root;
  const node = db.prepare("SELECT cwd FROM nodes WHERE rig_id = ? AND cwd IS NOT NULL ORDER BY logical_id LIMIT 1")
    .get(rigId) as { cwd: string } | undefined;
  return node?.cwd ?? null;
}
