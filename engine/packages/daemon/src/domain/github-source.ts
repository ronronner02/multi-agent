import type Database from "better-sqlite3";
import type { PlanGovernance } from "./plan-governance.js";
import type { ControlReceipt } from "../contracts/team-control.js";

/**
 * Plan R18 / KTD11 / KTD12 — the team's open pull request feeds its own work.
 *
 * Each open team pull request is polled as the agent account. A review comment on a file goes to
 * the task whose write paths own that file, as a comment on its thread; everything else, and a
 * failed CI check, goes to the lead's chat. Only the owner and collaborators with write access
 * are delivered: bots, the agent's own comments and anyone else are recorded and dropped, so a
 * public repository's strangers cannot steer an agent. Delivered items are recorded, so a restart
 * never delivers one twice.
 */
export interface SourceHost {
  status(): Promise<{ signedIn: boolean; login: string | null }>;
  apiGet<T = unknown>(path: string): Promise<T>;
}

interface GithubUser { login: string; type?: string }
interface ReviewComment { node_id: string; body: string; path?: string; line?: number | null; user: GithubUser; html_url: string }
interface IssueComment { node_id: string; body: string; user: GithubUser; html_url: string }
interface Review { node_id: string; body: string | null; state: string; user: GithubUser; html_url: string }
interface CheckRun { id: number; name: string; conclusion: string | null; html_url: string }

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
const WRITERS = new Set(["admin", "maintain", "write"]);
const FAILED = new Set(["failure", "timed_out"]);

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

export function composeGithubSource(deps: GithubSourceDeps) {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = () => deps.now?.() ?? new Date();
  const nextPoll = new Map<string, number>();
  const writers = new Map<string, boolean>();
  const seen = (runId: string, item: string) => Boolean(deps.db.prepare("SELECT 1 FROM team_github_seen WHERE run_id = ? AND item = ?").get(runId, item));
  const markSeen = (runId: string, item: string) => deps.db.prepare("INSERT OR IGNORE INTO team_github_seen (run_id, item, seen_at) VALUES (?, ?, ?)")
    .run(runId, item, now().toISOString());
  const request = (runId: string, actionId: string, payload: unknown) => ({ protocolVersion: "1.0" as const, runId, actionId, payload,
    expectedEntityVersion: deps.governance.getRun(runId).entityVersion, idempotencyKey: actionId });
  const actor = { kind: "owner" as const, sessionId: "github-source" };
  const start = async (runId: string, receipt: ControlReceipt) => {
    if (!receipt.effectMayStart || !receipt.revisionTaskId) return;
    try { await deps.dispatch()?.(runId, receipt.revisionTaskId); }
    catch (error) { log(`team github: run=${runId} did not start ${receipt.revisionTaskId}: ${error instanceof Error ? error.message : String(error)}`); }
  };

  /** Whether an author's words may reach an agent: the owner, or a collaborator who can write. */
  async function delivered(repository: string, user: GithubUser, owner: string | null, agent: string | null): Promise<"owner" | "collaborator" | null> {
    if (user.type === "Bot" || user.login === agent) return null;
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
      deps.db.prepare("UPDATE team_pull_requests SET state = ?, updated_at = ? WHERE run_id = ?")
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
    for (const comment of reviewComments) {
      if (seen(runId, comment.node_id)) continue;
      const who = await delivered(repository, comment.user, owner.login, agent.login);
      if (who) {
        const where = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""}` : "the pull request";
        const body = `GitHub review comment by @${comment.user.login} on ${where}:\n${comment.body}\n${comment.html_url}`;
        const task = comment.path ? owningTask(deps.db, runId, comment.path) : null;
        if (task) await toTask(runId, task, comment.node_id, body);
        else await toLead(runId, comment.node_id, body);
      }
      markSeen(runId, comment.node_id);
    }
    const conversation = [...issueComments.map(comment => ({ id: comment.node_id, body: comment.body, user: comment.user, url: comment.html_url })),
      ...reviews.filter(review => (review.body ?? "").trim() || review.state === "CHANGES_REQUESTED")
        .map(review => ({ id: review.node_id, body: review.body?.trim() || "Changes requested.", user: review.user, url: review.html_url }))];
    for (const item of conversation) {
      if (seen(runId, item.id)) continue;
      const who = await delivered(repository, item.user, owner.login, agent.login);
      if (who) await toLead(runId, item.id, `GitHub comment by @${item.user.login} on the team's pull request:\n${item.body}\n${item.url}`);
      markSeen(runId, item.id);
    }
    for (const check of checks.check_runs ?? []) {
      const item = `check-${check.id}`;
      if (!check.conclusion || !FAILED.has(check.conclusion) || seen(runId, item)) continue;
      await toLead(runId, item, `GitHub (automated): CI check "${check.name}" failed on the team's pull request.\n${check.html_url}`);
      markSeen(runId, item);
    }
  }

  return {
    poll,
    /** One sweep step: each open team pull request is read at most once a minute. */
    async sweep(): Promise<void> {
      const open = deps.db.prepare("SELECT run_id AS runId, repository, number FROM team_pull_requests WHERE state = 'open'").all() as
        { runId: string; repository: string; number: number }[];
      for (const pull of open) {
        if ((nextPoll.get(pull.runId) ?? 0) > now().getTime()) continue;
        nextPoll.set(pull.runId, now().getTime() + POLL_MS);
        try { await poll(pull.runId, pull.repository, pull.number); }
        catch (error) { log(`team github: run=${pull.runId} poll failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    },
  };
}
export type GithubSource = ReturnType<typeof composeGithubSource>;
