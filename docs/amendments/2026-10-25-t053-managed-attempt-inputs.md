# T053 Amendment: managed-attempt production inputs

Date: 2026-10-25
Authority: the owner's instruction of 2026-10-25, following T047's intake stop.
Status: owner-authorized; execution requires its own Track A intake and required review. This status is not an approval record.
Rebased: 2026-10-26, onto `6113c3f`, after `docs/amendments/2026-10-26-simplification.md`. The four gaps below were rechecked there and still hold.
Source: `docs/plans/2026-10-13-001-feat-multi-agent-team-plan.md`, U5 and U2.
Blocked work: T047.

## Decision and unchanged scope

T047 stopped at intake under its own `stop_if`. Its goal is to attach a *produced* managed attempt to a seat's binding and register that attempt's mailbox endpoint in the composed launch chain. Reading source at `64d5071` established that the producer (`WorkflowRuntime.produceManagedAttempt`, landed by T042) has no production caller and is not even configured: `managedAttemptRoots` is declared in `workflow-runtime.ts` and supplied by no production composition; the runtime built at `startup.ts` receives `assignmentRoot`, `candidateRoot` and `defaultWorker`, but no attempt roots, so the producer throws `Managed attempt production is not configured` in a real daemon.

Four of the producer's inputs have no production owner, and none of them lies in T047's declared files. This amendment defines **T053**, a Track A prerequisite that supplies them and the composition point. T047 keeps its attachment scope unchanged and gains a note naming T053 as its prerequisite.

The Product Contract and every acceptance example remain byte-for-byte unchanged. No requirement, KTD, role charter or verification obligation changes. This is not a split of T047's scope and it grants no Track B work.

## Why these four inputs are not wiring

Each was verified against source rather than inferred. All four are *authority* questions, not plumbing:

| Input | State on `main` | Why it is not T047 wiring |
| --- | --- | --- |
| Worker control credentials | Every production construction of `TeamControlCredentials` sets only `ownerToken` (`startup.ts`, `index.ts`, `server.ts`). The only environment variable read is `MULTI_AGENT_OWNER_TOKEN`. `resolveManagedWorkerScope` requires a `workers[]` entry matching the task's `destinationSession`, and `writeBootstrap` throws `mailbox_bootstrap_credential_unavailable` without one. | Issuing a worker token and storing it is minting a grant. No production path, provisioning script or operations document defines where such a token comes from, so this is a new authority surface. |
| Per-seat mailbox capability | `produceManagedAttempt` requires `mailbox:{43}`. The only minting site is `ChatRepository`, as a side effect of a send. No session, seat, run or task record carries a capability. | Choosing the capability a seat's mailbox authenticates with establishes a new persistent identity, not a lookup. |
| Per-task `outputs` / `permissions` | Caller-supplied to both `admitForLaunch` and `produceManagedAttempt`. `parseAssignment` persists only `{taskId, role, paths, dependencies}`. In the launch path both are read back *out of the context manifest*, so the projection is the only store and cannot itself be produced from the persisted row. | Recording a task's declared outputs and permissions changes the durable task contract and the `task.created` payload. |
| Worker uid/gid | No `src/` code resolves a worker name to a uid. Every occurrence compares a uid it was handed; the value comes from the privileged `--inspect` preflight, which requires an attempt that already exists. | Resolving from the provisioned identity reads the host's worker accounts, which provisioning installs. That is a new host-fact reader, not a launch-path edit. |

The circularity in the fourth row is what makes T047 unimplementable as written: an attempt cannot be produced until its worker's uid is known, and the uid is only observable once an attempt exists. T053 breaks it by reading the provisioned identity directly.

## T053 — supply the managed-attempt production inputs

- **Goal:** make `produceManagedAttempt` reachable from production, with every input sourced from an existing or newly-established owner, so a later T047 can attach what the producer returns.
- **Dependencies:** T042 (the producer and its input contract), T041 (composed launch chain), T036 (health evidence owner, read-only). T053 owns its own wave, 16.5, between T042 in wave 16 and T047 in wave 17, because T047 depends on it. T047 serializes after it on `startup.ts`. T052 runs earlier in Track A, so T053 rebases onto T052's `startup.ts` (see Ordering effect).
- **Files:**
  - `engine/packages/daemon/src/domain/worker-control-access.ts` (new) — worker-token issuance, durable store and lookup by session/run.
  - `engine/packages/daemon/src/domain/seat-mailbox-capability.ts` (new) — the per-seat capability owner.
  - `engine/packages/daemon/src/db/migrations/106_managed_attempt_inputs.ts` (new) — the additive migration for the task outputs/permissions record, the worker-token store and the per-seat capability.
  - `engine/packages/daemon/src/db/all-migrations.ts`
  - `engine/packages/daemon/src/domain/plan-governance.ts` — persist and read the task's declared `outputs`/`permissions`; extend the `task.created` payload.
  - `engine/packages/daemon/src/contracts/team-control.ts` — the additive schema for those fields.
  - `engine/packages/daemon/src/domain/worker-identity.ts` (new) — resolve a provisioned worker name to uid/gid and groups from the installed policy and the host's accounts.
  - `engine/packages/daemon/src/startup.ts` — the composition point: supply `managedAttemptRoots`, the credential owner and the identity reader to the `WorkflowRuntime` built in startup.
  - `engine/packages/daemon/src/index.ts` — wire the worker-credential owner into the `teamControl` options at the process entry.
  - `engine/packages/daemon/test/managed-attempt-inputs.test.ts` (new)
- **Expected side effects:** `tools/upstream-import.mjs`, exact provenance entries only; `docs/operations.md` gains the worker-token and capability provisioning entries.
- **Approach:**
  - **Worker credentials:** issue one token per `(sessionId, runId)` on admission, store only its digest with the session and run, and expose `readCredentials()` over that store. The plaintext is returned once, at issuance, and reaches the mailbox bootstrap through the existing `readCredentials` seam. A token is revoked when its attempt retires and on daemon restart reconciliation, matching T042's endpoint lifetime. Never reuse the owner token; a worker token authenticates nothing but its own attempt's mailbox and its own team-control worker scope.
  - **Mailbox capability:** mint one `mailbox:{43}` per seat at assignment, persist it with the seat's session and run, and hand the same value to the producer and to any later message send for that seat. The value the bootstrap carries must be the value `poll` matches on.
  - **Task outputs/permissions:** extend `task.created` to require both arrays, validate them against the binding and the role's permission vocabulary at creation, and persist them beside the existing assignment. `admitForLaunch` and `produceManagedAttempt` read them from the record; a caller-supplied value that disagrees is refused rather than trusted.
  - **Worker identity:** resolve uid, gid, supplementary groups, home, scratch and tree from the installed worker policy plus the host's account database, and refuse a name absent from either. This replaces the `--inspect` round trip for the producer only; the launcher's own inspection remains the authoritative check at launch.
  - **Composition:** supply `managedAttemptRoots` in the same place `assignmentRoot`/`candidateRoot` are supplied, reading roots from the same installed policy bytes so the producer writes where the launcher will mount.
- **Test scenarios:** (1) in a composed startup, a task admitted through governance yields a produced attempt whose projection, endpoint and bootstrap all exist, with roots taken from the installed policy; (2) a worker token authenticates only its own `(sessionId, runId)` mailbox scope and is refused by every other route and for every other seat; (3) the owner token is never accepted as a worker credential and no secret appears in any recorded command, log or bootstrap beyond the authorization field; (4) a seat's persisted capability is the exact value both the producer's bridge and a later send use, and a message sent with a different capability is invisible to that seat's poll; (5) a task whose persisted outputs/permissions disagree with a caller's is refused, and an output outside the assignment's write paths is refused at creation; (6) worker identity resolves for every identity the policy lists and refuses an unknown name, and the resolved uid/gid matches what the launcher observes at launch; (7) retiring an attempt revokes its token and closes its endpoint, and a daemon-restart reconciliation revokes tokens no live attempt owns; (8) no read introduced here mutates durable state, files, sessions or provider state, and no provider session starts.
- **Done signal:** the composed-startup test produces a real attempt from an admitted assignment, offline, with the privileged launcher faked only at `/usr/bin/sudo`; every scenario above passes; the daemon typecheck passes; one final daemon package run has no task-caused failure; required independent review closes on the final candidate. T053 claims no launch outcome and no installed-client outcome — it makes the producer reachable, not T047's attachment.
- **Stop if:** any of the four inputs turns out to need a provider session, a live client or a change to `worker-launch.mjs` or the installed policy; a credential store would need to hold plaintext tokens at rest; output/permission persistence would change an existing acceptance example; or the task-level budget is reached.
- **Review intent:** required. Check that a worker token cannot act as an owner grant, that the capability is one value with one owner rather than two independently-minted readings, that a refused task leaves no credential and no capability, and that the composition reads roots from the same policy bytes the launcher validates.

## Ordering effect (owner decision, 2026-10-26)

T047 gains T053 as a dependency and keeps its own scope unchanged. T038 still follows T047.

T052 no longer depends on T047. T047-H1 has landed the health-reader composition T052 needed, and T052 reads managed attempts from T042's records, the same way the simplification amendment released T052 from T046. Until T047 lands, no production attempt is attached, so live-attempt evidence reads as unavailable, which T052's evidence table already allows. T052 and T053 both edit `startup.ts`, so they serialize; T052 goes first.

Track A runs in this order: T052 → T054 → T048 → T043 → T053 → T047 → T038. The order puts first the tasks Track B waits on: T015 Phase 2 needs T052, T035 needs T054 and T048, and T017 needs T043. Nothing in Track B waits on T053 or T047. This replaces the order this amendment recorded on 2026-10-25, which predated the simplification amendment and still named the cancelled T049 and the deferred T046.

## Why not the alternatives

- **Widen T047's file list** to absorb all four inputs: this is the whole of T053 plus the attachment in one card, it touches the durable task contract and a new credential store, and its size is what forced the earlier T039, T042 and T044 splits.
- **Narrow T047 to attachment over fixtures:** gives a green card that leaves an admitted assignment unable to reach the privileged launch, which is T047's stated goal and T038's precondition.
- **Let the mailbox bridge mint its own credential:** rejected by T042's own residual R1 — one constant would become a grant to every attempt's mailbox.