import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export const OWNER_COOKIE = "multi_agent_owner";
export const OWNER_CSRF_HEADER = "X-Multi-Agent-CSRF";
export const PAIRING_TTL_MS = 60_000;
export const OWNER_IDLE_MS = 30 * 60_000;
export const OWNER_ABSOLUTE_MS = 12 * 60 * 60_000;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const digest = (purpose: string, value: string) => createHash("sha256").update(purpose + "\0" + value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

export interface OwnerSession {
  id: string; origin: string; created_at: number; last_seen_at: number; expires_at: number; revoked_at: number | null;
}
type StoredSession = OwnerSession & { csrf_hash: string };
export type OwnerSessionResult = { ok: true; session: OwnerSession }
  | { ok: false; code: "owner_session_required" | "owner_anti_forgery_required"; status: 401 | 403 };

/** One control-owned database is the authority for pairing, expiry and revocation. Raw secrets are never stored. */
export class OwnerSessions {
  constructor(readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  mint(ownerToken: string): { code: string; expiresAt: number } {
    const code = secret(), at = this.now(), expiresAt = at + PAIRING_TTL_MS;
    this.db.prepare("INSERT INTO owner_pairing_codes (code_hash, owner_hash, expires_at) VALUES (?, ?, ?)")
      .run(digest("pairing", code), digest("owner", ownerToken), expiresAt);
    return { code, expiresAt };
  }

  exchange(code: unknown, origin: string, ownerToken: string):
    { token: string; antiForgeryToken: string; session: OwnerSession } | null {
    if (typeof code !== "string" || !SECRET.test(code)) return null;
    return this.db.transaction(() => {
      const at = this.now(), owner = digest("owner", ownerToken);
      const consumed = this.db.prepare(`UPDATE owner_pairing_codes SET consumed_at = ?
        WHERE code_hash = ? AND owner_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
        .run(at, digest("pairing", code), owner, at);
      if (consumed.changes !== 1) return null;
      const token = secret(), antiForgeryToken = secret();
      const session: OwnerSession = { id: randomUUID(), origin, created_at: at, last_seen_at: at,
        expires_at: at + OWNER_ABSOLUTE_MS, revoked_at: null };
      this.db.prepare(`INSERT INTO owner_sessions
        (id, token_hash, csrf_hash, owner_hash, origin, created_at, last_seen_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(session.id, digest("session", token), digest("csrf", antiForgeryToken), owner, origin, at, at, session.expires_at);
      return { token, antiForgeryToken, session };
    })();
  }

  authenticate(cookie: string | undefined | null, origin: string | undefined, csrf: string | undefined,
    requireCsrf: boolean, ownerToken: string): OwnerSessionResult {
    const values = (cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(OWNER_COOKIE + "="));
    const token = values.length === 1 ? values[0]!.slice(OWNER_COOKIE.length + 1) : "";
    if (!SECRET.test(token) || !origin) return { ok: false, code: "owner_session_required", status: 401 };
    return this.db.transaction((): OwnerSessionResult => {
      const at = this.now();
      const row = this.db.prepare(`SELECT id, origin, created_at, last_seen_at, expires_at, revoked_at, csrf_hash
        FROM owner_sessions WHERE token_hash = ? AND owner_hash = ? AND origin = ?
        AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?`)
        .get(digest("session", token), digest("owner", ownerToken), origin, at, at - OWNER_IDLE_MS) as StoredSession | undefined;
      if (!row) return { ok: false, code: "owner_session_required", status: 401 };
      if (requireCsrf && (!csrf || !SECRET.test(csrf)
        || !timingSafeEqual(Buffer.from(row.csrf_hash, "hex"), Buffer.from(digest("csrf", csrf), "hex")))) {
        return { ok: false, code: "owner_anti_forgery_required", status: 403 };
      }
      this.db.prepare("UPDATE owner_sessions SET last_seen_at = ? WHERE id = ?").run(at, row.id);
      return { ok: true, session: { id: row.id, origin: row.origin, created_at: row.created_at,
        last_seen_at: at, expires_at: row.expires_at, revoked_at: row.revoked_at } };
    })();
  }

  list(): OwnerSession[] {
    return this.db.prepare(`SELECT id, origin, created_at, last_seen_at, expires_at, revoked_at
      FROM owner_sessions ORDER BY created_at, id`).all() as OwnerSession[];
  }

  revoke(id: string): boolean {
    return this.db.prepare("UPDATE owner_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.now(), id).changes === 1;
  }
}
