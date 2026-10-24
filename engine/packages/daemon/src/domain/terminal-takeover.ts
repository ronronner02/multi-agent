import type { EventBus } from "./event-bus.js";

export const TERMINAL_TAKEOVER_IDLE_MS = 15 * 60_000;

export type TerminalTakeoverEndReason =
  | "release"
  | "disconnect"
  | "revoked"
  | "inactivity"
  | "replaced";

export type TerminalTakeoverAuditAction =
  | "takeover_started"
  | "takeover_reused"
  | "takeover_released"
  | "takeover_expired"
  | "takeover_revoked"
  | "takeover_disconnected"
  | "takeover_denied"
  | "input_rejected";

export interface TerminalTakeoverAuditRecord {
  type: "terminal.takeover.audit";
  action: TerminalTakeoverAuditAction;
  ownerSessionId: string;
  targetSession: string;
  at: number;
  reason?: string;
}

export interface TerminalTakeoverState {
  id: string;
  ownerSessionId: string;
  targetSession: string;
  startedAt: number;
  lastInputAt: number;
}

export type TerminalTakeoverResult =
  | { ok: true; state: TerminalTakeoverState; reused?: boolean }
  | { ok: false; code: "invalid_takeover_target" | "takeover_active" | "owner_session_required"; state?: TerminalTakeoverState };

export interface TerminalTakeoverManagerOptions {
  now?: () => number;
  idleMs?: number;
  eventBus?: EventBus;
  isOwnerSessionActive?: (ownerSessionId: string, at: number) => boolean;
  audit?: (record: TerminalTakeoverAuditRecord) => void | Promise<void>;
}

function validPart(value: string): boolean {
  return value.trim().length > 0 && value.length <= 512;
}

/**
 * In-memory owner keyboard authority. The daemon keeps the authority separate
 * from the terminal byte stream: this state contains identifiers and times,
 * never terminal input or output.
 */
export class TerminalTakeoverManager {
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly eventBus?: EventBus;
  private readonly isOwnerSessionActive?: (ownerSessionId: string, at: number) => boolean;
  private readonly audit?: (record: TerminalTakeoverAuditRecord) => void | Promise<void>;
  private readonly active = new Map<string, TerminalTakeoverState>();
  private readonly pendingGrants = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingClosures = new Map<string, { record: TerminalTakeoverAuditRecord; inFlight: boolean }>();

  constructor(options: TerminalTakeoverManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? TERMINAL_TAKEOVER_IDLE_MS;
    this.eventBus = options.eventBus;
    this.isOwnerSessionActive = options.isOwnerSessionActive;
    this.audit = options.audit;
  }

  begin(ownerSessionId: string, targetSession: string, at = this.now()): TerminalTakeoverResult {
    if (!validPart(ownerSessionId)) return { ok: false, code: "owner_session_required" };
    if (!validPart(targetSession)) return { ok: false, code: "invalid_takeover_target" };
    if (this.pendingGrants.has(targetSession)) return { ok: false, code: "takeover_active" };
    this.flushPendingClosure(targetSession);
    this.expireInactive(at);
    if (this.isOwnerSessionActive && !this.isOwnerSessionActive(ownerSessionId, at)) {
      this.record({ type: "terminal.takeover.audit", action: "takeover_denied", ownerSessionId, targetSession, at, reason: "owner_session_revoked" });
      return { ok: false, code: "owner_session_required" };
    }

    const current = this.active.get(targetSession);
    if (current) {
      if (current.ownerSessionId !== ownerSessionId) {
        this.record({
          type: "terminal.takeover.audit",
          action: "takeover_denied",
          ownerSessionId,
          targetSession,
          at,
          reason: "takeover_active",
        });
        return { ok: false, code: "takeover_active", state: { ...current } };
      }
      this.record({
        type: "terminal.takeover.audit",
        action: "takeover_reused",
        ownerSessionId,
        targetSession,
        at,
      }, () => {
        current.lastInputAt = at;
        this.schedule(current);
      });
      return { ok: true, state: { ...current }, reused: true };
    }

    const state: TerminalTakeoverState = {
      id: `${ownerSessionId}:${targetSession}:${at}`,
      ownerSessionId,
      targetSession,
      startedAt: at,
      lastInputAt: at,
    };
    this.record({
      type: "terminal.takeover.audit",
      action: "takeover_started",
      ownerSessionId,
      targetSession,
      at,
    }, () => {
      this.active.set(targetSession, state);
      this.schedule(state);
    });
    return { ok: true, state: { ...state } };
  }

  release(ownerSessionId: string, targetSession: string, reason: TerminalTakeoverEndReason = "release", at = this.now()): boolean {
    const state = this.active.get(targetSession);
    if (!state || state.ownerSessionId !== ownerSessionId) return false;
    return this.endStates([state], reason, at) === 1;
  }

  disconnect(ownerSessionId: string, at = this.now()): number {
    return this.endForOwner(ownerSessionId, "disconnect", at);
  }

  revoke(ownerSessionId: string, at = this.now()): number {
    return this.endForOwner(ownerSessionId, "revoked", at);
  }

  /** Remove all sessions whose inactivity deadline has elapsed. */
  expireInactive(at = this.now()): number {
    return this.endStates([...this.active.values()].filter(state => at - state.lastInputAt >= this.idleMs), "inactivity", at);
  }

  authorizeInput(ownerSessionId: string, targetSession: string, at = this.now()): boolean {
    this.expireInactive(at);
    const state = this.active.get(targetSession);
    if (state?.ownerSessionId === ownerSessionId && this.isOwnerSessionActive && !this.isOwnerSessionActive(state.ownerSessionId, at)) {
      this.release(state.ownerSessionId, state.targetSession, "revoked", at);
      return false;
    }
    if (!state || state.ownerSessionId !== ownerSessionId) {
      this.record({
        type: "terminal.takeover.audit",
        action: "input_rejected",
        ownerSessionId,
        targetSession,
        at,
        reason: "takeover_required",
      });
      return false;
    }
    state.lastInputAt = at;
    this.schedule(state);
    return true;
  }

  get(targetSession: string): TerminalTakeoverState | undefined {
    const state = this.active.get(targetSession);
    return state ? { ...state } : undefined;
  }

  list(): TerminalTakeoverState[] {
    return [...this.active.values()].map(state => ({ ...state }));
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.active.clear();
  }

  private endForOwner(ownerSessionId: string, reason: "disconnect" | "revoked", at: number): number {
    return this.endStates([...this.active.values()].filter(state => state.ownerSessionId === ownerSessionId), reason, at);
  }

  private endStates(states: TerminalTakeoverState[], reason: TerminalTakeoverEndReason, at: number): number {
    const action = reason === "inactivity" ? "takeover_expired" : reason === "revoked" ? "takeover_revoked"
      : reason === "disconnect" ? "takeover_disconnected" : "takeover_released";
    // Disable the entire batch before persistence or observers can interrupt closure.
    for (const state of states) {
      this.active.delete(state.targetSession);
      this.clearTimer(state.targetSession);
      this.pendingClosures.set(state.targetSession, { record: {
        type: "terminal.takeover.audit", action, ownerSessionId: state.ownerSessionId,
        targetSession: state.targetSession, at, ...(reason === "release" ? {} : { reason }),
      }, inFlight: false });
    }
    let failure: { error: unknown } | undefined;
    for (const state of states) {
      try { this.flushPendingClosure(state.targetSession); } catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
    return states.length;
  }

  private flushPendingClosure(targetSession: string): void {
    const pending = this.pendingClosures.get(targetSession);
    if (!pending) return;
    if (pending.inFlight) throw new Error("terminal closure audit in progress");
    pending.inFlight = true;
    try {
      this.record(pending.record);
      if (this.pendingClosures.get(targetSession) === pending) this.pendingClosures.delete(targetSession);
    } finally { pending.inFlight = false; }
  }

  private schedule(state: TerminalTakeoverState): void {
    this.clearTimer(state.targetSession);
    const timer = setTimeout(() => {
      const current = this.active.get(state.targetSession);
      if (current?.id !== state.id) return;
      // A failed audit remains an admission blocker; background expiry must not crash the daemon.
      try { this.expireInactive(this.now()); } catch { /* retried before readmission */ }
    }, this.idleMs);
    // Timers must not keep the daemon alive during a clean shutdown or test.
    timer.unref?.();
    this.timers.set(state.targetSession, timer);
  }

  private clearTimer(targetSession: string): void {
    const timer = this.timers.get(targetSession);
    if (timer) clearTimeout(timer);
    this.timers.delete(targetSession);
  }

  private record(record: TerminalTakeoverAuditRecord, apply?: () => void): void {
    // Persistence is authoritative; observers are optional and must not escape as unhandled rejections.
    if (apply) this.pendingGrants.add(record.targetSession);
    let persisted: ReturnType<EventBus["persistWithinTransaction"]> | undefined;
    try {
      persisted = this.eventBus?.persistWithinTransaction(record as never);
      apply?.();
    } finally { if (apply) this.pendingGrants.delete(record.targetSession); }
    if (persisted) this.eventBus?.notifySubscribers(persisted);
    try { void Promise.resolve(this.audit?.(record)).catch(() => {}); } catch { /* observer only */ }
  }
}
