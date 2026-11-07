import type Database from "better-sqlite3";
import { TEAM_CONTROL_VERSION, TeamContractError, canonicalJson, parseAssignment, type ControlActor, type ControlRequest, type JsonValue } from "../contracts/team-control.js";
import { hashBytes, type PlanGovernance } from "./plan-governance.js";
import type { LeadSeatChanges } from "./lead-roster.js";
import { LeadProposalMissingError, type LeadTask, type LeadProposal, type LeadResolution } from "./lead-proposal.js";

/**
 * U6 — the lead as manager, after the owner approved the plan.
 *
 * Two facts about a delivery run are the daemon's to observe rather than an agent's to claim:
 *
 * - *What did the lead's turn deliver?* The lead writes its task list and, when it needs a
 *   decision it may not take, an escalation. Both land as files in its own tree, and both are
 *   read at the turn boundary that already owns worker-written data. A valid list is admitted
 *   with no owner approval (KTD1); a list outside the approved plan is refused and the refusal
 *   becomes the lead's next prompt.
 * - *What has the team done since the lead last spoke?* A task that failed after its retry, a
 *   review allowance that ran out, a task that will not apply to the integration branch, and
 *   the moment every task is done are all facts no single attempt produces. The lead is woken
 *   once for everything one sweep found, never once per fact and never once per sweep.
 *
 * Nothing here launches a client itself: it asks the run's own dispatch, the same one a start,
 * a rework and a chat message use.
 */

/** The daemon's own identity in a control request. It observes; it never acts as the owner. */
const daemon: ControlActor = { kind: "daemon", sessionId: "daemon" };

/** One fact the lead should hear about, with the key that makes "already told" decidable. */
export interface LeadTeamEvent {
  key: string;
  note: string;
}

export interface LeadManagerDependencies {
  db: Database.Database;
  governance: PlanGovernance;
  /** The runtime's own reading of the lead's decomposition, at the worker-written boundary. */
  readLeadProposal?: (runId: string, taskId: string) => readonly LeadTask[] | LeadProposal;
  readMaxSeats?: () => number;
  /** The run's current binding, read the way every control command reads it. */
  currentBinding: (runId: string) => unknown;
  /** The daemon's dispatch, read at use so a host that composes it later is still the owner. */
  dispatch: () => ((runId: string, taskId: string) => Promise<void>) | undefined;
  log?: (message: string) => void;
}

export interface LeadManager {
  /** The lead's turn ended: admit what it proposed, or let the refusal be its next work. */
  turnEnd(attempt: { id: string; runId: string; qitemId: string | null; role: string }): Promise<void>;
  /** Wake every delivery run's lead once for the team events it has not been told about. */
  sweep(): Promise<void>;
}

/**
 * The events one run's team produced that the lead has not been told about.
 *
 * Each event is a fact read from the run's own rows, and its key is stable across sweeps, so a
 * fact that is still true on the next tick is the same event and not a second one. The wording
 * is short and concrete because it becomes the lead's prompt, not a log line.
 */
export function leadTeamEvents(db: Database.Database, runId: string): LeadTeamEvent[] {
  const rows = db.prepare(`SELECT a.task_id AS taskId, a.qitem_id AS qitemId, q.state AS state,
      q.closure_reason AS closureReason, COALESCE(a.display_name, a.task_id) AS name,
      json_extract(a.assignment_json, '$.role') AS role,
      json_extract(a.evidence_json, '$.reasonCode') AS evidenceReason,
      json_extract(a.evidence_json, '$.taskReport') AS taskReportJson,
      json_extract(a.evidence_json, '$.reportedAttemptId') AS reportedAttemptId
    FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
    WHERE a.run_id = ? ORDER BY a.rowid`).all(runId) as Array<{ taskId: string; qitemId: string; state: string;
      closureReason: string | null; name: string; role: string; evidenceReason: string | null;
      taskReportJson: string | null; reportedAttemptId: string | null }>;
  const run = db.prepare("SELECT json_extract(binding_json, '$.limits.maxReviewRounds') AS maxReviewRounds FROM team_runs WHERE id = ?")
    .get(runId) as { maxReviewRounds: number | null } | undefined;
  const maxReviewRounds = run?.maxReviewRounds ?? 0;
  const reviewRounds = (taskId: string) => (db.prepare(`SELECT count(*) AS count FROM team_queue_authority
    WHERE run_id = ? AND json_extract(assignment_json, '$.role') = 'reviewer'
      AND json_extract(assignment_json, '$.reviewOf') = ?`).get(runId, taskId) as { count: number }).count;
  const attemptHistory = (qitemId: string) => db.prepare("SELECT failure_json AS failureJson FROM team_attempts WHERE qitem_id = ? ORDER BY rowid")
    .all(qitemId) as Array<{ failureJson: string | null }>;
  const events: LeadTeamEvent[] = [];
  for (const row of rows) {
    if (row.role !== "implementer" && row.role !== "reviewer") continue;
    if (row.taskReportJson !== null && (row.state === "blocked" || row.state === "done")) {
      events.push({ key: `report:${row.taskId}:${row.reportedAttemptId}`,
        note: `Worker report for task "${row.name}" (taskId: ${row.taskId}): ${row.taskReportJson}. ` +
          "Resolve a paused task through resolutions in lead-proposal.json, or escalate only when the owner must decide." });
      continue;
    }
    // A task that used the run's whole review allowance: no further round could be admitted.
    if (row.role === "implementer" && row.state !== "done" && maxReviewRounds > 0 && reviewRounds(row.taskId) >= maxReviewRounds) {
      events.push({ key: `review-limit:${row.taskId}`,
        note: `Task "${row.name}" used every review round the plan allows and none of them approved it. ` +
          "Decide whether to add a follow-up task, narrow the work, or ask the owner." });
    }
    // U7 — a patch that does not apply to the integration branch is the lead's conflict to
    // resolve. U7 records it the way every other failure is recorded: the work was approved and
    // closed, the patch could not land, and the observed failure names `integration_conflict` in
    // the task's evidence — so the queue row is `failed`, not a state of its own. The queue state
    // and the closure reason are read too, so a host that records either signal is heard.
    if (row.state === "conflict" || row.closureReason === "integration_conflict"
      || row.evidenceReason === "integration_conflict") {
      events.push({ key: `conflict:${row.taskId}`,
        note: `Task "${row.name}" was approved but its patch does not apply to the run's integration branch, ` +
          "and the branch is unchanged. Decide how it is resolved against the branch head and write the task that does it." });
    }
    if (row.state !== "failed") continue;
    // The conflict is the whole story of this failure; a second note for it would only repeat it.
    if (row.evidenceReason === "integration_conflict") continue;
    // "Failed after its retry": the retry already happened, or the classifier said this failure
    // is not one the run may retry. Either way the next move is the lead's, not the queue's.
    const history = attemptHistory(row.qitemId);
    let retryable = true, reasonCode: string | null = null;
    try {
      const failure = history.at(-1)?.failureJson
        ? JSON.parse(history.at(-1)!.failureJson!) as { retryEligible?: boolean; reasonCode?: string } : null;
      retryable = failure?.retryEligible !== false;
      reasonCode = failure?.reasonCode ?? null;
    } catch {
      // A classification this reader cannot parse is no evidence either way, and no
      // classification already means "not retried": the lead hears about the failure.
    }
    events.push({ key: `failed:${row.taskId}`,
      note: `Task "${row.name}" failed ${(history.length >= 2 || retryable) ? "after its retry allowance" : "and is not retryable"}` +
        `${reasonCode === null ? "" : ` (${reasonCode})`}. Decide whether to replace it, split it, or ask the owner.` });
  }
  // Every task done is the run's own finish line, and the digest makes "done" mean this exact
  // set of tasks: a follow-up the lead adds later is a new finish line, not the old one again.
  const implementers = rows.filter(row => row.role === "implementer");
  const finished = rows.length > 0 && rows.every(row => row.state === "done" || row.state === "handed-off");
  if (implementers.length > 0 && finished) {
    events.push({ key: `all-done:${rows.map(row => row.taskId).sort().join(",")}`,
      note: `Every task is done (${rows.length} in all). Decide whether the plan is complete: ` +
        "tell the owner the run is ready to merge, or write the follow-up tasks it still needs." });
  }
  return events;
}

/**
 * Whether this run already holds exactly the list the lead's tree is offering.
 *
 * The tree keeps every file the lead wrote, so a turn that answered an event still holds the
 * list it delivered earlier — and that list may have been admitted by the daemon (a delivery
 * turn) or decided by the owner (the compatibility path). Both leave the same fact behind: the
 * run's own tasks. A list whose every task is already recorded with the same seat, paths and
 * brief is not a new request; a list that differs is admitted, and a repeated id is then refused
 * with that reason, which is what tells the lead to use new ids for new work.
 */
export function proposalAlreadyAdmitted(db: Database.Database, runId: string, tasks: readonly LeadTask[], seats?: LeadSeatChanges,
  resolutions?: readonly LeadResolution[]): boolean {
  if (seats !== undefined || resolutions !== undefined) {
    return !!db.prepare(`SELECT 1 FROM team_control_requests WHERE run_id = ?
      AND json_extract(response_json, '$.status') = 'accepted'
      AND json_extract(response_json, '$.value.proposalDigest') = ? LIMIT 1`)
      .get(runId, hashBytes(canonicalJson({ tasks, ...(seats === undefined ? {} : { seats }),
        ...(resolutions === undefined ? {} : { resolutions }) })));
  }
  const existing = db.prepare(`SELECT a.task_id AS taskId, q.destination_session AS seat, q.body AS body,
      a.assignment_json AS assignment FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
    WHERE a.run_id = ?`).all(runId) as Array<{ taskId: string; seat: string; body: string; assignment: string }>;
  const byId = new Map(existing.map(row => [row.taskId, row]));
  return tasks.every(task => {
    const row = byId.get(task.taskId);
    if (!row || row.seat !== task.seat || row.body !== task.body) return false;
    try {
      const assignment = parseAssignment(JSON.parse(row.assignment));
      return assignment.role === "implementer" && assignment.paths.length === task.paths.length
        && assignment.paths.every((path, index) => path === task.paths[index]);
    } catch { return false; }
  });
}

/**
 * The sentence a proposal the boundary refused reaches the lead with.
 *
 * The parse boundary names the field it refused. The two fields a lead actually gets wrong are
 * translated into what to do next; everything else is the boundary's own words, which already
 * name the field.
 */
export function proposalRefusalReason(error: unknown): string {
  if (error instanceof TeamContractError) {
    if (error.field === "proposal.paths" || error.field === "paths") {
      return "A task in your list names no write paths. Every task must own the files it writes; " +
        "the review of a finished task is created by the daemon, so it is not a task you propose.";
    }
    if (error.field === "proposal.taskId") return "Two tasks in your list share a task id. Use a new id for each task.";
  }
  return error instanceof Error ? error.message : String(error);
}

/** The event keys an earlier wake already delivered to this run's lead. */
export function deliveredLeadEvents(db: Database.Database, runId: string): Set<string> {
  const rows = db.prepare(`SELECT json_extract(payload, '$.payload.keys') AS keys FROM events
    WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ?
      AND json_extract(payload, '$.action') = 'lead.woken'
      AND json_extract(payload, '$.payload.keys') IS NOT NULL ORDER BY seq`).all(runId) as Array<{ keys: string }>;
  const keys = new Set<string>();
  for (const row of rows) {
    try { for (const key of JSON.parse(row.keys) as string[]) keys.add(key); } catch {
      // A wake this reader cannot parse tells it nothing, so its facts are still undelivered.
    }
  }
  return keys;
}

export function composeLeadManager(dependencies: LeadManagerDependencies): LeadManager {
  const { db, governance } = dependencies;
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  const request = (runId: string, actionId: string, idempotencyKey: string): ControlRequest<JsonValue> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId, actionId, idempotencyKey,
    expectedEntityVersion: governance.getRun(runId).entityVersion, payload: {},
  });
  const dispatchLead = async (runId: string, taskId: string): Promise<void> => {
    const dispatch = dependencies.dispatch();
    if (!dispatch) return;
    try { await dispatch(runId, taskId); }
    catch (error) { log(`team lead: the launch for run=${runId} task=${taskId} did not start: ${error instanceof Error ? error.message : String(error)}`); }
  };
  // One sweep at a time: two overlapping ticks would read the same undelivered facts before
  // either recorded them. The guard is per process and per manager, which is the scope of the
  // wake it protects.
  let sweeping = false;
  let wakes = 0;

  return {
    /**
     * The lead's turn end, for the half that is not its chat message.
     *
     * The decomposition is admitted at once and against the binding the run is bound to right
     * now, exactly as every other control command reconciles it. A refusal has already reopened
     * the lead inside the command, and the launch that follows resumes the conversation with
     * the reason in its prompt.
     */
    async turnEnd(attempt) {
      if (attempt.role !== "lead") return;
      const run = governance.getRun(attempt.runId);
      // A planning lead is the conversation with the owner; its deliverable is the plan, and
      // nothing is admitted before the owner approves it.
      if (run.phase !== "delivery" || run.state !== "approved") return;
      const lead = governance.leadTask(attempt.runId);
      if (!lead || !dependencies.readLeadProposal) return;
      let tasks: readonly LeadTask[], seats: LeadSeatChanges | undefined, resolutions: readonly LeadResolution[] | undefined;
      try {
        const proposal = dependencies.readLeadProposal(attempt.runId, lead.taskId);
        if ("tasks" in proposal) { tasks = proposal.tasks; seats = proposal.seats; resolutions = proposal.resolutions; }
        else tasks = proposal;
      }
      catch (error) {
        // No proposal in the tree is a management turn that answered in the chat instead, and
        // there is nothing to admit. A proposal the boundary read and refused is work the lead
        // must redo: it is refused through the same event and reopen a plan-coverage refusal
        // uses, so the reason is its next prompt. Swallowing it would leave the run with a
        // failed task and nobody told why.
        if (error instanceof LeadProposalMissingError) return;
        const refusal = (() => {
          try {
            return governance.refuseLeadTasks(
              request(attempt.runId, "lead-refusal-" + attempt.id, "daemon-lead-refusal:" + attempt.id),
              daemon, dependencies.currentBinding(attempt.runId), proposalRefusalReason(error));
          } catch (refused) {
            // The same turn observed twice: the stored receipt names the entity version it was
            // recorded at, so an exact replay cannot be rebuilt. Nothing was refused twice.
            if (/bound to another exact request/.test((refused as Error).message)) return null;
            throw refused;
          }
        })();
        if (refusal?.effectMayStart && refusal.revisionTaskId) await dispatchLead(attempt.runId, refusal.revisionTaskId);
        return;
      }
      // The tree keeps every file the lead wrote, so a turn that answered an event still holds
      // the list it delivered earlier. That list is not a new request.
      if (proposalAlreadyAdmitted(db, attempt.runId, tasks, seats, resolutions)) return;
      const receipt = (() => {
        try {
          return governance.admitLeadProposal(
            request(attempt.runId, "lead-admission-" + attempt.id, "daemon-lead-admission:" + attempt.id),
            daemon, dependencies.currentBinding(attempt.runId), tasks, seats, dependencies.readMaxSeats?.() ?? 6, resolutions);
        } catch (error) {
          // The attempt already admitted its list and the run has moved since: the stored
          // receipt names the entity version it was recorded at, so an exact replay cannot be
          // rebuilt. Nothing was admitted twice, which is the fact that matters here.
          if (/bound to another exact request/.test((error as Error).message)) return null;
          throw error;
        }
      })();
      if (receipt === null) return;
      if (receipt.status === "denied") {
        log(`team lead: run=${attempt.runId} refused the lead's task list: ${receipt.reason ?? "no reason recorded"}`);
      }
      if (receipt.effectMayStart && receipt.revisionTaskId) await dispatchLead(attempt.runId, receipt.revisionTaskId);
    },

    /**
     * Wake the lead for what its team did, once per event.
     *
     * One wake collects everything one sweep found, so two tasks failing together is one turn.
     * A lead already answering a turn is left alone and the events wait for it: waking it
     * mid-turn would put a second conversation in the same seat. Once a wake is recorded, the
     * keys it carried are what the next sweep subtracts, so nothing is told twice.
     */
    async sweep() {
      if (sweeping) return;
      sweeping = true;
      try {
        const runs = db.prepare("SELECT id FROM team_runs WHERE state = 'approved' AND phase = 'delivery' ORDER BY rowid")
          .all() as Array<{ id: string }>;
        for (const { id: runId } of runs) {
          try {
            const lead = governance.leadTask(runId);
            if (!lead) continue;
            if (governance.openAttemptCount(lead.qitemId) > 0) continue;
            const state = governance.queueState(lead.qitemId);
            if (state !== "pending" && state !== "in-progress" && state !== "done" && state !== "handed-off") continue;
            const told = deliveredLeadEvents(db, runId);
            const events = leadTeamEvents(db, runId).filter(event => !told.has(event.key));
            if (!events.length) continue;
            // The keys are what stops a second wake; the counter keeps each attempt its own
            // exact request, so a refusal this tick can be tried again on the next one instead
            // of replaying the stored denial forever.
            const receipt = governance.wakeLeadTask(
              request(runId, "lead-wake", `daemon-lead-wake:${runId}:${++wakes}`),
              daemon, dependencies.currentBinding(runId), events);
            if (receipt.status !== "accepted") {
              log(`team lead: run=${runId} was not woken: ${receipt.reason ?? receipt.status}`);
              continue;
            }
            await dispatchLead(runId, lead.taskId);
          } catch (error) {
            log(`team lead: run=${runId} could not be woken: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally {
        sweeping = false;
      }
    },
  };
}