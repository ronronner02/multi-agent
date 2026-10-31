# Demo team rig

A small rig for trying the managed team flow on a fresh machine. It is what
`rig team start "<goal>"` needs in order to have somewhere to put a task.

- `rig.yaml` — one pod, one implementer seat (`dev-impl@team-demo`), cwd `.`
- `culture.md` — the rig-wide guidance every seat reads
- `scripts/start-team-demo.ts` — creates the rig and registers the seat, so the
  demo needs no live agent process

## What it is for

`rig up` boots real agents. The MVP demo wants the *managed* half instead: a run,
a plan approval and a task that a worker can pick up. `start-team-demo.ts` writes
exactly the rows `rig up` would write for a one-seat rig — a rig, its node and the
node's session — and stops there. Nothing launches, so nothing needs a provider
account or a live token.

## Run it

From `engine/`, after `./setup.sh` and `./scripts/start.sh`:

```bash
npx tsx demo/team/scripts/start-team-demo.ts     # creates rig "team-demo"
rig team start "Say hello from the demo team"
```

`rig team start` prints the run id and the TUI and Web commands that watch it.
The task's repository is the rig's seat cwd, so the plan artifact it approves is
`plan.md` at that path; `demo/team/` carries one for the demo.
