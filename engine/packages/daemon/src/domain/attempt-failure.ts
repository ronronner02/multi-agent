/**
 * T033 — the one classifier for an attempt that ended.
 *
 * KTD20 gives every failed attempt exactly one reason code and a `resume_safe` flag, and only
 * five codes are eligible for KTD9's single recoverable retry. The decision has to be made in
 * one place: a consumer that re-derived eligibility could disagree with the owner's retry, and
 * the plan forbids that. This module is pure — evidence in, decision out — so the completion
 * sweep can call it at the moment it records a stop, and the tests can drive it directly.
 *
 * The order of the evidence is the order of its strength, and it never guesses:
 *
 * 1. **A cancellation is the reason.** If the run was canceling when the attempt ended, the
 *    attempt ended because the owner asked it to. No exit status or pane text can outrank that.
 * 2. **A provider or platform message the client printed.** Only lines that read as terminal
 *    errors are matched, only in a short tail, and never inside a fenced block: an agent that
 *    quotes a failure marker in its answer is reporting something, not failing.
 * 3. **A non-zero exit with nothing recognisable** is `agent_error.unknown`, and an unknown
 *    code is never retried. When uncertain, choose "not retried".
 *
 * Classification never adds an attempt or a unit of budget. It only says whether the owner's
 * already-counted retry may happen.
 */

/** Every KTD20 code, in the order the plan lists them. */
export const ATTEMPT_REASON_CODES = [
  // Platform codes.
  "runtime_offline", "daemon_recovery", "start_timeout", "run_timeout", "no_progress",
  "environment_prepare_failed", "resume_rejected", "agent_blocked", "canceled",
  // Client codes.
  "agent_error.provider_auth_or_access", "agent_error.provider_quota", "agent_error.provider_rate_limit",
  "agent_error.provider_server_error", "agent_error.provider_network", "agent_error.provider_invalid_request",
  "agent_error.model_unavailable", "agent_error.context_overflow", "agent_error.missing_config",
  "agent_error.missing_executable", "agent_error.unsupported_version", "agent_error.process_failure",
  "agent_error.unparseable_output", "agent_error.unknown",
] as const;
export type AttemptReasonCode = (typeof ATTEMPT_REASON_CODES)[number];

/**
 * KTD20's retry-eligible set, and nothing else. `agent_error.unknown` is deliberately absent:
 * an unclassified failure becomes an owner-visible blocker.
 */
export const RETRY_ELIGIBLE_REASON_CODES: readonly AttemptReasonCode[] = [
  "runtime_offline", "daemon_recovery", "run_timeout", "no_progress", "agent_error.provider_network",
];

/**
 * KTD20's resume-unsafe set. A continuation after one of these starts a fresh native session on
 * the same isolated tree, preserving its files, instead of resuming the session that failed.
 */
export const RESUME_UNSAFE_REASON_CODES: readonly AttemptReasonCode[] = [
  "agent_error.context_overflow", "agent_error.provider_invalid_request", "no_progress", "resume_rejected",
];

/**
 * What the owner can do about each code, as one sentence.
 *
 * A code outside the eligible set is a blocker, and a blocker that does not say what to do is
 * not actionable. The eligible ones say that a retry is the action, because that is the only
 * thing that code permits.
 */
export const OWNER_ACTIONS: Readonly<Record<AttemptReasonCode, string>> = {
  runtime_offline: "Start the runtime again, then retry the task.",
  daemon_recovery: "The daemon restarted during the attempt; retry the task.",
  start_timeout: "The client never became ready; repair the client or the seat, then start a new task.",
  run_timeout: "The attempt reached the run's time budget; retry the task while budget remains.",
  no_progress: "The attempt made no progress; retry with a narrower task, which starts a fresh session on the same tree.",
  environment_prepare_failed: "The attempt's environment could not be prepared; repair it, then start a new task.",
  resume_rejected: "The provider rejected the resumed session; the next attempt starts a fresh session on the same tree.",
  agent_blocked: "The agent stopped on a decision it could not make; resolve it, then start a new task.",
  canceled: "The owner canceled the run; start a new run if the work is still needed.",
  "agent_error.provider_auth_or_access": "Sign the client in or repair its provider access, then start a new task.",
  "agent_error.provider_quota": "The provider account is out of quota; add quota or wait for its reset, then start a new task.",
  "agent_error.provider_rate_limit": "The provider is rate-limiting this account; wait for the window, then start a new task.",
  "agent_error.provider_server_error": "The provider returned a server error; start a new task once its status is clear.",
  "agent_error.provider_network": "The provider was unreachable; retry the task.",
  "agent_error.provider_invalid_request": "The provider refused the request; fix the task or its model, and the next attempt starts a fresh session on the same tree.",
  "agent_error.model_unavailable": "The requested model is unavailable to this client; choose another model, then start a new task.",
  "agent_error.context_overflow": "The conversation outgrew the model's context; the next attempt starts a fresh session on the same tree.",
  "agent_error.missing_config": "The client is missing configuration it needs; repair it, then start a new task.",
  "agent_error.missing_executable": "The client executable is not on the seat's path; install it, then start a new task.",
  "agent_error.unsupported_version": "The client build is not the one this daemon supports; install the supported build, then start a new task.",
  "agent_error.process_failure": "The client process failed; inspect its output, then start a new task.",
  "agent_error.unparseable_output": "The client's output could not be read; inspect it, then start a new task.",
  "agent_error.unknown": "The daemon could not classify this failure, so it is not retried; inspect the attempt's output.",
};

/** The decision recorded with a stopped attempt, and read back by every consumer. */
export interface AttemptClassification {
  reasonCode: AttemptReasonCode;
  resumeSafe: boolean;
  retryEligible: boolean;
  ownerAction: string;
}

/**
 * The evidence the daemon actually has about an ended attempt.
 *
 * There is deliberately no phase or readiness field here: `team_attempts` records none, so a
 * classifier input for them would be invented. `start_timeout` and the platform recovery codes
 * stay in the vocabulary and in the owner table, and the slice that records attempt phases is
 * the one that will produce them.
 */
export interface AttemptEvidence {
  /** True when the run was `cancel_requested` or `canceled` when the attempt ended. */
  canceled: boolean;
  /** The process end the seat's terminal recorded, or null when it recorded none. */
  exit: { code: number | null } | null;
  /** The last lines the seat's terminal held when the process ended, or null when unreadable. */
  terminalTail: string | null;
}

/** How much terminal output a fingerprint is allowed to look at. */
export const TERMINAL_TAIL_LINES = 40;

/**
 * A line that reads as a terminal error, so a fingerprint on it is the client's own report.
 *
 * The anchors are the shapes the evidence in this repository actually has: a bracketed runner
 * tag (`[stub-runner] ERROR`), an HTTP status (`401 authentication_error`, `529 overloaded`),
 * Claude's `API Error:` prefix, and Codex's `■` banner. Prose that merely mentions a failure
 * does not begin with one of these.
 */
const TERMINAL_ERROR_LINE = /^(?:\[[^\]\n]{1,40}\]\s*)?(?:\d{3}\s|API Error\b|Error\b|ERROR\b|error\b|FATAL\b|fatal\b|panic\b|■)/;

/**
 * Text fingerprints, each captured from evidence already in this repository rather than
 * invented. Order matters only where two patterns could match one line; the more specific
 * failure wins, and an auth failure is never reported as a network one.
 *
 * `anchored` is what keeps an agent's prose from deciding the outcome. A pattern whose words
 * an agent might quote in an answer (`authentication_error`, `fetch failed`, a connection code)
 * only counts on a line that begins like a terminal error. A pattern that is itself a complete
 * message a program prints — Claude's own resume refusal, the shell's missing-command line, the
 * Codex banner — needs no anchor, because no ordinary answer contains it as a sentence.
 *
 * - `401 authentication_error: API key is invalid.` — the OMP runner fixture
 *   (`test/omp-runner.test.ts`, mirroring OMP 18.2.11's own emission).
 * - `invalid x-api-key` — Anthropic's own error text.
 * - `■ You've hit your usage limit.` — the Codex banner (`domain/provider/codex-limit-banner.ts`).
 * - `529 overloaded` / `overloaded_error` — the OMP fixture and Anthropic's error type.
 * - the connection codes — `packages/cli/src/remote-host-ops.ts` names the same set.
 * - `invalid_request_error` — the 400 the model-divergence monitor reports.
 * - `No conversation found` — Claude's own answer to a resume it cannot honour
 *   (`domain/native-resume-probe.ts`).
 * - `command not found` — the shell's answer to a missing executable
 *   (`packages/cli/src/cross-host-executor.ts` treats exit 127 the same way).
 */
const FINGERPRINTS: ReadonlyArray<{ pattern: RegExp; code: AttemptReasonCode; anchored: boolean }> = [
  { pattern: /\bauthentication_error\b/, code: "agent_error.provider_auth_or_access", anchored: true },
  { pattern: /\binvalid x-api-key\b/, code: "agent_error.provider_auth_or_access", anchored: true },
  { pattern: /You've hit your usage limit/, code: "agent_error.provider_quota", anchored: false },
  { pattern: /\binvalid_request_error\b/, code: "agent_error.provider_invalid_request", anchored: true },
  { pattern: /No conversation found/, code: "resume_rejected", anchored: false },
  { pattern: /\boverloaded_error\b|\b529 overloaded\b/, code: "agent_error.provider_server_error", anchored: true },
  { pattern: /\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/,
    code: "agent_error.provider_network", anchored: true },
  { pattern: /\bfetch failed\b/, code: "agent_error.provider_network", anchored: true },
  { pattern: /\bcommand not found\b/, code: "agent_error.missing_executable", anchored: false },
];

/** The classification a reason code implies. The three sets are the only place it is decided. */
export function classificationFor(reasonCode: AttemptReasonCode): AttemptClassification {
  return {
    reasonCode,
    resumeSafe: !RESUME_UNSAFE_REASON_CODES.includes(reasonCode),
    retryEligible: RETRY_ELIGIBLE_REASON_CODES.includes(reasonCode),
    ownerAction: OWNER_ACTIONS[reasonCode],
  };
}

/**
 * Classify an attempt that ended, or return null when the evidence shows no failure.
 *
 * Null is not "unknown": it means the daemon holds no evidence that the attempt failed — the
 * client exited cleanly, or no exit record exists at all. There is nothing to classify, the
 * attempt's owner read carries no code, and the owner's retry is refused because an
 * unclassified attempt is exactly KTD20's "when uncertain, choose not retried".
 *
 * An attempt that ended with a non-zero exit and printed nothing recognisable is
 * `agent_error.unknown` — a code, and never retried.
 */
export function classifyAttemptFailure(evidence: AttemptEvidence): AttemptClassification | null {
  if (evidence.canceled) return classificationFor("canceled");
  const printed = fingerprintOf(evidence.terminalTail);
  if (printed !== null) return classificationFor(printed);
  // No exit record is no evidence of failure, so nothing is claimed.
  if (evidence.exit === null) return null;
  if (evidence.exit.code === 0) return null;
  // A non-zero exit with no nameable cause: the attempt failed and the daemon cannot say why.
  // Uncertain means not retried.
  return classificationFor("agent_error.unknown");
}

/**
 * The code a short terminal tail names, or null.
 *
 * Only the last `TERMINAL_TAIL_LINES` lines are read, newest first, so an older error the agent
 * already worked past does not decide the outcome. A fenced block is quoted content — the same
 * rule the Codex banner detector applies — and a line has to begin like a terminal error for
 * its text to count.
 */
export function fingerprintOf(terminalTail: string | null): AttemptReasonCode | null {
  if (terminalTail === null) return null;
  const lines = terminalTail.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - TERMINAL_TAIL_LINES));
  for (let index = tail.length - 1; index >= 0; index--) {
    const line = tail[index]!;
    if (insideFence(tail, index)) continue;
    const trimmed = line.trim();
    const anchored = TERMINAL_ERROR_LINE.test(trimmed);
    for (const fingerprint of FINGERPRINTS) {
      if (fingerprint.anchored && !anchored) continue;
      if (fingerprint.pattern.test(trimmed)) return fingerprint.code;
    }
  }
  return null;
}

/** Whether a line sits inside a fenced code block opened earlier in the same tail. */
function insideFence(lines: readonly string[], index: number): boolean {
  let open = false;
  for (let i = 0; i < index; i++) if (/^\s*```/.test(lines[i]!)) open = !open;
  return open;
}

/**
 * Validate a classification read back from the database.
 *
 * This is a real boundary — the row is durable state a later process reads — so the stored
 * shape is checked rather than trusted, and a row that disagrees with the code sets is refused
 * instead of being acted on. The derived fields are recomputed from the code, so a stored
 * `retryEligible` that disagrees with KTD20 cannot grant a retry.
 */
export function parseAttemptClassification(value: unknown): AttemptClassification {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("attempt failure is not an object");
  const record = value as Record<string, unknown>;
  const reasonCode = record.reasonCode;
  if (typeof reasonCode !== "string" || !(ATTEMPT_REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new Error("attempt failure names no known reason code");
  }
  if (typeof record.ownerAction !== "string" || record.ownerAction.length === 0 || record.ownerAction.length > 1_024) {
    throw new Error("attempt failure has no owner action");
  }
  const expected = classificationFor(reasonCode as AttemptReasonCode);
  if (record.resumeSafe !== expected.resumeSafe || record.retryEligible !== expected.retryEligible) {
    throw new Error("attempt failure disagrees with the reason code's eligibility");
  }
  return expected;
}
