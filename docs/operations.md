# Operations

Local runbook for the multi-agent engineering team milestone. Commands run inside the WSL Ubuntu distribution unless stated otherwise.

## Worker Isolation

`workers.isolation` selects how a managed worker runs. It is read once at daemon startup, so a change applies on the next restart.

| Value | What runs |
| --- | --- |
| `none` (default) | The native client runs as the daemon's own user, inside the task's candidate git worktree, in the seat's tmux pane. No host provisioning, sudo, extra accounts or sandbox. |
| `hardened` | The existing restricted worker launcher. Requires the `ma-*` accounts, the installed policy and sudo, all from the provisioning step below. |

Under `none`, the daemon keeps its state under `$OPENRIG_HOME/state/workers/`: `assignments/<worker>/<run>-<task>` for candidate worktrees, `context/<worker>/<run>/<attempt>` for attempt projections, and `$OPENRIG_HOME/sock/<worker>/<run>/<attempt>/mailbox.sock` for mailbox endpoints (kept shallow because an AF_UNIX path is limited to 108 bytes). Nothing in that path reads `/etc/multi-agent`, `/opt/multi-agent`, `/run/multi-agent` or `/usr/local/libexec/multi-agent`, and no launch calls sudo.

The isolation is a boundary between tasks, not between the worker and the host: a worker under `none` has the daemon's full filesystem access, its network and its environment. The receipt records `network.mode: "unknown"` because no profile is enforced. Use `hardened` where that matters.

The three health lights that describe the hardened boundary (`workerBoundary`, `sandboxNetwork`, `clients`) report `unknown` with the reason `workers_isolation_none` in this mode, rather than reading files nothing enforces.

## Identities and Boundaries

The table and the boundary description below apply to `workers.isolation: hardened`.

| Identity | Purpose | Notes |
| --- | --- | --- |
| Owner login (for example `leo`) | Owner TUI, owner browser, owner terminal host | The only approval authority. Never used for agent sessions. |
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

The WSL checkout `/home/leo/src/multi-agent` is the only development source. Provision, preflight, build and test from that checkout. `D:\Multi-Agent` is a preserved read-only copy; it changes only through the one-way export described in `docs/development.md`.

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
- Run it in a standalone clone with its own `npm ci` and a fresh `npm run build` of `packages/daemon` and `packages/cli`. Never use a linked worktree with symlinked `node_modules`, where daemon-spawn tests fail.
- Start it with no controlling terminal (`setsid -w … < /dev/null`, inside `tmux` when the session may be reaped). Unset `TMUX` and `TMUX_PANE` (`env -u TMUX -u TMUX_PANE`), or the hermetic scenario tests refuse to run. A test that opens an interactive shell can otherwise take the terminal, and the run then stops with SIGTTIN/SIGTTOU while looking hung.
- Use `--maxWorkers=2 --testTimeout=60000`, run one suite at a time, and write a `.done` marker on exit.

## Starting team work (MVP slice 2)
`POST /api/team-control/runs` is the owner action that creates a run and the task that puts one agent on a goal. `GET /api/team-control/runs` lists the runs that exist, so no client has to ask for an id. Both are owner-only on the team-control surface, so the managed-mode allowlist and the owner credential apply unchanged.
- The start request names the goal, and optionally the rig, the seat, the repository and the write scope. Every default is read from what the daemon already runs: the only active rig, that rig's first agent node, its cwd, `plan.md`, and `src`.
- The binding is read from the repository at the moment of the request: the canonical root, the plan artifact's exact bytes, and the commit they are approved at. A repository with no commit is refused, because the contract cannot name an identity for it.
- The endpoint proposes the implementation approval for that binding and records the owner's own control session as the decision, then creates the task. A run whose approval or task is refused keeps its row, so the refusal is readable instead of silent.
- Under `workers.isolation: none` the daemon has no installed policy, so a new binding is approved against the unisolated roots' revision, a fingerprint naming the isolation mode, and the clients the daemon may start by name. Dispatch then refuses a binding built for any other mode, which is the same check that already guards a launch.
- `rig team start "<goal>"` calls the endpoint with the owner credential and prints the run id plus the TUI and Web commands that watch it. The Web UI's "New task" form and run list call the same endpoint.
- `engine/demo/team/run.sh` proves the flow without a provider account: it seeds the demo rig, boots a managed daemon with the compiled stub runner, starts a run, and reads the created task back from the run's own projection.
