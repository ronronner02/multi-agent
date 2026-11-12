# Security policy

## Supported versions

Only the latest published version on npm (`@multi-agent/cli`) is supported. Fixes are developed on
`main` and released after verification; a merged fix is not necessarily in the published package.
Include the affected version even when reporting a problem in an older installation.

## What Multi-Agent touches

Multi-Agent runs a local daemon, drives coding agents in tmux sessions on your machine, and writes
configuration for those harnesses, including workspace trust records and executable hooks: for
example `~/.claude.json`, skills under `~/.claude`, `$CODEX_HOME/config.toml` (default `~/.codex`),
and, in the project, `.claude/settings.local.json`, `.mcp.json` and managed blocks in `CLAUDE.md`,
`CLAUDE.local.md` or `AGENTS.md`. `multi-agent setup` also edits `~/.tmux.conf` and, on macOS, cmux's
settings. Multi-Agent's own state lives under `$MULTI_AGENT_HOME` (default `~/.multi-agent`). The README
section [What Multi-Agent changes on your machine](README.md#what-multi-agent-changes-on-your-machine)
describes these effects and the trust/permission choices. Unexpected access, disclosure or
permission changes are useful reports; include what you expected and what you observed.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Open the repository's [Security page](https://github.com/ronronner02/multi-agent/security). If
**Report a vulnerability** is available, use it to send a private report to the maintainers.
The reporter and authorized advisory collaborators can also see that report; it is not public.
Availability depends on the repository setting, not on this file being present.

If that option is unavailable, ask in [Discussions Q&A](https://github.com/ronronner02/multi-agent/discussions/categories/q-a)
for a private security contact. Post only the request for a channel: do not include the
vulnerability details, reproduction, logs, credentials or affected private systems in public.
Wait for the private channel before sharing the report.

Include: the Multi-Agent version, the harnesses involved, the steps to reproduce, and what an attacker
could do. A proof of concept is welcome; a working exploit against a third party's machine is not.

## What to expect

- We will acknowledge the report and coordinate assessment and next steps privately.
- Assessment and fix timing depend on impact and reproduction; no fixed deadline is promised.
- We will agree on disclosure and credit with you. You can ask to remain anonymous.

## Scope notes

- Multi-Agent is designed for your own machine or a trusted private network, for you and people you trust, not for the
  open internet. We assess reports by their practical impact on a user in that setup. Exposing an install to the open
  internet isn't a supported deployment. Multi-Agent's own gateway integrations with outside services, such as Slack, and
  anything that lets an untrusted party reach the daemon or an agent are in scope.
- Multi-Agent assumes the machine and the accounts it runs under are trusted by their owner. Reports
  that require a hostile local user with the same account are still welcome but are unlikely to be
  treated as high severity.
- A harness carrying out an intentionally authorized operation is not by itself evidence of an
  Multi-Agent vulnerability. Reports of Multi-Agent bypassing a chosen permission, changing trust
  unexpectedly, or routing data or actions to the wrong destination are in scope.
