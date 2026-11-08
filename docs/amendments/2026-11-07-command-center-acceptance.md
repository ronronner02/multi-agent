# Command-center acceptance decisions

This amendment records decisions made while executing U10 of
`2026-11-06-001-feat-command-center-plan.md`, the owner-selected command-center plan.
The plan and task bodies remain unchanged.

## Recovery test alignment

U11 makes invalid evidence a judgment failure rather than an automatic retry.
Transient failures retry only after their persisted delay, and environment
failures retain their owner-action message. The older recovery fixtures still
expected the previous policy.

Use a provider-network failure for the retry-budget scenarios, assert the
persisted `retryNotBefore`, and advance the fixture clock before another attempt.
Keep the queue, budget, blocked-run and Resume assertions. Cover both invalid
evidence and provider authentication in the non-retry lead case with their exact
messages. This changes test expectations to the approved contract; it changes no
production recovery behavior.

## Pre-existing consent-continuation regression

The full daemon suite found a legacy fresh-launch consent test receiving two
submissions instead of one: a durable-obligation kickoff followed by the configured
startup action. The unchanged test passes at `ce889359` and fails at `48f92af`,
before the command-center implementation. It also fails at the U10 base `b028f7f`.

Retain the assertion and record the exact failure in
[known failures](../known-failures.md). Do not remove the identity-less durable-work
kickoff: its existing tests cover a separate intended behavior. Combining the
legacy startup submissions is follow-up work outside this evidence-and-docs unit.
The failing check is an explicit residual, not a passing result or a failure
introduced by the command-center changes.

## Evidence boundaries

The installer build, an isolated desktop launch, installation, source tests and
the live first-open-to-Merge flow are separate checks. A successful earlier check
does not close a later one. Live acceptance uses only synthetic project files and
new private repositories. It does not authorize replacing the installed app,
changing the owner's shared GitHub sign-in, or pushing delivery commits after
the initial project bootstrap.

## Planning approval integration

The live browser run reproduced an approval refusal: the chat client discarded
the existing `planApproval` evidence returned by `GET /runs/:runId/chat`, and the
approval client sent an empty payload. The daemon correctly rejected the missing
roster digest and returned the plan to the lead.

Extend U10's source scope to `engine/packages/ui/src/team/clients.ts`,
`chat-panel.tsx`, their focused chat-panel tests, and both i18n catalogs. Preserve
the existing read contract, display the proposed plan and team, and send the
digest of the roster shown to the owner. Missing or invalid evidence disables
approval; legacy runs with an explicitly null proposal retain their existing
approval path. A failed approval is named as such and is not automatically
retried. Do not weaken the daemon's digest check or add a public API.

The focused regression reproduced the empty approval payload before the fix.
Source checks and a successful repeat of the original browser action are separate
requirements; neither replaces the remaining desktop acceptance gate.

## Candidate bases across a restart

The live restart left both native turns running. After one task integrated, the
other task's completion adopted its candidate against the newer integration head
instead of its starting commit. Files delivered by the first task were therefore
misread as deletions by the second and rejected as outside its assignment.

Extend U10's source scope to `engine/packages/daemon/src/domain/workflow-runtime.ts`
and `engine/packages/daemon/test/integration-branch.test.ts`. Persist the starting
base for every newly created candidate through the existing control-owned base
record, not only for delivery lead turns. Adoption still requires the existing
provenance checks, and new tasks still start from the latest integration head.
Retain the legacy record filename for active lead turns. No candidate-owned Git
metadata becomes trusted, and no scope or evidence assertion is relaxed.

The existing concurrent-integration scenario now also reopens the database and
recreates the runtime before the second completion. That variant reproduced the
changed base before the fix; it also asserts that only the second task's own file
appears in its completion evidence. The failed live run remains evidence of the
defect, not a successful acceptance run or a reason to override a task outcome.

## Native turn telemetry wiring

The live Codex turn completed real file edits and tests, but neither telemetry
sidecar existed. Its launch passed the native `-o` final-message path without
passing that same path to the turn view. The sidecar writer consequently had no
output directory and stayed disabled. The isolated parser fixtures had supplied
the missing argument directly, so they did not cover the launch integration.

Extend U10's source scope to
`engine/packages/daemon/src/adapters/direct-worker-launch.ts` and its existing
`direct-worker-launch.test.ts`. Give both native clients' turn views the existing
per-attempt result path. The native client still owns its final-message write;
stdin, process exit status, retry classification and command permissions remain
unchanged. Strengthen the actual launch/sweep fixture to read the usage and tool
sidecars, retaining its native identity, resume, retry and failure assertions.

## Action notices when switching runs

After canceling the failed run and starting its repeat, the active planning run
still displayed the previous run's cancellation notice. The action component
retained local state across run changes; an outstanding action could likewise
keep the new run's buttons disabled and later publish an unrelated result.

Extend U10's source scope to `engine/packages/ui/src/team/overview.tsx` and its
existing `overview.test.tsx`. Key the action component by run identity so notices,
busy state and late responses remain with the run that initiated them. Preserve
the cancellation confirmation, command payload and observed-result assertions.
The regression reproduces both the completed-notice and pending-action cases
before the fix. No daemon state or command contract changes.

## Native completion review projection

The fixed-source repeat completed both implementations, recorded their approved
reviews and merged both integration commits. The screens nevertheless kept the
tasks in Review and reported that no candidate existed. The read model selected
candidate identity only from the legacy review ledger, while native completion
had already stored the validated manifest digest in the task authority row.

Extend U10's source scope to `engine/packages/daemon/src/team-control-surface.ts`
and `engine/packages/daemon/test/team-read-model.test.ts`. For a completed native
implementer task without a legacy candidate, expose the validated completion
digest through the existing field. Keep a legacy candidate authoritative, require
a matching approved verdict before closing Review, and keep missing acceptance
criteria unavailable. Lead completions, pending tasks and unvalidated evidence
do not become native review candidates. This is a read-only projection repair;
it changes no stored outcome, approval, review verdict or public contract.

## Managed launch fixture state

The refreshed full suite reached a permission error in the production-composition
lock-refusal test. Its policy redirected candidate worktrees into a temporary
directory but retained the installed `/var/lib/multi-agent/control` state path.
Persisting the starting base now uses that path for commit-backed candidates, so
the fixture stopped at admission before its intended unsupported-client check.
A temporary diagnostic in the standalone verification clone confirmed `EACCES`
on the candidate-record directory; the diagnostic was removed with its original
file hash restored.

Extend the test scope to
`engine/packages/daemon/test/managed-native-startup.test.ts`. Place that fixture's
control state beside its temporary worktrees, keeping the mailbox root under
that directory as required by the existing policy consistency check. Preserve
all fresh/resume lock, endpoint, channel and privileged-call assertions. This supplies the existing
control-state requirement without changing the installed policy, admission code
or hardened launch behavior.

## Remaining acceptance boundary

The owner chose to leave the original daemon and installed desktop app untouched,
keep U10 unmerged, and finish the remaining isolated checks. Installation and
clean-profile first open remain open until a separate environment supplies the
required port. The refreshed installer is build evidence, not installation proof.
No acceptance delivery commit is pushed to either synthetic repository.

After a later local Merge, both earlier task-result previews returned HTTP 503.
Their unchanged candidates became readable after an idle restart of only the
acceptance daemon. This is recovery evidence, not a source fix. Source-ref
fingerprint invalidation is the leading explanation; the internal exception was
not captured. Keep the source/provenance checks intact and retain this limitation
in the structured acceptance bundle. The stale post-Merge progress label and the
lead's inaccurate busy-time status reply also remain open observations.

The validation bundle contains scoped, sanitized evidence and explicit gate
status. It does not include credential stores, browser credentials, a raw database,
or native transcripts. The plan and task bodies remain unchanged, and no PR or
completion claim is made while U10 is open.

## Historical results after an owner Merge

A real-Git regression confirmed the preview failure at the cached source check.
The successful owner Merge changed a non-team branch ref while leaving the
candidate's integration source HEAD, status and file hashes unchanged. A fresh
runtime adopted the same registered tree and returned the original manifest;
the cached runtime threw instead.

Extend U10's bounded fix scope to `domain/team-workspace.ts`,
`domain/integration-branch.ts`, `domain/workflow-runtime.ts`, `startup.ts` under
`engine/packages/daemon/src/`, and the existing integration and workspace tests.
A successful Merge acknowledges only its exact old-to-new ref transition, only
for this repository's registered integration sources. Replacing that one current
ref with its prior value must reproduce the recorded digest. Other refs, source
HEAD ancestry, status and dirty bytes retain their checks; an invalidated
candidate is never revived. No candidate, stored base or owner file is rewritten.
The worker-file reader change requires an independent report-only review.

## Observed Merge progress

The owner approved the additive, read-only `merge.merged` integration field.
Readiness alone is not completion: the old read returned `possible: true` before
and after Merge, so Overview stayed at Awaiting delivery decision. Derive the
new field from the integration branch's ancestry in the current owner checkout,
with at least one recorded task commit. Missing Git evidence is null, not success.
No write endpoint, Merge permission, approval rule or run state changes.

Extend the existing integration, client and Overview scope and their tests to
consume this field. Old daemons remain compatible: an absent field stays unknown.
A confirmed Merge completes the progress step and disables the redundant Merge
action. Re-read the fact after refresh and restart; do not substitute browser-local
state for Git evidence or claim that Merge readiness means delivery occurred.

## Lead progress context

The recorded reviewer attempt began before the busy-time lead prompt was written.
That prompt included the owner's question but no durable task or review status.
The real managed-launch fixture reproduces the omission with a reviewer already
running and the owner-message slot admitting the lead at worker capacity.

Extend U10's bounded scope to `domain/agent-turn.ts` and
`domain/startup-orchestrator.ts` under `engine/packages/daemon/src/`, plus the
existing agent-turn and seat-pane-launch tests. Each lead prompt receives a
run-scoped snapshot of task states, assigned client, latest attempt and recorded
review verdict. The snapshot has an observation time, a 100-task limit and an
explicit truncation flag. It carries no task bodies, transcripts, credentials or
new read permission. Missing evidence is null, and a stopped reviewer is not
presented as an approval. Other roles receive no team-wide snapshot.

This repairs the missing context, not a guarantee about generated prose. Native
reply accuracy remains a separate, bounded acceptance observation. The original
inaccurate reply remains in the evidence.

## Starting-base record identity

The independent source review identified an admitted task ID whose path segments
made the generalized starting-base writer overwrite another task's record. A
real-Git regression reproduced the changed saved commit after a later candidate
was created; the candidate itself remained inside the assignment root.

Use identity-safe record addressing in the existing runtime. Fixed-width UUID
runs with single-component task IDs retain their safe legacy filenames. Other
identifier pairs use a digest of the serialized pair in a separate control-owned
namespace. This preserves normal active-run recovery without treating an opaque
ID as a filesystem path, changing the public task-ID contract, or trusting a
worker-written base. Tests retain the victim's exact bytes, recover both distinct
bases after reopening the database, and cover the safe legacy filename. The
independent P0/P1 confirmation remains a required gate for this fix.

## Removed seat sessions on a still-live server

The final-source repeat kept the previous projects after acceptance cleanup had
removed their idle terminal sessions. The new lead recreated its session, but the
implementers retained old pane bindings. Listing panes for either missing named
session then threw before the existing seat-recreation path could run. The tasks
stayed queued with no native attempt. The affected lookup was unchanged at the
U10 base; a real-terminal regression reproduced the same missing-session error.

Extend the bounded scope to `engine/packages/daemon/src/domain/seat-pane.ts` and
its existing `seat-pane-launch.test.ts`. Check the exact named session through
the adapter's existing presence probe before reading its saved pane. Missing
sessions proceed through the existing lifecycle lease and creation path;
unexpected probe failures still propagate. A live neighboring session is neither
adopted nor replaced. The regression keeps that neighbor alive, removes the bound
seat, and verifies its new binding while preserving the neighbor's pane. A second
test preserves the original binding and terminal when the probe fails.

The pending acceptance run remains the same run. No session is fabricated by a
manual database write, and no original-service or installed-app state is changed.

The direct-dispatch fixtures in `integration-branch.test.ts`,
`attempt-failure.test.ts`, `lead-roster.test.ts` and `owner-slot.test.ts` already
model a present, bound pane. Supply that same presence fact through `hasSession`
in their partial terminal doubles. Preserve every retry, roster, reserved-slot
and conversation-identity assertion; production callers use the existing full
adapter. The first broader check's missing-method failures remain recorded.

## Final isolated repeat and remaining gates

The same pending runtime repeat completed after the missing-session repair. Both
native implementations and their reviews finished, and the owner-facing Merge
fast-forwarded only the synthetic project. Its final test run passed 57 tests.
The earlier failed run and all earlier verification results remain in the bundle.

Both historical result previews were primed on the final daemon before Merge.
They returned HTTP 200 with identical base identifiers, manifest digests, byte
counts and patch hashes after Merge without a restart, and again after an idle
restart. The additive `merge.merged` field changed from false to true; all four
Overview phases remained complete after page refresh and daemon restart. The
1440- and 390-pixel light and dark captures retained their measured viewport width.

The final busy-time owner question reached the lead while Task B's reviewer was
running. The prompt snapshot and reply agreed: both implementations were done,
Task A had an approved review, and Task B had no verdict yet. The reply included
the snapshot time and arrived before the later verdict. Only one worker attempt
was active for this final question. Earlier two-slot saturation evidence and the
current reserved-capacity regression remain separate checks; this repeat does
not prove the combined scenario at full worker capacity or guarantee future prose.

The last Reviews task-selection observation did not reproduce as a product
navigation defect. The exact-label probe matched no selector; the observed
combobox selected Task B, and its task query and settled diff survived refresh
with a successful result response. A filename-only wait also matched a review
finding before the diff settled. Keep those automation observations, use the
settled diff evidence, and make no additional source change for them.

The required independent runtime review found one P0 starting-base identity
issue. Its single confirmation closed R1-1 with no new P0/P1 findings. That review
used source inspection and hash-verified producer receipts, not independently
executed tests. The later missing-seat repair and fixture alignment received a
bounded root review; they are not added to the independent review's coverage.

Final-source focused checks passed 533 tests. The UI suite passed 1,868 tests with
one skipped; typechecking, build and smoke checks passed. The standalone daemon
suite passed 17,086 tests but failed the two exact cases in `docs/known-failures.md`:
the intentionally unresolvable hostname and the duplicate fresh-launch startup
submission. Five tests were skipped and five remained todo. The suite stays
failed, and neither assertion is weakened. The 31-path source manifest, rather
than the stale 28-path supervisor caption, identifies the tested candidate.

The current browser session was revoked, its isolated context closed, and only
the idle acceptance daemon and its four terminal sessions were stopped. The
original daemon, original terminal server, protected dirty checkout and installed
app remain unchanged. Both existing synthetic repositories are still private;
their remote branches remain at bootstrap commits, with no delivery push.

U10 remains uncommitted and unmerged. Desktop installation and clean-profile
first open are not run: the owner chose to preserve the occupied port-7433
environment and installed app. Source, browser, installer-build and local-project
Merge evidence do not replace those desktop gates.

## Owner-authorized desktop instance switch

The owner subsequently requested stopping the old instance, starting the new
candidate, and continuing the remaining acceptance checks. This supersedes the
earlier decision to leave the original port-7433 daemon running. Stop only the
identity-verified daemon after a private database backup and a fresh check that
there are no executing attempts. Preserve all original run and queue records,
its idle terminal session, credentials, and the existing all-users installation.

Use the already-built candidate installer in a separate per-user destination. A
fresh desktop profile contains only the selected candidate engine path; its
session, project state, and GitHub configuration begin empty. Process-local WSL
environment forwarding must be verified before launch so neither startup nor
pairing uses the original profile. Record the clean first-open and native folder
picker separately from the earlier browser and native execution evidence.

After those checks, reconnect the installed candidate to the existing isolated
acceptance projects on port 7433. Do not create another remote repository, upload
new files, replace the existing installation, or mutate the old run records.
The requested replacement may remain running at closeout; this does not grant
commit, push, merge, release, or automatic restoration of the old daemon.

## Desktop GitHub device-code output compatibility

The first installed-desktop sign-in started the real GitHub CLI but remained at
Loading. A bounded reproduction with the same process environment captured the
clipboard form, `One-time code (ABCD-1234) copied to clipboard`, followed by the
canonical device URL. The reader recognized only `one-time code: ABCD-1234`.
The desktop login shell exposes the Windows clipboard helper, unlike the earlier
bounded browser environment. No credential-store or authorization change is
needed.

Extend the acceptance repair to `domain/github-cli.ts`, the existing
`team-github.test.ts`, and `test/fixtures/stub-gh.mjs`. Accept both observed public
code prompts while retaining the exact code format and canonical-URL check. The
new fixture splits the clipboard prompt and URL across chunks; the regression
must fail before the one-line parser repair. Preserve the initial timeout and
unauthenticated diagnostic request failures as observations, not product passes.
This later repair receives a root review and is outside the earlier independent
review's recorded coverage.

## Desktop acceptance paused for owner use

The owner confirmed, "Keep this instance; pause interactive checks." Keep the
newly installed candidate and its fresh profile running as the owner's working
instance. Preserve the current form, project state and credentials. Stop desktop
interaction; do not submit the form, switch to the earlier acceptance profile,
close or restart the window, or restore the old service automatically. The
owner's current project is outside the synthetic acceptance scope. Its contents,
form text and database records are not part of this evidence update.

The authorized original-daemon stop completed with one SIGTERM and a clean
shutdown receipt after a private backup. Its five run records and three pending
queue items, idle terminal and shell, protected configuration, and existing
all-users installation remain preserved. The candidate installer completed in a
separate per-user destination. Its installed payload hashes match the build; the
fresh first open started and paired with the isolated engine on port 7433. Real
sign-in succeeded after the clipboard-prompt parser repair. The installer adds a
per-user uninstall entry; its new Start Menu shortcut was moved to task scratch
so the normal launch shortcut still targets the original installation.

The parser regression failed before the repair and the combined sign-in and
bootstrap check then passed 48 tests. Typechecking, build and smoke passed; smoke
counts were 742 daemon, 45 CLI, 45 i18n and 88 UI tests. Desktop tests passed 26.
The latest standalone daemon suite ran against the current 34-path candidate:
17,086 passed, 3 failed, 5 skipped and 5 todo. All three failure signatures match
`docs/known-failures.md`: hostname resolution, the duplicate fresh-launch startup
submission, and the existing event-ordering determinism case. Retain the failed
suite result. No test assertion is weakened or repeated for a green result.
The earlier full UI and synthetic delivery checks retain their recorded scope.

Installation, clean first open and real sign-in are now observed. Opening the
native folder dialog is not proof of a completed synthetic folder selection or
Create. Folder selection and preview, top-bar drag, close-button acceptance, the
complete desktop Create flow, and the combined final busy reply with both worker
slots occupied remain incomplete. Incorrect locators and unsettled picker
observations remain test-harness limitations, not diagnosed product defects.
The fresh UI began with the product's default Chinese language; the earlier
system-locale explanation was not established. The two diagnostic HTTP 403s
omitted the anti-forgery header, and the blocked font request was imposed by the
exact-origin test route. Neither is evidence of failed application pairing.

Preserve the prior bundle snapshot under `history/pre-desktop/`, add only
allowlisted desktop receipts and inspected screenshots, and refresh current
source, service, verification and privacy facts. The later parser change has a
local source-and-receipt review only; it does not extend the completed independent
review's coverage. U10 remains uncommitted and unmerged, with its remaining
interactive acceptance paused by the owner.
