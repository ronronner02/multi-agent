/**
 * U4 / KTD5 — reconcile submitted and started attempts after a daemon restart.
 *
 * On boot, every row in `team_attempts` with state `running` or `unknown` must be
 * reconciled against the recorded process identity. The host's observation is the
 * only authority: a confirmed live child is tree-killed and recorded as interrupted
 * only after its recorded identity is absent; a stubborn survivor persists as
 * `recovery_blocked` with an owner-facing reason and is never requeued; a confirmed
 * dead child is recorded as interrupted; and an unknown or not-ours probe blocks
 * recovery with a named reason — never treated as dead, never requeued automatically.
 *
 * A task requeues once, and only from a durable interrupted fact. Owner Resume
 * clears a blocked one.
 */

import type Database from "better-sqlite3";
import type { PlanGovernance } from "./plan-governance.js";
import { TEAM_CONTROL_VERSION, jsonValue, type ControlRequest, type JsonValue } from "../contracts/team-control.js";
import { observeIdentity, terminateProcessGroup } from "./process-termination.js";
import { classificationFor } from "./attempt-failure.js";
import { occupantTruthFromIdentity, type SeatOccupant } from "./seat-occupant.js";

export interface BootRecoveryDependencies {
  db: Database.Database;
  governance: PlanGovernance;
  /** Injectable for tests; production uses the real platform observer. */
  observe?: (identity: { processId: number; processStart: string }) => Promise<"alive" | "dead" | "not-ours" | "unknown">;
  /** Injectable for tests; production uses the real tree killer. */
  terminate?: (identity: { processId: number; processStart: string }) => Promise<import("./process-termination.js").TerminationResult>;
  log?: (message: string) => void;
}

/**
 * The outcome of one boot reconciliation sweep.
 */
export interface BootReconciliationOutcome {
  /** How many attempts were found in a running or unknown state. */
  total: number;
  /** How many were tree-killed and recorded as interrupted after absence verification. */
  interrupted: number;
  /** How many had a stubborn survivor and are now recorded as recovery_blocked. */
  blocked: number;
  /** How many had an unknown or not-ours identity and are now recovery_blocked. */
  unknown: number;
  /** Per-attempt details. */
  details: Array<{
    attemptId: string;
    state: string;
    identityState: string;
    outcome: "interrupted" | "recovery_blocked";
    reason: string;
  }>;
}

/**
 * Reconcile all running and unknown attempts on boot.
 *
 * Reads every `team_attempts` row with state `running` or `unknown`, queries the
 * recorded process identity, and:
 *
 * - Confirmed live -> tree-kill -> verify absence -> `interrupted`
 * - Survivor remains after tree-kill -> `recovery_blocked` (owner reason)
 * - Confirmed dead -> `interrupted`
 * - `unknown` or `not-ours` -> `recovery_blocked` (named reason, never automatic requeue)
 */
export async function bootReconcileAttempts(dependencies: BootRecoveryDependencies): Promise<BootReconciliationOutcome> {
  const { db, governance } = dependencies;
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  const observe = dependencies.observe ?? observeIdentity;
  const terminate = dependencies.terminate ?? (target => terminateProcessGroup(target));
  const outcome: BootReconciliationOutcome = { total: 0, interrupted: 0, blocked: 0, unknown: 0, details: [] };

  // Read every running or unknown attempt with a recorded identity.
  const rows = db.prepare(`
    SELECT id, run_id AS runId, identity_json AS identityJson, state, unknown_reason AS unknownReason
    FROM team_attempts WHERE state IN ('running', 'unknown') AND identity_json IS NOT NULL
  `).all() as Array<{ id: string; runId: string; identityJson: string; state: string; unknownReason: string | null }>;

  for (const row of rows) {
    outcome.total += 1;
    const identity = JSON.parse(row.identityJson) as { processId: number; processStart: string };
    try {
      const state = await observe(identity);
      const occupantTruth = occupantTruthFromIdentity(state);

      if (state === "dead") {
        // Confirmed dead: record as interrupted — no tree-kill needed.
        await recordInterrupted(dependencies, row, identity);
        outcome.interrupted += 1;
        outcome.details.push({ attemptId: row.id, state: row.state, identityState: state, outcome: "interrupted", reason: "Confirmed dead on boot" });
      } else if (state === "alive") {
        // Confirmed live: tree-kill, then verify absence. The termination's own outcome is the
        // proof it verified absence after killing; a second probe is only consulted when the
        // killer could not answer for itself.
        const termination = await terminate(identity);
        const after = termination.outcome === "stopped" ? "dead" : await observe(identity);
        if (after === "dead") {
          await recordInterrupted(dependencies, row, identity);
          outcome.interrupted += 1;
          outcome.details.push({ attemptId: row.id, state: row.state, identityState: state, outcome: "interrupted",
            reason: `Tree-killed on boot (${termination.outcome}, escalated: ${termination.escalated}, waited: ${termination.waitedMs}ms)` });
        } else {
          // Survivor remains: persist as recovery_blocked.
          await recordRecoveryBlocked(dependencies, row, identity,
            `Stubborn survivor after tree-kill: ${after}`);
          outcome.blocked += 1;
          outcome.details.push({ attemptId: row.id, state: row.state, identityState: state, outcome: "recovery_blocked",
            reason: "Survivor remained after tree-kill" });
        }
      } else {
        // Not-ours or unknown: recovery_blocked with named reason.
        await recordRecoveryBlocked(dependencies, row, identity,
          state === "not-ours" ? "PID reused: creation time does not match" : "Identity query could not be answered");
        outcome.unknown += 1;
        outcome.details.push({ attemptId: row.id, state: row.state, identityState: state, outcome: "recovery_blocked",
          reason: `Identity ${state} on boot` });
      }
    } catch (error) {
      log(`boot reconcile: attempt ${row.id} reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        await recordRecoveryBlocked(dependencies, row, identity,
          `Reconciliation error: ${error instanceof Error ? error.message : String(error)}`);
      } catch (inner) {
        log(`boot reconcile: attempt ${row.id} recovery_blocked record also failed: ${inner instanceof Error ? inner.message : String(inner)}`);
      }
      outcome.unknown += 1;
      outcome.details.push({ attemptId: row.id, state: row.state, identityState: "error", outcome: "recovery_blocked",
        reason: `Reconciliation failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return outcome;
}

/**
 * Record an attempt as interrupted after a confirmed dead or tree-killed-and-absent outcome.
 *
 * An interrupted attempt is a durable fact from which the task may requeue. The evidence
 * carries a `daemon_recovery` failure classification so the retry policy knows this is a
 * restart recovery, not an ordinary failure.
 */
async function recordInterrupted(
  deps: BootRecoveryDependencies,
  row: { id: string; runId: string; identityJson: string },
  identity: { processId: number; processStart: string },
): Promise<void> {
  const { governance } = deps;
  const attempt = governance.getAttempt(row.id);
  if (!attempt) return;

  const run = governance.getRun(row.runId);
  const failure = classificationFor("daemon_recovery");
  const request: ControlRequest<unknown> = {
    protocolVersion: TEAM_CONTROL_VERSION,
    runId: row.runId,
    actionId: row.id,
    expectedEntityVersion: run.entityVersion,
    idempotencyKey: `boot-recovery:${row.id}`,
    payload: {
      expectedAttemptVersion: attempt.entityVersion,
      state: "stopped",
      usage: jsonValue(attempt.usage),
      failure: jsonValue(failure),
    },
  };
  governance.recordUsage(request);
}

/**
 * Record an attempt as recovery_blocked — the process identity could not be resolved or a
 * survivor remained after tree-kill. Never requeued automatically; owner Resume clears it.
 *
 * The state is set to "unknown" with a specific reason. This goes through the same governance
 * command path as interrupted, so entity-version guards, the event log, and subscribers all
 * observe the transition. The state is "unknown" rather than "stopped" because a blocked
 * attempt was never properly observed to end — it is a fact about identity, not about
 * termination — and only an explicit owner Resume can clear it.
 */
async function recordRecoveryBlocked(
  deps: BootRecoveryDependencies,
  row: { id: string; runId: string; state: string },
  identity: { processId: number; processStart: string },
  reason: string,
): Promise<void> {
  const { governance } = deps;
  const attempt = governance.getAttempt(row.id);
  if (!attempt) return;

  const run = governance.getRun(row.runId);
  const request: ControlRequest<unknown> = {
    protocolVersion: TEAM_CONTROL_VERSION,
    runId: row.runId,
    actionId: row.id,
    expectedEntityVersion: run.entityVersion,
    idempotencyKey: `boot-recovery-blocked:${row.id}`,
    payload: {
      expectedAttemptVersion: attempt.entityVersion,
      state: "unknown",
      unknownReason: `recovery_blocked: ${reason}`,
      usage: jsonValue(attempt.usage),
    },
  };
  governance.recordUsage(request);
}
