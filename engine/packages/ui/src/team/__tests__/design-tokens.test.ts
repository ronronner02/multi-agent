import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const team = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(team, "team.css"), "utf8");
function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.name === "__tests__" ? []
    : entry.isDirectory() ? sourceFiles(join(path, entry.name))
      : /\.(tsx?|css)$/.test(entry.name) ? [join(path, entry.name)] : []);
}
function palette(theme: string) {
  const block = css.match(new RegExp(`\\.team-shell\\[data-ui-theme="${theme}"\\]\\s*\\{([^}]+)\\}`))?.[1] ?? "";
  return [...block.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]).sort();
}

describe("command-center design tokens", () => {
  it("keeps raw hex colors in CSS token definitions, never in team components or selector rules", () => {
    const violations = sourceFiles(team).flatMap(file => readFileSync(file, "utf8").split("\n")
      .flatMap((line, index) => /#[0-9a-f]{3,8}\b/i.test(line) && !(file.endsWith(".css") && /^\s*--[\w-]+:/.test(line))
        ? [`${file.slice(team.length + 1)}:${index + 1}`] : []));
    expect(violations).toEqual([]);
  });

  it("defines the same semantic tokens in both themes", () => {
    const dark = palette("dark");
    expect(dark.length).toBeGreaterThan(20);
    expect(palette("light")).toEqual(dark);
  });

  it("documents every semantic color token in the shared design document", () => {
    const document = readFileSync(resolve(team, "../../../../../docs/design/command-center/DESIGN.md"), "utf8");
    expect(palette("dark").length).toBeGreaterThan(20);
    for (const name of palette("dark")) expect(document).toContain(`\`${name}\``);
  });
});
