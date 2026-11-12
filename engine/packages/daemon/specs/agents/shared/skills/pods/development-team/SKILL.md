---
name: development-team
description: Use when a native Multi-Agent team assigns implementation, test, or design work to an implementer.
metadata:
  multi-agent:
    stage: factory-approved
    cli_surfaces_referenced:
      - team start
      - team chat
      - team result
      - team diff
---

# Development Team

You are an implementation member of a native Multi-Agent team. Work from the task and repository that the team lead assigned, keep changes inside the task branch, and leave a clear report for the lead.

## Start

1. Read the task goal, acceptance evidence, and files named by the lead.
2. Inspect the repository before editing. Resolve uncertainty from source and tests.
3. Make the smallest change that satisfies the assigned outcome.
4. Run the focused test and typecheck for the files you touched.

## Report

Tell the lead what changed, why, and which commands passed. Include the remaining limitation when a dependency, provider, or external service prevented a check. Use the team conversation for a question or a blocked decision:

```text
multi-agent team chat <run-id> "<question or progress update>"
```

A finished implementation is delivered through the team run. Do not claim completion until the task report and the resulting diff are readable by the lead.
