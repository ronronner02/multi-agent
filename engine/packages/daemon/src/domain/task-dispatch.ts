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

export function composeTaskDispatch(deps: TaskDispatchDependencies): TaskDispatch {
  const starting = new Set<string>();
  return async (runId, taskId) => {
    const timing = deps.sessions.db.prepare(`SELECT json_extract(evidence_json, '$.retryNotBefore') AS notBefore FROM team_queue_authority WHERE run_id = ? AND task_id = ?`).get(runId, taskId) as { notBefore: string | null } | undefined;
    if (!retryIsDue(timing?.notBefore, deps.now?.())) return;
    const row = deps.sessions.db.prepare(`SELECT q.destination_session AS seat, a.qitem_id AS qitemId, a.task_id AS taskId FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id WHERE a.run_id = ? AND a.task_id = ?`).get(runId, taskId) as { seat: string; qitemId: string; taskId: string } | undefined;
    if (!row || starting.has(row.seat)) return;
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
      if (!started.ok) console.warn(`team dispatch: seat ${row.seat} remains ${started.startupStatus}; ${started.errors.join("; ")}`);
    } finally { starting.delete(row.seat); }
  };
}

function resumeUnsafe(deps: TaskDispatchDependencies, runId: string, taskId: string): boolean {
  const row = deps.sessions.db.prepare(`SELECT a.failure_json AS failureJson FROM team_attempts a JOIN team_queue_authority q ON q.qitem_id = a.qitem_id WHERE q.run_id = ? AND q.task_id = ? AND a.state = 'stopped' ORDER BY a.rowid DESC LIMIT 1`).get(runId, taskId) as { failureJson: string | null } | undefined;
  if (!row?.failureJson) return false;
  try { return !parseAttemptClassification(JSON.parse(row.failureJson)).resumeSafe; } catch { return true; }
}
