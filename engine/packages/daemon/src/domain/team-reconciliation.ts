import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonicalJson, type JsonObject, type TeamRun } from "../contracts/team-control.js";
import type { EventBus } from "./event-bus.js";
import type { PlanGovernance } from "./plan-governance.js";
import type { ManagedCancellationControl, ManagedRunObservation, ManagedSessionReceipt } from "./runtime-adapter.js";
import { stopManagedSession } from "./rig-teardown.js";

export const RAW_LOG_LIMIT = 64 * 1024 * 1024;
export const ARTIFACT_LIMIT = 256 * 1024 * 1024;
const NO_PROGRESS_MS = 600_000;
interface Activity {
  lastProgressAt: number;
  tool: { attemptId: string; deadline: number; evidenceRef: string } | null;
  rawLogBytes: number;
  artifactBytes: number;
  omittedLogBytes: number;
}
export interface TeamStopResult { stopped: string[]; unresolved: string[]; }

/** Reconciles the existing run/attempt ledger; timers only wake durable decisions. */
export class TeamReconciliation {
  private readonly pending = new Map<string, Promise<TeamStopResult>>();
  private monitor?: ReturnType<typeof setInterval>;
  constructor(private readonly deps: {
    db: Database.Database; events: EventBus; governance: PlanGovernance;
    control: ManagedCancellationControl; now?: () => number;
  }) {}
  private now() { return (this.deps.now ?? Date.now)(); }
  private request(runId: string, actionId: string, payload: unknown) {
    return { protocolVersion: "1.0", runId, actionId, payload, idempotencyKey: randomUUID(),
      expectedEntityVersion: this.deps.governance.getRun(runId).entityVersion };
  }
  private latest<T>(runId: string, action: string): T | undefined {
    const row = this.deps.db.prepare(`SELECT payload FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.action') = ? ORDER BY seq DESC LIMIT 1`)
      .get(runId, action) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload).payload as T : undefined;
  }
  private event(run: TeamRun, action: string, payload: JsonObject) {
    return { type: "team.control" as const, protocolVersion: "1.0", eventId: randomUUID(),
      rigId: run.rigId, runId: run.id, taskId: null, attemptId: null, entityId: run.id,
      entityVersion: run.entityVersion, action, payload };
  }
  private activity(run: TeamRun): Activity {
    const activity = this.latest<Activity>(run.id, "run.activity") ?? { lastProgressAt: Date.parse(run.createdAt),
      tool: null, rawLogBytes: 0, artifactBytes: 0, omittedLogBytes: 0 };
    const starts = this.liveAttempts(run.id).map(attempt => Date.parse(attempt.startedAt));
    const progress = this.deps.db.prepare(`SELECT MAX(strftime('%Y-%m-%dT%H:%M:%fZ', e.created_at)) AS at
      FROM events e JOIN team_queue_authority t ON t.qitem_id = json_extract(e.payload, '$.qitemId')
      WHERE t.run_id = ? AND (e.type IN ('queue.claimed', 'queue.unclaimed', 'queue.handed_off')
        OR e.type = 'queue.updated' AND json_extract(e.payload, '$.fromState') <> json_extract(e.payload, '$.toState'))`)
      .get(run.id) as { at: string | null };
    // Use committed execution/progress times, not approval wait or the controller's poll time.
    activity.lastProgressAt = Math.max(activity.lastProgressAt, starts.length ? Math.min(...starts) : 0,
      progress.at ? Date.parse(progress.at) : 0);
    return activity;
  }
  private liveAttempts(runId: string): { id: string; startedAt: string }[] {
    return this.deps.db.prepare(`SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS startedAt
      FROM team_attempts WHERE run_id = ? AND state <> 'stopped'
      UNION SELECT json_extract(payload, '$.attemptId') AS id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS startedAt
      FROM events WHERE seq IN (
        SELECT MAX(seq) FROM events WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ?
        AND json_extract(payload, '$.action') = 'attempt.launch-intent' GROUP BY json_extract(payload, '$.attemptId'))
      AND json_extract(payload, '$.payload.state') = 'admitted'`).all(runId, runId) as { id: string; startedAt: string }[];
  }
  private attemptIds(runId: string): string[] {
    return [...new Set(this.liveAttempts(runId).map(row => row.id))];
  }
  private session(runId: string, attemptId: string): ManagedSessionReceipt | undefined {
    const row = this.deps.db.prepare(`SELECT payload FROM events WHERE type = 'managed.attempt.receipt'
      AND json_extract(payload, '$.receipt.runId') = ? AND json_extract(payload, '$.receipt.attemptId') = ?
      ORDER BY seq DESC LIMIT 1`).get(runId, attemptId) as { payload: string } | undefined;
    const receipt = row ? JSON.parse(row.payload).receipt as ManagedSessionReceipt : undefined;
    const attempt = this.deps.governance.getAttempt(attemptId);
    return receipt && attempt?.runId === runId && attempt.state !== "stopped" && attempt.identity
      && canonicalJson(attempt.identity) === canonicalJson(receipt.identity) ? receipt : undefined;
  }

  checkpoint(runId: string, observation: ManagedRunObservation = {}): TeamRun {
    const { governance, events } = this.deps, run = governance.getRun(runId);
    const activity = this.activity(run), previous = this.latest<Activity>(runId, "run.activity");
    const now = this.now(), elapsed = run.accountedAt === null ? 0 : Math.max(0, now - Date.parse(run.accountedAt));
    const remaining = Math.max(0, run.binding.limits.maxActiveMs - run.activeMs - elapsed);
    if (observation.progress && observation.progress !== "heartbeat" && observation.progress !== "status") activity.lastProgressAt = now;
    if (observation.tool !== undefined) {
      const session = observation.tool ? this.session(runId, observation.tool.attemptId) : undefined;
      activity.tool = observation.tool && session && Number.isSafeInteger(observation.tool.deadline)
        && observation.tool.deadline > now && observation.tool.evidenceRef
        ? { ...observation.tool, deadline: Math.min(observation.tool.deadline, session.deadline, now + remaining) } : null;
    }
    for (const key of ["rawLogBytes", "artifactBytes", "omittedLogBytes"] as const) {
      const bytes = observation[key];
      if (bytes !== undefined) {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid cumulative storage observation");
        activity[key] = Math.max(activity[key], bytes);
      }
    }
    if (!previous || canonicalJson(previous) !== canonicalJson(activity)) events.emit(this.event(run, "run.activity", { ...activity }));
    const live = this.attemptIds(runId);
    const tool = activity.tool && this.session(runId, activity.tool.attemptId) ? activity.tool : null;
    const reason = remaining === 0 ? "run_budget_exhausted"
      : activity.rawLogBytes >= RAW_LOG_LIMIT || activity.artifactBytes >= ARTIFACT_LIMIT ? "storage_capacity_exhausted"
      : live.length && tool && now >= tool.deadline ? "tool_deadline_exhausted"
      : live.length && !tool && now - activity.lastProgressAt >= NO_PROGRESS_MS ? "no_progress" : null;
    if (reason) this.scheduleStop(runId, reason);
    return governance.getRun(runId);
  }

  /** Reserve retained bytes before writing; a failed write conservatively keeps its reservation. */
  retainLog(runId: string, body: string): string {
    const activity = this.activity(this.deps.governance.getRun(runId)), bytes = Buffer.from(body);
    let retained = Math.min(bytes.length, Math.max(0, RAW_LOG_LIMIT - activity.rawLogBytes));
    while (retained > 0 && (bytes[retained]! & 0xc0) === 0x80) retained--;
    this.checkpoint(runId, { rawLogBytes: activity.rawLogBytes + retained,
      omittedLogBytes: activity.omittedLogBytes + bytes.length - retained });
    if (retained < bytes.length) this.scheduleStop(runId, "storage_capacity_exhausted");
    return bytes.subarray(0, retained).toString("utf8");
  }

  scheduleStop(runId: string, reason = "cancel_requested"): void {
    void this.stopRun(runId, reason).catch(() => console.error("Managed cancellation evidence is unresolved"));
  }

  stopRun(runId: string, reason = "cancel_requested"): Promise<TeamStopResult> {
    const current = this.pending.get(runId);
    if (current) return current;
    const { governance, db, events, control } = this.deps;
    let run = governance.getRun(runId);
    const last = this.latest<TeamStopResult>(runId, "run.stop-observed"), live = this.attemptIds(runId);
    if (!live.length && last?.unresolved.length === 0 && run.state !== "approved" && run.state !== "pending") {
      return Promise.resolve({ stopped: [], unresolved: [] });
    }
    const prior = last?.unresolved.length === 0 ? undefined : this.latest<{ requestedAt: number }>(runId, "run.stop-requested");
    const requestedAt = prior?.requestedAt ?? this.now();
    if (prior && last && this.now() >= requestedAt + 15_000
      && canonicalJson([...last.unresolved].sort()) === canonicalJson([...live].sort())) {
      return Promise.resolve({ stopped: [], unresolved: live });
    }
    if (!prior && run.accountedAt !== null && Date.parse(run.accountedAt) !== this.now()) {
      governance.reconcileBinding(this.request(runId, runId, run.binding));
      run = governance.getRun(runId);
    }
    if (!prior) events.withNotifyEnvelope(register => {
      if (run.state !== "cancel_requested" && run.state !== "invalidated") {
        const updated = db.prepare(`UPDATE team_runs SET state = 'blocked', state_reason = ?, entity_version = entity_version + 1, updated_at = ?
          WHERE id = ? AND entity_version = ?`).run(reason, new Date(this.now()).toISOString(), runId, run.entityVersion);
        if (updated.changes !== 1) throw new Error("Run entity version conflict");
      }
      register(events.persistWithinTransaction(this.event(governance.getRun(runId), "run.stop-requested",
        { requestedAt, reason, gracefulAvailable: !!control.requestStop })));
    });
    const operation = (async () => {
      const result: TeamStopResult = { stopped: [], unresolved: [] };
      await Promise.all(live.map(async attemptId => {
        try {
          let receipt = this.session(runId, attemptId);
          const stopped = await stopManagedSession(() => (receipt = this.session(runId, attemptId)), {
            ...(control.requestStop ? { requestStop: session => control.requestStop!(session) } : {}),
            quiesce: async session => {
              const currentSession = this.session(runId, attemptId);
              if (!currentSession || canonicalJson(currentSession) !== canonicalJson(session)) return false;
              return control.quiesce(session);
            },
          }, requestedAt);
          const attempt = governance.getAttempt(attemptId), intent = governance.getNativeLaunchIntent(runId, attemptId);
          if (!this.attemptIds(runId).includes(attemptId) && (attempt?.state === "stopped" || intent?.state === "not_started")) {
            result.stopped.push(attemptId);
          } else if (stopped && receipt && attempt?.identity && canonicalJson(attempt.identity) === canonicalJson(receipt.identity)) {
            const observed = governance.recordUsage(this.request(runId, attemptId,
              { expectedAttemptVersion: attempt.entityVersion, state: "stopped", usage: attempt.usage }));
            if (observed.status !== "observed") throw new Error("Managed stop observation was not recorded");
            result.stopped.push(attemptId);
          } else result.unresolved.push(attemptId);
        } catch { result.unresolved.push(attemptId); }
      }));
      result.stopped.sort(); result.unresolved.sort();
      events.emit(this.event(governance.getRun(runId), "run.stop-observed", { ...result, requestedAt }));
      return result;
    })();
    this.pending.set(runId, operation);
    void operation.finally(() => this.pending.delete(runId)).catch(() => {});
    return operation;
  }

  async stopRig(rigId: string): Promise<TeamStopResult | null> {
    const rows = this.deps.db.prepare("SELECT id FROM team_runs WHERE rig_id = ?").all(rigId) as { id: string }[];
    if (!rows.length) return null;
    const results = await Promise.all(rows.map(row => this.stopRun(row.id, "rig_teardown")));
    return { stopped: results.flatMap(result => result.stopped), unresolved: results.flatMap(result => result.unresolved) };
  }
  start(): void {
    if (this.monitor) return;
    const poll = () => {
      try {
        const rows = this.deps.db.prepare("SELECT id, state FROM team_runs").all() as { id: string; state: string }[];
        for (const row of rows) {
          const live = this.attemptIds(row.id), requested = this.latest<{ requestedAt: number }>(row.id, "run.stop-requested");
          const observed = this.latest<TeamStopResult>(row.id, "run.stop-observed");
          if (live.length && row.state === "cancel_requested" || requested && observed?.unresolved.length !== 0) this.scheduleStop(row.id);
          else if (live.length) this.checkpoint(row.id);
        }
      } catch { console.error("Managed run reconciliation remains unresolved"); }
    };
    poll();
    this.monitor = setInterval(poll, 1_000);
    this.monitor.unref();
  }
  async shutdown(): Promise<void> {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    const rows = this.deps.db.prepare("SELECT id FROM team_runs").all() as { id: string }[];
    const results = await Promise.all(rows.map(row => this.stopRun(row.id, "daemon_shutdown")));
    if (results.some(result => result.unresolved.length)) throw new Error("Managed termination remains unresolved");
  }
}
