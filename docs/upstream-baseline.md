# Upstream Baseline

`engine/` is a maintained import of OpenRig (KTD1). This page records where it came from, what was imported, what has been changed since, and how to re-verify all of it.

## Provenance

| Item | Value |
| --- | --- |
| Repository | [`mvschwarz/openrig`](https://github.com/mvschwarz/openrig) |
| Commit | `cb79b8c980ec120c8db28d5aaf2c4bb3cc540c61` (2026-10-13, "fix: distinguish intentional seat stops in rig health (#1192)") |
| Upstream manifest version | `0.6.10`. This default-branch commit is not claimed to equal the `0.6.10` release tag. |
| License | Apache-2.0, retained at `engine/LICENSE`. Upstream ships no `NOTICE` file. |
| Archive | `https://codeload.github.com/mvschwarz/openrig/tar.gz/cb79b8c…`, sha256 `9bb71fc7a227bbe311c1fe14a34483ecdcf2e6966817a9704460713f9489694b` |
| Import manifest digest | `8efe21ebbf4e9994c8b18b362d41fc76b120f36db8a03a3ea653013493e4ef82` (3,548 files, 5 symlinks) |

## Import Set

The owner approved the full upstream tree except three directories (18 archive entries):

| Excluded | Reason |
| --- | --- |
| `.agents/`, `.claude/` | Upstream's own agent-instruction mirrors. Native clients working in this repository would load them as nested instructions, which the plan forbids ("no unintended ancestor/global content"). |
| `.github/` | CI workflows and templates. They are inert below the repository root, and no remote CI is activated in this milestone. |

Everything else, including inactive components (`demo/`, `docker/`, `assets/`), is kept verbatim. Upstream's `engine/.gitignore` ignores `docs/*`, so the upstream-tracked `engine/docs/DESIGN.md` is force-added.

The archive audit (`tools/upstream-import.mjs`) found no entry that escapes the root and no hardlinks or devices. All five symlinks are `engine/packages/daemon/context-packs-src/{help,reference}/*.md -> ../../../../docs/reference/*.md` and resolve inside the import.

## Install-Time Scripts

| Package | Script | Audit | Status |
| --- | --- | --- | --- |
| `@openrig/cli` (workspace) | `postinstall: node scripts/check-abi.mjs` | Loads `better-sqlite3` in a child process to report Node/ABI problems. No network access or writes. | Runs (workspace scripts are not gated). |
| `better-sqlite3@13.0.3` | `install: node-gyp rebuild` (npm's default for packages with a `binding.gyp`) | Sets up the package's shipped, lockfile-pinned `prebuilds/linux-x64.node`. node-gyp needs `make`, `g++` and `python3`. | Approved in `allowScripts`. |
| `esbuild@0.27.4`, `esbuild@0.25.12` (via vite) | `postinstall: node install.js` | Validates and optimizes the lockfile-pinned `@esbuild/linux-x64` binary. It falls back to `npm install` or a direct download only when that platform package is missing. | Approved in `allowScripts`. |
| `fsevents@2.3.3` | native build | macOS only; never installed on Linux. | Not applicable. |

npm 11 blocks dependency install scripts that `allowScripts` does not approve. Approvals are pinned to exact versions, so a dependency update needs a fresh audit and approval (`npm install-scripts ls`, then `npm install-scripts approve <pkg>`).

## Adaptations

Imported files changed on purpose. Each is declared in `PIN.adapted` in `tools/upstream-import.mjs`, so verification reports it as adapted rather than drifted.

| File | Change | Why |
| --- | --- | --- |
| `engine/package.json` | `version` 0.6.10 -> 0.1.0; adds `allowScripts` | Application version for this milestone; the approved install scripts above. |
| `engine/packages/{cli,daemon,ui}/package.json` | `version` 0.6.10 -> 0.1.0 | Same application version. Package identifiers (`@openrig/*`) are kept. `tui` was already 0.1.0. |
| `engine/package-lock.json` | Workspace version fields | Lockfile kept in sync with the manifests. |

## Source Owners for Planned Work

Before the import, the plan named several owners in shorthand. These are the imported files they refer to. The plan's U-IDs authorize them; the derived task pack does not list the adapter files, so regenerate it before relying on its file lists.

| Plan reference | Imported owner(s) |
| --- | --- |
| Native adapter contract | `packages/daemon/src/domain/runtime-adapter.ts` |
| Claude / Codex adapters | `packages/daemon/src/adapters/claude-code-adapter.ts`, `claude-resume.ts`, `claude-resume-launch.ts`; `codex-runtime-adapter.ts`, `codex-resume.ts` |
| tmux adapter | `packages/daemon/src/adapters/tmux.ts`, `tmux-exec.ts`, `tmux-server.ts` |
| Broad-access defaults | `packages/daemon/src/adapters/kernel-authority.ts`, `yolo-mode.ts` |
| Queue owner and pickup | `packages/daemon/src/domain/queue-repository.ts`, `queue-recovery.ts`, `queue-waiting.ts`, `queue-stuck-sweep.ts`, `policies/idle-gate-qitem.ts`, `workflow-runtime.ts` |
| Chat / event replay | `packages/daemon/src/domain/chat-repository.ts`, `routes/chat.ts`, `domain/event-bus.ts` |
| Browser / terminal surfaces | `packages/daemon/src/server.ts`, `middleware/browser-boundary.ts`, `middleware/auth-bearer-token.ts`, `routes/terminal-ws.ts`, `terminal/TerminalSessionBroker.ts` |
| Persistence | `packages/daemon/src/db/all-migrations.ts`. The latest imported migration is `103_session_stop_intent.ts`, so planned migrations start at `104`. |

All 42 pre-existing files that the task pack declares exist in the import. The other 85 declared paths are new files that later tasks create.

## Verify

```bash
node tools/upstream-import.mjs verify                  # 0 missing, 0 changed, 0 extra; only declared adaptations differ
node --test engine/test/project-baseline.test.mjs      # importer, exporter, pinned-manifest and cutover checks
```

`verify` re-downloads the archive into `~/.cache/multi-agent/` the first time, and keeps it only after the checksum matches.
