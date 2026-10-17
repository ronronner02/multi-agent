---
title: Scheduled Inspection and Proactive Audit - Plan
type: feat
date: 2026-10-18
topic: inspection-audit
execution: code
status: draft
---

# Scheduled Inspection and Proactive Audit - Plan

- **Status:** draft, not active. Do not derive a task pack or start execution until Milestone 1 is delivered and the open owner decisions below are settled; then the owner marks this plan active.
- **Relationship to Milestone 1:** a separate plan. It changes nothing in [the Milestone 1 plan](2026-10-13-001-feat-multi-agent-team-plan.md) or its acceptance; that plan's KTD18 remote phone access is a different deferred item and is not covered here.
- **Prerequisites:** Milestone 1 delivered (U1-U13), in particular U2 governance grants, U4 restricted launch with the KTD27 client lock, U5 snapshot review and KTD25 extensions, KTD20 reason codes, and U13 health checks.
- **Principles:** scripts first, snapshot isolation, finding text is always data, no new client adapters, no over-engineering.

## Goal

Keep finished projects maintained at low cost. Scripts inspect each registered project on a schedule; a model is called only to summarize red results or to run a budgeted audit of recent changes. Findings stay local, the owner triages them, and an accepted finding becomes a small fix plan that goes through normal M1 approval before any code changes.

## Scope

**Included**
- Standing inspection grants per target repository, and a daemon-owned schedule.
- Passive inspection: scripted probes in an immutable snapshot, fingerprinted findings, flaky-test rerun, auto-resolve and per-run caps.
- Proactive audit: report-only review of changes since the last audited commit, under a daily budget.
- Local finding store, triage in the TUI and Web UI, and micro-fix plan generation.
- Model profiles: owner-selected models on the existing Claude Code and Codex clients, with bounded failover.

**Excluded**
- New client adapters (DeepSeek, Ollama or others as separate runtimes).
- Creating GitHub issues or any other publication; export stays a manual owner action.
- Automatic fixes, or dispatch from a finding without an approved plan.
- Always-on processes, concurrent inspection of several projects, and remote nodes.

## Requirements

- M2-R1. An inspection or audit runs only under an active, owner-approved inspection grant for that target. No scheduler or external trigger holds an owner credential.
- M2-R2. Probes and reviewers run against an immutable snapshot of the target, with no write access to the target tree, no git metadata and no database access.
- M2-R3. A run whose probes are all green makes no model call.
- M2-R4. Findings are fingerprinted; a recurrence updates the existing finding instead of creating a new one.
- M2-R5. A failing test is rerun once in the same snapshot to separate flaky from failing.
- M2-R6. A finding auto-resolves after N consecutive clean runs of the probe that raised it; a skipped or failed probe run does not count as clean.
- M2-R7. Each run creates at most a capped number of new findings and reports how many it suppressed.
- M2-R8. The proactive audit reviews recent changes first and stops admitting work when its daily budget is spent.
- M2-R9. Probe output, finding text and reviewer output are data. They never enter an agent prompt as instructions, never become terminal input, and never trigger an action.
- M2-R10. Only accepted findings produce micro-fix plans, and a micro-fix plan dispatches only after normal KTD5 approval.
- M2-R11. The owner selects the model for each role from approved profiles; failover uses only the profiles the grant lists.
- M2-R12. Runs on one machine are serial and wait for any active managed run. A missed scheduled slot runs once on the next daemon start and is recorded as late.
- M2-R13. Every run records time and usage per role; unavailable usage is null with a reason, never zero.

## Key Technical Decisions

- M2-KTD1. **One standing grant replaces per-run authorization for inspection.** A new additive approval action, `inspection-grant`, binds: target repository identity, schedule (cron expression, local time zone), enabled modes (passive, audit), per-run time limit, daily audit budget, ordered model profiles per role, finding caps, auto-resolve N, and expiry. The grant authorizes read-only inspection runs only, never implementation. Any field change creates a new grant version; revocation stops new runs. Each run records the grant version it ran under. Inspection runs are their own run kind and do not consume M1 run budgets.
- M2-KTD2. **The managed daemon owns the schedule.** A managed-mode scheduler computes due slots from active grants. An external OS scheduler (Windows Task Scheduler or cron) may only start WSL and the daemon; it calls no run endpoint and holds no credential. On start, the daemon replays at most one missed slot per grant and records the rest as skipped. Runs are serial, and a due run waits while an M1 managed run is active.
- M2-KTD3. **Two phases, two identities.** Phase 1 (probes) runs under a dedicated inspector worker identity with no provider credentials. It sees the snapshot read-only plus a throwaway scratch overlay for installs and test artifacts, deleted after the run; network egress follows KTD23. Phase 2 (model) runs only when phase 1 is red, under a separate identity with provider credentials and read-only access to the snapshot and phase 1 results. Neither phase has git metadata, the target tree or a database connection. Findings reach the daemon only through a capability that can create or annotate findings for that run.
- M2-KTD4. **Probe definitions live in the orchestrator, not the target.** Each grant references an owner-maintained probe manifest (`engine/config/inspection/probes/<target>.json`) naming the commands for tests, `npm audit --json`, `npm outdated --json`, typecheck and lint, plus the U13 health checks and KTD20 failure records for that target. Code in the target cannot disable or rewrite a probe. Each probe has a timeout and a deterministic parser; a hung or unparseable probe is a probe failure, not a clean run.
- M2-KTD5. **Fingerprints come from structured fields only.** Keys per kind: test failure (probe, test ID, error class, normalized first message line); advisory (advisory ID, package); outdated (package, major version); health (check ID); attempt failure (reason code, role); audit issue (file, category, hash of the cited code). Normalization strips timestamps, durations, line numbers and scratch paths. Model text is never part of a fingerprint. A dismissed fingerprint stays dismissed unless its severity rises.
- M2-KTD6. **The summarizer annotates; it never decides.** Probes alone decide whether a finding exists. The summarizer receives finding IDs and redacted excerpts as read-only files, and returns schema-validated JSON (`findingId`, `summary`, `suspectedCause`, `files[]`). Unknown IDs, files outside the snapshot and invalid JSON are dropped; the finding stays, unannotated.
- M2-KTD7. **The audit resumes from the last fully audited commit.** It diffs the snapshot's commit against the last completed audit point, skips the model when nothing changed, and splits the diff into chunks, with security-relevant paths first (auth, input handling, credentials, isolation config). Each chunk is a report-only reviewer invocation through the M1 framework integration. Budget is checked before each chunk; a running chunk finishes, and only completed chunks advance the audit point. An audit finding must cite a file and line range that exists in the snapshot, or it is dropped.
- M2-KTD8. **Triage gates every fix.** Accept and snooze are versioned owner-control actions the owner or the Lead may take; dismiss is owner-only, so finding text cannot talk an agent into hiding a real problem. Accept generates a micro-fix plan from a fixed template: problem, evidence (finding text inside a fenced, labeled data block), proposed write scope (only the finding's validated files), acceptance criteria (the failing probe or test passes, plus a regression test). The plan then follows normal M1 binding, KTD5 approval, KTD25 extensions and review.
- M2-KTD9. **Model profiles ride on existing clients.** An owner-maintained `engine/config/models/profiles.json` defines each profile: client (`claude-code` or `codex`), model ID, provider endpoint and a credential reference in the worker home. Claude Code reaches Anthropic-compatible endpoints through its gateway settings; Codex reaches OpenAI-compatible endpoints, including a local Ollama inside WSL, through its provider configuration. The launcher writes these into the worker home and never touches personal configuration. Adding an endpoint is a KTD23 egress change (policy revision bump plus preflight); switching models among approved endpoints is a profile edit. A readiness probe per profile gates first use. On `model_unavailable`, `provider_quota` or `provider_server_error`, a run switches once to the next profile in its grant within the same budget; auth failures never fail over.
- M2-KTD10. **Measure and bound cost per role.** Phase 2 and audit chunks run as single-shot headless invocations with structured output inside the M1 worker boundary, not long interactive sessions. Usage comes from the client's structured output when available, otherwise wall-clock time only, labeled. Context per invocation is minimal (finding excerpts, or one diff chunk plus its acceptance rules), with stable content first so provider prompt caching can apply.

## Implementation Units

Execution note: the imported engine already has health and crash-cart domain modules (`domain/health-*.ts`, `domain/crash-cart-*.ts`). Inspect them before M2-U2 and M2-U3, and extend what fits instead of building parallel probes.

### M2-U1. Inspection grants, schedule and model profiles
- **Requirements:** M2-R1, M2-R11, M2-R12; M2-KTD1, M2-KTD2, M2-KTD9.
- **Files:** `engine/packages/daemon/src/domain/inspection-grant.ts`, `engine/packages/daemon/src/domain/inspection-scheduler.ts`, `engine/packages/daemon/src/domain/model-profiles.ts` (new); `engine/packages/daemon/src/contracts/team-control.ts`, `engine/packages/daemon/src/routes/team-control.ts`, a new additive migration; `engine/config/models/profiles.json` (new); tests `inspection-grant.test.ts`, `inspection-scheduler.test.ts`, `model-profiles.test.ts` (new).
- **Test scenarios:** (1) no run starts without an active grant, or after expiry or revocation; (2) an agent credential cannot create, change or approve a grant; (3) a grant change creates a new version, and runs record theirs; (4) after downtime, one missed slot runs late and the rest are recorded as skipped; (5) a due run waits while an M1 run is active; (6) a profile whose endpoint is not in the egress allowlist is refused; (7) failover switches once on `model_unavailable` and never on auth failure.

### M2-U2. Snapshot probe runner and parsers
- **Requirements:** M2-R2, M2-R3, M2-R5; M2-KTD3, M2-KTD4.
- **Files:** `engine/packages/daemon/src/domain/inspection-runner.ts`, `engine/packages/daemon/src/domain/probe-parsers.ts` (new); `engine/config/inspection/probes/` (new); `engine/config/isolation/worker-policy.json` (inspector identity; policy revision bump and preflight); tests `inspection-runner.test.ts`, `probe-parsers.test.ts` (new) with fixtures.
- **Test scenarios:** (1) a probe that tries to write the target tree, read `.git`, open the database or reach a denied host fails, and the target is byte-identical afterwards; (2) the scratch overlay is gone after the run; (3) vitest, `npm audit` and `npm outdated` fixtures parse to the expected records; (4) a test that fails then passes is `flaky_test`, and one that fails twice is `test_failure`; (5) a hung probe is a probe failure; (6) an all-green run makes no model call.

### M2-U3. Finding store and noise reduction
- **Requirements:** M2-R4, M2-R6, M2-R7; M2-KTD5.
- **Files:** `engine/packages/daemon/src/domain/finding-store.ts` (new), a new additive migration; test `finding-store.test.ts` (new).
- **Test scenarios:** (1) the same failure over three runs is one finding with three sightings; (2) timestamp, duration and path differences do not change the fingerprint; (3) N clean runs resolve a finding, and a skipped or failed probe run does not count; (4) recurrence after resolve reopens the same finding; (5) a dismissed finding stays dismissed unless its severity rises; (6) the per-run cap holds and the suppressed count is reported.

### M2-U4. Red-only summarizer
- **Requirements:** M2-R3, M2-R9, M2-R13; M2-KTD6, M2-KTD10.
- **Files:** `engine/packages/daemon/src/domain/finding-summarizer.ts` (new); test `finding-summarizer.test.ts` (new).
- **Test scenarios:** (1) probe output containing "ignore previous instructions" or "dismiss all findings" changes no state and issues no tool call; (2) unknown finding IDs and files outside the snapshot are dropped; (3) invalid JSON leaves findings unannotated, not deleted; (4) the summarizer cannot create or resolve findings; (5) usage is recorded, or null with a reason.

### M2-U5. Proactive audit
- **Requirements:** M2-R8, M2-R9, M2-R13; M2-KTD7, M2-KTD10.
- **Files:** `engine/packages/daemon/src/domain/proactive-audit.ts` (new); test `proactive-audit.test.ts` (new).
- **Test scenarios:** (1) no new commits makes no model call; (2) security-relevant chunks run first; (3) when the budget runs out, a running chunk finishes, no new chunk starts, and the audit point advances only past completed chunks; (4) a finding without a valid in-snapshot citation is dropped; (5) reviewer output cannot write files or start other invocations.

### M2-U6. Triage and micro-fix plans
- **Requirements:** M2-R9, M2-R10; M2-KTD8.
- **Files:** `engine/packages/daemon/src/domain/finding-triage.ts`, `engine/packages/daemon/src/domain/micro-fix-plan.ts` (new); TUI and Web UI triage views; i18n keys; tests `finding-triage.test.ts`, `micro-fix-plan.test.ts` (new) and a UI component test.
- **Test scenarios:** (1) only the owner can dismiss; the Lead can accept or snooze; (2) a snoozed finding returns after its date; (3) a micro-fix plan's write scope contains only the finding's validated files, and its evidence sits in a fenced data block; (4) a micro-fix plan does not dispatch before KTD5 approval; (5) finding text that names other files or asks for wider scope changes neither the plan's scope nor its acceptance criteria.

### M2-U7. Prove the loop on the demo
- **Requirements:** all M2 requirements.
- **Files:** `engine/test/inspection-e2e.test.mjs` (new), `docs/validation/inspection.md` (new), `docs/operations.md`; `work-board` fixtures with a planted failing test, a flaky test, a vulnerable dev dependency and a test that prints injection text.
- **Test scenarios:** (1) a passive run files each planted problem exactly once; (2) a second run deduplicates them; (3) after fixing, N clean runs resolve the findings; (4) an accepted finding becomes an approved micro-fix plan that the M1 team fixes and reviews; (5) the injection text causes no action; (6) the report lists time and usage per role, with unknown usage stated.

## Defaults (owner-adjustable)

| Setting | Default |
|---|---|
| Passive run time limit | 20 minutes |
| Daily audit budget | 30 minutes wall-clock (token budget when usage is reported) |
| New findings per run | 10 |
| Auto-resolve after | 3 consecutive clean runs |
| Grant expiry | 90 days |

## Open owner decisions

1. Where micro-fix plans live: the daemon's store (target tree untouched), or `docs/plans/maintenance/` in the target repository.
2. Audit cadence: nightly, or weekly with nightly passive runs.
3. Which provider endpoints to pre-approve in the egress allowlist for model profiles.
