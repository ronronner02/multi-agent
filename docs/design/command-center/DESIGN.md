# Command-center design

This is the shared token contract for the browser and desktop command center. The shell and current screens use the same variables; the retained run-page names are aliases, not a second palette.

## Color tokens

Dark is the default. An explicit dark or light preference stays fixed; system follows the operating system. Surfaces are opaque and lift from the canvas to panels and overlays. Raw hex colors belong only in these CSS token definitions, never in components or selector rules.

| Token | Dark | Light |
| --- | --- | --- |
| `--ui-canvas` | `#151619` | `#f6f6f8` |
| `--ui-surface` | `#1c1d21` | `#ffffff` |
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

The historical loop is restored without modification. The reduced-motion poster is a frame extracted from that same file. Background playback pauses while the window is blurred or the document is hidden; reduced motion loads only the still image. Cards and overlays remain opaque.

The notification badge is the length of the same pending-decision array rendered in the chat. A healthy state creates no attention row. Each pending decision carries one question or action; historical chat stays separate. Internal run and task IDs are used for routing, not as labels.

## Scope

This document implements KTD19. The six destinations and persistent lead chat are the shared shell. Their detailed task, workspace, review and analytics screens follow the remaining command-center units; no placeholder metrics, monetary values or unsupported controls are introduced.
