import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RuntimeAdapter, NodeBinding } from "./runtime-adapter.js";
import type { StartupOrchestrator } from "./startup-orchestrator.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { ensureSeatPane, seatForTask } from "./seat-pane.js";
import { parseAttemptClassification } from "./attempt-failure.js";

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
  tmux: TmuxAdapter;
  startupOrchestrator: StartupOrchestrator;
  runtimeAdapters: Record<string, RuntimeAdapter>;
  sessionEnv?: Record<string, string | undefined>;
  runtimeSessionEnv?: Record<string, Record<string, string | undefined>>;
}

export type TaskDispatch = (runId: string, taskId: string) => Promise<void>;

export function composeTaskDispatch(dependencies: TaskDispatchDependencies): TaskDispatch {
  // The sessions this dispatcher is already starting. `startNode` records `pending` before its
  // first await, so this covers only the window where a second dispatch would still read the
  // seat as pending and open a second terminal for it.
  const starting = new Set<string>();
  return async (runId, taskId) => {
    const seat = seatForTask(dependencies.sessions, runId, taskId);
    const context = dependencies.sessions.findResumeContextByName(seat);
    const session = context ? dependencies.sessions.getSessionsForRig(context.rigId)
      .find(row => row.id === context.sessionId) : undefined;
    const node = context ? dependencies.rigRepo.getRig(context.rigId)?.nodes.find(row => row.id === context.nodeId) : undefined;
    const adapter = node?.runtime ? dependencies.runtimeAdapters[node.runtime] : undefined;
    // Only a seat that has never launched starts here. A ready seat already has an agent, and
    // an attention or failed one is the owner's to reconcile; either way it is not this
    // dispatch's to overwrite. `starting` covers the window before that state is recorded.
    if (!context || !session || !node?.cwd || !adapter || session.startupStatus !== "pending"
      || starting.has(session.id)) return;
    starting.add(session.id);
    try {
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
      // the launch, so the client starts a fresh session in the same candidate tree and keeps
      // every file the failed attempt wrote. Nothing else about the tree changes.
      if (resumeUnsafe(dependencies, runId, taskId)) dependencies.sessions.clearResumeToken(session.id);
      await dependencies.startupOrchestrator.startNode({ rigId: context.rigId, nodeId: node.id, sessionId: session.id,
        binding, adapter,
        plan: { runtime: adapter.runtime, cwd: node.cwd, entries: [], startup: { files: [], actions: [] },
          conflicts: [], noOps: [], diagnostics: [] },
        resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: seat,
        includeDurableObligations: true, allowFreshFallback: false });
    } finally {
      starting.delete(session.id);
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
