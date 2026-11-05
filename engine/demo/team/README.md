# Demo team rig

A small rig for trying the managed team flow on a fresh machine. It is what
`rig team start "<goal>"` needs in order to have somewhere to put a task.

- `rig.yaml` — one pod, one implementer seat, cwd `.`
- `culture.md` — the rig-wide guidance every seat reads
- `scripts/start-team-demo.ts` — creates the rig and registers the seat through the same
  `createTeam` the `rig team create` verb uses, so the demo needs no live agent process

## What it is for

`rig up` boots real agents. The MVP demo wants the *managed* half instead: a run,
a plan approval and a task that a worker can pick up. `start-team-demo.ts` writes
exactly the rows `rig up` would write for a one-seat rig — a rig, its node and the
node's session — and stops there. Nothing launches, so seeding needs no provider
account or a live token.

## Run it

From `engine/`, after `./setup.sh` and `./scripts/start.sh`:

```bash
npx tsx demo/team/scripts/start-team-demo.ts     # creates rig "team-demo"
rig team start "Say hello from the demo team"
```

`rig team start` prints the run id and the Web UI command that watches it, and it
starts the agent: the seat has no terminal yet, so the daemon opens one for it and
launches the client into it. There is no step between the start and the launch.
The task's repository is the rig's seat cwd, so the plan artifact it approves is
`plan.md` at that path; `demo/team/` carries one for the demo.

## Create a team for your own repository

`rig team create <repository>` is the product path; the demo seed above only exists so the
demo repository has a team without an extra command.

```bash
rig team create ~/src/my-project
rig team start "Add a health endpoint" --rig my-project
```

It records a lead, two implementers and a reviewer for that repository and prints the next
command. `--lead`, `--implementers` and `--reviewer` choose the clients, where `claude` is
shorthand for `claude-code`.

`bash demo/team/scripts/create-team-demo.sh` proves this without a provider account: it
creates a team for a scratch repository with the compiled CLI against a managed daemon, starts
a run on it, and waits for the daemon to launch the stub runner into the seat's terminal.
