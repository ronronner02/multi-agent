---
name: claude-compaction-restore
description: Use when a Claude Code session is about to compact, has just compacted, reached its context limit, resumed after /compact, or must rebuild its working picture from its restore packet, transcript and touched files.
metadata:
  multi-agent:
    sibling_skills:
      - claude-compaction-restore
      - agent-operated-software
      - agent-operated-workflows
      - verification-before-completion
---

# Claude Compaction Restore

Compaction keeps facts and loses connections. After a compaction you may remember file names and decisions
without remembering why they matter, what depends on them, what was next, or which evidence was already
checked. This skill rebuilds that working picture before you make another change.

The PreCompact hook writes a restore packet under the configured temporary output root. The companion
`restore-from-jsonl.mjs` script can create a packet from a Claude JSONL transcript when the hook packet is
unavailable.

## If You Are About To Compact

1. Finish a tiny atomic step only when stopping would leave a misleading partial artifact.
2. Write a short restore map in the path named by the preparation request. Record who you are in the current
   run, the goal and decision you hold, the files and evidence that matter, what changed in this window, what
   comes next, and who authorizes that next step.
3. Link the map to the repository task and durable team artifacts. Keep private session details in the local
   compaction area, not in the repository.
4. End by naming the map path so the next session can open it before acting.

The map is a connection record, not a transcript copy. Point to the packet, task result, team diff, source
files, and test output instead of duplicating them.

## If You Just Compacted

1. Read the restore request and the packet's `restore-instructions.md` and `touched-files.md` when present.
2. Read the current task, repository instructions, and the files named by the packet in full. Treat the packet
   as a pointer, not as proof that the files still have the same contents.
3. Re-enter the supported product surface with `multi-agent --help` and `multi-agent team --help`. If a run
   id is available, read `multi-agent team chat <run-id>`, then the durable `team result` and `team diff`.
   Use `multi-agent daemon status` when the local engine may have changed state.
4. Rebuild the connections: the current goal, the accepted boundaries, the files that implement it, evidence
   already checked, unresolved decisions, and the next authorized action.
5. Reply with `restored from packet at <path>; resumed at step <X>` and name the packet or map you used.
   If no packet exists, say that you restored from the transcript and name the transcript path.

## Required Read-Depth Audit

When the restore request asks for an audit, list each required source as `FULL`, `PARTIAL`, or `NOT_READ`,
with the actual portion read and any missing context. Read required sources fully before resuming. Record
the connections you rebuilt, the evidence that still needs checking, and the next authorized step.

Read the current source that a decision depends on, not an old transcript summary. A compacted session may
sound certain while carrying stale state. Use the team result and diff as durable evidence, and rerun a focused
check when the packet does not establish it. Keep a short note of anything you could not re-establish and the
file or command that would answer it later.

## What belongs where

- The task and repository artifacts hold goals, acceptance evidence, decisions, and candidate changes.
- The team chat holds concise questions and progress updates that another participant must see.
- The team result and diff hold the candidate's durable output and review surface.
- The compaction packet and restore map hold private session continuity and pointers into those durable sources.

Do not infer completion from a worker's last message, a stale transcript, or a remembered command. Read the
current result and diff, then run the verification required by the task before claiming success.
