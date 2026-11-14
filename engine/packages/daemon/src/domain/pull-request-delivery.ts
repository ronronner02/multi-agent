import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import type { Integration, MergeOutcome } from "./integration-branch.js";
import type { PlanGovernance } from "./plan-governance.js";

/**
 * Plan R17 / KTD13 — a run whose project lives on GitHub ends in a pull request.
 *
 * Once every task is done, the dedicated agent account pushes the run's integration branch and
 * opens a pull request; later commits (a follow-up's) are pushed to the same branch. The owner
 * merges it with their own account, so the agent never merges its own work. A project without a
 * GitHub origin, or without a usable agent account, keeps today's local merge.
 */
export interface AgentHost {
  status(): Promise<{ signedIn: boolean; login: string | null }>;
  repositoryAccess(identity: string): Promise<{ push: boolean; defaultBranch: string }>;
  pushBranch(repository: string, branch: string): Promise<void>;
  findPullRequest(identity: string, branch: string): Promise<{ number: number; url: string; state: string; headSha: string } | null>;
  createPullRequest(identity: string, branch: string, base: string, title: string, body: string): Promise<{ number: number; url: string }>;
}
export interface OwnerHost {
  status(): Promise<{ signedIn: boolean; login: string | null }>;
  mergePullRequest(identity: string, number: number, headSha: string): Promise<void>;
}

export interface PullRequestRecord { runId: string; repository: string; number: number; url: string; headSha: string; state: "open" | "merged" | "closed" }

/** `owner/name` from a GitHub origin URL, or null for any other remote. */
export function githubIdentity(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function git(cwd: string, args: readonly string[]): string | null {
  try { return execFileSync("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim(); }
  catch { return null; }
}

export function readPullRequest(db: Database.Database, runId: string): PullRequestRecord | null {
  const row = db.prepare(`SELECT run_id AS runId, repository, number, url, head_sha AS headSha, state FROM team_pull_requests WHERE run_id = ?`)
    .get(runId) as PullRequestRecord | undefined;
  return row ?? null;
}

function writePullRequest(db: Database.Database, record: PullRequestRecord, now: string): void {
  db.prepare(`INSERT INTO team_pull_requests (run_id, repository, number, url, head_sha, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET repository = excluded.repository, number = excluded.number, url = excluded.url,
      head_sha = excluded.head_sha, state = excluded.state, updated_at = excluded.updated_at`)
    .run(record.runId, record.repository, record.number, record.url, record.headSha, record.state, now);
}

export interface PullRequestDeliveryDeps {
  db: Database.Database;
  governance: PlanGovernance;
  integration: Integration;
  agent: AgentHost;
  owner: OwnerHost;
  now?: () => Date;
  log?: (message: string) => void;
}

/** How long a run waits after a failed delivery before the sweep tries GitHub again. */
const RETRY_MS = [60_000, 120_000, 300_000, 900_000];

export function composePullRequestDelivery(deps: PullRequestDeliveryDeps) {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = () => deps.now?.() ?? new Date();
  const backoff = new Map<string, { failures: number; notBefore: number }>();
  const due = (runId: string) => (backoff.get(runId)?.notBefore ?? 0) <= now().getTime();
  const failed = (runId: string, error: unknown) => {
    const failures = (backoff.get(runId)?.failures ?? 0) + 1;
    backoff.set(runId, { failures, notBefore: now().getTime() + RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]! });
    log(`team delivery: run=${runId} pull request not updated: ${error instanceof Error ? error.message : String(error)}`);
  };

  /** Push and open (or update) the pull request for one finished run. Returns the record or null when not applicable. */
  async function deliver(runId: string): Promise<PullRequestRecord | null> {
    const status = deps.integration.status(runId);
    if (!status.tasksDone || status.commits.length === 0 || status.merge.merged === true || !status.repository) return null;
    const head = git(status.repository, ["rev-parse", "--verify", `refs/heads/${status.branch}^{commit}`]);
    const identity = githubIdentity(git(status.repository, ["remote", "get-url", "origin"]) ?? "");
    if (!head || !identity) return null;
    const existing = readPullRequest(deps.db, runId);
    if (existing && existing.state !== "open") return existing;
    if (existing && existing.headSha === head) return existing;
    const [agent, owner] = await Promise.all([deps.agent.status(), deps.owner.status()]);
    // The agent never acts as the owner: a missing or same account keeps the local merge.
    if (!agent.signedIn || !agent.login || (owner.signedIn && owner.login === agent.login)) return null;
    const access = await deps.agent.repositoryAccess(identity);
    if (!access.push) throw new Error("github_agent_no_access");
    await deps.agent.pushBranch(status.repository, status.branch);
    let pull = existing ? { number: existing.number, url: existing.url } : await deps.agent.findPullRequest(identity, status.branch);
    if (!pull) {
      const run = deps.governance.getRun(runId);
      const body = ["This is by an automated agent, not a human.", "",
        `Delivers the team run "${run.displayName ?? runId}".`, "",
        ...status.commits.map(commit => `- ${commit.subject}`)].join("\n");
      pull = await deps.agent.createPullRequest(identity, status.branch, access.defaultBranch, run.displayName ?? status.branch, body);
    }
    const record: PullRequestRecord = { runId, repository: identity, number: pull.number, url: pull.url, headSha: head, state: "open" };
    writePullRequest(deps.db, record, now().toISOString());
    return record;
  }

  return {
    deliver,
    pullRequest: (runId: string) => readPullRequest(deps.db, runId),
    /** One sweep step: every approved run whose tasks are done gets its pull request, with backoff on failure. */
    async sweep(): Promise<void> {
      const runs = deps.db.prepare("SELECT id FROM team_runs WHERE state = 'approved'").all() as { id: string }[];
      for (const run of runs) {
        if (!due(run.id)) continue;
        try { await deliver(run.id); backoff.delete(run.id); }
        catch (error) { failed(run.id, error); }
      }
    },
    /**
     * The owner's merge. With an open pull request it merges on GitHub at the recorded head with
     * the owner's account; otherwise it is null and the caller keeps the local merge.
     */
    async merge(runId: string): Promise<MergeOutcome | null> {
      const record = readPullRequest(deps.db, runId);
      if (!record || record.state !== "open") return null;
      const branch = deps.integration.status(runId).branch;
      await deps.owner.mergePullRequest(record.repository, record.number, record.headSha);
      writePullRequest(deps.db, { ...record, state: "merged" }, now().toISOString());
      return { status: "merged", code: null, reason: null, branch, mode: "pull-request", head: record.headSha };
    },
  };
}
export type PullRequestDelivery = ReturnType<typeof composePullRequestDelivery>;
