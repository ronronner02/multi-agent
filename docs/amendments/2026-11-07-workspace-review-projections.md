# Workspace and review projections

## Decisions

U7 restores the historical agent-grid, split/focus inspector and review-diff layout on the current read model. The older running-turn controls and candidate approval controls stay removed; review is read-only, and Ask the lead appends task context to the existing chat draft without sending it.

- The existing seat projection publishes its recorded retirement state. Retired seats remain in Workspace, but the Overview fleet lists active seats.
- Verdicts publish their existing finding records beside the existing counts. File and summary text use the same bounded, redacted projection as logs.
- Activity reads belong to visible cards or the selected visible inspector. Running attempts poll every two seconds; stopped attempts get one final read. First-seen row identity, text and order survive settlement. The wire status completed is displayed as succeeded.
- Changes reuse the existing owner result route. An unfinished task or an absent candidate has no result request. The cache key includes the candidate digest, and a response for another digest is rejected.
- Evidence checks pass only when the known verified count equals the known total. A missing count remains unknown. Review requires the latest recorded approval to match a non-null current candidate. Integration additionally requires that task in the existing integration commit list. Merge readiness reads the run's existing merge check; it is not a claim that a merge already happened.
- Workspace selection survives layout changes. Review finding identifiers and candidate digests stay in folded details.

## Boundaries

No new source-file reader, approval endpoint, task-stage classifier, running-turn control or monetary metric is introduced. Live fixture activity and browser comparisons prove the local rendering and update path; the real-client, whole-product acceptance remains in U10.
