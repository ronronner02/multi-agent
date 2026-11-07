# Preserve existing seats during roster approval

Date: 2026-11-07
Scope: Command-center plan U3, R4 and R5

The owner selected compatibility-first reconciliation for existing teams. A new planning run
requires a roster even when its team already has implementers or a reviewer.

## Decisions

- Match each non-retired implementer or reviewer to one proposed slot by role and client.
  Reuse matching node and session identities, including their models and history; add only
  missing slots. Duplicate slots match distinct seats.
- Every existing non-retired seat must match. Return a named surplus, mismatch, unsupported
  client or missing-session reason to the lead for revision. Approval neither silently retires
  a seat nor replaces its session or client.
- Inactive sessions remain seats. Count reused and added seats once each; exclude the lead and
  retired seats. Keep historical names reserved by the existing allocator.
- Read the seat cap at approval and keep the concurrency limit captured in the run binding.
  Choose the reviewer from the resulting roster, whether reused or newly added.
- Only roster-enabled planning instructions include existing role/client slot counts.
  Individual identities stay in the existing projected roster. Counts preserve the required
  multiplicity without duplicating long seat names into the bounded instruction field.
  The projected roster schema and delivery instructions stay unchanged.
- Persisted planning runs without the roster marker retain their existing approval contract.
  There is no binding migration or retroactive roster requirement.

## Transaction boundary

Use the same reconciliation for the route's preflight and the approval transaction's fresh
check. Validate all seats before inserting any. Seat additions, reviewer assignment and the
approval transition share the existing database transaction.

The plan commit still precedes the database approval and is not part of that transaction.
Ordinary reconciliation failures are caught before that commit. A persistence failure or a
seat change after preflight may leave the plan commit recorded while the run remains planning;
no new Git compensation behavior is introduced.

The previously verified delivery-retirement rule, including protection for unresolved review
rework, is unchanged.
