import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import type { ScopedAssignment, TeamRole } from "../contracts/team-control.js";
import { attemptInstructionFiles, type ContextManifest } from "../integrations/framework/context-manifest.js";
import { blockingFindings } from "./review-loop.js";
import type { ReviewFinding } from "./review-evidence.js";

/**
 * MVP — one attempt is one headless turn.
 *
 * Measured on the installed Claude Code 2.1.296 before this module existed: the managed
 * launch started the client *interactively* and the startup orchestrator typed the task
 * prompt into its composer. A finished agent then waited at its prompt and never exited, so
 * the completion sweep never saw the process end, the attempt never became `stopped`, and the
 * owner's outcome action was refused. Nothing about the attempt was wrong except that it was
 * a session rather than a turn.
 *
 * The owner's decision is that an attempt is one non-interactive turn (`claude -p`), and that
 * a rework or a lead revision is a **new attempt** that continues the same conversation with
 * `--resume`. This module owns the two facts both ends of that launch must agree on: the text
 * of the turn, and where it is written so it can be fed on stdin without quoting it into a
 * shell command.
 */

/**
 * Where an attempt's turn text is written.
 *
 * It sits in the attempt's mutable state rather than its projection: the projection is the
 * sealed, read-only record of what the attempt must obey, and the prompt is a launch input.
 * It is not written into the candidate tree either, because the tree is the deliverable and
 * the completion evidence counts every path that moved.
 */
export function agentTurnPromptPath(manifest: ContextManifest): string {
  return join(manifest.mutableStateRoot, "turns", manifest.projection.attemptId + ".prompt");
}

/** Durable turn output, outside the candidate and addressable by attempt id after a restart. */
export function agentTurnOutputPaths(mutableStateRoot: string, attemptId: string) {
  const directory = join(mutableStateRoot, "turns", attemptId);
  return { directory, lastMessage: join(directory, "last-message.txt"), threadId: join(directory, "thread-id.txt"),
    activity: join(directory, "activity.jsonl"), usage: join(directory, "usage.json"),
    taskReport: join(directory, "report", "task-report.json") };
}

/** The same native-token alphabet and length limit the managed Claude launcher accepts. */
export function isNativeSessionToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

/** Only a valid first thread.started id may become a resume token. */
export function readAgentTurnThreadId(path: string): string | null {
  try {
    const token = readFileSync(path, "utf8");
    return isNativeSessionToken(token) ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Write the turn's text and return its path. The file is private to the daemon's user. */
export function writeAgentTurnPrompt(manifest: ContextManifest, text: string): string {
  const path = agentTurnPromptPath(manifest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

/** The bound on a turn's final message, matching the chat body a reply becomes. */
const TURN_MESSAGE_LIMIT = 65_536;

/**
 * U5 — the final message of any managed attempt, whatever client ran it.
 *
 * A turn's answer is one file per attempt, `last-message.txt`: Codex writes it through its own
 * `-o`, and a Claude turn's readable view records its stream-json `result` into the same file.
 * So a reader of the end of a turn asks this one question — "what did attempt X say?" — without
 * knowing which client it was, and without re-parsing a terminal's scrollback. U4 reads reviewer
 * verdicts from the same answer; a lead's reply is stored in the chat from it.
 *
 * Null means the turn recorded nothing: a client that failed before answering, a command whose
 * own output is not a final message, or bytes no message could carry.
 */
export function readAgentTurnLastMessage(mutableStateRoot: string, attemptId: string): string | null {
  let bytes: Buffer;
  try { bytes = readFileSync(agentTurnOutputPaths(mutableStateRoot, attemptId).lastMessage); }
  catch { return null; }
  if (bytes.length > TURN_MESSAGE_LIMIT || bytes.includes(0)) return null;
  const text = bytes.toString("utf8").trim();
  return text || null;
}

export interface ManagedTurnPromptInput {
  /** The seat's authored identity text, when the launch has one. Empty for a dispatched task. */
  identity: string;
  /** The first `send_text` post-launch file, already read. Empty when there is none. */
  bundle: string;
  runId: string;
  assignment: ScopedAssignment;
  taskBody: string;
  outputs: readonly string[];
  permissions: readonly string[];
  /** The projected instruction files this attempt must read, at the path its client can open. */
  instructions: { path: string }[];
  /** What this attempt continues, when it is a rework or a lead revision. */
  continuation: string | null;
  taskReportPath?: string;
}

/**
 * The text a managed attempt's client receives.
 *
 * KTD28 keeps the core and the role's charter out of the brief, so they reach the client only
 * through its projection; naming those files is therefore part of the launch, not a second
 * brief. The prompt states where the attempt's instructions are, never what they say.
 *
 * A continuation states why this attempt exists. Without it a resumed agent reads the original
 * brief again and has no way to know that a reviewer's blocking finding, or the owner's
 * rejection of its proposal, is the work.
 */
export function managedTurnPrompt(input: ManagedTurnPromptInput): string {
  const instructions = input.instructions;
  return [input.identity, input.bundle, `Managed task ${input.assignment.taskId} for run ${input.runId}`, input.taskBody,
    `Assignment: ${JSON.stringify(input.assignment)}`, `Outputs: ${JSON.stringify(input.outputs)}`,
    `Permissions: ${JSON.stringify(input.permissions)}`,
    ...(instructions.length === 0 ? [] : ["Read these files before you start work; they are this attempt's role instructions and run context, and they are read-only:",
      ...instructions.map(file => `- ${file.path}`)]),
    "Work only on this assigned task in the current worktree and within its declared paths. Report the result when finished.",
    ...(input.taskReportPath ? [`Task report file: ${JSON.stringify(input.taskReportPath)}`,
      "Only this per-attempt report file is writable outside the candidate. It does not change your source permissions. " +
      "For blocked, needs-decision, or dropped, write the structured report there, not in the candidate or final prose."] : []),
    ...(input.continuation === null ? [] : [input.continuation])].filter(Boolean).join("\n\n");
}

/** The instruction files an attempt is told to read, from its own manifest. */
export function turnInstructions(manifest: ContextManifest): { path: string }[] {
  return attemptInstructionFiles(manifest);
}

/**
 * Why this attempt is a continuation, or null when it continues nothing.
 *
 * Both answers come from the run's own durable log rather than from a second record: a review
 * round's blocking findings are the `review.verdict` event that reopened the implementer, and a
 * rejected proposal's reason is the `approval.decided` event the owner's decision emitted. An
 * attempt that has neither is a plain continuation — a retry after a failure the classifier
 * called resume-safe — and says nothing about why.
 */
export function continuationNote(db: Database.Database, runId: string, taskId: string, role: TeamRole): string | null {
  if (role === "reviewer") return null;
  if (role === "lead") {
    // The decision's own event carries the reason the owner gave; the payload is the event's
    // `payload` object, so the note and the task are one level down.
    //
    // U5 — the owner's approval of the plan is the other thing a lead continuation can be. The
    // two are the same question ("what happened to what I wrote?") asked of the newest answer,
    // so the newest of the two decides and one turn is never told both.
    //
    // U6 — a refused proposal and a team event are the same question asked twice more, and every
    // one of these notes is news only until the lead has answered it: each is a fact about a
    // turn, so it is read only when it happened after the lead's last turn ended. Without that,
    // a plan approval or a wake would be restated in every later turn, and a lead that follows
    // its instructions would decompose the same plan twice.
    const lastTurnEnd = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events
      WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.taskId') = ?
        AND json_extract(payload, '$.action') = 'task.outcome'`).get(runId, taskId) as { seq: number };
    const row = db.prepare(`SELECT json_extract(payload, '$.action') AS action,
        json_extract(payload, '$.payload.note') AS note, json_extract(payload, '$.payload.reason') AS reason
      FROM events
      WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.taskId') = ?
        AND json_extract(payload, '$.action') IN ('approval.decided', 'plan.approved', 'lead.proposal-refused', 'lead.plan-refused', 'lead.woken')
        AND seq > ?
      ORDER BY seq DESC LIMIT 1`).get(runId, taskId, lastTurnEnd.seq) as
      { action: string; note: string | null; reason: string | null } | undefined;
    if (!row) return null;
    if (row.action === "plan.approved") {
      const plan = db.prepare("SELECT json_extract(binding_json, '$.planRef') AS planRef FROM team_runs WHERE id = ?")
        .get(runId) as { planRef: string | null } | undefined;
      return "This continues your earlier attempt. The owner approved the plan. It is recorded at " +
        `${plan?.planRef ?? "the plan path"} on the run's own branch, and your working tree is based on it. ` +
        "Decompose it now: write lead-proposal.json in your working tree as your run instructions describe. " +
        "Your task list is admitted without a further owner decision.";
    }
    if (row.action === "lead.plan-refused") {
      return `The planning roster was refused, because:\n\n${row.note ?? "the roster needs revision"}\n\n` +
        "Revise lead-roster.json beside the plan, then wait for the owner to approve the plan and roster together.";
    }
    if (row.action === "lead.proposal-refused") {
      return `This continues your earlier attempt. The task list you proposed was refused, because:\n\n` +
        `${row.note ?? "it is outside the approved plan"}\n\n` +
        "Write a list that stays inside the approved goal and files, or write lead-escalation.json if only the owner can decide.";
    }
    if (row.action === "lead.woken") {
      return `This continues your earlier attempt. Since your last turn:\n\n${row.note ?? "a team event needs you"}\n\n` +
        "Decide what the team does next: write the follow-up tasks to lead-proposal.json, or write " +
        "lead-escalation.json if the owner must decide.";
    }
    return row.note
      ? `This continues your earlier attempt. The owner rejected the proposal you wrote and gave this reason:\n\n${row.note}\n\nWrite a revised lead-proposal.json that answers it. The owner reads and decides the revised proposal as before.`
      : "This continues your earlier attempt. The owner rejected the proposal you wrote. Write a revised lead-proposal.json; the owner reads and decides it as before.";
  }
  const row = db.prepare(`SELECT payload FROM events
    WHERE type = 'team.control' AND json_extract(payload, '$.action') = 'review.verdict'
      AND json_extract(payload, '$.payload.taskId') = ? AND json_extract(payload, '$.payload.verdict') = 'changes-required'
    ORDER BY seq DESC LIMIT 1`).get(taskId) as { payload: string } | undefined;
  if (!row) return null;
  const record = (JSON.parse(row.payload) as { payload: { round: number; findings: ReviewFinding[] } }).payload;
  const blocking = blockingFindings(record.findings);
  if (blocking.length === 0) return null;
  return [`This continues your earlier attempt. The reviewer's round ${record.round} returned the work for rework, with ${blocking.length} blocking finding(s):`,
    ...blocking.map(finding => `- ${finding.id} (${finding.severity}, ${finding.citation}) in ${finding.file}: ${finding.scenario ?? finding.category}`),
    "Fix these in the same worktree. The candidate keeps every file your earlier attempt wrote."].join("\n");
}
