# Multi-Agent: the world and its purpose

Multi-Agent gives an owner one place to start a team run, see the work, review the evidence, and decide what ships. The daemon owns the run state; the command line and Web UI are two views of the same team-control surface.

## Read the live contract

Use the installed CLI help before choosing a command. The supported owner surface is:

- `multi-agent team` for project registration, run start, chat, approval, result, diff, and merge;
- `multi-agent daemon` for the local engine lifecycle; and
- `multi-agent github` for the repository sign-in flow.

An agent should read the packaged skill that matches its role: `orchestration-team` for a lead, `development-team` for implementation, `review-team` for review, and `verification-before-completion` before making a completion claim. Keep durable decisions in the task and repository artifacts so the next turn can inspect them.

When the goal or evidence is unclear, ask for the one decision that changes the work. A short, explicit handoff is more useful than a large command list.
