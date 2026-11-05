import type Database from "better-sqlite3";
import { TeamContractError } from "../contracts/team-control.js";
import { readAgentTurnLastMessage } from "./agent-turn.js";
import type { PlanGovernance } from "./plan-governance.js";

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
  body: string;
  /** The lead attempt whose final message this is; null for an owner message. */
  attemptId: string | null;
  /** The lead attempt whose prompt carried an owner message; null while it is still pending. */
  deliveredAttempt: string | null;
  createdAt: string;
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

function rowToMessage(row: { id: string; runId: string; sender: string; body: string; attemptId: string | null;
  deliveredAttempt: string | null; createdAt: string }): TeamChatMessage {
  return { ...row, sender: row.sender === "lead" ? "lead" : "owner" };
}

const COLUMNS = `id, run_id AS runId, sender, body, attempt_id AS attemptId,
  delivered_attempt AS deliveredAttempt, created_at AS createdAt`;

/** Append one message. Called inside the caller's transaction; it never opens its own. */
export function appendChatMessage(db: Database.Database, input: {
  id: string; runId: string; sender: "owner" | "lead"; body: string; attemptId?: string | null; createdAt: string;
}): TeamChatMessage {
  db.prepare(`INSERT INTO team_chat_messages (id, run_id, sender, body, attempt_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(input.id, input.runId, input.sender, input.body,
    input.attemptId === undefined ? null : input.attemptId, input.createdAt);
  return getChatMessage(db, input.id)!;
}

export function getChatMessage(db: Database.Database, id: string): TeamChatMessage | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages WHERE id = ?`).get(id) as
    Parameters<typeof rowToMessage>[0] | undefined;
  return row ? rowToMessage(row) : null;
}

/** The run's conversation, in the order it happened. */
export function listChatMessages(db: Database.Database, runId: string): TeamChatMessage[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages WHERE run_id = ? ORDER BY rowid`).all(runId) as
    Array<Parameters<typeof rowToMessage>[0]>;
  return rows.map(rowToMessage);
}

/** Owner messages no lead prompt has carried yet, oldest first. */
export function pendingOwnerMessages(db: Database.Database, runId: string): TeamChatMessage[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages
    WHERE run_id = ? AND sender = 'owner' AND delivered_attempt IS NULL ORDER BY rowid`).all(runId) as
    Array<Parameters<typeof rowToMessage>[0]>;
  return rows.map(rowToMessage);
}

/**
 * Take the pending owner messages for one attempt, marking them delivered.
 *
 * Idempotent per attempt: a prompt written twice for the same attempt (a retried delivery)
 * reads the same messages and marks the same rows, and the second call returns what the first
 * did — `delivered_attempt = ?` matches either way. A message whose prompt was written but whose
 * client never started is not retried by itself; the owner's next message brings it along with
 * the next prompt. That is the conservative answer: the daemon cannot know a turn ran until the
 * process it started is observed, and pretending otherwise would answer a message nobody read.
 */
export function takeOwnerMessages(db: Database.Database, runId: string, attemptId: string): TeamChatMessage[] {
  const pending = db.prepare(`SELECT ${COLUMNS} FROM team_chat_messages
    WHERE run_id = ? AND sender = 'owner' AND (delivered_attempt IS NULL OR delivered_attempt = ?) ORDER BY rowid`)
    .all(runId, attemptId) as Array<Parameters<typeof rowToMessage>[0]>;
  if (!pending.length) return [];
  db.prepare(`UPDATE team_chat_messages SET delivered_attempt = ?
    WHERE run_id = ? AND sender = 'owner' AND delivered_attempt IS NULL`).run(attemptId, runId);
  return pending.map(rowToMessage);
}

/**
 * Store the lead's reply to one attempt. Returns whether this call wrote it.
 *
 * The attempt is the identity: one lead turn has one final message, and the sweep that observes
 * the turn's end may run twice. A row already recorded for the attempt is left alone.
 */
export function recordLeadReply(db: Database.Database, input: {
  id: string; runId: string; attemptId: string; body: string; createdAt: string;
}): boolean {
  const inserted = db.prepare(`INSERT OR IGNORE INTO team_chat_messages (id, run_id, sender, body, attempt_id, created_at)
    VALUES (?, ?, 'lead', ?, ?, ?)`).run(input.id, input.runId, input.body, input.attemptId, input.createdAt);
  return inserted.changes === 1;
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
export function leadChatTurnNote(messages: readonly TeamChatMessage[]): string | null {
  if (!messages.length) return null;
  return ["The owner wrote to you in the run's chat:",
    ...messages.map(message => `Owner: ${message.body}`),
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
  /** The daemon's dispatch, read at use so a host that composes it later is still the owner. */
  dispatch: () => ((runId: string, taskId: string) => Promise<void>) | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * The lead turn's end, as its conversation sees it.
 *
 * Two writes, in this order, and both are idempotent:
 *
 * 1. The turn's final message becomes the lead's reply. `readAgentTurnLastMessage` is the one
 *    reader for either client — Claude's stream-json `result`, written by the readable view, and
 *    Codex's `-o` file — so a Lead on Codex chats exactly as a Claude Lead does.
 * 2. If owner messages are still waiting for a turn, the next turn starts now. They can only be
 *    waiting because they arrived while this turn was running, and a chat whose answer waits for
 *    the owner to speak again is not a conversation. Nothing starts when the turn recorded no
 *    reply: a client that failed before answering would otherwise be retried in a loop the owner
 *    never asked for, and the messages stay pending for the next message to bring along.
 *
 * A turn whose task row is no longer active is left alone: a done lead task is reopened by the
 * owner's next message, which is the path that records the reopen's reason.
 */
export function composeLeadTurnEnd(dependencies: LeadTurnEndDependencies): (attempt: {
  id: string; runId: string; qitemId: string | null; role: string;
}) => Promise<void> {
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  return async (attempt) => {
    if (attempt.role !== "lead") return;
    // One reader for either client: a Claude turn's view records its stream-json `result` in
    // this file and a Codex turn writes it through `-o`, so a Codex lead's reply is chat too.
    const body = dependencies.turnStateRoot
      ? readAgentTurnLastMessage(dependencies.turnStateRoot, attempt.id) : null;
    if (!body) return;
    const inserted = dependencies.db.transaction(() =>
      recordLeadReply(dependencies.db, { id: `chat-${attempt.id}`, runId: attempt.runId, attemptId: attempt.id,
        body, createdAt: (dependencies.now?.() ?? new Date()).toISOString() }))();
    if (!inserted) return;
    if (!pendingOwnerMessages(dependencies.db, attempt.runId).length) return;
    const run = dependencies.governance.getRun(attempt.runId);
    if (run.state !== "approved") return;
    const task = runLeadTask(dependencies.db, attempt.runId);
    if (!task || dependencies.governance.openAttemptCount(task.qitemId) > 0) return;
    const state = dependencies.governance.queueState(task.qitemId);
    if (state !== "pending" && state !== "in-progress") return;
    const dispatch = dependencies.dispatch();
    if (!dispatch) return;
    try { await dispatch(attempt.runId, task.taskId); }
    catch (error) { log(`team chat: the lead's next turn for run=${attempt.runId} did not start: ${error instanceof Error ? error.message : String(error)}`); }
  };
}