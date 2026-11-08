import type Database from "better-sqlite3";
import { object, TeamContractError, type TeamAttempt } from "../contracts/team-control.js";
import { FRAMEWORK_PIN, frameworkEntry, type FrameworkEntrypoint } from "../integrations/framework/catalog.js";
import { normalizeFrameworkOutcome, type FrameworkOutcome, type PreparedFrameworkInvocation } from "../integrations/framework/invocation.js";

export interface WorkflowSelection { entrypoint: FrameworkEntrypoint; input?: string; readOnly: boolean; ownerMessageId?: string }
export interface TaskWorkflow extends WorkflowSelection { origin: "user" | "caller"; revision: string }

/** Only admission code supplies origin. A worker or HTTP body never supplies its own grant. */
export function parseWorkflowSelection(value: unknown): WorkflowSelection {
  const input = object(value, "workflow");
  const entry = typeof input.entrypoint === "string" ? frameworkEntry(input.entrypoint) : undefined;
  if (!entry || Object.keys(input).some(key => !["entrypoint", "input", "readOnly", "ownerMessageId"].includes(key))
    || input.input !== undefined && (typeof input.input !== "string" || input.input.length > 65_536 || input.input.includes("\u0000"))
    || input.readOnly !== undefined && typeof input.readOnly !== "boolean"
    || input.ownerMessageId !== undefined && (typeof input.ownerMessageId !== "string" || !input.ownerMessageId
      || input.ownerMessageId.length > 256 || /[\u0000-\u0020\u007f]/.test(input.ownerMessageId))) throw new TeamContractError("workflow");
  return { entrypoint: entry.name, readOnly: input.readOnly === true || entry.name === "spec-code-review",
    ...(input.input === undefined ? {} : { input: input.input as string }),
    ...(input.ownerMessageId === undefined ? {} : { ownerMessageId: input.ownerMessageId as string }) };
}
export function ownerWorkflowCommand(body: string): WorkflowSelection | null {
  const match = /^[/$]([a-z][a-z0-9-]*)(?:[ \t]+(--read-only))?(?:\s+([\s\S]*))?$/.exec(body.trim());
  if (!match || !frameworkEntry(match[1]!)) return null;
  return parseWorkflowSelection({ entrypoint: match[1], readOnly: match[2] !== undefined, input: match[3] ?? "" });
}
export function unassignedOwnerWorkflows(db: Database.Database, runId: string): WorkflowSelection[] {
  const messages = db.prepare(`SELECT c.id, c.body FROM team_chat_messages c WHERE c.run_id = ? AND c.sender = 'owner'
    AND NOT EXISTS (SELECT 1 FROM team_queue_authority a WHERE json_extract(a.workflow_json, '$.ownerMessageId') = c.id)
    ORDER BY c.rowid`).all(runId) as Array<{ id: string; body: string }>;
  return messages.flatMap(message => {
    const workflow = ownerWorkflowCommand(message.body);
    return workflow ? [{ ...workflow, ownerMessageId: message.id }] : [];
  });
}
export function resolveAdmittedWorkflow(db: Database.Database, runId: string, selection: WorkflowSelection,
  origin: TaskWorkflow["origin"]): { workflow: TaskWorkflow } | { error: string } {
  if (selection.ownerMessageId) {
    const message = db.prepare("SELECT body FROM team_chat_messages WHERE id = ? AND run_id = ? AND sender = 'owner'")
      .get(selection.ownerMessageId, runId) as { body: string } | undefined;
    const command = message ? ownerWorkflowCommand(message.body) : null;
    if (!command || command.entrypoint !== selection.entrypoint) return { error: "An explicit matching owner workflow request is required in this run." };
    if (db.prepare("SELECT 1 FROM team_queue_authority WHERE json_extract(workflow_json, '$.ownerMessageId') = ?")
      .get(selection.ownerMessageId)) return { error: "This owner workflow request already has an assigned task." };
    selection = { ...selection, input: command.input, readOnly: selection.readOnly || command.readOnly };
    origin = "user";
  }
  const error = workflowAdmissionRefusal(selection, origin);
  return error ? { error } : { workflow: admittedWorkflow(selection, origin) };
}
export function workflowAdmissionRefusal(selection: WorkflowSelection, origin: TaskWorkflow["origin"]): string | null {
  const entry = frameworkEntry(selection.entrypoint)!;
  return entry.invocation === "workflow" || entry.invocation === origin ? null : `${entry.invocation}-invocation-required: ${entry.name}`;
}
export function workflowCapabilityRefusal(entrypoint: string, platform: string = process.platform): string | null {
  return entrypoint === "spec-test-xcode" && platform !== "darwin" ? "A macOS node with Xcode and simulator capability is required." : null;
}
export function workflowTurnInstructions(request: PreparedFrameworkInvocation): string {
  const prerequisite = frameworkEntry(request.entrypoint)!.prerequisite;
  return `Requested workflow: ${request.nativeInvocation}\nOrigin: ${request.origin}\nPinned revision: ${request.revision}\n` +
    `Read-only: ${request.readOnly}\nWorkflow input: ${JSON.stringify(request.input)}\n` +
    (prerequisite ? `Required before effects: ${prerequisite}\n` : "") +
    "Read the pinned entrypoint and its supporting references. Follow its own user/caller, capability and approval gates before acting. " +
    "An entrypoint selection is not commit, push, merge, setup, network or budget authorization. Use the existing managed team protocol for delegation; do not start an independent scheduler. " +
    (request.readOnly ? "Remain report-only: do not modify the candidate or perform external writes. " : "") +
    "At the end of this native turn, append exactly one result envelope outside any code fence:\n" +
    '<workflow-outcome>{"status":"complete|incomplete|blocked|failed","artifacts":["relative/path"],"reason":"","summary":"what was actually accomplished"}</workflow-outcome>\n' +
    "Use complete only after the requested work and its checks finish. Reference actual artifacts, or return a substantive summary for an answer-only workflow. " +
    "For a missing capability, caller contract or approval return blocked with the specific reason. A launch, catalog entry, or queued task is not completion. " +
    "This envelope records the workflow result; it does not replace task evidence, a reviewer verdict, or owner acceptance.";
}
export function extractWorkflowOutcome(message: string | null): FrameworkOutcome {
  const blocks = [...(message ?? "").matchAll(/<workflow-outcome>([\s\S]*?)<\/workflow-outcome>/g)];
  if (blocks.length !== 1 || blocks[0]![1]!.length > 65_536) {
    return { status: "incomplete", artifacts: [], reason: "workflow-outcome-missing-or-ambiguous" };
  }
  try { return normalizeFrameworkOutcome(JSON.parse(blocks[0]![1]!)); }
  catch { return { status: "incomplete", artifacts: [], reason: "malformed-framework-outcome" }; }
}
export function recordWorkflowOutcome(db: Database.Database, input: {
  attemptId: string; qitemId: string; generation: number; workflow: TaskWorkflow; outcome: FrameworkOutcome;
}): FrameworkOutcome {
  db.prepare(`INSERT OR IGNORE INTO team_workflow_outcomes
    (attempt_id, qitem_id, generation, entrypoint, revision, outcome_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(input.attemptId, input.qitemId, input.generation, input.workflow.entrypoint, input.workflow.revision,
      JSON.stringify(input.outcome), new Date().toISOString());
  return JSON.parse((db.prepare("SELECT outcome_json AS value FROM team_workflow_outcomes WHERE attempt_id = ? AND generation = ?")
    .get(input.attemptId, input.generation) as { value: string }).value) as FrameworkOutcome;
}
export function recordWorkflowTurn(db: Database.Database, attempt: TeamAttempt, message: string | null): FrameworkOutcome | null {
  if (!attempt.qitemId || !attempt.identity || attempt.state !== "stopped") return null;
  const row = db.prepare("SELECT workflow_json AS value FROM team_queue_authority WHERE qitem_id = ?").get(attempt.qitemId) as { value: string | null } | undefined;
  if (!row?.value) return null;
  const workflow = JSON.parse(row.value) as TaskWorkflow;
  const outcome = attempt.failure ? { status: "failed" as const, artifacts: [], reason: attempt.failure.reasonCode }
    : extractWorkflowOutcome(message);
  return recordWorkflowOutcome(db, { attemptId: attempt.id, qitemId: attempt.qitemId, generation: attempt.identity.generation, workflow, outcome });
}
export function readRunWorkflows(db: Database.Database, runId: string) {
  const rows = db.prepare(`SELECT a.task_id AS taskId, a.workflow_json AS workflowJson, q.state AS taskState,
    o.attempt_id AS attemptId, o.generation, o.outcome_json AS outcomeJson, o.recorded_at AS recordedAt
    FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
      LEFT JOIN team_workflow_outcomes o ON o.qitem_id = a.qitem_id
    WHERE a.run_id = ? AND a.workflow_json IS NOT NULL ORDER BY a.rowid, o.recorded_at, o.generation`).all(runId) as Array<{
      taskId: string; workflowJson: string; taskState: string; attemptId: string | null; generation: number | null; outcomeJson: string | null; recordedAt: string | null;
    }>;
  return rows.map(({ workflowJson, outcomeJson, ...row }) => ({ ...row,
    workflow: JSON.parse(workflowJson) as TaskWorkflow, outcome: outcomeJson === null ? null : JSON.parse(outcomeJson) as FrameworkOutcome }));
}
export const admittedWorkflow = (selection: WorkflowSelection, origin: TaskWorkflow["origin"]): TaskWorkflow =>
  ({ ...selection, origin, revision: FRAMEWORK_PIN.revision });
