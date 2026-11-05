import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson, parseTeamEvent, type TeamRun } from "../contracts/team-control.js";
import type { EventBus, NotifyRegister } from "./event-bus.js";

type Run = Pick<TeamRun, "id" | "rigId" | "bindingDigest" | "entityVersion" | "state" | "stateReason">;
interface WakeState {
  pending: Record<string, string[]>;
  activations: number[];
  cycles: Record<string, { progress: number; count: number }>;
  grant: number; cycleBlock: number | null;
}
const isWakeBlocker = (reason: string | null) => reason === "lead-wake:hourly" || reason === "lead-wake:cycles";

/** The event log owns wake snapshots; queue rows remain the trigger source of truth. */
export class LeadWakePolicy {
  constructor(private readonly db: Database.Database, private readonly events: EventBus) {}

  private read(runId: string): WakeState {
    const row = this.db.prepare(`SELECT payload FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.action') = 'lead.wake-state'
      ORDER BY seq DESC LIMIT 1`).get(runId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload).payload as WakeState : { pending: {}, activations: [], cycles: {}, grant: 0, cycleBlock: null };
  }

  check(run: Run, qitemId: string | null, now: string) {
    const state = this.read(run.id);
    state.activations = state.activations.filter(at => at > Date.parse(now) - 3_600_000);
    const grant = this.db.prepare(`SELECT rowid AS sequence FROM team_approvals WHERE run_id = ? AND action = 'limit-increase'
      AND state = 'approved' AND decision_actor IS NOT NULL AND binding_digest = ? AND target_digest = ?
      AND expires_at > ? AND json_extract(payload_json, '$.guard') = 'lead-wake:hourly'
      ORDER BY rowid DESC LIMIT 1`).get(run.id, run.bindingDigest, run.bindingDigest, now) as { sequence: number } | undefined;
    if (grant && grant.sequence > state.grant) { state.activations = []; state.grant = grant.sequence; }
    const { progress } = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS progress FROM events
      WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ?
      AND json_extract(payload, '$.action') IN ('approval.decided', 'task.outcome', 'plan.approved', 'chat.message')
      AND json_extract(payload, '$.payload.observedBy') IS NOT NULL`).get(run.id) as { progress: number };
    const task = qitemId ? this.db.prepare(`SELECT json_extract(a.assignment_json, '$.taskId') AS id, q.destination_session AS recipient
      FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id WHERE a.qitem_id = ? AND a.run_id = ?`)
      .get(qitemId, run.id) as { id: string; recipient: string } | undefined : undefined;
    if (task) {
      const ids = Object.hasOwn(state.pending, task.recipient) ? state.pending[task.recipient] ?? [] : [];
      state.pending = { ...state.pending, [task.recipient]: [...new Set([...ids, qitemId!])] };
    }
    const taskId = task?.id ?? null, cycle = taskId ? state.cycles[taskId] : undefined;
    if (state.cycleBlock !== progress) state.cycleBlock = null;
    const reason = state.activations.length >= 12 ? "lead-wake:hourly"
      : state.cycleBlock === progress || (cycle?.progress === progress && cycle.count >= 2) ? "lead-wake:cycles" : null;
    if (reason === "lead-wake:cycles") state.cycleBlock = progress;
    return { state, progress, reason, taskId };
  }

  pause(run: Run, reason: string, now: string): void {
    if (run.state !== "approved" && !(run.state === "blocked" && isWakeBlocker(run.stateReason))) return;
    run.state = "blocked"; run.stateReason = reason;
    if (this.db.prepare(`SELECT id FROM team_approvals WHERE run_id = ? AND action = 'limit-increase'
      AND state = 'pending' AND json_extract(payload_json, '$.guard') = ?`).get(run.id, reason)) return;
    const payload = canonicalJson({ guard: reason });
    this.db.prepare(`INSERT INTO team_approvals (id, run_id, kind, action, payload_json, payload_digest,
      target_digest, binding_digest, state, expires_at, created_at, updated_at)
      VALUES (?, ?, 'orchestrator', 'limit-increase', ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(randomUUID(), run.id, payload, `sha256:${createHash("sha256").update(payload).digest("hex")}`,
        run.bindingDigest, run.bindingDigest, new Date(Date.parse(now) + 3_600_000).toISOString(), now, now);
  }

  save(run: Run, state: WakeState, register: NotifyRegister): void {
    register(this.events.persistWithinTransaction(parseTeamEvent({ type: "team.control", protocolVersion: "1.0",
      eventId: randomUUID(), rigId: run.rigId, runId: run.id, taskId: null, attemptId: null,
      entityId: run.id, entityVersion: run.entityVersion, action: "lead.wake-state", payload: state })));
  }

  record(run: Run, qitemId: string | null, now: string, check: ReturnType<LeadWakePolicy["check"]>, register: NotifyRegister): void {
    check.state.activations.push(Date.parse(now));
    if (check.taskId) {
      const previous = check.state.cycles[check.taskId];
      check.state.cycles = { ...check.state.cycles, [check.taskId]: { progress: check.progress, count: previous?.progress === check.progress ? previous.count + 1 : 1 } };
    }
    if (qitemId) {
      for (const [recipient, ids] of Object.entries(check.state.pending)) {
        check.state.pending[recipient] = ids.filter(id => id !== qitemId);
        if (!check.state.pending[recipient].length) delete check.state.pending[recipient];
      }
    }
    this.save(run, check.state, register);
  }

  resume(run: Run): void {
    if (run.state === "blocked" && isWakeBlocker(run.stateReason)) { run.state = "approved"; run.stateReason = null; }
  }

  retain(qitemId: string, recipient: string): string | null {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_queue_authority'").get()) return null;
    const task = this.db.prepare(`SELECT a.run_id AS runId, q.source_session AS source, q.destination_session AS destination,
      json_extract(a.assignment_json, '$.role') AS role FROM team_queue_authority a
      JOIN queue_items q ON q.qitem_id = a.qitem_id WHERE a.qitem_id = ?`).get(qitemId) as
      { runId: string; source: string; destination: string; role: string } | undefined;
    if (!task) return null;
    if (task.destination !== recipient || task.source === recipient) return "lead-wake:suppressed";
    return this.events.withNotifyEnvelope(register => {
      const run = this.db.prepare(`SELECT id, rig_id AS rigId, binding_digest AS bindingDigest, entity_version AS entityVersion,
        state, state_reason AS stateReason FROM team_runs WHERE id = ?`).get(task.runId) as Run;
      const now = new Date().toISOString(), check = this.check(run, task.role === "lead" ? qitemId : null, now);
      const ids = Object.hasOwn(check.state.pending, recipient) ? check.state.pending[recipient] ?? [] : [];
      check.state.pending = { ...check.state.pending, [recipient]: [...new Set([...ids, qitemId])] };
      if (task.role === "lead" && check.reason) this.pause(run, check.reason, now);
      run.entityVersion += 1;
      this.db.prepare("UPDATE team_runs SET state = ?, state_reason = ?, entity_version = ?, updated_at = ? WHERE id = ?")
        .run(run.state, run.stateReason, run.entityVersion, now, run.id);
      this.save(run, check.state, register);
      return check.reason ?? "lead-wake:mailbox-pending";
    });
  }
}
