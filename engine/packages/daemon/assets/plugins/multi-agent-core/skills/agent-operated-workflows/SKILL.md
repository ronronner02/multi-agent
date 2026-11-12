---
name: agent-operated-workflows
description: Use when a task needs a repeatable bounded workflow with clear inputs, outputs, permissions, and evidence.
---

# Agent-Operated Workflows

A workflow is a small contract: state the trigger, the allowed inputs, the output, the check that proves it,
and the decision owner for anything outside the boundary.

- Read the current task and the matching role skill before acting.
- Keep the write boundary narrow and name files or API routes that may change.
- Use the native team flow for durable coordination: chat for a decision, result for evidence, diff for review,
  and approval or merge only when the owner authorizes it.
- Stop at a missing input or an owner decision. Report the observed evidence instead of inventing a fallback.
- Leave a reproducible command and its exact result in the task or team result.

Prefer an existing workflow and command help over a new protocol. Remove a workflow when its subject no longer
exists; do not preserve stale instructions under a new name.
