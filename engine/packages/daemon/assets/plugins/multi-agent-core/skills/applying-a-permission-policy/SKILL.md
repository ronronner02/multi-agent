---
name: applying-a-permission-policy
description: Use before a worker launch or external write when the task's repository, files, client, and delivery authority must be checked.
---

# Applying a Permission Policy

Before a write or launch, make the boundary concrete:

- what goal and repository the task belongs to;
- which files, routes, or commands the task may change;
- which client or process will perform the work;
- what evidence must be returned; and
- which decision still belongs to the owner.

Read the current task and repository instructions, then inspect the team result or chat for any updated
boundary. Refuse or pause when the requested action exceeds that boundary. A planning run requires the owner's
approval before implementation begins; delivery and merge require the owner to accept the result and diff.

Record the decision and the evidence in the durable team artifacts. Do not create a hidden coordination file or
silently widen a write path to make a task convenient.
