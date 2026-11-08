import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { assignSeatSoul, listTeamSouls, resolveTeamSoul, rosterSoulRefusal, saveTeamSoul, soulDigest, teamSoulSettings } from "../src/domain/team-souls.js";

describe("versioned project specialist profiles", () => {
  let directory: string, db: Database.Database;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "team-souls-"));
    db = createDb(join(directory, "state.sqlite")); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('project', 'fixture'), ('other', 'other')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, profile) VALUES ('seat', 'project', 'impl', 'implementer', 'codex', 'legacy-runtime-profile')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, resume_type, resume_token) VALUES ('session', 'seat', 'impl@fixture', 'codex_id', 'previous-thread')").run();
  });
  afterEach(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("provides specialists without reinterpreting the runtime profile or permission role", () => {
    expect(listTeamSouls(db, "project").map(item => item.id)).toContain("frontend");
    expect(resolveTeamSoul(db, "project", "implementer").id).toBe("engineer");
    expect(teamSoulSettings(db, "project").seats[0]).toMatchObject({ soulId: "engineer", role: "implementer" });
    expect(db.prepare("SELECT profile FROM nodes WHERE id = 'seat'").get()).toEqual({ profile: "legacy-runtime-profile" });
  });
  it("persists revisions, detects stale writes and keeps projects independent", () => {
    const before = resolveTeamSoul(db, "project", "implementer", "frontend");
    const saved = saveTeamSoul(db, "project", "frontend", { expectedVersion: 1, name: "UI engineer",
      roles: ["implementer"], content: "Verify real browser flows and keyboard behavior." });
    expect(saved.version).toBe(2); expect(saved.digest).not.toBe(before.digest);
    expect(() => saveTeamSoul(db, "project", "frontend", { expectedVersion: 1, name: "Stale", roles: ["implementer"], content: "Old edit" })).toThrow(/Reload/);
    db.close(); db = createDb(join(directory, "state.sqlite"));
    expect(resolveTeamSoul(db, "project", "implementer", "frontend")).toEqual(saved);
    expect(resolveTeamSoul(db, "other", "implementer", "frontend")).toEqual(before);
    expect(before.version).toBe(1);
  });
  it("creates custom identities and preserves every stored version", () => {
    const first = saveTeamSoul(db, "project", "data", { expectedVersion: 0, name: "Data specialist", roles: ["implementer"], content: "Check schema compatibility." });
    const next = saveTeamSoul(db, "project", "data", { expectedVersion: 1, name: "Data specialist", roles: ["implementer"], content: "Check schema compatibility and migrations." });
    expect(next.version).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM team_soul_versions WHERE soul_id = 'data'").get()).toEqual({ count: 2 });
    const { digest, ...value } = first; expect(digest).toBe(soulDigest(value));
  });
  it("lets the owner assign a compatible specialist and clears only that seat's continuation", () => {
    assignSeatSoul(db, "project", "seat", { soulId: "backend" });
    expect(teamSoulSettings(db, "project").seats[0]?.soulId).toBe("backend");
    expect(db.prepare("SELECT resume_token FROM sessions WHERE id = 'session'").get()).toEqual({ resume_token: null });
    expect(() => assignSeatSoul(db, "other", "seat", { soulId: "backend" })).toThrow(/seat/);
    expect(() => assignSeatSoul(db, "project", "seat", { soulId: "reviewer" })).toThrow(/permission role/);
  });
  it("rejects worker identity fields that could grant permissions and protects assigned roles", () => {
    expect(() => saveTeamSoul(db, "project", "engineer", { expectedVersion: 1, name: "Changed",
      roles: ["reviewer"], content: "Review." })).toThrow(/permission roles/);
    expect(() => saveTeamSoul(db, "project", "data", { expectedVersion: 0, name: "Data",
      roles: ["implementer"], content: "Work.", permissions: ["merge"] })).toThrow();
    expect(rosterSoulRefusal(db, "project", [{ role: "implementer", soulId: "missing" }])).toContain("does not exist");
    expect(resolveTeamSoul(db, "project", "reviewer").content).toContain("report-only");
  });
  it.each(["../soul", "Bad", "--option"])("rejects invalid profile ID %s", id => {
    expect(() => saveTeamSoul(db, "project", id, { expectedVersion: 0, name: "Invalid", roles: ["lead"], content: "Text" })).toThrow();
  });
});
