# First-open, project creation and usage semantics

## Owner settings and account state

The team-control settings surface exposes only `team.leadClient`, `team.maxSeats` and `team.maxConcurrentAgents`. The registered settings store owns validation and persistence; environment values keep precedence over file values. General shows the effective default lead client and disables its control when an environment value owns it. These defaults affect newly created projects or runs, not an existing roster or a running turn.

Pairing comes before GitHub sign-in. Project, run, chat and integration queries mount only after a fresh successful account read. Sign-out cancels older account reads before publishing the signed-out result, so a delayed pre-logout response does not reopen the application. GitHub retains the credential; no token is added to the UI or its preferences. Sessions revokes the current browser only.

## Analytics population

The 7-day and 30-day views use captured, stopped attempts in UTC, scoped to the selected project or all projects. Native input, output and cache counters keep their reported meaning; missing fields remain unavailable rather than becoming zero. The cached tile combines the available native cache-read and cache-write counters. Partial capture is identified separately from a measured zero.

Success uses the captured attempts with a known outcome as its denominator. Retry uses captured attempts. Agent utilization is each seat's share of captured active time, not wall-clock capacity or a claim about concurrent availability. The charts preserve gaps for missing token measurements and size their text to the actual viewport. No monetary metric is derived or displayed.

## Create consequences

Create first requests the existing bootstrap dry run. The confirmation shows its canonical folder, file count, exclusions and whether the action creates a private repository, retries an initial push or registers an existing origin. The submit request uses that preview's canonical folder and name, with no owner-selected seats. Editing either input or dismissing the dialog invalidates the preview.

A repository-name collision clears the preview and returns focus to the name. A failed initial push retains the canonical target and offers Retry. A successful Create selects the project even before its first run. The native folder picker is used when its desktop bridge is present; otherwise the owner uses the engine-backed folder browser.

## Former screen functions

| Former function | Current home |
| --- | --- |
| Project list and project selection | Overview's project cards and the sidebar project selector |
| Project creation | Create project dialog |
| New work and run selection | New work form and the current project's run selector |
| Run state, attention and task counts | Overview and Tasks |
| Lead conversation, approval and escalation answers | Persistent lead chat panel |
| Resume, Merge and Cancel | Overview run controls |
| Task diff, evidence, review and attempt history | Tasks detail drawer, Reviews and Workspace |
| Integration branch and commit history | Reviews diff and folded Overview integration details |
| Language, account, appearance and browser revocation | Settings |

The former manual **Mark done** action is deliberately retired rather than moved. Completion follows the daemon's recorded task, review and integration evidence; the owner-facing controls remain Resume, Merge and Cancel. Existing daemon and CLI completion APIs are unchanged. The old run, project, task-detail and branch components, their tests and their route dispatch branches are removed; no parallel old-screen implementation remains.
