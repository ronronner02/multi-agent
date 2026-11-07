# Task-stage projection

## Decision

U6 extends the existing read-model owner at engine/packages/daemon/src/team-control-surface.ts; the plan's extra domain/ segment is a path typo.

The pure classifier keeps KTD14's precedence. Run-wide plan and chat decisions apply to unfinished tasks and the lead that represents the run; they do not relabel already-finished worker tasks. A blocked run likewise gates unfinished work. Overview lists each run-level decision once, using the same decision array as the chat badge, rather than duplicating one action for every affected task.

An open worker report remains Waiting on lead until the lead resolves it or escalates. A scheduled provider retry remains Queued. A completed implementer with a required but unapproved current-candidate review remains Review. A canceled run has no outstanding retry or review dependency. A terminal task with no remaining dependency is Done; its recorded outcome remains visible in the drawer, so Done does not assert success.

## Existing owners

The projection reads assigned seats, attempts, review verdicts and the latest worker report from existing durable owners. Report prose is bounded and redacted at the read boundary. It adds no worker-file reader, task transition or approval permission.

Overview and Tasks render the published stage. Verified criteria retain their evidence-bound counts; missing criteria remain unknown. No estimated percentage is invented. Resume reuses the existing limit-increase behavior. Merge uses the integration read's readiness and handles a refused result as a refusal, not a successful merge.
