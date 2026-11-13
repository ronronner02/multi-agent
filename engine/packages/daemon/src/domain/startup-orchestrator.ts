import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { RuntimeAdapter, NodeBinding, ManagedAttempt, ResolvedStartupFile } from "./runtime-adapter.js";
import type { ProjectionPlan } from "./projection-planner.js";
import type { StartupAction } from "./types.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { handbackPath, takeTaskComments, taskCommentNote, taskCommentNotices } from "./task-thread.js";
import { managedTurnPrompt, writeAgentTurnPrompt, agentTurnOutputPaths, boundedOwnerWords, continuationNote, leadProgressNote } from "./agent-turn.js";
import { leadChatTurnNote, listChatMessages, responseLanguageNote, runLeadTask, takeOwnerMessages, type ResponseLanguage } from "./lead-chat.js";
import { unassignedOwnerWorkflows } from "./team-workflows.js";
import type { ScopedAssignment, TeamRole } from "../contracts/team-control.js";

export interface StartupInput {
  rigId: string; nodeId: string; sessionId: string; binding: NodeBinding; adapter: RuntimeAdapter;
  plan: ProjectionPlan; resolvedStartupFiles: ResolvedStartupFile[]; startupActions: StartupAction[]; isRestore: boolean;
  sessionName?: string; taskId?: string; runId?: string; resumeToken?: string; continueSessionId?: string; resumeType?: string;
  forkSource?: { kind: "native_id" | "artifact_path" | "name" | "last"; value?: string };
  rebuildArtifacts?: ResolvedStartupFile[]; skipHarnessLaunch?: boolean; allowFreshFallback?: boolean;
  preserveStartupContext?: boolean; continueFreshStartup?: boolean; assertContinuation?: () => void;
  includeDurableObligations?: boolean; readinessTimeoutMs?: number;
}

export type StartupResult = { warnings?: string[] } & (
  | { ok: true; startupStatus: "ready"; continuityOutcome: "resumed" | "fresh" | "forked" | "rebuilt"; submission?: { status: "unverified" | "staged"; reasons: string[] } }
  | { ok: false; startupStatus: "attention_required" | "failed"; errors: string[]; recovery?: string }
);

export function hasPendingFreshStartup(db: Database.Database, nodeId: string, sessionId: string): boolean {
  const row = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed') ORDER BY seq DESC LIMIT 1").get(nodeId) as { payload: string } | undefined;
  if (!row) return false;
  try { const event = JSON.parse(row.payload) as Record<string, unknown>; return event.type === "node.startup_failed" && event.sessionId === sessionId && event.freshContextPending === true; } catch { return false; }
}

interface StartupOrchestratorDeps { db: Database.Database; sessionRegistry: SessionRegistry; eventBus: EventBus; managedAttempt?: (input: StartupInput) => Promise<ManagedAttempt | undefined>; }

/** Native startup coordinator. Every retained launch is a direct child turn. */
export class StartupOrchestrator {
  readonly db: Database.Database;
  private readonly sessions: SessionRegistry;
  private readonly events: EventBus;
  private readonly resolveAttempt?: StartupOrchestratorDeps["managedAttempt"];
  private readonly pending = new Map<string, { sessionId: string; binding: NodeBinding }>();

  constructor(deps: StartupOrchestratorDeps) {
    if (deps.db !== deps.sessionRegistry.db || deps.db !== deps.eventBus.db) throw new Error("StartupOrchestrator dependencies must share the same database");
    this.db = deps.db; this.sessions = deps.sessionRegistry; this.events = deps.eventBus; this.resolveAttempt = deps.managedAttempt;
  }
  pendingManagedBinding(nodeId: string, sessionId: string): NodeBinding | null { const value = this.pending.get(nodeId); return value?.sessionId === sessionId ? value.binding : null; }
  canContinueFresh(nodeId: string, sessionId: string): boolean { return this.pending.get(nodeId)?.sessionId === sessionId; }

  async startNode(input: StartupInput): Promise<StartupResult> {
    const binding = { ...input.binding };
    try {
      if (!binding.managedAttempt && this.resolveAttempt) binding.managedAttempt = await this.resolveAttempt({ ...input, binding });
      if (!binding.managedAttempt) return { ok: false, startupStatus: "failed", errors: ["Native managed attempt is unavailable"] };
      this.sessions.updateStartupStatus(input.sessionId, "pending");
      this.events.emit({ type: "node.startup_pending", rigId: input.rigId, nodeId: input.nodeId });
      const projection = await input.adapter.project(input.plan, binding);
      if (projection.failed.length) throw new Error(projection.failed.map((item) => item.error).join("; "));
      const delivered = await input.adapter.deliverStartup(input.resolvedStartupFiles, binding);
      if (delivered.failed.length) throw new Error(delivered.failed.map((item) => item.error).join("; "));
      const attempt = binding.managedAttempt;
      const { runId, assignment } = attempt.context;
      const prompt = managedTurnPrompt({ identity: "", bundle: "", runId, assignment,
        taskBody: this.taskBody(runId, assignment.taskId), outputs: attempt.context.outputs, permissions: attempt.context.permissions,
        instructions: attempt.context.files.map((file) => ({ path: file.workerPath })),
        continuation: this.continuation(runId, assignment.taskId, assignment.role, attempt.attemptId, Boolean(input.continueSessionId),
          attempt.context.mutableStateRoot),
        taskReportPath: agentTurnOutputPaths(attempt.context.mutableStateRoot, attempt.attemptId).taskReport, workflow: attempt.context.workflow,
        ...(assignment.role === "lead" ? {} : { ownerWords: this.ownerWords(runId),
          evidenceDirectory: this.evidenceDirectory(attempt.context.mutableStateRoot, runId, assignment, attempt.attemptId) }) });
      writeAgentTurnPrompt(attempt.context, prompt);
      this.pending.set(input.nodeId, { sessionId: input.sessionId, binding });
      const launch = input.skipHarnessLaunch ? { ok: true as const } : await input.adapter.launchHarness(binding, { name: input.sessionName ?? input.sessionId,
        ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}), ...(input.continueSessionId ? { continueSessionId: input.continueSessionId } : {}), ...(input.forkSource ? { forkSource: input.forkSource } : {}) });
      if (!launch.ok) throw new Error(launch.error);
      const ready = input.skipHarnessLaunch ? { ready: true } : await input.adapter.checkReady(binding);
      if (!ready.ready) throw new Error(ready.reason ?? ready.code ?? "Native worker is not ready");
      input.assertContinuation?.();
      this.sessions.updateStartupStatus(input.sessionId, "ready", new Date().toISOString());
      this.events.emit({ type: "node.startup_ready", rigId: input.rigId, nodeId: input.nodeId });
      return { ok: true, startupStatus: "ready", continuityOutcome: input.rebuildArtifacts ? "rebuilt" : input.resumeToken ? "resumed" : input.forkSource ? "forked" : "fresh" };
    } catch (error) {
      this.sessions.updateStartupStatus(input.sessionId, "failed");
      this.events.emit({ type: "node.startup_failed", rigId: input.rigId, nodeId: input.nodeId, sessionId: input.sessionId, error: error instanceof Error ? error.message : String(error) });
      this.pending.delete(input.nodeId);
      return { ok: false, startupStatus: "failed", errors: [error instanceof Error ? error.message : String(error)] };
    }
  }
  /** The run task's body: assignments name the run's task id, which is not the queue item's id. */
  private taskBody(runId: string, taskId: string): string {
    const row = this.db.prepare(`SELECT q.body FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
      WHERE a.run_id = ? AND a.task_id = ?`).get(runId, taskId) as { body?: string } | undefined;
    return row?.body ?? "Complete the assigned managed task.";
  }

  /** The run's goal as the owner wrote it: the lead task's body, which the start route stores verbatim. */
  private ownerWords(runId: string): string | null {
    const lead = runLeadTask(this.db, runId);
    if (!lead) return null;
    const row = this.db.prepare("SELECT body FROM queue_items WHERE qitem_id = ?").get(lead.qitemId) as { body?: string } | undefined;
    return row?.body ? boundedOwnerWords(row.body) : null;
  }

  /**
   * An implementer saves UI captures beside its own turn output. A reviewer is pointed at the
   * directory of the latest attempt of the task it reviews, which is where those captures are.
   */
  private evidenceDirectory(root: string, runId: string, assignment: ScopedAssignment, attemptId: string): string | null {
    if (assignment.role === "implementer") return join(agentTurnOutputPaths(root, attemptId).directory, "evidence");
    if (assignment.role !== "reviewer" || !assignment.reviewOf) return null;
    const reviewed = this.db.prepare(`SELECT p.id FROM team_attempts p JOIN team_queue_authority a ON a.qitem_id = p.qitem_id
      WHERE a.run_id = ? AND a.task_id = ? ORDER BY p.rowid DESC LIMIT 1`).get(runId, assignment.reviewOf) as { id: string } | undefined;
    return reviewed ? join(agentTurnOutputPaths(root, reviewed.id).directory, "evidence") : null;
  }

  /**
   * Why this turn exists and what it must answer. A lead's turn is also where the owner's pending
   * messages are delivered: taking them marks them this attempt's, immediately before launch.
   */
  private continuation(runId: string, taskId: string, role: TeamRole, attemptId: string, resumes: boolean, root: string): string | null {
    const chat = role === "lead"
      ? leadChatTurnNote(takeOwnerMessages(this.db, runId, attemptId), listChatMessages(this.db, runId), unassignedOwnerWorkflows(this.db, runId))
      : null;
    // Plan KTD5 — an implementer's turn carries the owner's comments on its own task.
    const comments = role === "implementer"
      ? taskCommentNote(takeTaskComments(this.db, runId, taskId, attemptId), handbackPath(agentTurnOutputPaths(root, attemptId).taskReport))
      : null;
    const preference = this.db.prepare("SELECT response_language AS language FROM team_runs WHERE id = ?").get(runId) as
      { language: ResponseLanguage | null } | undefined;
    return [resumes ? "Continue the existing native conversation." : null, continuationNote(this.db, runId, taskId, role), chat,
      role === "implementer" ? this.followUpContext(runId, taskId, root) : null, comments,
      role === "lead" ? leadProgressNote(this.db, runId) : null, role === "lead" ? taskCommentNotices(this.db, runId) : null,
      responseLanguageNote(listChatMessages(this.db, runId), preference?.language)].filter(Boolean).join("\n\n") || null;
  }

  /**
   * A follow-up starts in its own tree, so it cannot resume the original task's native session.
   * It reads what that task was asked and what it reported instead.
   */
  private followUpContext(runId: string, taskId: string, root: string): string | null {
    const original = this.db.prepare(`SELECT o.task_id AS taskId, q.body AS body FROM team_queue_authority f
      JOIN team_queue_authority o ON o.run_id = f.run_id AND o.task_id = f.follow_up_of JOIN queue_items q ON q.qitem_id = o.qitem_id
      WHERE f.run_id = ? AND f.task_id = ?`).get(runId, taskId) as { taskId: string; body: string } | undefined;
    if (!original) return null;
    const last = this.db.prepare(`SELECT p.id FROM team_attempts p JOIN team_queue_authority a ON a.qitem_id = p.qitem_id
      WHERE a.run_id = ? AND a.task_id = ? AND p.state = 'stopped' ORDER BY p.rowid DESC LIMIT 1`).get(runId, original.taskId) as { id: string } | undefined;
    let report: string | null = null;
    if (last) {
      try { report = readFileSync(agentTurnOutputPaths(root, last.id).lastMessage, "utf8").trim().slice(0, 4_096); }
      catch { report = null; }
    }
    return [`This task follows up task ${original.taskId}, whose change is already on the run's branch your tree starts from.`,
      `Its brief:\n${original.body.slice(0, 4_096)}`, ...(report ? [`Its final report:\n${report}`] : [])].join("\n\n");
  }
}
