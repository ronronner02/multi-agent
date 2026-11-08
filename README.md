# Multi-Agent

A coding team for your projects. Create a private GitHub repository from a folder,
agree a plan and team with the lead, watch the work, then merge the result into your
local branch. The engine lives in `engine/`.

## Quick start

Requires Linux or WSL2, with `git`, `tmux`, and a Linux installation of Node.js 22 or 24
on `PATH`. Install and sign in to the clients you want the team to use: Claude Code
(`claude`) or Codex (`codex`). The team uses your local client configuration.

On Windows, install the Windows desktop installer and open Multi-Agent from the
Start menu. It sets up WSL, the engine and the Web UI, and handles local pairing
automatically. Later launches reuse the saved engine repository path
([desktop instructions](desktop/README.md)). The clients run inside WSL too.

```bash
git clone https://github.com/ronronner02/multi-agent.git
cd multi-agent
./setup.sh
export PATH="$PWD/engine/node_modules/.bin:$PATH"
rig config set ui.enabled true
./scripts/start.sh
```

Setup installs and builds the engine, makes GitHub CLI available, and creates your
owner credential. Agents run as your user in task worktrees with
`workers.isolation: none`, the default.

## Sign in and create a project

1. Open [the Web UI](http://127.0.0.1:7433/team) and
   [pair your browser](docs/operations.md#pair-a-browser). The desktop app pairs itself.
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
needs. **Approve plan** approves the plan and the proposed roster together; the
owner does not manually assemble a team in the UI.

Use the project and run selectors to change context. **Overview** combines progress,
selected-task evidence, agent activity, owner attention and integration history.
**Workspace** shows live seat activity and tool calls. **Tasks** opens a searchable
list beside a persistent inspector with attempts, reports and diffs; **Board** keeps
the dependency-stage view. **Reviews** shows candidate findings. **Analytics** shows
captured native token use for the selected project over 7 or 30 days, not monetary
estimates. Missing counters stay unavailable. **Settings** contains General, GitHub,
Appearance, Sessions and the read-only Agents view.

After GitHub sign-in, the same project flow is available from the setup shell:

```bash
rig github status
rig team create /absolute/path/to/project --name project-name --dry-run
rig team create /absolute/path/to/project --name project-name
rig team start "Describe the change you want" --planning --rig <team-name>
rig team chat <run-id>
rig team chat <run-id> "Your answers and requested changes"
rig team approve-plan <run-id>
```

Review the preview before confirming Create. Use the team name printed by Create and
the run id printed by Start. `--rig` may be omitted when there is exactly one team.
The default delivery scope is `src`; use `--write <path...>` on CLI Start for another
scope, as described in [operations](docs/operations.md#plan-and-deliver).

## Resume and merge

The daemon records outcomes, starts reviews and commits approved work to `team/…`.
Workers bring blockers to the lead first. Answer an escalation in the chat when a
person is needed; there is no manual task-completion step.

If a run is blocked, resolve the displayed reason and choose **Resume**, or run:

```bash
rig team resume <run-id>
```

Time and retry budget blocks need an increase; the UI states any increase before
resuming. CLI budget options are described in
[operations](docs/operations.md#resume-a-blocked-run).

When work is ready, inspect its task diffs and the integration history on Overview,
then choose **Merge**, or run:

```bash
rig team merge <run-id>
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
