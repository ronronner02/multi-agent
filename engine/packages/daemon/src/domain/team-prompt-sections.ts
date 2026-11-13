import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { integer, object, TeamContractError } from "../contracts/team-control.js";

/**
 * Plan R13–R15 / KTD9 — the three team prompt sections the owner may edit.
 *
 * The built-in text lives in `engine/config/team/sections/`. A save stores only the sections the
 * owner overrode, each with the built-in text it was based on, as one immutable revision per
 * team. A section whose built-in text changed since the owner's save is marked
 * `defaultChanged`, so settings can show both defaults beside the owner's text. The text guides
 * agents and grants nothing: the daemon's rules, the core and the role charters rank above it.
 */
export const TEAM_SECTIONS = ["communication", "scope", "delivery"] as const;
export type TeamSectionName = (typeof TEAM_SECTIONS)[number];

/** The total size of every override together. Longer text is refused, never cut. */
export const TEAM_SECTIONS_LIMIT = 16_384;

export class TeamSectionsError extends Error {
  constructor(readonly code: string, message: string, readonly status: 409 | 413 = 409) { super(message); }
}

/** The built-in text, read on every call so a new default reaches the next attempt without a restart. */
export function defaultSection(name: TeamSectionName): string {
  return readFileSync(new URL(`../../../../config/team/sections/${name}.md`, import.meta.url), "utf8");
}

interface Revision { revision: number; overrides: Partial<Record<TeamSectionName, string>>; bases: Partial<Record<TeamSectionName, string>> }

function latest(db: Database.Database, rigId: string): Revision {
  const row = db.prepare(`SELECT revision, overrides_json AS overrides, bases_json AS bases FROM team_prompt_versions
    WHERE rig_id = ? ORDER BY revision DESC LIMIT 1`).get(rigId) as { revision: number; overrides: string; bases: string } | undefined;
  return row ? { revision: row.revision, overrides: JSON.parse(row.overrides), bases: JSON.parse(row.bases) } : { revision: 0, overrides: {}, bases: {} };
}

export interface TeamSectionView {
  name: TeamSectionName;
  /** What agents read: the owner's override, or the built-in text. */
  text: string;
  overridden: boolean;
  defaultText: string;
  /** The built-in text the override was saved against, when it has since changed. */
  previousDefault: string | null;
  defaultChanged: boolean;
}

export function teamSectionSettings(db: Database.Database, rigId: string): { revision: number; sections: TeamSectionView[] } {
  const current = latest(db, rigId);
  return { revision: current.revision, sections: TEAM_SECTIONS.map(name => {
    const defaultText = defaultSection(name), override = current.overrides[name];
    const base = current.bases[name] ?? null;
    const defaultChanged = override !== undefined && base !== null && base !== defaultText;
    return { name, text: override ?? defaultText, overridden: override !== undefined, defaultText,
      previousDefault: defaultChanged ? base : null, defaultChanged };
  }) };
}

/**
 * Save a new revision. `sections` names the sections this save changes: a string is the
 * owner's text, saved against today's built-in text; `null` returns the section to the
 * built-in text. Text identical to the built-in text is not an override, so it follows future
 * defaults. Saving the same text again re-bases it, which is how "Keep mine" clears the mark.
 */
export function saveTeamSections(db: Database.Database, rigId: string, value: unknown): { revision: number; sections: TeamSectionView[] } {
  const body = object(value, "teamSections");
  if (Object.keys(body).some(key => key !== "baseRevision" && key !== "sections")) throw new TeamContractError("teamSections");
  const baseRevision = integer(body.baseRevision, "teamSections.baseRevision", 0);
  const changes = object(body.sections, "teamSections.sections");
  for (const [name, text] of Object.entries(changes)) {
    if (!(TEAM_SECTIONS as readonly string[]).includes(name)) throw new TeamContractError("teamSections.sections");
    if (text !== null && (typeof text !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))) {
      throw new TeamContractError("teamSections.sections." + name);
    }
  }
  return db.transaction(() => {
    const current = latest(db, rigId);
    if (current.revision !== baseRevision) throw new TeamSectionsError("sections_revision_conflict", "The team sections changed. Reload them before saving.");
    const overrides = { ...current.overrides }, bases = { ...current.bases };
    for (const [key, text] of Object.entries(changes) as [TeamSectionName, string | null][]) {
      const defaultText = defaultSection(key);
      if (text === null || text.trim() === "" || text === defaultText) { delete overrides[key]; delete bases[key]; continue; }
      overrides[key] = text; bases[key] = defaultText;
    }
    const size = Object.values(overrides).reduce((total, text) => total + (text?.length ?? 0), 0);
    if (size > TEAM_SECTIONS_LIMIT) throw new TeamSectionsError("sections_too_large", `The team sections exceed ${TEAM_SECTIONS_LIMIT} characters.`, 413);
    db.prepare(`INSERT INTO team_prompt_versions (rig_id, revision, overrides_json, bases_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(rigId, current.revision + 1, JSON.stringify(overrides), JSON.stringify(bases), new Date().toISOString());
    return teamSectionSettings(db, rigId);
  })();
}

/** The projected file every attempt reads after its charter. */
export function teamSectionsText(db: Database.Database, rigId: string): string {
  return ["# Team sections",
    "Set by the owner for this team. They guide how you work; the core, your charter and the daemon's rules rank above them.",
    ...teamSectionSettings(db, rigId).sections.map(section => section.text.trim())].join("\n\n") + "\n";
}
