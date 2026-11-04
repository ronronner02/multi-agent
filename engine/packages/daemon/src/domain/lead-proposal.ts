import type Database from "better-sqlite3";
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
    FROM nodes n WHERE n.rig_id = ? AND n.runtime IS NOT NULL AND n.runtime <> 'terminal' ORDER BY n.logical_id`).all(input.rigId) as
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
 * lead what to do without an agent-callable endpoint: where the proposal goes, the exact shape
 * the boundary will accept, and that the owner — not the lead — decides it.
 */
export function leadInstructions(goal: string): string {
  // The manifest bounds this text, and a goal may be a whole brief: the lead reads the rest of
  // its task through the plan and the roster, so only the opening sentence is restated here.
  const summary = goal.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);
  return `Goal: ${summary}\n\n` +
    `Write your decomposition to ${LEAD_PROPOSAL_PATH} in your working tree as JSON:\n` +
    `{"tasks":[{"taskId":"task-2","seat":"<roster member>","paths":["<approved path>"],"dependencies":[],"body":"<the work>"}]}\n\n` +
    "Each task is an implementer task inside the approved scope, with a task id this run does not already use. " +
    "Choose seats from the roster. Do not implement, review or record acceptance yourself. " +
    "The owner approves the exact batch, and the daemon then runs each task and its review.";
}

/** The activation one lead attempt runs under: its identity, its roster and its instructions. */
export function leadActivation(db: Database.Database, input: {
  rigId: string; roles: readonly TeamRole[]; seat: string; goal: string; activationId: string;
}): { activationId: string; roster: LeadRosterMember[]; instructions: string } {
  return { activationId: input.activationId, roster: leadRoster(db, { rigId: input.rigId, roles: input.roles, excludeSeat: input.seat }),
    instructions: leadInstructions(input.goal) };
}
