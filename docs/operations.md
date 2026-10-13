# Operations

Local runbook for the multi-agent engineering team milestone. Commands run inside the WSL Ubuntu distribution unless stated otherwise.

## Identities and Boundaries

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
- **Network namespace is shared** (`sandbox.network: host-shared`) because the native clients need outbound provider access, and no user-mode network stack is packaged for this release. Workers can therefore reach loopback TCP listeners and host abstract unix sockets. Control-plane services must use authenticated loopback listeners or path-based unix sockets under the control state directory, and must never use abstract sockets. The preflight receipt records how many abstract sockets are visible.
- **Interactive panes rely on the kernel TIOCSTI restriction.** Interactive sessions keep the tmux pane as their controlling terminal. The launcher refuses to start one unless `dev.tty.legacy_tiocsti` is `0`.

## Host Provisioning

Owner-run and idempotent. It requires the owner's sudo password and network access to `nodejs.org` and `registry.npmjs.org`.

```bash
sudo bash engine/config/isolation/provision-host.sh --preflight-owner "$USER"
```

It installs:

- Host packages: `bubblewrap`, `tmux`, `util-linux`, `socat`, `acl`, `curl`, `xz-utils`, `ca-certificates`.
- Node.js `v24.21.0` from the official tarball, verified against a pinned SHA-256, into `/opt/multi-agent/toolchain/node`.
- `@anthropic-ai/claude-code@2.1.296` and `@openai/codex@0.160.0` into `/opt/multi-agent/toolchain/clients`. npm lifecycle scripts are disabled. The only shipped lifecycle script, Claude Code's `install.cjs`, was audited (it copies the bundled platform binary locally) and is run explicitly. Codex ships no lifecycle scripts.
- The `ma-control` and `ma-worker*` identities, and `/var/lib/multi-agent/{control,workers,assignments}` with the modes listed above. Assignment directories are `<worker>:ma-control 2770`, with default ACLs so control can stage trees that the worker can edit.
- The launcher, its `/bin/sh` wrapper (which clears the environment except `SUDO_UID`) and the policy, all root-owned.
- `/etc/sudoers.d/multi-agent-launcher`: `ma-control ALL=(root) NOPASSWD: /usr/local/libexec/multi-agent/worker-launch`.
- With `--preflight-owner`: `/etc/sudoers.d/multi-agent-preflight`, which lets that login act as the control and worker identities without a password so the harness can stage control-owned sentinels. **Remove it after preflight:**

```bash
sudo rm /etc/sudoers.d/multi-agent-preflight
```

Re-run provisioning after any change to `engine/config/isolation/`. The preflight compares installed hashes with the sources and fails on drift.

The script does not auto-upgrade the clients. To change a pinned version, edit the script, re-run it, then re-run the preflight.

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
- that a Windows process reaches a WSL listener bound to `127.0.0.1`, and that the listener is not bound to other interfaces.

Missing tools, identities, launcher installation, kernel capability or preflight access fail every host check with a distinct `blocked by prerequisites:` code. Fix the prerequisite; never weaken the policy. A redacted receipt (facts, installed hashes and probe outcomes, but no sentinel contents) is written to `${XDG_STATE_HOME:-~/.local/state}/multi-agent/preflight/<run>.json`, outside the repository.

### Recorded Result (2026-10-13)

The host preflight passed 29/29 checks against policy revision 2, with no prerequisite or fixture blockers. The receipt is `preflight-8a55c69d.json`.

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
| Loopback | A Windows process reaches a WSL listener on `127.0.0.1` (HTTP 200); the listener is bound only to `127.0.0.1`. |
| Limitation | 6 host abstract unix sockets are visible inside the sandbox because the network namespace is shared (see Known boundary properties). |

Claude Code's live sandboxed tool execution needs an authenticated worker home and a model call. It is exercised through the managed launch path in U4, under a recorded run budget.

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
