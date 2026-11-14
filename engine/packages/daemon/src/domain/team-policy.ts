import type Database from "better-sqlite3";
import { integer, object, TeamContractError } from "../contracts/team-control.js";

/**
 * Plan R20 / KTD14 — what a team may start on its own.
 *
 * The accept mode and the owner's rules are one versioned policy per team, `observe` until the
 * owner saves one. Every item the GitHub intake sees is recorded here with the state it reached,
 * so the inbox shows what would have started, what did, and what was skipped.
 */
export const INTAKE_MODES = ["off", "observe", "auto"] as const;
export type IntakeMode = (typeof INTAKE_MODES)[number];
export interface IntakeRule { name: string; instruction: string; enabled: boolean }
export interface IntakePolicy { revision: number; mode: IntakeMode; rules: IntakeRule[] }

export type IntakeState = "pending" | "would_start" | "started" | "skipped" | "unavailable" | "dismissed";
export type IntakeKind = "issue" | "comment" | "ci";
export interface IntakeItem {
  item: string; kind: IntakeKind; title: string; url: string; author: string;
  /** An owner-authored request that mentioned the agent account. */
  explicit: boolean;
  state: IntakeState; matched: string[]; policyRevision: number | null; runId: string | null;
  createdAt: string; updatedAt: string;
}

export const INTAKE_RULE_LIMIT = 20;

export class TeamPolicyError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

export function readIntakePolicy(db: Database.Database, rigId: string): IntakePolicy {
  const row = db.prepare(`SELECT revision, mode, rules_json AS rules FROM team_intake_policies
    WHERE rig_id = ? ORDER BY revision DESC LIMIT 1`).get(rigId) as { revision: number; mode: IntakeMode; rules: string } | undefined;
  return row ? { revision: row.revision, mode: row.mode, rules: JSON.parse(row.rules) } : { revision: 0, mode: "observe", rules: [] };
}

function rules(value: unknown): IntakeRule[] {
  if (!Array.isArray(value)) throw new TeamContractError("rules");
  if (value.length > INTAKE_RULE_LIMIT) throw new TeamPolicyError("intake_rules_invalid", `A team has at most ${INTAKE_RULE_LIMIT} rules.`);
  const names = new Set<string>();
  return value.map(entry => {
    const v = object(entry, "rules");
    const name = typeof v.name === "string" ? v.name.trim() : "";
    const instruction = typeof v.instruction === "string" ? v.instruction.trim() : "";
    if (!name || name.length > 80) throw new TeamPolicyError("intake_rules_invalid", "A rule name is 1 to 80 characters.");
    if (!instruction || instruction.length > 2000) throw new TeamPolicyError("intake_rules_invalid", "A rule instruction is 1 to 2000 characters.");
    if (names.has(name)) throw new TeamPolicyError("intake_rules_invalid", `Two rules are named "${name}".`);
    if (v.enabled !== undefined && typeof v.enabled !== "boolean") throw new TeamContractError("rules.enabled");
    names.add(name);
    return { name, instruction, enabled: v.enabled !== false };
  });
}

/**
 * Save a new revision. Items still waiting for an assessment are requeued, so each one is judged
 * once under the policy now in force; an assessment already running under the old revision is
 * discarded when it returns. `baseRevision` is the revision the editor read: a save made against
 * an older one is refused, so two editors never overwrite each other unseen.
 */
export function saveIntakePolicy(db: Database.Database, rigId: string, value: unknown, now = new Date()): IntakePolicy {
  if (!db.prepare("SELECT 1 FROM rigs WHERE id = ?").get(rigId)) throw new TeamPolicyError("team_not_found", "No team has that id.", 404);
  const v = object(value, "policy");
  if (Object.keys(v).some(key => !["baseRevision", "mode", "rules"].includes(key))) throw new TeamContractError("policy");
  const baseRevision = integer(v.baseRevision, "policy.baseRevision", 0);
  if (!INTAKE_MODES.includes(v.mode as IntakeMode)) throw new TeamContractError("mode");
  const policy = { revision: baseRevision + 1, mode: v.mode as IntakeMode, rules: rules(v.rules) };
  db.transaction(() => {
    if (readIntakePolicy(db, rigId).revision !== baseRevision) {
      throw new TeamPolicyError("intake_policy_conflict", "The intake policy changed. Reload it before saving.", 409);
    }
    db.prepare("INSERT INTO team_intake_policies (rig_id, revision, mode, rules_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(rigId, policy.revision, policy.mode, JSON.stringify(policy.rules), now.toISOString());
    db.prepare("UPDATE team_intake_items SET attempts = 0, policy_revision = NULL, updated_at = ? WHERE rig_id = ? AND state = 'pending'")
      .run(now.toISOString(), rigId);
  })();
  return policy;
}

interface ItemRow { item: string; kind: IntakeKind; title: string; url: string; author: string; explicit: number; state: IntakeState;
  matched: string; policyRevision: number | null; runId: string | null; createdAt: string; updatedAt: string }
const ITEM_COLUMNS = `item, kind, title, url, author, explicit, state, matched_json AS matched, policy_revision AS policyRevision,
  run_id AS runId, created_at AS createdAt, updated_at AS updatedAt`;
const toItem = (row: ItemRow): IntakeItem => ({ ...row, explicit: row.explicit === 1, matched: JSON.parse(row.matched) });

/** The inbox: newest first, at most 100. */
export function listIntakeItems(db: Database.Database, rigId: string): IntakeItem[] {
  return (db.prepare(`SELECT ${ITEM_COLUMNS} FROM team_intake_items WHERE rig_id = ? ORDER BY created_at DESC, item DESC LIMIT 100`)
    .all(rigId) as ItemRow[]).map(toItem);
}

export function readIntakeItem(db: Database.Database, rigId: string, item: string): IntakeItem | null {
  const row = db.prepare(`SELECT ${ITEM_COLUMNS} FROM team_intake_items WHERE rig_id = ? AND item = ?`).get(rigId, item) as ItemRow | undefined;
  return row ? toItem(row) : null;
}

/** Mark an item the owner does not want started. A started or dismissed item stays as it is. */
export function dismissIntakeItem(db: Database.Database, rigId: string, item: string, now = new Date()): IntakeItem {
  const current = readIntakeItem(db, rigId, item);
  if (!current) throw new TeamPolicyError("intake_item_not_found", "No inbox item has that id.", 404);
  if (current.state === "started" || current.state === "dismissed") {
    throw new TeamPolicyError("intake_item_closed", "That item has already started or been dismissed.", 409);
  }
  db.prepare("UPDATE team_intake_items SET state = 'dismissed', updated_at = ? WHERE rig_id = ? AND item = ?").run(now.toISOString(), rigId, item);
  return readIntakeItem(db, rigId, item)!;
}
