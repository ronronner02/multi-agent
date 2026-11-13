import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { defaultSection, saveTeamSections, teamSectionSettings, teamSectionsText, TeamSectionsError, TEAM_SECTIONS_LIMIT } from "../src/domain/team-prompt-sections.js";
import { attemptInstructionFiles, type ContextManifest } from "../src/integrations/framework/context-manifest.js";

/**
 * Plan R13–R15 — the owner's three team sections: versioned saves, a conflict on a stale base,
 * built-in text that keeps following new defaults, and a mark when a default changes under an
 * override.
 */
describe("team prompt sections", () => {
  let db: Database.Database;
  const section = (name: string) => teamSectionSettings(db, "rig").sections.find(item => item.name === name)!;
  beforeEach(() => {
    db = createDb(":memory:"); initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'Project')").run();
  });
  afterEach(() => db.close());

  it("reads the built-in text until the owner saves, then versions each save", () => {
    expect(teamSectionSettings(db, "rig").revision).toBe(0);
    expect(section("communication")).toMatchObject({ overridden: false, text: defaultSection("communication"), defaultChanged: false });
    const saved = saveTeamSections(db, "rig", { baseRevision: 0, sections: { communication: "## Communication\n\nNever message on weekends." } });
    expect(saved.revision).toBe(1);
    expect(section("communication")).toMatchObject({ overridden: true, text: "## Communication\n\nNever message on weekends." });
    expect(section("scope").overridden).toBe(false);
    saveTeamSections(db, "rig", { baseRevision: 1, sections: { scope: "## Task scope\n\nStop at 300 lines." } });
    expect(teamSectionSettings(db, "rig").revision).toBe(2);
    expect(section("communication").overridden).toBe(true);
  });

  it("refuses a save against a stale revision, an unknown section, and text over the limit", () => {
    saveTeamSections(db, "rig", { baseRevision: 0, sections: { delivery: "## Delivery\n\nOne reviewer." } });
    expect(() => saveTeamSections(db, "rig", { baseRevision: 0, sections: { delivery: "x" } })).toThrow(TeamSectionsError);
    expect(() => saveTeamSections(db, "rig", { baseRevision: 1, sections: { tone: "x" } })).toThrow();
    let caught: unknown;
    try { saveTeamSections(db, "rig", { baseRevision: 1, sections: { scope: "x".repeat(TEAM_SECTIONS_LIMIT + 1) } }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "sections_too_large", status: 413 });
    expect(teamSectionSettings(db, "rig").revision).toBe(1);
  });

  it("drops an override equal to the built-in text, or set to null, so the section follows new defaults", () => {
    saveTeamSections(db, "rig", { baseRevision: 0, sections: { scope: "## Task scope\n\nCustom." } });
    saveTeamSections(db, "rig", { baseRevision: 1, sections: { scope: defaultSection("scope") } });
    expect(section("scope").overridden).toBe(false);
    saveTeamSections(db, "rig", { baseRevision: 2, sections: { scope: "## Task scope\n\nCustom again." } });
    saveTeamSections(db, "rig", { baseRevision: 3, sections: { scope: null } });
    expect(section("scope")).toMatchObject({ overridden: false, text: defaultSection("scope") });
  });

  it("marks an override whose built-in text changed, and Keep mine or Use the new default clears it", () => {
    // An override saved against an older built-in text, as a later upgrade leaves it.
    db.prepare(`INSERT INTO team_prompt_versions (rig_id, revision, overrides_json, bases_json, created_at) VALUES ('rig', 1, ?, ?, '2026-11-13T00:00:00Z')`)
      .run(JSON.stringify({ communication: "Mine." }), JSON.stringify({ communication: "The old default." }));
    expect(section("communication")).toMatchObject({ overridden: true, text: "Mine.", defaultChanged: true,
      previousDefault: "The old default.", defaultText: defaultSection("communication") });
    saveTeamSections(db, "rig", { baseRevision: 1, sections: { communication: "Mine." } });
    expect(section("communication")).toMatchObject({ overridden: true, defaultChanged: false, previousDefault: null });
    db.prepare(`INSERT INTO team_prompt_versions (rig_id, revision, overrides_json, bases_json, created_at) VALUES ('rig', 3, ?, ?, '2026-11-13T00:00:00Z')`)
      .run(JSON.stringify({ communication: "Mine." }), JSON.stringify({ communication: "The old default." }));
    saveTeamSections(db, "rig", { baseRevision: 3, sections: { communication: null } });
    expect(section("communication")).toMatchObject({ overridden: false, defaultChanged: false });
  });

  it("projects every section, with the owner's override, below the core and the charter", () => {
    saveTeamSections(db, "rig", { baseRevision: 0, sections: { delivery: "## Delivery requirements\n\nTwo reviewers approve." } });
    const text = teamSectionsText(db, "rig");
    expect(text).toContain("the core, your charter and the daemon's rules rank above them");
    expect(text).toContain("Two reviewers approve.");
    expect(text).toContain(defaultSection("communication").trim());
    expect(text).toContain(defaultSection("scope").trim());
    const files = (["run", "soul", "team", "charter", "core"] as const).map(kind => ({ kind, path: `/context/${kind}`, workerPath: `/context/${kind}` }));
    const order = attemptInstructionFiles({ files, sameIdentity: true } as unknown as ContextManifest).map(file => file.kind);
    expect(order).toEqual(["core", "charter", "team", "soul", "run"]);
  });
});
