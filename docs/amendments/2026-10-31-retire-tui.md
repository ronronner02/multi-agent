# 2026-10-31: Retire the terminal UI

**Decided by:** the owner, 2026-10-31. The product is the Web UI (`engine/packages/ui`, served
under `/team`) plus the Windows desktop app (`desktop/`).

## Why
- The owner retired the terminal UI. The Web UI now covers what it did, through the runs list,
the "New task" form, the run view's diff and the review decisions.
- Two user surfaces were being maintained for one job. Every change to team state had to be made
in both, and the TUI carried its own HTTP client, state projection, renderer and test suite.

## Decisions
1. **Delete `engine/packages/tui`** and everything that existed only to serve it: the bare-`rig`
front door (`packages/cli/src/front-door.ts`), the shared-terminal attachment
(`shared-tui.ts`), the TUI-only local-reading helper, the client-side command dump, the packaged
`openrig-tui` bin and its packaging test, and the scenario `tui_socket` surface with its
provisioning helper.
2. **Keep `rig tui` as a stub, not a deletion.** Existing instructions, release notes and the
shipped onboarding text still name the command, so removing it would turn them into "unknown
command". The stub prints the Web UI dashboard address and exits non-zero, so no script reads it
as a successful open.
3. **`rig` with no arguments prints the normal usage.** It no longer launches an interactive
surface; there is no terminal UI to launch.
4. **Provenance.** `tools/upstream-import.mjs` gains a `PIN.removed` list. `verifyTree` reports a
declared removal as `removed` instead of `missing`, so the pinned-upstream gate stays meaningful
after a deliberate deletion. Every imported file this change edited is registered in
`PIN.adapted`.
5. **Catalog keys are untouched here.** Keys only the terminal UI used stay in the shared i18n
catalogs until the parallel Web UI slice settles the catalogs; removing them here would conflict.

## What this does not change
- The daemon, its routes and the team-control contract are unchanged.
- The Web UI and the desktop app are unchanged.
- The pinned upstream commit and its manifest digest are unchanged.
