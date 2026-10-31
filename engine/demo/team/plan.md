# Demo Team Plan

The plan artifact a started run is approved against. `rig team start` hashes these
exact bytes, so editing this file changes the binding and a run started before the
edit is invalidated by the governance owner.

## Goal

Demonstrate the managed team flow end to end on a fresh machine: a run, an owner
approval, and one task on an implementer seat.

## Work

1. The seat reads the goal it was given and does it.
2. The result is the tree under `src/` in the task's candidate worktree.

## Out of scope

Anything outside `src/`. The run's binding grants write access there and nowhere
else, so a task that needs another path needs a new run.
