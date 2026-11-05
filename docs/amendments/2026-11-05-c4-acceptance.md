# C4 acceptance: one recorded end-to-end run

Date: 2026-11-05

Scope: decision 3 bullet C4 and decision 5 of `docs/amendments/2026-11-02-mvp-multi-agent-scope.md`.
C4 replaces T024-T030 with one recorded end-to-end run on a demo repository, including the
failure cases a real run reaches: a rejected approval, a review rework, a cancellation and a
restart, with **at least one review round that changed the candidate**.

This record states the three decisions the owner made for the run, and then what the run
itself established.

## Decisions

### 1. Real agents

The run uses real Claude Code sessions, not the compiled stub runner. Every lead, implementer
and reviewer attempt is a real `claude -p` turn that spends real tokens through the owner's
relay, so the demo task stays small: two helpers, one test file each.

### 2. Claude Code only

Lead, implementer and reviewer seats all run Claude Code. Codex is not runnable in WSL on this
host, so it is recorded as a residual rather than proven. That replaces the amendment's "both
installed clients" for this acceptance.

### 3. "Recorded" means an evidence bundle

The run is recorded as a bundle committed under `docs/validation/2026-11-05-c4-acceptance/`:

- the run's control-event export, pretty-printed;
- the owner read snapshots at each step;
- the final patch;
- the reviewer's findings, as the reviewer wrote them;
- the completion evidence the daemon computed for each task;
- a `README.md` report;
- Web UI screenshots in zh-CN of each owner step.

No video is recorded.

## What the run established

The run and its evidence are described in the bundle's `README.md`. Three defects the stub demos
could not reach were found and fixed while running it:

- a lead's own `lead-proposal.json` was read as an out-of-scope write when the lead's revision
  attempt re-staged its candidate, so every lead revision failed to launch;
- the freed-slot dispatch re-selected a reopened task after its revision attempt had ended,
  spending the run's lead-wake budget until the run was blocked with `lead-wake:cycles`;
- a seat holding two live tasks (two completed implementers are two pending reviews on the same
  reviewer seat) made the launch composition and the completion sweep refuse to name either,
  so a real review turn ran with no attempt behind it.

Each fix carries a focused test that fails without it, and the revert-check is recorded in the
PR that delivers this slice.

## Closing decision

**Decided by:** the owner, 2026-11-05.

C4 is closed without one of its proofs: a live review round that changed the candidate
(decision 5 of the 2026-11-02 amendment). Three live attempts did not produce one:

- In the main run, the review of task-3 returned `changes-required` with a reproduced P1, and
  the rework turn ran with that finding in its prompt. The agent then reported NEEDS-DECISION
  and changed nothing. The finding conflicted with the ASCII-only rule that the owner's own
  rejection reason had added to the task body.
- In the two follow-up runs (`truncate`, `formatBytes`), the implementers met the stated rule
  first time and both reviews approved in round 1.

The full sequence, from `changes-required` through rework to `approved`, is proven with the
stub runner (`engine/demo/team/scripts/review-demo.ts`) and by focused tests. With real
agents, every step is proven up to the rework turn running with the finding in its prompt.
Whether a real rework turn changes a candidate and then passes re-review is still unproven.

The per-run review-round limit that the main run hit is fixed: each implementer task now gets
its own rounds (`1bb85a1`).

What remains for the milestone is the full daemon suite, run once at wrap-up, and the
regenerated task pack.
