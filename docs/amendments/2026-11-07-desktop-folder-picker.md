# Shared desktop chrome and native folder selection

Date: 2026-11-07
Scope: Command-center plan U9, R9 and R13

## Existing owners

The desktop already has a hidden title bar, native caption overlay, selected WSL distribution,
and pairing bridge. The shared UI owns `.ui-topstrip` and the footer. Its current Create sheet
has a repository input but no native-picker consumer.

U9 therefore extends `teams-screen.tsx`, `team.css`, the existing team tests and both interface
catalogs in addition to its listed desktop files. These are necessary consumers of the planned
bridge, not a new creation flow. The current seat controls and `/teams` payload remain unchanged;
the project-bootstrap UI belongs to U8. A desktop test step is added to the existing smoke
CI job, without making the engine-only smoke command depend on desktop packaging.

## Decisions

- The preload marks the document as desktop and exposes one fixed `pickFolder()` operation.
  It keeps the existing pairing and status handoff and injects no chrome or body padding.
- The 48-pixel native overlay aligns with the shared strip. Desktop-only styles reserve the
  native caption area, make strip controls non-draggable and place drawers below the strip.
  Browser layout is unchanged. The setup page owns its own drag strip.
- The dialog is parented to the current window and accepts only the current main frame on
  the existing daemon origin. Mapping uses the engine's already-selected distribution.
- Drive paths and that distribution's `wsl.localhost` or legacy `wsl$` share map lexically to
  POSIX. Distro matching is case-insensitive and compares the entire share component. Spaces,
  Unicode and punctuation are preserved as data. Other shares, relative paths and traversal
  components produce an error; cancellation leaves the repository field unchanged.
- Folder selection starts no process and does not authorize creation or a push. Existing
  daemon validation remains responsible for project-root and bootstrap restrictions.

## Verification boundary

Pure mapping tests and a simulated desktop boundary cover the path and IPC contract. Browser
fixtures cover the shared layout with the real preload and synthetic native responses. Neither
proves Windows caption hit testing or a native dialog; those require the native desktop check.
Installer delivery remains a separate wrap-up gate.
