# Turn telemetry and analytics semantics

The turn wrapper records observations beside each attempt's existing final-message and thread files. Completion stores those observations before releasing the pane or seat. A telemetry capture failure leaves the attempt eligible for the next sweep; missing or malformed sidecars instead produce unavailable or partial evidence and do not prevent completion. The existing running-usage contract is unchanged.

## Per-attempt usage

- Recorded initial and resumed invocations establish that Claude's result.usage is invocation-local. Its cumulative modelUsage and intermediate assistant snapshots are not summed.
- Codex's turn.completed.usage is cumulative for the native thread. A fresh invocation uses its reported total; a resumed invocation subtracts the preceding recorded total for that same native thread.
- An uncaptured or unusable predecessor is not a zero baseline. Its successor keeps usage unavailable while retaining its own cumulative total, allowing the next observed invocation to recover accurate deltas.
- Unsupported or missing counters remain null. Available input and output counters make usage available; incomplete reported counters are partial. Reasoning output is already included in output and is never added a second time.
- Native session identifiers and cumulative baselines stay in the store. The activity response exposes only the attempt's normalized usage.

## Activity and lifecycle

`GET /api/team-control/runs/:runId/attempts/:attemptId/activity?after=<sequence>` is owner-only. The route resolves the recorded attempt and its run before reading any sidecar. The cursor is one nonnegative safe integer. The activity response includes usage, records, nextSeq, source, timestamps and evidence status.

Tool records contain a local call id, sequence, timestamp, tool, redacted input summary and status. Tool output, assistant text and reasoning text are excluded. Redaction precedes truncation. The store validates external sidecars again and settles any remaining open calls as aborted when the wrapper did not finalize. It preserves partial evidence instead of leaving a running call after a stop.

The first observed stop time is immutable. Duration is the nonnegative interval between the recorded attempt's creation and that observation. Task outcomes are captured at completion, before retry, rework or later task state can overwrite their meaning. A stopped process without a recorded task outcome remains unknown; a successful review attempt means it produced a valid review, not that its reviewed candidate was approved.

## Analytics

`GET /api/team-control/analytics?team=<teamId>&days=<1..365>` is owner-only. The default window is 30 UTC calendar days, including today through the request time.

- The population is captured attempts whose observed stop falls in the window, optionally filtered to one team. Historical rows predating telemetry are not invented or backfilled.
- Tokens by day, model and seat sum reported counters. Unavailable counters and empty token populations stay null; partial and measured attempt counts identify coverage.
- Active time sums attempt durations and can exceed elapsed wall time when attempts overlap. Median duration uses all captured stopped attempts.
- Success rate is successful recorded task outcomes divided by successful plus failed outcomes. Unknown and canceled outcomes are excluded from this denominator.
- Retry rate is attempts with an explicitly counted retry divided by all captured attempts. Automatic retry metadata and accepted owner-retry events supply the numerator; resumed chat turns and review rounds are not inferred to be retries.
- Current task-state counts describe the distinct tasks represented in the population. They never determine historical attempt success.
- Seat names are captured with the attempt and remain readable after seat retirement.
- An empty rate denominator returns null. Monetary fields are absent.

Sidecars are best-effort observations. Missing telemetry modules in a source-only or incomplete package disable sidecars without changing native launch, pane bytes, standard streams, final-message files or terminal status.
