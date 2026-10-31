# Multi-Agent

A team of coding agents, defined in YAML and run as one managed system. The engine
lives in `engine/`; it builds on OpenRig and adds owner-governed team runs.

## Quick start

Requires Linux or WSL2, with `git`, `tmux`, and Node.js 22 or 24.

```bash
git clone https://github.com/ronronner02/multi-agent.git && cd multi-agent
./setup.sh                                  # install, build, create the owner token
export PATH="$PWD/engine/node_modules/.bin:$PATH"
./scripts/start.sh                          # start the daemon in managed mode
rig tui                                     # open the dashboard
```

Agents run as your own user; no `sudo` and no system provisioning.

## Start team work

Create the demo team rig once, then give the team a goal:

```bash
cd engine
npx tsx demo/team/scripts/start-team-demo.ts   # creates rig "team-demo"
rig team start "Say hello from the demo team"
```

`rig team start` creates a run, gets the plan approved for you, and puts a task on the
rig's implementer seat. It prints the run id. Watch it in a browser at
`http://127.0.0.1:7433/team?run=<run-id>`, after `rig config set ui.enabled true` and a
daemon restart.

The Web UI has the same action as a "New task" form, and lists the runs that exist so
you never have to type an id.

To watch the whole flow without a provider account or a live token, `bash
engine/demo/team/run.sh` boots a daemon with the stub runner and starts a run end to end.
