# Operations

Runbook for a team working on your repository. Commands run on Linux or inside WSL2
unless stated otherwise. Use Linux Node.js 22 or 24, git and tmux. Put the selected
Node installation first on `PATH`; a Windows npm on the WSL path cannot build the engine.

## Create a team for your repository

From a fresh clone, run `./setup.sh`, add `engine/node_modules/.bin` to `PATH`, run
`rig config set ui.enabled true`, then `./scripts/start.sh`. The
[README quick start](../README.md#quick-start) gives the complete sequence. Setup creates
the owner credential and installs GitHub CLI; the start script loads the credential
and starts a managed daemon on loopback. The default `workers.isolation: none` needs
no host provisioning.

Install and sign in to the clients the team will use before starting work. The daemon
uses your local Claude Code and Codex configurations. A new project folder does not
need an initial commit, a plan file or a seed script.

Pair the browser, sign in to GitHub, then choose **Create project**. Select a folder,
enter a project name, choose **Review files**, and inspect the canonical path, included
file count, excluded paths and upload consequence. **Create** confirms that action.
The desktop picker accepts Windows drive folders; the browser picker lists folders
on the engine's machine, not the browser's machine.

A named project starts with only its configured lead. The lead proposes the remaining
seats during planning; plan approval approves that roster too. The older CLI path
without `--name` still registers a local repository with manual seats, as described
below; it is not the UI's project-creation flow.

## Pair a browser

Open `http://127.0.0.1:7433/team`. A new browser needs a one-time pairing code; the
Windows desktop app obtains and exchanges it automatically. Use the owner CLI to mint a one-time code:

```bash
rig team pair-browser
```

The command prints only the code so it can be pasted directly into the browser. For
scripts or diagnostics, use `rig team pair-browser --json` to receive the code and
its expiry timestamp. The code expires after 60 seconds and is single-use.

Enter the printed code in the browser's pairing field.

The desktop reuses its saved engine repository and any configured non-secret runtime
profile for both startup and pairing. It renews an expired owner session without
reloading the current project or form. A connection failure offers **Retry**; it does
not change the selected profile or require copying a token into the app.

## GitHub sign-in

After pairing, choose **Sign in to GitHub**, then **Open GitHub**. Enter the displayed
one-time code on GitHub and approve the device flow. The app checks the account
before mounting the project and run views. If the code expires or sign-in fails,
choose **Try again** for a new flow. A missing GitHub CLI requires `./setup.sh`.

```bash
rig github status
rig github status --json
```

These commands inspect the daemon's account; they do not start sign-in or print a token.
The daemon uses GitHub CLI's Linux credential store, honoring `GH_CONFIG_DIR` when
configured. It deliberately ignores inherited `GH_TOKEN` and `GITHUB_TOKEN` values
so those variables do not override the account or defeat sign-out. It does not
install a global git credential helper.

**Settings → GitHub → Sign out** signs the active account out of that store and returns
to the sign-in gate. Other processes using the same store see that change too.
**Settings → Sessions → Revoke this browser** instead revokes only the current owner
session. A standalone browser must pair again; the desktop stays disconnected until
you choose **Retry**. It does not sign GitHub out or stop the team.

## Create and retry behavior

After sign-in, preview and create a named project from the terminal:

```bash
rig team create /absolute/path/to/project --name project-name --dry-run
rig team create /absolute/path/to/project --name project-name
```

The second command asks for confirmation. For non-interactive use, review the dry run
first and add `--yes` only when the displayed upload is intended. `--name` uses the
configured lead; it does not combine with manual `--lead`, `--implementers` or
`--reviewer` flags.

- **New folder or no commit:** Create initializes git, adds a default `.gitignore` if
  absent, snapshots the included files into an initial commit, creates a private
  GitHub repository, sets `origin`, and pushes. The preview changes no project files.
- **Commit with no origin:** Create uploads the selected existing commit and its
  reachable history. Uncommitted changes stay local. Credential-policy paths in the
  outgoing history cause rejection; the engine does not rewrite that history.
- **Existing origin:** The project is registered without creating a remote or pushing.
  Its remote and visibility are unchanged; registration does not make it private.
- **Folder safety:** Home and drive roots, credential-policy locations and folders
  nested inside another repository are rejected. Excluded credential paths are listed.
  Inspect content before confirming: path exclusions do not detect every possible secret.
- **Name collision:** Choose a different name and review again. The existing remote
  is not reused just because its name matches.
- **Interrupted push:** Check connectivity, account access and private visibility, then
  choose **Retry** with the same folder and name. The daemon retains the bootstrap and
  retries the pinned initial commit rather than creating a second remote or commit.
  An origin or bootstrap change requires review again; do not delete its state to retry.

A desktop drive path such as `D:\code\project` maps to `/mnt/d/code/project`. The browser
accepts engine-visible absolute paths and provides a directory browser. Create's
upload is the engine's only push; delivery and Merge remain local.

### Existing local repositories with manual seats

For CLI compatibility, an unnamed Create registers a repository that already has a commit:

```bash
rig team create /absolute/path/to/existing-repository
```

This path does not create or push a GitHub repository. Its defaults remain a Claude Code
lead, Claude Code and Codex implementers, and a Claude Code reviewer. `--lead <client>`,
`--implementers <comma-separated-clients>` and `--reviewer <client>` select those seats;
values are `claude-code` and `codex` (`claude` is also accepted).

## Plan and deliver

Enter a goal in the new project's start form, or choose **New work** for another run.
The lead drafts `plan.md`, asks questions in chat, and proposes the roster. Review the
plan and team together before **Approve plan**. Sending a chat answer does not approve
either artifact.

The CLI requires `--planning` for this flow:

```bash
rig team start "Describe the change you want" --planning --rig <team-name>
rig team chat <run-id>
rig team chat <run-id> "Your answers and requested changes"
rig team approve-plan <run-id>
```

Use the team name printed by Create and the run id printed by Start. `--rig` may be
omitted when there is exactly one team. Start uses `plan.md`. Planning grants ordinary
project-wide implementation only after approval; protected paths, work outside the
project, external actions, budget increases and final merge remain separate decisions.
Use `--write <path...>` to narrow that grant (for example `--write src test`). A direct
non-planning CLI Start still defaults to `src`. `--plan <path>` selects another
repository-relative plan artifact. Planning writes its agreement and proposal
artifacts, not delivery code. Approval binds the current plan and roster.

Once approved, the lead assigns implementer tasks. The daemon records outcomes,
creates reviews, routes rework and commits approved candidates to `team/…`. Workers
report blockers to the lead first. Task admission, worker completion and reviewer
verdicts require no owner action. Answer an escalation when the lead needs a decision
about scope, budget or an unresolved conflict. Owner chat has reserved lead capacity
even when worker slots are full; a provider-wide limit may still delay the reply.

For a run with a reviewer, an implementation dependency is ready only after validated
completion and its integration commit. Worker completion or review approval alone
does not start a dependent candidate before the accepted files reach the run branch.
An explicitly read-only workflow requires validated completion but no implementation
review or empty integration commit; its read paths are not exclusive write claims.
Validated task drops and settled, integrated tasks release their write-path claims
for later admitted work without deleting their records. Pending review, unintegrated
work and active attempts keep their claims.

The project selector changes the project; the run selector changes its run. The six
sections keep their own view of that context:

| Section | What to inspect |
| --- | --- |
| Overview | Progress, selected-task evidence, agent activity, owner attention and folded integration history. |
| Workspace | Seats, live pane output, native token counters and recorded tool calls. |
| Tasks | Searchable List and persistent inspector with attempts, reports and diffs; Board retains dependency stages. |
| Reviews | Candidate findings and the action to ask the lead for follow-up. |
| Analytics | Project-scoped captured stopped attempts over 7 or 30 days, grouped in UTC. |
| Settings | General, GitHub, Appearance, Sessions, model policy and specialist profiles. |

Analytics uses native input, cache and output counters without monetary estimates.
Missing counters remain unavailable, not zero. Outcome rates show their denominators;
agent utilization is the share of captured active time, not wall-clock capacity.
Workspace can show a running turn before that attempt is eligible for Analytics.

General selects the default lead client for future projects. `team.maxSeats` and
`team.maxConcurrentAgents` bound roster size and dispatch; configure them through
`rig config set`. Environment overrides take precedence over saved values. Appearance
controls theme and the Shuimo Danqing backdrop's motion. The entrance plays once per
app/browser session, then only the complete portrait segment repeats. Navigation,
reload and reconnect do not restart the entrance. Reduced motion uses the portrait
still; animation pauses when the window loses focus or the page is hidden.
Agents edits model policy and specialist identities, not the team's size or permission
roles. The lead proposes those choices through the existing roster approval path.

## Workflows and specialist profiles

### Dispatch and outcomes

New work and the initial project chat accept an optional **Workflow** selection.
In a Lead-led run, an initial selection becomes a recorded owner request, not a
permanent workflow on the Lead's chat task. It remains in subsequent Lead prompts
until assigned once to a worker; planning requests still wait for execution approval.
A run without a Lead dispatches the selection directly to its worker.
Delivery-phase chat uses the same owner-request path, with commands such as:

```text
/spec-handoff --read-only
Summarize the current task.
```

The lead receives that request's recorded message ID. It can put
`workflow: {"entrypoint":"spec-handoff","ownerMessageId":"<message-id>","readOnly":true}`
on an ordinary proposed task. Admission checks the owner, run, entrypoint and original
input, preserves read-only scope, and permits only one assigned task per owner request.
An ordinary lead-selected workflow has caller provenance; putting an owner-only
entrypoint in a task body does not supply an owner grant. Caller-only helpers remain
internal to their governed caller contracts. No second scheduler is started.

CLI Start supports `--workflow <entrypoint>` and optional `--read-only`; the latter
requires the former. Workflow selection does not approve the plan, commit, push,
merge, external actions or a larger budget. Existing protected-path rules still apply.

The owner API provides `GET /api/team-control/workflows` and
`GET /api/team-control/runs/:runId/workflows`. Each native turn reports an outcome
envelope, retained with its attempt and generation. Missing or malformed output is
`incomplete`; the workflow reports missing capabilities as `blocked`; native process failure overrides
a claimed success. A complete answer-only, read-only workflow may have no files, but
needs a substantive summary and an unchanged candidate. Reported file artifacts must
exist before task evidence validates. The history displays native outcomes separately
from task validation, review verdicts and owner acceptance.

The owner completion read uses the outcome for the latest attempt's exact native
generation, so it applies the same workflow evidence rules as automatic completion.
A failed exact-resume preflight preserves the earlier candidate and context. Its
launch-block record is separate from the native generation that a later retry starts.

All 38 entries use the same admission, attempt-context and completion path. This is
dispatch coverage, not a claim that every external capability is installed or that
all 38 upstream workflows have passed live acceptance. Browser workflows need their
browser capability and exact target origin. The pinned browser workflow owns its
wrapper probe, exact-origin validation and checks before browser effects. Starting a
native client lets it evaluate those prerequisites; it neither authorizes browser
effects nor attests that the browser checks passed. The daemon does not produce a
browser conformance receipt. Xcode workflows record a capability block on Linux/WSL;
macOS execution remains outside the supported host matrix.

In direct mode, read-only turns use the native client's read-only settings: the
shell sandbox is read-only with no approval escalation, or the alternate client is
limited to Read/Glob/Grep in planning mode without inherited external tools. These
settings do not turn same-user direct mode into the hardened OS boundary; configured
external tools remain subject to the existing approval protocol. The experimental
hardened policy supports a physically read-only candidate only for reviewer seats;
a read-only workflow on another role records a capability block before native launch.
Read-only assignments may use the binding's approved read paths as inputs without
acquiring write permission or declaring written outputs.

### Pinned source installation

`./setup.sh` installs the exact catalog revision under
`$OPENRIG_HOME/framework/<revision>` (using the application's normal per-user state
home when `OPENRIG_HOME` is unset). Git must be able to fetch the pinned repository.
To use an already installed, verified source package, set
`MULTI_AGENT_FRAMEWORK_ROOT` to its absolute path before setup and daemon launch.

Installation checks the fetched revision and records the complete file set and
SHA-256 hashes. Repository link blobs are checked out as inert files, not followed
as runtime mirrors. Launch verifies the source package, including supporting
references, and reads canonical source entrypoints. It never downloads at launch,
silently replaces an unverified nonempty directory, or substitutes generated skill
mirrors. Legacy launches with no installed source remain available; explicit workflow
requests record a block until source is installed.

### Versioned SOUL profiles

**Settings → Agents → Specialist profiles** contains seven built-in profiles and
owner-created profiles. A profile has an ID, display name, compatible permission
roles, instructions, version and content digest. Saving appends a project-scoped
revision with an optimistic version check; it does not overwrite an earlier saved
revision. Owner routes are:

- `GET /api/team-control/teams/:teamId/souls`
- `PUT /api/team-control/teams/:teamId/souls/:soulId`
- `PUT /api/team-control/teams/:teamId/seats/:nodeId/soul`

The lead sees the available profile IDs, names, roles and versions and can select
`soulId` in a proposed roster seat or seat addition. Permission role and client/model
are independent of that identity. A profile cannot grant permissions, change a
binding or replace the approved task. The existing runtime `profile` field retains
its meaning; specialist identity is stored separately.

Each attempt records the selected profile's exact version, content and digest in its
context. A profile edit affects new attempts; an exact resume keeps its old snapshot.
Changing a seat's identity waits until its assigned work has finished and clears that
seat's continuation tokens. No cross-run personal memory is added.

## Resume a blocked run

Read the block reason and resolve any external problem, then choose **Resume** in
the run's primary action or use:

```bash
rig team resume <run-id>
```

Resume clears a resumable block and offers pending work to dispatch, including a
failed lead. It does not restart the daemon or rerun finished tasks. Time and retry
budget blocks require a positive increase in that budget in the same action:

```bash
rig team resume <run-id> --add-minutes 30
rig team resume <run-id> --add-retries 1
rig team resume <run-id> --add-review-rounds 1
```

Use the option that matches the displayed budget block. Review exhaustion can also
be resumed without an increase so the lead can decide on follow-up work. The UI
shows the increase it will request before the click. Resume is for a blocked run;
plan approval and escalation answers remain separate actions.

## Merge the integration branch

Review the task diffs and the integration commits, then choose **Merge** in the UI
or run:

```bash
rig team merge <run-id>
```

This updates the currently checked-out branch in the repository the team was created
for. The checkout must be clean and on a branch. The daemon fast-forwards when it can,
otherwise makes a merge commit. A conflict is reported and the attempted merge is
aborted, restoring the checkout. Resolve the conflict before trying the merge again.
Merge does not push; publishing the resulting branch is a separate owner action.

Readiness requires landed work, completed implementation/review tasks and no failed
task. Merge is also refused while the lead task is pending, in progress or blocked.
[PR #138](https://github.com/ronronner02/multi-agent/pull/138) (`abb344f`) fixed the
lead-evidence and premature-merge defect recorded in the
[U11 acceptance record](validation/2026-11-06-autonomous-team/README.md).

## Worker Isolation

`workers.isolation` selects how a managed worker runs. It is read once at daemon startup, so a change applies on the next restart.

| Value | What runs |
| --- | --- |
| `none` (default) | The native client runs as the daemon's own user, inside the task's candidate git worktree, in the seat's tmux pane. No host provisioning, sudo, extra accounts or sandbox. |
| `hardened` | The existing restricted worker launcher. Requires the `ma-*` accounts, the installed policy and sudo, all from the provisioning step below. |

Under `none`, the daemon keeps its state under `$OPENRIG_HOME/state/workers/`:
`assignments/<worker>/<run>-<task>` for candidate worktrees and
`context/<worker>/<run>/<attempt>` for attempt projections. Mailbox endpoints use
`$OPENRIG_HOME/sock/<worker>/<attempt>/mailbox.sock` while that path fits Linux's
107 usable AF_UNIX pathname bytes. For a longer profile, only the transient mailbox
root moves to `/tmp/ma-<uid>-<profile-hash>`, a private `0700` directory checked for
canonical path and current-user ownership. Databases, worktrees and credentials stay
in their configured locations. No launch uses sudo or reads hardened provisioning
from `/etc/multi-agent`, `/opt/multi-agent`, `/run/multi-agent` or
`/usr/local/libexec/multi-agent`.

The isolation is a boundary between tasks, not between the worker and the host: a worker under `none` has the daemon's full filesystem access, its network and its environment. The receipt records `network.mode: "unknown"` because no profile is enforced. Use `hardened` where that matters.

The three health lights that describe the hardened boundary (`workerBoundary`, `sandboxNetwork`, `clients`) report `unknown` with the reason `workers_isolation_none` in this mode, rather than reading files nothing enforces.

## Identities and Boundaries

The table and the boundary description below apply to `workers.isolation: hardened`.

| Identity | Purpose | Notes |
| --- | --- | --- |
| Owner login (for example `leo`) | Owner browser, owner terminal host | The only approval authority. Never used for agent sessions. |
| `ma-control` | Daemon / control plane | Owns `/var/lib/multi-agent/control` (mode `0700`). May run exactly one sudo command: the worker launcher. |
| `ma-worker1`..`ma-worker3` | Managed coding sessions (lead, implementer, reviewer) | System accounts, `nologin` shell, no supplementary groups, no sudo. |

Every managed coding process starts through the restricted worker launcher (`/usr/local/libexec/multi-agent/worker-launch`). The launcher runs as root through a fixed sudoers rule. It accepts only:

- an identity from the policy allow-list that holds no privileged group;
- a defined role (`implementer` mounts the assigned tree read-write, `reviewer` read-only);
- a tree inside `/var/lib/multi-agent/assignments/<worker>/`, resolved through symlinks;
- environment keys from the policy allow-list;
- an absolute command under `/opt/multi-agent/toolchain/` or `/usr/bin/`.

It then drops to the worker identity (`setpriv --no-new-privs`, all capabilities and supplementary groups cleared) and enters a bubblewrap sandbox. The sandbox has separate user, PID, IPC and UTS namespaces, a cleared environment, and fresh `/proc`, `/dev`, `/tmp` and `/run` mounts. The only bind mounts are read-only `/usr`, selected `/etc` files, the toolchain and the pinned framework, plus the worker's own home, its scratch directory and the assigned tree. Within `/usr`, the Windows-provided driver store and GPU libraries at `/usr/lib/wsl` are masked by an empty tmpfs.

The launcher opens the three writable sources itself, re-verifies each through `/proc/self/fd`, and hands them to bubblewrap as descriptors (`--bind-fd`), so a path swapped after validation cannot change what is mounted. It also refuses to start when any standard stream is a directory descriptor, which a worker could otherwise use with `openat()` to reach outside its mounts.

Control state, owner tokens, the browser session store, the SQLite database with its WAL and shared-memory files, supervisor and tmux sockets, other workers' data, `/mnt/*` (the Windows drives) and `/run/WSL` (the Windows interop sockets) are never mounted. Restrictive ownership is a second layer.

The installed policy (`/etc/multi-agent/worker-policy.json`) and launcher are root-owned copies of `engine/config/isolation/`. Workers and the control identity cannot modify them. Callers cannot pass bind mounts or sandbox flags.

Known boundary properties:

- **WSL interop is global.** `/run/WSL/*_interop` sockets are world-writable, and `/mnt/c` and `/mnt/d` are drvfs mounts readable by every local uid. Outside the sandbox, a worker uid could start Windows processes or read Windows files. The sandbox hides both paths, and the preflight harness proves that neither a mounted nor a copied Windows executable runs inside it. Never launch a worker outside the launcher.
- **The worker network is its own, and the only way out is the egress filter (KTD23).** Policy revision 3 sets `sandbox.network: filtered-proxy`.
  - Each sandbox gets an empty network namespace (`--unshare-net`) that holds only loopback. Windows `127.0.0.1` listeners under `networkingMode=mirrored`, the LAN, overlay-network peers, MagicDNS names and host abstract unix sockets are therefore unreachable. The sandbox has no name resolution of its own.
  - Outbound traffic goes only through `multi-agent-egress.service`. It runs as the separate `ma-egress` identity and listens on `/run/multi-agent-egress/proxy.sock`, which the launcher binds read-only into each sandbox.
  - Inside the sandbox, a relay exposes that socket as `HTTPS_PROXY=http://127.0.0.1:3128`, which the launcher sets and callers cannot override.
  - The filter accepts only `CONNECT` to an exact `host:port` in `/etc/multi-agent/egress.json`. It refuses IP literals and names without a dot, and forwards through the owner's upstream proxy when one is configured.
  - Without an upstream, it connects directly and refuses names that resolve to loopback, private, link-local, overlay or multicast addresses. With an upstream, the upstream resolves names, so the allow-list is the control.
  - A network namespace does not cover `AF_VSOCK` (the Hyper-V channel to the Windows host), and `io_uring` can create sockets without `socket()`. The launcher therefore passes bubblewrap a seccomp program (`--seccomp`, x86_64 only): `socket`/`socketpair` with `AF_VSOCK` fail with `EAFNOSUPPORT`, and `io_uring_*`, x32 and foreign-architecture syscalls fail with `EPERM`. Everything else is allowed, and nested bubblewrap still works.
  - If the filter is not running, the launcher refuses with `egress-unavailable`. Revision 3 has no fallback to the host namespace.
  - The service keeps `/run/multi-agent-egress` across a stop or restart (`RuntimeDirectoryPreserve=yes`), so a running sandbox reconnects to the new socket. A restart cuts open tunnels within 5 seconds. With a literal-IP upstream, the service itself may reach only that address (`IPAddressDeny=any`, `IPAddressAllow=<upstream>`).
  - Control-plane services must in any case use authenticated loopback listeners or path-based unix sockets under the control state directory, and must never use abstract sockets.
- **Interactive panes rely on the kernel TIOCSTI restriction.** Interactive sessions keep the tmux pane as their controlling terminal. The launcher refuses to start one unless `dev.tty.legacy_tiocsti` is `0`.

## Host Provisioning

Only needed for `workers.isolation: hardened`; the default `none` requires none of it.

Owner-run and idempotent. It requires the owner's sudo password and network access to `nodejs.org` and `registry.npmjs.org`.

```bash
sudo bash engine/config/isolation/provision-host.sh --preflight-owner "$USER" \
  --egress-upstream http://<owner-proxy-host>:<port>     # omit for direct egress
  # --egress-allow <gateway-host>:443                    # repeat per extra provider gateway
```

systemd must be PID 1 (`[boot] systemd=true` in `/etc/wsl.conf`). `--egress-upstream` and `--egress-allow` write the machine-local `/etc/multi-agent/egress.json` and never the repository. The public provider and registry endpoints are always allowed: `api.anthropic.com`, `api.openai.com`, `chatgpt.com` and `registry.npmjs.org`, all on 443. A re-run without these flags keeps the installed upstream and extra entries. A custom gateway that a client is configured to use must be added with `--egress-allow`, or that client's requests are refused.

It installs:

- Host packages: `bubblewrap`, `tmux`, `util-linux`, `socat`, `acl`, `curl`, `xz-utils`, `ca-certificates`.
- Node.js `v24.21.0` from the official tarball, verified against a pinned SHA-256, into `/opt/multi-agent/toolchain/node`.
- The client builds named in `engine/config/isolation/client-lock.json` (currently `@anthropic-ai/claude-code@2.1.296` and `@openai/codex@0.160.0`) into `/opt/multi-agent/toolchain/clients`. Provisioning fails if any installed file's SHA-256 differs from the lock. npm lifecycle scripts are disabled. The only shipped lifecycle script, Claude Code's `install.cjs`, was audited (it copies the bundled platform binary locally) and is run explicitly. Codex ships no lifecycle scripts.
- The `ma-control` and `ma-worker*` identities, and `/var/lib/multi-agent/{control,workers,assignments}` with the modes listed above. Assignment directories are `<worker>:ma-control 2770`, with default ACLs so control can stage trees that the worker can edit.
- The launcher, its `/bin/sh` wrapper (which clears the environment except `SUDO_UID`), the policy and `/etc/multi-agent/client-lock.json`, all root-owned.
- The worker egress filter: `/opt/multi-agent/toolchain/egress/egress.mjs` (root-owned, inside the toolchain the sandbox already mounts) and `/etc/multi-agent/egress.json` (root-owned, `0644`; it holds no credentials). They are run by `multi-agent-egress.service` as the `ma-egress` system identity. That identity is in `forbidden_worker_groups`, has no shell or home, and runs with `NoNewPrivileges`, an empty capability set and `ProtectSystem=strict`.
- `/etc/sudoers.d/multi-agent-launcher`: `ma-control ALL=(root) NOPASSWD: /usr/local/libexec/multi-agent/worker-launch`.
- With `--preflight-owner`: `/etc/sudoers.d/multi-agent-preflight`, which lets that login act as the control and worker identities without a password so the harness can stage control-owned sentinels. **Remove it after preflight:**

```bash
sudo rm /etc/sudoers.d/multi-agent-preflight
```

Re-run provisioning after any change to `engine/config/isolation/`. The preflight compares installed hashes with the sources and fails on drift.

The script does not auto-upgrade the clients.

## Client Lock (KTD27)

`engine/config/isolation/client-lock.json` pins each native client to:
- an exact version;
- the SHA-256 of every file in its exec chain (Claude Code's `claude.exe`; Codex's `codex.js` wrapper and the vendored native binary it spawns);
- the adapter contract fixtures captured for that version.

On every fresh launch and resume, the privileged launcher re-hashes the pinned files from the installed `/etc/multi-agent/client-lock.json` and checks that the entry point resolves to the first pinned file. Any mismatch refuses the launch:
- the launcher returns `unsupported-version`;
- the daemon returns `agent_error.unsupported_version`;
- there is no retry and no compatibility fallback.

The launcher also refuses a Codex command that does not disable self-update, and it sets `DISABLE_AUTOUPDATER=1` for Claude Code. Workers cannot write the toolchain. Each launch event records the lock digest and version.

The lock is separate from `worker-policy.json`. Client versions are runtime dependencies, not security-boundary configuration, so changing the lock does not bump `policy_revision`.

Changing a pinned client is an owner action:
1. Set the new `version` in `client-lock.json`, then re-run provisioning to install that build. Provisioning stops at the hash check; that stop is expected.
2. Capture the adapter contract fixtures with the new build: the native channel spike record and the screen captures the adapters parse. Each fixture must name the exact version.
3. Record the new SHA-256 of every exec-chain file in `files`, and list the new fixtures in `fixtures`. `client-lock.test.ts` fails when an entry has no fixture set, or when a fixture does not name its version.
4. Re-run the native adapter contract tests and the daemon package suite.
5. Re-run provisioning, which now passes the hash check and installs the new lock, then run the full U1 host preflight.

## Role Charters (KTD28)

Every managed attempt's `/context` projection carries two instruction files besides its role, plan and framework entries:
- `engine/config/team/core.md`, the conduct every role shares;
- its role's charter: `engine/config/team/roles/implementer.md` or `engine/config/team/roles/reviewer.md`. The Lead's charter is `engine/config/team/lead-protocol.md`.

Each file starts with a `Version:` line. The manifest records both versions and the file hashes. A missing, duplicate, changed or other-role file refuses the launch, and a version that differs at launch or resume refuses it too. A resume keeps its attempt's projection; a new attempt picks up the current files. Development reviews use the same reviewer charter (`AGENTS.md`, "Reviewer instructions live in one charter").

The reviewer charter's report format is enforced when a review is recorded:
- a P0 or P1 needs a failing scenario;
- from round 2 on, every new finding needs a delta tag, and every earlier open P0/P1 needs a verdict (`CLOSED`, `STILL OPEN` or `REGRESSED`). A finding kept open but not re-raised is carried into the round, so it cannot close by omission;
- the daemon decides delta membership from the retained packet's changed files. Until packet retention lands, every finding counts, as in a full review.

A refused submission records nothing and does not use a round.

Changing a charter or the core is an owner action:
1. Edit the file and increase its `Version:`. For the Lead protocol, also update `LEAD_PROTOCOL_VERSION`.
2. Run `role-charter.test.ts`, `framework-context-manifest.test.ts` and `team-review-cycle.test.ts`. The charter test parses the reviewer charter's JSON example through the ledger, so the documented format and the enforced one cannot drift apart.
3. Under a separate owner live-spend grant (KTD9), give each role its planted-defect fixture under `engine/packages/daemon/test/fixtures/role-charters/` and record whether the expected outcome appeared. Do this whenever a charter, the core, a model profile or the KTD27 lock changes. The offline test only checks that the fixtures are well-formed and cite real plan decisions.

## Isolation Preflight

Offline. It starts no model session and spends no provider quota.

```bash
# Offline unit checks (any platform)
node --test engine/test/worker-isolation-preflight.test.mjs

# Host checks (provisioned WSL host, owner login, preflight sudoers present)
MA_PREFLIGHT=1 /opt/multi-agent/toolchain/node/bin/node --test engine/test/worker-isolation-preflight.test.mjs
```

The host run stages control-owned sentinels in a fresh `/var/lib/multi-agent/control/preflight-*` directory: an owner token, `state.db`, `state.db-wal`, `state.db-shm`, a browser session store, a listening supervisor socket, and a control tmux server. It also starts an owner tmux server. Before probing, it confirms every target is live from its owner's side; a fixture that fails to start is a blocker, not a pass. It then launches real worker subprocesses through the installed launcher and checks:

- the actual identity, `NoNewPrivs`, empty effective capabilities, no descriptor pointing outside the sandbox, and no leaked `WSL_INTEROP`/`TMUX`/`SUDO_*` variables;
- that reading, writing, listing or connecting to every sentinel, the Windows drives, the interop sockets, other workers' directories and the owner's tmux socket fails, and that host processes are invisible;
- that both a Windows-mounted executable and a copied one fail to run, and that no `9p`/`drvfs`/`virtiofs` mount (including `/usr/lib/wsl`) is visible;
- that scratch and the implementer tree are writable and the reviewer candidate is read-only;
- that ownership still denies access outside the sandbox, and that workers cannot invoke the launcher;
- that the launcher rejects control identity, out-of-assignment trees, symlink escapes, disallowed environment, Windows commands and a directory on stdin with distinct codes;
- that both native clients start, that nested bubblewrap (the Claude Code sandbox mechanism) and `socat` work inside the boundary, and that the Codex native sandbox still enforces its profiles: `:read-only` write denied, `:workspace` write allowed, writes outside the workspace and network denied. Each case checks the resulting filesystem state, and the network case first proves the same request succeeds outside the Codex sandbox;
- that a Windows process reaches a WSL listener bound to `127.0.0.1`, and that the listener is not bound to other interfaces;
- that the egress filter is active as `ma-egress`, matches the reviewed `egress.mjs`, and that its profile fingerprint (the SHA-256 of `egress.json`) is recorded. A changed allow-list or upstream is a new profile;
- KTD23 reachability, enumerated from inside the sandbox:
  - the sandbox network namespace differs from the host's;
  - a scan of every loopback port finds only the egress relay;
  - a live owner loopback listener, every non-loopback host address, the default gateway, the resolver and the overlay resolver `100.100.100.100` are unreachable on ports 22, 53 and 443;
  - name resolution fails, and no host abstract socket is visible, although the host shows some;
  - through the filter, an allowed registry request succeeds (`CONNECT` 200), while an unlisted host and an IP literal are refused by the filter itself (`CONNECT` 403);
  - `AF_VSOCK` socket creation fails inside (`EAFNOSUPPORT`) and works on the host, which is the positive control; `io_uring_setup` fails inside;
  - across the whole sandbox filesystem, the only connectable path socket is the egress socket, and the seccomp descriptor does not reach the worker;
  - the receipt records the host networking mode (`wslinfo --networking-mode`), so a later mode change visibly voids it.

Missing tools, identities, launcher installation, kernel capability or preflight access fail every host check with a distinct `blocked by prerequisites:` code. Fix the prerequisite; never weaken the policy. A redacted receipt (facts, installed hashes and probe outcomes, but no sentinel contents) is written to `${XDG_STATE_HOME:-~/.local/state}/multi-agent/preflight/<run>.json`, outside the repository.

### Recorded Result (2026-10-18, policy revision 3)

The host preflight passed 46/46 checks under `networkingMode=mirrored` (recorded in the receipt as `host_networking_mode`) against policy revision 3, with no prerequisite or fixture blockers. The receipt is `preflight-7d304b13.json`, recorded at 2026-10-18T02:32:45Z. A receipt is valid only for the host networking, the policy revision and the egress profile it was taken under. Re-run the preflight after any of them changes.

| Fact | Value |
| --- | --- |
| OS / toolchain / clients | Ubuntu 26.04.1 LTS, `6.18.33.2-microsoft-standard-WSL2`; Node.js `v24.21.0`, bubblewrap 0.11.1; Claude Code `2.1.296`, Codex CLI `0.160.0` |
| Egress filter | `multi-agent-egress.service` is active as `ma-egress`. The installed `egress.mjs` matches the source. An upstream proxy is configured. The allow-list is `api.anthropic.com:443`, `api.openai.com:443`, `chatgpt.com:443` and `registry.npmjs.org:443`. The profile fingerprint is `sha256:baf85cd58c3ac8fd3c7572d9ba574037c879ff864917f8d0ac017275e2e33649`. |
| Network namespace | The sandbox namespace `net:[4026532311]` differs from the host namespace `net:[4026531833]`. |
| Host channels outside the namespace | `AF_VSOCK` socket creation returns `EAFNOSUPPORT` and `io_uring_setup` returns `EPERM` inside the sandbox; both succeed on the host (positive control). Across the whole sandbox filesystem the only connectable path socket is `/run/multi-agent-egress/proxy.sock`. |
| Reachable set inside the sandbox | A full loopback scan finds only the egress relay, `127.0.0.1:3128`. None of the 25 probed host targets connects: a live owner loopback listener, plus ports 22, 53 and 443 on every IPv4 and global IPv6 host address, the gateway, the resolver and `100.100.100.100`. Name resolution fails with `EAI_AGAIN`. Abstract sockets: 7 visible on the host, 0 in the sandbox. |
| Egress controls | `registry.npmjs.org` returns `CONNECT 200` with an HTTP 200. `example.com` and the IP literal `1.1.1.1` are each refused by the filter with `CONNECT 403`. The Codex `:workspace` network denial is now proven: its positive control succeeds through the filter. |

Before revision 3 was provisioned, an earlier probe on the same day under revision 2 found the sandbox reaching the Windows proxy, the proxy controller, the remote-desktop listener and two tailnet peers. Revision 3 closes that.

### Recorded Result (2026-10-13, superseded)

The host preflight passed 29/29 checks against policy revision 2, with no prerequisite or fixture blockers. The receipt is `preflight-8a55c69d.json`.

**This receipt is superseded and must not be cited as current evidence.** It was taken under WSL2 NAT networking and policy revision 2 (`host-shared`). Its only loopback check ran in the Windows-to-WSL direction.

| Fact | Value |
| --- | --- |
| OS / kernel | Ubuntu 26.04.1 LTS / `6.18.33.2-microsoft-standard-WSL2` |
| Toolchain | Node.js `v24.21.0`, bubblewrap 0.11.1, tmux 3.6, util-linux 2.41.3 |
| Native clients | Claude Code `2.1.296`, Codex CLI `0.160.0` (toolchain copies, no auto-upgrade) |
| Identities | `ma-control` uid 999; `ma-worker1..3` uids 997/994/993; each holds only its own group |
| Control sudo grant | `(root) NOPASSWD: /usr/local/libexec/multi-agent/worker-launch` only |
| Kernel | `dev.tty.legacy_tiocsti = 0`; WSL interop enabled (hidden from workers) |
| Denials | All sentinel, Windows-drive, interop-socket, other-worker and owner-tmux paths return `ENOENT` inside the sandbox, although each was confirmed live from its owner's side first. The reviewer candidate returns `EROFS`. A live host PID returns `ESRCH`. A copied Windows executable is present but cannot run. A directory on stdin is rejected (`stdio-not-allowed`). |
| Windows-backed mounts | The `/usr/lib/wsl/drivers` 9p mount is covered by the read-only mask and does not resolve. No other 9p/drvfs/virtiofs mount appears. The only path-backed descriptor in the worker is `/dev/null`. |
| Native protections | Nested bubblewrap and `socat` work. Codex `:read-only` write, out-of-workspace write and network access are denied, with the resulting files absent and the network positive control succeeding outside Codex. `:workspace` write is allowed and the file exists. |
| Loopback (Windows to WSL only) | A Windows process reaches a WSL listener on `127.0.0.1` (HTTP 200); the listener is bound only to `127.0.0.1`. The reverse direction, and the reachable set from inside the sandbox, were not measured and are required by KTD23. |
| Limitation | 6 host abstract unix sockets are visible inside the sandbox because the network namespace was shared at that time (see Known boundary properties). Under KTD23 the sandbox must not reach host abstract sockets at all, and the preflight enumerates the reachable set from inside the sandbox. |

Claude Code's live sandboxed tool execution needs an authenticated worker home and a model call. It is exercised through the managed launch path in U4, under a recorded run budget.

## Daemon Mode

The daemon runs in exactly one mode per process, fixed at startup:

| Mode | How it starts | What runs |
| --- | --- | --- |
| Legacy | Default, or `MULTI_AGENT_MODE=legacy` | Upstream OpenRig behavior. Registering a managed run is refused. |
| Managed | `MULTI_AGENT_MODE=managed`, or automatically when the database already holds a managed run | Team control only. No legacy background service starts; every non-`/api/team-control` `/api/*` path returns HTTP 403 with `managed_control_required`, and legacy pages return HTTP 404. |

Any other `MULTI_AGENT_MODE` value stops the daemon at startup. Pass the owner control credential in `MULTI_AGENT_OWNER_TOKEN`; the daemon reads it and removes it from its environment before starting anything else.

Switching modes requires a daemon restart. Once a database holds a managed run, the daemon starts in managed mode from then on. Legacy tmux sessions that already exist when a managed daemon starts are left untouched; the managed daemon neither adopts nor stops them.

## Managed Attempt Credentials

The producer supplies everything an attempt needs, from owners the daemon already holds. Under `workers.isolation: hardened`, nothing here is provisioned by hand beyond `/etc/multi-agent/worker-policy.json` and the worker accounts; under `none`, the daemon creates all of it itself.

- **Worker control credential.** One token per `(run, session)`, minted when the attempt is admitted. Only its digest is durable (`team_worker_credentials`); the plaintext lives in the daemon process, reaches the sandbox only as `bootstrap.json` `authorization` (mode 0600 beside the mailbox socket), and is never written to a log, command line or projection. It is revoked when the attempt retires and at daemon startup, where every inherited digest names a token this process cannot honour. It authenticates that attempt's mailbox and its own control run scope, never an owner action.
- **Seat mailbox capability.** One `mailbox:{43}` per `(run, session)`, minted with the task assignment and stored in `team_seat_mailbox_capabilities`. The producer's endpoint and any later send for that seat must use this value; `poll` matches on it, so a second independently minted value would make the seat's mailbox unreadable. Deleting a row mints a fresh value on the next assignment, and messages still addressed to the old value become invisible.
- **Roots.** `context_root` and `mailbox_root` are read from `worker-policy.json` in the same composition that supplies `assignment_root`; the daemon refuses a policy whose `mailbox_root` is not `<control_state_dir>/mailboxes`.
- **Worker identity.** uid, gid, supplementary groups, home, scratch and the assignment directory are resolved from the policy plus `/etc/passwd` and `/etc/group`, which provisioning installs. A name absent from either is refused; the privileged launcher's own inspection remains the authoritative check at launch.

## Source Authority and Windows Export

The repository in WSL is the development source. Build and test in the task's own worktree or verification clone; leave the owner's working checkout alone. The preserved Windows copy changes only through the separately authorized one-way export described in `docs/development.md`.

Outside the repository:

- `~/.local/state/multi-agent/cutover/` holds the cutover record and the byte manifest of the Windows workspace.
- `~/.local/state/multi-agent/exports/` holds export records.
- `~/.cache/multi-agent/` holds the checksum-verified upstream archive.

Keep these directories when rolling back, because `engine/test/project-baseline.test.mjs` uses them to prove the Windows files were preserved.

## Rollback

To remove the worker boundary completely:

```bash
sudo rm -f /etc/sudoers.d/multi-agent-launcher /etc/sudoers.d/multi-agent-preflight
sudo rm -rf /usr/local/libexec/multi-agent /etc/multi-agent /opt/multi-agent
for u in ma-worker1 ma-worker2 ma-worker3 ma-control; do sudo userdel "$u"; done
# Only after preserving any evidence you still need:
sudo rm -rf /var/lib/multi-agent
```

The Windows workspace, `/etc/wsl.conf` and the owner account are never modified by provisioning.

## System health lights (KTD26)

The owner-only GET /api/team-control/health query is read-only. It reports ok, degraded, failed, or unknown for the database, queue/mailbox, control tmux, worker boundary, sandbox network, and locked clients. A probe is bounded by five seconds; a timeout is unknown and never ok. The response carries the check time and an evidence reference for each light.

- database: failed: preserve the database and WAL, stop managed dispatch, and check that the writer lock can be acquired and rolled back before restarting the daemon.
- queueMailbox: failed: preserve pending rows and receipts, stop new dispatch, and inspect the queue and mailbox repositories for a blocked or corrupt record.
- controlTmux: failed: leave recorded worker processes untouched, verify the control tmux socket and owned sessions, then reconcile each attempt before retrying.
- workerBoundary: failed: stop managed launch, preserve the preflight evidence, and verify the installed policy revision, fingerprint, worker identities, and per-worker sign-in evidence.
- sandboxNetwork: failed: stop managed launch, preserve the reachable-set receipt, and rerun the owner-approved network preflight after verifying the installed egress profile.
- clients: failed: do not update a worker in place; compare the installed executable hashes and versions with client-lock.json, then perform the owner-approved lock update and preflight.
- unknown: treat the component as unverified. Do not render it as healthy or start a managed attempt until the bounded check completes with an observed result.

## Reaching reviewers
Moved from `AGENTS.md` on 2026-10-26; the roster and review sizing stay there.
- `gpt-6.1-sol` runs through `codex exec -s read-only`. `ds/gpt-6-astra` supports the Responses API, so it runs through `codex exec -s read-only -m ds/gpt-6-astra`. The gateway requires the `ds/` prefix.
- `ds/claude-*` models run only through the Claude CLI (`claude -p --model ds/claude-...`), never through `/chat/completions`.
- If a stream drops, call the gateway's `/chat/completions` endpoint directly. Send system and user roles only, a client `User-Agent` header and a streamed response, with `reasoning_effort` set to `low`; the gateway ends any request at 300 seconds.
- A read-only `codex exec` cannot read the WSL checkout. Give each reviewer frozen, read-only copies of the diff, the touched files and the contract excerpt.
- Reach every model through the locally configured gateway. Never print or persist keys.

## Full daemon suite

This runs at project wrap-up or when the owner asks; tasks do not run it.

- Run it in a standalone clone with its own `npm ci` and a fresh `npm run build` of [`engine/packages/daemon`](../engine/packages/daemon) and [`engine/packages/cli`](../engine/packages/cli). Never use a linked worktree with symlinked `node_modules`, where daemon-spawn tests fail.
- Start it with no controlling terminal (`setsid -w … < /dev/null`, inside `tmux` when the session may be reaped). Unset `TMUX` and `TMUX_PANE` (`env -u TMUX -u TMUX_PANE`), or the hermetic scenario tests refuse to run. A test that opens an interactive shell can otherwise take the terminal, and the run then stops with SIGTTIN/SIGTTOU while looking hung.
- Put the Linux Node installation first on a clean `PATH` that excludes Windows binaries. From `engine/packages/daemon`, run `npx vitest run --maxWorkers=2 --testTimeout=60000`, one Vitest process at a time, and write a `.done` marker with the exit code on completion. Preserve the counts and failure details before cleaning up only the fixtures that run created.

## Automatic completion and review

The daemon observes each managed client's process end, validates its candidate and
records the task outcome. An implementer finishing is not enough to accept its work:
its patch must stay inside the assignment and its reviewer must approve it. Agents
cannot call an owner completion endpoint or merge into the owner's branch.

- Each native generation has one recorded attempt. Repeated receipt reads and stop
  observations update that attempt rather than creating another task or turn.
- A validated implementer outcome creates a reviewer task for that candidate. The
  daemon parses the reviewer's final findings and records its verdict. A reproduced
  P0/P1 sends the task back for rework; P2/P3 findings do not prevent approval.
- Each implementer task has its own review-round allowance. Exhaustion goes to the
  lead for a follow-up decision or escalation. A refused lead task list is returned
  to the lead with its reason, so the lead can revise it without an owner resubmission.
- Approval lands the candidate as a commit on the integration branch. Completed
  candidates can be read again after a daemon restart. Integration does not update
  the owner's checkout; the owner's Merge action does that.

The task drawer shows the attempts, worker reports, review findings and diff. Lead chat carries
questions and escalation answers. Owners do not mark each task done, transcribe
reviewer reports or approve each task list as part of this flow.

## Classifying a failed attempt (T033)

Failed attempts carry a KTD20 reason code, a `resume_safe` flag and retry eligibility.
The classifier in `engine/packages/daemon/src/domain/attempt-failure.ts` owns that
mapping; the completion path, task detail, health projection and continuation all
read it. A client can exit cleanly and still fail candidate validation; completion
then records `evidence_invalid` or `review_report_missing`.

- **Where the evidence comes from.** A direct launch sets the seat pane's `remain-on-exit` before the client starts, so a client that exits leaves the pane dead instead of destroying it (measured on tmux 3.6: without that option the pane, and a seat's only pane its session, is gone, with no exit status and no output). The completion sweep reads tmux's own `pane_dead` and `pane_dead_status` once, at the moment it records the stop, plus the pane's last lines.
- **How it decides.** A canceled run is `canceled` whatever the exit said. Otherwise a non-zero exit or a signal sends the last lines through a small set of fingerprints, each taken from output this repository already has evidence for. An exit status of 0 is a finished turn, so nothing it printed is the failure. A non-zero exit with nothing recognisable is `agent_error.unknown`. No exit record at all is no evidence, so no code is recorded — and an attempt with no code is never retried.
- **What it never does.** It adds no attempt and no unit of budget. It never retries an unknown code. A stored classification that disagrees with its own code's eligibility is refused when it is read, so a row cannot grant a retry KTD20 does not allow.
- **Automatic retry and Resume.** The completion path retries an eligible failure while the run has retry budget. Each retry spends that budget once. A failure that cannot be retried is routed to the lead; an unrecoverable lead failure blocks the run. After resolving the reason, the owner uses the Resume action described above.
- **`resume_safe: false`.** The dispatch that starts a reopened task clears the seat's saved native token first, so the next launch is a fresh native session in the same candidate tree, with every file the failed attempt wrote still there.
- `engine/demo/team/scripts/failure-demo.ts` proves both halves with a client that really fails: a refused connection is classified, retried once, fails again, and the second retry is refused on budget; a rejected key is classified and refused at once with the owner action.

| Reason code | Retry eligible | Response if work remains blocked |
| --- | --- | --- |
| `runtime_offline` | yes | Restore the runtime, then Resume the blocked run. |
| `daemon_recovery` | yes | Use Resume if daemon recovery left the run blocked. |
| `run_timeout` | yes | A wall-clock budget block needs Resume with `--add-minutes`. |
| `no_progress` | yes (`resume_safe: false`) | Discuss a narrower task with the lead; continuation starts a fresh session on the same tree. |
| `agent_error.provider_network` | yes | Restore provider connectivity; automatic retry applies while budget remains. |
| `evidence_invalid` | yes | Inspect the rejected candidate evidence if the automatic retry does not resolve it. |
| `review_report_missing` | yes | The reviewer did not return a readable findings report; automatic retry applies while budget remains. |
| `integration_conflict` | no | The lead needs to resolve the conflict against the integration head; replaying the same patch does not repair it. |
| `start_timeout` | no | Repair the client or seat before resuming a blocked run. |
| `environment_prepare_failed` | no | Repair the reported environment problem before Resume. |
| `resume_rejected` | no (`resume_safe: false`) | The saved continuation was rejected; the next attempt starts a fresh native session. |
| `agent_blocked` | no | Answer the lead's decision request; Resume if the run remains blocked. |
| `canceled` | no | Start New work if the canceled goal is still needed. |
| `agent_error.provider_auth_or_access` | no | Sign in or repair provider access before Resume. |
| `agent_error.provider_quota` | no | Add quota or wait for its reset before Resume. |
| `agent_error.provider_rate_limit` | no | Wait for the rate-limit window before Resume. |
| `agent_error.provider_server_error` | no | Wait for the provider to recover before Resume. |
| `agent_error.provider_invalid_request` | no (`resume_safe: false`) | Correct the task or client settings; the next attempt uses a fresh native session. |
| `agent_error.model_unavailable` | no | Select an available model in the client settings before Resume. |
| `agent_error.context_overflow` | no (`resume_safe: false`) | Ask the lead to narrow the work; continuation starts a fresh native session. |
| `agent_error.missing_config` | no | Supply the client configuration named by the failure before Resume. |
| `agent_error.missing_executable` | no | Install the client on the daemon's path before Resume. |
| `agent_error.unsupported_version` | no | Install the supported client build before Resume. |
| `agent_error.process_failure` | no | Inspect the attempt's failure before Resume. |
| `agent_error.unparseable_output` | no | Inspect the unreadable client output before Resume. |
| `agent_error.unknown` | no | Inspect the attempt evidence; an unknown failure is not retried automatically. |

`start_timeout` is reserved in the vocabulary: the completion path records no
attempt readiness phase to time out against yet.
