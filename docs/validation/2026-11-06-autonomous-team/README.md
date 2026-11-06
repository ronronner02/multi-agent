# Autonomous team acceptance — 2026-11-06

Attempt 2 delivered two independently reviewed helper tasks to the demo repository's
`main`, where `npm test` passed **19/19**. The owner discussed the plan, approved it and
merged the integration branch. A lead turn survived the planned daemon restart with
no duplicate task or attempt row.

The recorded run was not a clean acceptance pass: its final lead turn failed evidence
validation and left its task pending, while the branch view still offered Merge.
That defect is now fixed by [PR #138](https://github.com/ronronner02/multi-agent/pull/138)
(`abb344f`). The recorded full daemon suite has seven failures beyond the two
environment exceptions in the brief; six were test drift, fixed by PR #139
(`0326993`), and one is the known determinism flake. The original evidence and subsequent fixes are
recorded below; the finished live run was not repeated for this wrap-up.

## What ran

The team was created through the Web UI for the fresh `smalltools` repository, with
an existing `clamp` helper and four baseline tests. It used `workers.isolation: none`,
an isolated `OPENRIG_HOME`, a daemon on port 7833 and its own tmux server. The
[original progress notes](live-run-progress.txt) record setup and the run; the
[team export](teams.json) and [owner read](owner-read.json) record the seats and turns.

Run: `60218d24-2f0e-4168-ada5-ce6a2c9a2840`.

| Role | Seat | Client | Recorded turns |
| --- | --- | --- | --- |
| Lead | `lead-1@smalltools` | Claude Code | 9: two planning turns, three task-list turns, two completion/follow-up turns, and two replies to later owner messages |
| Implementer A | `impl-1@smalltools` | Claude Code | 1, for task-2 (`chunk`) |
| Implementer B | `impl-2@smalltools` | Codex | 1, for task-3 (`formatBytes`) |
| Reviewer | `review-1@smalltools` | Claude Code | 2, one review of each implementer candidate |

These are the 13 distinct `read.attempts` rows, all `stopped` in the final snapshot.
The run contains five task rows: the lead, two implementers and two automatic reviews.
Token and cost fields are unavailable in the owner read; no usage figures are inferred.

## Attempt 1

The first run, `2f82bb8e-37fa-4114-921b-a615e8871148`, used the earlier `toolbox` demo.
It stalled after the lead revised its list to give a read-only review task
`paths: []`. The parser refused that list, but the refusal was swallowed as an
unreadable proposal and recorded as `evidence_invalid`. Nothing retried it. Merge
was offered even though no implementation task had been admitted and zero commits
had landed. These defects were fixed by
[PR #136](https://github.com/ronronner02/multi-agent/pull/136).

The archived evidence makes the stall inspectable:

- [Revised lead proposal](attempt-1/lead-proposal.json): task-4 has an empty path list.
- [Archived control events](attempt-1/control-events.json): seq 35/37 record the first
  overlap refusal; seq 43 records the revision turn; seq 45/46 observe its end and
  classification; seq 48 records its outcome. There is no later retry event.
- [Archived state](attempt-1/archived-state.json): the only task is the failed lead;
  its evidence says `The lead's proposal is missing or unreadable`, its final attempt
  has `evidence_invalid` with `retryEligible: true`, `retries_used` is 0, and the
  integration commit list is empty.
- [Archived chat](attempt-1/chat.json) and the
  [attempt-1 planning screenshot](screenshots/02-chat-with-plan.png) show the lead's
  questions and its revision. The chat also records a demo-fixture mistake: the old
  `npm test` script used `node --test src`, which failed on Node 24. The owner told the
  lead to use `node --test` without widening that run's scope. Attempt 2 used a fresh
  baseline with a working test script.

The saved files do not contain an attempt-1 merge response. The zero-commit readiness
defect is the one recorded and fixed in PR #136; the archived state independently
establishes the failed lead, zero admitted implementation tasks and zero landed work.

Attempt 2 exercised the repaired refusal path too: seq 35/37 rejected overlapping
review paths, seq 48/50 returned the empty-path refusal to the lead, and seq 62/64/65
admitted its corrected two-task list without another owner action.

## Attempt 2 timeline

Seq numbers in this table come from [control-events.json](control-events.json).
They are global event numbers, so the filtered export has gaps between entries; it
contains 95 entries and reports `gap: false`, with `latestSeq: 159`. Times below are
UTC. Team creation, the restart and the merge have no dedicated entry in this export;
their separate evidence is named instead of assigning them an invented seq.

| Step | Time (UTC) | Seq | Evidence and outcome |
| --- | --- | --- | --- |
| Team created in the UI | Before 07:24 | — | [Team export](teams.json) and [01](screenshots/01-team-created.png) show the four seats on `smalltools`. |
| Planning run started | 07:24:05–07:24:06 | 1–5, 11 | Run and lead task created; the first lead attempt is recorded. The initial approval at seq 3 is the start's planning authorization, not the later owner plan approval. |
| Lead asked three questions | 07:24:42 | 13 | The first turn ends. [Chat](chat.json) asks about invalid input, the largest unit and unit selection before rounding. |
| Owner answered; lead updated the plan | 07:27:10–07:27:37 | 14, 20–22 | One chat message accepts `RangeError`, retaining TiB for larger values, and selecting the unit before rounding. The lead confirms the update to `plan.md`. |
| Owner approved the plan | 07:36:54 | 23–24 | `plan.approved` opens delivery; the daemon renews the implementation approval. |
| Lead corrected its task list | 07:36:55–07:38:13 | 30–65 | Two refused lists are returned to the lead. It removes the explicit review task; task-2 and task-3 are admitted at seq 62/64. |
| Both implementers started | 07:38:14 | 74–75 | Claude Code attempt `683c8b10…` takes task-2; Codex attempt `0197f3c7…` takes task-3. |
| Task A completed, reviewed and landed | 07:38:43–07:39:03 | 76, 79, 84–89 | The daemon records the outcome, creates the review, records a round-1 approval with no findings at seq 87, and integrates task-2 at seq 89 as `dea017c`. |
| Task B completed, reviewed and landed | 07:44:27–07:44:49 | 91, 94, 99–105 | The daemon records the outcome and round-1 approval at seq 103, then integrates task-3 at seq 105 as `0d93818`. The review has one P3 testing finding. |
| Lead checked the result | 07:44:49–07:45:57 | 106–131 | The lead is woken after all five tasks had reached done. It reports 19 passing tests on the integration branch. An empty follow-up list is refused at seq 119/121; the next turn deletes the proposal file. |
| Owner requested a final check | 07:55:03–07:55:38 | 133, 139–143 | The owner asks for the four-file scope and branch test result; the lead replies. |
| Owner asked how to use the exports | 08:11:39–08:11:40 | 145, 151 | A third owner chat starts lead attempt `d6e9eba6…`. |
| Daemon restarted mid-turn | 08:11:44–08:11:46 | Between 151 and 153 | [Restart log](restarts.log), [before](before-restart.json) and [after](after-restart.json): the same attempt is running on both sides; both snapshots have five tasks and 13 unique attempts. |
| Lead turn ended after restart | 08:11:59 | 153–154, 157 | The same attempt is observed stopped, then classified, and its outcome is recorded. The final owner read reports `evidence_invalid`; the lead row stays pending. |
| Owner merged in the UI | 08:35:53 | — | The [progress notes](live-run-progress.txt) record the UI action. The [existing main reflog](demo-repo-merge-reflog.txt) records a fast-forward of the integration branch at 16:35:53 +08:00. |
| Demo main verified | After merge | — | [Git log](demo-repo-git-log.txt): `main` and the integration branch are at `0d93818`. [Saved npm test output](demo-repo-npm-test.txt): 19 passed, 0 failed. |

The two `attempt.observed` events at seq 153 and 154 refer to the same attempt; they
are not two new turns. The restart snapshots and the final owner read retain the
same 13 attempt ids. The two integration events correspond to exactly two task
commits.

## Owner action count

**Attempt 2 has five allowed owner workflow actions: three chat messages, one plan
approval and one merge.** No separate escalation answer was needed; all three owner
messages are ordinary `text` messages in [chat.json](chat.json).

| # | Action | Evidence |
| --- | --- | --- |
| 1 | Answer all three planning questions in one message. | Seq 14; chat at 07:27:10.373Z. |
| 2 | Approve the plan in the UI. | Seq 23. |
| 3 | Ask the lead to confirm the two commits' file scope and `npm test`. | Seq 133; chat at 07:55:03.445Z. |
| 4 | Ask how the two helpers are imported and called. | Seq 145; chat at 08:11:39.864Z. |
| 5 | Merge the integration branch in the UI. | Progress notes, main reflog and final git log. |

This five-action count does not hide setup or intervention. The progress notes,
screenshots and restart log also document these **six steps outside the allowed
workflow-action list**:

| Additional step | Finding |
| --- | --- |
| Pair the browser. | Required browser setup. The desktop pairs automatically; the browser currently needs a separately minted code. The operations guide documents that existing route. |
| Create the team in the UI. | Required bootstrap in the acceptance brief; it is an owner action outside the narrow chat/approval/merge list. |
| Submit the multi-line goal that was refused. | Product defect 1. The failed request precedes this run's event export; the progress notes record it. |
| Install the goal fix and restart the daemon at 15:19:23 +08:00. | A manual repair was required before delivery could start. PR #137 removes the need for that repair on a fresh run. |
| Submit New work successfully. | Required run creation, recorded at seq 1–5; planning is selected by the UI for this team. |
| Restart the daemon at 16:11:44 +08:00 while the lead ran. | Deliberate fault injection required by the brief, not a recovery action needed to move a task forward. |

That is **at least 11 documented product/operator steps** for attempt 2, of which
five are the allowed workflow decisions. Demo-fixture preparation and read-only
diagnostic/evidence capture are additional work; the saved record is not a complete
command or click ledger for those activities. A claim that the whole exercise needed
only five owner actions would be unsupported. After plan approval, both implementer
outcomes, both reviews and both task commits were recorded by the daemon.

Attempt 1 has two separately recorded workflow decisions: one owner chat at its
seq 14 and the plan approval at its seq 23. It did not deliver a task or complete a
merge. Its setup and eventual archival are separate from attempt 2's count.

## Delivered result and review

The integration branch is
`team/add-two-independent-helpers-to-src-in-th-60218d24`.

| Task | Commit | Files added | Review |
| --- | --- | --- | --- |
| task-2 | `dea017c85f26b0ad16329fe451b70364ac7a1113` | `src/chunk.mjs`, `src/chunk.test.mjs` | Approved, round 1, no findings (seq 87). |
| task-3 | `0d938189f730a363b99d2178aeca59ee84d7298c` | `src/format-bytes.mjs`, `src/format-bytes.test.mjs` | Approved, round 1, one P3 (seq 103). |

[Task A's commit](commit-task-a.txt) adds 38 lines; [task B's](commit-task-b.txt) adds
58. The approved-plan commit `3c63c6c` precedes both. The 19 demo tests comprise four
baseline clamp tests, six chunk tests and nine formatBytes tests.

The P3 concerns a test name: “at and above 1024 TiB” tests 1025 TiB but omits exactly
1024 TiB. The reviewer ran the exact boundary and found correct behavior. It did not
ask for rework. Both reviews approved in their first round; this run does not prove a
candidate-changing rework round, and none was forced.

## Defects found

### Defect 1: a multi-line goal was refused — fixed

The UI's goal textarea could submit line breaks, but `POST /runs` used the identifier
validator `text()`, which rejected C0 control characters, including newlines. The
request returned `invalid_team_contract`. The run resumed only after the goal path
used the prose validator. The [progress notes](live-run-progress.txt) record the
failed request and local fix `4c27c01` on `fix/team-goal-prose`; it is now fixed by
[PR #137](https://github.com/ronronner02/multi-agent/pull/137), `1034f46`.

The failed request has no seq in this run's export because it preceded run creation.
This wrap-up reports the prior fix and does not claim a new failing-before run for it.

### Defect 2: lead evidence after task landing — fixed by PR #138

In the recorded run, after the task commits landed, a later lead turn was checked
against the integration head while its candidate still contained the earlier plan
tree. That diff treated the four landed helper files as deletions by the lead and
rejected them as outside the lead's proposal scope. The task remained `pending`,
while integration readiness reported `tasksDone: true` and `merge.possible: true`.

The durable evidence is:

- Seq 89 and 105 land the two task commits. Seq 151 records the final lead attempt,
  `d6e9eba6-1f64-484c-a9e6-4c7befbe0f98`; seq 153/154 observe its stop and classification,
  and seq 157 records its outcome.
- [owner-read.json](owner-read.json) has that attempt's `failure.reasonCode` set to
  `evidence_invalid`, with `resumeSafe: true` and `retryEligible: true`. Task-1 is
  `pending`; the four implementation/review rows are `done`; `retriesUsed` is 1.
- [lead-evidence.json](lead-evidence.json) preserves a read-only check of the existing
  tree and database. The lead HEAD is `047f21e`; the integration HEAD is `0d93818`.
  Diffing the lead tree against `0d93818` reports deletion of all four new files;
  diffing it against the approved-plan commit `3c63c6c` reports no changes. Stored
  evidence names `0d93818` as its base and says `4 changed path(s) are not the lead's
  proposal`. Queue seq 155/156 show failed → pending; the subsequent launch fails
  at seq 159 with `plan-change-required: other-task-scope`. Those raw queue/startup
  events are supplemental evidence, not entries in the filtered control export.
- [integration.json](integration.json) still offers Merge. The branch screenshot
  [05](screenshots/05-merged.png) shows the offer even with the lead unfinished.

The progress note described every later lead turn as failing. The retained rows only
classify the final attempt as `evidence_invalid`: earlier attempts `9f953c63…`,
`8e916ff4…` and `653d3e8c…` have `failure: null`, and their queue transitions include
`done`. This bundle does not turn that broader note into an unsupported per-turn claim.
The final attempt's `resumeSafe: true` also shows that the failure did not require a
fresh native session.

The defect is fixed by [PR #138](https://github.com/ronronner02/multi-agent/pull/138)
(`abb344f`), from `fix/lead-evidence-after-landing`.
The fix refreshes each delivery lead turn's tree to the integration head and preserves
its starting base across a restart, keeps the lead's native conversation when its
workspace path is unchanged, and refuses merge while the lead task is pending, in
progress or blocked.
The [implementation decision](../../amendments/2026-11-06-lead-management-turn-base.md)
records that behavior. This documentation branch includes the fix through its rebase
onto `abb344f`; the evidence above remains the record of the earlier live run.

## Full daemon suite

The suite ran **once**, in a standalone clone of `1034f46`, with its own
`npm ci --no-audit --no-fund` and a fresh
`npm run build -w packages/daemon -w packages/cli`. Linux Node `v24.21.0` and npm
`11.19.0` were selected by a clean PATH beginning with
`/opt/multi-agent/toolchain/node/bin`. It used `setsid -w`, stdin from `/dev/null`,
`TMUX` and `TMUX_PANE` unset, two workers and an exit-code `.done` marker, following
[operations](../../operations.md#full-daemon-suite).

Command, from the clone's `engine/packages/daemon`:

```bash
npx vitest run --maxWorkers=2 --testTimeout=60000 --reporter=default --reporter=json --outputFile=<verification>/full-daemon.json
```

| Measure | Result |
| --- | --- |
| Files | 1,016 passed, 5 failed, 2 skipped — 1,023 total |
| Tests | 16,719 passed, 9 failed, 5 skipped, 5 todo — 16,738 total |
| Duration | 654.48 seconds |
| Exit code | 1 |
| Beyond the brief's two environment exceptions | 7 failures in 3 files |

[Machine-readable result](full-daemon-suite.json) and
[assertion output](full-daemon-suite.txt) preserve the command, counts and all nine
failed test names. File counts above come from the console summary; the raw JSON
reporter's file status labels include entirely skipped files among passed files.

| File | Failed | Cause and classification |
| --- | --- | --- |
| `auth-bearer-token.test.ts` | 1 | HG-4 expected an intentionally unresolvable hostname to return null, but the resolver returned `198.18.0.64`. This matches the documented synthetic-DNS environment failure and the brief's exception. |
| `seat-fresh-launch.test.ts` | 1 | The late-consent case expected its callback spy once and observed two calls at line 214. This is the brief's known environment exception; this wrap-up does not infer a more specific cause from that assertion. |
| `startup.test.ts` | 2 | Both tests pin PATH to `/proof/openrig/bin:/usr/bin:/bin`. `startup.ts:1123–1127` now appends the client binary directory, so the exact PATH assertions at lines 427 and 455 fail. The second test's title mentions HOME/CODEX_HOME, but its received diff is also the PATH addition. These are additional failures. |
| `s03-bound-launch.test.ts` | 4 | The four username cases extract only the `launchSessionEnv` object from startup source and evaluate it in a VM at line 83. That object now refers to `launchPath`, whose initializer is outside the extracted object and absent from the VM bindings. All four throw `ReferenceError: launchPath is not defined`. These are additional failures. |
| `stub-runner-determinism.test.ts` | 1 | The two activity arrays contain a different event order at line 120: one has `SessionStart → UserPromptSubmit → Stop`, the other `SessionStart → Stop → UserPromptSubmit`. This matches the pre-existing ordering flake in `docs/known-failures.md`, but it still counts here because the brief exempts only the two environment cases above. |

The six non-environment failures in `startup.test.ts` (2) and
`s03-bound-launch.test.ts` (4) are test drift from U1's PATH re-apply. PR #139
(`0326993`) fixed them in the tests; production code was already correct.
`stub-runner-determinism.test.ts` is a known flake. These follow-ups do not change the
recorded result: no test or production code was changed for this documentation
wrap-up. After PR #139, the only full-suite failures left are the two environment
exceptions and the known determinism flake.

## Wrap-up verification

The initial wrap-up rebased the worktree onto `origin/main` at `1034f46` after
stashing the untracked bundle, then restored the bundle. `npm ci --no-audit --no-fund`
and the initial `npm run build` completed in `engine/` with Linux Node first on PATH.

The checks on that base passed; [command output](wrap-up-checks.txt) preserves their
results.

| Check | Result |
| --- | --- |
| `npm run build` in `engine/` | Passed for all four workspaces, including the UI typecheck and Vite build. |
| `npx vitest run test/migration-fixture-parity.test.ts test/p34-call-site-allowlist.test.ts --maxWorkers=2` in `engine/packages/daemon/` | 16/16 tests passed in two files. |
| `npm run smoke` in `engine/` | 721/721 tests passed in 40 files: daemon 605, CLI 41, i18n 45, UI 30. |
| CLI documentation check against `engine/packages/cli/src` | All 10 command paths and 11 flags checked are present; the browser-pairing example passes syntax checking. |
| Local Markdown links | Every local link and heading anchor in the four updated documents resolves. |

The follow-up rebased this documentation branch onto `origin/main` at `abb344f`.
`npm ci --no-audit --no-fund` and `npm run build` passed again, the two guard files
passed **16/16**, and `npm run smoke` passed **721/721** across 40 files (daemon 605,
CLI 41, i18n 45, UI 30), with Linux Node first on PATH and detached test stdin.
[Follow-up command output](rebase-checks.txt) preserves those results.
The full daemon suite was not repeated; its recorded result above is still the run
on `1034f46`.

This unit changes evidence and documentation only; it introduces no product fix or
new regression test, so a failing-before run is not applicable. The stored demo test
run remains 19/19; it was not repeated during wrap-up.

## Screenshots and evidence

All six preserved screenshots are zh-CN at **1440 × 900**. Their visible contents,
not just their filenames, determine what they prove.

| Screenshot | What is visible |
| --- | --- |
| [01 — team created](screenshots/01-team-created.png) | `smalltools` and all four client/role seats. |
| [02 — plan chat](screenshots/02-plan-chat.png) | Attempt 2's draft plan and questions. The full conversation and owner answer are in the transcript. |
| [03 — mid-delivery capture](screenshots/03-mid-delivery.png) | By capture time both implementer tasks and both reviews are done; the lead is pending. It does not show two running implementers. |
| [04 — after restart](screenshots/04-after-restart.png) | The same completed work and pending lead. The before/after JSON snapshots prove the running turn survived. |
| [05 — merge view](screenshots/05-merged.png) | Both task commits and an enabled Merge button. It is not a success receipt; the main reflog and git log prove the merge. |
| [Earlier 02 — attempt-1 chat](screenshots/02-chat-with-plan.png) | The `toolbox` run's planning discussion and broken baseline test script. |

The [chat transcript](chat-transcript.txt), [chat JSON](chat.json),
[control events](control-events.json), [owner read](owner-read.json),
[integration read](integration.json), [team export](teams.json),
[restart log](restarts.log), [before-restart read](before-restart.json) and
[after-restart read](after-restart.json) retain the live-run record. The
[commit summaries](commit-task-a.txt), [second commit summary](commit-task-b.txt),
[demo history](demo-repo-git-log.txt), [merge reflog](demo-repo-merge-reflog.txt) and
[demo test output](demo-repo-npm-test.txt) retain the delivered result.

[daemon.log](daemon.log) was checked before inclusion: it contains startup,
shutdown, seat-recovery and refusal messages, with no bearer token, owner token,
API key or private key found. Neither archived owner credential appears in it.
No live daemon state was changed during this wrap-up.
