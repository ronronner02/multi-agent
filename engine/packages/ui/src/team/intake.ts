import { useQuery } from "@tanstack/react-query";
import { useOwnerSession } from "../hooks/useOwnerSession.js";

/**
 * U13 — the team's intake policy and the project inbox.
 *
 * The shapes mirror the team-control contract: `revision` 0 means the policy was never saved,
 * the mode defaults to `observe`, and `repository` is null when the project has no GitHub origin.
 */

export type IntakeMode = "off" | "observe" | "auto";
export interface IntakeRule { name: string; instruction: string; enabled: boolean }
export interface IntakePolicy { revision: number; mode: IntakeMode; rules: IntakeRule[] }
export type IntakeState = "pending" | "would_start" | "started" | "skipped" | "unavailable" | "dismissed";
export interface IntakeItem {
  item: string; kind: "issue" | "comment" | "ci"; title: string; url: string; author: string;
  /** An owner-authored request that mentioned the agent account. */
  explicit: boolean; state: IntakeState; matched: string[];
  policyRevision: number | null; runId: string | null; createdAt: string; updatedAt: string;
}
export interface IntakeReply { policy: IntakePolicy; repository: string | null; items: IntakeItem[] }
export type IntakeDraft = Pick<IntakePolicy, "mode" | "rules">;

type Request = ReturnType<typeof useOwnerSession>["request"];

export const INTAKE_MODES: readonly IntakeMode[] = ["off", "observe", "auto"];
/** The server's limits, so the editor stops at them instead of letting a save be refused. */
export const INTAKE_RULE_LIMITS = { rules: 20, name: 80, instruction: 2000 } as const;
/** Start is allowed for every state that has not become a run yet. */
export const STARTABLE_STATES: readonly IntakeState[] = ["would_start", "skipped", "unavailable"];
/** Dismiss is offered for every state that is neither running nor already dismissed. */
export const DISMISSABLE_STATES: readonly IntakeState[] = ["pending", "would_start", "skipped", "unavailable"];
export const intakeKey = (teamId: string) => ["team", "intake", teamId] as const;

/** The policy and the newest hundred items, shared by the settings editor and the inbox. */
export function useIntake(teamId: string | undefined) {
  const { paired, request } = useOwnerSession();
  return useQuery({
    queryKey: intakeKey(teamId ?? ""), enabled: paired && !!teamId, retry: false, refetchInterval: 5_000,
    queryFn: ({ signal }) => request<IntakeReply>(`/teams/${encodeURIComponent(teamId!)}/intake`, { signal }),
  });
}

/** `baseRevision` is the revision the editor read; the daemon refuses the save if another one replaced it. */
export async function saveIntakePolicy(request: Request, teamId: string, baseRevision: number, draft: IntakeDraft): Promise<IntakePolicy> {
  const body = await request<{ policy: IntakePolicy }>(`/teams/${encodeURIComponent(teamId)}/intake/policy`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision, mode: draft.mode, rules: draft.rules }),
  });
  return body.policy;
}

export async function startIntakeItem(request: Request, teamId: string, item: string): Promise<string> {
  const body = await request<{ runId: string }>(`/teams/${encodeURIComponent(teamId)}/intake/items/${encodeURIComponent(item)}/start`, { method: "POST" });
  return body.runId;
}

export async function dismissIntakeItem(request: Request, teamId: string, item: string): Promise<IntakeItem> {
  const body = await request<{ item: IntakeItem }>(`/teams/${encodeURIComponent(teamId)}/intake/items/${encodeURIComponent(item)}/dismiss`, { method: "POST" });
  return body.item;
}