import { OwnerReadError, type useOwnerSession } from "../hooks/useOwnerSession.js";
import type { TeamRun, TeamRunState } from "@openrig/daemon/team-control";

/**
 * U10 — the client for the endpoints the design needs but the daemon does not serve yet.
 *
 * Each one answers `{ available: false }` when the route is absent, so the screens render the
 * state they can honestly show instead of an error. The shapes below are the contract these
 * screens are built against; when the units land, only this file changes.
 */

type Request = ReturnType<typeof useOwnerSession>["request"];

export interface ChatMessage {
  id: string;
  author: "owner" | "lead";
  /** The lead's seat, when the daemon names it. Rendered through the seat projection. */
  seat?: string | null;
  body: string;
  createdAt: string;
}

export interface ChatState { available: boolean; messages: ChatMessage[]; phase: RunPhase }
export type RunPhase = "planning" | "delivery";

/** U5 — `GET /runs/:runId/chat`. A run that has no chat yet answers with an empty list. */
export async function readChat(request: Request, runId: string, signal?: AbortSignal): Promise<ChatState> {
  try {
    const body = await request<{ messages?: ChatMessage[]; phase?: RunPhase }>(
      `/runs/${encodeURIComponent(runId)}/chat`, { signal },
    );
    return { available: true, messages: body.messages ?? [], phase: body.phase ?? "delivery" };
  } catch (error) {
    if (error instanceof OwnerReadError && error.status === 404) return { available: false, messages: [], phase: "delivery" };
    throw error;
  }
}

/** U5 — `POST /runs/:runId/chat` with the owner's message. */
export async function sendChatMessage(request: Request, runId: string, body: string): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }),
  });
}

/** U5 — `POST /runs/:runId/plan/approve`. */
export async function approvePlan(request: Request, runId: string): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/plan/approve`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
}

export interface BranchCommit { taskId: string | null; name: string; shortHash: string; committedAt: string }
export interface BranchState { available: boolean; branch: string; base: string; commits: BranchCommit[] }

/** U7 — `GET /runs/:runId/branch`. Absent until the integration branch ships. */
export async function readBranch(request: Request, runId: string, signal?: AbortSignal): Promise<BranchState> {
  try {
    const body = await request<{ branch?: string; base?: string; commits?: BranchCommit[] }>(
      `/runs/${encodeURIComponent(runId)}/branch`, { signal },
    );
    return { available: true, branch: body.branch ?? "", base: body.base ?? "main", commits: body.commits ?? [] };
  } catch (error) {
    if (error instanceof OwnerReadError && error.status === 404) return { available: false, branch: "", base: "main", commits: [] };
    throw error;
  }
}

/** U7 — `POST /runs/:runId/merge`. */
export async function mergeBranch(request: Request, runId: string): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/merge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
}

/** The run states that mean work is still going on, for the teams list. */
export const RUNNING_STATES: readonly TeamRunState[] = ["pending", "approved", "cancel_requested"];

export function isRunActive(run: Pick<TeamRun, "state">): boolean {
  return RUNNING_STATES.includes(run.state);
}