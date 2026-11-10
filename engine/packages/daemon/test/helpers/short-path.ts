import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * The 8.3 spelling of a directory, or `null` where this volume does not generate one.
 *
 * Windows keeps a second, short form of a long directory name (`C:\Users\RUNNER~1\…` for
 * `C:\Users\runneradmin\…`), and GitHub's Windows runner hands `%TEMP%` in that form. A test that
 * asserts the daemon records one canonical spelling has to be able to name the other one.
 *
 * `dir /x` lists the short name beside the long one; a volume with 8.3 generation disabled leaves
 * that column empty, so `null` means "this host cannot make the fixture" and the caller skips.
 */
export function shortPath(path: string): string | null {
  if (process.platform !== "win32") return null;
  const separator = path.lastIndexOf("\\");
  const parent = path.slice(0, separator), leaf = path.slice(separator + 1);
  let listing: string;
  try {
    listing = execFileSync("cmd", ["/c", "dir", "/x", parent], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch { return null; }
  for (const line of listing.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[columns.length - 1] !== leaf) continue;
    const short = columns[columns.length - 2]!;
    return /~[0-9]/.test(short) ? join(parent, short) : null;
  }
  return null;
}
