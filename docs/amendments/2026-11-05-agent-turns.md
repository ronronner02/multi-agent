# 2026-11-05: An attempt is one headless turn

**Decided by:** the owner on 2026-11-04, recorded by the implementer of this slice under the
standing grants in `AGENTS.md` and decision 4 of the 2026-11-02 MVP scope amendment.

This records what the slice's brief left to the code, and changes no requirement.

## Why

The first live acceptance run showed that no task could complete. The managed launch started
the client **interactively** and the startup orchestrator typed the task prompt into it. A
finished agent then waited at its prompt and never exited, so:

- the completion sweep never saw the process end and the attempt never became `stopped`;
- the owner's outcome action was refused, because it requires a stopped attempt;
- T033 never classified anything, because it classifies the stop;
- the run's session slots never freed, because a live attempt is what occupies one.

The stub demos hid this: the stub was killed by the demo, so its process always ended.

A second gap the same run hit: a task admitted while the run was at `limits.maxSessions` was
refused once by the launch and never dispatched again. Nothing started a pending task later.

## Measured before deciding

All measurements were on the installed Linux build, Claude Code 2.1.296
(`/opt/multi-agent/toolchain/clients/bin/claude`), in a real tmux 3.6 pane:

- **`-p` ends the process.** One turn, then exit 0. An interactive client never exits.
- **`--output-format text` prints nothing until the turn ends** — neither assistant prose nor
  tool activity. It is not watchable.
- **`--output-format stream-json` requires `--verbose`** and streams live, but every line is a
  JSON event object.
- **A provider failure is printed as the result.** `API Error: 422 model not found: …` arrives
  as the `result` field of a `{"type":"result","is_error":true}` line, and the process exits 1.
  That line is what T033's fingerprints read.
- **`--session-id <uuid>` then `--resume <uuid>` continues the same conversation.** Measured by
  writing a value in the first turn and reading it back in the second.
- **`-p` skips the workspace-trust dialog**, which is why the interactive "continue after trust"
  path cannot occur on a turn.
- **`exec` keeps the pane's pid.** `tmux #{pane_pid}` is the same pid before and after
  `cd <tree> && exec …`, and a dead pane keeps `#{pane_dead}=1` and its exit status.
- **A pane whose client never started still names the shell.** With the client missing, the pane
  dies with status 127 and the shell's own error line.

## Decisions

1. **One attempt is one headless turn, for Claude Code.** The managed attempt's command is
   `claude -p --permission-mode bypassPermissions [--model] [--effort]
   (--session-id <id> | --resume <id>) --output-format stream-json --verbose`. The process exits
   when the turn ends, which is what makes completion, slot release and T033's exit
   classification work at all. Codex is unchanged and stays interactive: it is a residual of
   this slice, not an oversight.
2. **The prompt is a file on stdin, not a shell line.** The daemon writes the turn's text to
   the attempt's mutable state (`<worker scratch>/turns/<attemptId>.prompt`, mode 0600) before
   the launch and feeds it with `exec … < <path>`. The text is long and multi-line, so putting
   it on the command line would be a quoting hazard and a length limit. It is not written into
   the candidate tree, because the tree is the deliverable and the completion evidence counts
   every path that moved.
3. **A small formatter gives the pane a readable view.** `stream-json` is the only mode that
   streams, and raw JSON is not watchable. The shipped `assets/agent-turn-view.mjs` starts the
   client, turns each event into the line a person would have read (assistant text, a `[tool]`
   line, a retried provider error, the turn's own result) and exits with the client's status,
   re-raising a signal so the pane still records "signalled". The pane `exec`s the formatter, so
   the pane's exit status is still the turn's own — which is what T033 reads.
4. **Readiness is the process, not a composer.** A turn has no composer to probe, and a turn
   that has already ended is a valid fast turn, not a launch failure. Readiness is: the pane is
   dead (its exit status is the evidence), or a non-shell process is its foreground command. The
   identity is read **before** the line is submitted, because a fast turn can end before the
   launch looks; `exec` keeps the pid, so the identity is the same either way.
5. **A gate is still a gate.** The screen probe is still read, and a positive gate — a bypass
   consent prompt, a refused login, an MCP approval, a resume it cannot honour — still fails
   readiness. Everything else is the turn doing its work.
6. **Nothing is typed after readiness for a headless attempt.** The post-readiness
   `deliverInitialSessionPrompt` path is skipped for a turn; its text is already in the prompt
   file. The interactive path is unchanged for every other launch.
7. **A freed slot dispatches the run's next task.** The completion sweep calls a new internal
   owner after it records a stop and releases the seat. That owner reads the run's durable
   queue, refuses a run that is not `approved` (the same gate every admitting command already
   reads, so cancellation's closure holds), and dispatches while the run's live sessions leave
   room. It adds no owner verb, no event and no second queue.
8. **A task is started only if nobody is working it and nothing is waiting to be recorded.** A
   task with a live attempt is skipped, and so is one whose last attempt ended while its queue
   row has not moved since: that agent finished a turn and the owner has not recorded the
   outcome, so restarting would spend a second attempt on work that may be done. A task a
   completion **reopened** is dispatched — that is the rework and the lead revision.
9. **The slot limit is asked before the client starts.** The governance gate that enforces
   `maxSessions` runs when the launch's receipt is registered, a second after the client is
   already running; a refusal there leaves an attempt nothing observes ending. The dispatcher
   now asks the same limit first, from the run's own rows and binding.
10. **A rework resumes the implementer's conversation.** The dispatch hands the launcher the
    seat's recorded native session (`continueSessionId`), so the next attempt opens `--resume`
    on it rather than a fresh `--session-id`. `resumeToken` keeps its meaning — the exact
    native identity a restore re-enters — and a `resume_safe: false` failure still clears the
    token first, so a poisoned conversation is never continued.
11. **The rework's prompt carries the reviewer's blocking findings.** They are read from the
    `review.verdict` event that reopened the task, which is the run's own durable record of the
    round; nothing is copied into a second store. Only P0/P1 findings with a citation are
    listed, because those are the ones the loop exists to close.
12. **A rejected lead proposal reopens the lead with the owner's reason.** The decision accepts
    an optional `reason`, records it on the `approval.decided` event, reopens the lead task
    through the transition the rework path already uses, and reports `revisionTaskId` so the
    route dispatches it. The lead's next attempt resumes its conversation and its prompt states
    that the proposal was rejected and why. No new public verb was needed: the existing decision
    request carries the reason as an optional field, and the existing dispatch starts the task.
13. **The rejection reason is owner prose that reaches an agent's prompt.** It is therefore a
    real boundary: bounded to 4 KiB, and refused rather than truncated when it does not fit.

## Surfaces

- No new route, verb or event. `rig team proposal <run-id> <task-id> --decide rejected` gains an
  optional reason through the same `approvals/decide` request the Web UI uses; the CLI and the
  decision dialog are unchanged by this slice.
- The owner watches a turn in the seat's pane and cannot type into it while it runs. That is the
  trade the owner accepted when choosing turns over sessions.

## Residuals

- **Codex is still interactive.** It starts as before, so a Codex attempt still cannot complete
  on its own. The slice is Claude Code only, as the brief scoped it.
- **`rig team continue` refuses a managed attempt.** A turn has no staged prompt to continue and
  `-p` skips the trust dialog, so the route answers `continuation_unavailable`. The owner's
  answer to a gate is to clear it and start the task again, which is a new attempt on the same
  tree. The route itself is unchanged for every other launch.
- **The formatter is a wrapper, not a second client.** It forwards stdin, inherits stderr and
  exits with the client's status, but it is still a process between the client and the pane. A
  signal it receives is re-raised on itself, which preserves the pane's "signalled" record;
  a client killed inside the wrapper reports that status as the wrapper's exit code.
- **A turn's cost is not capped.** `--max-budget-usd` was measured but is not passed: the run's
  own active-time limit is the only budget this slice enforces, as before.
- **`pendingTasks` reads the newest queue transition's note** to tell a reopened task from one
  whose outcome is pending. That note is written by the queue's own reopen path, so the two
  cannot drift, but a future transition that reuses the same wording would be read the same way.
