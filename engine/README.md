# Multi-Agent engine

The local engine for the Multi-Agent desktop and optional browser viewer. It runs
on native Windows 10/11 x64 and Linux with Node.js 22 or 24 and Git. The desktop
owns the engine process and connects over a dynamically assigned loopback port.

```sh
npm ci --no-audit --no-fund
npm run build
npm run lint
npm run smoke
```

The workspaces are `@multi-agent/daemon`, `@multi-agent/cli`, `@multi-agent/ui`, and
`@multi-agent/i18n`. The executable is `multi-agent`; its commands are `daemon`,
`team`, and `github`. Run `node packages/cli/dist/index.js --help` after building.

Mutable state defaults to `%LOCALAPPDATA%\Multi-Agent` on Windows; configuration
uses `%APPDATA%\Multi-Agent`. Other platforms use `~/.multi-agent` for both.
`MULTI_AGENT_HOME` overrides both roots. A fresh engine creates `multi-agent.sqlite`.
The desktop uses its own data root's `engine` subdirectory as the engine home.
Existing data from previous product names is never discovered or migrated.

See the [project quick start](../README.md), [operations](../docs/operations.md), and
[desktop instructions](../desktop/README.md) for first run, dependency detection,
GitHub sign-in, browser pairing, cancellation, and recovery.

Copyright and license terms remain in [LICENSE](LICENSE); the historical import
record remains in [the upstream baseline](../docs/validation/upstream-baseline.md).
