---
name: agent-operated-software
description: Use when an agent must turn a goal into a bounded change, inspect the current source, verify the consumer, and report evidence.
---

# Agent-Operated Software

Treat the repository and its live team run as the source of truth. Start from the goal and acceptance
condition, inspect the current source, make the smallest change that satisfies the contract, and verify the
boundary that could still be wrong.

1. Read the task, repository instructions, and the relevant team result or chat.
2. Trace the behavior from the user-visible boundary to the source that produces it.
3. Change only the files needed for the accepted scope. Keep public contracts and data paths explicit.
4. Run the focused test, typecheck, or smoke command that can falsify the change.
5. Report the changed behavior, the evidence, and the remaining limit in the team result or repository task.

When a provider or repository decision blocks progress, record the observed error and the one decision the
owner must make. Do not infer completion from a worker's last message; read the current result and diff.
