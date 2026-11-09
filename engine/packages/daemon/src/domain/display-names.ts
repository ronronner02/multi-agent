/**
 * U9 / KTD8 — the readable names the owner read publishes beside the ids.
 *
 * Names come from recorded text, never from ids: a run starts with its goal and receives a
 * concise title from the lead's reply; a task has an explicit title or its body's first line.
 * A seat's name is its role and client. These plain-text rules let the creation path and read
 * model derive the same name from the same row — a row recorded before the names existed is
 * named on read by calling the same functions.
 *
 * The stored form is the English fallback. A client that renders in another language rebuilds
 * the name from its parts (a review's round and subject, a seat's role and client), which this
 * module also returns; nothing here decides how the UI composes them.
 */

/** The longest title a derived name carries, in characters. */
export const DISPLAY_NAME_LIMIT = 48;

/** What a shortened title may not end with: a sentence's punctuation, not the title's words. */
const TRAILING_PUNCTUATION = /[,.;:!?，。；：！？、…]+$/u;

/** A markdown heading or list marker is structure, not part of the title it introduces. */
function withoutMarkup(line: string): string {
  return line.replace(/^#{1,6}\s+/u, "").replace(/^[-*+]\s+/u, "");
}

/** The first non-blank line of a body, without a leading heading or list marker. */
export function firstLine(body: string): string {
  const line = body.split(/\r?\n/).map(entry => entry.trim()).find(entry => entry.length > 0) ?? "";
  return withoutMarkup(line);
}

/**
 * A title cut to `limit` characters at a word boundary.
 *
 * A space at the cut means the limit already lands between two words, so the head is used
 * whole. Otherwise the head is cut back to its last space: the word the limit landed inside is
 * dropped rather than shown half-written. Text with no spaces at all — Chinese, or one long
 * token — has no word boundary to cut at, so it is cut by character.
 */
export function shortenTitle(raw: string, limit = DISPLAY_NAME_LIMIT): string {
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  const characters = [...collapsed];
  if (characters.length <= limit) return collapsed.replace(TRAILING_PUNCTUATION, "").trim();
  const head = characters.slice(0, limit);
  const boundary = characters[limit] === " " ? limit : head.lastIndexOf(" ");
  const title = (boundary > 0 ? head.slice(0, boundary) : head).join("");
  return title.replace(TRAILING_PUNCTUATION, "").trim();
}

/** A concise title authored in the existing lead reply, never inferred from later headings. */
export function generatedReplyTitle(body: string): string | null {
  const heading = /^# ([^\r\n]+)(?:\r?\n|$)/u.exec(body.trimStart())?.[1];
  if (!heading || /[\u0000-\u001f\u007f]/u.test(heading)) return null;
  const title = heading.replace(/\s+/gu, " ").trim();
  return title && [...title].length <= 80 ? title : null;
}

/** A run's name from its goal, or `null` when the goal carries no text to name it with. */
export function runName(goal: string): string | null {
  return shortenTitle(firstLine(goal)) || null;
}

/** A task's name from its title, which is the first line of the body it was admitted with. */
export function taskName(body: string): string | null {
  return shortenTitle(firstLine(body)) || null;
}

/** A reviewer task's name: the task it reviews, and the round when there is more than one. */
export function reviewName(implementerName: string, round: number): string {
  return `${round > 1 ? `Review ${round}` : "Review"}: ${implementerName}`;
}

/** The name a run recorded before names existed falls back to: its creation order on the rig. */
export function ordinalRunName(ordinal: number): string {
  return `Run ${ordinal}`;
}

/** The same fallback for a task whose recorded body has nothing to name it with. */
export function ordinalTaskName(ordinal: number): string {
  return `Task ${ordinal}`;
}

/** A role's label in the stored English form. Clients localise from the `role` field instead. */
export function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

const CLIENT_LABELS: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** A client's label in the stored English form. Clients localise from the `client` field instead. */
export function clientLabel(client: string): string {
  return CLIENT_LABELS[client] ?? client;
}

/**
 * A seat's name from the role and client it runs.
 *
 * The number is present only when the role and client repeat on the rig — both members of the
 * group carry it, so "Implementer · Codex 1" and "Implementer · Codex 2" stay distinct.
 */
export function seatName(input: { role: string; client: string; index?: number | null }): string {
  const base = `${roleLabel(input.role)} · ${clientLabel(input.client)}`;
  return input.index === undefined || input.index === null ? base : `${base} ${input.index}`;
}