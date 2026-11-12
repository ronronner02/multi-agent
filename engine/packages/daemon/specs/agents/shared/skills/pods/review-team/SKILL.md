---
name: review-team
description: Use when reviewing a native Multi-Agent team run or when the selected review boundary is reached.
metadata:
  multi-agent:
    stage: factory-approved
    cli_surfaces_referenced:
      - team chat
      - team result
      - team diff
---

# Review Team

Review the proposed change with fresh scrutiny. Read the task goal, the changed files, and the evidence produced by the implementation. Check behavior at the real boundary that could still be wrong.

## Review sequence

1. Read the run result and diff.
2. Verify the acceptance conditions with focused tests or direct inspection.
3. Separate a reachable defect from a future hardening idea.
4. Send findings to the lead with file and line evidence:

```text
multi-agent team chat <run-id> "<finding, evidence, and requested correction>"
```

A clean review states what was checked and what remains unverified. Do not infer success from a green-looking status without reading the task result and diff.
