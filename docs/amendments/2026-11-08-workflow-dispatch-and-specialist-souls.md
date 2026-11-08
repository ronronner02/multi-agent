# Native workflow dispatch and specialist profiles

## Owner decision

The owner approved extending the existing run and seat system to dispatch all 38 catalog workflows and record their outcomes. User-only entrypoints, governed caller contracts, capability checks, protected paths, external actions and budget limits remain in force. Catalog coverage is not evidence of successful execution on every host.

The owner also approved versioned, owner-editable specialist profiles (SOULs) that the Lead can select. Permission role, specialist identity and client/model are separate choices. The Lead chooses the necessary seats within the approved roster and model limits; the owner need not predict the number of specialists.

## Implementation boundaries

- Extend task admission, native attempt context and the existing completion observer. Do not introduce a second scheduler.
- Derive request provenance at owner and Lead admission boundaries; worker-written requests do not create owner grants.
- In Lead-led runs, record initial selections as owner chat requests for worker delegation, not as permanent workflows on the Lead's conversation task. Keep unassigned requests in the Lead's context across planning turns and remove them after assignment. Runs without a Lead dispatch directly to their worker.
- Use the complete pinned source package, including relative supporting files, rather than generated skill mirrors.
- Expose workflow selection and recorded results through the existing owner API and task/chat surfaces.
- Store specialist revisions per project. Pin the selected profile's identity, version, content and digest to the attempt context. Editing a profile affects new attempts, not a resumed attempt's recorded context.
- Profiles guide expertise, working style and evidence quality. They never expand a role's permissions or replace the approved task.
- Reuse the current UI components, authentication, queue, candidate workspaces and launch lifecycle. Add no shared cross-run personal memory or new dependency.
- Read-only workflow inputs do not claim exclusive write paths. Validated answer-only completion does not need an implementation review or an empty integration commit.
- Read-only workflows may consume the approved read scope but never declare candidate writes. Roster reconciliation and owner assignment both preserve specialist identity while a seat has unfinished work.
- Carry read-only scope through both native admission steps. Owner completion reads use the exact current native generation's recorded outcome, not an earlier success or candidate changes alone.
- Preserve the previous candidate and recorded context when an exact resume fails before launch. Record that failed launch separately so it does not occupy the later native generation's outcome.
- Keep entrypoint-specific capability and effect checks with the pinned workflow that owns them. In particular, the browser wrapper owns its runtime probe and exact-origin checks before browser effects; native client startup is not browser execution or a daemon-issued browser attestation.
- Direct read-only launches select the native client's restrictive mode. The parked hardened policy retains its role-based mounts; a read-only request on a non-reviewer role records a capability block instead of launching with a writable candidate.
- Source setup uses the exact Git revision and checks out link blobs as inert regular files. This preserves the pinned repository's runtime aliases without following them or using them as entrypoints.

## Verification and delivery

Verify provenance, the 38-entry dispatch matrix, missing source/capabilities, asynchronous completion, profile persistence, role compatibility, owner-only edits and resume stability. Run affected package checks, focused tests and smoke checks. Distinguish source/package coverage, native fixture execution and live external capability verification.

The one-time degraded-review decision applies only to PR #151. New changes retain the repository's current review and delivery requirements.
