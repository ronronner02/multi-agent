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
| Cancel run | — | A separate short run was started on the implementer seat and canceled while its agent was mid-turn. |

## The review round that changed the candidate

The requirement is a review round that changed the candidate. The round is **task-3's first
review**, whose verdict is `review.verdict = changes-required` at **seq 73** and whose record is
`review-1-task3-findings.json`. It reopened the implementer's task at **seq 74**.

The reviewer's report, verbatim:

> **R1-1 (P1, correctness)** in `src/titleCase.mjs`, `titleCase`. The plan says a word starts
> "after any character that is not a letter or digit", and every other letter must stay "exactly
> as it was". Task B has no ASCII-only exception. […] I ran it: `titleCase("naïve")` gives
> `"NaïVe"` (expected `"Naïve"`), `titleCase("cafés ouverts")` gives `"CaféS Ouverts"`, and
> `titleCase("élan vital")` gives `"éLan Vital"` (expected `"Élan Vital"`). […] Fix:
> `/(?<![\p{L}\p{N}])\p{Ll}/gu`.

The candidate it reviewed was `sha256:fa0de34d…` (`src/titleCase.mjs` using
`/(?<![A-Za-z0-9])[a-z]/g`). The finding is what sent the task back to its implementer, which is
the change the requirement asks for. The rework turn itself did not run in this recording: the
implementer's seat had been left `failed` by an earlier launch, and a `failed` seat has no
managed owner surface to return it to launchable (see Residuals). The review's verdict, its
finding and the reopening are all recorded; the second-round candidate is not.

## Requirements proven

| Requirement | Where it is proven |
|---|---|
| Lead protocol | Seq 6–15 and `lead-proposal-1.json`: the lead ran one turn under its protocol and roster, wrote `lead-proposal.json`, and the daemon read it at the boundary that owns worker-written data. |
| Owner approval gate | Seq 16–25 and `step-reject.txt` / `step-approve.txt`: nothing the lead proposed was admitted until the owner decided the batch, and the rejected batch admitted nothing. |
| Rejected approval | Seq 17 records the owner's rejection **with its reason**. `proposal-2-now.json` shows the revision answering both points of that reason. |
| Review rework | `review-1-task3-findings.json` and seq 73: a cited, reproduced P1 with `done_signal.holds = false`, recorded as `changes-required`, which reopened task-3 at seq 74. |
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

- **The rework turn.** The review reopened task-3, but the implementer's seat was `failed` and
  could not be relaunched through any managed owner surface, so the second-round candidate and
  its approving review do not exist. See Residuals.
- **Codex.** Every seat ran Claude Code. Codex is not runnable in WSL on this host, so nothing
  here proves it.
- **task-3's patch and task-4's patch.** task-3 has no finished outcome (it is reopened), and
  task-4's candidate was empty, so neither has a patch. Only task-2's patch is in the bundle.
- **The task-4 turn's product.** task-4 asked for a helper the plan does not describe. The
  implementer correctly refused and wrote nothing, and the owner recorded it `failed`.

## Defects found and fixed while running this

The run found three defects the stub demos could not reach. Each is fixed with a focused test
that fails without the fix, and each fix is its own commit.

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

## Residuals

- **A `failed` seat has no managed owner surface.** `rig seat clean` and `rig seat launch` are
  legacy surfaces, refused in a managed-mode daemon, and the managed allowlist is
  `/api/team-control` only. When a launch fails after the seat is marked `failed`, the seat stays
  `failed`, the dispatcher will not start it again, and the owner cannot clear it without editing
  the database. This is what stopped task-3's rework. It needs a new owner surface, which is a
  public contract this run did not add.
- **A daemon restart can destroy a held pane.** The restart in this run left the implementer
  seat's pane gone; the next launch failed with `target pane has exited` and marked the seat
  `failed`. The restart requirement itself passed (the running turns survived and were observed
  stopped), but the seat's pane did not.
- **A `lead-wake:cycles` block has no owner surface.** Approving the `limit-increase` escalation
  does not clear it, and `resume` refuses a run that is not `owner-paused`.
- **Redundant helper copy on the owner screens.** Several zh-CN screens repeat a helper sentence
  above and inside the panel (for example the pairing card, and the Reviews empty state's
  "没有可供审查的候选任务" appearing twice). Recorded here, not changed in this run.
- **Codex.** Not run.
