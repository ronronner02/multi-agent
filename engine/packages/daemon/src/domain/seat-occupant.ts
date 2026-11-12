/**
 * U4 / R5 — a seat is the durable role identity; the process is a replaceable occupant.
 *
 * Multi-Agent's seat identity and occupant truth pattern (Apache-2.0) is the idea, and this
 * module is our own implementation. Keep it thin: the resident process is `resolved`,
 * a seat with no process is `none`, and an unobservable state is `ambiguous`. Never guess.
 *
 * The search intent is: two strings (a seat name and an occupant id) and one three-valued
 * truth value. That's the whole public surface.
 */

export type OccupantTruth = "resolved" | "none" | "ambiguous";

export interface SeatOccupant {
  /** The durable seat name (the role identity). */
  seat: string;
  /** The occupant identifier (process-related identity), or null when none is resolved. */
  occupantId: string | null;
  /** Whether the occupant is known, absent, or cannot be determined. */
  truth: OccupantTruth;
}

/**
 * The occupant is the recorded process identity for the seat's attempt.
 *
 * A running attempt with a known identity resolves the occupant. A seat with no running
 * attempt has no occupant. Everything else — a running attempt with unknown identity,
 * an identity that cannot be verified — is `ambiguous`.
 */
export function seatOccupantFromAttempts(
  seat: string,
  attempts: ReadonlyArray<{ id: string; state: string; identity: unknown }>,
): SeatOccupant {
  const running = attempts.filter(a => a.state === "running");
  if (running.length === 0) {
    return { seat, occupantId: null, truth: "none" };
  }
  // Multiple running attempts is itself ambiguous.
  if (running.length > 1) {
    return { seat, occupantId: null, truth: "ambiguous" };
  }
  const attempt = running[0]!;
  if (!attempt.identity) {
    return { seat, occupantId: null, truth: "ambiguous" };
  }
  return { seat, occupantId: attempt.id, truth: "resolved" };
}

/**
 * Map an identity-state result to an occupant truth.
 *
 * `alive` and `dead` are resolved (the occupant is known). `not-ours` and `unknown` are
 * ambiguous (something is running but we cannot prove it is ours). Never treat unknown as
 * resolved or none.
 */
export function occupantTruthFromIdentity(state: "alive" | "dead" | "not-ours" | "unknown"): OccupantTruth {
  switch (state) {
    case "alive":
    case "dead":
      return "resolved";
    case "not-ours":
    case "unknown":
      return "ambiguous";
  }
}
