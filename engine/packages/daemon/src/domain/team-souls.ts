import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson, integer, object, text, TeamContractError, type TeamRole } from "../contracts/team-control.js";
import { SessionRegistry } from "./session-registry.js";

export interface SpecialistSoul {
  id: string; version: number; name: string; roles: TeamRole[]; content: string; digest: string;
}
export class TeamSoulError extends Error {
  constructor(readonly code: string, message: string, readonly status: 404 | 409 = 409) { super(message); }
}

const defaults: Array<Omit<SpecialistSoul, "version" | "digest">> = [
  { id: "coordinator", name: "Project coordinator", roles: ["lead"],
    content: "Turn the owner's goal into a right-sized plan and a small team. Select specialists by the actual work, reuse idle seats and delegate independent tasks. Resolve ordinary implementation choices yourself. Track evidence, dependencies, review and remaining risks; ask the owner only for decisions outside the approved scope." },
  { id: "engineer", name: "Software engineer", roles: ["implementer"],
    content: "Trace the current behavior before changing it. Prefer existing owners and simple, surgical implementations. Work vertically from a real caller through persistence and verification. Keep a regression test for a verified defect. Report what ran, what changed and what remains unproved." },
  { id: "architect", name: "Systems architect", roles: ["implementer"],
    content: "Map ownership, data flow and failure boundaries before proposing structure. Compare reuse, extension and composition against the smallest new abstraction. Preserve compatibility and explain consequential trade-offs. Turn decisions into concrete interfaces and verifiable acceptance without speculative infrastructure." },
  { id: "frontend", name: "Frontend specialist", roles: ["implementer"],
    content: "Build complete user flows with the existing design system. Include loading, empty, error and recovery states, keyboard access and responsive layouts. Verify the real interaction at desktop and mobile sizes. Keep visual polish subordinate to correct state, clear actions and accessible semantics." },
  { id: "backend", name: "Backend specialist", roles: ["implementer"],
    content: "Follow requests through validation, authorization, transactions and durable state. Preserve idempotency, compatibility and failure visibility. Test real boundary behavior, including concurrent updates and restart recovery. Keep secrets and internal control surfaces out of user and worker outputs." },
  { id: "verification", name: "Verification specialist", roles: ["implementer", "reviewer"],
    content: "Derive tests from the user's workflow and the highest-impact failure modes. Separate source checks, fixtures, runtime behavior and end-to-end acceptance. Seek counterexamples to apparent success. Preserve useful failure evidence and state precisely which capabilities or scenarios remain unverified." },
  { id: "reviewer", name: "Independent reviewer", roles: ["reviewer"],
    content: "Review the current candidate against its task and actual callers. Prioritize reachable correctness, data loss, security and regression defects. Give concise findings with a concrete scenario and source evidence. Remain report-only; do not implement fixes, self-approve or treat missing evidence as a passing verdict." },
];
export const defaultSoulId = (role: TeamRole): string => role === "lead" ? "coordinator" : role === "reviewer" ? "reviewer" : "engineer";
export function soulId(value: unknown): string {
  const id = text(value, "soulId", 64);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new TeamContractError("soulId");
  return id;
}
export function soulDigest(soul: Omit<SpecialistSoul, "digest">): string {
  return createHash("sha256").update(canonicalJson(soul)).digest("hex");
}
function projectExists(db: Database.Database, rigId: string): void {
  if (!db.prepare("SELECT 1 FROM rigs WHERE id = ?").get(rigId)) throw new TeamSoulError("team_not_found", "The project no longer exists.", 404);
}
function storedSouls(db: Database.Database, rigId: string): SpecialistSoul[] {
  return (db.prepare(`SELECT soul_id AS id, version, name, roles_json AS rolesJson, content, digest
    FROM team_soul_versions v WHERE rig_id = ? AND version = (
      SELECT MAX(version) FROM team_soul_versions WHERE rig_id = v.rig_id AND soul_id = v.soul_id)
    ORDER BY soul_id`).all(rigId) as Array<Omit<SpecialistSoul, "roles"> & { rolesJson: string }>).map(({ rolesJson, ...soul }) =>
    ({ ...soul, roles: JSON.parse(rolesJson) as TeamRole[] }));
}
export function listTeamSouls(db: Database.Database, rigId: string): SpecialistSoul[] {
  projectExists(db, rigId);
  const profiles = new Map(defaults.map(item => {
    const soul = { ...item, roles: [...item.roles], version: 1 };
    return [item.id, { ...soul, digest: soulDigest(soul) }];
  }));
  for (const soul of storedSouls(db, rigId)) profiles.set(soul.id, soul);
  return [...profiles.values()];
}
export function resolveTeamSoul(db: Database.Database, rigId: string, role: TeamRole, id = defaultSoulId(role)): SpecialistSoul {
  const soul = listTeamSouls(db, rigId).find(item => item.id === id);
  if (!soul) throw new TeamSoulError("soul_not_found", "The selected specialist profile does not exist in this project.", 404);
  if (!soul.roles.includes(role)) throw new TeamSoulError("soul_role_mismatch", "The specialist profile does not support this seat's permission role.");
  return soul;
}
export function rosterSoulRefusal(db: Database.Database, rigId: string, seats: readonly { role: TeamRole; soulId?: string }[]): string | null {
  try { for (const seat of seats) resolveTeamSoul(db, rigId, seat.role, seat.soulId); return null; }
  catch (error) { if (error instanceof TeamSoulError) return error.message; throw error; }
}
export function saveTeamSoul(db: Database.Database, rigId: string, id: string, value: unknown): SpecialistSoul {
  soulId(id);
  const body = object(value, "soul");
  if (Object.keys(body).some(key => !["expectedVersion", "name", "roles", "content"].includes(key))
    || !Array.isArray(body.roles) || !body.roles.length || body.roles.length > 3
    || new Set(body.roles).size !== body.roles.length
    || body.roles.some(role => !["lead", "implementer", "reviewer"].includes(role as string))
    || typeof body.content !== "string" || !body.content.trim() || body.content.length > 16_384
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.content)) throw new TeamContractError("soul");
  const expected = integer(body.expectedVersion, "expectedVersion", 0), name = text(body.name, "soul.name", 128);
  return db.transaction(() => {
    const previous = listTeamSouls(db, rigId).find(item => item.id === id);
    if ((previous?.version ?? 0) !== expected) throw new TeamSoulError("soul_version_conflict", "The profile changed. Reload it before saving.");
    const roles = body.roles as TeamRole[];
    const assigned = db.prepare(`SELECT role, soul_id AS soulId FROM nodes WHERE rig_id = ? AND retired_at IS NULL
      AND role IN ('lead', 'implementer', 'reviewer')`).all(rigId) as Array<{ role: TeamRole; soulId: string | null }>;
    if (assigned.some(seat => (seat.soulId ?? defaultSoulId(seat.role)) === id && !roles.includes(seat.role))) {
      throw new TeamSoulError("soul_in_use", "Keep support for the permission roles of seats using this profile.");
    }
    const value = { id, version: expected + 1, name, roles: [...roles].sort(), content: body.content as string };
    const soul = { ...value, digest: soulDigest(value) };
    db.prepare(`INSERT INTO team_soul_versions (rig_id, soul_id, version, name, roles_json, content, digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(rigId, id, soul.version, name, JSON.stringify(soul.roles), soul.content, soul.digest, new Date().toISOString());
    return soul;
  })();
}

export function teamSoulSettings(db: Database.Database, rigId: string) {
  const profiles = listTeamSouls(db, rigId);
  const seats = (db.prepare(`SELECT n.id AS nodeId, n.role, n.soul_id AS soulId,
    (SELECT session_name FROM sessions WHERE node_id = n.id ORDER BY rowid DESC LIMIT 1) AS member
    FROM nodes n WHERE n.rig_id = ? AND n.retired_at IS NULL AND n.role IN ('lead', 'implementer', 'reviewer')
    ORDER BY n.logical_id`).all(rigId) as Array<{ nodeId: string; role: TeamRole; soulId: string | null; member: string | null }>).map(seat =>
    ({ ...seat, soulId: seat.soulId ?? defaultSoulId(seat.role) }));
  return { profiles, seats };
}
export function seatHasUnfinishedWork(db: Database.Database, member: string | null): boolean {
  return !!db.prepare(`SELECT 1 FROM queue_items q JOIN team_queue_authority a ON a.qitem_id = q.qitem_id
    WHERE q.destination_session = ? AND (q.state IN ('pending', 'in-progress', 'blocked')
      OR EXISTS (SELECT 1 FROM team_attempts WHERE qitem_id = q.qitem_id AND state <> 'stopped')) LIMIT 1`).get(member);
}
export function assignSeatSoul(db: Database.Database, rigId: string, nodeId: string, value: unknown): void {
  const body = object(value, "seatSoul");
  if (Object.keys(body).some(key => key !== "soulId")) throw new TeamContractError("seatSoul");
  const id = soulId(body.soulId);
  db.transaction(() => {
    const seat = teamSoulSettings(db, rigId).seats.find(item => item.nodeId === nodeId);
    if (!seat) throw new TeamSoulError("seat_not_found", "The active seat no longer exists in this project.", 404);
    resolveTeamSoul(db, rigId, seat.role, id);
    if (seat.soulId === id) return;
    if (seatHasUnfinishedWork(db, seat.member)) throw new TeamSoulError("soul_seat_busy", "Wait for this seat's assigned work to finish before changing its specialist identity.");
    db.prepare("UPDATE nodes SET soul_id = ? WHERE id = ?").run(id, nodeId);
    const sessions = db.prepare("SELECT id FROM sessions WHERE node_id = ?").all(nodeId) as Array<{ id: string }>;
    const registry = new SessionRegistry(db);
    for (const session of sessions) registry.clearResumeToken(session.id);
  })();
}
