# Project-wide implementation scope after plan approval

Date: 2026-11-08
Status: approved by the owner

## Decision

New planning runs default to ordinary implementation throughout the selected project workspace. The owner approves the plan and team, not a guessed list of top-level implementation directories. The Lead chooses concrete task paths and staffing within that approved scope.

The previous default carried only `src` into execution. A web application needing `package.json`, `server/`, `client/` and `index.html` consequently failed task admission with `Assignment path is outside the binding` even after its plan was approved.

## Contract

- The binding-only path marker `.` denotes project-wide scope. It is valid in binding `readPaths` and `writePaths`, not in task assignments or output paths.
- Before execution approval, a new planning run carries prospective project scope in `readPaths`. Its write grant remains the named planning documents and conversation metadata.
- Execution approval promotes that requested scope into the delivery binding. The approval surface states this consequence before either a button or conversation confirmation submits it.
- The project-root grant excludes the existing protected credential, governance, contract, migration and CI paths. Candidate staging checks those exclusions even beneath an assigned directory. An explicit owner scope retains its existing meaning.
- Tasks still name concrete, nonoverlapping relative paths. Assignment preparation and candidate staging retain canonical-path checks; the project marker grants no path outside the selected workspace.
- Task-local scope changes, budgets, role permissions, external actions and the owner's final merge decision keep their existing controls.

## Compatibility

Explicit narrow planning scopes and existing persisted bindings are unchanged. Immediate non-planning starts retain their concrete default assignment. There is no data migration or automatic expansion of an existing run.

An owner may expand an existing run through the existing scope-change proposal and decision. The old binding remains authoritative until that exact decision is approved. Code delivery does not itself restart a daemon, deploy the change or mutate a live run's approval.

## Verification

Regressions cover planning-only writes, root application files after approval, protected descendants, concrete task ownership, external paths and aliases, explicit narrow scopes, existing-run expansion only after an owner decision, and the displayed approval consequence.
