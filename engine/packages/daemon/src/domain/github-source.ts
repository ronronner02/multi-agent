import type Database from "better-sqlite3";
import type { PlanGovernance } from "./plan-governance.js";
import type { ControlReceipt } from "../contracts/team-control.js";
import { readHandback } from "./task-thread.js";

/**
 * Plan R18 / R19 / KTD11 / KTD12 — the team's open pull request feeds its own work.
 *
 * Each open team pull request is polled as the agent account. A review comment on a file goes to
 * the task whose write paths own that file, as a comment on its thread; everything else, and a
 * failed CI check, goes to the lead's chat. Only the owner, collaborators with write access and
 * automated reviewers are delivered, and an automated reviewer only for its first three review
 * rounds on a pull request. The agent's own comments and anyone else's are recorded and dropped,
 * so a public repository's strangers cannot steer an agent. Delivered items are recorded, so a
 * restart never delivers one twice. A failed poll backs off, doubling up to 15 minutes.
 *
 * A review comment a task took is answered by outcome through the agent account: a declined one
 * gets the task's one sentence of reason, and a fixed one has its thread resolved, without a
 * reply, once a newer head is pushed to the pull request.
 */
export interface SourceHost {
  status(): Promise<{ signedIn: boolean; login: string | null }>;
  apiGet<T = unknown>(path: string): Promise<T>;
  apiPost<T = unknown>(path: string, fields: Record<string, string>): Promise<T>;
  graphql<T = unknown>(query: string, variables: Record<string, string | number>): Promise<T>;
}

interface GithubUser { login: string; type?: string }
interface ReviewComment { id: number; node_id: string; body: string; path?: string; line?: number | null; user: GithubUser; html_url: string;
  pull_request_review_id?: number | null }
interface IssueComment { node_id: string; body: string; user: GithubUser; html_url: string }
interface Review { id: number; node_id: string; body: string | null; state: string; user: GithubUser; html_url: string }
interface CheckRun { id: number; name: string; conclusion: string | null; html_url: string }
type Author = "owner" | "collaborator" | "automated";

export interface GithubSourceDeps {
  db: Database.Database;
  governance: PlanGovernance;
  agent: SourceHost;
  owner: Pick<SourceHost, "status">;
  dispatch: () => ((runId: string, taskId: string) => Promise<void>) | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

const POLL_MS = 60_000;
const BACKOFF_MAX_MS = 900_000;
const WRITERS = new Set(["admin", "maintain", "write"]);
const FAILED = new Set(["failure", "timed_out"]);
/** Plan R19 — the review rounds an automated reviewer gets on one pull request. */
export const AUTOMATED_ROUNDS = 3;
/** The tries a thread reply gets before it is recorded as failed. */
const REPLY_ATTEMPTS = 3;
export const AGENT_LINE = "This is by an automated agent, not a human.";

/** The implementer task whose write paths cover `file`, the most specific first. */
export function owningTask(db: Database.Database, runId: string, file: string): string | null {
  const rows = db.prepare(`SELECT a.task_id AS taskId, a.assignment_json AS assignment FROM team_queue_authority a
    JOIN queue_items q ON q.qitem_id = a.qitem_id
    WHERE a.run_id = ? AND json_extract(a.assignment_json, '$.role') = 'implementer' AND q.state NOT IN ('canceled', 'denied')`)
    .all(runId) as { taskId: string; assignment: string }[];
  let best: { taskId: string; depth: number } | null = null;
  for (const row of rows) {
    for (const path of (JSON.parse(row.assignment) as { paths: string[] }).paths) {
      const clean = path.replace(/\/+$/, "");
      const covers = clean === "." || file === clean || file.startsWith(clean + "/");
      const depth = clean === "." ? 0 : clean.split("/").length;
      if (covers && (!best || depth > best.depth)) best = { taskId: row.taskId, depth };
    }
  }
  return best?.taskId ?? null;
}

const RESOLVE_QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
  pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { id } } } } } } }`;
const RESOLVE_MUTATION = "mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }";

export function composeGithubSource(deps: GithubSourceDeps) {
  const { db } = deps;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = () => deps.now?.() ?? new Date();
  const nextPoll = new Map<string, number>();
  const failures = new Map<string, number>();
  const writers = new Map<string, boolean>();
  /** A thread whose reply failed waits a poll interval before its next try. */
  const retryAt = new Map<string, number>();
  const seen = (runId: string, item: string) => Boolean(db.prepare("SELECT 1 FROM team_github_seen WHERE run_id = ? AND item = ?").get(runId, item));
  const markSeen = (runId: string, item: string) => db.prepare("INSERT OR IGNORE INTO team_github_seen (run_id, item, seen_at) VALUES (?, ?, ?)")
    .run(runId, item, now().toISOString());
  const request = (runId: string, actionId: string, payload: unknown) => ({ protocolVersion: "1.0" as const, runId, actionId, payload,
    expectedEntityVersion: deps.governance.getRun(runId).entityVersion, idempotencyKey: actionId });
  const actor = { kind: "owner" as const, sessionId: "github-source" };
  const start = async (runId: string, receipt: ControlReceipt) => {
    if (!receipt.effectMayStart || !receipt.revisionTaskId) return;
    try { await deps.dispatch()?.(runId, receipt.revisionTaskId); }
    catch (error) { log(`team github: run=${runId} did not start ${receipt.revisionTaskId}: ${error instanceof Error ? error.message : String(error)}`); }
  };

  /** Whose words these are, when they may reach an agent at all. An automated reviewer counts only within its rounds. */
  async function author(repository: string, user: GithubUser, owner: string | null, agent: string | null,
    round: number | null): Promise<Author | null> {
    if (user.login === agent) return null;
    if (user.type === "Bot") return round !== null && round < AUTOMATED_ROUNDS ? "automated" : null;
    if (owner && user.login === owner) return "owner";
    const key = `${repository}\u0000${user.login}`;
    if (!writers.has(key)) {
      try {
        const answer = await deps.agent.apiGet<{ permission?: string }>(`repos/${repository}/collaborators/${user.login}/permission`);
        writers.set(key, WRITERS.has(answer.permission ?? ""));
      } catch { writers.set(key, false); }
    }
    return writers.get(key) ? "collaborator" : null;
  }
  const byline = (user: GithubUser, who: Author) => who === "automated" ? `@${user.login} (automated reviewer)` : `@${user.login}`;

  async function toTask(runId: string, taskId: string, item: string, body: string) {
    const run = deps.governance.getRun(runId);
    await start(runId, deps.governance.postTaskComment(request(runId, `gh-${item}`, { taskId, body }), actor, run.binding));
  }
  async function toLead(runId: string, item: string, body: string) {
    const run = deps.governance.getRun(runId);
    await start(runId, deps.governance.postChatMessage(request(runId, `gh-${item}`, { body }), actor, run.binding));
  }

  async function poll(runId: string, repository: string, number: number): Promise<void> {
    const pull = await deps.agent.apiGet<{ state: string; merged?: boolean; head: { sha: string } }>(`repos/${repository}/pulls/${number}`);
    if (pull.state !== "open") {
      db.prepare("UPDATE team_pull_requests SET state = ?, updated_at = ? WHERE run_id = ?")
        .run(pull.merged ? "merged" : "closed", now().toISOString(), runId);
      return;
    }
    const [agent, owner] = await Promise.all([deps.agent.status(), deps.owner.status()]);
    const [reviewComments, issueComments, reviews, checks] = await Promise.all([
      deps.agent.apiGet<ReviewComment[]>(`repos/${repository}/pulls/${number}/comments`),
      deps.agent.apiGet<IssueComment[]>(`repos/${repository}/issues/${number}/comments`),
      deps.agent.apiGet<Review[]>(`repos/${repository}/pulls/${number}/reviews`),
      deps.agent.apiGet<{ check_runs?: CheckRun[] }>(`repos/${repository}/commits/${pull.head.sha}/check-runs`),
    ]);
    // An automated reviewer's rounds are its reviews on this pull request, oldest first.
    const rounds = new Map<string, number[]>();
    for (const review of reviews) {
      if (review.user.type !== "Bot") continue;
      const ids = rounds.get(review.user.login) ?? [];
      if (!ids.includes(review.id)) ids.push(review.id);
      rounds.set(review.user.login, ids);
    }
    const roundOf = (user: GithubUser, reviewId: number | null | undefined) => {
      const index = reviewId === null || reviewId === undefined ? -1 : (rounds.get(user.login) ?? []).sort((a, b) => a - b).indexOf(reviewId);
      return index < 0 ? null : index;
    };
    for (const comment of reviewComments) {
      if (seen(runId, comment.node_id)) continue;
      const who = await author(repository, comment.user, owner.login, agent.login, roundOf(comment.user, comment.pull_request_review_id));
      if (who) {
        const where = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""}` : "the pull request";
        const body = `GitHub review comment by ${byline(comment.user, who)} on ${where}:\n${comment.body}\n${comment.html_url}`;
        const task = comment.path ? owningTask(db, runId, comment.path) : null;
        if (task) {
          db.prepare(`INSERT OR IGNORE INTO team_github_threads (run_id, message_id, repository, number, comment_id, node_id, state, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`).run(runId, `gh-${comment.node_id}`, repository, number, comment.id, comment.node_id, now().toISOString());
          await toTask(runId, task, comment.node_id, body);
        } else await toLead(runId, comment.node_id, body);
      }
      markSeen(runId, comment.node_id);
    }
    const conversation = [
      ...issueComments.filter(comment => comment.user.type !== "Bot")
        .map(comment => ({ id: comment.node_id, body: comment.body, user: comment.user, url: comment.html_url, round: null as number | null })),
      ...reviews.filter(review => (review.body ?? "").trim() || review.state === "CHANGES_REQUESTED")
        .map(review => ({ id: review.node_id, body: review.body?.trim() || "Changes requested.", user: review.user, url: review.html_url,
          round: roundOf(review.user, review.id) })),
    ];
    for (const item of conversation) {
      if (seen(runId, item.id)) continue;
      const who = await author(repository, item.user, owner.login, agent.login, item.round);
      if (who) await toLead(runId, item.id, `GitHub comment by ${byline(item.user, who)} on the team's pull request:\n${item.body}\n${item.url}`);
      markSeen(runId, item.id);
    }
    for (const check of checks.check_runs ?? []) {
      const item = `check-${check.id}`;
      if (!check.conclusion || !FAILED.has(check.conclusion) || seen(runId, item)) continue;
      await toLead(runId, item, `GitHub (automated): CI check "${check.name}" failed on the team's pull request.\n${check.html_url}`);
      markSeen(runId, item);
    }
  }

  interface Thread { runId: string; messageId: string; repository: string; number: number; commentId: number; nodeId: string;
    outcome: "fixed" | "declined"; reason: string | null; headSha: string | null; attempts: number }
  const closeThread = (thread: Thread, state: "open" | "done" | "failed", attempts = thread.attempts) =>
    db.prepare("UPDATE team_github_threads SET state = ?, attempts = ?, updated_at = ? WHERE run_id = ? AND message_id = ?")
      .run(state, attempts, now().toISOString(), thread.runId, thread.messageId);

  async function resolve(thread: Thread): Promise<void> {
    const [owner, name] = thread.repository.split("/") as [string, string];
    const found = await deps.agent.graphql<{ repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string; isResolved: boolean;
      comments: { nodes: Array<{ id: string }> } }> } } } }>(RESOLVE_QUERY, { owner, name, number: thread.number });
    const target = found.repository.pullRequest.reviewThreads.nodes.find(node => node.comments.nodes[0]?.id === thread.nodeId);
    if (target && !target.isResolved) await deps.agent.graphql(RESOLVE_MUTATION, { thread: target.id });
  }

  /** Answer every thread whose outcome is known: a declined one now, a fixed one once a newer head is pushed. */
  async function answer(): Promise<void> {
    const threads = db.prepare(`SELECT t.run_id AS runId, t.message_id AS messageId, t.repository, t.number, t.comment_id AS commentId,
        t.node_id AS nodeId, t.outcome, t.reason, t.head_sha AS headSha, t.attempts, p.head_sha AS pullHead, p.state AS pullState
      FROM team_github_threads t LEFT JOIN team_pull_requests p ON p.run_id = t.run_id
      WHERE t.state = 'open' AND t.outcome IS NOT NULL`).all() as Array<Thread & { pullHead: string | null; pullState: string | null }>;
    for (const thread of threads) {
      if (thread.pullState !== "open") { closeThread(thread, "done"); continue; }
      if (thread.outcome === "fixed" && thread.pullHead === thread.headSha) continue;
      if ((retryAt.get(thread.messageId) ?? 0) > now().getTime()) continue;
      try {
        if (thread.outcome === "declined") {
          await deps.agent.apiPost(`repos/${thread.repository}/pulls/${thread.number}/comments/${thread.commentId}/replies`,
            { body: `${AGENT_LINE}\n\n${thread.reason}` });
        } else await resolve(thread);
        closeThread(thread, "done");
      } catch (error) {
        const attempts = thread.attempts + 1;
        closeThread(thread, attempts >= REPLY_ATTEMPTS ? "failed" : "open", attempts);
        retryAt.set(thread.messageId, now().getTime() + POLL_MS);
        log(`team github: run=${thread.runId} thread ${thread.messageId} not answered (${attempts}/${REPLY_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    poll,
    answer,
    /**
     * Record the outcome of the GitHub review comments a finished turn took. A comment the turn
     * declined in `declineFile` keeps its reason; every other one counts as fixed at the pull
     * request's current head. A failed turn records nothing: its comments go to the next turn.
     */
    attemptStopped(attempt: { id: string; runId: string }, declineFile: string): void {
      const failed = db.prepare("SELECT failure_json IS NOT NULL AS failed FROM team_attempts WHERE id = ?").get(attempt.id) as { failed: number } | undefined;
      if (!failed || failed.failed) return;
      const taken = db.prepare(`SELECT t.message_id AS messageId FROM team_github_threads t
        JOIN team_chat_messages m ON m.id = t.message_id AND m.run_id = t.run_id
        WHERE t.run_id = ? AND m.delivered_attempt = ? AND t.outcome IS NULL`).all(attempt.runId, attempt.id) as { messageId: string }[];
      if (!taken.length) return;
      const declined = new Map(readHandback(declineFile).map(entry => [entry.messageId, entry.reason]));
      const head = (db.prepare("SELECT head_sha AS headSha FROM team_pull_requests WHERE run_id = ?").get(attempt.runId) as { headSha: string } | undefined)?.headSha ?? null;
      for (const { messageId } of taken) {
        const reason = declined.get(messageId);
        db.prepare("UPDATE team_github_threads SET outcome = ?, reason = ?, head_sha = ?, updated_at = ? WHERE run_id = ? AND message_id = ?")
          .run(reason ? "declined" : "fixed", reason ?? null, head, now().toISOString(), attempt.runId, messageId);
      }
    },
    /** One sweep step: each open team pull request is read at most once a minute, less often after failures. */
    async sweep(): Promise<void> {
      const open = db.prepare("SELECT run_id AS runId, repository, number FROM team_pull_requests WHERE state = 'open'").all() as
        { runId: string; repository: string; number: number }[];
      for (const pull of open) {
        if ((nextPoll.get(pull.runId) ?? 0) > now().getTime()) continue;
        try {
          await poll(pull.runId, pull.repository, pull.number);
          failures.delete(pull.runId);
          nextPoll.set(pull.runId, now().getTime() + POLL_MS);
        } catch (error) {
          const count = (failures.get(pull.runId) ?? 0) + 1;
          failures.set(pull.runId, count);
          nextPoll.set(pull.runId, now().getTime() + Math.min(POLL_MS * 2 ** count, BACKOFF_MAX_MS));
          log(`team github: run=${pull.runId} poll failed (${count}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await answer();
    },
  };
}
export type GithubSource = ReturnType<typeof composeGithubSource>;
