import type Database from "better-sqlite3";
import type { TaskDispatch } from "./task-dispatch.js";

/**
 * MVP — a freed session slot starts the run's next task.
 *
 * The first live run found the gap this closes: a task admitted while the run was at its
 * `maxSessions` limit was refused once by the launch and never tried again. Nothing dispatched
 * a pending task later, so a run at its limit could not make progress after its first tasks
 * ended — and with two seats and a limit of two, that is every run with a review or a rework.
 *
 * This is internal scheduling over the durable queue, not an owner verb: the completion sweep
 * calls it after it records an attempt stopped and releases the seat, and it asks the same
 * `TaskDispatch` a start and a completion already use. There is no new contract, no new event
 * and no second queue.
 *
 * It refuses a run that is not `approved`. That is the same gate every command that admits
 * work already reads, so a canceled, invalidated or suspended run dispatches nothing — the
 * closure cancellation relies on is the one it keeps.
 */
export interface PendingDispatchDependencies {
  db: Database.Database;
  dispatch: () => TaskDispatch | undefined;
  /** How many of the run's attempts are live now, read the way governance counts them. */
  liveSessions: (runId: string) => number;
  /** The run's live-session limit, from its own binding. */
  maxSessions: (runId: string) => number;
  log?: (message: string) => void;
}

/**
 * The run's pending tasks this owner may start, oldest first.
 *
 * Three kinds of pending task are left alone, and each would be a real defect if it were
 * started here:
 *
 * - one with a live attempt, which is already being worked;
 * - one whose last attempt ended and whose queue row has not moved since — the agent finished a
 *   turn and the owner has not recorded the outcome, so starting again would spend a second
 *   attempt on work that may already be done;
 * - one the run has recorded as waiting on a blocker.
 *
 * A task a completion reopened *is* dispatched: its last transition is the reopen, which is the
 * rework after a review or the lead's revision after a rejection. Both are new attempts on the
 * same conversation, and both are exactly what a freed slot exists to start.
 */
export function pendingTasks(db: Database.Database, runId: string): string[] {
  const rows = db.prepare(`
    SELECT a.task_id AS taskId, q.state AS state,
      (SELECT count(*) FROM team_attempts t WHERE t.qitem_id = a.qitem_id) AS attempts,
      (SELECT count(*) FROM team_attempts t WHERE t.qitem_id = a.qitem_id AND t.state <> 'stopped') AS openAttempts,
      (SELECT tr.transition_note FROM queue_transitions tr WHERE tr.qitem_id = a.qitem_id
        ORDER BY tr.ts DESC, tr.transition_id DESC LIMIT 1) AS lastNote
    FROM team_queue_authority a
    JOIN queue_items q ON q.qitem_id = a.qitem_id
    WHERE a.run_id = ? AND q.state IN ('pending', 'in-progress')
    ORDER BY a.rowid`).all(runId) as Array<{ taskId: string; state: string; attempts: number; openAttempts: number;
      lastNote: string | null }>;
  return rows.filter(row => row.openAttempts === 0
    // Never ran, or reopened deliberately: both are work nobody is doing.
    && (row.attempts === 0 || (row.lastNote ?? "").startsWith("reopen acknowledged:")))
    .map(row => row.taskId);
}

/**
 * Start the run's pending tasks while its live sessions leave room.
 *
 * A dispatch that starts nothing (a seat that is not ready, a task that cannot be admitted)
 * leaves its slot unused rather than being retried here, which is the same answer the start
 * route gives; the next freed slot asks again. The loop asks again after every dispatch rather
 * than assuming each one used its slot, so a refusal never hides the room for the next task.
 */
export function composePendingDispatch(dependencies: PendingDispatchDependencies) {
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  return async (runId: string): Promise<void> => {
    const dispatch = dependencies.dispatch();
    if (!dispatch) return;
    const run = dependencies.db.prepare("SELECT state FROM team_runs WHERE id = ?").get(runId) as { state: string } | undefined;
    // Only an approved run may start work. A canceled or suspended run keeps its queue exactly
    // as the cancel left it, and dispatching into it would reopen work the owner ended.
    if (run?.state !== "approved") return;
    const limit = dependencies.maxSessions(runId);
    // A task this call tried and could not start is not tried again in the same pass: the seat
    // or the admission refused it, and repeating the refusal would only spend the same cost.
    const tried = new Set<string>();
    for (;;) {
      if (dependencies.liveSessions(runId) >= limit) return;
      const next = pendingTasks(dependencies.db, runId).find(taskId => !tried.has(taskId));
      if (next === undefined) return;
      tried.add(next);
      try {
        await dispatch(runId, next);
      } catch (error) {
        log(`team dispatch: launch for run=${runId} task=${next} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
