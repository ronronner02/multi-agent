***

# Task: Build a Premium Multi-Agent Engineering Team TUI

You are the senior frontend/TUI engineer responsible for implementing the terminal user interface of my Multi-Agent Engineering Team.

Your goal is to build a beautiful, professional, production-quality, keyboard-driven terminal application inspired by a modern dark engineering control center with a traditional Chinese ink-wash (“水墨丹青”) aesthetic.

The interface must be implemented as a real, interactive TUI, not a static mockup, web page, or screenshot.

All user-facing interface text must be in English.

## 1. Project Context

This project is a Spec-first-driven multi-agent software engineering system.

The intended workflow is:

1. Initialize the project.
2. Read and understand the specifications.
3. Create an implementation plan.
4. Break the plan into executable tasks.
5. Execute tasks using coding agents.
6. Run automated tests.
7. Perform independent code reviews.
8. Fix review findings and re-review.
9. Integrate completed tasks.
10. Run integration tests and final quality gates.
11. Deliver the completed changes.

The main orchestrator is a strong independent model. Worker agents use their native CLI tools, such as Claude Code, Codex, and Pi. Two independent reviewers may be used for task-level code review.

The UI must make it easy to understand what the system is doing, which agents are working, which tasks are blocked, and what needs human attention.

## 2. Mandatory Preliminary Steps

Before writing code:

- Inspect the existing repository, package.json, architecture, dependencies, and current UI implementation.
- Read the applicable project instructions, including AGENTS.md, CLAUDE.md, and any relevant Spec-first skills or project rules.
- Follow the existing technology stack and coding conventions where possible.
- Do not replace existing infrastructure or introduce a second framework without a clear reason.
- Identify the current TUI framework and its actual capabilities before implementing components.
- If the current project has not selected a TUI framework, propose the smallest suitable stack and explain the choice. **You must also provide a mapping for the UI components listed in Section 8 to the primitives of that framework** (e.g., in Ink, `<Box>` and `<Text>`; in Bubbletea, `Model` and `View` functions) rather than assuming React-style components exist.
- Reuse existing state management, task models, agent adapters, event streams, and persistence layers where available.
- Do not fabricate backend APIs, agent execution results, task statuses, or integration points.
- Do not silently overwrite unrelated work.

If the project is still at the design-approval stage, follow the existing Spec-first UI design workflow: prepare the design specification and interaction proposal first, then wait for approval before production implementation. If implementation has already been approved, proceed with the code.

## 3. Visual Design Direction

Create a premium dark terminal dashboard that evokes the mood of a traditional Chinese ink-wash painting (“水墨丹青”) rendered on a modern engineering console.

**Fundamental principle:** The terminal cannot display video, images, or paper textures. “Ink-wash” is expressed through color semantics, restrained contrast, and deliberate use of negative space (留白). Do not attempt to simulate texture with ASCII art or decorative characters.

### 3.1 Color Palette (ANSI / TrueColor semantic mapping)

Use the following semantic colors. TrueColor values are provided for terminals that support them; also define ANSI 16 fallbacks for portability and user-theme respect.

| Role | TrueColor (Hex) | ANSI 16 Fallback | Intent |
|---|---|---|---|
| **Background (canvas)** | `#0D1117` (deep ink-blue, not pure black) | Default terminal background | The “paper” is dark, like ink on a night scroll. Never override the user’s terminal background; render panels as slightly lighter overlays. |
| **Panel surface** | `#161B22` (subtle lift from canvas) | `bright black` / default | Separates functional regions without hard borders. |
| **Primary text (ink)** | `#C9D1D9` (soft off-white, warm-cool balance) | `white` / `bright white` | High contrast without harshness; reads as “ink on paper.” |
| **Secondary text (wash)** | `#8B949E` (muted blue-gray) | `bright black` | Dimmed metadata, timestamps, helper text. |
| **Accent / Focus (丹青)** | `#D29922` (aged amber / 赭石) **or** `#A371F7` (muted violet / 紫毫) | `yellow` or `magenta` | The single “seal” color. Use sparingly: selected item border, active tab underline, critical action button. **Do not** use electric blue as primary accent; it fights the ink-wash mood. |
| **Success (青绿)** | `#3FB950` (celadon green) | `green` | Passed tests, healthy component, completed task. |
| **Warning (藤黄)** | `#D29922` (same as accent) | `yellow` | Degraded state, pending human decision. |
| **Error / Blocked (朱砂)** | `#F85149` (vermilion red) | `red` | Failed test, blocking review finding, error state. |
| **Border (淡墨)** | `#30363D` (very low-contrast gray-blue) | `bright black` / default | Thin, unobtrusive panel separators. Prefer whitespace over heavy borders. |
| **Selection background** | `#264F78` (muted indigo wash) | `blue` background | Visible but not saturated; does not overpower ink text. |

### 3.2 Visual hierarchy through color

- **Never rely on color alone** to convey status. Always pair color with a text label, a distinct glyph (e.g., `✔`, `✖`, `!`, `●`), or both. This is a hard accessibility requirement.
- **Accent color is scarce.** If more than ~5% of visible characters use the accent color, reduce it. Ink-wash aesthetics value restraint.
- **Borders are optional.** Use them only where two panels would otherwise merge ambiguously. Prefer blank space (留白) between sections.
- **Selected item:** Use a subtle background wash (`#264F78` or reverse video) plus a single accent-colored left border (e.g., `▌`). Do not use bold + underline + color + background all at once.
- **Progress and status:** Use glyphs from a consistent icon set supported by the chosen TUI framework (e.g., Nerd Font icons if available, otherwise simple Unicode: `● ○ ◐ ✔ ✖ ⚠`). Do not mix emoji and monochrome symbols.

### 3.3 What NOT to do (ink-wash anti-patterns)

- **No electric blue, neon cyan, or saturated purple** as primary accents. These read as “cyberpunk,” not “ink-wash.”
- **No gradient text** or rainbow coloring. One accent, one semantic set.
- **No large decorative ASCII art** (mountains, bamboo, seals) in the main working area. At most, a single-line minimal watermark in the header, and only if it does not steal focus.
- **No heavy borders or box-drawing characters** around every panel. The default should be whitespace separation; borders only when necessary.

## 4. Main Screen Layout

Implement the main screen using a responsive, terminal-native layout.

Conceptual layout:

┌─────────────────────────────────────────────────────────────────────────────┐
│ APP HEADER: Logo | Multi-Agent Engineering Team | Project | Runtime Status │
├────────────┬──────────────────────────────────────────────┬─────────────────┤
│            │                                              │                 │
│ LEFT       │ TOP WORKFLOW PROGRESS                        │ AGENT PANEL     │
│ NAVIGATION ├──────────────────────────────────────────────┤                 │
│            │                                              ├─────────────────┤
│ Dashboard  │ TASK LIST / TASK QUEUE                       │ SYSTEM STATUS   │
│ Tasks      │                                              │                 │
│ Workspaces ├──────────────────────────────────────────────┤                 │
│ Agents     │ SELECTED TASK DETAILS                        ├─────────────────┤
│ Reviews    │                                              │ RECENT ACTIVITY │
│ Chat       │                                              │                 │
│ Knowledge  │                                              │                 │
│ Logs       │                                              │                 │
│ Settings   │                                              │                 │
├────────────┴──────────────────────────────────────────────┴─────────────────┤
│ BOTTOM CONSOLE: Terminal | Logs | Reviews | Messages | Command Input        │
└─────────────────────────────────────────────────────────────────────────────┘

This is a conceptual hierarchy, not a requirement to force every panel into one fixed layout. Adapt it to the available terminal dimensions.

### 4.1 Header
The top header should include:
- Application identity: `Multi-Agent Engineering Team`
- Current project name.
- Current branch when available.
- Runtime or environment indicator.
- Current workflow phase.
- A compact notification or attention indicator when necessary.
Keep the header shallow. Do not waste vertical space on a large title banner.

### 4.2 Left Navigation
Create a compact navigation sidebar containing:
- Dashboard
- Tasks
- Workspaces
- Agents
- Reviews
- Chat
- Knowledge
- Logs
- Settings
Each navigation item should have:
- A consistent icon or symbol.
- A readable label.
- An optional count badge for actionable items.
- A visible selected state.
- A keyboard shortcut when appropriate.
The selected section should be immediately recognizable. When the terminal is too narrow, collapse the sidebar to icons or switch to a compact navigation mode.

### 4.3 Workflow Progress Panel
Show the major workflow phases: `Initialize → Read Spec → Plan & Split → Execute Tasks → Review → Integration → Finalize`.
For each phase, distinguish: Completed, Current, Pending, Blocked, Failed.
Use a compact horizontal progress indicator on sufficiently wide terminals. On narrow terminals, use a vertical or condensed representation.
Do not mark a phase completed until the underlying workflow state confirms completion.

### 4.4 Task List Panel
Display tasks as compact rows instead of oversized cards. Each row should show: Task ID, Short title, Assigned agent, Current status, Progress (when meaningful), Priority, Relevant labels, Dependency/blocker indicator.
Support these task states: Pending, Ready, In Progress, Testing, In Review, Changes Requested, Blocked, Completed, Failed, Cancelled.
Include task filters: All, Ready, In Progress, In Review, Blocked, Completed.
Include search and sorting by priority, status, and task ID.
The selected task must have a strong but restrained visual highlight. Long titles and labels must be truncated gracefully. Progress values must come from actual task state. Never invent percentages.

### 4.5 Selected Task Details Panel
When the user selects a task, display its details. Include: Task ID and title, Description, Current status and priority, Assigned agent, Dependencies, Acceptance criteria, Related files, Test results, Review results, Commit information, Recent task events.
Provide tabbed or keyboard-switchable views: Details, Diff, Tests, Reviews, Commits, Discussion.
Acceptance criteria must be individually checkable in the UI. Distinguish between: Not evaluated, Passed, Failed, Waiting for verification. A task must not be displayed as completed merely because the coding agent says it finished.

### 4.6 Agent Panel
Show the agents participating in the project (e.g., Lead / Orchestrator, Claude Code, Codex, Pi). Agent names must be configurable.
Each agent row should show: Agent name, Configured model or CLI, Status (Online, Offline, Starting, Busy, Waiting, Failed, Needs Attention), Current task, Current activity, Latest result or error, Elapsed time.
Selecting an agent should reveal its recent activity, task assignments, and logs. Use a small status indicator plus text. Never rely on color alone. The UI must distinguish between an agent process being alive and an agent successfully completing its task.

### 4.7 Review Panel
Code review is a first-class part of this product. For each logical code change, show independent reviewer results (e.g., Claude Review, Codex Review).
Display: Reviewer identity, Review status, Findings count, Blocking findings, Warnings, Files and line references, Review timestamp, Whether a re-review is required.
Use explicit states: Not Started, Running, Passed, Findings, Changes Required, Failed, Unavailable.
Do not treat a timeout, missing response, or reviewer crash as a successful review. The UI must make it obvious whether a change is eligible for commit under the configured policy.

### 4.8 System Status Panel
Show the health of important project components: Git repository and current branch, Worktree status, Task storage, Spec-first integration, Agent runtime, Test runner, Event stream, Remote workers (when configured).
Use clear status labels such as: Healthy, Running, Degraded, Disconnected, Failed, Unknown.
Only show components that actually exist. Do not present placeholder services as operational infrastructure.

### 4.9 Recent Activity Panel
Show a concise, chronological event feed (e.g., `21:04:12 — TASK-003 assigned to Claude`). Events must be derived from real application events or clearly identified sample fixtures in development mode. Support scrolling and opening the related task, agent, or review.

### 4.10 Bottom Console
Create a persistent or collapsible bottom console with tabs: Terminal, Logs, Reviews, Messages.
The console should display timestamped, color-coded log levels: DEBUG, INFO, WARN, ERROR, PASS.
Provide: Scrollable output, Pause/resume following new output, Clear visual distinction between stdout and stderr when available, Copyable log content if supported, A compact input field for supported commands or messages, An agent selector when sending a message to a specific agent.
Do not invent a shell or command execution API. Wire the input only to real supported application functionality. The console must not consume too much vertical space.

## 5. Layout Proportions and Responsive Behavior

Use these proportions as starting points, not hardcoded pixel dimensions.

**Breakpoints must be determined by both `terminal.columns` and `terminal.rows`.**

- **Wide terminal (approx. 140–180 columns)**: Header 2–3 rows; Left sidebar 20–25 columns; Main work area 60–70% of remaining width; Right info column 25–35% of remaining width; Bottom console 20–25% of available height. Remaining height goes to workflow progress, task list, and task details.
- **Medium terminal (approx. 100–139 columns)**: Reduce sidebar width. Keep task list and task details as primary content. Move secondary information into switchable tabs or a compact side panel. Avoid clipping task titles.
- **Narrow terminal (below 100 columns OR rows < 24)**: Use a single-column or master-detail layout. Let the user switch between Tasks, Task Details, Agents, Reviews, and Logs. Do not render unreadable three-column panels. Preserve selected task and navigation context. Collapse workflow tracker, reduce activity feed, and make bottom console collapsible. Prioritize task list and task details.
- **Handle terminal resize events gracefully. Never assume a fixed resolution.**

## 6. Keyboard Interaction

This application must be keyboard-first. Provide a consistent shortcut system and a visible help overlay.

Suggested shortcuts:
- `1` — Dashboard; `2` — Tasks; `3` — Agents; `4` — Reviews; `5` — Logs
- `Tab` / `Shift+Tab` — Move focus
- `Arrow Up` / `Arrow Down` — Navigate lists
- `Enter` — Open or confirm selection
- `Esc` — Close dialog or return
- `/` — Search
- `r` — Refresh current view
- `c` — Open the configured command interface
- `?` — Show keyboard shortcuts
- `q` — Quit, with confirmation when work is running

Avoid shortcuts that conflict with terminal input. Show a small contextual footer with relevant shortcuts. Every interactive control must have a clear focus state. Mouse support is optional.

## 7. Interaction and Visual Quality

Implement the following interaction patterns: Navigation, Task selection/filtering, Task detail tabs, Agent inspection, Review finding inspection, Log scrolling, Search/empty states, Loading/disconnected/error/blocked states, Confirmation dialogs, Clear feedback after actions, Help overlay.

Use restrained transitions only if the TUI framework supports them without harming performance or accessibility. Avoid full-screen flicker. Use stable panel sizes where possible, and prevent rapidly changing content from causing unnecessary layout shifts. All panels must have consistent borders, spacing, alignment, labels, and status conventions.

## 8. Architecture and Implementation Constraints

Keep the presentation layer separate from business logic. Use reusable components where supported by the selected TUI framework, such as: AppShell, Header, Sidebar, WorkflowProgress, TaskList, TaskDetails, AgentList, ReviewPanel, SystemStatus, ActivityFeed, BottomConsole, SearchInput, StatusIndicator, ConfirmDialog, HelpOverlay.

Requirements:
- Use the existing language and framework where practical.
- Keep TypeScript strict if the project uses TypeScript.
- Define explicit types for tasks, agents, reviews, events, and system health.
- Separate UI state from persistent project state.
- Do not put all logic in one giant component.
- Avoid unnecessary dependencies and global mutable state.
- Do not introduce a mock backend to conceal missing integrations.
- Keep actual CLI process management in the appropriate service or adapter layer.
- Keep the UI responsive when agents produce large volumes of output.
- Clean up subscriptions, child processes, and event listeners when appropriate.
- Respect terminal capabilities and color settings.
- If a real backend integration is not yet available, implement a clearly isolated development fixture provider. Make it impossible to confuse fixture data with live execution data.

## 9. Data and State Modeling

The UI should consume structured application events rather than parse arbitrary terminal output to determine task status. Define or reuse types equivalent to: Task, TaskDependency, Agent, AgentRun, Review, ReviewFinding, TestResult, CommitRecord, ActivityEvent, SystemComponentStatus.

A task status must have a single authoritative source. The UI must not independently decide that a task has passed its acceptance criteria. Represent unavailable or unknown values honestly.

## 10. Accessibility and Terminal Compatibility

- Ensure readable contrast. Never communicate status through color alone.
- Handle Unicode width correctly. Avoid relying on emoji width for layout calculations.
- **You must respect `NO_COLOR` and `TERM=dumb`. When colors are disabled, states must be distinguished solely by text labels and glyphs (e.g., `[PASS]`, `[FAIL]`, `[BLOCKED]`). Success and error states must not rely solely on green and red; they must also use distinct glyphs and text.**
- Support common Windows terminal environments. Avoid shell-specific assumptions.
- Handle Ctrl+C and graceful shutdown correctly. Do not corrupt the terminal after exiting. Restore terminal state and cursor visibility.
- The first target is Windows local development. Keep the architecture portable enough for later macOS and Linux support.

## 11. Testing and Acceptance Criteria

Do not consider the task complete simply because the application starts. Verify the following:

1. The TUI launches successfully using the project's documented command.
2. The main dashboard renders without layout errors.
3. Navigation works using the keyboard.
4. Tasks can be selected, filtered, and inspected.
5. Agent states are displayed correctly.
6. Review states distinguish Passed, Findings, Failed, and Unavailable.
7. Logs and activity events render correctly.
8. The interface adapts to wide, medium, and narrow terminal dimensions.
9. Short terminal heights do not make the main screen unusable.
10. Long task names and log lines do not break the layout.
11. Empty, loading, error, disconnected, and blocked states are handled.
12. No unsupported APIs or fabricated live data are presented as real.
13. Existing project tests continue to pass.
14. New UI behavior has appropriate tests where practical.
15. The terminal is restored cleanly when the application exits.
16. **In `TERM=xterm-256color` without `COLORTERM`, the UI remains usable and all states are distinguishable. In `NO_COLOR=1`, the UI emits no ANSI color codes and remains fully navigable.**

Add automated layout or component tests where the framework supports them. Manually test at multiple terminal sizes as well.

## 12. Delivery Requirements

Before implementation, summarize:
- Existing TUI framework and relevant project architecture.
- Files that will be changed.
- Components to be created or reused.
- Integration points with the existing task and agent systems.
- Any important missing interfaces or decisions.

Then implement the approved scope.

After implementation, report:
- Files changed.
- Components implemented.
- Keyboard shortcuts.
- Commands to run the application and tests.
- Actual test results.
- Features connected to real data.
- Features still using development fixtures.
- Known limitations.
- Any decisions requiring human approval.

Do not claim a test passed unless it actually ran and passed.

## Final Quality Bar

The result should feel like a polished, premium engineering command center rather than a generic terminal menu.

The layout should be immediately understandable, visually balanced, information-dense, and comfortable to use for long development sessions.

Prioritize, in this order:
1. Correct interaction and state representation.
2. Clear visual hierarchy.
3. Responsive terminal layout.
4. Consistent styling and spacing.
5. Reliable keyboard navigation.
6. Integration with the real project workflow.
7. Subtle visual polish.

**When information density conflicts with the ink-wash aesthetic of negative space, prioritize information density. Negative space should be achieved through panel padding and component spacing, not by hiding information or rendering excessive empty lines. The ink-wash mood serves readability, not the other way around.**

Start by inspecting the repository and its Spec-first instructions. Do not rewrite unrelated parts of the application.