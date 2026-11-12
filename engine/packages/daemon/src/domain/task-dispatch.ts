import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RuntimeAdapter, NodeBinding } from "./runtime-adapter.js";
import type { StartupOrchestrator } from "./startup-orchestrator.js";
import { isRetiredTeamNode } from "./team-setup.js";
import { retryIsDue, parseAttemptClassification } from "./attempt-failure.js";
import { ownerMessageSlot } from "./lead-chat.js";

export interface TaskDispatchDependencies {
  rigRepo: RigRepository; sessions: SessionRegistry; now?: () => Date; startupOrchestrator: StartupOrchestrator;
  runtimeAdapters: Record<string, RuntimeAdapter>; maxSessions: (runId: string) => number; liveSessions: (runId: string) => number;
  renewApproval?: (runId: string) => boolean; prepareDeliveryLeadTurn?: (runId: string, taskId: string) => boolean;
}
export type TaskDispatch = (runId: string, taskId: string) => Promise<void>;

/**
 * A launch refusal that is the owner's to answer, not the dispatcher's to repeat.
 *
 * Plan governance is the one admission step that can refuse with an outcome rather than a
 * failure: a scope stage says `plan-change-required` when a candidate writes outside the
 * approved paths, touches a protected path, or exhausts an extension cap, and `extension-pending`
 * when the owner has an extension to decide. Nothing the dispatcher can do turns either into a
 * launch. The plan has to change, or the owner has to decide, and until then every tick reads
 * the same refusal. Asking again wrote one `node.startup_failed` event and one log line per
 * second for the life of the daemon; a fresh project produced twelve in a few minutes, and a
 * night of it would have been tens of thousands.
 *
 * The refusal is recognised by the code `ScopeExtensionError` carries in its message, because
 * the launch boundary hands the dispatcher an `Error` rather than the typed refusal.
 */
export function ownerActionRefusal(message: string): boolean {
  return /^(?:plan-change-required|extension-pending): /.test(message);
}

export function composeTaskDispatch(deps: TaskDispatchDependencies): TaskDispatch {
  const starting = new Set<string>();
  // One refusal per (task, run version). The run's entity version moves with every governance
  // command, so an owner action is exactly what earns one more attempt; nothing else does.
  const refused = new Map<string, number>();
  // A launch that failed for another reason — an endpoint this host cannot bind, a client that
  // will not start — is retried, but not on the sweep's cadence. The first retry waits one
  // interval, each later one doubles it up to a minute, and any success or owner action resets
  // the count. The bound keeps a host-wide fault out of the event log; the retry keeps a
  // transient fault from wedging a seat permanently.
  const failures = new Map<string, { runVersion: number; attempts: number; notBefore: number }>();
  // The clock is read once per dispatch, so every deadline below agrees about "now".
  const now = () => deps.now?.() ?? new Date();
  return async (runId, taskId) => {
    const key = runId + "\u0000" + taskId;
    const timing = deps.sessions.db.prepare(`SELECT json_extract(evidence_json, '$.retryNotBefore') AS notBefore FROM team_queue_authority WHERE run_id = ? AND task_id = ?`).get(runId, taskId) as { notBefore: string | null } | undefined;
    if (!retryIsDue(timing?.notBefore, now())) return;
    const row = deps.sessions.db.prepare(`SELECT q.destination_session AS seat, a.qitem_id AS qitemId, a.task_id AS taskId, r.entity_version AS runVersion FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id JOIN team_runs r ON r.id = a.run_id WHERE a.run_id = ? AND a.task_id = ?`).get(runId, taskId) as { seat: string; qitemId: string; taskId: string; runVersion: number } | undefined;
    if (!row || starting.has(row.seat)) return;
    if (refused.get(key) === row.runVersion) return;
    const backoff = failures.get(key);
    if (backoff !== undefined && backoff.runVersion === row.runVersion && backoff.notBefore > now().getTime()) return;
    const context = deps.sessions.findResumeContextByName(row.seat);
    const session = context ? deps.sessions.getSessionsForRig(context.rigId).find(value => value.id === context.sessionId) : undefined;
    const node = context ? deps.rigRepo.getRig(context.rigId)?.nodes.find(value => value.id === context.nodeId) : undefined;
    const adapter = node?.runtime ? deps.runtimeAdapters[node.runtime] : undefined;
    if (!context || !session || !node?.cwd || !adapter || adapter.managedTransport !== "direct" || isRetiredTeamNode(deps.rigRepo.db, node.id)) return;
    if (!(session.startupStatus === "pending" || session.startupStatus === "failed" || session.startupStatus === "attention_required")) return;
    const receipts = deps.sessions.db.prepare(`SELECT json_extract(e.payload, '$.sessionName') AS seat FROM events e LEFT JOIN team_attempts a ON a.id = json_extract(e.payload, '$.receipt.attemptId') WHERE e.type = 'managed.attempt.receipt' AND json_extract(e.payload, '$.sessionName') = ? AND (a.id IS NULL OR a.state <> 'stopped')`).all(row.seat) as Array<{ seat: string }>;
    if (receipts.length) return;
    if (deps.liveSessions(runId) >= deps.maxSessions(runId) + ownerMessageSlot(deps.sessions.db, runId, taskId)) return;
    starting.add(row.seat);
    try {
      deps.renewApproval?.(runId);
      if (session.startupStatus !== "pending") deps.sessions.updateStartupStatus(session.id, "pending");
      const bindingRow = deps.sessions.getBindingForNode(node.id);
      const binding: NodeBinding = { ...(bindingRow ?? { id: `direct:${node.id}`, nodeId: node.id, attachmentType: "external_cli" as const, tmuxSession: row.seat, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "" }), cwd: node.cwd,
        ...(node.model ? { model: node.model } : {}), ...(node.effort ? { effort: node.effort } : {}), ...(node.codexConfigProfile ? { codexConfigProfile: node.codexConfigProfile } : {}) };
      const unsafe = (deps.prepareDeliveryLeadTurn?.(runId, taskId) ?? false) || resumeUnsafe(deps, runId, taskId);
      if (unsafe) deps.sessions.clearResumeToken(session.id);
      const previous = deps.sessions.db.prepare(`SELECT json_extract(e.payload, '$.receipt.identity.nativeSessionId') AS token FROM events e JOIN team_attempts a ON a.id = json_extract(e.payload, '$.receipt.attemptId') JOIN team_queue_authority q ON q.qitem_id = a.qitem_id WHERE e.type = 'managed.attempt.receipt' AND q.run_id = ? AND q.task_id = ? AND a.state = 'stopped' AND json_extract(e.payload, '$.sessionName') = ? AND json_extract(e.payload, '$.receipt.client') = ? ORDER BY e.seq DESC LIMIT 1`).get(runId, taskId, row.seat, adapter.runtime) as { token: string | null } | undefined;
      const started = await deps.startupOrchestrator.startNode({ rigId: context.rigId, nodeId: node.id, sessionId: session.id, binding, adapter,
        plan: { runtime: adapter.runtime, cwd: node.cwd, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: row.seat, runId, taskId,
        ...(!unsafe && previous?.token ? { continueSessionId: previous.token } : {}) });
      if (started.ok) { failures.delete(key); return; }
      // A refusal that is the owner's to answer is recorded once and then left alone. The launch
      // already wrote its `node.startup_failed`; repeating it on the dispatch cadence would only
      // restate the same decision, so the same (task, run version) is not asked twice.
      const refusal = started.errors.find(ownerActionRefusal);
      if (refusal !== undefined) {
        refused.set(key, row.runVersion);
        deps.sessions.updateStartupStatus(session.id, "attention_required");
        console.warn(`team dispatch: seat ${row.seat} is waiting on an owner decision and will not be retried; ${refusal}`);
        return;
      }
      // Every other failure is retried on a doubling interval, capped at a minute. The count is
      // held per run version so an owner action tries immediately, and it is only a backoff —
      // never a permanent refusal, because a host fault can be fixed while the daemon runs.
      const priorFailure = failures.get(key);
      const attempts = priorFailure?.runVersion === row.runVersion ? priorFailure.attempts + 1 : 1;
      failures.set(key, { runVersion: row.runVersion, attempts, notBefore: now().getTime() + Math.min(60_000, 1_000 * 2 ** (attempts - 1)) });
      console.warn(`team dispatch: seat ${row.seat} remains ${started.startupStatus}; ${started.errors.join("; ")} (retry ${attempts})`);
    } finally { starting.delete(row.seat); }
  };
}

function resumeUnsafe(deps: TaskDispatchDependencies, runId: string, taskId: string): boolean {
  const row = deps.sessions.db.prepare(`SELECT a.failure_json AS failureJson FROM team_attempts a JOIN team_queue_authority q ON q.qitem_id = a.qitem_id WHERE q.run_id = ? AND q.task_id = ? AND a.state = 'stopped' ORDER BY a.rowid DESC LIMIT 1`).get(runId, taskId) as { failureJson: string | null } | undefined;
  if (!row?.failureJson) return false;
  try { return !parseAttemptClassification(JSON.parse(row.failureJson)).resumeSafe; } catch { return true; }
}
