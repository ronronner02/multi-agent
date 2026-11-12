import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "__tests__") return [];
    const fullPath = join(path, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : /\.(tsx?|jsx?)$/.test(entry.name) ? [fullPath] : [];
  });
}

describe("team UI API boundary", () => {
  it("uses authenticated fetch streaming instead of native EventSource", () => {
    const violations = sourceFiles(sourceRoot).filter(file => /new\s+EventSource\s*\(/.test(readFileSync(file, "utf8")));
    expect(violations).toEqual([]);
  });
  it("contains no legacy /api path literal outside team-control", () => {
    const violations = sourceFiles(sourceRoot).flatMap(file => readFileSync(file, "utf8").split("\n")
      .flatMap((line, index) => /["'`][^"'`]*\/api\/(?!team-control)/.test(line)
        ? [`${file.slice(sourceRoot.length + 1)}:${index + 1}`] : []));
    expect(violations).toEqual([]);
  });

  it("loads nothing from the network outside the daemon's own origin", () => {
    // The desktop window waits for every stylesheet in index.html; an unreachable host keeps it on the
    // first-run page, so the shipped page and stylesheets reference no external URL.
    const styles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? styles(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);
    const pages = [resolve(process.cwd(), "index.html"), ...styles(sourceRoot)];
    const external = pages.flatMap(file => /(?:src|href)=["']https?:\/\/|@import\s+url\(["']?https?:\/\//.test(readFileSync(file, "utf8"))
      ? [file] : []);
    expect(external).toEqual([]);
  });
});
