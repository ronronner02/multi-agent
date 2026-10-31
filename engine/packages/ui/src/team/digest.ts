/**
 * Slice B — how a digest is shown.
 *
 * A full `sha256:…` is 71 characters: too long for a header cell and unreadable wrapped over
 * three lines. The short form keeps the algorithm and the first 12 hex characters, which is what
 * a person compares by eye, and the full value stays in the element's `title` so nothing is lost.
 */

const PREFIX = "sha256:";
const SHOWN = 12;

export function shortDigest(value: string | null | undefined): string {
  if (!value) return "—";
  const hex = value.startsWith(PREFIX) ? value.slice(PREFIX.length) : value;
  if (hex.length <= SHOWN) return value;
  return `${PREFIX}${hex.slice(0, SHOWN)}…`;
}

/** The full value, for a `title` attribute: the reader can still copy exactly what the daemon sent. */
export function fullDigest(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}
