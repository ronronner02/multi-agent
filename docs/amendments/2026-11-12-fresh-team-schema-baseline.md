# Fresh team schema baseline

Date: 2026-11-12. Scope: U10 of the Windows-native desktop plan.

Use `PRAGMA user_version = 1` as the single fresh-schema marker. The marker and all retained schema objects commit in one transaction. SQLite already persists this header field, so no metadata table or migration registry is needed.

Inspect existing database files through a read-only connection before configuring journals or opening application repositories. An unmarked file with user schema objects fails with `legacy_database` and the filename. There is no legacy-data migration or preservation path. Marked files reopen normally.

Preserve the migration chain's final column types, defaults, constraints, foreign keys, indexes and trigger for the inventoried retained tables. Remove snapshot, discovery and startup-context reads whose writers were deleted, and keep their empty public projections. Retain binding, session and occupant columns used by the remaining repository and identity behavior.

Keep `TEAM_HEALTH_LIGHTS.controlTmux`: the team overview iterates that contract. Its current native probe continues to report `unknown` with `terminal_control_removed`. U10 changes no team HTTP contract, desktop screen, event stream, product name, `OPENRIG_HOME` variable or `openrig.sqlite` filename.
