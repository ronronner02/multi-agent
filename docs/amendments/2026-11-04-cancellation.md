# 2026-11-04: The owner's cancel stops the work

**Decided by:** the implementer for the cancellation half of T017, under the standing grants in
`AGENTS.md` and decision 4 of the 2026-11-02 MVP scope amendment.

This records the decisions the slice's brief left to the code. It sits beside C2 (the review
loop) and C3 (the lead) and changes no requirement.

## Why

`POST /runs/:runId/cancel` recorded `cancel_requested` and stopped there. Measured on a live
unisolated run before this slice, with a stub client idling in its seat's pane:

- the cancel returned `202 pending-execution` and the run read `cancel_requested`;
- the client process was still alive five seconds later, in the same pane, under the same pid;
- the attempt stayed `running`, so the completion sweep never observed an end;
- the task stayed `pending`, and a dispatch call still reached the composed dispatch path;
- no code path could ever record the observation, so the run could not leave
  `cancel_requested` at all — not by finishing, not by anything else.

The command's own reason said "Termination has not been observed", and nothing ever observed it.

## Decisions

1. **The intent and the observation are two commands, and the route runs both.** `cancelRun`
   stays exactly what it was — the owner's durable request, closed to dispatch from the moment
   it commits. A new `observeCancellation` records that the stop was seen, and only it can move
   the run to `canceled`. The route calls them in that order: record the intent, end the
   processes this run launched, record the observation. A crash between the two leaves a run
   that refuses new work, never one that quietly keeps admitting it.
2. **Dispatch closure needs no second gate.** Every command that admits work — a task, a
   native launch intent, an attempt, a growth decision — already refuses unless the run is
   `approved`. `cancel_requested` and `canceled` are both outside that, so a C1 growth task, a
   C2 review task, a rework and a direct launch are all refused by the check that already
   existed. The slice adds no parallel allow-list that could drift from it.
3. **Only what the run recorded is signalled, and only while it is still that process.** The
   target is the `processId` *and* `processStart` a launch receipt already recorded in
   `team_attempts`. A pid whose start tick moved is a different process and is never signalled;
   neither is one whose group it does not lead. The signal goes to the process group the client
   leads — tmux starts a pane's foreground process in a new session — so the client and anything
   it spawned end together while the tmux server, the daemon and every other seat stay out of
   reach. This is why the group is signalled rather than the pid: a client that spawns a tool
   would otherwise leave the tool running after the agent is gone.
4. **SIGTERM, then SIGKILL after five seconds, and `unresolved` at fifteen.** A client that
   exits on SIGTERM is `stopped`; one that survives the grace is killed; one still alive at the
   limit is reported as unresolved, and the run stays `cancel_requested` naming the attempt. The
   receipt carries the escalation and how long the wait took, so the owner sees a slow stop
   rather than a silent one.
5. **The observation is the completion sweep's, not a second writer.** An attempt whose process
   is gone is recorded stopped by `attempt-completion.ts` — the same write a client that
   finished on its own produces. The cancellation waits a bounded moment for the sweep, then
   asks governance to close the run. So there is one answer to "did this attempt end", and the
   cancel cannot disagree with the completion path about it.
6. **`canceled` is a run state, and closing a run closes its tasks.** The state is new; the
   queue's `canceled` is not, so a closed task is written through the transition the rework path
   already uses, with its transition log and dependency gate intact. A task that already reached
   a terminal outcome keeps it: a candidate the owner accepted is still accepted.
7. **Nothing is deleted.** The candidate tree, the attempts and the evidence stay exactly as
   they were. The result route serves a `canceled` task's patch (it already accepted that state
   as finished), so `rig team diff` and `rig team apply` still read a canceled run's work. The
   demo proves it by reading the manifest and the uncommitted change after the cancel.
8. **The clients report what the daemon observed.** `rig team cancel <run-id>` is new, and the
   Web UI's existing Stop dialog now shows the receipt's own outcome: `observed` once the run is
   `canceled`, or the count of attempts still alive. Neither invents a result.

## Residuals

- **Cancellation is composed only under `workers.isolation: none`.** Under hardened isolation a
  client is launched by the privileged launcher under a policy this daemon does not own, and
  T038 is parked; the intent-only command is unchanged there. This is the slice's stated scope,
  not an oversight.
- **The daemon's own restart is not a cancel.** A run left in `cancel_requested` by a restart is
  observed by the next sweep and closed on the next cancel request; nothing scans for such runs
  at boot. A boot sweep would be the next step if a restart mid-cancel turns out to matter.
- **A group whose leader exited but whose children live is reported `not-running`.** The
  identity is the leader, so once it is gone the daemon has no recorded identity to aim at. It
  does not scan for orphans: guessing at a process tree the run did not record is exactly the
  signal-against-an-unowned-identity the contract forbids. In practice the group signal reaches
  the children in the same call that ends the leader.
- **An attempt with no recorded identity is left to reconciliation.** A launch that never
  produced a receipt has nothing this module can safely signal, so the run reports it unresolved
  instead of guessing.
- Out of scope by the brief and not built here: the hardened launcher, `engine/config/isolation/*`,
  the cumulative 60-minute budget outside the daemon, the no-progress detector, and log caps.
