# Known pre-existing test failures

Failures listed here reproduce at a task's base commit and are not caused by task work. Under the `AGENTS.md` review and verification cost rules, a matching failure is recorded as pre-existing without a new base-commit reproduction. Remove an entry once the failure is fixed.

| Test | Symptom | Cause | Confirmed |
| --- | --- | --- | --- |
| `engine/packages/daemon/test/auth-bearer-token.test.ts` — HG-4 cases ("returns null for an intentionally-unresolvable hostname", "(7) DNS-unresolvable hostname with no bearer → THROW") | The unresolvable hostname resolves to an address in `198.18.0.0/15` instead of failing | Environment: the local resolver appears to answer every name with a synthetic address from that range, so the hostname never fails to resolve | T032 base `b599fef71689aa2d54a93c08ff9fe81c995f504b`, 2026-10-17 |
| `engine/packages/daemon/test/stub-runner-determinism.test.ts` — "produces a byte-identical pane transcript + activity sequence + asset stamps across a double-run" | Activity events arrive in a different order between runs | Intermittent ordering flake; an isolated base repeat failed on attempt four after three passes | T032 base `b599fef71689aa2d54a93c08ff9fe81c995f504b`, 2026-10-17 |
