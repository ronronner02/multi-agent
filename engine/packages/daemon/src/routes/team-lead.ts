import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, parseControlRequest, parseProtocolVersion } from "../contracts/team-control.js";
import type { PlanGovernance, ProviderPolicyCapability } from "../domain/plan-governance.js";
import type { LeadTask } from "../domain/lead-proposal.js";
import { refreshPlanBinding } from "./team-start.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

/**
 * C3 — the owner's read of a lead's decomposition, and the decision it becomes.
 *
 * The lead writes one file into its own candidate tree; this route is where the owner turns
 * that file into an approval. It is owner-only on both verbs: the read is worker-written
 * content, and the write is the owner's decision. Nothing here admits a task — `proposeLeadTasks`
 * records a pending approval carrying the exact batch, and the owner approves it through the
 * `approvals/decide` path C1 growth already uses. So a lead's proposal reaches the run only
 * after the owner says yes, and the tasks it carries then run, complete and get reviewed through
 * C1, C2 and the completion path unchanged.
 *
 * The read is separated from the write on purpose: a client can show the batch before the owner
 * decides it, and a second read of a rejected proposal does not create a second approval.
 */

/** How long an unapproved lead proposal stays decidable. One day, as a start's approval does. */
export const PROPOSAL_WINDOW_MS = 86_400_000;

export interface LeadProposalRouteOptions {
  credentials: TeamControlCredentials;
  legacyTokens: readonly (string | null | undefined)[];
  /** The runtime that owns the candidate trees and reads worker-written files. */
  runtime?: { leadProposalFor(runId: string, taskId: string): LeadTask[] };
  /** The current policy capability a decision reconciles against, as every command reads it. */
  readPolicyCapability?: () => ProviderPolicyCapability | null;
}

export function teamLeadRoutes(governance: PlanGovernance, options: LeadProposalRouteOptions): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  const route = "/runs/:runId/tasks/:taskId/proposal";
  app.use(route, teamControlAuthentication(() => options.credentials, options.legacyTokens));
  app.use(route, bodyLimit({ maxSize: 1_048_576,
    onError: c => c.json({ code: "invalid_team_contract", error: "The proposal request exceeds its size limit." }, 413) }));
  /** The lead task this run's decomposition comes from: a lead task, and the run's own row. */
  const leadTaskOf = (runId: string, taskId: string) => {
    const task = governance.findTask(runId, taskId);
    return task && task.assignment.role === "lead" ? task : null;
  };

  app.get(route, (c) => {
    const runId = c.req.param("runId"), taskId = c.req.param("taskId");
    if (c.get("controlActor").kind !== "owner" || (c.get("controlRunId") !== null && c.get("controlRunId") !== runId)) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    if (!leadTaskOf(runId, taskId)) return c.json({ code: "control_not_found", error: "This run has no lead task with that id." }, 404);
    if (!options.runtime) return c.json({ code: "lead_proposal_unavailable", error: "Candidate trees are not composed in this daemon." }, 503);
    let tasks: LeadTask[];
    try {
      tasks = options.runtime.leadProposalFor(runId, taskId);
    } catch (error) {
      // A lead that wrote nothing, or wrote something the boundary refuses, is a named refusal
      // rather than a crash: the message is this module's own, never an internal one.
      return c.json({ code: "lead_proposal_unreadable", error: (error as Error).message }, 409);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, proposal: { runId, taskId, tasks } });
  });

  /**
   * Record the owner decision for the batch the daemon reads.
   *
   * The batch is re-read here rather than accepted from the request: what the owner approves has
   * to be what the daemon can verify, so the request supplies only its own identity and an
   * expiry. A lead's proposal that changed between the read and the decision is a different
   * batch, and the approval it produces names that batch's digest.
   */
  app.post(route, async (c) => {
    const runId = c.req.param("runId"), taskId = c.req.param("taskId");
    if (c.get("controlActor").kind !== "owner" || (c.get("controlRunId") !== null && c.get("controlRunId") !== runId)) {
      return c.json({ code: "owner_control_required", error: "An authenticated owner decision is required." }, 403);
    }
    const request = parseControlRequest(await c.req.json());
    if (request.runId !== runId) return c.json({ code: "control_scope_denied", error: "The request and route must identify the same run." }, 403);
    if (!leadTaskOf(runId, taskId)) return c.json({ code: "control_not_found", error: "This run has no lead task with that id." }, 404);
    if (!options.runtime) return c.json({ code: "lead_proposal_unavailable", error: "Candidate trees are not composed in this daemon." }, 503);
    let tasks: LeadTask[];
    try {
      tasks = options.runtime.leadProposalFor(runId, taskId);
    } catch (error) {
      return c.json({ code: "lead_proposal_unreadable", error: (error as Error).message }, 409);
    }
    const policy = options.readPolicyCapability?.();
    const run = governance.getRun(runId);
    const binding = policy ? refreshPlanBinding(run.binding, policy) : run.binding;
    // The request supplies only its expiry. The batch is re-read above, so the approval names
    // the tasks the daemon just verified rather than anything the client claims, and a retried
    // request replays the approval it already recorded.
    const receipt = governance.proposeLeadTasks(request, c.get("controlActor"), binding, tasks);
    return c.json(receipt, receipt.status === "denied" ? 403 : 200);
  });

  app.onError((error, c) => {
    if (/not found/i.test(error.message)) return c.json({ code: "control_not_found", error: "The requested entity was not found." }, 404);
    if (/conflict|idempotency key/i.test(error.message)) {
      return c.json({ code: "control_conflict", error: "Refresh the entity version and exact request before retrying." }, 409);
    }
    console.warn("team lead: proposal was not acknowledged: " + error.message);
    return c.json({ code: "control_persistence_failed", error: "The lead proposal was not acknowledged." }, 500);
  });
  return app;
}
