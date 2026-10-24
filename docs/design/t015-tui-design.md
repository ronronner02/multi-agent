# Team TUI design (ink wash)

**Status:** approved by the owner on 2026-10-24. This is the design proposal that the T015 and T016 cards wait for. It covers the terminal client only; the Web UI (T019–T022) still needs its own proposal.

**Sources, in order of precedence:**
1. The owner rulings in section 1.
2. The source plan: `docs/plans/2026-10-13-001-feat-multi-agent-team-plan.md` (Web UI and TUI Experience, U6).
3. The owner's brief: `docs/design/tui-brief.md`.
4. The layout reference: `docs/design/mockups/06-tui-ink-wash.html` (open it in a browser). It shows the regions, breakpoints and states. Its English-only labels and Unicode glyphs are superseded by sections 1 and 4.

`docs/Rendering.png` stays the information benchmark (PC3). This design restates it as a terminal grid.

---

## 1. Owner rulings (2026-10-24)

1. **Language.** Chinese and English are both supported, and Chinese is the default (`DEFAULT_LANGUAGE = "zh-CN"` in `@openrig/i18n`). The language switch stays, as KTD15 and U6 scenario 10 require. State codes, identifiers and agent text never change with the language.
2. **Console input.** The input accepts system commands only, from a fixed allowlist (section 7). There is no chat with the Lead and no message to any agent (PC4); conversations stay in the native CLI. The brief's "Chat" navigation item is dropped.
3. **Agent status is dual.** Every agent row shows the process state *and* the task state (section 6), so a running process is never read as a finished task.
4. **Finalize.** The last workflow stage reads `等待决定` / `awaiting decision` until an owner decision is recorded. Nothing marks it complete automatically.
5. **Terminal-native only.** No images, rounded corners or shadows. The layout is a plain character grid with whitespace between regions.
6. **Icons are Nerd Font glyphs** with an automatic plain-text fallback (section 4). No emoji. Never print a glyph the font may not have.
7. **Palette** is the 24-bit set in section 3.
8. **No flicker** under high-frequency log output (section 9).

## 2. Existing owners to reuse

The TUI is the imported custom renderer in `engine/packages/tui`, not Ink or Bubbletea. Build on what is there:

| Concern | Owner today | Change |
|---|---|---|
| Color modes (truecolor, 256, 16, none) and `NO_COLOR` | `src/theme.ts` (`detectColorMode`, `createStyle`) | Add the ink-wash tokens; existing tokens stay as they are |
| Line painting | `src/stylize.ts` | Unchanged; team views paint through the new tokens |
| Frame output | `src/main.ts` (full repaint, `\x1b[2K` per line) | Replace with the frame writer in section 9 |
| Strings and display width | `@openrig/i18n` (`CATALOGS`, `displayWidth`) | Use it for every label and every width calculation |
| Team views | `src/render.ts`, `src/state.ts`, `src/attention/attention-model.ts` | T015 adds the regions below |

Legacy (non-team) views must look and behave exactly as before.

## 3. Palette

The team views use their own tokens. Legacy tokens keep their values.

| Token | Truecolor | 256 | 16-color | Role |
|---|---|---|---|---|
| `inkCanvas` | `#0D1117` | — | — | Terminal background. **Never painted**: the user's own terminal background shows through. |
| `inkSurface` | `#161B22` | 234 | default bg | Region surface, lifted one step from the canvas |
| `inkText` | `#C9D1D9` | 252 | 37 | Primary text |
| `inkDim` | `#8B949E` | 246 | 90 | Secondary text, labels, timestamps |
| `inkMute` | `#6E7681` | 243 | 90 | Least important metadata |
| `inkLine` | `#30363D` | 237 | 90 | The rare divider, connectors |
| `inkSelection` | `#264F78` | 24 | bg 44 | Selected-row wash |
| `ochre` | `#D29922` | 178 | 33 | The one accent (focus mark, selected-row edge, active tab, items waiting on the owner), and warnings |
| `cinnabar` | `#F85149` | 203 | 31 | Failure, blocked, blocking review findings, disconnected |
| `emerald` | `#3FB950` | 71 | 32 | Verified, passed, healthy |

Rules:
- **The accent is scarce.** Ochre covers at most about 5% of visible cells.
- **Color never carries meaning alone.** Every state pairs color with a glyph or text label.
- **The selected row** gets the `inkSelection` wash plus a single ochre `▌` at its left edge. Don't combine bold, underline, color and background at once.
- **The focused region** gets an ochre `▌` before its title, and the title turns `inkText`.
- **Under `NO_COLOR` (and `TERM=dumb`), no color SGR is emitted.** States read from glyph and label only. Selection uses reverse video (SGR 7), which is not a color code.

## 4. Icons: Nerd Font with plain-text fallback

Fonts: the owner installs `Maple Mono NF CN` (recommended, because its CJK glyphs are monospaced at exactly two cells) or `JetBrainsMono Nerd Font Mono`. They are set in the Windows Terminal profile; nothing is installed inside WSL. Use the **Mono** variants, so every Nerd Font glyph is one cell wide.

**Detection** (`src/icons.ts`):
- `NERD_FONT=1` (or `true`) selects Nerd Font glyphs.
- `NERD_FONT=0`, `TERM=dumb`, or an unset `NERD_FONT` selects plain text.
- A terminal can't report its font, so the default is plain text. That guarantees no tofu (□) on a terminal without the font.
- A TUI setting may override the variable later (T016 settings). The variable wins when both are set.
- In text mode, the renderer must never emit a Private Use Area code point (U+E000–U+F8FF, U+F0000 and above). A test pins this.

**Map.** Code points follow the Nerd Fonts cheat sheet (v3). Check each against the installed font when implementing, and fix any that differ.

| Role | Glyph | Name | Text fallback |
|---|---|---|---|
| Git branch | `` | nf-fa-code_fork | `[Git]` |
| Workspace / folder | `` | nf-fa-folder | `[Dir]` |
| Coding agent (Claude Code, Codex, Pi) | `` | nf-fa-robot | `[AI]` |
| Lead / orchestrator | `` | nf-fa-sitemap | `[Lead]` |
| Dashboard | `` | nf-fa-tachometer | `[Dash]` |
| Tasks | `` | nf-fa-tasks | `[Task]` |
| Reviews & decisions | `` | nf-fa-eye | `[Rev]` |
| Logs | `` | nf-fa-file_text | `[Log]` |
| Knowledge | `` | nf-fa-book | `[Doc]` |
| Settings | `` | nf-fa-cog | `[Set]` |
| Passed / healthy / verified | `` | nf-fa-check | `[OK]` |
| Failed / error | `` | nf-fa-times | `[Err]` |
| Warning / degraded | `` | nf-fa-warning | `[!]` |
| Blocked | `` | nf-fa-ban | `[Blk]` |
| Running | `` | nf-fa-spinner | `[Run]` |
| Pending / not evaluated | `` | nf-fa-circle_o | `[ ]` |
| Needs the owner | `` | nf-fa-bell | `[!!]` |
| Unknown | `` | nf-fa-question | `[?]` |
| Locked / awaiting decision | `` | nf-fa-lock | `[Lock]` |

Width: compute every width with `displayWidth` from `@openrig/i18n`. CJK characters are two cells and Nerd Font Mono glyphs are one. Text fallbacks are measured as the labels they are. Pad and truncate (with `…`) by display width, never by string length.

## 5. Layout and breakpoints

The breakpoints use both columns and rows. Re-layout on every resize (SIGWINCH), keeping the selected task, the focused region and the active tabs.

| Mode | When | Shape |
|---|---|---|
| **Wide** | ≥ 140 columns and ≥ 24 rows | Header 1 row (plus 1 spacer row at ≥ 30 rows). Three columns: navigation 22–24 columns with the current-plan card; main area (workflow, task list, task detail); right column about 30% (36–54 columns) with Needs you, Agents, System and Recent activity. Console about 24% of the remaining height, at least 6 rows. Key hints on the last row. |
| **Medium** | 100–139 columns and ≥ 24 rows | Navigation collapses to a 5-column icon rail. Task list over task detail stay primary. The right column (about 32%) keeps Needs you on top; Agents, System and Activity share one tabbed region. |
| **Narrow** | < 100 columns **or** < 24 rows | Master-detail. One view at a time (Tasks, Details, Agents, Reviews, Logs), chosen with 1–5. The workflow is condensed to one line. The console collapses to one line (`c` opens it). Navigation shows as icons only. |

Regions are separated by **one cell of canvas**, not by box borders. Each region paints its `inkSurface` with one cell of inner padding and a dim uppercase title. Box-drawing borders appear only on overlays (help, confirm dialogs).

## 6. Regions

- **Header (1 row):** app name; project and branch (` main`); `WSL2 · Ubuntu 22.04`; current phase (`4/7 执行任务`); ` 2` items waiting on the owner; connection with sync age (`● 已连接 · 2s`); the language; the clock. While the run uses development fixtures, `示例数据` / `SAMPLE DATA` is shown. Fixture data must be impossible to mistake for live data.
- **Navigation:** Dashboard, Tasks, Workspace, Agents, Reviews & decisions, Logs, Knowledge, Settings. There is no Chat. Each item has an icon, a label, an optional count, and its shortcut key at the right edge.
- **Current-plan card:** title, digest prefix, approval state (approved / stale / invalidated) and approval time. A stale or invalidated plan shows a warning and disables approve.
- **Workflow:** seven stages: Initialize, Read Spec, Plan & Split, Execute Tasks, Review, Integration, Finalize. Labels come from the shared catalog in both languages. Each stage shows completed, current, pending, blocked or failed, from durable state only. Finalize shows `awaiting decision` until the owner decides (ruling 4). Wide terminals draw it horizontally; narrow ones draw it as one condensed line.
- **Task list:** columns are ID, title (truncated by display width), agent, state (glyph and label), verified-criteria progress (`▰▰▱ 2/3`), priority, labels and a dependency marker (`↳ 003`). It covers every queue state, including blocked, failed, denied, canceled and handed-off. In-review and changes-requested are derived from review state; testing is derived from the attempt phase. Filters and search use `/`; sort is by priority, status or ID. **Never show a percentage.**
- **Task detail:** tabs for Details, Diff, Tests, Reviews, Commits and Discussion (read-only). Details shows:
  - the description;
  - each acceptance criterion as passed, failed, not evaluated or waiting for verification, with its evidence;
  - dependencies, owners and the candidate digest;
  - the **review gate**: each reviewer's state (not started, running, passed, findings, changes required, failed, unavailable), blocking findings and warnings with file:line, and whether the change may be committed. A timeout or crashed reviewer is `unavailable`, never a pass.

  A "Lead estimate" appears only with its author and time.
- **Needs you:** the top of the right column, shown only when something is waiting. A KTD25 scope extension shows each path with create or modify, the reason and the classification, plus `a` approve and `x` reject. A native prompt offers `o` (open session) and never approve.
- **Agents (ruling 3):** each row shows the name, the configured model or CLI, then two states. The current task, the activity and the elapsed time go on a second line.
  - Process state: Online, Starting, Busy, Idle, Offline, Failed.
  - Task state: In progress, Waiting, Needs attention, Done, or `—` when there is none.

  The plan's session states map onto these. An agent awaiting a native prompt shows Busy and Needs attention. A resumable session is Offline · Waiting. An unknown outcome is Unknown and Needs attention.
- **System:** Git repository and branch, worktrees, task storage, Spec-first, agent runtime, test runner, the event stream, and the KTD26 lights (sandbox network, worker sign-in, client versions against the lock, control tmux). States are Healthy, Running, Degraded, Disconnected, Failed and Unknown. A timed-out probe shows Unknown, never Healthy. Components that don't exist (for example remote workers) are not shown.
- **Recent activity:** durable events, newest first, each linked to its task, agent or review.
- **Console:** tabs for Terminal (a read-only session view until an audited take-over), Logs, Reviews and Messages (read-only).
  - Log lines show the time, level (DEBUG, INFO, WARN, ERROR, PASS) and stream (`out` / `err` / `sys`).
  - Redaction, truncation and reconnect gaps are shown as inert text.
  - `p` pauses and resumes following.
  - The input line is described in section 7.
- **Key hints** stay on the last row and change with focus. Disabled actions are drawn dim and struck from the hint set.

## 7. Keyboard and console commands

| Key | Action |
|---|---|
| `1`–`5` | Views (narrow) or navigation targets (wide/medium) |
| `Tab` / `Shift+Tab` | Move focus between regions |
| `↑` `↓` | Move in the focused list |
| `Enter` / `Esc` | Open the selection / close an overlay or go back |
| `[` `]` | Previous / next detail or console tab |
| `/` | Search tasks |
| `a` / `x` | Approve / reject the focused decision (confirm dialog shows target and scope first) |
| `o` | Open the agent's native session |
| `v` / `t` | View a session read-only / take over (audited, T016) |
| `r` | Refresh the current view |
| `c` | Focus the command input (narrow: open the console) |
| `p` | Pause or follow console output |
| `L` | Switch language (中/EN) |
| `?` | Help overlay |
| `q` | Quit; asks first while work is running |

Reject moves from `r` (the earlier mockup) to `x`, because `r` is refresh.

**Command input (ruling 2).** It accepts only allowlisted commands, each backed by an existing owner-control contract:
- `retry <task>`
- `pause`
- `resume`
- `open <task|agent>`
- `help`

Anything else is refused with a one-line message naming the allowed commands. There is no free text, no agent picker and no message sending. While the daemon is unreachable, the input is disabled and says why.

## 8. States

All of these are visible on both clients:
- **Loading:** placeholders.
- **No active run:** setup status.
- **Stale:** no heartbeat for 5 s. A banner appears, and approve and reject are disabled.
- **Disconnected:** a banner, all controls disabled, and the reconnect attempt shown.
- **Version conflict:** shows the newer state and asks again.
- **Pending control:** reads `requested` until the daemon reports the observed outcome.

## 9. Rendering performance (no flicker)

The frame writer in `src/main.ts` replaces today's full repaint (`\x1b[H` plus `\x1b[2K` on every line, every frame):
- **Coalesce:** mark the frame dirty on each event; render at most once per 33 ms.
- **Diff:** compare the new frame with the last one written, and write only the changed rows (cursor-position, then the row). An identical frame writes nothing. Never clear the whole screen per frame.
- **Synchronized output:** wrap each frame in DEC mode 2026 (`\x1b[?2026h` … `\x1b[?2026l`), which Windows Terminal supports. Terminals that ignore the mode lose nothing.
- **Bound the buffers:** a log view keeps a ring buffer (2,000 lines per attempt view). Only the visible slice is laid out.
- **Keep output inert:** strip escape sequences from agent output before it reaches a frame (the plan's existing rule).
- **Restore the terminal:** on exit, including Ctrl+C, restore it and show the cursor again.

## 10. Acceptance

**Owned by T050:**
- Palette output in all four color modes, with no color SGR under `NO_COLOR`.
- Icon-mode detection for `NERD_FONT=1`, `0` and unset, and `TERM=dumb`.
- No Private Use Area code points in text mode.
- Display widths: CJK is two cells, Nerd Font glyphs are one.
- Frame writer:
  - an identical frame writes nothing;
  - one changed row writes only that row;
  - frames are wrapped in mode 2026;
  - 1,000 log events coalesce into a bounded number of frames.
- Legacy views render unchanged.

**Owned by T015:**
- Wide, medium and narrow layouts chosen from both columns and rows, including 150×22 (narrow) and 90×30.
- Long titles and log lines truncate without breaking columns, in both languages.
- Dual agent status.
- Finalize reads `awaiting decision`.
- Every queue state shows its label and glyph.
- The review gate shows `unavailable` for a missing review.
- The existing T015 scenarios.

**Owned by T016:**
- The command allowlist and the refusal of free text.
- Approve and reject confirmations, including the `x` binding.
- Take-over.
- Real-terminal runs at two sizes in both languages, in Windows Terminal with a Nerd Font and again with `NERD_FONT=0`.
