# Project planning, model policy and retained records

The owner selected three desktop repairs: project-first planning chat, enforceable model configuration, and visible persistent records. This slice does not add group-chat orchestration, a knowledge base, or the remaining reference dashboard features.

## Decisions

- Compose the existing planning-run and lead-chat lifecycle. Opening a project conversation has no launch side effect. Its first sent message starts a planning record and is stored in the existing chat table. Only an internal lead planning task exists until explicit plan-and-roster approval; it is not an execution task.
- During installed-desktop acceptance, approval while a planning revision was running committed the previous plan and misclassified the final planning turn as delivery. Approval now waits for active or admitted lead turns and queued owner messages before recording the plan or changing phase.
- Keep project navigation available without a selected run. Show planning, execution and recorded results separately, with honest empty and failed-read states. Results require recorded integration evidence, not a run name or an approved bootstrap binding.
- Project classification is explicit owner metadata (project or test), never inferred from names. Existing isolated acceptance databases remain separate; they are not silently merged into the desktop database or presented as current work.
- Extend the existing team setup owner with project model settings. Lead runtime/model remain authoritative in the lead node. A rig stores its allowed subagent client/model pairs. An unset legacy policy is visibly unconfigured, not presented as enforced. A saved empty allowlist permits planning only.
- Require exact explicit model IDs when saving a policy. Apply the policy to proposed rosters and at the managed direct launch boundary, including continuations. Save changes atomically and report active attempts rather than silently restarting them. A native model observation is distinct from a requested launch model; missing observations remain unknown.
- Reuse existing run, queue, chat, integration and telemetry owners. No new conversation store or copied historical execution records. No new dependency.

## Card surface scope addition

The owner requested transparent glass cards and removal of the overview header's leftover skin. Shared card styles now reveal the existing page background, with theme-specific translucent fills, an 8 px backdrop blur, subtle borders and fully opaque text. Inputs, diffs and overlay panels keep their reading surfaces; nested cards do not add another glass layer. No new assets, dependencies or motion. The shared design-token document records this superseding card treatment.

## Verification and delivery boundary

Focused regression tests cover project chat before execution, initial-message persistence, section-specific empty states, saved model policy, roster rejection and launch enforcement. Run touched package typechecks and the engine smoke suite. Then verify the installed desktop entry, reopen the same records after restart, and retain the old installation/profile and a database backup for rollback.

Work stays in the selected acceptance worktree. Preserve its pre-existing edits using the pre-change snapshot. No commit, push, merge or unrelated service change is authorized by this slice. A source or component test pass is not desktop acceptance.
