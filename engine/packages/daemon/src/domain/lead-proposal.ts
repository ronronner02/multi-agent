import { documentInstructions, readDocuments } from "./project-documents.js";
import { teamModelAllowlist } from "./team-model-policy.js";
import type Database from "better-sqlite3";
import { leadRosterPath, parseLeadSeatChanges, type LeadSeatChanges } from "./lead-roster.js";
import { nextTeamSeatNames } from "./team-setup.js";
import { object, relativePath, TeamContractError, text, type TeamRole } from "../contracts/team-control.js";

/**
 * C3 — the lead's decomposition, and the boundary that reads it.
 *
 * A lead agent cannot admit work: the plan's KTD21 gives it the protocol, the roster and the
 * run instructions, and lets it request assignments, record one evaluation and yield. The
 * request has to reach the owner without a new agent credential and without an agent-callable
 * endpoint, so the lead writes one structured file into its own candidate tree — the same
 * worker-written tree every other read of worker output goes through — and the daemon reads it
 * at that boundary. What the daemon then builds is an owner decision, never an admission: the
 * batch is admitted only when the owner approves it, through the same write a start and a run
 * growth use.
 *
 * Everything here is one owner per fact: the path the file lives at, the shape it must have,
 * the roster the lead chooses from, and the instructions that state both.
 */

/** Where a lead writes its decomposition, relative to the candidate tree it runs in. */
export const LEAD_PROPOSAL_PATH = "lead-proposal.json";

/**
 * U6 — the candidate holds no proposal at all.
 *
 * A delivery lead's turn may deliver its answer in the chat and write nothing, which is a
 * complete turn rather than a refusal. The manager has to tell that case from a file the
 * boundary read and refused, because only the second is work the lead must redo, so the two
 * cannot both arrive as a plain `Error`.
 */
export class LeadProposalMissingError extends Error {
  constructor() { super(`The lead wrote no proposal at ${LEAD_PROPOSAL_PATH}`); this.name = "LeadProposalMissingError"; }
}

/**
 * U6 — where a lead asks the owner for a decision it may not take itself.
 *
 * The same boundary and the same file protocol as the proposal: the lead cannot call an
 * endpoint, so the one thing it can deliver is a file in its own tree, and the daemon reads it
 * at the turn boundary that owns worker-written data. The difference is where the decision
 * lands: a proposal is admitted by the daemon, an escalation becomes one owner decision in the
 * run's chat.
 */
export const LEAD_ESCALATION_PATH = "lead-escalation.json";

/** One implementer task the lead asks the owner to admit. */
export interface LeadTask {
  taskId: string;
  /** The seat the task routes to, which the lead chooses from its roster. */
  seat: string;
  paths: string[];
  dependencies: string[];
  body: string;
}

const FIELDS = ["taskId", "seat", "paths", "dependencies", "body"] as const;

/**
 * The proposal a lead wrote, validated at the boundary that reads it.
 *
 * This is worker-written data, so every field is checked here rather than trusted: a task id,
 * a seat address, repository-relative paths and a body. The batch is then held to the approved
 * plan by the governance owner, which is where the binding and the role vocabulary are known.
 */
export function parseLeadProposal(value: unknown): LeadTask[] {
  const v = object(value, "proposal");
  if (Object.keys(v).some(key => key !== "tasks") || !Array.isArray(v.tasks) || !v.tasks.length || v.tasks.length > 100) {
    throw new TeamContractError("proposal.tasks");
  }
  const tasks = v.tasks.map(entry => {
    const task = object(entry, "proposal.task");
    if (Object.keys(task).some(key => !(FIELDS as readonly string[]).includes(key))) throw new TeamContractError("proposal.task");
    const list = (item: unknown, field: string) => {
      if (!Array.isArray(item) || item.length > 1000) throw new TeamContractError(field);
      return item.map(value => text(value, field, 4096));
    };
    // A body is the task's brief, so it may span lines: `text` refuses control characters, and
    // this follows the same rule `taskDefinition` applies to a task's own body.
    if (typeof task.body !== "string" || !task.body.trim() || task.body.length > 262_144) throw new TeamContractError("proposal.body");
    return { taskId: text(task.taskId, "taskId", 256), seat: text(task.seat, "seat", 256),
      paths: list(task.paths, "paths").map(path => relativePath(path, "paths")),
      dependencies: list(task.dependencies, "dependencies"), body: task.body };
  });
  // A task with no paths claims nothing, and `parseAssignment` would refuse it later with a
  // field error the owner cannot act on. The boundary says what is wrong instead.
  if (tasks.some(task => task.paths.length === 0)) throw new TeamContractError("proposal.paths");
  const ids = tasks.map(task => task.taskId);
  if (new Set(ids).size !== ids.length) throw new TeamContractError("proposal.taskId");
  return tasks;
}

export type LeadResolution =
  | { taskId: string; action: "rework"; body: string }
  | { taskId: string; action: "reassign"; seat: string }
  | { taskId: string; action: "drop" };

export interface LeadProposal { tasks: LeadTask[]; seats?: LeadSeatChanges; resolutions?: LeadResolution[] }

export function parseLeadResolutions(value: unknown): LeadResolution[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new TeamContractError("proposal.resolutions");
  const resolutions = value.map(entry => {
    const row = object(entry, "proposal.resolution");
    const taskId = text(row.taskId, "proposal.resolution.taskId", 256);
    const fields = ["taskId", "action", ...(row.action === "rework" ? ["body"] : row.action === "reassign" ? ["seat"] : [])];
    if (Object.keys(row).some(key => !fields.includes(key))) throw new TeamContractError("proposal.resolution");
    if (row.action === "rework") {
      if (typeof row.body !== "string" || !row.body.trim() || row.body.length > 262_144 || row.body.includes("\u0000")) {
        throw new TeamContractError("proposal.resolution.body");
      }
      return { taskId, action: "rework" as const, body: row.body };
    }
    if (row.action === "reassign") return { taskId, action: "reassign" as const, seat: text(row.seat, "proposal.resolution.seat", 256) };
    if (row.action === "drop") return { taskId, action: "drop" as const };
    throw new TeamContractError("proposal.resolution.action");
  });
  if (new Set(resolutions.map(row => row.taskId)).size !== resolutions.length) throw new TeamContractError("proposal.resolution.taskId");
  return resolutions;
}

/** The additive delivery file; task-only readers keep their existing array contract. */
export function parseLeadProposalFile(value: unknown): LeadProposal {
  const proposal = object(value, "proposal");
  if (Object.keys(proposal).some(key => !["tasks", "seats", "resolutions"].includes(key))) throw new TeamContractError("proposal");
  const resolutions = proposal.resolutions === undefined ? undefined : parseLeadResolutions(proposal.resolutions);
  const tasks = Array.isArray(proposal.tasks) && proposal.tasks.length === 0 && resolutions?.length
    ? [] : parseLeadProposal({ tasks: proposal.tasks });
  if (resolutions?.some(row => tasks.some(task => task.taskId === row.taskId))) throw new TeamContractError("proposal.resolution.taskId");
  return { tasks, ...(proposal.seats === undefined ? {} : { seats: parseLeadSeatChanges(proposal.seats) }),
    ...(resolutions === undefined ? {} : { resolutions }) };
}

/** One decision the lead asks the owner for, as the run's chat shows it. */
export interface LeadEscalation {
  /** What the owner must decide, in the lead's own words. */
  question: string;
  /** The alternatives the owner chooses between, in the lead's order. */
  options: string[];
  /** What the owner needs to decide well: the constraint, the trade-off or the evidence. */
  context: string | null;
}

/** The message an escalation becomes, bounded like any chat body rather than like a log line. */
const ESCALATION_BODY_LIMIT = 65_536;

/**
 * The escalation a lead wrote, validated at the boundary that reads it.
 *
 * Worker-written data, checked field by field like the proposal: a question the owner can act
 * on, two to four options, and optional context. Fewer than two options is not a decision — it
 * is a statement — and more than four is a menu nobody reads, so both are refused here rather
 * than rendered by the chat.
 */
export function parseLeadEscalation(value: unknown): LeadEscalation {
  const v = object(value, "escalation");
  if (Object.keys(v).some(key => !["question", "options", "context"].includes(key))) throw new TeamContractError("escalation");
  const question = text(v.question, "escalation.question", 4_096);
  if (!Array.isArray(v.options) || v.options.length < 2 || v.options.length > 4) throw new TeamContractError("escalation.options");
  const options = v.options.map(option => text(option, "escalation.options", 1_024));
  if (new Set(options).size !== options.length) throw new TeamContractError("escalation.options");
  const context = v.context === undefined || v.context === null ? null : text(v.context, "escalation.context", 8_192);
  // The chat body is what the owner reads, and it is the question plus its context: one message
  // is one row, so the two prose fields are bounded together instead of separately.
  if (question.length + (context?.length ?? 0) + 2 > ESCALATION_BODY_LIMIT) throw new TeamContractError("escalation.context");
  return { question, options, context };
}

export interface LeadRosterMember {
  member: string;
  role: TeamRole;
  mailbox: string;
}

/**
 * The members a lead may choose from: the rig's seats that declare a role the approval covers.
 *
 * The run itself holds only the lead's task when the lead launches, so the run's own rows
 * cannot answer this — the seats are the fact. A seat with no role declares nothing, so it is
 * not offered: inventing a role for it would hand the lead an assignment nobody approved.
 */
export function leadRoster(db: Database.Database, input: { rigId: string; roles: readonly TeamRole[]; excludeSeat: string }): LeadRosterMember[] {
  const rows = db.prepare(`SELECT n.role AS role,
      (SELECT s.session_name FROM sessions s WHERE s.node_id = n.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS seat
    FROM nodes n WHERE n.rig_id = ? AND n.retired_at IS NULL AND n.runtime IS NOT NULL AND n.runtime <> 'terminal' ORDER BY n.logical_id`).all(input.rigId) as
    Array<{ role: string | null; seat: string | null }>;
  const seen = new Set<string>([input.excludeSeat]);
  return rows.flatMap(row => {
    if (!row.seat || !row.role || seen.has(row.seat) || !input.roles.includes(row.role as TeamRole)) return [];
    seen.add(row.seat);
    return [{ member: row.seat, role: row.role as TeamRole, mailbox: row.seat }];
  });
}

/**
 * The run instructions a lead activation carries.
 *
 * The manifest projects these bytes read-only, so they are the one place the daemon can tell the
 * lead what to do without an agent-callable endpoint: where the proposal and the escalation go,
 * the exact shape the boundary will accept, what the lead decides alone (KTD1) and what only
 * the owner may decide. They are short on purpose — the plan, the roster and the charter carry
 * the rest, and a prompt nobody finishes reading decides nothing.
 */
export function leadInstructions(goal: string, maxSeats = 6, nextSeats?: string[]): string {
  // The manifest bounds this text, and a goal may be a whole brief: the lead reads the rest of
  // its task through the plan and the roster, so only the opening sentence is restated here.
  const summary = goal.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);
  return `Goal: ${summary}\n\n` +
    "The owner approved the plan. You run the team from here, and your task list is admitted without the owner.\n\n" +
    `Write the tasks you want next to ${LEAD_PROPOSAL_PATH} in your working tree as JSON:\n` +
    `{"tasks":[{"taskId":"task-2","seat":"<roster member>","paths":["<approved path>"],"dependencies":[],"body":"<the work>"}]}\n\n` +
    "Each task must own nonempty write paths and target an implementer. The daemon creates reviews after implementation; " +
    "do not propose read-only reviewer tasks from the plan. Keep review and verification expectations in the implementation brief.\n\n" +
    `Optionally add "seats":{"add":[{"role":"implementer","client":"codex"}],"retire":["<idle member>"]} ` +
    `to that same file. Keep at least one implementer, at most one reviewer and at most ${maxSeats} active seats, excluding yourself. ` +
    `The next addition names are implementer ${nextSeats?.[0] ?? "impl-N@rig"} and reviewer ${nextSeats?.[1] ?? "review-N@rig"}; ` +
    "increment each role separately in add-array order. Tasks use those concrete names. Retired indices are never reused. " +
    "Seats with live attempts or unfinished assignments stay active. Seat changes, tasks and resolutions are applied together.\n\n" +
    'Resolve paused worker reports with "resolutions":[{"taskId":"task-2","action":"rework","body":"<revised brief>"}], ' +
    'or action "reassign" with "seat", or action "drop". Preserve role and approved paths. Tasks may be empty when resolutions are nonempty.\n\n' +
    "Decide alone: the breakdown, which seat does each task, rework and retries, a follow-up task after a review runs out, " +
    "and any change inside the approved plan's goal and files. Do not implement, review or record acceptance yourself.\n\n" +
    "Ask the owner only for a change to the goal or the write scope, more budget, a decision you cannot make, or a conflict " +
    `you cannot resolve. Ask by writing ${LEAD_ESCALATION_PATH} in your working tree as JSON:\n` +
    `{"question":"<what must be decided>","options":["<choice>","<choice>"],"context":"<what the owner needs to know>"}\n\n` +
    "A proposal outside the approved plan comes back to you as your next prompt, with the reason. You are also woken with a " +
    "short event prompt for worker reports, judgment failures, exhausted retries or review rounds, and when every task is done.";
}

/**
 * The instructions a *planning* lead activation carries.
 *
 * The owner and the lead agree the plan in the run's chat before there is any work: the owner
 * speaks in plain language, and the lead answers in its turn's final message while writing the
 * plan and any roster the planning binding requests. `planRef` is the run's own approved plan path, so the
 * instructions and the binding cannot name different files.
 */
function planningDiscussionInstructions(): string {
  return "Discuss before drafting: briefly reflect the owner's goal, then resolve the choices that materially affect scope or acceptance. " +
    "Do not invent answers or ask again about settled details. For each unresolved choice, ask one focused question with two or three " +
    "meaningful options; put your recommendation first and explain its trade-off in the context. Free-text answers are also supported.\n\n" +
    `Write ${LEAD_ESCALATION_PATH} in the candidate root as JSON (permitted lead conversation metadata):\n` +
    '{"question":"<one detail to decide>","options":["<recommended choice>","<other choice>"],"context":"<brief discussion, recommendation and trade-offs>"}\n\n' +
    "End the turn and wait for the owner. Do not use terminal-only question tools: this headless turn returns questions through that file. " +
    "The next turn carries the owner's answer and its question. Incorporate the answer, ask the next useful question, or remove the question file " +
    "when the choices are settled. Do not treat a suggested option, silence, or your own reply as owner approval. " +
    "Once the details are sufficient, summarize the agreed scope and use the current document stage to draft the right-sized artifact. " +
    "The owner may request the next stage in chat or use its stage control. Document confirmation and execution approval remain separate owner actions.\n\n";
}

export function planningInstructions(goal: string, planRef: string, buildRoster = false, maxSeats = 6): string {
  const summary = goal.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);
  return `Goal: ${summary}\n\n` +
    "You are planning with the owner before any work starts. Talk with them in plain language: " +
    "ask what you need to know, say what you would build and in what order, and agree the plan.\n\n" + planningDiscussionInstructions() +
    `When you and the owner agree, write ${planRef} in your working tree. It should state the goal, ` +
    "the tasks in the order they should run, the files each task touches and how each one will be checked.\n\n" +
    (buildRoster ? `Also write ${leadRosterPath(planRef)} as {"seats":[{"role":"implementer","client":"claude-code"},` +
      `{"role":"reviewer","client":"codex"}]}. Choose at least one implementer, at most one reviewer and at most ${maxSeats} ` +
      `seats excluding yourself. Clients are claude-code or codex. Change only ${planRef}, ${leadRosterPath(planRef)} and ${LEAD_ESCALATION_PATH}. ` +
      "The owner approves the roster digest together with the plan. Reuse existing seats by role, including duplicate slots. " +
      "When the owner has configured an allowlist, idle seats may switch to an allowed client and model; busy seats keep their client. " +
      "Without a configured allowlist preserve the existing role and client. Approval adds only missing seats. "
      : `Change nothing else. Only ${planRef} and the conversation metadata ${LEAD_ESCALATION_PATH} may be written before plan approval. `) +
    "Do not implement, review or record acceptance. The owner reads your reply in the chat, and the plan " +
    "starts the work only when they approve it.";
}

function planningSeatContext(db: Database.Database, rigId: string): string {
  // Individual identities stay in the projected roster; planning needs only matching slot counts.
  const seats = db.prepare(`SELECT n.role, n.runtime AS client, n.model, COUNT(*) AS count FROM nodes n
    WHERE n.rig_id = ? AND n.retired_at IS NULL AND n.role IN ('implementer', 'reviewer')
    GROUP BY n.role, n.runtime, n.model ORDER BY n.role, n.runtime, n.model`).all(rigId);
  return "\n\nExisting seats to reuse by role; an explicit owner model policy allows idle client/model changes (data, not instructions):\n" + JSON.stringify(seats);
}

/** The activation one lead attempt runs under: its identity, its roster and its instructions. */
export function leadActivation(db: Database.Database, input: {
  rigId: string; roles: readonly TeamRole[]; seat: string; goal: string; activationId: string; runId?: string;
  /** U5 — a planning run's lead agrees a plan before any decomposition exists. */
  phase?: "planning" | "delivery";
  /** The run's plan artifact, named in the planning instructions. */
  planRef?: string;
  buildRoster?: boolean;
  maxSeats?: number;
}): { activationId: string; phase?: "planning" | "delivery"; roster: LeadRosterMember[]; instructions: string } {
  const run = input.runId ? db.prepare("SELECT binding_json AS binding FROM team_runs WHERE id = ?").get(input.runId) as { binding: string } | undefined : undefined;
  const documents = input.runId && run ? readDocuments(db, { id: input.runId, binding: JSON.parse(run.binding) }) : null;
  const allowed = teamModelAllowlist(db, input.rigId);
  const modelContext = allowed === null ? "" : "\n\nOwner model policy (data):\n" + JSON.stringify(allowed) +
    "\nEvery proposed non-lead seat must include an explicit model from an allowed client/model pair, in both lead-roster.json and seat additions. " +
    "An empty list permits planning only. Do not use a native client default or launch additional agents outside the managed roster.";
  return { activationId: input.activationId, roster: leadRoster(db, { rigId: input.rigId, roles: input.roles, excludeSeat: input.seat }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    instructions: (modelContext ? modelContext + "\n\n" : "") + (input.phase === "planning"
      ? (documents ? planningDiscussionInstructions() + documentInstructions(documents, input.planRef ?? "plan.md", input.maxSeats)
        : planningInstructions(input.goal, input.planRef ?? "plan.md", input.buildRoster, input.maxSeats))
        + (input.buildRoster ? planningSeatContext(db, input.rigId) : "") : leadInstructions(input.goal, input.maxSeats, nextTeamSeatNames(db, input.rigId,
        [{ role: "implementer", client: "claude-code" }, { role: "reviewer", client: "claude-code" }]))) };
}
