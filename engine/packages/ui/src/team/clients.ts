import type { AttemptActivity, TeamAttemptView, TurnProgress, DocumentPins, ProjectDocumentStage, ProjectDocumentVersion, ProjectDocumentWorkflow } from "@multi-agent/daemon/team-control";
import { OwnerReadError, type useOwnerSession } from "../hooks/useOwnerSession.js";

/**
 * U10 — the clients for the endpoints this surface reads.
 *
 * Chat is U5/U6's own routes; the integration branch is U7's. Each answers `{ available: false }`
 * when the route is absent, so a screen renders the state it can honestly show instead of an
 * error. Shapes here are the contract the components are built against.
 */

export type ResponseLanguage = "en" | "zh-CN";

type Request = ReturnType<typeof useOwnerSession>["request"];

export type RunPhase = "planning" | "delivery";

export interface ChatMessage {
  id: string;
  sender: "owner" | "lead";
  kind: "text" | "decision" | "confirmation";
  body: string;
  /** A decision's 2–4 choices; null on a text turn. */
  options: string[] | null;
  answeredBy: string | null;
  createdAt: string;
}

export interface PlanApproval {
  documentVersions?: DocumentPins;
  plan: { content: string; hash: string } | null;
  roster: { seats: { role: "implementer" | "reviewer"; client: "claude-code" | "codex"; model?: string }[]; digest: string } | null;
  error: string | null;
}

export interface LiveLeadTurn {
  attemptId: string; state: TeamAttemptView["state"]; progress: TurnProgress | null; activity: AttemptActivity | null;
}

export interface ChatState {
  liveTurn?: LiveLeadTurn | null;
  documentWorkflow?: ProjectDocumentWorkflow | null;
  available: boolean;
  phase: RunPhase;
  messages: ChatMessage[];
  /** The newest unanswered decision: the "waiting on you" signal. */
  pendingDecision: { id: string; body: string; options: string[]; createdAt: string } | null;
  /** Null identifies legacy planning without a roster; missing evidence is not approval-ready. */
  planApproval?: PlanApproval | null;
}

function controlBody(runId: string, actionId: string, entityVersion: number, payload: unknown) {
  return JSON.stringify({
    protocolVersion: "1.0", runId, actionId, expectedEntityVersion: entityVersion,
    idempotencyKey: crypto.randomUUID(), payload,
  });
}

/** U5 — `GET /runs/:runId/chat`. */
export async function readChat(request: Request, runId: string, signal?: AbortSignal): Promise<ChatState> {
  try {
    const body = await request<{ liveTurn?: LiveLeadTurn | null; messages?: ChatMessage[]; phase?: RunPhase; pendingDecision?: ChatState["pendingDecision"]; planApproval?: PlanApproval | null; documentWorkflow?: ProjectDocumentWorkflow | null }>(
      `/runs/${encodeURIComponent(runId)}/chat`, { signal },
    );
    return { available: true, messages: body.messages ?? [], phase: body.phase ?? "delivery",
      pendingDecision: body.pendingDecision ?? null, liveTurn: body.liveTurn ?? null, planApproval: body.planApproval, documentWorkflow: body.documentWorkflow };
  } catch (error) {
    if (error instanceof OwnerReadError && error.status === 404) {
      return { available: false, messages: [], phase: "delivery", pendingDecision: null };
    }
    throw error;
  }
}

/**
 * U6 — `POST /runs/:runId/chat`. Answering a decision sends the chosen option's text with
 * `answerTo`, which is how the lead knows which question it answers.
 */
export async function sendChatMessage(request: Request, runId: string, body: string, entityVersion: number, answerTo?: string, responseLanguage?: ResponseLanguage): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: controlBody(runId, crypto.randomUUID(), entityVersion, { body, ...(answerTo ? { answerTo } : {}), ...(responseLanguage ? { responseLanguage } : {}) }),
  });
}

/** Plan R7 — `POST /runs/:runId/tasks/:taskId/comments`: the owner's comment goes to that task's agent. */
export async function postTaskComment(request: Request, runId: string, taskId: string, body: string, entityVersion: number): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/comments`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: controlBody(runId, crypto.randomUUID(), entityVersion, { taskId, body }),
  });
}

export interface TaskComment { id: string; runId: string; taskId: string; body: string; createdAt: string; deliveredAttempt: string | null }

/** Plan R7 — `GET /runs/:runId/tasks/:taskId/comments`: the task's thread. */
export async function readTaskComments(request: Request, runId: string, taskId: string, signal?: AbortSignal): Promise<TaskComment[]> {
  const body = await request<{ comments?: TaskComment[] }>(`/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/comments`, { signal });
  return body.comments ?? [];
}

/** Plan R10 — `POST /runs/:runId/tasks/:taskId/hold`. */
export async function holdTask(request: Request, runId: string, taskId: string, held: boolean, entityVersion: number): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/hold`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: controlBody(runId, crypto.randomUUID(), entityVersion, { taskId, held }),
  });
}

/** U5 — `POST /runs/:runId/plan/approve`. */
export async function approvePlan(request: Request, runId: string, entityVersion: number, rosterDigest?: string, documentVersions?: DocumentPins, conversation?: { ownerMessage: string; planHash?: string }, responseLanguage?: ResponseLanguage): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/plan/approve`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: controlBody(runId, crypto.randomUUID(), entityVersion, { ...(rosterDigest ? { rosterDigest } : {}), ...(documentVersions ? { documentVersions } : {}), ...conversation, ...(responseLanguage ? { responseLanguage } : {}) }),
  });
}

export async function confirmDocument(request: Request, runId: string, entityVersion: number, version: ProjectDocumentVersion, ownerMessage?: string, responseLanguage?: ResponseLanguage): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/documents/confirm`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: controlBody(runId, crypto.randomUUID(), entityVersion, { kind: version.kind, versionId: version.id, hash: version.hash, ...(ownerMessage ? { ownerMessage } : {}), ...(responseLanguage ? { responseLanguage } : {}) }),
  });
}
export async function selectDocumentStage(request: Request, runId: string, entityVersion: number, stage: ProjectDocumentStage, ownerMessage?: string, responseLanguage?: ResponseLanguage): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/documents/stage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: controlBody(runId, crypto.randomUUID(), entityVersion, { stage, ...(ownerMessage ? { ownerMessage } : {}), ...(responseLanguage ? { responseLanguage } : {}) }),
  });
}

export interface IntegrationCommit { hash: string; subject: string; task: string }
export interface IntegrationState {
  available: boolean;
  branch: string;
  commits: IntegrationCommit[];
  /** Every task the run admitted has finished. */
  tasksDone: boolean;
  merge: { possible: boolean; reason: string | null; merged?: boolean | null };
  /** Plan R17 — the pull request a GitHub project's run is delivered through; the owner merges it on GitHub. */
  pullRequest?: IntegrationPullRequest | null;
}
export interface IntegrationPullRequest { number: number; url: string; state: "open" | "merged" | "closed" }

const ABSENT_INTEGRATION: IntegrationState = {
  available: false, branch: "", commits: [], tasksDone: false, merge: { possible: false, reason: null, merged: null }, pullRequest: null,
};

function pullRequestOf(value: unknown): IntegrationPullRequest | null {
  if (!value || typeof value !== "object") return null;
  const { number, url, state } = value as Record<string, unknown>;
  return typeof number === "number" && typeof url === "string" && /^https:\/\/github\.com\//.test(url)
    && (state === "open" || state === "merged" || state === "closed") ? { number, url, state } : null;
}

/** U7 — `GET /runs/:runId/integration`. */
export async function readIntegration(request: Request, runId: string, signal?: AbortSignal): Promise<IntegrationState> {
  try {
    const body = await request<{ integration?: Partial<IntegrationState>; pullRequest?: unknown }>(
      `/runs/${encodeURIComponent(runId)}/integration`, { signal },
    );
    const integration = body.integration;
    if (!integration) return { ...ABSENT_INTEGRATION };
    return {
      available: true,
      branch: integration.branch ?? "",
      commits: integration.commits ?? [],
      tasksDone: integration.tasksDone === true,
      merge: { possible: integration.merge?.possible === true, reason: integration.merge?.reason ?? null,
        merged: typeof integration.merge?.merged === "boolean" ? integration.merge.merged : null },
      pullRequest: pullRequestOf(body.pullRequest),
    };
  } catch (error) {
    if (error instanceof OwnerReadError && error.status === 404) return { ...ABSENT_INTEGRATION };
    throw error;
  }
}

export interface MergeOutcome {
  status: "merged" | "refused" | "conflict";
  code: string | null;
  reason: string | null;
  branch: string | null;
  mode: "fast-forward" | "merge-commit" | "up-to-date" | "pull-request" | null;
  head: string | null;
}

/**
 * U7 — `POST /runs/:runId/merge`. A refusal answers 409 with its own code, so the code is read
 * from the error rather than thrown at the owner. Neither `code` nor `reason` is rendered
 * verbatim: the screen maps the code to a label and names open tasks itself.
 */
export async function mergeBranch(request: Request, runId: string, entityVersion: number): Promise<MergeOutcome> {
  try {
    const body = await request<MergeOutcome>(`/runs/${encodeURIComponent(runId)}/merge`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: controlBody(runId, crypto.randomUUID(), entityVersion, {}),
    });
    return body;
  } catch (error) {
    if (error instanceof OwnerReadError && (error.status === 409 || error.status === 403 || error.status === 502)) {
      return { status: "refused", code: error.code, reason: null, branch: null, mode: null, head: null };
    }
    throw error;
  }
}

/** A run whose state still means work is going on, for the teams list. */
export function isRunActive(run: { state: string }): boolean {
  return run.state === "pending" || run.state === "approved" || run.state === "cancel_requested";
}
