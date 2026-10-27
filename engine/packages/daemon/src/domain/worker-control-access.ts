import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { TeamControlCredentials } from "../middleware/auth-bearer-token.js";

/**
 * T053 — the worker control credential owner.
 *
 * One token per `(runId, sessionId)`, which is the pair every consumer of a worker
 * credential already keys on: `resolveManagedWorkerScope` matches the task's queue
 * destination, `WorkerMailboxBridge` matches its own binding, and
 * `resolveTeamControlCredential` derives the run scope from it. Nothing else needs to
 * know the attempt id, so the store does not carry one.
 *
 * Only the digest is durable. The plaintext lives in this process for exactly as long as
 * an endpoint can authenticate with it — an attempt that outlived the daemon has no
 * bootstrap, because the bootstrap sits beside a socket the daemon closed. A restart
 * therefore starts with no worker token to honour and revokes every row it inherits
 * (`reconcile`), which is the same lifetime T042 gives an endpoint.
 *
 * Issuance and reading are separate on purpose. The endpoint authenticates every request
 * against `readCredentials()`, so a read must never write: a "read" that minted would let a
 * request against a revoked seat bring its credential back. `issue` is called once, by the
 * producer, before the endpoint exists.
 *
 * The `credentials` object is mutated in place rather than replaced: startup hands one
 * instance to the control routes, the managed launch control and the history adapter, and
 * a replacement would leave some of them reading a stale copy.
 */
export class WorkerControlAccess {
  private readonly issued = new Map<string, { token: string; sessionId: string; runId: string }>();
  /** Credentials the process entry supplied: configuration this owner honours, never leftovers. */
  private readonly supplied: Set<string>;

  constructor(private readonly db: Database.Database, readonly credentials: TeamControlCredentials) {
    // A caller that hands startup a worker credential is configuring this process, so the
    // token is not an inherited one and reconciliation must not revoke it. In production
    // nothing is supplied and every durable row belongs to a process that no longer exists.
    this.supplied = new Set();
    for (const worker of credentials.workers ?? []) {
      const key = `${worker.runId}\u0000${worker.sessionId}`;
      this.issued.set(key, { ...worker });
      this.supplied.add(key);
    }
  }

  /** The token for this seat, minted once and reused for as long as it is not retired. */
  issue(runId: string, sessionId: string): string {
    const key = `${runId}\u0000${sessionId}`;
    const existing = this.issued.get(key);
    if (existing) return existing.token;
    const token = randomBytes(32).toString("base64url");
    this.db.prepare(`INSERT INTO team_worker_credentials (run_id, session_id, token_digest, issued_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(run_id, session_id) DO UPDATE SET token_digest = excluded.token_digest,
      issued_at = excluded.issued_at`).run(runId, sessionId, digestOf(token), new Date().toISOString());
    this.issued.set(key, { token, sessionId, runId });
    this.publish();
    return token;
  }

  /** Whether this seat currently has a live credential, without minting one. */
  has(runId: string, sessionId: string): boolean {
    return this.issued.has(`${runId}\u0000${sessionId}`);
  }

  /** The credentials the control routes, the launcher and the mailbox all authenticate against. */
  readCredentials(): TeamControlCredentials {
    return this.credentials;
  }

  /** Drop a retired attempt's credential; the row is the durable half, the token the live one. */
  retire(runId: string, sessionId: string): void {
    this.issued.delete(`${runId}\u0000${sessionId}`);
    this.db.prepare("DELETE FROM team_worker_credentials WHERE run_id = ? AND session_id = ?").run(runId, sessionId);
    this.publish();
  }

  /**
   * Boot reconciliation: a token this process never minted cannot authenticate anything,
   * because its plaintext was never durable. Revoking every inherited row is what keeps a
   * digest from outliving the endpoint it belonged to; a credential the process entry
   * supplied is configuration and stays.
   */
  reconcile(): void {
    this.db.prepare("DELETE FROM team_worker_credentials").run();
    for (const key of [...this.issued.keys()]) if (!this.supplied.has(key)) this.issued.delete(key);
    this.publish();
  }

  private publish(): void {
    this.credentials.workers = [...this.issued.values()].map(({ token, sessionId, runId }) => ({ token, sessionId, runId }));
  }
}

function digestOf(token: string): string {
  return "sha256:" + createHash("sha256").update(token).digest("hex");
}