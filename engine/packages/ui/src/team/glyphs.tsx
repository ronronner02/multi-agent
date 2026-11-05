/**
 * U10 — the handful of glyphs the team surface draws.
 *
 * One family, 16px canvas, 1.4px stroke, round joins, sized by the caller. They are inline so
 * the desktop app ships no icon font and no network request, and each is decorative: the label
 * or the accessible name is always the text beside it.
 */

const base = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
  strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true,
};

export function ChevronLeft() {
  return <svg {...base}><path d="M10 3 5 8l5 5" /></svg>;
}

export function ChevronRight() {
  return <svg {...base}><path d="M6 3l5 5-5 5" /></svg>;
}

export function MoreHorizontal() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" />
  </svg>;
}

export function Check() {
  return <svg {...base} strokeWidth={1.5}><path d="M3 8.5 6.5 12 13 4.5" /></svg>;
}

export function Close() {
  return <svg {...base}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
}

export function Caret() {
  return <svg {...base}><path d="M4 6l4 4 4-4" /></svg>;
}