# Active-time continuation

Date: 2026-11-09

The owner can continue an unfinished run after its active-time budget is exhausted. Each Web UI continuation adds 60 minutes to the approved limit and displays that increase before submission. Earlier extensions do not change the size of the next increase. The existing seven-day total limit remains in force.

The continuation request targets the run itself: both `runId` and `actionId` contain the run ID, while each submitted request receives a fresh `idempotencyKey`. This uses the existing owner-command contract and applies to the shared Overview and lead-chat control.
