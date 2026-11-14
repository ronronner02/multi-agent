import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { chatBody } from "./lead-chat.js";

/**
 * Plan KTD5 — a task thread is the owner's chat scoped to one task.
 *
 * An owner comment is a `team_chat_messages` row carrying the task id. The task's next turn
 * takes it the way a lead turn takes the run's chat, and marks it delivered to that attempt. A
 * comment delivered to an attempt that then failed is taken again by the next attempt, so a
 * failed turn never loses what the owner wrote.
 */
export interface TaskComment { id: string; runId: string; taskId: string; body: string; createdAt: string; deliveredAttempt: string | null }

const COLUMNS = "id, run_id AS runId, task_id AS taskId, body, created_at AS createdAt, delivered_attempt AS deliveredAttempt";

export function appendTaskComment(db: Database.Database, input: { id: string; runId: string; taskId: string; body: string; createdAt: string }): TaskComment {
  const body = chatBody(input.body, "comment.body");
  db.prepare(`INSERT INTO team_chat_messages (id, run_id, sender, kind, body, created_at, task_id)
    VALUES (?, ?, 'owner', 'text', ?, ?, ?)`).run(input.id, input.runId, body, input.createdAt, input.taskId);
  return db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages WHERE id = ?`).get(input.id) as TaskComment;
}

export function listTaskComments(db: Database.Database, runId: string, taskId: string): TaskComment[] {
  return db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages WHERE run_id = ? AND task_id = ? ORDER BY rowid`).all(runId, taskId) as TaskComment[];
}

/** Comments no successful attempt of the task has taken: never delivered, or delivered to a failed attempt. */
const UNTAKEN = `sender = 'owner' AND task_id = ? AND run_id = ? AND (delivered_attempt IS NULL
  OR delivered_attempt IN (SELECT id FROM team_attempts WHERE failure_json IS NOT NULL))`;

export function pendingTaskComments(db: Database.Database, runId: string, taskId: string): TaskComment[] {
  return db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages WHERE ${UNTAKEN} ORDER BY rowid`).all(taskId, runId) as TaskComment[];
}

/** Take the task's waiting comments for one attempt. Idempotent per attempt, like `takeOwnerMessages`. */
export function takeTaskComments(db: Database.Database, runId: string, taskId: string, attemptId: string): TaskComment[] {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages WHERE (${UNTAKEN}) OR (task_id = ? AND run_id = ? AND delivered_attempt = ?)
      ORDER BY rowid`).all(taskId, runId, taskId, runId, attemptId) as TaskComment[];
    if (rows.length) {
      db.prepare(`UPDATE team_chat_messages SET delivered_attempt = ? WHERE ${UNTAKEN}`).run(attemptId, taskId, runId);
    }
    return rows;
  })();
}

/** Move waiting comments to another task: the follow-up a comment on landed work starts. */
export function moveTaskComments(db: Database.Database, runId: string, fromTaskId: string, toTaskId: string): number {
  return db.prepare(`UPDATE team_chat_messages SET task_id = ?, delivered_attempt = NULL WHERE ${UNTAKEN}`)
    .run(toTaskId, fromTaskId, runId).changes;
}

/** The hand-back file sits beside the attempt's task report, outside the candidate. */
export function handbackPath(taskReportPath: string): string {
  return join(dirname(taskReportPath), "handback.json");
}

/** Plan R19 — the GitHub review comments a turn declines sit beside its hand-back file, in the same shape. */
export function declinePath(taskReportPath: string): string {
  return join(dirname(taskReportPath), "declined.json");
}

/** The turn prompt's note for the comments it carries, and how to hand one back or decline a GitHub one. */
export function taskCommentNote(comments: readonly TaskComment[], handbackFile: string, declineFile?: string): string | null {
  if (!comments.length) return null;
  const github = declineFile !== undefined && comments.some(comment => comment.id.startsWith("gh-"));
  return ["The owner commented on this task:",
    ...comments.map(comment => `Comment ${comment.id}: ${comment.body}`),
    "Act on each comment within this task's paths and the approved plan. A comment that asks for work beyond this task, or belongs " +
      `to another task, is not yours: write [{"messageId":"<id>","reason":"<one sentence>"}] to ${JSON.stringify(handbackFile)} ` +
      "and do not act on it. Leave ordinary discussion unanswered.",
    ...(github ? ["Comments whose id starts with gh- are GitHub review comments on the team's pull request. Never post on GitHub " +
      "yourself; the team's agent account answers for you. To decline one, write " +
      `[{"messageId":"<id>","reason":"<one sentence, in the reviewer's language>"}] to ${JSON.stringify(declineFile)}: the reason ` +
      "is posted as the reply. Every other GitHub comment you took counts as fixed, and its thread is resolved once your change is pushed."] : [])].join("\n\n");
}

export interface Handback { messageId: string; reason: string }

/** Read an attempt's hand-back file. Absent is no hand-back; a malformed file hands nothing back. */
export function readHandback(file: string): Handback[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const { messageId, reason } = entry as Record<string, unknown>;
    return typeof messageId === "string" && typeof reason === "string" && messageId && reason.trim()
      ? [{ messageId, reason: reason.trim().slice(0, 500) }] : [];
  });
}

/**
 * Plan R9 — a handed-back comment becomes the run's owner message, so the lead reads it as the
 * owner speaking. Only a comment of this task that this attempt took can be handed back.
 */
export function handBackComments(db: Database.Database, runId: string, taskId: string, attemptId: string,
  entries: readonly Handback[]): Handback[] {
  const moved: Handback[] = [];
  for (const entry of entries) {
    const changed = db.prepare(`UPDATE team_chat_messages SET task_id = NULL, delivered_attempt = NULL
      WHERE id = ? AND run_id = ? AND task_id = ? AND sender = 'owner' AND delivered_attempt = ?`)
      .run(entry.messageId, runId, taskId, attemptId).changes;
    if (changed) moved.push(entry);
  }
  return moved;
}

export interface TaskThreadDependencies {
  db: Database.Database;
  governance: import("./plan-governance.js").PlanGovernance;
  turnStateRoot?: string;
  dispatch: () => ((runId: string, taskId: string) => Promise<void>) | undefined;
  log?: (message: string) => void;
}

/**
 * The task thread's two daemon steps. At an implementer turn's end, comments it handed back go
 * to the lead as owner messages, and the lead is started for them. On each sweep, comments that
 * waited for a task under review start that task's follow-up once its change has landed.
 */
export function composeTaskThreads(dependencies: TaskThreadDependencies) {
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  const start = async (runId: string, taskId: string) => {
    const dispatch = dependencies.dispatch();
    if (!dispatch) return;
    try { await dispatch(runId, taskId); }
    catch (error) { log(`team task thread: run=${runId} task=${taskId} did not start: ${error instanceof Error ? error.message : String(error)}`); }
  };
  return {
    async attemptStopped(attempt: { id: string; runId: string; qitemId: string | null; role: string }): Promise<void> {
      if (attempt.role !== "implementer" || !attempt.qitemId || !dependencies.turnStateRoot) return;
      const task = dependencies.db.prepare("SELECT task_id AS taskId FROM team_queue_authority WHERE qitem_id = ?").get(attempt.qitemId) as { taskId: string } | undefined;
      if (!task) return;
      const file = handbackPath(join(dependencies.turnStateRoot, "turns", attempt.id, "report", "task-report.json"));
      const moved = handBackComments(dependencies.db, attempt.runId, task.taskId, attempt.id, readHandback(file));
      if (!moved.length) return;
      for (const entry of moved) log(`team task thread: task ${task.taskId} handed comment ${entry.messageId} to the lead: ${entry.reason}`);
      const lead = dependencies.db.prepare(`SELECT task_id AS taskId FROM team_queue_authority
        WHERE run_id = ? AND json_extract(assignment_json, '$.role') = 'lead' ORDER BY rowid LIMIT 1`).get(attempt.runId) as { taskId: string } | undefined;
      if (!lead) return;
      try {
        dependencies.governance.continueLeadChat({ protocolVersion: "1.0", runId: attempt.runId, actionId: lead.taskId,
          expectedEntityVersion: dependencies.governance.getRun(attempt.runId).entityVersion, idempotencyKey: `handback:${attempt.id}`, payload: {} },
        { kind: "daemon", sessionId: "daemon" });
      } catch { /* A running or pending lead reads the message on its next turn. */ }
      await start(attempt.runId, lead.taskId);
    },
    async sweep(): Promise<void> {
      const runs = dependencies.db.prepare("SELECT id FROM team_runs WHERE state = 'approved'").all() as { id: string }[];
      for (const run of runs) for (const taskId of dependencies.governance.promoteTaskComments(run.id)) await start(run.id, taskId);
    },
  };
}

/** Plan KTD4 — the lead's copy of the questions workers asked the owner, which the owner answers. */
export function ownerQuestionNotices(db: Database.Database, runId: string): string | null {
  const rows = db.prepare(`SELECT a.task_id AS taskId, json_extract(a.evidence_json, '$.taskReport.question') AS question
    FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
    WHERE a.run_id = ? AND json_extract(a.assignment_json, '$.role') = 'implementer' AND q.state = 'blocked'
      AND json_extract(a.evidence_json, '$.taskReport.status') = 'needs-decision'
      AND json_extract(a.evidence_json, '$.taskReport.question') IS NOT NULL
      AND json_extract(a.evidence_json, '$.resolution') IS NULL ORDER BY a.rowid`).all(runId) as { taskId: string; question: string }[];
  if (!rows.length) return null;
  return ["Questions workers asked the owner (the owner answers them on the task; you need not act):",
    ...rows.map(row => `- ${row.taskId}: ${row.question.slice(0, 500)}`)].join("\n");
}

/** Plan KTD7 — the lead's context, not a wake: the latest owner comments on tasks. */
export function taskCommentNotices(db: Database.Database, runId: string, limit = 10): string | null {
  const rows = db.prepare(`SELECT task_id AS taskId, body, delivered_attempt AS deliveredAttempt FROM team_chat_messages
    WHERE run_id = ? AND sender = 'owner' AND task_id IS NOT NULL ORDER BY rowid DESC LIMIT ?`).all(runId, limit) as
    Array<{ taskId: string; body: string; deliveredAttempt: string | null }>;
  if (!rows.length) return null;
  return ["Owner comments on tasks (newest first; the task's own agent handles each, you need not act):",
    ...rows.map(row => `- ${row.taskId} (${row.deliveredAttempt ? "delivered" : "waiting"}): ${row.body.slice(0, 200)}`)].join("\n");
}
