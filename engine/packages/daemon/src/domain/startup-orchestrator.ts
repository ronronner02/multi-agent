import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { RuntimeAdapter, NodeBinding, ManagedAttempt, ResolvedStartupFile } from "./runtime-adapter.js";
import type { ProjectionPlan } from "./projection-planner.js";
import type { StartupAction } from "./types.js";
import { managedTurnPrompt, writeAgentTurnPrompt, agentTurnOutputPaths } from "./agent-turn.js";

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
      const prompt = managedTurnPrompt({ identity: "", bundle: "", runId: attempt.context.runId, assignment: attempt.context.assignment,
        taskBody: this.taskBody(input.taskId), outputs: attempt.context.outputs, permissions: attempt.context.permissions,
        instructions: attempt.context.files.map((file) => ({ path: file.workerPath })),
        continuation: input.continueSessionId ? "Continue the existing native conversation." : null,
        taskReportPath: agentTurnOutputPaths(attempt.context.mutableStateRoot, attempt.attemptId).taskReport, workflow: attempt.context.workflow });
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
  private taskBody(taskId?: string): string { if (!taskId) return "Complete the assigned managed task."; const row = this.db.prepare("SELECT body FROM queue_items WHERE qitem_id = ?").get(taskId) as { body?: string } | undefined; return row?.body ?? "Complete the assigned managed task."; }
}
