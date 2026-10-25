# Simplification amendment

Date: 2026-10-26
Authority: the owner's instruction of 2026-10-26 to cut over-engineering and defensive design.
Source: `docs/plans/2026-10-13-001-feat-multi-agent-team-plan.md`, U5, and `AGENTS.md`.

## Decisions

1. **`AGENTS.md` trimmed.** The execution rules shrink from about 4,100 to about 1,750 words. Reviewer transport and the full-suite procedure move to `docs/operations.md`. The dated history of each rule, and the spent T010 grant, are removed.
2. **Core code narrowed.** Two reviewers apply only to `engine/config/isolation/`, `adapters/worker-launch*.ts`, credential handling and `domain/team-workspace.ts`. Authority, admission, the mailbox and `contracts/` become non-core and get one reviewer. Changes under 100 lines get one round.
3. **Proof-only work cut or deferred.**
   - T049 is cancelled; T054 carries the regression matrix that matters.
   - T046, T018, T024, T025 and the live runs T026-T030 are deferred until the UI tasks (T015, T016 and T019-T022) have landed and the owner says go.
   - T052 no longer depends on T046. Until T046 lands, T052 reports retained review packets as unavailable, which T052's evidence table already allows for missing evidence.
4. **Candidate workspace re-planned (T054).** The control copies the candidate into a control-owned scratch directory and runs plain git there, with a cleared configuration. This replaces the hand-written worktree reader. The design and the probe result are in plan U5, "Candidate manifest from a copied snapshot". T048 follows T054, because both edit `team-workspace.ts`.

## Unchanged

The product contract, requirements, acceptance examples, the snapshot lane, the T015 amendment and the delivery and live grants.
