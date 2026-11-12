---
name: delegating-work
description: "Use when an owner-governed team run must decide who should do a task: the lead, an implementer, a reviewer, a short-lived subagent, or the human. Route work to the participant that already holds the needed context and authority."
---

# Delegating Work

Delegation is a context and authority decision. Before handing work away, identify the smallest useful
brief, the evidence the worker must return, and the participant who can make the next decision without
reconstructing the whole run.

## Choose the right participant

- **The human owner** when the choice changes scope, permissions, repository boundaries, release, or another
  irreversible outcome.
- **The team lead** when the task needs planning, coordination, or a decision that spans several work items.
- **An implementer** when the task has a bounded write boundary and a concrete acceptance check.
- **The reviewer** when the task is to inspect evidence, a diff, or a completion claim independently.
- **A short-lived subagent** when the task is self-contained, easy to verify from its returned evidence, and
  does not require the run's historical context.
- **Yourself** when delegation would cost more context than the task itself or when you are the only holder of
  the decision that must be made.

The more context a task needs, the more valuable it is to route it to a participant already working on the
same run. A blank-slate worker can produce a plausible answer while missing the run's actual contract; require
file or command evidence that the owner can check before accepting such work.

## The practical test

Ask: **would a wrong-but-plausible answer be detectable from the returned diff, result, test output, or
source citation?** If yes, a short-lived subagent is suitable. If no, keep the work with the lead, an
established implementer or reviewer, or the owner.

## Hand over intent and evidence

Give the recipient the goal, why it matters, the files or API boundary they may touch, and the evidence they
must return. Preserve the requester's own wording when it carries a decision. Let the recipient choose the
implementation details; make only the boundary and evidence contract exact.

Use the native team flow for durable delegation:

```bash
multi-agent team start "<goal>" --lead <session> --reviewer <session>
multi-agent team chat <run-id> "<decision or progress update>"
multi-agent team result <run-id>
multi-agent team diff <run-id>
```

For a planning run, the owner reviews the lead's conversation and approves it before implementation starts.
The daemon records task ownership, attempts, evidence, and the result. Do not create a second handoff protocol
in a terminal transcript or an obsolete queue/seat command.
