# Command-center design

This is the shared token contract for the browser and desktop command center. The shell and current screens use the same variables; the retained run-page names are aliases, not a second palette.

## Color tokens

Dark is the default. An explicit dark or light preference stays fixed; system follows the operating system. Cards use translucent glass over the single page skin. Inputs, code, diffs and overlay panels retain opaque reading surfaces. Raw hex colors belong only in these CSS token definitions, never in components or selector rules.

| Token | Dark | Light |
| --- | --- | --- |
| `--ui-canvas` | `#151619` | `#f6f6f8` |
| `--ui-surface` | `#1c1d21` | `#ffffff` |
| `--ui-glass-surface` | `rgb(28 29 33 / .54)` | `rgb(255 255 255 / .58)` |
| `--ui-glass-border` | `rgb(255 255 255 / .16)` | `rgb(255 255 255 / .46)` |
| `--ui-glass-highlight` | `rgb(255 255 255 / .09)` | `rgb(255 255 255 / .70)` |
| `--ui-raised` | `#232429` | `#ffffff` |
| `--ui-divider` | `#2c2d34` | `#e0e1e7` |
| `--ui-divider-soft` | `#24252b` | `#edeef2` |
| `--ui-text` | `#ededf0` | `#20212a` |
| `--ui-text-secondary` | `#c2c3cc` | `#454857` |
| `--ui-muted` | `#999ba6` | `#646675` |
| `--ui-faint` | `#8b8e9b` | `#737583` |
| `--ui-selection` | `#292b38` | `#ececf6` |
| `--ui-accent` | `#818cf8` | `#6366f1` |
| `--ui-accent-press` | `#a5b4fc` | `#4f46e5` |
| `--ui-on-accent` | `#151619` | `#ffffff` |
| `--ui-accent-soft` | `#25283c` | `#eeedff` |
| `--ui-ok` | `#4ade80` | `#168345` |
| `--ui-warn` | `#fbbf24` | `#8a5900` |
| `--ui-warn-soft` | `#332a1c` | `#fff5dd` |
| `--ui-warn-border` | `#725b2e` | `#d9be85` |
| `--ui-error` | `#f87171` | `#b42318` |
| `--ui-error-soft` | `#382124` | `#fff0ed` |
| `--ui-add-bg` | `#1a3227` | `#e8f4ec` |
| `--ui-add-ink` | `#86d9a0` | `#27623a` |
| `--ui-remove-bg` | `#382124` | `#fff0ed` |
| `--ui-remove-ink` | `#f8a4a4` | `#9f342e` |
| `--ui-overlay` | `rgb(0 0 0 / .55)` | `rgb(32 33 42 / .22)` |
| `--ui-shadow` | `rgb(0 0 0 / .35)` | `rgb(32 33 42 / .16)` |

The `--paper`, `--surface`, `--ink`, `--line`, `--accent`, attention, error and diff variables used by the retained screens alias the corresponding semantic tokens in `team.css`.

## Type and layout

- Self-hosted Inter, with system CJK fallbacks; IBM Plex Mono for code and branches. These typefaces need no remote fetch. The shared HTML still requests its pre-existing Material Symbols font; command-center icons use local SVGs and do not depend on it.
- Headings: 24 px; UI: 14 px; secondary labels: 12 px; footer: 11 px. Headings remain sans-serif in both themes.
- Sidebar: 188 px. Top bar: 48 px. Footer: at least 28 px. Controls: 32–36 px. Corners: 6 px.
- New layout uses an 8 px spacing grid. Panels use 16 or 24 px padding.
- At 760 px and below, the rail becomes a keyboard-accessible menu; the chat uses the whole viewport. Existing run and task layouts keep their mobile behavior.

## Motion and attention

The historical loop is restored without modification. The reduced-motion poster is a frame extracted from that same file. Background playback pauses while the window is blurred or the document is hidden; reduced motion loads only the still image. Cards use an 8 px backdrop blur, a subtle inset highlight and a tinted border; their text remains fully opaque. Muted card text uses the stronger secondary-text color for contrast. Nested cards share the parent glass layer. The overview header never embeds its own skin image. This styling adds no motion.

The notification badge is the length of the same pending-decision array rendered in the chat. A healthy state creates no attention row. Each pending decision carries one question or action; historical chat stays separate. Internal run and task IDs are used for routing, not as labels.

## Scope

This document implements KTD19. The six destinations and persistent lead chat are the shared shell. Their detailed task, workspace, review and analytics screens follow the remaining command-center units; no placeholder metrics, monetary values or unsupported controls are introduced.

## Content flow and long-text behavior

The desktop uses compact, content-first bands rather than a workbench beside an unbounded stack. This extends the existing glass direction; it does not replace the skin or introduce a second design system.

| Surface | Primary content and action | Layout and overflow contract |
| --- | --- | --- |
| Project history | Open a planning record, execution, or retained result | Keep those groups distinct. Project selection cards align at the top without stretching to the longest neighbor. Project names and paths use bounded disclosures. Record names use two-line button previews; opening a record exposes its full goal. No invented empty records. |
| Overview | Select work and inspect its evidence | Heading, measured summary/progress, owner attention, full-width task workbench, integration results, then the three supporting status cards. No tall side rail controlling the task row. |
| Tasks | Choose a task; inspect its brief, criteria and result | List and inspector use shrinkable columns and bounded independent scroll on a wide workspace. Stack when the content area is 720px or narrower. Empty filters hide the redundant inspector. |
| Workspace | Read one member's current work and tool activity | Cards keep short identity rows; lengthy activity stays inside its reading area. Split view stacks below an 800px content area. Focus view preserves full text. |
| Documents | Read, compare and confirm a specific version | The record goal uses the shared three-line disclosure. Navigation and reader stay separate; long documents scroll inside keyboard-focusable reading surfaces. Comparison stacks below an 800px content area. Confirmation remains visible outside document scrolling. |
| Reviews | Read the candidate diff, findings and recorded gates | Full candidate evidence, bounded findings and unchanged gate semantics. Short diffs use natural height; long code scrolls locally within 560px or 62% of the viewport height. Stack below an 800px content area. A long finding cannot widen the diff. |
| Analytics | Inspect measured usage | Charts retain their existing dimensions; tables own horizontal overflow. Missing measurements stay unknown. |
| Settings | Edit policy and inspect saved/effective values | Forms wrap by field, model identifiers wrap inside fixed-layout tables, and only the table scrolls horizontally. Launch evidence occupies at most 320px or 45% of the viewport height, with sticky column headings and a keyboard-focusable scroll area. Every returned record stays accessible; adding rows does not grow the page. No settings are saved by a layout action. |
| Chat and overlays | Read the dialogue, answer a question or send a message | Viewport-owned panel with an expandable context heading, fixed composer and scrollable history. Stage controls scroll with history; a direct document action remains in the header, so a short viewport never sacrifices the composer to fixed metadata. Preserve full choices and approval consequence text; never clamp them into ambiguous actions. |

- Page/card groups use 16px gaps; headings and actions can wrap. Every flexible child accepts a zero minimum width. Resizing and 200-percent reading must not produce a page-level horizontal scrollbar.
- Navigable task and record names show at most two lines. Their existing detail entry exposes the full text. Standalone long goals, briefs, event names and findings use a three-line preview with an explicit keyboard-operable expansion button. Rendered overflow is measured again after resizing, so shorter CJK names and narrow headings also get an expansion control. Expanded prose remains complete in a bounded reading area; no bytes are removed from state or storage.
- Code, diffs, document content and long identifiers have local scrolling or wrapping. Do not clip approval consequences, options, errors or model-policy choices merely to fit a card.
- The overview defaults to active work while it exists, then exposes completed work. Once the owner chooses a filter, subsequent reads do not override that choice.
- Empty content uses compact natural height. Equal card heights, viewport fillers and oversized fixed minimum heights must not manufacture blank panels.
- Supporting status cards form three columns, then two below a 900px content area, then one below 600px. The last card spans the narrow two-column row. These are content-area thresholds, accounting for the sidebar.
- The verified-account retention wrapper preserves the shell's full viewport height. A failed account read still hides the retained subtree; it does not expose gated controls.

No motion, background asset, execution approval, document version, model policy, route or backend contract changes are introduced by this layout adjustment.
