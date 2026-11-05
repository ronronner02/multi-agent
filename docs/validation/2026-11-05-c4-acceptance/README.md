# C4 acceptance run — 2026-11-05

One end-to-end run of a managed team on a demo repository, with real Claude Code agents in every
seat. The run is recorded here in full: the control-event export, the owner read snapshots taken
at each step, the final patch, the reviewer's own findings, the completion evidence the daemon
computed, and zh-CN screenshots of the owner steps.

The demo repository is `text-helpers`, created by `engine/demo/team/scripts/acceptance-seed.ts`:
a fresh `git init` with a `plan.md` whose goal needs two small implementer tasks, each with its
own `node:test` file. The four seats are rows created by
`engine/demo/team/scripts/acceptance-seats.ts`.

The run used `workers.isolation: none`, its own `OPENRIG_HOME`, its own daemon on port 7533 and
its own tmux server under the run's scratch directory. Nothing touched the owner's daemon,
`~/.openrig`, or the owner's checkout.

## What ran

| Role | Seat | Turns |
|---|---|---|
| Lead | `lead@acceptance` | 2 (first proposal, then a revision after the owner's rejection) |
| Implementer A | `one@acceptance` | 2 (task-2, then task-4) |
| Implementer B | `two@acceptance` | 1 (task-3) |
| Reviewer | `review@acceptance` | 2 (task-2's candidate, then task-3's candidate) |

Every attempt is one headless `claude -p` turn: the agent reads its prompt, works, and exits by
itself. Nothing was typed into any agent's pane. The only inputs were the owner surfaces
`rig team start`, `rig team done`, `rig team proposal --decide`, `rig team apply` and
`rig team cancel`, plus the two owner API surfaces the Web UI itself uses (the task edit and
the growth approval).

## Timeline

Seq numbers are `events.seq` from `main-run/control-events.json`.

| Step | Seq | What happened |
|---|---|---|
| Run started | 1–5 | The owner started the run with a lead and a reviewer. Task-1 was admitted on the lead seat and dispatched. |
| Lead turn | 6–9 | The lead's turn launched, the receipt was recorded, the attempt was admitted, the seat came up. |
| Lead proposal read | — | The lead wrote `lead-proposal.json`; the owner read it with `rig team proposal`. It proposed task-2 (slugify) and task-3 (titleCase). |
| Lead task done | 10–15 | `rig team done task-1` recorded the lead's deliverable. |
| **Rejected approval** | 16–17 | `rig team proposal --decide rejected --reason "…"` recorded the owner's decision and its reason at seq 17. |
| Lead revision | 18–21 | The rejection reopened the lead task; its next attempt resumed the conversation with the reason in the prompt and wrote a revised proposal. |
| **Approved** | 22–25 | The owner approved the revised batch; task-2 and task-3 were admitted and dispatched. |
| Implementers | 26–43 | Both implementers ran real turns concurrently. |
| **Daemon restart mid-turn** | — | The daemon was stopped and restarted while both implementer turns were running. The turns kept running with no daemon; after the restart the run was `approved`, all three tasks were present with no duplicate, and both attempts were still recorded `running`. |
| Implementers done | 44–47 | Both turns ended; the sweep observed both attempts `stopped`. |
| task-2 recorded | 48–49 | `rig team done task-2` created `task-2-review-1`. |
| task-3 recorded | 54–56 | `rig team done task-3` created `task-3-review-1`. |
| Review 1 (task-2) | 64–68 | The reviewer's turn reviewed task-2's candidate and approved it: `review.verdict = approved` at seq 67, no P0/P1, one P2 and one P3, both testing-only. Recorded at seq 68. |
| **Review 2 (task-3): changes required** | 70–75 | The reviewer's turn reviewed task-3's candidate and returned **CHANGES-REQUIRED**: `review.verdict = changes-required` at seq 73 with a cited, reproduced P1, recorded at seq 75. See below. |
| Rework | 74 | The verdict reopened task-3 for rework (`queue.updated` done→pending). |
| **Rework turn** | 122–130 | After a restart, the dispatcher recovered the wedged implementer seat and launched the rework attempt `fd4b9dcb`. Its prompt carried the reviewer's R1-1 verbatim. The agent reported **NEEDS-DECISION** and changed nothing (see below). |
| **Review limit reached** | 131–132 | Recording the round-2 candidate was refused with `review limit exhausted`: the run had spent its `maxReviewRounds: 2` (task-2 approved, task-3 changes-required), so the loop stopped at its designed limit and the run went `blocked`. |
| Cancel run | — | A separate short run was started on the implementer seat and canceled while its agent was mid-turn. |

## The review round that sent the candidate back

The round is **task-3's first review**, whose verdict is `review.verdict = changes-required` at
**seq 73** and whose record is `review-1-task3-findings.json`. It reopened the implementer's task
at **seq 74**, and the rework turn it started resumes the implementer's conversation with that
finding in its prompt.

The reviewer's report, verbatim:

> **R1-1 (P1, correctness)** in `src/titleCase.mjs`, `titleCase`. The plan says a word starts
> "after any character that is not a letter or digit", and every other letter must stay "exactly
> as it was". Task B has no ASCII-only exception. […] I ran it: `titleCase("naïve")` gives
> `"NaïVe"` (expected `"Naïve"`), `titleCase("cafés ouverts")` gives `"CaféS Ouverts"`, and
> `titleCase("élan vital")` gives `"éLan Vital"` (expected `"Élan Vital"`). […] Fix:
> `/(?<![\p{L}\p{N}])\p{Ll}/gu`.

The candidate it reviewed was `sha256:fa0de34d…` (`src/titleCase.mjs` using
`/(?<![A-Za-z0-9])[a-z]/g`). The finding sent the task back to its implementer.

## The rework round, and why it changed nothing

The rework turn did run this time. The dispatcher recovered the implementer's wedged seat and
launched attempt `fd4b9dcb` with the reviewer's R1-1 verbatim in its prompt. The agent answered
**NEEDS-DECISION** and changed nothing; its full report is `main-run/rework-report.txt`. Its
reasoning, in its own words:

> The brief requires ASCII-only letters, with "every non-ASCII character, including accented
> letters, acts as a word boundary, and non-ASCII characters are never changed." Under that rule,
> `'naïve'` → `'NaïVe'` … The current code produces exactly these. … R1-1 asks for the Unicode
> reading … That regex would uppercase `é`, which breaks the brief's "never changed" rule. … All
> four acceptance lines pass under either rule, so the tests can't decide between them.

That is a real conflict between the task body the owner approved (ASCII-only, from the owner's own
rejection reason at seq 17) and the reviewer's plan reading. It is not a defect in either agent,
and resolving it is an owner decision the run did not make. The round-2 candidate is therefore
byte-identical to round 1 — `main-run/task-3-round-2.diff` is empty by construction, and both
rounds record the same manifest digest `sha256:fa0de34d…`.

Recording that candidate was then refused with `review limit exhausted` (seq 131–132): the run had
spent its `maxReviewRounds: 2` on task-2's approval and task-3's change request. The loop stopped
at its designed limit and the run went `blocked`.

## Requirements proven

| Requirement | Where it is proven |
|---|---|
| Lead protocol | Seq 6–15 and `lead-proposal-1.json`: the lead ran one turn under its protocol and roster, wrote `lead-proposal.json`, and the daemon read it at the boundary that owns worker-written data. |
| Owner approval gate | Seq 16–25 and `step-reject.txt` / `step-approve.txt`: nothing the lead proposed was admitted until the owner decided the batch, and the rejected batch admitted nothing. |
| Rejected approval | Seq 17 records the owner's rejection **with its reason**. `proposal-2-now.json` shows the revision answering both points of that reason. |
| Review rework | `review-1-task3-findings.json` and seq 73: a cited, reproduced P1 with `done_signal.holds = false`, recorded as `changes-required`, which reopened task-3 at seq 74. |
| Rework turn ran | Seq 122–130 and `rework-report.txt`: after a restart the dispatcher recovered the wedged seat, launched attempt `fd4b9dcb` with the P1 in its prompt, and the turn ended with the agent's own NEEDS-DECISION report. |
| Review loop limit | Seq 131–132: the round-2 candidate could not be recorded because the run had spent `maxReviewRounds`, so the loop stopped at its designed limit. |
| Restart | The daemon was restarted while two turns were running. After it: three tasks, no duplicate, both attempts still `running`, then both observed `stopped`. |
| Cancellation | `cancel-run/`: the run was canceled while its agent was mid-turn. The receipt names the process it stopped, the attempt is `stopped`, the task and the run are `canceled`, and the candidate tree is still on disk. |
| Applied result | `step-apply.txt` and `step-apply-tests.txt`: `rig team apply` applied task-2's patch to a scratch clone and its `npm test` passed 5 of 5. |

## The rejection reason and the revision

The owner's rejection, recorded verbatim at seq 17:

> Two changes before I approve. (1) task-3 must not leave the non-ASCII question to the
> implementer: state in the task body that only ASCII letters count as letters for titleCase, the
> same rule Task A uses. (2) Each task body must require the repository's full 'npm test' to
> pass, not only the implementer's own test file, and must say to report that output.

The lead's revision (`proposal-2-now.json`) answers both: task-3's body states "Only ASCII
letters (A-Z, a-z) count as letters for titleCase, the same rule Task A uses for slugify", and
both bodies now require the repository's full `npm test` and its complete output.

## Usage

The daemon recorded no token or cost figures for these attempts: a headless turn's usage is not
read back from the client, so `usage` stays "not observed" rather than being estimated. The
bundle therefore contains no token counts.

## What was not proven

- **A review round that changed the candidate.** The round-1 review sent task-3 back with a cited,
  reproduced P1 (seq 73), and the rework turn ran with that finding in its prompt. The rework
  agent then reported **NEEDS-DECISION** and changed nothing, because the reviewer's Unicode
  reading conflicts with the ASCII-only task body the owner approved. The round-2 candidate is
  byte-identical to round 1 (`task-3-round-2.diff` is empty), and recording it was refused with
  `review limit exhausted`. So the requirement — a review round whose outcome changed the
  candidate — is **not met** by this run. What the run does prove is the loop up to that point:
  the finding, the reopen, the rework dispatch and the limit.
- **An owner decision on the ASCII-versus-Unicode conflict.** Resolving it needs the lead to
  reissue task-3's body or the owner to rule R1-1 not a defect; this run did neither.
- **Codex.** Every seat ran Claude Code. Codex is not runnable in WSL on this host, so nothing
  here proves it.
- **task-3's patch and task-4's patch.** task-3 has no accepted outcome, and task-4's candidate was
  empty, so neither has a patch. Only task-2's patch is in the bundle.
- **The task-4 turn's product.** task-4 asked for a helper the plan does not describe. The
  implementer correctly refused and wrote nothing, and the owner recorded it `failed`.
- **`rig team apply` after the later restarts.** The daemon's candidate registry is in memory, and
  it keeps no provenance record to adopt from after a restart, so the result route refused
  task-2's candidate once the run had been restarted. The bundle's `task-2.patch` is the patch the
  owner read while the candidate was live, and applying it to a fresh clone passes 5 of 5
  (`step-apply-tests.txt`).

## Defects found and fixed while running this

The run found four defects the stub demos could not reach. Each is fixed with a focused test that
fails without the fix, and each fix is its own commit.

1. **A lead revision could not launch.** Re-staging the lead's candidate read its own
   `lead-proposal.json` as an out-of-scope write, so every revision failed with
   `plan-change-required: outside-write-paths`. The lead's proposal is its deliverable, and the
   completion path already exempts it; the scope stage now exempts that one path for the lead
   role only.
2. **A reopen was served once per freed slot.** After a revision attempt ended, the freed-slot
   dispatch re-selected the same task, because the reopen was still the queue row's last
   transition. Each extra launch spent the run's lead-wake budget until the run was blocked with
   `lead-wake:cycles`. A reopen now starts one attempt.
3. **A seat holding two live tasks could not launch or admit.** Two completed implementers are
   two pending reviews on the same reviewer seat; the launch refused the seat as ambiguous and
   the sweep recorded no attempt for the turn that ran. The launch now names the task it starts,
   stamps its pane, and the sweep reads that stamp.
4. **A wedged seat was never restarted, and a restart dispatched nothing.** A seat whose last
   launch failed — or one that still said `ready` while its pane was dead — could not be started
   again by anything: the dispatcher starts only a `pending` seat and the legacy seat verbs are
   refused in a managed daemon. The dispatch now recovers such a seat once, in the dispatch
   itself, and the completion owner asks the scheduler for a run's pending work when the daemon
   starts, because a restart is a freed slot too.

## Residuals

- **A wedged seat is now recovered, but only by the dispatcher.** `rig seat clean` and
  `rig seat launch` are still legacy surfaces a managed daemon refuses, and the managed allowlist
  is `/api/team-control` only. The dispatcher recovers such a seat on its own (fix 4), so the
  owner has no way to ask for it directly and no way to see that it happened other than the
  daemon's log line. A first-class owner surface is still missing.
- **The candidate registry does not survive a restart.** The runtime keeps its candidate records
  in memory and writes no provenance record, so after a restart `rig team apply` and
  `rig team diff` refuse a task whose candidate is on disk. The trees are intact; the daemon
  cannot adopt them. This is why the apply step here is proven from the patch the owner read
  while the candidate was live.
- **A daemon restart can leave a held pane dead.** The run's restart left one implementer's pane
  held and dead (`remain-on-exit` did its job), and the next launch pasted into it and failed with
  `target pane has exited`. The restart requirement itself passed — the running turns survived and
  were observed stopped — and the dispatcher now respawns such a pane (fix 4), but the pane is not
  carried across a restart by the launch path itself.
- **A `lead-wake:cycles` block has no owner surface.** Approving the `limit-increase` escalation
  does not clear it, and `resume` refuses a run that is not `owner-paused`.
- **The review-round limit is spent after two rounds for a whole run**, not per task. Two
  implementer tasks therefore leave one change request before the loop stops, and the second
  task's rework can never be re-reviewed. Whether the limit should be per task is a plan
  question this run did not decide.
- **The ASCII-versus-Unicode conflict in Task B is unresolved.** The plan and the task body say
  ASCII-only; the reviewer read the plan as requiring Unicode letters. The run recorded the
  disagreement rather than choosing.
- **Redundant helper copy on the owner screens.** Several zh-CN screens repeat a helper sentence
  above and inside the panel (for example the pairing card, and the Reviews empty state's
  "没有可供审查的候选任务" appearing twice). Recorded here, not changed in this run.
- **Codex.** Not run.
