/**
 * Slice B — the unified-diff model.
 *
 * The daemon serves a candidate's patch as one unified diff string (`team-result.ts`). This module
 * turns that text into files, hunks and numbered lines so both the Workspace and the Reviews
 * screen can render it. It parses git's own output and nothing else: no second manifest, no
 * inferred content, and no line the patch does not carry.
 */

export type DiffLineKind = "context" | "add" | "remove" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** The line's number in the pre-image; null on an added line and on a note. */
  oldLine: number | null;
  /** The line's number in the post-image; null on a removed line and on a note. */
  newLine: number | null;
}

export interface DiffHunk {
  /** The `@@ … @@` line itself, including its trailing context, as git wrote it. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  /** The post-image path: what the file is called after the patch. */
  path: string;
  /** The pre-image path, present only when the patch renames the file. */
  previousPath: string | null;
  status: DiffFileStatus;
  /** A binary file carries no hunks; the patch says only that the two sides differ. */
  binary: boolean;
  /** Added and removed line counts, or null for a binary file, whose size the patch never states. */
  added: number | null;
  removed: number | null;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip git's `a/` and `b/` prefixes; a path is shown to the owner as the repository knows it. */
function stripPrefix(value: string): string {
  return value.replace(/^[ab]\//, "");
}

/**
 * The paths a `diff --git` header names, for the cases the `---`/`+++` lines cannot state.
 *
 * The header is ambiguous for paths containing " b/", so it is only a fallback: the file's own
 * `rename to`, `+++` or `---` line wins whenever one is present.
 */
function headerPaths(line: string): { from: string; to: string } | null {
  const rest = line.slice("diff --git ".length);
  const split = rest.lastIndexOf(" b/");
  if (split < 0) return null;
  return { from: stripPrefix(rest.slice(0, split)), to: stripPrefix(rest.slice(split + 1)) };
}

/**
 * Parse one unified diff into its files.
 *
 * A file with no `+++` line (a pure rename, a mode change) still appears in the list, because the
 * patch names it and the owner asked to see what the candidate moves.
 */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  // A hunk belongs to the file it was opened in; both move together.
  const cursor: { hunk: DiffHunk | null; oldLine: number; newLine: number } = { hunk: null, oldLine: 0, newLine: 0 };
  let sawMinus = false;
  let sawPlus = false;
  let minusPath: string | null = null;

  const openHunk = (line: string, match: RegExpExecArray) => {
    cursor.hunk = { header: line, oldStart: Number(match[1]), newStart: Number(match[3]), lines: [] };
    cursor.oldLine = cursor.hunk.oldStart;
    cursor.newLine = cursor.hunk.newStart;
    current!.hunks.push(cursor.hunk);
  };

  const finish = () => {
    if (!current) return;
    // A `--- a/x` with no `+++` never happens in git output, but a patch cut mid-file would leave
    // one; the file keeps the pre-image name rather than an empty path.
    if (sawMinus && !sawPlus && !current.previousPath && minusPath) current.path = minusPath;
    files.push(current);
    current = null; cursor.hunk = null; sawMinus = false; sawPlus = false; minusPath = null;
  };

  const lines = patch.split("\n");
  // A patch ending in a newline leaves one empty trailing element; it is not a line of content.
  if (lines.at(-1) === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finish();
      const paths = headerPaths(line);
      current = { path: paths?.to ?? "", previousPath: null, status: "modified", binary: false, added: 0, removed: 0, hunks: [] };
      continue;
    }
    if (!current) continue;

    const match = HUNK.exec(line);
    if (match) { openHunk(line, match); continue; }

    if (cursor.hunk) {
      const hunk = cursor.hunk;
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" annotates the line before it and consumes no number.
        hunk.lines.push({ kind: "note", text: line, oldLine: null, newLine: null });
        continue;
      }
      if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: cursor.newLine++ });
        current.added = (current.added ?? 0) + 1;
        continue;
      }
      if (line.startsWith("-")) {
        hunk.lines.push({ kind: "remove", text: line.slice(1), oldLine: cursor.oldLine++, newLine: null });
        current.removed = (current.removed ?? 0) + 1;
        continue;
      }
      // A context line always begins with a space; a truncated patch must not read its remaining
      // text as diff content, so anything else ends the hunk.
      if (line.startsWith(" ")) {
        hunk.lines.push({ kind: "context", text: line.slice(1), oldLine: cursor.oldLine++, newLine: cursor.newLine++ });
        continue;
      }
      cursor.hunk = null;
    }

    if (line.startsWith("new file mode")) { current.status = "added"; continue; }
    if (line.startsWith("deleted file mode")) { current.status = "deleted"; continue; }
    if (line.startsWith("rename from ")) { current.previousPath = line.slice("rename from ".length); current.status = "renamed"; continue; }
    if (line.startsWith("rename to ")) { current.path = line.slice("rename to ".length); current.status = "renamed"; continue; }
    if (line.startsWith("--- ")) {
      const path = line.slice(4);
      sawMinus = true;
      if (path === "/dev/null") current.status = "added";
      else minusPath = stripPrefix(path);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      sawPlus = true;
      if (path === "/dev/null") current.status = "deleted";
      else current.path = stripPrefix(path);
      continue;
    }
    if (line.startsWith("Binary files ")) {
      current.binary = true; current.added = null; current.removed = null;
      continue;
    }
  }
  finish();
  return files;
}
