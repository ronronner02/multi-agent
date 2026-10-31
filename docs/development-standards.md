# Development Standards

These standards carry over to any project built from this codebase. They come from what slowed this project down: about two weeks went into hardening worker isolation before anyone could create a team task, and the work depended on one developer's machine.

## 1. Walking skeleton first
- Before any hardening, build the thinnest path that lets a user do the core job end to end: start the system, give it work, watch it run, get the result.
- Order the work so each slice extends that path, and each slice ends in a command anyone can run to see it work.
- Hardening, generalization and polish come after the path works. A slice that is "secure but unreachable" is not progress.

## 2. Hardening is opt-in
- Strong isolation, extra users, privileged helpers and host provisioning go behind one setting with a simple default (here: `workers.isolation: none | hardened`).
- The default path must run on a clean machine without sudo.

## 3. Portable by default
- No user- or machine-specific paths, hosts, proxies or credentials in code, scripts or CI. Use per-user config and state directories and environment variables.
- One setup script and a short README quick start must be enough for a new developer. If setup needs a document longer than a screen, fix the setup.
- Declare supported platforms explicitly. Code that only works on one platform (for example `/proc` readers) is either behind that platform's support or replaced.

## 4. Cheap checks, often
- Every change: focused tests for the touched code plus the package's typecheck.
- Every PR: a smoke set of about 10 test files in CI, finishing in minutes.
- The full suite runs before a release, not per change. A suite nobody can run per task gets skipped or wastes days.

## 5. Stop rules beat persistence
Stop and re-plan when:
- a slice grows past twice its estimate;
- the same fix fails twice;
- an investigation runs 30 minutes with no measured lead.

Long loops of "one more check" were the most expensive failure mode here.

## 6. Review in proportion to risk
- One reviewer reads the diff and runs the demo.
- A second, independent reviewer is reserved for code that guards credentials or reads untrusted, worker-written data.
- A finding that only asks for more hardening, with no reachable scenario, is recorded and not implemented.

## 7. Workspace hygiene
- One worktree and one scratch folder per task, both removed when the task lands.
- No probe scripts or logs in the repository or the home directory.
- Archive unlanded work before deleting anything.

## 8. Decide and record
- Agents decide questions that the rules or the slice settle, and record the reason in the PR.
- The owner is asked only about scope, public contracts, architecture or missing grants, in one batch.
