# 2026-11-04: The completion path

**Decided by:** the implementer for the completion-path slice, under the standing grants in
`AGENTS.md` and the 2026-11-02 MVP scope amendment.

This records the decisions the slice's brief left to the code. It sits between C2 (the review
loop) and C3 (the lead), and it changes no requirement.

## Why

C2's loop starts on `evidence.validated === true` recorded through `tasks/outcome`. That command
needs an owner actor, a stopped attempt with an identity, and non-empty evidence — and on `main`
nothing produced either. A direct launch recorded a receipt and no attempt row; no production
code ever marked an attempt `stopped`; and no client called `tasks/outcome`. A live run therefore
started agents and could never complete a task, which C3 and C4 both depend on.

## Decisions

1. **The receipt is the attempt's admission, and the process end is its stop.** The attempt owner
   admits an attempt from each `managed.attempt.receipt` through the existing `recordAttempt`
   command, and records it stopped through the existing `recordUsage` command when
   `/proc/<pid>/stat` no longer shows the identity's process. No second writer, no new control
   command, and no new event type: both writes are the ones the demos and tests already used.
2. **The daemon computes the evidence; the owner supplies only the decision.** The evidence is
   the candidate's own manifest digest, the paths its own patch moves, and whether those paths
   are inside the assignment. `validated` is derived from those checks and is never a caller's
   claim. This is R18 read literally: an ended attempt or an existing candidate accepts nothing.
3. **The owner action is one read plus the existing write.** `GET .../completion` publishes the
   attempt, the blockers and the evidence; `POST .../tasks/outcome` is unchanged. The CLI
   (`rig team done`) and the Web UI's completion panel are two clients of those two calls, so
   they cannot disagree.
4. **No agent-facing contract.** Agents cannot complete, accept or fail a task, and no agent
   credential or agent-callable endpoint was added. The brief's stop condition on a new
   agent-facing contract therefore does not apply.
5. **A tmux pane id belongs to the seat that created it.** A pane id is unique only within one
   tmux server's lifetime, and a server whose last client exits is gone; the next server numbers
   from `%0` again. A dead seat's binding then named the new seat's pane, the delivery guard's
   target lookup found two nodes, and the launch that opened the pane was refused. The binding
   for a pane this daemon just created is now written only to the seat that created it, which
   releases any stale claim on that id first. This is a defect the completion path's own demo
   exposed; it is not hardening, and it has a reachable scenario in the demo.
6. **An attempt that ended releases its seat.** `startup_status: ready` is what tells the
   dispatcher "this seat already has an agent", and it stays true only while one runs. The
   attempt-end observation therefore puts the seat's session back to `pending` — the existing
   status write a start leaves a never-launched seat in, no new state — so the rework dispatch
   and the reviewer's second round start a fresh client instead of seeing a live one that is
   gone. The demo no longer resets the seat by hand, which is what proved the fact was missing.
7. **The sweep reads only what is new.** Receipts are append-only and registration is
   idempotent, so the sweep keeps the highest `seq` it has read and queries `seq > ?`. The first
   sweep after a restart reads the log once; every later tick reads only what arrived. A receipt
   that was skipped because its seat had no single live task is not retried: the owner action
   refuses that task by name, so repeating the refusal would cost more the longer the daemon ran
   and tell nobody anything new.
8. **`team-workspace.ts` and credential code are unchanged.** The evidence reuses
   `candidateManifestFor`, the reader `rig team apply` already goes through.

## Residuals

- `tasks/outcome` still accepts `validated` exactly as the caller sends it. Only an owner can
  call it, so this is acceptable for the MVP; a daemon-side re-derivation at the write would be
  the next step if the surface ever widens.
- A receipt is admitted only when its run and seat resolve to exactly one live task. A second
  task on the same seat leaves the receipt unrecorded rather than guessing, and the owner action
  refuses that task with a named reason.
- The candidate's scope check still runs on the read the owner action performs, because it runs
  inside `candidateManifest`. That is the same call `rig team apply` makes, so a candidate whose
  edits need a scope extension raises that extension at completion time.
