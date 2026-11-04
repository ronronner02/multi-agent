import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { TEAM_CONTROL_VERSION, jsonValue, type ControlRequest, type JsonValue } from "../contracts/team-control.js";
import type { PlanGovernance } from "./plan-governance.js";
import type { SessionRegistry } from "./session-registry.js";
import type { NativeAttemptIdentity } from "../contracts/team-control.js";

/**
 * MVP — the completion path's observation half.
 *
 * A direct launch records a receipt naming the client process the pane runs under, but nothing
 * wrote that attempt into `team_attempts` and nothing ever closed it. A task could therefore
 * never be observed to finish, and the owner's outcome command — which requires a stopped
 * attempt with an identity — could never succeed outside the demos.
 *
 * This owner closes that gap with the two writes the plan already defines: the receipt admits
 * the attempt through `recordAttempt`, and the end of the process the receipt named is recorded
 * through `recordUsage`. Nothing here decides an outcome: R18 says a completed attempt never
 * accepts a task, so the owner's action still supplies the evidence and the decision. Both
 * writes are idempotent, so a sweep that runs twice records nothing twice.
 */

/** How often receipts are registered and identities re-observed, on the daemon's 1 Hz cadence. */
export const ATTEMPT_SWEEP_INTERVAL_MS = 1_000;

export interface AttemptCompletionDependencies {
  db: Database.Database;
  governance: PlanGovernance;
  /**
   * The run's current binding, read the way every control command reads it. A plan that moved
   * under the attempt invalidates the run instead of being admitted against a stale approval.
   */
  currentBinding: (runId: string) => unknown;
  /** The seat's session status, which the dispatcher reads to decide whether to start a client. */
  sessions: Pick<SessionRegistry, "findResumeContextByName" | "updateStartupStatus">;
  /** Injectable for the tests; production leaves the default. */
  alive?: (identity: { processId: number; processStart: string }) => boolean;
  intervalMs?: number;
  log?: (message: string) => void;
}

export interface AttemptCompletion {
  /** Register every receipt whose attempt is not recorded, then stop the ones that ended. */
  sweep(): void;
  start(): void;
  stop(): void;
}

const unavailable = { value: null, reason: "Native usage has not been observed" };

/**
 * Whether the process a receipt named is still the one running.
 *
 * The start time is the identity: a recycled pid starts at a different clock tick, so it is a
 * different process. A zombie has already exited even though `/proc` still lists it. A `/proc`
 * that cannot be read at all is not evidence of an end — only a missing process is.
 */
export function processIdentityAlive(identity: { processId: number; processStart: string }): boolean {
  try {
    const raw = readFileSync("/proc/" + identity.processId + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[0] !== "Z" && fields[0] !== "X" && fields[19] === identity.processStart;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

interface ReceiptRow { seq: number; payload: string }

export function composeAttemptCompletion(dependencies: AttemptCompletionDependencies): AttemptCompletion {
  const { db, governance, currentBinding, sessions } = dependencies;
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  const intervalMs = dependencies.intervalMs ?? ATTEMPT_SWEEP_INTERVAL_MS;
  const alive = dependencies.alive ?? processIdentityAlive;
  let timer: ReturnType<typeof setInterval> | null = null;
  /**
   * The highest receipt `seq` this process has already read.
   *
   * Receipts are only ever appended, and `register` is idempotent, so the first sweep after a
   * restart reads the log once from the beginning and every later tick reads only what is new.
   * Without this, the cost of a tick would grow with every run the daemon has ever hosted.
   */
  let processedSeq = 0;

  /**
   * The task a seat is working, resolved from the run's own rows.
   *
   * The receipt names the seat, not the task: the launch composition decided the task before
   * the client started, and the queue destination is that decision made durable. A seat with
   * no single live task has nothing to admit, so the attempt stays unrecorded and the owner
   * action refuses it rather than attaching the receipt to a guess.
   */
  const taskForSeat = (runId: string, sessionName: string) => {
    const rows = db.prepare(`
      SELECT a.qitem_id AS qitemId, json_extract(a.assignment_json, '$.role') AS role
      FROM team_queue_authority a
      JOIN queue_items q ON q.qitem_id = a.qitem_id
      JOIN team_runs r ON r.id = a.run_id
      WHERE a.run_id = ? AND q.destination_session = ? AND q.state IN ('pending', 'in-progress')
        AND r.state = 'approved'
      LIMIT 2`).all(runId, sessionName) as Array<{ qitemId: string; role: string }>;
    return rows.length === 1 ? rows[0]! : null;
  };

  /** Admit the attempt a launch receipt names, unless it is already recorded. */
  const register = (row: ReceiptRow): void => {
    const { sessionName, receipt } = JSON.parse(row.payload) as {
      sessionName?: string; receipt?: { attemptId: string; runId: string; client: string; identity: NativeAttemptIdentity };
    };
    if (!sessionName || !receipt) return;
    // A resume re-enters the attempt it recorded, so its row already exists and keeps its own
    // history. Only the first observation of a native generation admits a new row.
    if (governance.getAttempt(receipt.attemptId)) return;
    const task = taskForSeat(receipt.runId, sessionName);
    if (!task) {
      log(`team completion: no single live task on ${sessionName} for run=${receipt.runId}; attempt ${receipt.attemptId} is unrecorded`);
      return;
    }
    const request: ControlRequest<unknown> = {
      protocolVersion: TEAM_CONTROL_VERSION, runId: receipt.runId, actionId: receipt.attemptId,
      expectedEntityVersion: governance.getRun(receipt.runId).entityVersion,
      // One key per attempt: a repeated receipt replays the same admission instead of racing a
      // second row for the same native generation.
      idempotencyKey: "attempt-receipt:" + receipt.attemptId,
      payload: {
        qitemId: task.qitemId, role: task.role, provider: receipt.client === "codex" ? "codex" : "claude",
        identity: receipt.identity as unknown as JsonValue, state: "running", unknownReason: null,
        usage: { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable },
      },
    };
    const recorded = governance.recordAttempt(request, currentBinding(receipt.runId));
    if (recorded.status !== "observed" && !recorded.replayed) {
      log(`team completion: attempt ${receipt.attemptId} was not registered: ${recorded.reason ?? recorded.status}`);
    }
  };

  /**
   * Record the end of every running attempt whose process is gone.
   *
   * The seat the attempt ran on is put back to the state a start leaves a never-launched seat
   * in. `startup_status: ready` is what tells the dispatcher "this seat already has an agent",
   * and it is true only while one is running: leaving it set would make the rework dispatch and
   * the reviewer's second round see a live agent and start nothing, and the task would wait
   * forever for work nobody was doing. The session's `status` is left alone — it is the
   * presence record of the terminal, not of the agent.
   */
  const close = (): void => {
    const rows = db.prepare("SELECT id FROM team_attempts WHERE state = 'running' AND identity_json IS NOT NULL")
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      try {
        const attempt = governance.getAttempt(row.id);
        if (!attempt?.identity || alive(attempt.identity)) continue;
        const request: ControlRequest<unknown> = {
          protocolVersion: TEAM_CONTROL_VERSION, runId: attempt.runId, actionId: attempt.id,
          expectedEntityVersion: governance.getRun(attempt.runId).entityVersion,
          idempotencyKey: `attempt-stop:${attempt.id}:${attempt.entityVersion}`,
          // The end of the process is the observation; no usage figure is claimed for it.
          payload: { expectedAttemptVersion: attempt.entityVersion, state: "stopped", usage: jsonValue(attempt.usage) },
        };
        const recorded = governance.recordUsage(request);
        if (recorded.status !== "observed" && !recorded.replayed) {
          log(`team completion: attempt ${attempt.id} stop was not recorded: ${recorded.reason ?? recorded.status}`);
          continue;
        }
        releaseSeat(attempt.qitemId);
      } catch (error) {
        // A run or attempt that moved under the sweep is re-read on the next tick; one failed
        // observation must not stop the others.
        log(`team completion: sweep skipped ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  /** Return the seat that ran a stopped attempt to "never launched", so a dispatch may start it. */
  const releaseSeat = (qitemId: string | null): void => {
    const seat = qitemId === null ? null : governance.taskSeat(qitemId);
    const context = seat === null ? null : sessions.findResumeContextByName(seat);
    if (!context) return;
    sessions.updateStartupStatus(context.sessionId, "pending");
  };

  const sweep = (): void => {
    const receipts = db.prepare("SELECT seq, payload FROM events WHERE type = 'managed.attempt.receipt' AND seq > ? ORDER BY seq")
      .all(processedSeq) as ReceiptRow[];
    for (const row of receipts) {
      // Advance before registering: a receipt that cannot be registered now is not retried, and
      // the owner action refuses its task with a named reason rather than leaving a tick to
      // repeat the same refusal every second for the life of the daemon.
      processedSeq = row.seq;
      try { register(row); } catch (error) {
        log(`team completion: receipt was not registered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    close();
  };

  return {
    sweep,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try { sweep(); } catch (error) {
          log(`team completion: sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, intervalMs);
      // The daemon's lifetime decides how long this runs; a tick must never be the reason a
      // process stays alive after its database closed.
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
