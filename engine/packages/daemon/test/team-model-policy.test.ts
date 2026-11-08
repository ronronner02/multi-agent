import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { managedModelRefusal, readTeamModelSettings, rosterModelRefusal, saveTeamModelSettings } from "../src/domain/team-model-policy.js";
import type { WorkerLaunchInput } from "../src/adapters/worker-launch.js";

const policy = { kind: "test", lead: { client: "codex", model: "chosen-lead" },
  allowedSubagents: [{ client: "claude-code", model: "allowed-worker" }] };
const launch = (role: "lead" | "implementer" | "reviewer", client: "claude-code" | "codex", model?: string) => ({ client, model,
  attempt: { context: { runId: "run", assignment: { role } } } }) as WorkerLaunchInput;

describe("project model policy persistence and launch authority", () => {
  let directory: string, db: Database.Database;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "model-policy-")); db = createDb(join(directory, "state.sqlite")); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('project', 'fixture')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES ('lead', 'project', 'lead', 'lead', 'claude-code')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, resume_type, resume_token) VALUES ('session', 'lead', 'lead@fixture', 'claude_id', 'old-native-identity')").run();
    db.prepare("INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at) VALUES ('run', 'project', '{}', 'fixture', 'approved', '2026-11-08', '2026-11-08')").run();
  });
  afterEach(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("preserves native defaults until the owner explicitly configures a policy", () => {
    expect(readTeamModelSettings(db, "project")).toMatchObject({ configured: false, allowedSubagents: null, kind: "project" });
    expect(managedModelRefusal(db, launch("lead", "claude-code"))).toBeNull();
  });
  it("persists across database reopen and clears the old lead's native continuation", () => {
    saveTeamModelSettings(db, "project", policy); db.close(); db = createDb(join(directory, "state.sqlite"));
    expect(readTeamModelSettings(db, "project")).toMatchObject({ ...policy, configured: true, launches: [] });
    expect(db.prepare("SELECT resume_token FROM sessions WHERE id = 'session'").get()).toEqual({ resume_token: null });
  });
  it("enforces the selected lead pair and allowed worker pairs rather than client defaults", () => {
    saveTeamModelSettings(db, "project", policy);
    expect(managedModelRefusal(db, launch("lead", "codex", "chosen-lead"))).toBeNull();
    expect(managedModelRefusal(db, launch("lead", "codex"))).toBe("team_lead_model_mismatch");
    expect(managedModelRefusal(db, launch("lead", "claude-code", "chosen-lead"))).toBe("team_lead_model_mismatch");
    for (const role of ["implementer", "reviewer"] as const) {
      expect(managedModelRefusal(db, launch(role, "claude-code", "allowed-worker"))).toBeNull();
      expect(managedModelRefusal(db, launch(role, "claude-code", "outside"))).toBe("team_model_not_allowed");
      expect(managedModelRefusal(db, launch(role, "codex", "allowed-worker"))).toBe("team_model_not_allowed");
      expect(managedModelRefusal(db, launch(role, "claude-code"))).toBe("team_model_not_allowed");
    }
    expect(rosterModelRefusal(db, "project", [{ client: "codex", model: "allowed-worker" }])).toContain("allowed subagent models");
  });
  it("treats an explicitly empty list as no subagents, not unrestricted defaults", () => {
    saveTeamModelSettings(db, "project", { ...policy, allowedSubagents: [] });
    expect(managedModelRefusal(db, launch("lead", "codex", "chosen-lead"))).toBeNull();
    expect(managedModelRefusal(db, launch("implementer", "claude-code", "allowed-worker"))).toBe("team_model_not_allowed");
  });
  it.each(["", "--override", "with whitespace", "bad\nmodel"])("rejects invalid model %j without changing saved settings", model => {
    expect(() => saveTeamModelSettings(db, "project", { ...policy, lead: { client: "codex", model } })).toThrow();
    expect(readTeamModelSettings(db, "project").configured).toBe(false);
  });
  it("does not replace settings while a native launch is admitted but not registered", () => {
    db.prepare("INSERT INTO events (type, payload) VALUES ('team.control', ?)").run(JSON.stringify({
      runId: "run", attemptId: "launch-1", action: "attempt.launch-intent", payload: { state: "admitted" },
    }));
    expect(() => saveTeamModelSettings(db, "project", policy)).toThrow(/active attempts/);
    expect(readTeamModelSettings(db, "project").configured).toBe(false);
  });
  it("keeps the requested launch model separate from unobserved provider evidence", () => {
    db.prepare("INSERT INTO events (type, payload) VALUES ('managed.attempt.receipt', ?)").run(JSON.stringify({
      rigId: "project", nodeId: "lead", runId: "run", requestedModel: "chosen-lead", receipt: { attemptId: "unregistered", client: "codex" },
    }));
    expect(readTeamModelSettings(db, "project").launches).toMatchObject([
      { requestedModel: "chosen-lead", observedModel: null, state: "unregistered" },
    ]);
  });
});
