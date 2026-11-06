# Multi-Agent

A coding team for your repository. Agree a plan with the lead, let the team implement
and review it, then merge the result into your branch. The engine lives in `engine/`.

## Quick start

Requires Linux or WSL2, with `git`, `tmux`, and a Linux installation of Node.js 22 or 24
on `PATH`. Install and sign in to the clients you want your seats to use: Claude Code
(`claude`) or Codex (`codex`). The team uses your local client configuration.

On Windows, install `Multi-Agent Setup.exe` instead and open it from the Start menu: the
desktop app sets up WSL, the engine and the Web UI for you
([desktop instructions](desktop/README.md)). The clients run inside WSL too.

```bash
git clone https://github.com/ronronner02/multi-agent.git
cd multi-agent
./setup.sh
export PATH="$PWD/engine/node_modules/.bin:$PATH"
rig config set ui.enabled true
./scripts/start.sh
```

Setup installs and builds the engine and creates your owner credential. Agents run as
your user in task worktrees with `workers.isolation: none`, the default.

## Create a team and start work

Open [the Web UI](http://127.0.0.1:7433/team) and
[pair your browser](docs/operations.md#pair-a-browser). In **Teams → New team**, choose
your repository and the clients for its seats. The repository must have at least one
commit. It does not need a plan file or a seed script.

Choose **New work** and enter your goal. A team with a lead starts in planning: chat
with the lead, settle its questions, and choose **Approve plan**. The lead then assigns
the work, the implementers deliver it, and the reviewer checks each candidate.

You can do the same work from the terminal, using the shell from setup:

```bash
rig team create /absolute/path/to/your-repository
rig team start "Describe the change you want in your repository" --planning
```

The default team has a Claude Code lead, one Claude Code implementer, one Codex
implementer, and a Claude Code reviewer. To choose clients, use `--lead`,
`--implementers` (comma separated), and `--reviewer` on `rig team create`. If you have
more than one team, add `--rig <team-name>` to `rig team start`, using the name printed
by create. Keep `--planning` on the CLI start to agree a new plan first.
The default delivery scope is `src`; use `--write <path...>` on the CLI start when
the work belongs elsewhere, as described in [operations](docs/operations.md#plan-and-deliver).

Start prints the run id. Use it in the following commands:

```bash
rig team chat <run-id>
rig team chat <run-id> "Your answers and any changes to the plan"
rig team approve-plan <run-id>
```

## Resume and merge

Watch the lead chat and task list in the run view. Open a task for its attempts, review
and diff, or open **Commits** for the integration branch. The daemon records outcomes,
starts reviews and commits approved work to `team/…`. Answer any escalation in the chat.

If a run is blocked, resolve the reason shown and choose **Resume** in its plate, or run:

```bash
rig team resume <run-id>
```

Time and retry budget blocks need an increase; the UI states any increase before
resuming. CLI budget options are described in
[operations](docs/operations.md#resume-a-blocked-run).

When the work is ready, review the commits and choose **Merge**, or run:

```bash
rig team merge <run-id>
```

Merge writes to the currently checked-out branch in the repository you created the
team for. Keep that checkout clean. It fast-forwards when possible, otherwise creates
a merge commit; a conflict is reported without leaving a half-merged checkout.

The [operations guide](docs/operations.md) covers setup, recovery and verification.
The [live acceptance record](docs/validation/2026-11-06-autonomous-team/README.md)
contains the two delivered commits, the restart evidence, and the defects and their
subsequent fixes.
