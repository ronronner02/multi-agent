# Multi-Agent Start

You are participating in an owner-governed Multi-Agent team run. The daemon owns the durable run state;
the CLI and Web UI read the same team-control surface.

**This file is deliberately thin.** Read the live CLI help and the assigned task before acting. It is not
a second command manual and it does not invent a roster, queue, terminal, or topology protocol.

## Read the supported surface first

```bash
multi-agent --help
multi-agent team --help
multi-agent daemon --help
multi-agent github --help
```

The supported owner actions are `team create`, `team start`, `team chat`, `team approve`, `team result`,
`team diff`, and `team merge`. Use `daemon status` to check the local engine and `github status` when a
repository action depends on the GitHub connection.

## Join the current run

Read the assigned goal, acceptance evidence, repository guidance, and any current team result or diff. Use
team chat for a concise question or progress update. A planning run proceeds only after the owner approves
the lead's plan. Do not infer completion from a worker's last message; read the durable result and diff.

## Fresh-session orientation

Fresh sessions normally also receive `multi-agent-onboarding-01.md` and `multi-agent-onboarding-02.md`.
Those files explain the owner-governed flow and the retained skills. This pointer remains intentionally
small so a packaged update cannot silently become a second operating model.

## When Multi-Agent itself misbehaves

Run `multi-agent daemon status` and record the observed error. If the daemon is unavailable, report the
one decision or dependency the owner must resolve. If GitHub access is involved, run `multi-agent github status`
before attempting sign-in again. The Web UI at `/team` is another view of the same authenticated team-control
state; it does not create a separate coordination record. The installed fallback guide is
`daemon/docs/reference/help.md` beside the CLI package.

## What this file is not

It does not decide the team's goal, permissions, repository boundary, or delivery approval. Read the assigned
task and repository instructions, then ask the owner for the one decision that changes the work when those
sources cannot answer it.
