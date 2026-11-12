# Multi-Agent

A coding team for your projects. Create a private GitHub repository from a folder,
agree a plan and team with the lead, watch the work, then merge the result into your
local branch. The engine lives in `engine/`.

## Quick start

The shipped target is Windows 10/11 x64 with native Node.js 22 or 24 and Git for
Windows on `PATH`. Install and sign in to Claude Code (`claude`) or Codex (`codex`)
for the clients your team will use. Multi-Agent uses their existing local sign-in.
The engine also runs on Linux with Node.js 22 or 24 and Git.

From a source checkout, build the engine and start the desktop:

```powershell
cd engine
npm ci --no-audit --no-fund
npm run build
cd ../desktop
npm ci --no-audit --no-fund
npm start
```

The desktop owns the native engine process, selects a free loopback port, pairs its
window automatically, and reports missing dependencies on first run. The engine and
workers run as ordinary child processes. See [desktop instructions](desktop/README.md).

Windows state defaults to `%LOCALAPPDATA%\Multi-Agent`; configuration defaults to
`%APPDATA%\Multi-Agent`. The desktop keeps engine state in the `engine` subdirectory
of its data root. Other platforms use `~/.multi-agent`. `MULTI_AGENT_HOME` overrides
both engine roots; `MULTI_AGENT_DESKTOP_DATA_DIR` overrides the desktop root.
Each new installation creates `multi-agent.sqlite`; previous product data is ignored.

For a Linux development setup, `./setup.sh` installs and builds the engine and its
pinned workflow source, installs GitHub CLI when needed, and creates an owner
credential. Run `./scripts/start.sh` to start the engine, then use
`engine/node_modules/.bin/multi-agent --help` for the retained CLI commands.
Agents run as your user in task worktrees with `workers.isolation: none`, the default.
Claude implementers use `bypassPermissions` and can access files outside their task
worktree. Codex implementers use `workspace-write`; reviewers use read-only tools.

## Sign in and create a project

1. Open Multi-Agent. For an optional browser viewer, use **Open browser** in the
   desktop and [pair your browser](docs/operations.md#pair-a-browser).
2. Choose **Sign in to GitHub**, then **Open GitHub**. Enter the displayed one-time
   code on GitHub and approve sign-in. The app checks the account before opening
   your projects; there is no token to paste into the app.
3. Choose **Create project**, select a folder and enter a project name. The desktop
   uses a native folder picker; the browser browses folders on the engine's machine.
4. Choose **Review files**. Check the resolved folder, included file count, excluded
   paths and upload consequence, then choose **Create**.

For a new folder, Create initializes git, adds a default `.gitignore` when absent,
creates the initial commit and a **private** GitHub repository, sets `origin`, and
pushes that commit. The project starts with only its configured lead. Review the
files yourself: credential-path exclusions are not a content-level secret scanner.
Home and drive roots are rejected.

An existing repository with `origin` is registered without creating a remote or
pushing; its existing visibility is unchanged. An existing commit without `origin`
uploads that commit and its reachable history, not uncommitted changes. See
[Create and retry behavior](docs/operations.md#create-and-retry-behavior) before
using an existing repository.

## Plan and deliver

Enter your goal on the new project's start form. For another run, choose **New work**.
Chat with the lead while it drafts the plan and proposes the seats and clients it
needs. **Approve plan** approves the plan and the proposed roster together, including
ordinary implementation files throughout the selected project. Protected paths,
external actions, budget increases and final merge remain separate decisions. The
owner does not manually assemble a team in the UI.

Use the project and run selectors to change context. **Overview** combines progress,
selected-task evidence, agent activity, owner attention and integration history.
**Workspace** shows live seat activity and tool calls. **Tasks** opens a searchable
list beside a persistent inspector with attempts, reports and diffs; **Board** keeps
the dependency-stage view. **Reviews** shows candidate findings. **Analytics** shows
captured native token use for the selected project over 7 or 30 days, not monetary
estimates. Missing counters stay unavailable. **Settings** contains General, GitHub,
Appearance, Sessions and Agents, with model policy and specialist profile settings.

After GitHub sign-in, the same project flow is available from the setup shell:

```bash
multi-agent github status
multi-agent team create /absolute/path/to/project --name project-name --dry-run
multi-agent team create /absolute/path/to/project --name project-name
multi-agent team start "Describe the change you want" --planning --rig <team-name>
multi-agent team chat <run-id>
multi-agent team chat <run-id> "Your answers and requested changes"
multi-agent team approve-plan <run-id>
```

Review the preview before confirming Create. Use the team name printed by Create and
the run id printed by Start. `--rig` may be omitted when there is exactly one team.
Planning defaults to project-wide implementation after approval. Use
`--write <path...>` to narrow that grant; a direct, non-planning CLI Start still
defaults to `src`. See [operations](docs/operations.md#plan-and-deliver).

## Workflows and specialist identities

The **Workflow** selector on New work and lead chat exposes all 38 catalog entries.
Leave it on **Automatic** for ordinary delegation, or select a workflow to request
from the Lead. Initial selections wait for execution approval during planning and
remain visible to the Lead until assigned to a worker. A run without a Lead dispatches
the selection directly to its worker. Caller-only helpers are listed
but not offered as direct owner commands. Results appear under **Workflow outcomes**
in chat; they are distinct from task validation, independent review and acceptance.

```bash
multi-agent team start "Inspect the current architecture" --workflow spec-pov --read-only
multi-agent team chat <run-id> $'/spec-handoff --read-only\nSummarize the current task.'
```

In **Settings → Agents → Specialist profiles**, edit a SOUL, create a specialist or
assign a compatible profile to an idle seat. Seven defaults cover coordination,
engineering, architecture, frontend, backend, verification and independent review.
The lead selects profiles and the team size within the approved limits. Permission
role, specialist identity and client/model remain separate choices.

Profile edits create new versions. New attempts use the current version; exact
resumes keep their recorded profile. A SOUL guides expertise and working style,
not permissions, and is not shared personal memory. See the
[workflow and profile guide](docs/operations.md#workflows-and-specialist-profiles)
for source installation, provenance and capability limits.

## Resume and merge

The daemon records outcomes, starts reviews and commits approved work to `team/…`.
Workers bring blockers to the lead first. Answer an escalation in the chat when a
person is needed; there is no manual task-completion step.

If a run is blocked, resolve the displayed reason and choose **Resume**, or run:

```bash
multi-agent team resume <run-id>
```

Time and retry budget blocks need an increase; the UI states any increase before
resuming. CLI budget options are described in
[operations](docs/operations.md#resume-a-blocked-run).

When work is ready, inspect its task diffs and the integration history on Overview,
then choose **Merge**, or run:

```bash
multi-agent team merge <run-id>
```

Merge updates the currently checked-out branch in the project's repository. Keep
that checkout clean. It fast-forwards when possible, otherwise creates a merge
commit; a conflict is reported without leaving a half-merged checkout. **Merge does
not push to GitHub.** Create's initial upload is the engine's only push.

The [operations guide](docs/operations.md) covers sign-in, Create, recovery and
verification. The [earlier delivery acceptance record](docs/validation/2026-11-06-autonomous-team/README.md)
preserves the pre-command-center delivery and restart evidence and its subsequent fixes.
The [command-center acceptance evidence](docs/validation/2026-11-07-command-center/acceptance.json)
records the isolated live checks and the still-open desktop and runtime limitations.
