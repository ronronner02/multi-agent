import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * T053 — the per-seat mailbox capability.
 *
 * `poll` matches messages on `capability`, and the mailbox bridge hands the recipient's own
 * value to its endpoint, so a value minted twice would leave the seat's mailbox permanently
 * unreadable. This is therefore the single minting site: a seat gets one `mailbox:{43}` for a
 * run, created with its task assignment and read back by every later sender.
 * `ChatRepository.sendMailbox` still mints when a caller supplies none, but a managed sender
 * names this value, which is what keeps the two ends agreeing.
 *
 * The tmux removal deleted this file and left the composition returning an empty string, which
 * the producer refuses with `Invalid mailbox capability` — so no managed attempt could be
 * produced at all. It is restored here because the value is a property of the seat's mailbox
 * and not of any transport.
 */
export function ensureSeatMailboxCapability(db: Database.Database, runId: string, sessionId: string,
  now: Date = new Date()): string {
  const select = db.prepare(
    "SELECT capability FROM team_seat_mailbox_capabilities WHERE run_id = ? AND session_id = ?");
  const existing = select.get(runId, sessionId) as { capability: string } | undefined;
  if (existing) return existing.capability;
  const capability = `mailbox:${randomBytes(32).toString("base64url")}`;
  // Two writers racing on the same seat keep the first value; the loser reads it back rather
  // than returning a capability the seat's mailbox does not answer to.
  db.prepare(`INSERT INTO team_seat_mailbox_capabilities (run_id, session_id, capability, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(run_id, session_id) DO NOTHING`)
    .run(runId, sessionId, capability, now.toISOString());
  return (select.get(runId, sessionId) as { capability: string }).capability;
}

/** The composition handle startup injects; the function above stays the one owner. */
export class SeatMailboxCapabilities {
  constructor(private readonly db: Database.Database, private readonly clock: () => Date = () => new Date()) {}

  forSeat(runId: string, sessionId: string): string {
    return ensureSeatMailboxCapability(this.db, runId, sessionId, this.clock());
  }

  /**
   * The value already recorded for this seat, or null. A send uses this: it must never mint,
   * because a message is not the place to establish a seat's mailbox identity.
   */
  find(runId: string, sessionId: string): string | null {
    const row = this.db.prepare(
      "SELECT capability FROM team_seat_mailbox_capabilities WHERE run_id = ? AND session_id = ?")
      .get(runId, sessionId) as { capability: string } | undefined;
    return row?.capability ?? null;
  }
}