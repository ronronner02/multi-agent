# Command-center interface direction

## Decision

For the restored command-center screens, the 2026-10-31 mockup prompts and `docs/design/command-center/DESIGN.md` replace section 9 of `docs/development-standards.md`. Subtitles and secondary labels from that direction are retained. This does not change unrelated dashboard screens or the delivery engine.

The shell has Overview, Workspace, Tasks, Reviews, Analytics and Settings. Dark is the default; light and system are persistent preferences. The lead chat opens from the Coordinator or top bar and preserves its draft while navigating. The background loop pauses on blur or hidden documents and becomes a still image for reduced motion.

## Attention rules

- A count equals the length of the list it opens.
- A healthy state takes no extra attention space.
- A waiting row names whom it waits for and presents one action.
- Internal IDs belong only in folded details, never in primary labels.

Resume, Merge and Cancel remain run-level actions. No running-turn Pause, agent-card Stop, remote-management controls or monetary metrics are added.

## Transition

The existing `/team/teams`, `/team/run`, `/team/task` and `/team/branch` URLs remain reachable until U8 removes the old screens. U5 provides the restored shell and reuses the current task-evidence and run views while U6–U8 replace their contents. Analytics explicitly reports telemetry as unavailable until its data slice is connected.
