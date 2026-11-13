import { ownerWorkflowCommand, type WorkflowSelection } from "./team-workflows.js";
import type Database from "better-sqlite3";
import { TeamContractError } from "../contracts/team-control.js";
import { readAgentTurnLastMessage } from "./agent-turn.js";
import { generatedReplyTitle } from "./display-names.js";
import type { PlanGovernance } from "./plan-governance.js";
import { ATTEMPT_REASON_CODES, failureClassFor, type AttemptReasonCode } from "./attempt-failure.js";

/**
 * U5 — the owner↔lead conversation, and the two facts a turn needs from it.
 *
 * The conversation is durable rows, one per message, ordered by insertion. Two questions are
 * asked of it, and each has one answer:
 *
 * - *What has the lead not seen yet?* A message is marked with the attempt whose prompt carried
 *   it. Everything unmarked is pending, so a message that arrives while a turn is running is
 *   answered by the next turn rather than being read as answered because a reply landed after
 *   it. The mark is taken by the prompt builder, which runs immediately before the client starts.
 * - *What did the lead just say?* A lead row carries the attempt whose final message it is, and
 *   one attempt yields at most one row (the unique index), so a sweep that replays records
 *   nothing twice.
 *
 * Nothing here talks to an agent: the launch path writes the prompt, and the completion sweep
 * observes the end of a turn. This module is the storage and the two texts those owners use.
 */

/** One message in a run's conversation, as the daemon and the routes read it. */
export interface TeamChatMessage {
  id: string;
  runId: string;
  sender: "owner" | "lead";
  /**
   * `decision` asks the owner to choose; `confirmation` records an accepted owner action.
   *
   * The two are the same row because they are the same conversation: a decision is a lead
   * message with two-to-four options and an answer, and the chat lists it where the lead said it.
   */
  kind: "text" | "decision" | "confirmation";
  body: string;
  responseLanguage?: "en" | "zh-CN";
  /** The choices a decision offers, in the lead's order; null on every other message. */
  options: string[] | null;
  /** The owner message that answered a decision; null while the run waits on it. */
  answeredBy: string | null;
  /** The lead attempt whose final message this is; null for an owner message. */
  attemptId: string | null;
  /** The lead attempt whose prompt carried an owner message; null while it is still pending. */
  deliveredAttempt: string | null;
  createdAt: string;
}

export type ResponseLanguage = "en" | "zh-CN";

export function parseResponseLanguage(value: unknown): ResponseLanguage | undefined {
  if (value === undefined) return undefined;
  if (value !== "en" && value !== "zh-CN") throw new TeamContractError("responseLanguage");
  return value;
}

/** The latest stored owner choice also governs turns after that message was delivered. */
export function responseLanguageNote(history: readonly TeamChatMessage[], currentLanguage?: ResponseLanguage | null): string | null {
  const language = currentLanguage ?? [...history].reverse().find(message => message.sender === "owner" && message.responseLanguage)?.responseLanguage;
  if (!language) return null;
  const label = language === "zh-CN" ? "Simplified Chinese (zh-CN)" : "English (en)";
  return `The owner's selected response language is ${label}. Use it for owner-facing replies, public progress, questions, and generated titles. ` +
    "This current owner preference takes precedence over repository language defaults and previous turns. " +
    "Preserve code, commands, paths, identifiers, and quoted source text. Honor an explicit translation or language request in the current owner message.";
}

/** The longest message either side may send. Bounded like a task body, not like a log line. */
export const CHAT_BODY_LIMIT = 65_536;

/**
 * A chat body, validated where it enters.
 *
 * `text` refuses control characters, and a message is prose: it may span lines. What is refused
 * here is a NUL, which would cut the text at a client's first write, and anything past the bound.
 */
export function chatBody(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > CHAT_BODY_LIMIT || value.includes("\u0000")) {
    throw new TeamContractError(field);
  }
  return value;
}

function rowToMessage(row: { id: string; runId: string; sender: string; kind: string; body: string; optionsJson: string | null;
  answeredBy: string | null; attemptId: string | null; deliveredAttempt: string | null; createdAt: string; responseLanguage?: ResponseLanguage | null }): TeamChatMessage {
  return { id: row.id, runId: row.runId, sender: row.sender === "lead" ? "lead" : "owner",
    ...(row.responseLanguage ? { responseLanguage: row.responseLanguage } : {}),
    kind: row.kind === "decision" || row.kind === "confirmation" ? row.kind : "text", body: row.body,
    // The options are this row's own bytes, written by the daemon when it stored the decision.
    // A row whose JSON the daemon cannot read is still a message, so it renders as one.
    options: row.optionsJson === null ? null : parseOptions(row.optionsJson),
    answeredBy: row.answeredBy, attemptId: row.attemptId, deliveredAttempt: row.deliveredAttempt,
    createdAt: row.createdAt };
}

function parseOptions(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every(option => typeof option === "string") ? parsed as string[] : null;
  } catch { return null; }
}

const COLUMNS = `id, run_id AS runId, sender, kind, body, options_json AS optionsJson,
  answered_by AS answeredBy, attempt_id AS attemptId, delivered_attempt AS deliveredAttempt, created_at AS createdAt, response_language AS responseLanguage`;

/** Append one owner message. Called inside the caller's transaction; it never opens its own. */
export function appendChatMessage(db: Database.Database, input: {
  id: string; runId: string; body: string; createdAt: string; kind?: "confirmation"; responseLanguage?: ResponseLanguage;
}): TeamChatMessage {
  db.prepare(`INSERT INTO team_chat_messages (id, run_id, sender, kind, body, created_at, response_language)
    VALUES (?, ?, 'owner', ?, ?, ?, ?)`).run(input.id, input.runId, input.kind ?? "text", input.body, input.createdAt, input.responseLanguage ?? null);
  if (input.responseLanguage) db.prepare("UPDATE team_runs SET response_language = ? WHERE id = ?")
    .run(input.responseLanguage, input.runId);
  return getChatMessage(db, input.id)!;
}

export function getChatMessage(db: Database.Database, id: string): TeamChatMessage | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages WHERE id = ?`).get(id) as
    Parameters<typeof rowToMessage>[0] | undefined;
  return row ? rowToMessage(row) : null;
}

/** The run's conversation, in the order it happened. */
/** The run's conversation as the owner sees it: every message except the lead's activity notes. */
export function listChatMessages(db: Database.Database, runId: string): TeamChatMessage[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages WHERE run_id = ? AND visibility = 'chat' ORDER BY rowid`).all(runId) as
    Array<Parameters<typeof rowToMessage>[0]>;
  return rows.map(rowToMessage);
}

/** The lead's turn notes that needed no owner attention, kept for the lead's detail view. */
export function listRunActivity(db: Database.Database, runId: string): TeamChatMessage[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages WHERE run_id = ? AND visibility = 'activity' ORDER BY rowid`).all(runId) as
    Array<Parameters<typeof rowToMessage>[0]>;
  return rows.map(rowToMessage);
}

/**
 * Whether a lead turn's message is worth the owner's attention (plan KTD3). It is when the turn
 * answered an owner message, when every task of the run is done (the result), or when a task
 * failed for a reason only the owner can repair (the blocker). A decision is always shown; the
 * caller decides that before asking. Everything else is activity.
 */
export function leadMessageVisibility(db: Database.Database, runId: string, attemptId: string): "chat" | "activity" {
  const answered = db.prepare(`SELECT 1 FROM team_chat_messages
    WHERE run_id = ? AND sender = 'owner' AND delivered_attempt = ? LIMIT 1`).get(runId, attemptId);
  if (answered) return "chat";
  const tasks = db.prepare(`SELECT json_extract(a.assignment_json, '$.role') AS role, q.state AS state, a.qitem_id AS qitemId
    FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
    WHERE a.run_id = ? AND json_extract(a.assignment_json, '$.role') IN ('implementer', 'reviewer')`).all(runId) as
    Array<{ role: string; state: string; qitemId: string }>;
  if (tasks.some(task => task.role === "implementer") && tasks.every(task => task.state === "done" || task.state === "handed-off")) return "chat";
  for (const task of tasks) {
    if (task.state !== "failed") continue;
    const latest = db.prepare("SELECT failure_json AS failureJson FROM team_attempts WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(task.qitemId) as { failureJson: string | null } | undefined;
    try {
      const code = latest?.failureJson ? (JSON.parse(latest.failureJson) as { reasonCode?: string }).reasonCode : undefined;
      if (code && (ATTEMPT_REASON_CODES as readonly string[]).includes(code)
        && failureClassFor(code as AttemptReasonCode) === "environment") return "chat";
    } catch { /* An unreadable classification is no evidence of an owner repair. */ }
  }
  return "activity";
}

/** Owner messages no lead prompt has carried yet, oldest first. */
export function pendingOwnerMessages(db: Database.Database, runId: string): TeamChatMessage[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages
    WHERE run_id = ? AND sender = 'owner' AND kind = 'text' AND delivered_attempt IS NULL ORDER BY rowid`).all(runId) as
    Array<Parameters<typeof rowToMessage>[0]>;
  return rows.map(rowToMessage);
}

/** One extra slot belongs only to this run's lead carrying an owner message. */
export function ownerMessageSlot(db: Database.Database, runId: string, taskId: string, attemptId?: string): number {
  if (runLeadTask(db, runId)?.taskId !== taskId) return 0;
  return db.prepare(`SELECT 1 FROM team_chat_messages WHERE run_id = ? AND sender = 'owner' AND kind = 'text'
    AND (delivered_attempt IS NULL OR delivered_attempt = ?) LIMIT 1`).get(runId, attemptId ?? null) ? 1 : 0;
}

/** Return a failed turn's messages only after its reply had a chance to be recorded. */
function returnUnansweredMessages(db: Database.Database, runId: string, attemptId: string): number {
  return db.prepare(`UPDATE team_chat_messages SET delivered_attempt = NULL
    WHERE run_id = ? AND sender = 'owner' AND delivered_attempt = ?
      AND NOT EXISTS (SELECT 1 FROM team_chat_messages WHERE run_id = ? AND sender = 'lead' AND attempt_id = ?)`)
    .run(runId, attemptId, runId, attemptId).changes;
}

/**
 * Take the pending owner messages for one attempt, marking them delivered.
 *
 * Idempotent per attempt: a prompt written twice for the same attempt (a retried delivery)
 * reads the same messages and marks the same rows, and the second call returns what the first
 * did. A stopped turn without a recorded reply returns its messages to pending; delivery alone
 * is not acknowledgment.
 */
export function takeOwnerMessages(db: Database.Database, runId: string, attemptId: string): TeamChatMessage[] {
  const pending = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages
    WHERE run_id = ? AND sender = 'owner' AND kind = 'text' AND (delivered_attempt IS NULL OR delivered_attempt = ?) ORDER BY rowid`)
    .all(runId, attemptId) as Array<Parameters<typeof rowToMessage>[0]>;
  if (!pending.length) return [];
  db.prepare(`UPDATE team_chat_messages SET delivered_attempt = ?
    WHERE run_id = ? AND sender = 'owner' AND kind = 'text' AND delivered_attempt IS NULL`).run(attemptId, runId);
  return pending.map(rowToMessage);
}

/**
 * Store the lead's message for one attempt: its reply, or the decision it asked the owner for.
 *
 * The attempt is the identity: one lead turn has one message, and the sweep that observes the
 * turn's end may run twice. A row already recorded for the attempt is left alone.
 */
export function recordLeadReply(db: Database.Database, input: {
  id: string; runId: string; attemptId: string; body: string; createdAt: string;
  /** U6 — a turn that asked for a decision records that decision as its message. */
  decision?: { options: readonly string[] } | null;
  /** Plan KTD3 — a message that needs no owner attention is kept as run activity. A decision is always chat. */
  visibility?: "chat" | "activity";
}): boolean {
  const decision = input.decision ?? null;
  const visibility = decision === null ? input.visibility ?? "chat" : "chat";
  const inserted = db.prepare(`INSERT OR IGNORE INTO team_chat_messages
    (id, run_id, sender, kind, body, options_json, attempt_id, created_at, visibility)
    VALUES (?, ?, 'lead', ?, ?, ?, ?, ?, ?)`).run(input.id, input.runId, decision === null ? "text" : "decision",
    input.body, decision === null ? null : JSON.stringify(decision.options), input.attemptId, input.createdAt, visibility);
  return inserted.changes === 1;
}

/**
 * U6 — record the owner's message as the answer to one decision.
 *
 * The decision row is the one place the pending state lives: `answered_by` set means answered,
 * null means the run is still waiting. A decision another message already answered keeps its
 * first answer, which is what makes a replayed request record nothing twice.
 */
export function answerDecision(db: Database.Database, decisionId: string, messageId: string): boolean {
  return db.prepare("UPDATE team_chat_messages SET answered_by = ? WHERE id = ? AND kind = 'decision' AND answered_by IS NULL")
    .run(messageId, decisionId).changes === 1;
}

/** The decision the run is waiting on: the newest lead decision no owner message answered. */
export function pendingDecision(db: Database.Database, runId: string): TeamChatMessage | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages
    WHERE run_id = ? AND kind = 'decision' AND answered_by IS NULL ORDER BY rowid DESC LIMIT 1`).get(runId) as
    Parameters<typeof rowToMessage>[0] | undefined;
  return row ? rowToMessage(row) : null;
}

/**
 * Whether this run's conversation already holds this exact decision.
 *
 * An escalation file stays in the lead's tree after the turn that wrote it, so a later turn's
 * end reads it again. The same question with the same options is one decision: the owner
 * answers it once, and a stale file must not put a second copy in front of them.
 */
function decisionRecorded(db: Database.Database, runId: string, body: string, options: readonly string[]): boolean {
  const row = db.prepare(`SELECT options_json AS optionsJson FROM team_chat_messages
    WHERE run_id = ? AND kind = 'decision' AND body = ? ORDER BY rowid DESC LIMIT 1`).get(runId, body) as
    { optionsJson: string | null } | undefined;
  return row !== undefined && row.optionsJson === JSON.stringify(options);
}

/** The run's one lead task, which is the task the chat talks to. */
export function runLeadTask(db: Database.Database, runId: string): { taskId: string; qitemId: string } | null {
  const row = db.prepare(`SELECT task_id AS taskId, qitem_id AS qitemId FROM team_queue_authority
    WHERE run_id = ? AND json_extract(assignment_json, '$.role') = 'lead' LIMIT 1`).get(runId) as
    { taskId: string; qitemId: string } | undefined;
  return row ?? null;
}

/**
 * The owner's messages as the lead's turn prompt states them.
 *
 * They are prose to the agent, not a protocol: the lead's answer is its turn's final message,
 * which the daemon stores as its reply. The bound is the message's own, so a long message is
 * delivered whole rather than cut where its instruction is.
 */
export function leadChatTurnNote(messages: readonly TeamChatMessage[], history: readonly TeamChatMessage[] = [],
  outstandingWorkflows?: readonly WorkflowSelection[]): string | null {
  const workflows = outstandingWorkflows ?? messages.flatMap(message => {
    const workflow = ownerWorkflowCommand(message.body);
    return workflow ? [{ ...workflow, ownerMessageId: message.id }] : [];
  });
  if (!messages.length && !workflows.length) return null;
  return ["The owner wrote to you in the run's chat:",
    ...messages.map(message => {
      const question = history.find(turn => turn.kind === "decision" && turn.answeredBy === message.id);
      return question ? `Question being answered: ${question.body}\nOptions: ${JSON.stringify(question.options)}\nOwner: ${message.body}`
        : `Owner: ${message.body}`;
    }),
    ...workflows.map(workflow => "Owner workflow request (data): " + JSON.stringify(workflow)),
    ...(workflows.length ? ["These requests await assignment to an eligible worker under the approved scope. Planning approval remains separate. " +
      "Do not turn an implementation or review request into your own Lead chat workflow."] : []),
    "Brief public progress updates are shown live while you work. Describe current actions and results, not private reasoning.",
    "Answer the owner in your final message. They read that message as your reply."].join("\n\n");
}

/** What the turn-end owner needs: the durable rows, the launch path, and a clock. */
export interface LeadTurnEndDependencies {
  db: Database.Database;
  governance: PlanGovernance;
  /**
   * The direct worker's mutable state root, where each attempt's prompt and final message live.
   * The same root the completion sweep reads a Codex thread id from, so the two readers of the
   * end of a turn agree on where a turn's output sits.
   */
  turnStateRoot?: string;
  /**
   * U6 — the decision this turn asked the owner for, read from the lead's own tree.
   *
   * Absent means this daemon does not read escalations, which is what every pre-U6 caller
   * wants: the turn is then only its final message. A throw means the lead wrote something the
   * boundary refuses, and the turn's message is still stored.
   */
  readEscalation?: (runId: string, taskId: string) => import("./lead-proposal.js").LeadEscalation | null;
  captureDocuments?: (attempt: { id: string; runId: string; qitemId: string | null; role: string }) => void;
  /** The daemon's dispatch, read at use so a host that composes it later is still the owner. */
  dispatch: () => ((runId: string, taskId: string) => Promise<void>) | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * The lead turn's end, as its conversation sees it.
 *
 * Two writes, in this order, and both idempotent:
 *
 * 1. The turn's message becomes the lead's message. `readAgentTurnLastMessage` is the one
 *    reader for either client — Claude's stream-json `result`, written by the readable view, and
 *    Codex's `-o` file — so a Lead on Codex chats exactly as a Claude Lead does. A turn that
 *    wrote `lead-escalation.json` speaks with that decision instead of its prose: the question
 *    is what the owner has to answer, and one turn is one message.
 * 2. Unanswered messages return to pending. The next eligible turn carries them, as it carries
 *    messages that arrived during this turn. Dispatch still enforces run state, retry timing,
 *    same-seat admission and the lead wake limits.
 *
 * A completed delivery task is reopened when a pending owner message still needs a reply.
 * Closed runs and failed tasks waiting on owner repair keep the message pending without launching.
 */
export function composeLeadTurnEnd(dependencies: LeadTurnEndDependencies): (attempt: {
  id: string; runId: string; qitemId: string | null; role: string;
}) => Promise<void> {
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  /** The decision the lead's tree holds for this turn, or null when it asked for none. */
  const escalationOf = (runId: string): import("./lead-proposal.js").LeadEscalation | null => {
    if (!dependencies.readEscalation) return null;
    const task = runLeadTask(dependencies.db, runId);
    if (!task) return null;
    try { return dependencies.readEscalation(runId, task.taskId); }
    catch (error) {
      // A file the boundary refuses is not a decision: the turn still said something in its
      // final message, and a refused escalation must not silently become one the owner answers.
      // A candidate the runtime cannot adopt right now reads the same way, and is worth saying
      // because a turn with an intended decision would otherwise look like a turn without one.
      log(`team chat: no escalation was read for run=${runId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  return async (attempt) => {
    if (attempt.role !== "lead") return;
    dependencies.captureDocuments?.(attempt);
    // One reader for either client: a Claude turn's view records its stream-json `result` in
    // this file and a Codex turn writes it through `-o`, so a Codex lead's reply is chat too.
    const body = dependencies.turnStateRoot
      ? readAgentTurnLastMessage(dependencies.turnStateRoot, attempt.id) : null;
    const asked = escalationOf(attempt.runId);
    // The escalation is what the owner must act on, so it is the message; its context is prose
    // they read, and the options are the structured part the client renders as choices. A file
    // the run has already turned into a decision is not asked again: the turn then speaks with
    // its own final message.
    const content = asked
      ? asked.context ? `${asked.question}\n\n${asked.context}` : asked.question
      : null;
    const escalation = asked && content !== null && !decisionRecorded(dependencies.db, attempt.runId, content, asked.options)
      ? asked : null;
    if (!body && !escalation) {
      returnUnansweredMessages(dependencies.db, attempt.runId, attempt.id);
    } else {
      const message = escalation
        ? escalation.context ? `${escalation.question}\n\n${escalation.context}` : escalation.question
        : body!;
      const inserted = dependencies.db.transaction(() => {
        const visibility = escalation ? "chat" : leadMessageVisibility(dependencies.db, attempt.runId, attempt.id);
        const recorded = recordLeadReply(dependencies.db, { id: `chat-${attempt.id}`, runId: attempt.runId, attemptId: attempt.id,
          body: message, createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
          ...(escalation ? { decision: { options: escalation.options } } : { visibility }) });
        const title = body ? generatedReplyTitle(body) : null;
        if (recorded && title) {
          dependencies.db.prepare("UPDATE team_runs SET display_name = ? WHERE id = ?").run(title, attempt.runId);
          dependencies.db.prepare(`UPDATE team_queue_authority SET display_name = ?
            WHERE run_id = ? AND json_extract(assignment_json, '$.role') = 'lead'`).run(title, attempt.runId);
        }
        return recorded;
      })();
      if (!inserted) return;
    }
    if (!pendingOwnerMessages(dependencies.db, attempt.runId).length) return;
    const run = dependencies.governance.getRun(attempt.runId);
    if (run.state !== "approved") return;
    const task = runLeadTask(dependencies.db, attempt.runId);
    if (!task || dependencies.governance.openAttemptCount(task.qitemId) > 0) return;
    if (["done", "handed-off"].includes(dependencies.governance.queueState(task.qitemId) ?? "")) {
      dependencies.governance.continueLeadChat({ protocolVersion: "1.0", runId: attempt.runId, actionId: task.taskId,
        expectedEntityVersion: run.entityVersion, idempotencyKey: `lead-chat-continue:${attempt.id}`, payload: {} },
      { kind: "daemon", sessionId: "daemon" });
    }
    const state = dependencies.governance.queueState(task.qitemId);
    if (state !== "pending" && state !== "in-progress") return;
    const dispatch = dependencies.dispatch();
    if (!dispatch) return;
    try { await dispatch(attempt.runId, task.taskId); }
    catch (error) { log(`team chat: the lead's next turn for run=${attempt.runId} did not start: ${error instanceof Error ? error.message : String(error)}`); }
  };
}
