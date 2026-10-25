import { displayWidth } from "@openrig/i18n";

const ICONS = {
  branch: ["\uf126", "[Git]"],
  directory: ["\uf07b", "[Dir]"],
  agent: ["\uf544", "[AI]"],
  lead: ["\uf0e8", "[Lead]"],
  dashboard: ["\uf0e4", "[Dash]"],
  tasks: ["\uf0ae", "[Task]"],
  reviews: ["\uf06e", "[Rev]"],
  logs: ["\uf15c", "[Log]"],
  knowledge: ["\uf02d", "[Doc]"],
  settings: ["\uf013", "[Set]"],
  passed: ["\uf00c", "[OK]"],
  failed: ["\uf00d", "[Err]"],
  warning: ["\uf071", "[!]"],
  blocked: ["\uf05e", "[Blk]"],
  running: ["\uf110", "[Run]"],
  pending: ["\uf10c", "[ ]"],
  owner: ["\uf0f3", "[!!]"],
  unknown: ["\uf128", "[?]"],
  locked: ["\uf023", "[Lock]"],
} as const;
export type IconName = keyof typeof ICONS;

export function createIcons(env: NodeJS.ProcessEnv = process.env): Readonly<Record<IconName, string>> {
  const nerd = env["TERM"] !== "dumb" && /^(1|true)$/.test(env["NERD_FONT"] ?? "");
  return Object.fromEntries(Object.entries(ICONS).map(([role, pair]) => [role, pair[nerd ? 0 : 1]])) as Record<IconName, string>;
}
export function padDisplay(text: string, columns: number): string {
  return text + " ".repeat(Math.max(0, columns - displayWidth(text)));
}
export function truncateDisplay(text: string, columns: number): string {
  if (columns <= 0) return "";
  if (displayWidth(text) <= columns) return text;
  let result = "", width = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const next = displayWidth(segment);
    if (width + next + 1 > columns) break;
    result += segment; width += next;
  }
  return result + "\u2026";
}
