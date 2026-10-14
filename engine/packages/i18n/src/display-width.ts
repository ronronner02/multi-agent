import stringWidth from "string-width";

/** Terminal cells in one rendered line; wrapping remains renderer-owned. */
export function displayWidth(text: string): number {
  return stringWidth(text, { ambiguousIsNarrow: true });
}
