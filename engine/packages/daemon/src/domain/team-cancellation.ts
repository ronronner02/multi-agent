import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { TEAM_CONTROL_VERSION, type ControlActor, type ControlReceipt, type ControlRequest } from "../contracts/team-control.js";
import type { PlanGovernance } from "./plan-governance.js";
import { runningAttemptIdentities, terminateProcessGroup, type ProcessIdentity, type TerminationResult } from "./process-termination.js";

/**
 * T017 (cancellation half) — the owner's cancel actually stops the work.
 *
 * On `main` the cancel command recorded `cancel_requested` and nothing else happened: the
 * client kept running, the queue row stayed open, and the run never left that state. This is
 * the missing half, and it stays small because every decision it makes is one an existing
 * owner already makes.
 *
 * - **Dispatch closure** is `eligibility`: every command that admits work — a task, a launch
 *   intent, an attempt, a growth decision — already refuses unless the run is `approved`. A run
 *   in `cancel_requested` is closed to all of them, so no C1 growth task, C2 review task or
 *   rework can be admitted after a cancel. Nothing here adds a second gate.
 * - **Termination** is only ever aimed at an identity `team_attempts` recorded: the client's
 *   pid *and* its start tick, signalled as the process group it leads. `process-termination.ts`
 *   says why the group is safe to signal and when it is not.
 * - **The observation** is the completion sweep's: an attempt whose process is gone is recorded
 *   stopped by `attempt-completion.ts`, exactly as it is for work that finished on its own.
 *   Governance then closes the run once nothing is left running.
 *
 * No worktree, candidate or evidence row is touched. A canceled run is still reviewable, and
 * `rig team apply` reads the same candidate it would have read before the cancel.
 */

export interface CancellationDependencies {
  db: Database.Database;
  governance: PlanGovernance;
  /** How a group is ended; injectable so the tests can decide the outcome instead of spawning. */
  terminate?: (identity: ProcessIdentity) => Promise<TerminationResult>;
  /** How long to wait for the sweep to observe a stopped client before deciding the outcome. */
  settleMs?: number;
  log?: (message: string) => void;
}

export interface StoppedAttempt extends ProcessIdentity {
  outcome: TerminationResult["outcome"];
  escalated: boolean;
  waitedMs: number;
}

export interface CancellationResult {
  /** The run as it stands after this cancel: `canceled` when the stop was observed. */
  state: string;
  /** One entry per attempt this cancel tried to end, with the identity it was aimed at. */
  attempts: StoppedAttempt[];
  /** The attempts nothing has observed end; empty exactly when the run reached `canceled`. */
  unresolvedAttempts: string[];
  /** The tasks this cancel closed, by task id. */
  canceledTasks: string[];
  /** Why the run has not reached `canceled`, or null when it has. */
  reason: string | null;
}

export interface Cancellation {
  /** Record the owner's intent. Durable before any signal, and closed to dispatch from here on. */
  request(runId: string, request: ControlRequest<unknown>, actor: ControlActor): ControlReceipt;
  /**
   * End what this run launched, wait for the sweep to observe it, and record the outcome.
   *
   * The caller has already recorded the intent; this only acts on a run that is awaiting
   * cancellation, so a repeated request against a settled run signals nothing.
   */
  stop(runId: string, actor: ControlActor): Promise<CancellationResult>;
}

export const CANCEL_SETTLE_MS = 2_000;

export function composeCancellation(dependencies: CancellationDependencies): Cancellation {
  const { db, governance } = dependencies;
  const terminate = dependencies.terminate ?? (identity => terminateProcessGroup(identity));
  const settleMs = dependencies.settleMs ?? CANCEL_SETTLE_MS;
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const current = (runId: string): CancellationResult => {
    const run = governance.getRun(runId);
    const attempts = db.prepare("SELECT id, state FROM team_attempts WHERE run_id = ? ORDER BY rowid").all(runId) as Array<{ id: string; state: string }>;
    return {
      state: run.state,
      attempts: [],
      unresolvedAttempts: attempts.filter(attempt => attempt.state !== "stopped").map(attempt => attempt.id),
      canceledTasks: canceledTasks(db, runId),
      reason: run.state === "canceled" ? null : run.stateReason ?? "Termination has not been observed",
    };
  };

  /** One observation command, with the run's version as it stands now. */
  const observeOnce = (runId: string, actor: ControlActor): ControlReceipt =>
    governance.observeCancellation({ protocolVersion: TEAM_CONTROL_VERSION, runId, actionId: runId,
      expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: "cancel-observe:" + randomUUID(),
      payload: {} }, actor);

  /**
   * Give the sweep its chance to see the ends, then record the observation.
   *
   * The sweep runs on its own cadence, so a client can be gone before the attempt row says so.
   * Waiting a bounded moment keeps the common case one action for the owner; a run that is
   * still unresolved is reported as unresolved instead of being waited on forever.
   */
  const settle = async (runId: string, actor: ControlActor): Promise<void> => {
    const deadline = Date.now() + settleMs;
    for (;;) {
      const run = governance.getRun(runId);
      if (run.state !== "cancel_requested") return;
      const open = (db.prepare("SELECT count(*) AS count FROM team_attempts WHERE run_id = ? AND state <> 'stopped'").get(runId) as { count: number }).count;
      if (open === 0 || Date.now() >= deadline) {
        const receipt = observeOnce(runId, actor);
        if (receipt.status !== "observed") log(`team cancel: run=${runId} stays ${governance.getRun(runId).state}: ${receipt.reason ?? receipt.status}`);
        return;
      }
      await sleep(100);
    }
  };

  return {
    request(runId, raw, actor) {
      return governance.cancelRun(raw, actor);
    },

    async stop(runId, actor) {
      const attempts = governance.getRun(runId).state === "cancel_requested" ? runningAttemptIdentities(db, runId) : [];
      const results: StoppedAttempt[] = [];
      for (const identity of attempts) {
        const result = await terminate(identity);
        results.push({ ...identity, ...result });
        if (result.outcome === "unresolved") {
          log(`team cancel: run=${runId} process ${identity.processId}:${identity.processStart} is unresolved after ${result.waitedMs}ms`);
        }
      }
      await settle(runId, actor);
      return { ...current(runId), attempts: results };
    },
  };
}

/** The tasks a run's cancellation closed, read back from the queue rows themselves. */
function canceledTasks(db: Database.Database, runId: string): string[] {
  const rows = db.prepare(`SELECT a.task_id AS taskId FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
    WHERE a.run_id = ? AND q.state = 'canceled' ORDER BY a.task_id`).all(runId) as Array<{ taskId: string }>;
  return rows.map(row => row.taskId);
}
