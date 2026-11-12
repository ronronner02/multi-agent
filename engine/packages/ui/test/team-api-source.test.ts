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
  it("contains no legacy /api path literal outside team-control", () => {
    const violations = sourceFiles(sourceRoot).flatMap(file => readFileSync(file, "utf8").split("\n")
      .flatMap((line, index) => /["'`][^"'`]*\/api\/(?!team-control)/.test(line)
        ? [`${file.slice(sourceRoot.length + 1)}:${index + 1}`] : []));
    expect(violations).toEqual([]);
  });
});
