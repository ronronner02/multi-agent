# 2026-11-04: Classifying a failed attempt

**Decided by:** the implementer for T033, under the standing grants in `AGENTS.md` and decision 4
of the 2026-11-02 MVP scope amendment.

This records the decisions the slice's brief left to the code. It sits beside the completion
path (`2026-11-04-completion-path.md`) and the cancellation half of T017, and it changes no
requirement.

## Why

KTD20 requires one reason code and a `resume_safe` flag for every failed attempt, with only five
codes eligible for KTD9's single recoverable retry. On `main` nothing produced either: an attempt
that ended was recorded `stopped` and nothing said why, so the owner's retry had no reason to
refuse and the classifier that decides could not exist. The brief's own question was where the
exit evidence could come from at all — the completion sweep observes only `/proc`.

## Measured before deciding

- **A pane whose client exits is destroyed.** On tmux 3.6, `new-session`, then a foreground
  process that exits: the pane is gone, and when it was the session's only pane the session is
  gone too. `display-message #{pane_dead}` and `capture-pane` then answer "can't find pane", and a
  `no server running` answer follows for a sole session. There is no exit status and no output.
- **`remain-on-exit` preserves both.** With the pane option set before the client starts, the
  same exit leaves the pane dead, `#{pane_dead}=1`, `#{pane_dead_status}=<code>`, and the last
  screen lines readable. A signalled client reports `dead=1` with an empty status.
- **A dead pane accepts input and does nothing.** `send-keys` into it succeeds and the screen does
  not change; `respawn-pane` in place revives it and keeps the option.
- **A client that exits from the alternate screen leaves nothing.** A full-screen client that
  switches back before exiting wipes the primary screen, so the tail can legitimately be empty.
- **No client was available to capture fresh output.** `claude --version` reports 2.1.318 but the
  installed entry is a Windows `.exe`; `codex` needs a node this shell does not have. So the
  fixtures are the error strings this repository already carries evidence for, each naming its
  source, rather than invented provider output.

## Decisions

1. **One pure classifier, and it decides three things.** `domain/attempt-failure.ts` maps evidence
   to `{ reasonCode, resumeSafe, retryEligible, ownerAction }`. The eligible and resume-unsafe sets
   are single exported lists; `classificationFor` is the only place the three are derived, and
   every consumer reads its answer. Classification adds no attempt and no budget.
2. **The launcher holds the pane, because otherwise there is nothing to read.** The direct launch
   sets the seat pane's `remain-on-exit` before the client starts (under the same delivery guard
   and lease as every other terminal write), and the sweep releases a held pane once it has read
   the evidence, so the next client starts in a live shell. This is what makes structured exit
   evidence reachable without wrapping the native client.
3. **Structured evidence first, text only as a fallback.** The sweep reads `pane_dead_status` once,
   at the moment it records the stop. A canceled run is `canceled` whatever the exit said. An
   exit status of 0 is a finished turn, so its output is not read for a failure. Only a non-zero
   exit, a signal, or no exit record sends a bounded tail (40 lines, visible screen) to the
   fingerprints.
4. **Fingerprints are conservative in two ways.** A line must begin like a terminal error for the
   patterns an agent might quote in an answer; a pattern that is itself a complete message a
   program prints needs no anchor. A fenced block is quoted content, the rule the Codex banner
   detector already applies. The newest matching line wins, so an error the agent already worked
   past does not decide the outcome.
5. **No evidence is not "unknown".** A clean exit, or a pane this daemon cannot read, records no
   code. `agent_error.unknown` is reserved for a failure the daemon positively observed (a
   non-zero exit) and could not name. Either way the owner retry refuses: an attempt with no
   classification is refused by name, and an unknown code is outside the eligible set. This is
   KTD20's "when uncertain, choose not retried".
6. **The classification is stored on the attempt, in one nullable column.** `team_attempts` gains
   `failure_json` (migration `110_attempt_failure`), written by the existing `attempt.observed`
   command the sweep already uses, so there is no new control command, no new event type and no
   second table. `recordUsage` accepts it only on a stopped attempt and only in the shape its own
   code implies.
7. **A stored classification is re-derived when it is read.** `parseAttemptClassification`
   recomputes `resumeSafe` and `retryEligible` from the code and refuses a row that disagrees, so
   durable state cannot grant a retry KTD20 does not allow.
8. **The retry reads the decision; it never re-derives it.** `ownerCommand("retry")` refuses an
   ineligible code with the classifier's owner action in the reason, refuses an attempt with no
   classification, and otherwise spends `maxRetries` exactly once, as before.
9. **`resume_safe: false` clears the seat's native token before the launch.** The dispatch that
   starts a reopened task asks the stored decision and, when it is unsafe, clears the saved
   resume token first: the client starts a fresh session in the same candidate tree, and every
   file the failed attempt wrote stays. The tree is not touched.
10. **The owner reads one record through three surfaces.** The owner read publishes each attempt's
    `failure`; the Tasks screen renders its code, owner action and retry decision; the health
    projection publishes `reasonCode` and `resumeSafe` from the same row, in both isolation
    modes. None of them infers a code.
11. **`start_timeout` is in the vocabulary and not yet produced.** `team_attempts` records no
    attempt phase, so there is no readiness state to time out against; adding one would be a new
    contract this slice does not need. The code, its owner action and its table row are in place
    for the slice that records phases.

## Residuals

- **A client that exits from the alternate screen leaves no tail.** The exit status still
  classifies it, but a non-zero exit with no readable output is `agent_error.unknown`, which is
  not retried. Recording the client's own stderr would need a wrapper around the native client,
  which the MVP's direct launch deliberately does not have.
- **Only the direct launch holds its pane.** A hardened launch is parked (T038), and its launcher
  is unchanged, so an attempt under it records no exit evidence and therefore no code. The
  conservative answer holds: nothing is retried on a guess.
- **The health projection lists the newest 100 attempts**, not a per-run selection, because the
  unisolated health reader has no run scope. The Tasks screen and the retry read the run's own
  attempts through the governance owner, so they are exact.
- **`process_failure` and `unparseable_output` have no fingerprint.** Nothing in this repository
  carries evidence for what either looks like in a client's output, so an attempt with either
  cause classifies as `agent_error.unknown` until a captured fixture exists. Both are
  non-retryable, so the owner's behaviour is the same.
