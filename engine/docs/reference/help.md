# Help your user get unstuck

This page is for an owner or agent whose Multi-Agent team flow is not working. The command line and Web UI
read the same authenticated team-control state. Use the installed command's help before choosing an option:

```sh
multi-agent --help
multi-agent team --help
multi-agent daemon --help
multi-agent github --help
```

If the daemon is unavailable, `multi-agent daemon status` reports that directly. The same text is installed
beside the CLI package at `daemon/docs/reference/help.md`; in this source repository it is
`docs/reference/help.md`.

Start with the goal, the command that was run, the expected result, and the exact observed error. Keep private
repository content and credentials out of a support request.

## Start with the local engine

```sh
multi-agent --version
multi-agent daemon status
```

If the daemon is stopped, start it with `multi-agent daemon start` and check the status again. Use an explicit
`--port` when another local process owns the default. The daemon writes its mutable state below the canonical
Multi-Agent home; set `MULTI_AGENT_HOME` only for an isolated test or temporary run.

## Start and inspect a team run

Use the native owner flow:

```sh
multi-agent team create <repository>
multi-agent team start "<goal>" --repository <repository> --write <path>
multi-agent team chat <run-id> "<question or progress update>"
multi-agent team result <run-id>
multi-agent team diff <run-id>
multi-agent team merge <run-id>
```

A planning run pauses for the owner to review the lead conversation and run `multi-agent team approve
<run-id>`. Read the durable result and diff before delivery. A worker's final message alone does not prove
that the task is complete.

If a task is blocked, record the observed error and the one owner decision that would change the work. Keep
coordination in team chat and the durable result rather than inventing another terminal handoff protocol.

## GitHub connection problems

Use `multi-agent github status` to inspect the account used by the daemon. Run `multi-agent github sign-in`
only when the status and the error show that authentication is the missing decision. A repository creation or
push remains an owner decision; review the project preview before confirming it.

## UI and data paths

The Web UI at `/team` is another view of the same team-control API. If the UI is unavailable, use the CLI
against the same local daemon. On Windows, mutable state is under `%LOCALAPPDATA%\Multi-Agent` and configuration
under `%APPDATA%\Multi-Agent`; other platforms default to `~/.multi-agent`. `MULTI_AGENT_HOME` overrides the
mutable state root for an isolated process. Legacy product directories and environment names are not read.

## Prepare a support request

Record:

- the Multi-Agent version and operating system;
- the goal and repository boundary;
- the exact command and expected result;
- the observed output or error;
- the daemon status and, when relevant, GitHub status; and
- the one question that still needs an owner or support decision.

Remove credentials, private source, and unrelated logs before sharing the report. Send it only through a channel
the owner has authorized.
