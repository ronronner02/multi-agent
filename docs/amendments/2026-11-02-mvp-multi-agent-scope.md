# 2026-11-02: MVP scope for multi-agent runs

**Decided by:** the owner, 2026-11-02.

This amendment records what the active plan no longer governs, and what the MVP must
deliver instead. It follows `2026-10-31-mvp-reset.md` and `2026-10-31-retire-tui.md`
and supersedes the plan sections it names. The plan text itself is left unchanged; the
derived task pack is regenerated separately.

## Why

The 2026-10-31 reset moved the product to an MVP path but did not reconcile the plan.
The plan still requires a terminal UI (R12, PC1-PC5, U6) and still lists T024-T030 as
required proofs, while `main` has retired `packages/tui` and cut those tasks. Two
consequences:

- A task pack regenerated today would still contain TUI cards and cut acceptance cards,
  so an agent reading it would do the wrong work.
- "Definition of Done" still means the ReevesAgents comparison and a five-harness
  adversarial suite. Under the reset that is no longer the milestone.

Separately, the MVP as shipped is not multi-agent. In production code on `main`:

- `routes/team-start.ts` is the only non-test caller of `createTask`, and it creates one
  implementer task named `task-1`;
- no production path creates a reviewer task, so `reviewOf`, the read-only reviewer
  mount and the review-evidence ledger are reachable only from tests;
- no production path creates a lead task, so the lead protocol, charter and wake guards
  never run;
- no production path adds a task to a run that has started. `task-edit.ts` classifies
  `addTask` as `plan-change-required` and suspends the run, but nothing applies an
  updated binding and adds the tasks.

The owner's objective is the original plan's multi-agent behavior — lead, scoped
implementers, independent review — delivered through the MVP surfaces. The terminal UI
is not part of that objective.

## Decisions

1. **The product surfaces are the Web UI and the Windows desktop app.** The terminal UI
   stays retired. The plan's R12, PC1-PC5 and U6 are satisfied by the Web UI alone;
   every clause that names the TUI as a required client no longer applies. Where the plan
   says "both clients", read "the owner browser client".
2. **`workers.isolation: none` stays the default and the supported mode for this
   milestone.** Hardened isolation remains parked (T038, PR #85) and is not a
   prerequisite for any slice below. A slice may not depend on `/etc/multi-agent`, the
   `ma-*` accounts, sudo, or the bubblewrap launcher.
3. **The milestone delivers multi-agent runs.** Four slices, in order. Each is done when
   its demo command works on a fresh clone and smoke CI passes.
   - **C1 — Run growth.** An owner action that applies an updated plan binding to a
     running run and adds tasks to it. Implements the path `task-edit.ts` already
     classifies as `plan-change-required`, and keeps the existing suspension until the
     owner approves.
   - **C2 — Review loop.** When an implementer task completes with validated evidence,
     the run creates its reviewer task bound by `reviewOf` to that candidate and routes
     it to a reviewer seat. Findings return to the implementer under the existing
     bounded-rework counter.
   - **C3 — Lead.** A run starts with a lead task that decomposes the approved goal into
     implementer tasks under the existing lead protocol, roster and wake guards.
   - **C4 — Acceptance.** One recorded end-to-end run on a demo repository with both
     installed clients, plus the failure cases it naturally reaches (rejected approval,
     review rework, cancellation, restart). This replaces T024-T030.

   One session may take the whole sequence from C1 to C4 without returning for a
   per-slice decision. It stops only for a stop condition already named in `AGENTS.md`:
   a plan conflict, a missing tool or credential, a P0/P1 that survives its review
   rounds, or work that is clearly as large again as the budget.

   The appearance work in flight on `feat/restore-ink-appearance` lands before C1, and
   C1 rebases onto it rather than duplicating its shell changes.
4. **T033 and the cancellation half of T017 land alongside C2 and C3.** Retry
   classification and observed termination only matter once tasks are chained.
5. **Acceptance is re-cut.** The required proofs are:
   - the C4 recorded run, including at least one review round that changed the candidate;
   - the existing focused tests and smoke CI;
   - the full daemon suite once at wrap-up.
   The same-task OpenRig/ReevesAgents comparison, the separate reverse-pairing contract
   run, and the adversarial harness set are **withdrawn**, not deferred: they were cut on
   2026-10-31 and this amendment removes their claims from the plan's Definition of Done.

## What this does not change

- Product Contract R1-R22 and AE1-AE13 remain the requirements authority, except the
  terminal-UI clauses named above.
- Plan-governed autonomy, separate delivery permissions, the durable queue as the single
  task-state authority, the mailbox, the approval invariants, the evidence rules and the
  per-run limits (KTD9) are unchanged.
- The pinned engine baseline, the framework pin and the owner read model are unchanged.
- Nothing here authorizes commit, push, merge, release or deployment beyond the standing
  grants in `AGENTS.md`.

## Consequences the owner accepted

- The product has one owner client, so an interface change is made once.
- With `workers.isolation: none` a worker runs as the owner's user with the owner's
  filesystem and network access. That is disclosed in `docs/operations.md` and is the
  accepted posture until hardened isolation is unparked.
- Withdrawing the candidate comparison means the milestone no longer produces evidence
  about whether OpenRig was the better base. The selection stands on the earlier screen.
