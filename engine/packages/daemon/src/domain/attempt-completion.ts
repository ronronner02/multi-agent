import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { TEAM_CONTROL_VERSION, jsonValue, type ControlRequest, type JsonValue } from "../contracts/team-control.js";
import type { PlanGovernance } from "./plan-governance.js";
import type { SessionRegistry } from "./session-registry.js";
import type { NativeAttemptIdentity } from "../contracts/team-control.js";
import { classifyAttemptFailure, classificationFor, TERMINAL_TAIL_LINES, type AttemptClassification, type AttemptReasonCode } from "./attempt-failure.js";
import { agentTurnOutputPaths, readAgentTurnLastMessage, readAgentTurnThreadId } from "./agent-turn.js";
import { leadCompletionEvidence, taskCompletionEvidence, type CandidateFacts, type TaskCompletionEvidence } from "./task-completion.js";
import { recordedFindings } from "./review-loop.js";
import type { AttemptOutcome, AttemptTelemetry } from "./attempt-telemetry.js";
import { unreadableTaskReport, type TaskReport } from "./task-report.js";
import { recordWorkflowTurn } from "./team-workflows.js";
import { observeIdentity } from "./process-termination.js";

/**
 * MVP — the completion path's observation half.
 *
 * A direct launch records a receipt naming the client process the pane runs under, but nothing
 * wrote that attempt into `team_attempts` and nothing ever closed it. A task could therefore
 * never be observed to finish, and the owner's outcome command — which requires a stopped
 * attempt with an identity — could never succeed outside the demos.
 *
 * This path closes that gap with the receipt and stop writes, then records the task outcome from
 * the daemon's own evidence. Owner commands remain an override, while ordinary implementer,
 * lead and reviewer turns complete through this sweep. All writes are idempotent, so a repeated
 * sweep records nothing twice.
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
  sessions: Pick<SessionRegistry, "findResumeContextByName" | "updateStartupStatus">
    & Partial<Pick<SessionRegistry, "updateResumeToken">>;
  /** The direct worker's mutable state root, shared with its turn launcher. */
  turnStateRoot?: string;
  /** The same attempt store served by the live and historical telemetry routes. */
  telemetry?: Pick<AttemptTelemetry, "capture" | "recordOutcome">;
  /** The runtime's daemon-owned candidate manifest reader, used for automatic completion evidence. */
  candidateManifestFor?: (runId: string, taskId: string) => CandidateFacts;
  /** The runtime's daemon-owned lead proposal reader, used for automatic lead completion evidence. */
  readLeadProposal?: (runId: string, taskId: string) => readonly unknown[];
  readTaskReport?: (runId: string, attemptId: string) => TaskReport | null;
  /**
   * U6 — the runtime's reader of a delivery lead's escalation.
   *
   * Present means this daemon reads the second file a lead may deliver, and it turns on the
   * manager rule: a delivery lead turn that writes neither file is still a turn the owner asked
   * for, and one that writes either must have written a shape the boundary accepts.
   */
  readLeadEscalation?: (runId: string, taskId: string) => { optionCount: number } | null;
  /** Injectable for the tests; production reads the recorded identity on any host. */
  alive?: (identity: { processId: number; processStart: string }) => boolean | Promise<boolean>;
  /**
   * T033 — the exit evidence the seat's terminal recorded for a pane, read once when the sweep
   * observes the process gone. Absent means this daemon cannot read it (a hardened launch, or
   * a test), and the attempt is then classified from the evidence it does have.
   */
  paneExit?: (paneId: string) => Promise<{ dead: boolean; code: number | null } | null>;
  /** T033 — the pane's last lines, for the classifier's text fingerprints. Absent means none. */
  paneTail?: (paneId: string, lines: number) => Promise<string | null>;
  /**
   * The task a launch stamped into a pane before it started the client.
   *
   * A seat can hold two live tasks at once — two completed implementers are two pending
   * reviews on the same reviewer seat — so the receipt's seat name is not always enough to
   * say which task a turn is running. Absent means this daemon records no stamp and a
   * multi-task seat stays ambiguous, which records nothing rather than guessing.
   */
  paneTask?: (paneId: string) => Promise<string | null>;
  /** T033 — put a held pane back to a live shell once its exit evidence has been read. */
  releasePane?: (paneId: string) => Promise<unknown>;
  /**
   * MVP — start the run's next pending task now that this attempt's seat and slot are free.
   *
   * Absent means nothing dispatches on a freed slot, which is what every pre-MVP caller
   * (a test, or a daemon under hardened isolation) wants.
   */
  dispatchPending?: (runId: string) => Promise<void>;
  /** Persist native-turn documents before the stop write, while an interrupted capture can still be swept. */
  captureTurnDocuments?: (attempt: import("../contracts/team-control.js").TeamAttempt) => void;
  /**
   * U5 — the end of one turn, after its stop is recorded and before the next task starts.
   *
   * A lead's turn ends with its final message, and that message is the reply the owner reads in
   * the run's chat. Reading it and storing it belongs to the owner of that conversation, not to
   * this sweep: this is the observation that the turn ended, which is the fact the conversation
   * owner cannot see for itself. It is awaited so a reply is stored before the slot is offered
   * again, and its failure is logged rather than allowed to stop the sweep.
   */
  onAttemptStopped?: (attempt: import("../contracts/team-control.js").TeamAttempt) => Promise<void>;
  /**
   * U7 — land a task whose review just approved on the run's integration branch.
   *
   * The approval is the trigger: the outcome command records it, and this is the observation
   * that it happened. Awaited so the branch has the commit before the sweep offers the slot
   * again, and its failure is logged rather than allowed to stop the sweep — the task records
   * its own conflict, and the lead wakes on that.
   */
  integrateTask?: (runId: string, taskId: string) => Promise<unknown>;
  /**
   * U6 — the tick after every observation, for the owner of facts no single attempt produces.
   *
   * The lead is woken by what its whole team did — a task that failed after its retry, a review
   * allowance that ran out, a task that conflicts on the integration branch, every task done —
   * and none of those is "this attempt stopped". The completion sweep is already the daemon's
   * 1 Hz observation of the queue, so the team-event owner runs on it rather than opening a
   * second timer that could disagree about the cadence.
   */
  onSweep?: () => Promise<void>;
  now?: () => Date;
  intervalMs?: number;
  log?: (message: string) => void;
}

export interface AttemptCompletion {
  /** Register every receipt whose attempt is not recorded, then stop the ones that ended. */
  sweep(): Promise<void>;
  start(): void;
  stop(): void;
}

/** The final JSON report a reviewer turn must return for automatic verdict recording. */
export function extractReviewerReport(message: string | null): Record<string, unknown> | null {
  if (message === null) return null;
  const blocks = [...message.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const block = blocks.at(-1)?.[1];
  if (block === undefined) return null;
  try {
    const value = JSON.parse(block) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !("findings" in value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

const unavailable = { value: null, reason: "Native usage has not been observed" };

/**
 * Whether the process a receipt named is still the one running, on POSIX.
 *
 * The start time is the identity: a recycled pid starts at a different clock tick, so it is a
 * different process. A zombie has already exited even though `/proc` still lists it. A `/proc`
 * that cannot be read at all is not evidence of an end — only a missing process is.
 *
 * Windows has no `/proc`; there the same question is answered from the process's creation time
 * through the platform boundary, by `identityAlive` below.
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

/**
 * The sweep's liveness question on any host, in the one form its caller can act on.
 *
 * The sweep closes an attempt when this answers false, so only a proved end may answer false: a
 * missing process, or a zombie. On Windows a denied or timed-out query is `unknown` and a moved
 * creation time is `not-ours`; neither is evidence that the recorded process ended, so both answer
 * true and the attempt stays open. Recovery's own `unknown`/`unresolved` handling belongs to the
 * unit that reconciles identities at boot, not to this observation.
 */
export async function identityAlive(identity: { processId: number; processStart: string }): Promise<boolean> {
  return await observeIdentity(identity) !== "dead";
}

interface ReceiptRow { seq: number; payload: string }

export function composeAttemptCompletion(dependencies: AttemptCompletionDependencies): AttemptCompletion {
  const { db, governance, currentBinding, sessions } = dependencies;
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  const intervalMs = dependencies.intervalMs ?? ATTEMPT_SWEEP_INTERVAL_MS;
  const alive = dependencies.alive ?? identityAlive;
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweeping = false;
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
   *
   * One seat can hold two live tasks — two completed implementers are two pending reviews on
   * the same reviewer seat — and the launch recorded which of them its pane is running. That
   * stamp is the tie-break: without it the seat is ambiguous and a real turn would run with no
   * attempt to observe.
   */
  const taskForSeat = (runId: string, sessionName: string, paneTaskId: string | null) => {
    const rows = db.prepare(`
      SELECT a.qitem_id AS qitemId, a.task_id AS taskId, json_extract(a.assignment_json, '$.role') AS role
      FROM team_queue_authority a
      JOIN queue_items q ON q.qitem_id = a.qitem_id
      JOIN team_runs r ON r.id = a.run_id
      WHERE a.run_id = ? AND q.destination_session = ? AND q.state IN ('pending', 'in-progress')
        AND r.state = 'approved'
      LIMIT 2`).all(runId, sessionName) as Array<{ qitemId: string; taskId: string; role: string }>;
    if (rows.length === 1) return { qitemId: rows[0]!.qitemId, role: rows[0]!.role };
    const stamped = paneTaskId === null ? [] : rows.filter(row => row.taskId === paneTaskId);
    return stamped.length === 1 ? { qitemId: stamped[0]!.qitemId, role: stamped[0]!.role } : null;
  };

  /** Admit the attempt a launch receipt names, unless it is already recorded. */
  const register = async (row: ReceiptRow): Promise<void> => {
    const { sessionName, receipt } = JSON.parse(row.payload) as {
      sessionName?: string; receipt?: { attemptId: string; runId: string; client: string; identity: NativeAttemptIdentity };
    };
    if (!sessionName || !receipt) return;
    // A resume re-enters the attempt it recorded, so its row already exists and keeps its own
    // history. Only the first observation of a native generation admits a new row.
    if (governance.getAttempt(receipt.attemptId)) return;
    const paneTaskId = (await dependencies.paneTask?.(receipt.identity.paneId)) ?? null;
    const task = taskForSeat(receipt.runId, sessionName, paneTaskId);
    if (!task) {
      log(`team completion: no single live task on ${sessionName} for run=${receipt.runId}` +
        `${paneTaskId === null ? "" : ` (the pane's stamp names ${paneTaskId})`}; attempt ${receipt.attemptId} is unrecorded`);
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
   *
   * T033 — the stop carries the attempt's one KTD20 classification. The evidence is read here,
   * once, at the moment the sweep observes the process gone: the run's own cancel state, the
   * exit status the seat's terminal recorded, and the last lines it held. Nothing later
   * re-derives it, and nothing here adds an attempt or a unit of budget.
   */
  const close = async (): Promise<void> => {
    const rows = db.prepare("SELECT id FROM team_attempts WHERE state = 'running' AND identity_json IS NOT NULL")
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      try {
        const attempt = governance.getAttempt(row.id);
        if (!attempt?.identity || await alive(attempt.identity)) continue;
        // A pane the launcher held is still the seat's, but its dead foreground process makes the
        // seat unusable: measured on tmux 3.6, input into a dead pane is accepted and does
        // nothing. The evidence is read first, then the pane is released, so the next dispatch
        // of this seat starts its client in a live shell instead of a dead one.
        const failure = await classify(attempt);
        dependencies.telemetry?.capture(attempt);
        // A persisted stop is excluded from later sweeps. Save its exact documents first so a
        // restart never needs to attribute the candidate's later mutable bytes to this turn.
        dependencies.captureTurnDocuments?.(attempt);
        await releaseHeldPane(attempt.identity.paneId);
        const request: ControlRequest<unknown> = {
          protocolVersion: TEAM_CONTROL_VERSION, runId: attempt.runId, actionId: attempt.id,
          expectedEntityVersion: governance.getRun(attempt.runId).entityVersion,
          idempotencyKey: `attempt-stop:${attempt.id}:${attempt.entityVersion}`,
          // The end of the process is the observation; no usage figure is claimed for it.
          payload: { expectedAttemptVersion: attempt.entityVersion, state: "stopped", usage: jsonValue(attempt.usage),
            ...(failure === null ? {} : { failure: jsonValue(failure) }) },
        };
        const recorded = governance.recordUsage(request);
        if (recorded.status !== "observed" && !recorded.replayed) {
          log(`team completion: attempt ${attempt.id} stop was not recorded: ${recorded.reason ?? recorded.status}`);
          continue;
        }
        const stopped = governance.getAttempt(attempt.id);
        let telemetryOutcome: { outcome: AttemptOutcome; retryScheduled: boolean } = {
          outcome: failure?.reasonCode === "canceled" ? "canceled" : failure === null ? "unknown" : "failed", retryScheduled: false,
        };
        if (stopped) {
          try { telemetryOutcome = await recordAutomaticOutcome(stopped) ?? telemetryOutcome; }
          catch (error) { log(`team completion: automatic outcome for attempt ${attempt.id} failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
        try { dependencies.telemetry?.recordOutcome(attempt.id, telemetryOutcome); }
        catch (error) {
          // The capture is already durable and the native stop is recorded. An unavailable
          // outcome remains unknown; it must not strand the stopped attempt's seat.
          log(`team completion: telemetry outcome for ${attempt.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        releaseSeat(attempt.qitemId, attempt.provider === "codex" ? attempt.id : undefined);
        // U5 — the turn is over and its seat is free: whoever owns this attempt's conversation
        // gets its final message now, before the freed slot is offered to the next task.
        try { await dependencies.onAttemptStopped?.(attempt); } catch (error) {
          log(`team completion: turn-end owner for attempt ${attempt.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        // MVP — the seat and its session slot are free now, so the run's next pending task can
        // start. A dispatch failure is logged and left for the next freed slot: it must not stop
        // the rest of the sweep, and a task that cannot start yet is not an error of this one.
        try { await dependencies.dispatchPending?.(attempt.runId); } catch (error) {
          log(`team completion: dispatch after attempt ${attempt.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } catch (error) {
        // A run or attempt that moved under the sweep is re-read on the next tick; one failed
        // observation must not stop the others.
        log(`team completion: sweep skipped ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  /**
   * The evidence the daemon holds about one ended attempt, classified once.
   *
   * A terminal read that fails is no evidence, and the classifier already treats no evidence as
   * no failure rather than as a clean exit, so a transient tmux error cannot manufacture a
   * retryable code.
   *
   * The exit status decides first, because it is structured: a launched client holds its pane
   * (measured on tmux 3.6, without that the pane is destroyed on exit), and a client that exits
   * with 0 finished its turn, so nothing it printed is the failure of this attempt. Only a
   * non-zero exit, a signal, or no exit record at all sends the tail to the fingerprints.
   */
  const classify = async (attempt: NonNullable<ReturnType<PlanGovernance["getAttempt"]>>): Promise<AttemptClassification | null> => {
    const run = governance.getRun(attempt.runId);
    const canceled = run.state === "cancel_requested" || run.state === "canceled";
    const pane = attempt.identity?.paneId ?? null;
    const exit = pane !== null && dependencies.paneExit ? await dependencies.paneExit(pane) : null;
    const terminalTail = pane !== null && dependencies.paneTail && exit?.code !== 0
      ? await dependencies.paneTail(pane, TERMINAL_TAIL_LINES) : null;
    return classifyAttemptFailure({ canceled, exit: exit === null ? null : { code: exit.code }, terminalTail, now: dependencies.now?.() });
  };

  /** Record the task result the daemon can prove from the stopped turn. */
  const recordAutomaticOutcome = async (stoppedAttempt: NonNullable<ReturnType<PlanGovernance["getAttempt"]>>): Promise<{ outcome: AttemptOutcome; retryScheduled: boolean } | void> => {
    // Older embedders and unit fixtures may compose only the stop observer. Production wires at
    // least one worker-output reader; without one there is no daemon-owned evidence to record.
    if (!dependencies.candidateManifestFor && !dependencies.readLeadProposal && !dependencies.turnStateRoot) return;
    if (stoppedAttempt.qitemId === null) return;
    const task = governance.getTask(stoppedAttempt.qitemId);
    if (!task || !["lead", "implementer", "reviewer"].includes(task.assignment.role)) return;
    const workflowOutcome = recordWorkflowTurn(dependencies.db, stoppedAttempt, dependencies.turnStateRoot
      ? readAgentTurnLastMessage(dependencies.turnStateRoot, stoppedAttempt.id) : null);
    // A planning lead task is the owner↔lead chat conversation, not a delivery task. Its turn
    // ends in a chat reply and is reopened by the next owner message; completion evidence applies
    // once the run enters delivery and the lead writes its decomposition proposal.
    if (task.assignment.role === "lead" && governance.getRun(stoppedAttempt.runId).phase === "planning"
      && stoppedAttempt.failure === null) return;
    const subjectTaskId = task.assignment.role === "reviewer" && task.assignment.reviewOf !== undefined
      ? task.assignment.reviewOf : task.assignment.taskId;
    let state: "done" | "failed" | "blocked" | "canceled";
    let taskReport: TaskReport | null = null;
    if (task.assignment.role !== "lead" && dependencies.readTaskReport) {
      try { taskReport = dependencies.readTaskReport(stoppedAttempt.runId, stoppedAttempt.id); }
      catch (error) { taskReport = unreadableTaskReport(error); }
    }
    if (!taskReport && workflowOutcome && task.assignment.role !== "lead"
      && (workflowOutcome.status === "blocked" || workflowOutcome.status === "incomplete")) {
      taskReport = { status: "blocked", evidence: workflowOutcome.reason };
    }
    let evidence: Record<string, unknown>;
    let reasonCode: AttemptReasonCode | null = null;

    if (stoppedAttempt.failure?.reasonCode === "canceled") {
      state = "canceled"; evidence = { reasonCode: "canceled" };
    } else if (taskReport) {
      state = taskReport.status === "dropped" ? "done" : "blocked";
      evidence = { taskReport, reportedAttemptId: stoppedAttempt.id, validated: false };
    } else if (stoppedAttempt.failure) {
      state = "failed";
      reasonCode = stoppedAttempt.failure.reasonCode as AttemptReasonCode;
      evidence = { reasonCode };
    } else if (task.assignment.role === "reviewer") {
      const message = dependencies.turnStateRoot
        ? readAgentTurnLastMessage(dependencies.turnStateRoot, stoppedAttempt.id) : null;
      const report = extractReviewerReport(message);
      if (!report) {
        state = "failed";
        evidence = { reasonCode: "review_report_missing" };
        reasonCode = "review_report_missing";
      } else {
        try {
          // Validate the report at the same boundary the governance path uses before recording it.
          recordedFindings(report);
          evidence = { ...report };
          try {
            const manifest = dependencies.candidateManifestFor?.(stoppedAttempt.runId, subjectTaskId);
            if (manifest) evidence.manifestDigest = manifest.manifestDigest;
          } catch {
            // The review report remains sufficient evidence; the existing review path treats a
            // missing digest as unavailable candidate context and still validates the findings.
          }
          state = "done";
        } catch {
          state = "failed";
          evidence = { reasonCode: "review_report_missing" };
          reasonCode = "review_report_missing";
        }
      }
    } else {
      let manifest: CandidateFacts | null = null;
      let unavailableReason = "Candidate trees are not composed in this daemon";
      try {
        manifest = dependencies.candidateManifestFor?.(stoppedAttempt.runId, subjectTaskId) ?? null;
      } catch {
        unavailableReason = "The task's candidate is not on disk";
      }
      let completion: TaskCompletionEvidence;
      if (task.assignment.role === "lead") {
        let proposal: { taskCount: number } | null = null;
        if (dependencies.readLeadProposal) {
          try { proposal = { taskCount: dependencies.readLeadProposal(stoppedAttempt.runId, task.assignment.taskId).length }; }
          catch { proposal = null; }
        }
        // U6 — a delivery lead's other deliverable is the question only the owner can answer.
        // Read here too, so a turn that escalated is a turn that did its job rather than a turn
        // whose proposal is missing.
        let escalation: { optionCount: number } | null = null;
        if (dependencies.readLeadEscalation) {
          try { escalation = dependencies.readLeadEscalation(stoppedAttempt.runId, task.assignment.taskId); }
          catch { escalation = null; }
        }
        completion = leadCompletionEvidence({ manifest, proposal, planRef: governance.getRun(stoppedAttempt.runId).binding.planRef,
          ...(dependencies.readLeadEscalation ? { escalation, managementTurn: true } : {}), unavailableReason });
      } else {
        completion = taskCompletionEvidence({ role: task.assignment.role, assignmentPaths: task.assignment.paths, manifest, unavailableReason,
          ...(task.workflow && workflowOutcome ? { workflow: { readOnly: task.workflow.readOnly, outcome: workflowOutcome } } : {}) });
      }
      evidence = { ...completion, ...(workflowOutcome ? { workflowOutcome } : {}) } as unknown as Record<string, unknown>;
      if (completion.validated) state = "done";
      else {
        state = "failed";
        reasonCode = "evidence_invalid";
        evidence = { ...evidence, reasonCode };
      }
    }

    // The classifier is recorded with the stop when available. A failed evidence read has no
    // process classifier, so stamp its judgment classification onto the stopped attempt first.
    let currentAttempt = stoppedAttempt;
    if (state === "failed" && currentAttempt.failure === null && reasonCode !== null) {
      const failure = classificationFor(reasonCode);
      const observed = governance.recordUsage({
        protocolVersion: TEAM_CONTROL_VERSION, runId: currentAttempt.runId, actionId: currentAttempt.id,
        expectedEntityVersion: governance.getRun(currentAttempt.runId).entityVersion,
        idempotencyKey: `attempt-failure:${currentAttempt.id}:${currentAttempt.entityVersion}`,
        payload: { expectedAttemptVersion: currentAttempt.entityVersion, state: "stopped", usage: jsonValue(currentAttempt.usage), failure: jsonValue(failure) },
      });
      if (observed.status !== "observed" && !observed.replayed) {
        log(`team completion: could not record ${reasonCode} for attempt ${currentAttempt.id}: ${observed.reason ?? observed.status}`);
        return;
      }
      currentAttempt = governance.getAttempt(currentAttempt.id) ?? currentAttempt;
    }

    const actorSession = governance.taskSeat(task.qitemId);
    if (!actorSession) return;
    const run = governance.getRun(currentAttempt.runId);
    const outcome = governance.recordTaskOutcome({
      protocolVersion: TEAM_CONTROL_VERSION, runId: currentAttempt.runId, actionId: task.qitemId,
      expectedEntityVersion: run.entityVersion,
      idempotencyKey: `daemon-task-outcome:${currentAttempt.id}`,
      payload: { expectedTaskVersion: task.entityVersion, state, actorSession, attemptId: currentAttempt.id,
        expectedAttemptVersion: currentAttempt.entityVersion, evidence,
        ...(state === "done" ? { closureReason: "no-follow-on" } : {}) },
    }, { kind: "daemon", sessionId: "daemon" });
    if (outcome.status !== "observed" && !outcome.replayed) {
      log(`team completion: automatic outcome for ${task.assignment.taskId} was not recorded: ${outcome.reason ?? outcome.status}`);
      return;
    }
    const telemetryOutcome = { outcome: (state === "done" ? "succeeded" : state === "canceled" ? "canceled" : "failed") as AttemptOutcome,
      retryScheduled: governance.getRun(currentAttempt.runId).retriesUsed > run.retriesUsed };
    // U7 — an approving review is the run's signal to deliver the work it approved: the
    // implementer's own task lands as one commit on the run's branch. A replay finds the commit
    // already recorded, so a repeated sweep commits nothing twice.
    const review = (outcome.value as { review?: { verdict?: string; taskId?: string } } | null)?.review;
    if (review?.verdict === "approved" && typeof review.taskId === "string" && dependencies.integrateTask) {
      try { await dependencies.integrateTask(currentAttempt.runId, review.taskId); }
      catch (error) {
        log(`team completion: integration of ${review.taskId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return telemetryOutcome;
  };

  /** Release a pane the launcher held, so the seat's next client starts in a live shell. */
  const releaseHeldPane = async (paneId: string): Promise<void> => {
    if (!dependencies.paneExit || !dependencies.releasePane) return;
    const exit = await dependencies.paneExit(paneId);
    if (exit?.dead) await dependencies.releasePane(paneId);
  };

  /** Return the seat that ran a stopped attempt to "never launched", so a dispatch may start it. */
  const releaseSeat = (qitemId: string | null, codexAttemptId?: string): void => {
    const seat = qitemId === null ? null : governance.taskSeat(qitemId);
    const context = seat === null ? null : sessions.findResumeContextByName(seat);
    if (!context) return;
    if (codexAttemptId && dependencies.turnStateRoot) {
      const path = agentTurnOutputPaths(dependencies.turnStateRoot, codexAttemptId).threadId;
      const token = readAgentTurnThreadId(path);
      if (token) sessions.updateResumeToken?.(context.sessionId, "codex_id", token, "scrape");
    }
    sessions.updateStartupStatus(context.sessionId, "pending");
  };

  /** The runs that still hold work nobody is doing, as the scheduler's own durable rows say. */
  const pendingRunIds = (): string[] => (db.prepare(`
    SELECT DISTINCT a.run_id AS runId
    FROM team_queue_authority a
    JOIN queue_items q ON q.qitem_id = a.qitem_id
    JOIN team_runs r ON r.id = a.run_id
    WHERE q.state IN ('pending', 'in-progress') AND r.state = 'approved'
      AND NOT EXISTS (SELECT 1 FROM team_attempts t WHERE t.qitem_id = a.qitem_id AND t.state <> 'stopped')`)
    .all() as Array<{ runId: string }>).map(row => row.runId);

  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      const receipts = db.prepare("SELECT seq, payload FROM events WHERE type = 'managed.attempt.receipt' AND seq > ? ORDER BY seq")
        .all(processedSeq) as ReceiptRow[];
      for (const row of receipts) {
        // Advance before registering: a receipt that cannot be registered now is not retried, and
        // the owner action refuses its task with a named reason rather than leaving a tick to
        // repeat the same refusal every second for the life of the daemon.
        processedSeq = row.seq;
        try { await register(row); } catch (error) {
          log(`team completion: receipt was not registered: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await close();
      for (const runId of pendingRunIds()) {
        try { await dependencies.dispatchPending?.(runId); } catch (error) {
          log(`team completion: scheduled dispatch for run=${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // The sweep has recorded everything this tick can observe about its attempts; the facts the
      // whole team produced are read after it, once, for the same cadence.
      try { await dependencies.onSweep?.(); } catch (error) {
        log(`team completion: the sweep's team-event owner failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      sweeping = false;
    }
  };

  return {
    sweep,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        // The sweep guard covers timer ticks, startup and explicit observations while I/O waits.
        sweep().catch(error => log(`team completion: sweep failed: ${error instanceof Error ? error.message : String(error)}`));
      }, intervalMs);
      // The daemon's lifetime decides how long this runs; a tick must never be the reason a
      // process stays alive after its database closed.
      timer.unref?.();
      // A restart is a freed slot too: the run's pending tasks were waiting for one when the
      // daemon stopped, and nothing else asks the scheduler again. Without this a run resumed
      // after a restart sits with work nobody starts — measured on the C4 acceptance run, where
      // the rework the review had just reopened was never dispatched.
      void sweep().catch(error => log("team completion: startup sweep failed: " + String(error)));
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
