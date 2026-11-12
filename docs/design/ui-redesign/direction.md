# U10 — Web UI redesign: one direction

**Status:** design direction for review. No product code was changed. The previews are static
HTML built on the token set below; U10 implementation applies it to the React/Tailwind/Radix
surfaces in `engine/packages/ui/src/team/`.

**Direction name:** 主线 — *One Line*.

**Files:**
- `direction.md` — this document.
- `preview/{run-home,run-home-approval,team-create,task-detail,integration-branch}.html` —
  responsive static previews (open any of them in a browser; `preview.css` holds the token set).
- `screenshots/<screen>-1440.png` and `<screen>-390.png` — the same previews at 1440×900 and
  390×844, 1x.
- `screenshots/before-*.png` — the shipped screens, for comparison.

---

## 1. North star

> **One line from an approved plan to a merge, and one conversation about it.**
> The screen only ever shows two things: what the lead is saying, and how far the line has come.

Every choice below is judged against that sentence. The owner is a director who should be
interrupted twice — to approve a plan, and to merge. Everything else on screen is a record of
work in progress, not a dashboard of work that the owner is managing.

## 2. Tone, from the evidence

| Scale | Value | Why |
| --- | --- | --- |
| Energy | quiet | The owner hears back only at escalations and merge. A screen that is loud in the quiet hours misrepresents the system. |
| Finish | precise | A developer's daily tool used for months. One haircut: 1px hairlines, a 4px grid, three radii, zero shadows. |
| Density | medium-dense | 15px body, 14px rows, 68ch measure. Read in minutes, not browsed. |
| Weight | light | Type weights 400/500/600 only; no filled blocks except the single primary action and the merge terminus. |
| Seriousness | sober | A record of work on the owner's own repository. No illustration, no mascots, no playful microcopy. |

## 3. Generation engine

**One concrete object from the product: the integration branch.** The run's work lands as
commits on one branch; the branch's length is the real amount of work done. The line in the
right column on the run home and on the integration branch screen is that object, drawn
literally: a 1px rule, a node per task, filled to the last thing that landed, ending at the
merge.

Secondary grammar: **documents**. A run starts with a plan; the two things the owner decides
arrive as plates in the conversation, not as dialogs. The plates are set in a serif, the working
text in a sans — the record reads like paper, the work reads like a tool.

## 4. Typography

| Role | Family | Use |
| --- | --- | --- |
| Display | `Source Serif 4` + `Noto Serif SC` | Run name, plan title, escalation question, merge plate title. 18–24px, weight 600. |
| UI | `IBM Plex Sans` + `Noto Sans SC` | Everything else: chat, rows, labels, buttons. 12–15px, weights 400/500. |
| Data | `IBM Plex Mono` | Diffs, commit hashes, branch refs, counts, file paths. 11–13px, tabular. |

Why: IBM Plex is drawn for engineering documents and has a genuine Simplified-Chinese sibling
(Noto Sans SC) at matching stroke weight; Source Serif 4 / Noto Serif SC carry the same
document edge for the few large lines. Not Inter + Lucide, which every AI tool already is.

Rules:
- Chinese and Latin share a baseline; never mix two weights inside one line to fake emphasis.
- Body is 15px with a **1.75** line height for Chinese, 1.6 for Latin-only strings.
- No letter-spacing on Chinese. Numbers in tables and counters use tabular figures.
- Long technical tokens (`team/text-helpers`, `normalize()`, `plan.md`) never wrap mid-token.

## 5. Colour

Derived from the product: paper and ink (the lineage the project already carries in the
水墨丹青 skin), one cool accent that never collides with the diff's green/red content colours,
and one warm signal reserved for *something is waiting on you*.

| Token | Value | Role |
| --- | --- | --- |
| `--paper` | `#F4F3EF` | Page ground |
| `--surface` | `#FFFFFF` | Plates, sheets, composer |
| `--surface-2` | `#FAF9F6` | Pressed/quiet blocks |
| `--ink` | `#171A19` | Primary text |
| `--ink-2` | `#4A504D` | Chat body, secondary text (7.4:1) |
| `--muted` | `#5D635F` | Meta, state words (5.5:1) |
| `--faint` | `#6B716E` | Timestamps, seat names, line numbers (4.5:1) |
| `--line` | `#DCDAD2` | The single hairline |
| `--line-soft` | `#E9E7E0` | Dividers inside a surface |
| `--accent` 墨青 | `#155A5F` | Actions, landed work, the filled part of the line |
| `--accent-press` | `#0E4448` | Pressed action |
| `--accent-soft` | `#E4EEEC` | Hover wash on options, focus ring |
| `--attention` 赭 | `#96621A` | Something waits on the owner; plate waiting border |
| `--attention-soft` | `#F6EDDD` | Waiting wash |
| `--danger` 朱 | `#A3342A` | Blocked, failed |
| `--danger-soft` | `#F7E8E5` | Hover on remove |
| `--add-bg` / `--add-ink` | `#E8F0E7` / `#2C6640` | Diff content only (5.9:1) |
| `--remove-bg` / `--remove-ink` | `#F6E7E3` / `#9A3228` | Diff content only (6.1:1) |

Rules: the accent covers less than 5% of any screen; state is never carried by colour alone
(every coloured state also has its word: 已完成 / 审查中 / 排队中 / 受阻); content colours
(green/red) never appear outside a diff.

Mapping to the stack: the values replace the `--ui-*` set in `team.css` and
`skins/shuimo-danqing/skin.css`, and extend the Tailwind theme as
`colors.paper|surface|ink|accent|attention|danger`, `fontFamily.display|ui|mono`,
`spacing` on the 4px grid, `borderRadius.sm|md|lg`.

## 6. Spacing, density, shape, motion

- **Grid:** 4px. Steps used: 4, 8, 12, 16, 24, 32, 48, 56.
- **Type/density:** 15/26 body, 14/20 rows, 13/20 secondary, 12/18 meta; row height 48 desktop,
  52 mobile with 44px minimum touch targets.
- **Shape:** radius 4 (controls), 6 (options/inputs), 10 (plates/sheets). One 1px hairline for
  every division; no shadows, no gradients, no textures, no glass.
- **Top bar:** 56px. Chat measure 720px; right column 344px; page gutters 32px desktop / 16px
  mobile.
- **Motion (three basic ones):**
  1. A new plate enters at 6px up, 160ms `cubic-bezier(.2,.7,.3,1)`.
  2. Approving the plan collapses the plate's actions to its outcome line in 160ms, and the
     tasks appear in the line with a 40ms stagger.
  3. When the last task lands, the line's last segment draws into the merge plate (160ms) and
     the plate's border goes from `--line` to `--accent`.
  Reduced motion: all three are instant; the running node stops pulsing.

## 7. Per-screen protagonist and main action

| Screen | Protagonist | Main action | Secondary, demoted |
| --- | --- | --- | --- |
| **Teams** | The list of repositories with their seats | 新建团队 | Opening a team's run |
| **Team create** | The repository field | 创建团队 | 添加/移除席位, 取消 |
| **Run home** | The lead chat | The one plate action currently pending (批准计划 / an escalation option) — or the composer when nothing is waiting | 继续讨论, 查看提交 (quiet links) |
| **Task detail** | The diff | none — read only; the owner does not fix code from here | Back to the run |
| **Integration branch** | The commits ending at the merge plate | 合并到 main | The consequence line above it |
| **New task** | The task title | 加入队列 (a plate in the chat, not a screen) | 取消 |

Every screen has exactly one filled accent element. If two appear, one is wrong.

Task detail reads top-down: title and state, the diff full width (the file strip is a horizontal
rail along its top, so the code keeps the width), then one band with the review findings at a
narrow measure and the attempts in a right-hand rail. On a phone the diff wraps its long lines
instead of clipping them, and the file strip stays visible.

## 8. Naming: what replaces the ids

The owner's complaint is that the UI shows `task-1-review-1`, UUIDs and `impl@rework`. The rule:

| Today (rendered) | Replaced by | Source |
| --- | --- | --- |
| `0c45f341-07a2-…` run UUID | **文本工具函数** — the run's short name from its goal | U9 `display_name` |
| `task-1`, `task-1-review-1` | **补上 slugify 的边界用例**, **审查：补上 slugify 的边界用例** | U9 `display_name` |
| `dev-impl@team-demo`, `impl@rework` | **实现者 · Claude Code**, numbered when the role repeats (**实现者 · Codex 2**) | U9 seat name = role · client |
| `01M6P2CGXVE…` rig id | **文本工具** — the team's name | U3/U9 |
| `plan.md` as the plan's identity | The plan's own title, **文本工具函数** | plan artifact |
| `bindingDigest`, `qitemId`, digests | never rendered | — |
| `P1` / `P2` / `P3` | **需修改** / **建议** / **轻微** | review semantics |
| `multi-agent team apply …` CLI line | removed; merge is a button | U7 |
| `status.queue.in-progress` codes | **排队中 / 执行中 / 审查中 / 已完成 / 受阻** | i18n |

Rules that make it hold:

1. Ids live in URLs, React keys and logs — never in rendered text. The existing
   `no-UUID-in-DOM` test (U10) enforces it over the rendered DOM.
2. A name is always shown where identity matters. Two things with the same name get a number:
   `实现者 · Codex 1 / 2`.
3. Names are never truncated in the middle of a word; if a name is too long for its column, the
   column gives way (wrap to a second line), because two similar truncated names are worse than
   a taller row.
4. **One exception:** the 7-character commit hash on the integration branch. It is content from
   the owner's own repository (they may want `git show`), not an internal id, and it is the only
   place it appears.
5. Time reads relative inside 24 hours (`刚刚`, `3 分钟前`), then `昨天 22:06`, then `11月5日`.

## 9. Chat and decision patterns

**The conversation is a record, not a messenger.** One column, one measure, no bubbles and no
left/right alignment. The owner's turns are filled blocks (they are insertions into the record);
the lead's turns are plain text with the seat label above. This breaks the "contacts on the
left, messages on the right" convention on purpose: the value here is the run's history, and a
director reads a record.

**Three plate types, one shape.** A plate is a white surface with a 1px hairline, 10px radius,
a serif title, and one way out — either an action or a recorded outcome:
- **计划** — the plan's title, its task list (name + seat per row, numbered), and
  `批准计划` / `继续讨论`. After approval the actions collapse to `你在 21:38 批准了计划`; the
  plate keeps its place in the record.
- **决策** — the lead's question as the title, then 2–4 full-width option rows (one line each,
  44px, a chevron at the right edge, hover in accent-soft). The chevron is what separates a
  choice from a text field at rest. One click sends the answer as the owner's turn. No modal, no
  confirm step: an escalation is a decision the lead acts on, and the record shows it.
- **任务** — the owner adding a task directly: title + optional note, one `加入队列`.

**Waiting is warm, never loud.** A plate that needs the owner carries a `--attention` hairline;
nothing blinks, nothing badges, no toasts. The bell and the badge count are gone: what needs you
is in the conversation, which is where the owner reads anyway.

**One filled accent per state.** The composer's 发送 is quiet until there is text, so the only
filled accent on screen is the decision the owner is being asked to make.

**Errors appear where they happened.** Inline under the field or the action, using the daemon's
own reason text. No global error bar.

## 10. What is removed, and why

| Removed | Why |
| --- | --- |
| Six-item sidebar (总览/工作区/任务/审查/分析/设置) | Five of the six are different views of the same two questions. A 56px top bar gives the chat 188px back. |
| Overview screen: 5 summary cells, 4-stage progress, run-details disclosure, fleet panel, recent events | They describe work the owner is not managing. The line and the chat answer "what is running" and "what waits for me" with less. |
| Analytics screen | Token and cost accounting is explicitly out of scope in the plan's Scope Boundaries. |
| Workspace (file browser, knowledge, terminal, logs) | The owner does not inspect the agent's shell; raw output is reachable from a task's attempts. |
| Four-column kanban (排队中/运行中/审查中/受阻) | The columns are the queue's internal states, and each card repeated its state word. One ordered line replaces four boxes; empty columns stop eating 75% of the width. |
| Three themes (dark / light / ink) + video backdrop + paper grain | Three palettes multiply every visual decision by three; the video was decoration behind a diff. One light theme. |
| `--ui-*` ink-skin tokens and `ink-style.test.ts` | Replaced by the token set above; the test becomes a token test for the new set. |
| Every raw id in rendered text | See §8. |
| `multi-agent team apply …` command + copy button | Merge is a button (U7). |
| Run `<select>` in the command strip | Runs are reached through their team. |
| Search field, ⌘K, notification bell, badge, “查看运行” button, “提议新增任务” second primary | Each was a second way to do what the screen already does; two primaries on one screen is one too many. |
| Helper copy: `快照及后续重放中没有活动记录。`, `尚无验收检查证据`, `此快照没有尝试证据。`, `查看全部任务 →` | `docs/development-standards.md` §9: structure explains. Empty states are one state word, not a sentence. |

Kept on purpose: the pairing gate (a security boundary, shown once as an empty state), the
daemon's own refusal reasons, and the irreversible-action consequence line on merge.

Also removed in the subtraction pass: the `4 / 9` counter in the line's header (the merge plate
already says how many are unfinished, and the mobile strip keeps its count because the line is
hidden there), the attempt count in the task's meta row (the 尝试 list says it), and the
"2 个文件" count beside a file list that is on screen.

Before: `screenshots/before-run-home-1440.png` and `screenshots/before-tasks-1440.png` are the
shipped 总览 and 任务 screens, captured from a daemon running this branch's `origin/main` with
the stub-runner demo. They are the record of what is being removed.

## 11. Language and i18n

- Default `zh-CN`, English available; the `中 / EN` control sits in the top bar and is the only
  chrome on the teams root.
- All new strings go into `engine/packages/i18n/src/catalogs/{en,zh-CN}.json`. Names (run, task,
  seat) are data, not translations.
- Every removed string is removed from both catalogs; the i18n tests catch a straggler.

## 12. Implementation notes

- Tokens land on `.team-shell` as the `--ui-*` names above; Tailwind theme reads them, so a
  component never hard-codes a hex.
- Primitives: `Card` → plate; `Button` → three variants (primary / outline / quiet); `Dialog` →
  sheet only; `Tabs`, `Table`, `Analytics` charts and the terminal components are unused by the
  team screens after this change.
- Icons: one family, 16px, 1.4px stroke, round caps (the previews inline the few glyphs needed:
  back, more, close, check). No icon in a heading, no icon-only button without an accessible
  name.
- Fonts are self-hosted WOFF2 subsets (Source Serif 4 Latin + Noto Serif SC subset; IBM Plex
  Sans Latin + Noto Sans SC subset; IBM Plex Mono). The previews load them from Google Fonts
  only because they are prototypes.
- The `no-UUID` DOM test, the mobile stacking test and the responsive test in
  `engine/packages/ui/src/team/__tests__/` are the acceptance checks for the structure.

## 13. Assumptions and open questions for the orchestrator

1. **One theme, light only.** Dark mode is dropped for U10. If the owner works at night on a
   dark desktop, this is the first decision to revisit; adding it later means a second palette,
   not a redesign.
2. **The team is the entry point, the run is the home.** Teams → run. A team with several runs
   needs a run list, which this direction does not draw (U5 start flow assumes one active run
   per team).
3. **The commit hash** is the one identifier left on screen (§8 rule 4). If R12 is read
   strictly, remove it and keep the commit name + time only.
4. **Findings severity words** (需修改/建议/轻微) are a translation of P1–P3; if the daemon's
   codes must remain visible for support, they belong in a tooltip, not in the row.
5. **The plan plate lists implementer tasks** and states the review count in its meta; the plan
   file itself stays the source of truth, so the plate is a summary, not an editor.

## 14. Independent review

A fresh reviewer with no history of this work scored the first build **8/10** against the
`oil-ui` new-interface standard. Its five findings, all fixed in this version:

1. The diff was clipped mid-token at 390 → on a phone the code wraps with a hanging indent and a
   single line-number column; the file rail became a horizontal strip so the code keeps the width.
2. Option rows and the composer looked identical, and 发送 was a filled accent with an empty
   field → options end in a chevron and are 44px; 发送 is quiet until there is text.
3. Ochre (the "someone is waiting on you" signal) was spent on reviewer chips and on 建议
   findings → both are neutral now; ochre only marks a waiting state.
4. The approval screen's empty upper half → the conversation is top-aligned and opens with the
   owner's own message, so the first content sits in the top third.
5. Two Chinese orphan lines at 390 → `text-wrap: balance` on chat and finding paragraphs.

Not fixed, recorded as known: motion is not evidenced in static shots (the CSS carries the three
transitions, but their hand-feel is unverified); the EN state was not rendered.