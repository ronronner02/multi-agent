# Multi-Agent architecture

> **This map is not the territory.** It is a zoomed-out guide for finding your way around the
> code. It is incomplete by design and it may be stale. Where it disagrees with the code, the code
> is right; please fix the page. Every path, symbol, count and command below was checked against
> commit `c750304f` (0.6.6 development). Each count shows the command that produced it, so you
> can re-run it.

## What Multi-Agent is

Multi-Agent runs a team of coding agents on your machine as one system. A local daemon keeps the team's
state in SQLite and runs each agent as an ordinary Claude Code or Codex session (or a plain
terminal, a Pi or Oh My Pi (OMP) runner, or a scripted test stub) inside tmux. People and agents drive it through the
`rig` CLI and an MCP server, both of which talk to the daemon over local HTTP, plus the Web UI the
daemon serves.
The agents themselves are unmodified. What Multi-Agent adds is the coordination around them: launching
and restoring agents, delivering messages, keeping durable work in a queue, and giving each agent
the right skills and context.

## Packages

| Directory | Package | What it is | How it ships |
|---|---|---|---|
| `packages/daemon` | `@multi-agent/daemon` (private) | The daemon: HTTP routes, domain services, SQLite migrations, runtime adapters, built-in specs, skills, plugins, static context-pack sources | Copied into `@multi-agent/cli` |
| `packages/cli` | `@multi-agent/cli` | The `rig` command, the MCP server, daemon start and stop | The only published package |
| `packages/ui` | `@multi-agent/ui` (private) | The React Web UI, including the team dashboard at `/team` | Built files copied into `@multi-agent/cli` and served by the daemon |
| `packages/test-system` | none (not an npm workspace) | The stub-agent scenario library, the CI scenario harness, live-model eval cases | Not shipped |

**What bundles what.** `packages/cli/package.json` publishes `LICENSE`, `dist`, `daemon`, `ui`
and `scripts`. `scripts/build-package.sh` (the CLI's `prepublishOnly`) builds the daemon, UI and
CLI, then assembles them inside `packages/cli/`: the daemon's `dist`, `assets`, `specs` and
`policies`, the generated context packs and a copy of `docs/reference/` go under `daemon/`; the UI
build goes to `ui/dist`. So `docs/reference/` ships to every user; `docs/as-built/` and this file
do not.

**Sharing code between packages.** The CLI imports daemon code only through the subpaths in
the `exports` field of `packages/daemon/package.json` (21 at this commit), for example
`@multi-agent/daemon/attention`, which points at `packages/daemon/src/attention-surface.ts`. In
development they resolve through the npm workspace. At
package time `scripts/rewrite-daemon-imports.mjs` rewrites them to the shipped `daemon/dist` copy
and fails the build on a specifier with no `exports` entry. To share new daemon code, add a
`*-surface.ts` file and an `exports` entry.

## The request path

```
  rig (CLI)                     MCP server (multi-agent mcp serve, stdio)
       \                                /
        +---- HTTP to the daemon (port 7433 by default) --------------+
                                |
  packages/daemon/src/server.ts      createApp(): context middleware, /healthz, app.route("/api/...")
                                |
  packages/daemon/src/routes/        one Hono router per area; reads services with c.get(...)
                                |
  packages/daemon/src/domain/        services, repositories, orchestrators, event bus
              /                 |                  \
     SQLite (db/)       tmux (adapters/tmux.ts)    runtime adapters (adapters/*-adapter.ts)
                                                     claude-code, codex, pi, omp, terminal, stub
```

**Inside the daemon** (`packages/daemon/src/`):

- **Startup.** `index.ts` is the process entry: it resolves where to listen, starts the server and
  runs the periodic queue sweeps. It calls `createDaemon()` in `startup.ts`, which opens the
  database (`db/connection.ts`: WAL mode, foreign keys on), runs `migrate(db, ALL_MIGRATIONS)`,
  constructs every service and adapter, and passes them to `createAppWithWebSocket(deps)` in
  `server.ts`.
- **`server.ts`.** In `createApp(deps)`, an early `app.use("*", ...)` middleware (after the
  request-phase observer and the JSON body-parse tracker) puts each
  service on the request context (`c.set("<name>" as never, deps.<name>)`), serves `/healthz`, and
  mounts each router with `app.route("/api/<area>", ...)`. Unknown `/api/*` paths get a JSON 404;
  other GET requests serve the web UI's built files.
- **`routes/`.** Thin handlers. For example, `routes/ps.ts` reads `psProjectionService` from the
  context and returns its entries as JSON. `routes/terminal-ws.ts` registers the terminal
  WebSocket, and `routes/require-sender-identity.ts` is a shared helper rather than a router.
- **`domain/`.** The behaviour: repositories over SQLite (`rig-repository.ts`,
  `queue-repository.ts`, `session-registry.ts`), orchestration (`startup-orchestrator.ts`,
  `node-launcher.ts`, `rigspec-instantiator.ts`), message delivery (`session-transport.ts`,
  `seat-delivery-guard.ts`) and events (`event-bus.ts`). Larger areas have their own
  subdirectories, such as `gateway/`, `provider/`, `policies/`, `scope/`, `context-packs/` and
  `mission-control/`.
- **`adapters/`.** The outside world. `tmux.ts` wraps tmux. The six `RuntimeAdapter`
  implementations (OMP's extends Pi's) launch each runtime and project skills and files into it. `cmux.ts` and
  `compose-services-adapter.ts` cover other integrations.
- **`db/`.** `connection.ts` and the atomic fresh schema in `baseline.ts`.
- **`middleware/auth-bearer-token.ts`.** The bearer-token check for operator write routes, plus
  the loopback and Tailscale bind detection used at startup.
- **Live updates** go out as server-sent events: `routes/events.ts` uses Hono's `streamSSE`.
- **State** lives in `$MULTI_AGENT_HOME` (default `~/.multi-agent`). The database is `multi-agent.sqlite`
  there (`daemon-db-path.ts`).

**The clients:**

- **CLI.** `createProgram()` in `packages/cli/src/index.ts` registers every top-level command;
  the commands live in `packages/cli/src/commands/`. Most are thin clients: they call a daemon route
  through `DaemonClient` (`packages/cli/src/client.ts`) and render the result. A few lifecycle
  (`packages/cli/src/front-door.ts`).
- **MCP.** `createMcpServer(client)` in `packages/cli/src/mcp-server.ts` registers the tools over
  the same `DaemonClient`. `multi-agent mcp serve` (`packages/cli/src/commands/mcp.ts`) runs it on stdio.
- **Web UI.** Served by the daemon from the bundled `ui/dist`.

**In a development checkout,** `multi-agent daemon start` prefers `packages/daemon/dist` over the bundled
copy (`resolveDaemonPath` in `packages/cli/src/daemon-lifecycle.ts`). Rebuild the package you changed. A daemon
that is already running keeps running the code it started with.

## Key counts

At commit `c750304f`. Run these from the repository root to refresh them.

| What | Count | Command |
|---|---|---|
| Database migrations | 94 files (latest: `095_rig_non_interruptive.ts`; there is no 093) | `git ls-files packages/daemon/src/db/migrations \| wc -l` |
| Files in `routes/` | 67 | `git ls-files packages/daemon/src/routes \| wc -l` |
| ... of which create a Hono router | 65 | `git grep -l 'new Hono' -- packages/daemon/src/routes \| wc -l` |
| `app.route(...)` mounts in `server.ts` | 69 | `grep -c 'app.route(' packages/daemon/src/server.ts` |
| Top-level `rig` commands | 87 | `grep -c 'program.addCommand(' packages/cli/src/index.ts` |
| Runtime adapters | 6 (`claude-code`, `codex`, `pi`, `omp`, `terminal`, `stub`); the command counts 5 because `OmpRuntimeAdapter` extends `PiRuntimeAdapter` | `git grep -l 'implements RuntimeAdapter' packages/daemon/src \| wc -l` |
| MCP tools | 18 | `grep -c 'server.tool(' packages/cli/src/mcp-server.ts` |
| Daemon `exports` subpaths | 21 | `node -p 'Object.keys(require("./packages/daemon/package.json").exports).length'` |
| Library scenarios | 15 | `grep -l '^scenario:' packages/test-system/scenarios/*.yaml \| wc -l` |

## Where to add things

Each recipe names the files to touch. Read a neighbouring example before you start; the code is
the authority.

### A CLI command

1. Create `packages/cli/src/commands/<name>.ts` exporting a function that returns a commander
   `Command` and takes optional injected dependencies. `packages/cli/src/commands/unarchive.ts`
   is a short example.
2. In the action, get the daemon with `getDaemonStatus(...)` and `daemonStatusGuard(status)`
   (`packages/cli/src/daemon-lifecycle.ts`), then call it with
   `new DaemonClient(getDaemonUrl(status))` (`packages/cli/src/client.ts`). Offer `--json` for
   agents, and set `process.exitCode` on failure.
3. Register it in `createProgram()` in `packages/cli/src/index.ts` with
   `program.addCommand(...)`. If it takes injected dependencies, add them to `ProgramDeps` in the
   same file.
4. Add `packages/cli/test/<name>.test.ts`. `packages/cli/test/archive.test.ts` shows how tests
   inject mocked lifecycle dependencies.
5. If the command needs new daemon behaviour, add a route as well.

### A daemon route

1. Create `packages/daemon/src/routes/<area>.ts` with a Hono router. Both styles exist: a
   constant (`export const psRoutes = new Hono()` in `routes/ps.ts`) and a factory
   (`whoamiRoutes()` in `routes/whoami.ts`).
2. Read services from the request context with `c.get("<name>" as never)`. Keep the behaviour in
   `packages/daemon/src/domain/`.
3. Mount it in `createApp()` in `packages/daemon/src/server.ts` with
   `app.route("/api/<area>", ...)`, above the `/api/*` 404 catch-all.
4. A new service needs three more edits: a field on `AppDeps` and a `c.set(...)` line in
   `server.ts`, and its construction in `createDaemon()` in `packages/daemon/src/startup.ts`.
5. Test it the way `packages/daemon/test/whoami-routes.test.ts` does: build a small Hono app,
   `c.set` the service, mount the router and call `app.request(...)`. `createFullTestDb()` in
   `packages/daemon/test/helpers/test-app.ts` gives you an in-memory database initialized with the same baseline as startup.

### The database baseline

`packages/daemon/src/db/baseline.ts` creates the retained schema in one transaction and
records `PRAGMA user_version = 1` in that transaction. Startup inspects existing files
read-only before configuring their journal or opening application repositories. Files
with tables and no baseline marker fail with `legacy_database` and their filename;
the daemon does not migrate their data. Empty files are initialized, and marked files
reopen normally. `createFullTestDb()` uses the same initializer.

Schema changes must update the baseline and its focused tests. There is no upgrade
runner or migration registry; any future persisted-schema compatibility contract
requires an explicit decision.

### A runtime adapter

1. Implement `RuntimeAdapter` from `packages/daemon/src/domain/runtime-adapter.ts`: `runtime`,
   `listInstalled`, `project`, `deliverStartup`, `launchHarness` and `checkReady`. The smallest
   implementation is `packages/daemon/src/adapters/terminal-adapter.ts`; the scripted test double
   is `stub-runtime-adapter.ts`.
2. Register it in `packages/daemon/src/startup.ts`. The adapter maps are keyed by runtime name:
   `adapters:` (for the pod instantiator) and `runtimeAdapters:`. The context monitor has its own
   map for the runtimes it samples.
3. Accept the runtime name in multi-agent spec validation: `SUPPORTED_RUNTIMES` in
   `packages/daemon/src/domain/rigspec-preflight.ts`. Other runtime lists, such as `RuntimeHint` in
   `domain/discovery-types.ts` and `LEGACY_KNOWN_RUNTIMES` in `domain/rigspec-schema.ts`, may need
   it too; search for an existing runtime name such as `"pi"` to find them.
4. Launch, projection and readiness are arteries. Read
   [docs/as-built/arteries.md](docs/as-built/arteries.md) first.

### A shipped skill

Skills ship from three copies in this repository (the "edges"), listed in
`scripts/skill-edge-layout.generated.json`:

| Edge | Path | Layout |
|---|---|---|
| `spec` | `packages/daemon/specs/agents/shared/skills/` | by category (`core`, `pm`, `pods`, `process`) |
| `plugin` | `packages/daemon/assets/plugins/multi-agent-core/skills/` | flat |
| `canonical` | `skills/_canonical/` | public mirror of the `spec` copy |

Each skill in the layout file lists which edges carry it. At this commit, 33 skills are in `spec`
and `canonical`, 17 only in `plugin`, and 2 in all three.

- `npm run mirror-skills:check` (part of `npm test`) hashes every file in each edge and compares the
  hashes with `scripts/skill-edge-digests.generated.json`. It also fails on a `SKILL.md` the layout
  does not list.
- `npm run mirror-skills` regenerates the canonical and plugin edges from the repository's
  `packages/daemon/specs/agents/shared/skills` source and product policy JSON.
- **To fix a skill:** edit every edge that carries it, run
  `node scripts/regen-edge-digests.mjs`, then run `npm run mirror-skills:check`.
- **To add a skill:** update the product policy and generated layout together.
- Every shipped skill also becomes a context pack at package time (next recipe).

### A context pack

- **Static packs** are hand-written: a directory under `packages/daemon/context-packs-src/<name>/`
  with a `manifest.yaml` and its files. Keep `version: "0"` in the manifest; the generator stamps
  the package version. A pack file may be a symlink to a file under `docs/reference/`, so a
  reference document has one source (for example `help/help.md` points to
  `docs/reference/help.md`). Any other symlink fails the build. There are 5 static packs at this
  commit.
- **Generated packs** go to `packages/daemon/context-packs/`, which is gitignored and never edited
  by hand. `scripts/generate-context-packs.mjs` builds it at package time from every shipped skill
  and every static pack.
- `npm run generate-context-packs:check` (part of `npm test`) validates every pack through the
  daemon's own manifest parser, so build the daemon first. It also runs the leak scan over the
  static sources, including the `docs/reference/` files they link to.
- The daemon serves the shipped packs through `multi-agent context get`; `startup.ts` registers the bundled
  directory as its built-in root.

### A scenario

Scenarios run the real CLI, daemon, tmux and SQLite with scripted stub agents (`runtime: stub`)
and no model cost.

1. Add `packages/test-system/scenarios/<defect-class>.yaml`, named for the class of bug it
   catches. Topology fixtures sit beside it (`*-stub.yaml`).
2. The format is checked by `validateScenario` in
   `packages/daemon/test/helpers/scenario-schema.ts`. Step verbs: `up`, `down`, `send`, `restart`,
   `restore`, `emit`, `mutate`, `policy`, `seed_regression`, `daemon`, plus `expect`. `expect` may
   only read shipped surfaces: `ps`, `queue`, `stream`, `scope`, `pane`, `transcript`,
   `policy_provenance`.
3. Today the runner binds `up`, `down`, `send`, `restart` and `daemon`. `restore`, `emit`,
   `mutate` and `policy` fail with `UnboundActionError`, and `seed_regression` needs a fault
   controller (`packages/daemon/test/helpers/scenario-real-deps.ts`).
4. Write a header comment naming the defect class and the seed: what a seeded regression plants,
   and which `expect` must catch it. A scenario counts only as a pair: it passes on healthy code
   and fails on the seeded run (`packages/test-system/README.md`).
5. **Run it on your machine** after `npm run build`:
   `node --import tsx packages/daemon/scripts/run-scenarios.mjs <file.yaml>`. It uses a private
   daemon and a private tmux server, and builds its environment from `HOME`, `PATH` and `TERM`
   only, so your session's `TMUX` and daemon variables are dropped and it is safe to run from
   inside tmux, including an agent's pane. It supplies no fault controller, so a
   `seed_regression` step fails there; the seeded pair runs in the container path.
6. **CI.** The `installed-scenario` job runs `scripts/run-pr-scenarios.sh` in disposable,
   network-less containers built from the packed package. It runs four cases: `fixture` and `library`
   (`queue-baton-survives-restart.yaml`), each with a healthy run and a seeded lost-baton run, plus
   `transcript` and `capture`, healthy runs only. Adding a seeded case means changing three files:
   the `--case` list in `scripts/run-pr-scenarios.sh`, `CASES` in
   `packages/test-system/ci/result.mjs`, and the fault controller in
   `packages/test-system/ci/run.mjs`; a healthy-only case goes in `PASSING_CASES` in the first two
   and needs no fault controller. [docs/as-built/test-layers.md](docs/as-built/test-layers.md)
   covers both run modes, running a case on your own Docker host, and what a stub can and cannot
   prove.

## Guards you will meet

`npm test` runs `test:repo` (builds the daemon, runs `node --test scripts/*.test.mjs`, the docs
guard, `mirror-skills --check` and `generate-context-packs --check`) and then the daemon and CLI
suites. `npm run test:ui` runs the web UI suite separately. `npm run lint` typechecks all three
packages.

- **Docs guard** (`scripts/check-docs-guard.mjs`). Under `docs/`, git may track only
  `docs/as-built/`, `docs/reference/`, `docs/releases/` and exactly `docs/DESIGN.md`;
  `.gitignore` ignores the rest of `docs/`. Remember that `docs/reference/` ships inside the npm
  package, and the daemon copies its Markdown files to `$MULTI_AGENT_HOME/reference/` when it
  starts. Files in `docs/as-built/` carry a `last-verified-against-source` commit in their
  frontmatter.
- **Internal-leak guard** (`scripts/internal-leak-scanner.mjs`, with rules in
  `scripts/internal-tokens.generated.json`). It refuses maintainer-internal names and paths in
  content that ships. It runs in `generate-context-packs.mjs` (static pack sources, on every
  `npm test`), in the full skill mirror apply (each public skill), in `scripts/build-package.sh`
  (the daemon `specs/` tree before it is copied into the package), and in the release-time
  substance gate (`scripts/check-substance-gate.mjs`, `npm run gate:substance`) over the packed
  CLI. No workflow runs it over a pull request's whole diff.
- **Portability report** (`.github/workflows/portability-report.yml`, running
  `scripts/portability-report.mjs`). On each pull request it lists added lines containing
  machine-specific values: credentials, home and temporary paths, network addresses, email
  addresses. It never fails the job; you read it and decide.
- **Generated files.** Do not hand-edit `scripts/*.generated.json` or anything under
  `packages/daemon/context-packs/`. The skill-edge digests are the one generated file a contributor
  refreshes, with `node scripts/regen-edge-digests.mjs` (see "A shipped skill").
  The internal-token rules support optional `allowed_context_lines` for reviewed generic
  examples: the complete line must match exactly, including indentation and case. Unlike
  `allowed_context_substrings`, this does not exempt a line with added or substituted text;
  internal-path checks and the substance gate's human-review dispositions still apply.
- **Hosted CI** (`.github/workflows/tests.yml`): `build-and-package`, `typecheck`, `repo-checks`,
  `package-tests` (macOS; daemon, CLI and UI suites with no credentials and no external
  network) and `installed-scenario`.

## Pointers

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, what a pull request needs, what to expect from review.
- [docs/reference/developing.md](docs/reference/developing.md): which checks block and which are
  advisory, and what `.github/workflows/tests.yml` runs.
- [docs/reference/worktree-builds.md](docs/reference/worktree-builds.md): building in a git
  worktree, with its own `npm ci` rather than a symlinked `node_modules`.
- [docs/reference/](docs/reference/): user and operator reference; it ships with the package.
- [docs/as-built/](docs/as-built/README.md): module-by-module descriptions of the system. **These
  are being re-verified for 0.6.6.** Each page's `last-verified-against-source` names the commit it was
  checked against; until a page is re-verified, treat its counts as historical. Use them for
  orientation, then check the code.
- [docs/as-built/test-layers.md](docs/as-built/test-layers.md): what each test layer covers and
  what it cannot catch.
- [docs/as-built/arteries.md](docs/as-built/arteries.md): the areas where a small change has a
  large effect, what depends on them, and what broke there before.
- [packages/test-system/ci/README.md](packages/test-system/ci/README.md): the CI scenario job.
- [docs/releases/](docs/releases/) and [CHANGELOG.md](CHANGELOG.md): release history, written by
  the maintainers at release time.
