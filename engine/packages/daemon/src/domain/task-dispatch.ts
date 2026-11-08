import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RuntimeAdapter, NodeBinding } from "./runtime-adapter.js";
import type { StartupOrchestrator } from "./startup-orchestrator.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { ensureSeatPane, seatForTask } from "./seat-pane.js";
import { isRetiredTeamNode } from "./team-setup.js";
import { retryIsDue, parseAttemptClassification } from "./attempt-failure.js";
import { ownerMessageSlot } from "./lead-chat.js";

/**
 * MVP — the launch an owner's start produces.
 *
 * Creating a run and a task puts work on a seat; it does not start anything. On a fresh
 * install nothing else does either — `rig up` is what boots a seat's agent in a personal rig,
 * and a managed daemon refuses it — so the task would sit pending forever. This is the one
 * owner of "a new task starts the agent that has to do it": the start request hands its task
 * here, and the seat's own session record is what makes the dispatch idempotent. A session
 * that is already ready, or already starting, is left alone, so a repeated start and a second
 * task on the same seat never start a second client.
 *
 * Only `workers.isolation: none` composes this. Under hardened isolation an agent is launched
 * by the privileged launcher under a policy this daemon does not own, so the start endpoint
 * keeps its existing behaviour there.
 */

export interface TaskDispatchDependencies {
  rigRepo: RigRepository;
  sessions: SessionRegistry;
  now?: () => Date;
  tmux: TmuxAdapter;
  startupOrchestrator: StartupOrchestrator;
  runtimeAdapters: Record<string, RuntimeAdapter>;
  sessionEnv?: Record<string, string | undefined>;
  runtimeSessionEnv?: Record<string, Record<string, string | undefined>>;
  /** The run's live-session limit, as its binding states it. */
  maxSessions: (runId: string) => number;
  /** How many of the run's attempts are live right now, read the way governance counts them. */
  liveSessions: (runId: string) => number;
  /** Renew a near-expiry implementation approval at the dispatch boundary. */
  renewApproval?: (runId: string) => boolean;
  /** Refresh a delivery lead's tree; true means its workspace path changed. */
  prepareDeliveryLeadTurn?: (runId: string, taskId: string) => boolean;
}

export type TaskDispatch = (runId: string, taskId: string) => Promise<void>;

/**
 * Put a seat whose last launch failed back to the state a never-launched seat has.
 *
 * A launch that fails after the seat is marked `failed` used to wedge the seat for the life of
 * the run: the dispatcher starts only a `pending` seat, and the owner surfaces that could clear
 * one (`rig seat clean`, `rig seat launch`) are legacy verbs a managed daemon refuses. The C4
 * acceptance run hit exactly that — a launch pasted into a held-but-dead pane, failed, and left
 * the seat `failed`, so the task it was starting could never be dispatched again.
 *
 * The same holds for a seat that still says `ready` while its pane is dead: the status is then
 * stale rather than true, and a launch into that pane fails the same way. Both conditions are
 * what `paneDead` reports, and both are recovered here.
 *
 * Recovery is one dispatch's own business, not a new owner surface: the seat's pane is released
 * through the seat-pane owner's own adapter (a dead held pane is put back to a live shell; a live
 * one is left alone), and the session's startup status returns to `pending`, which is what the
 * dispatcher reads. Nothing else about the seat is rewritten — the resume token, the binding and
 * the candidate all stay, so the retry continues the same conversation in the same tree.
 */
async function recoverFailedSeat(dependencies: TaskDispatchDependencies, sessionId: string,
  nodeId: string, seat: string, pane: string | null, paneDead: boolean): Promise<void> {
  if (pane !== null && paneDead) await dependencies.tmux.respawnPane(pane);
  dependencies.sessions.updateStartupStatus(sessionId, "pending");
  console.warn(`team dispatch: recovered seat ${seat} for one launch` +
    ` (${pane === null ? "no pane recorded" : paneDead ? `pane ${pane} respawned` : `pane ${pane} kept`})`);
}

export function composeTaskDispatch(dependencies: TaskDispatchDependencies): TaskDispatch {
  // The sessions this dispatcher is already starting. `startNode` records `pending` before its
  // first await, so this covers only the window where a second dispatch would still read the
  // seat as pending and open a second terminal for it.
  const starting = new Map<string, string>();
  return async (runId, taskId) => {
    const timing = dependencies.sessions.db.prepare(`SELECT json_extract(evidence_json, '$.retryNotBefore') AS notBefore
      FROM team_queue_authority WHERE run_id = ? AND task_id = ?`).get(runId, taskId) as { notBefore: string | null } | undefined;
    if (!retryIsDue(timing?.notBefore, dependencies.now?.())) return;
    const seat = seatForTask(dependencies.sessions, runId, taskId);
    const context = dependencies.sessions.findResumeContextByName(seat);
    const session = context ? dependencies.sessions.getSessionsForRig(context.rigId)
      .find(row => row.id === context.sessionId) : undefined;
    const node = context ? dependencies.rigRepo.getRig(context.rigId)?.nodes.find(row => row.id === context.nodeId) : undefined;
    if (node && isRetiredTeamNode(dependencies.rigRepo.db, node.id)) return;
    const adapter = node?.runtime ? dependencies.runtimeAdapters[node.runtime] : undefined;
    // The seat's terminal, when it has one. A `ready` seat is skipped below, but a `ready` seat
    // whose pane is dead has no agent in it: the status is stale, not the truth, and the launch
    // that follows would paste into a dead pane. So the pane's own state is read here too. A
    // daemon that cannot read panes reports no evidence, which is never "dead".
    const boundPane = context ? dependencies.sessions.getBindingForNode(context.nodeId)?.tmuxPane ?? null : null;
    const paneDead = boundPane === null || !dependencies.tmux.getPaneExit
      ? false : (await dependencies.tmux.getPaneExit(boundPane))?.dead === true;
    // A seat this dispatch may start: one that has never launched (`pending`), one whose last
    // launch failed (`failed`), one waiting on a native prompt (`attention_required`), or one
    // that claims to be `ready` while its pane is dead. A live `ready` seat already has an agent.
    if (!context || !session || !node?.cwd || !adapter || starting.has(seat)
      || !(session.startupStatus === "pending" || session.startupStatus === "failed"
        || session.startupStatus === "attention_required"
        || (session.startupStatus === "ready" && paneDead))) return;
    // A short turn may exit before the next sweep registers its receipt. Its dead pane is
    // still occupied until that observation closes it; recovering it early launches the task twice.
    const receipts = dependencies.sessions.db.prepare(`SELECT json_extract(e.payload, '$.sessionName') AS seat,
        json_extract(e.payload, '$.runId') AS runId, a.id AS registeredId FROM events e
      LEFT JOIN team_attempts a ON a.id = json_extract(e.payload, '$.receipt.attemptId')
      WHERE e.type = 'managed.attempt.receipt'
        AND (json_extract(e.payload, '$.runId') = ? OR json_extract(e.payload, '$.sessionName') = ?)
        AND (a.id IS NULL OR a.state <> 'stopped')`).all(runId, seat) as Array<{ seat: string; runId: string; registeredId: string | null }>;
    if (receipts.some(receipt => receipt.seat === seat)) return;
    const unregistered = new Set(receipts.filter(receipt => receipt.runId === runId && receipt.registeredId === null).map(receipt => receipt.seat));
    for (const [startingSeat, startingRun] of starting) if (startingRun === runId) unregistered.add(startingSeat);
    // MVP — the run's live-session limit is asked *before* the client starts. The governance
    // gate that already enforces it runs when the launch's receipt is registered, a second
    // later: by then the client is running, and a refused registration leaves an attempt nothing
    // observes ending. A task over the limit stays pending and the next freed slot dispatches it.
    if (dependencies.liveSessions(runId) + unregistered.size >= dependencies.maxSessions(runId)
      + ownerMessageSlot(dependencies.sessions.db, runId, taskId)) return;
    starting.set(seat, runId);
    try {
      dependencies.renewApproval?.(runId);
      // A seat whose last launch failed is recovered once, in this dispatch: its terminal is put
      // back to a live shell and its startup status to the state a never-launched seat has. The
      // launch then proceeds exactly as it does for a fresh seat. A second failure leaves the
      // seat `failed` again — the launch records that itself — and the next dispatch is what
      // tries again, so there is no loop here and no retry beyond this one recovery.
      if (session.startupStatus === "failed" || session.startupStatus === "attention_required" || paneDead) {
        await recoverFailedSeat(dependencies, session.id, node.id, seat, boundPane, paneDead);
      }
      await ensureSeatPane(dependencies, seat);
      // The terminal just opened is recorded as this node's binding, so the launch reads the
      // one binding record rather than a second copy invented here.
      const recorded = dependencies.sessions.getBindingForNode(node.id);
      if (!recorded) return;
      const binding: NodeBinding = { ...recorded, cwd: node.cwd,
        ...(node.model ? { model: node.model } : {}), ...(node.effort ? { effort: node.effort } : {}),
        ...(node.codexConfigProfile ? { codexConfigProfile: node.codexConfigProfile } : {}) };
      // A seat this dispatch serves has never launched, so it holds no saved startup context.
      // Its agent starts with the role and plan it is given, which is what the task carries.
      // T033 — a task reopened by an eligible retry whose failure was `resume_safe: false` must
      // not continue the poisoned conversation. The seat's saved native token is cleared before
      // launch. A delivery lead keeps its conversation when a refreshed tree uses the same path.
      const leadPathChanged = dependencies.prepareDeliveryLeadTurn?.(runId, taskId) ?? false;
      const unsafe = leadPathChanged || resumeUnsafe(dependencies, runId, taskId);
      if (unsafe) dependencies.sessions.clearResumeToken(session.id);
      // MVP — a task this seat already ran is a continuation, not a fresh start: the rework
      // after a review, the lead's revision after a rejection, or a retry the classifier called
      // resume-safe. Its next attempt continues that conversation, so the agent still holds the
      // tree, the brief and what it was told to fix. The token is the run's own record of it.
      const previous = dependencies.sessions.db.prepare(`
        SELECT json_extract(e.payload, '$.receipt.identity.nativeSessionId') AS token
        FROM events e JOIN team_attempts a ON a.id = json_extract(e.payload, '$.receipt.attemptId')
        JOIN team_queue_authority q ON q.qitem_id = a.qitem_id
        WHERE e.type = 'managed.attempt.receipt' AND q.run_id = ? AND q.task_id = ? AND a.state = 'stopped'
          AND json_extract(e.payload, '$.sessionName') = ? AND json_extract(e.payload, '$.receipt.client') = ?
        ORDER BY e.seq DESC LIMIT 1`).get(runId, taskId, seat, adapter.runtime) as { token: string | null } | undefined;
      const continueSessionId = !unsafe && previous?.token ? previous.token : undefined;
      const started = await dependencies.startupOrchestrator.startNode({ rigId: context.rigId, nodeId: node.id, sessionId: session.id,
        binding, adapter,
        plan: { runtime: adapter.runtime, cwd: node.cwd, entries: [], startup: { files: [], actions: [] },
          conflicts: [], noOps: [], diagnostics: [] },
        resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: seat,
        // The task this dispatch is starting. A seat can hold two live tasks — two completed
        // implementers are two pending reviews on the same reviewer seat — and the launch
        // composition must be told which one it is starting rather than refusing both.
        runId, taskId,
        ...(continueSessionId ? { continueSessionId } : {}),
        includeDurableObligations: true, allowFreshFallback: false });
      if (!started.ok) {
        const detail = started.errors.join("; ");
        console.warn(`team dispatch: seat ${seat} remains ${started.startupStatus}; ${detail || started.recovery || "recovery requires owner attention"}`);
      }
    } finally {
      starting.delete(seat);
    }
  };
}

/**
 * T033 — whether the task's most recent ended attempt is one KTD20 says must not be resumed.
 *
 * A dispatch is about to start this seat's client, and a seat can carry a saved native token
 * from the attempt that just failed. `resume_safe: false` is the classifier's answer that the
 * conversation is poisoned, so the next launch has to be a fresh session on the same tree. An
 * attempt with no classification is not unsafe by default — there is no failure to continue —
 * so this asks the stored decision rather than guessing at one.
 */
function resumeUnsafe(dependencies: TaskDispatchDependencies, runId: string, taskId: string): boolean {
  const row = dependencies.sessions.db.prepare(`
    SELECT a.failure_json AS failureJson
    FROM team_attempts a JOIN team_queue_authority q ON q.qitem_id = a.qitem_id
    WHERE q.run_id = ? AND q.task_id = ? AND a.state = 'stopped'
    ORDER BY a.rowid DESC LIMIT 1`).get(runId, taskId) as { failureJson: string | null } | undefined;
  if (!row?.failureJson) return false;
  try {
    return !parseAttemptClassification(JSON.parse(row.failureJson)).resumeSafe;
  } catch {
    // A stored classification that disagrees with its own code is refused rather than acted on;
    // the safe answer for a continuation is not to resume a conversation nothing vouched for.
    return true;
  }
}
