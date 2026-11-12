# Multi-Agent Skills

This folder is the **publicly-visible mirror** of the canonical skills that
ship with Multi-Agent — the set of progressive-disclosure context manifests
that Multi-Agent agents load on demand to do their work well.

The skills are **mirrored** from the daemon's bundled-skills folder at
`packages/daemon/specs/agents/shared/skills/` into `_canonical/` here, so
that anyone reading the multi-agent repo can find the skills at the repo root
without spelunking through `packages/daemon/specs/`.

## What you'll find

| Path | Contents |
|---|---|
| `_canonical/` | The 17 mirrored skills, organized under `pm/`, `pods/`, and `process/`. Do not edit files here directly — see "Authoring" below. |
| `CHANGELOG.md` | Append-only log of skill changes per curation cycle close. Hand-authored. |
| `LICENSE` | Apache-2.0, matching the parent project. |

## What a skill is

A skill in Multi-Agent is a **primitive for progressive-disclosure context
injection**, not a unit of capability in the dictionary sense. Frontmatter
sits in the agent's hot tier (cheap pattern-matching against the trigger
description); body loads on activation; references in the folder load on
demand. Read a few `_canonical/*/SKILL.md` files to see the shape — the
frontmatter `description` is the trigger, and the body is what the agent
loads when the trigger matches.

Multi-Agent agents discover skills automatically; you generally don't invoke a
skill explicitly. Authoring a skill is about naming a recurring need with
a precise enough trigger that the agent reaches for it at the right moment.

## Using these skills

If you're running Multi-Agent (`npm install -g @multi-agent/cli` or via tarball),
these skills ship in the package and the daemon projects the selected native-team
skills into the worker runtime. The owner-facing command surface is the
`multi-agent team`, `multi-agent daemon`, and `multi-agent github` command groups; agents should
load the skill that matches the current team task and use the team-control surface
for coordination.

If you're reading this folder for reference (without Multi-Agent installed),
the SKILL.md files are pure markdown with YAML frontmatter; they're
human-readable and self-describing. Each `description` field in the
frontmatter says when to reach for the skill.

## Authoring

The categorized product source is `packages/daemon/specs/agents/shared/skills/`.
The seven plugin-only skills and their helpers are authored separately under
`packages/daemon/assets/plugins/multi-agent-core/skills/`, beside the plugin manifests.

`<repo-root>/skills/_canonical/` (this folder's `_canonical/`) is mirrored
**from** product source via `npm run mirror-skills`. The mirror is
strictly a copy — never edit `_canonical/` directly; edits in product
source must be propagated by re-running the mirror script. Plugin-only files are
checked against their recorded edge digests without replacing their source tree.

## Drift detection

`npm run test:repo` runs `mirror-skills --check` to detect drift between
product source and `_canonical/`. If you edit a skill in product source
without re-running the mirror, the test fails with a clear message naming
the script to run. CI may also enforce this gate when GitHub Actions
arrives.

## Future-state

This folder is structured **as if it were already its own repo** so that a
future `git subtree split --prefix=skills HEAD` is mechanical when growth
warrants. Until then, the in-repo mirror is the right scope: skill changes
ship atomically with the daemon binary that loads them; no version-skew
risk; one PR for both halves.
