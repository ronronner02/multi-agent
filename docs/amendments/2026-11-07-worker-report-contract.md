# Worker reports and lead resolutions

U11 follows the command-center plan. The owner approved these additive file-contract decisions on 2026-11-07.

## Report destination

Implementers and reviewers may write their one structured task report to the explicitly supplied per-attempt `task-report.json` path outside the candidate. The path is part of that attempt's output area. It is not a source-file permission, an assignment path, or a deliverable.

A reviewer continues to read the implementer's frozen candidate without source-write permission. Both roles keep their existing source permissions.

## Lead resolutions

`lead-proposal.json` accepts an optional `resolutions` array alongside its existing fields. Each entry identifies `taskId` and an `action`:

- `rework`: replace the paused task's brief with `body`.
- `reassign`: send the paused task to `seat`, retaining its approved role and write scope.
- `drop`: close the paused task without a candidate or review verdict.

Resolutions apply only to unresolved paused tasks in the same run. They preserve the approved write scope and existing proposals remain valid. Ordinary new tasks continue to use the existing `tasks` array.

The daemon remains responsible for task admission and completion; the lead gains no merge or approval authority.

## Parsing and retry interpretation

- Reports use `turns/<attemptId>/report/task-report.json` in the mutable attempt area. The dedicated report directory is exposed to the client; the candidate and source permissions stay unchanged.
- `evidence` is a required nonempty string, capped at 16,384 characters. An optional question is nonempty and capped at 500 characters. Extra fields and NUL characters are rejected. Missing means normal completion; unreadable means a blocked report.
- Retry timing lives in the existing task evidence as `retryNotBefore`, committed with its counted queue transition. No second queue or timer is introduced; the completion sweep dispatches due work on its existing cadence.
- Transient waits are 2, 5 and 15 minutes per task, bounded by the run retry budget. Quota waits permit one retry per task. A clock-only reset uses the next occurrence in the client host's local timezone; an unparseable reset uses the 30-minute fallback.
- Historical failure rows remain readable and normalize to the current failure classes. Environment failures preserve their action sentence as the blocked run's owner action. Judgment failures go to the lead without spending a retry.

## Manager recovery boundary

The lead-first failure rule applies to implementers and reviewers. If the lead itself fails and no provider retry remains, the existing blocked-run and owner Resume path stays in place. Existing run budgets and lead wake limits also remain owner-visible when exhausted. These are retained exceptions to KTD18's broad "only environment" wording: U11 does not introduce a new policy for a failed manager to repair itself.

## Launch observation

The completion sweep is serialized across timer, startup and explicit calls. A direct launch reserves its seat and concurrency slot until its existing receipt is registered and its stopped attempt is observed. A dead pane alone is not permission to launch the same task again. The stub-driven report demo reproduced duplicate launches without this rule.
