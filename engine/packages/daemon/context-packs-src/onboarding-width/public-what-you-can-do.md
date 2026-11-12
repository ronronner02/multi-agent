# What you can do here

This pack describes the native Multi-Agent command surface. Read the installed CLI help before acting; a packaged guide can explain a workflow, but the daemon and CLI own the current request and response shapes.

## Finding out what is actually true right now

- **`multi-agent --help`** — the supported top-level commands: `team`, `daemon`, and `github`.
- **`multi-agent team --help`** — the owner actions for creating a project, starting a run, reading its conversation, approving a plan, and inspecting its result.
- **`multi-agent daemon --help`** — start, stop, and inspect the local engine.
- **`multi-agent github --help`** — sign in and inspect the GitHub connection used by the team flow.
- **The Web UI at `/team`** — the same owner view over the authenticated team-control API.

The durable run result and diff are the authority for work that has finished. A terminal transcript is useful evidence, but it does not replace the task result.

## Starting and reviewing a team run

1. Register or create a project with `multi-agent team create <repository>`. The command can print a dry-run preview before any GitHub action.
2. Start a task with `multi-agent team start "<goal>"`. Name the repository and write paths when the run needs a narrower boundary.
3. For a planning run, read the lead's conversation with `multi-agent team chat <run-id>`, then approve it with `multi-agent team approve <run-id>` only after the owner agrees.
4. Read `multi-agent team result <run-id>` and `multi-agent team diff <run-id>` before review or delivery. The result records the candidate files, base, and patch.
5. Merge only through `multi-agent team merge <run-id>` after the result and review evidence match the accepted goal.

The daemon launches the configured native workers and records their progress. The owner remains the decision maker for planning, permissions, and delivery.

## Making work outlive you

A task survives a turn when its goal, acceptance evidence, and current result are written to the team run and repository artifacts. Use team chat for a concise decision or progress update; use the result and diff endpoints for durable evidence. Do not create a second handoff protocol in an ad-hoc file or terminal transcript.

When a provider or dependency blocks progress, report the observed error and one decision needed from the owner. A message can ask for that decision; only the resulting team action changes the run.

## When something is broken

- If the daemon is stopped, run `multi-agent daemon start` and then `multi-agent daemon status`.
- If a run cannot start, read the returned error code and inspect the repository, configured worker client, and owner credential before retrying.
- If a task appears complete but its result is missing, wait for the daemon's run state and read the task result again; do not infer completion from a worker's last message.
- If GitHub access fails, run `multi-agent github status` and repeat sign-in only after the failure explains which credential or repository decision is missing.
- If the UI is unavailable, use the CLI team commands against the same local daemon; they share the same owner session and run state.

## Tracking what is being built

The task goal, plan, implementation report, review evidence, and final diff form one chain. Keep the plan and repository-relative files named by the run. Record the exact verification command and its complete output before claiming success.

The bundled skills provide progressive guidance for this chain:

- `orchestration-team` for leads coordinating implementation, review, approval, and delivery;
- `development-team` for implementation work and evidence;
- `review-team` for independent review;
- `requirements-writer` for a clear acceptance contract;
- `agent-operated-software` for a legible control loop;
- `agent-operated-workflows` for bounded procedures; and
- `verification-before-completion` for evidence before a completion claim.

## Data and configuration

On Windows, mutable state lives under `%LOCALAPPDATA%\Multi-Agent` and configuration under `%APPDATA%\Multi-Agent`. On other platforms both default to `~/.multi-agent`. Set `MULTI_AGENT_HOME` for an explicit test or isolated run. The daemon database is `multi-agent.sqlite`.

The desktop passes its engine data root to the child daemon. It does not read legacy product directories or legacy environment names.
