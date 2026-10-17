import type Database from "better-sqlite3";
import { latestHookMovedOn, type AgentActivityStore } from "./agent-activity-store.js";
import { makePromptStateReader } from "./queue-wake-ladder.js";
import type { SeatActivityService } from "./seat-activity-service.js";
import type {
  ChatRepository,
  MailboxConsumptionReceipt,
  MailboxMessage,
  MailboxScope,
  MailboxSendResult,
} from "./chat-repository.js";

export const MAILBOX_POLL_RETRY_MS = 1_000;
export const MAILBOX_MAX_POLL_LIMIT = 100;
const MAILBOX_SESSION_STATES: ReadonlySet<string> = new Set(["ready", "prompt-active", "reconnect", "queued-wait"]);
/** A hook dated further ahead than this is not evidence of the present. */
const MAILBOX_CLOCK_SKEW_MS = 5_000;

export type MailboxSessionState = "ready" | "prompt-active" | "reconnect" | "queued-wait";

/** What the daemon itself observes at a recipient seat's prompt boundary. */
export type MailboxPromptState = "blocked" | "clear" | "unknown";
export type MailboxPromptStateReader = (recipient: string) => MailboxPromptState;

export interface MailboxPromptStateDeps {
  db: Database.Database;
  seatActivity?: Pick<SeatActivityService, "getSeatState"> | null;
  agentActivityStore?: Pick<AgentActivityStore, "getLatestForNode"> | null;
  /** When this daemon started observing; older evidence cannot read clear. */
  observedSince: string;
  now?: () => Date;
}

export interface MailboxSendRequest {
  rigId: string;
  sender: string;
  recipient: string;
  taskId: string;
  runId: string;
  body: string;
  messageId?: string;
  replyTo?: string | null;
  attachment?: unknown | null;
  capability?: string;
}

export interface MailboxPollRequest extends MailboxScope {
  state?: MailboxSessionState;
  limit?: number;
}

export interface MailboxPollResult {
  status: "ready" | "empty" | "prompt-active" | "reconnect" | "queued-wait";
  sessionState: MailboxSessionState;
  promptState: MailboxPromptState;
  messages: MailboxMessage[];
  pendingCount: number;
  retryAfterMs: number | null;
}

export interface MailboxConsumeRequest extends MailboxScope {
  messageId: string;
  consumedBy: string;
  /** May only hold delivery back; it never admits it. */
  state?: MailboxSessionState;
  /** How the route proved `consumedBy`; recorded on the receipt. */
  consumedByProvenance?: string | null;
}

export interface MailboxConsumptionResult {
  message: MailboxMessage;
  receipt: MailboxConsumptionReceipt;
}

export class MailboxDeliveryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Validates a caller-reported session state; an absent state stays absent. */
export function mailboxSessionState(value: string | undefined): MailboxSessionState | undefined {
  if (value === undefined) return undefined;
  if (!MAILBOX_SESSION_STATES.has(value)) {
    throw new MailboxDeliveryError(
      "invalid_mailbox_state",
      "state must be ready, prompt-active, reconnect or queued-wait",
    );
  }
  return value as MailboxSessionState;
}

/**
 * Reads the recipient seat's prompt state through the wake ladder's reader,
 * anchored at daemon start, so both block on the same evidence. Delivery is
 * stricter about "clear": the seat oracle's clear is not time-bounded and
 * carries no occupant generation, so it also needs this occupant's latest
 * hook to be fresh, generation-valid, observed since the daemon started and
 * not dated in the future. Anything else reads "unknown", which callers
 * treat as not admitted.
 */
export function createMailboxPromptStateReader(deps: MailboxPromptStateDeps): MailboxPromptStateReader {
  const now = deps.now ?? (() => new Date());
  const readWakePromptState = makePromptStateReader({
    db: deps.db,
    getSeatState: (nodeId) => deps.seatActivity?.getSeatState(nodeId),
    getLatestHook: (sessionName) => deps.agentActivityStore?.getLatestForNode({ sessionName }),
  });
  return (recipient) => {
    const wake = readWakePromptState(recipient, deps.observedSince);
    if (wake !== "clear") return wake;
    const hook = deps.agentActivityStore?.getLatestForNode({ sessionName: recipient }) ?? null;
    const eventAt = hook?.eventAt ? Date.parse(hook.eventAt) : NaN;
    const fresh = hook?.evidenceSource === "runtime_hook" && hook.stale !== true
      && eventAt <= now().getTime() + MAILBOX_CLOCK_SKEW_MS
      && latestHookMovedOn(hook, deps.observedSince, null);
    return fresh ? "clear" : "unknown";
  };
}

/**
 * Addressed peer delivery built on the existing ChatRepository rows.
 *
 * Polling is deliberately a data-only operation. It never reaches a native
 * terminal, submits a key, or interprets the body as an approval response.
 * Without a prompt-state reader nothing is ever admitted.
 */
export class MailboxDelivery {
  constructor(
    private readonly chatRepo: ChatRepository,
    private readonly readPromptState: MailboxPromptStateReader = () => "unknown",
  ) {}

  send(input: MailboxSendRequest): MailboxSendResult {
    const rigId = requiredText(input.rigId, "rigId");
    const sender = requiredText(input.sender, "sender");
    const recipient = requiredText(input.recipient, "recipient");
    const taskId = requiredText(input.taskId, "taskId");
    const runId = requiredText(input.runId, "runId");
    const body = requiredBody(input.body);
    const messageId = optionalText(input.messageId, "messageId");
    const replyTo = optionalText(input.replyTo, "replyTo") ?? null;
    const capability = optionalText(input.capability, "capability");

    try {
      return this.chatRepo.sendMailbox(rigId, sender, {
        messageId: messageId ?? undefined,
        recipient,
        taskId,
        runId,
        body,
        replyTo,
        attachment: input.attachment ?? null,
        capability: capability ?? undefined,
      });
    } catch (error) {
      if (error instanceof MailboxDeliveryError) throw error;
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string") throw new MailboxDeliveryError(code, (error as Error).message);
      throw error;
    }
  }

  poll(input: MailboxPollRequest): MailboxPollResult {
    const scope = normalizeScope(input);
    const sessionState = mailboxSessionState(input.state) ?? "ready";
    const limit = normalizeLimit(input.limit);
    const pendingCount = this.chatRepo.countPendingMailbox(scope);
    // The seat is read only for a scope that names pending rows, so a foreign
    // capability learns nothing about the recipient's prompt state.
    const promptState = pendingCount > 0 ? this.readPromptState(scope.recipient) : "unknown";

    // Only the daemon's own observation opens a delivery boundary; a caller's
    // state can hold delivery back but never admit it. Keeping the row pending
    // prevents peer text from becoming an approval answer.
    if (sessionState === "prompt-active" || (pendingCount > 0 && promptState !== "clear")) {
      return {
        status: "prompt-active",
        sessionState,
        promptState,
        messages: [],
        pendingCount,
        retryAfterMs: pendingCount > 0 ? MAILBOX_POLL_RETRY_MS : null,
      };
    }

    const messages = this.chatRepo.listMailbox(scope, limit);
    let status: MailboxPollResult["status"] = "ready";
    if (messages.length === 0) {
      status = sessionState === "queued-wait"
        ? "queued-wait"
        : sessionState === "reconnect"
          ? "reconnect"
          : "empty";
    }
    return {
      status,
      sessionState,
      promptState,
      messages,
      pendingCount,
      retryAfterMs: messages.length === 0 ? MAILBOX_POLL_RETRY_MS : null,
    };
  }

  consume(input: MailboxConsumeRequest): MailboxConsumptionResult {
    const scope = normalizeScope(input);
    const messageId = requiredText(input.messageId, "messageId");
    const consumedBy = requiredText(input.consumedBy, "consumedBy");
    const state = mailboxSessionState(input.state);
    try {
      // Existence and scope come first, so a foreign capability learns nothing
      // about the seat. Admission is then decided once, here, from the daemon's
      // observation; a prompt that appears afterwards is an observed outcome (KTD22).
      this.chatRepo.getMailbox({ ...scope, messageId });
      if (state === "prompt-active" || this.readPromptState(scope.recipient) !== "clear") {
        throw new MailboxDeliveryError(
          "mailbox_not_admitted",
          "the recipient seat is not at a daemon-observed safe boundary; retry later",
        );
      }
      return this.chatRepo.consumeMailbox({
        ...scope,
        messageId,
        consumedBy,
        consumedByProvenance: input.consumedByProvenance ?? null,
      });
    } catch (error) {
      if (error instanceof MailboxDeliveryError) throw error;
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string") throw new MailboxDeliveryError(code, (error as Error).message);
      throw error;
    }
  }
}

function normalizeScope(input: MailboxScope): MailboxScope {
  return {
    rigId: requiredText(input.rigId, "rigId"),
    recipient: requiredText(input.recipient, "recipient"),
    taskId: requiredText(input.taskId, "taskId"),
    runId: requiredText(input.runId, "runId"),
    capability: requiredText(input.capability, "capability"),
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1 || value > MAILBOX_MAX_POLL_LIMIT) {
    throw new MailboxDeliveryError(
      "invalid_mailbox_limit",
      `mailbox limit must be an integer from 1 to ${MAILBOX_MAX_POLL_LIMIT}`,
    );
  }
  return value;
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MailboxDeliveryError("invalid_mailbox_input", `${field} is required`);
  }
  return value.trim();
}

function requiredBody(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MailboxDeliveryError("invalid_mailbox_input", "body is required");
  }
  return value;
}

function optionalText(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new MailboxDeliveryError("invalid_mailbox_input", `${field} must be a non-empty string when provided`);
  }
  return value.trim();
}

