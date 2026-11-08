import type Database from "better-sqlite3";
import { object, text, TeamContractError, type TeamAttempt } from "../contracts/team-control.js";
import type { WorkerLaunchInput } from "../adapters/worker-launch.js";
import type { TeamClient } from "./team-setup.js";
import { SessionRegistry } from "./session-registry.js";

export interface TeamModelChoice { client: TeamClient; model: string }
export interface TeamModelSettings {
  teamId: string; kind: "project" | "test"; configured: boolean;
  lead: { client: TeamClient; model: string | null };
  allowedSubagents: TeamModelChoice[] | null;
  launches: Array<{ attemptId: string; runId: string; client: TeamClient; role: string;
    requestedModel: string | null; observedModel: string | null; state: TeamAttempt["state"] | "unregistered"; createdAt: string }>;
}
export class TeamModelError extends Error {
  constructor(readonly code: string, message: string, readonly status: 404 | 409 = 409) { super(message); }
}

/** Model IDs are owner input and later become single native CLI arguments. */
export function modelId(value: unknown): string {
  const id = text(value, "model", 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(id)) throw new TeamContractError("model");
  return id;
}
function choice(value: unknown): TeamModelChoice {
  const v = object(value, "modelChoice");
  if (Object.keys(v).some(key => key !== "client" && key !== "model")
    || (v.client !== "claude-code" && v.client !== "codex")) throw new TeamContractError("modelChoice");
  return { client: v.client, model: modelId(v.model) };
}
export function teamModelAllowlist(db: Database.Database, rigId: string): TeamModelChoice[] | null {
  const row = db.prepare("SELECT team_model_allowlist AS value FROM rigs WHERE id = ?").get(rigId) as { value: string | null } | undefined;
  if (!row) throw new TeamModelError("team_not_found", "The project no longer exists.", 404);
  return row.value === null ? null : JSON.parse(row.value) as TeamModelChoice[];
}

export function rosterModelRefusal(db: Database.Database, rigId: string,
  seats: readonly { client: string; model?: string }[]): string | null {
  const allowed = teamModelAllowlist(db, rigId);
  if (allowed === null) return null;
  const invalid = seats.find(seat => !allowed.some(item => item.client === seat.client && item.model === seat.model));
  return invalid ? `Model ${invalid.client}/${invalid.model ?? "(unspecified)"} is outside this project's allowed subagent models. Revise the roster or ask the owner to update project model settings.` : null;
}

export function readTeamModelSettings(db: Database.Database, rigId: string): TeamModelSettings {
  const allowedSubagents = teamModelAllowlist(db, rigId);
  const rig = db.prepare("SELECT team_kind AS kind FROM rigs WHERE id = ?").get(rigId) as { kind: TeamModelSettings["kind"] };
  const lead = db.prepare("SELECT runtime AS client, model FROM nodes WHERE rig_id = ? AND role = 'lead' AND retired_at IS NULL")
    .get(rigId) as TeamModelSettings["lead"] | undefined;
  if (!lead) throw new TeamModelError("team_lead_required", "This project has no lead seat to configure.");
  const launches = db.prepare(`SELECT json_extract(e.payload, '$.receipt.attemptId') AS attemptId,
      json_extract(e.payload, '$.runId') AS runId, json_extract(e.payload, '$.receipt.client') AS client,
      COALESCE(a.role, n.role, 'lead') AS role, json_extract(e.payload, '$.requestedModel') AS requestedModel,
      json_extract(t.usage_json, '$.model') AS observedModel, COALESCE(a.state, 'unregistered') AS state,
      e.created_at AS createdAt
    FROM events e LEFT JOIN team_attempts a ON a.id = json_extract(e.payload, '$.receipt.attemptId')
      LEFT JOIN attempt_telemetry t ON t.attempt_id = a.id LEFT JOIN nodes n ON n.id = json_extract(e.payload, '$.nodeId')
    WHERE e.type = 'managed.attempt.receipt' AND json_extract(e.payload, '$.rigId') = ?
    ORDER BY e.seq DESC LIMIT 20`).all(rigId) as TeamModelSettings["launches"];
  return { teamId: rigId, kind: rig.kind, configured: allowedSubagents !== null, lead, allowedSubagents, launches };
}

export function saveTeamModelSettings(db: Database.Database, rigId: string, value: unknown): TeamModelSettings {
  const body = object(value, "projectSettings");
  if (Object.keys(body).some(key => !["lead", "allowedSubagents", "kind"].includes(key))
    || (body.kind !== "project" && body.kind !== "test") || !Array.isArray(body.allowedSubagents)
    || body.allowedSubagents.length > 32) throw new TeamContractError("projectSettings");
  const lead = choice(body.lead), allowed = body.allowedSubagents.map(choice);
  if (new Set(allowed.map(item => item.client + "/" + item.model)).size !== allowed.length) throw new TeamContractError("allowedSubagents");
  return db.transaction(() => {
    const current = readTeamModelSettings(db, rigId);
    const live = db.prepare(`SELECT 1 FROM team_attempts a JOIN team_runs r ON r.id = a.run_id
      WHERE r.rig_id = ? AND a.state <> 'stopped' LIMIT 1`).get(rigId);
    const pending = db.prepare(`SELECT 1 FROM events e WHERE e.seq IN (
      SELECT MAX(e.seq) FROM events e JOIN team_runs r ON r.id = json_extract(e.payload, '$.runId')
      WHERE r.rig_id = ? AND e.type = 'team.control' AND json_extract(e.payload, '$.action') = 'attempt.launch-intent'
      GROUP BY json_extract(e.payload, '$.attemptId')) AND json_extract(e.payload, '$.payload.state') = 'admitted' LIMIT 1`).get(rigId);
    if (live || pending) throw new TeamModelError("team_models_busy", "Wait for this project's active attempts to stop before changing model settings.");
    db.prepare("UPDATE rigs SET team_model_allowlist = ?, team_kind = ? WHERE id = ?").run(JSON.stringify(allowed), body.kind, rigId);
    db.prepare("UPDATE nodes SET runtime = ?, model = ? WHERE rig_id = ? AND role = 'lead' AND retired_at IS NULL")
      .run(lead.client, lead.model, rigId);
    if (current.lead.client !== lead.client || current.lead.model !== lead.model) {
      const sessions = db.prepare("SELECT s.id FROM sessions s JOIN nodes n ON n.id = s.node_id WHERE n.rig_id = ? AND n.role = 'lead'")
        .all(rigId) as Array<{ id: string }>;
      const registry = new SessionRegistry(db);
      for (const session of sessions) registry.clearResumeToken(session.id);
    }
    return readTeamModelSettings(db, rigId);
  })();
}

/** The final launch boundary re-reads policy; UI and prompt claims are not authority. */
export function managedModelRefusal(db: Database.Database, input: WorkerLaunchInput): string | null {
  const { runId, assignment } = input.attempt.context;
  const run = db.prepare("SELECT rig_id AS rigId FROM team_runs WHERE id = ?").get(runId) as { rigId: string } | undefined;
  if (!run) return "team_model_run_missing";
  const allowed = teamModelAllowlist(db, run.rigId);
  if (allowed === null) return null;
  if (assignment.role !== "lead") return allowed.some(item => item.client === input.client && item.model === input.model)
    ? null : "team_model_not_allowed";
  const lead = db.prepare("SELECT runtime AS client, model FROM nodes WHERE rig_id = ? AND role = 'lead' AND retired_at IS NULL")
    .get(run.rigId) as { client: string; model: string | null } | undefined;
  return lead?.client === input.client && lead.model !== null && lead.model === input.model ? null : "team_lead_model_mismatch";
}
