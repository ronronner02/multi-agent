import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "postcss";

const team = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(team, "team.css"), "utf8");
function declarations(selector: string) {
  const values = new Map<string, string>();
  parse(css).walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(decl => { values.set(decl.prop, decl.value); });
  });
  return values;
}
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
  it("separates adjacent settings cards and keeps independent project cards at natural height", () => {
    const pane = declarations(".team-shell .ui-settings-pane");
    expect(pane.get("display")).toBe("grid");
    expect(pane.get("gap")).toBe("16px");
    expect(pane.get("align-content")).toBe("start");
    expect(declarations(".team-shell .ui-project-list").get("align-items")).toBe("start");
  });

  it("bounds launch history independently of its row count and keeps column headings visible", () => {
    const region = declarations(".ui-model-launches");
    expect(region.get("max-height")).toBe("min(320px, 45dvh)");
    expect(region.get("overflow")).toBe("auto");
    expect(region.get("overscroll-behavior")).toBe("contain");
    const header = declarations(".ui-model-launches th");
    expect(header.get("position")).toBe("sticky");
    expect(header.get("top")).toBe("0");
    expect(header.get("background")).toBe("var(--surface)");
  });

  it("does not manufacture empty diff height and bounds long code to a local scroll area", () => {
    parse(css).walkRules(rule => {
      if (rule.selectors.includes(".team-shell .diff")) rule.walkDecls("min-height", declaration => {
        expect(declaration.value).toBe("0");
      });
    });
    expect(declarations(".team-shell .code").get("max-height")).toBe("min(560px, 62dvh)");
    expect(declarations(".team-shell .code").get("overflow")).toBe("auto");
  });

  it("keeps compact summaries expandable and responsive split panes shrinkable", () => {
    const collapsed = declarations(".team-shell .ui-text-preview-body");
    const expanded = declarations('.team-shell .ui-text-preview[data-expanded="true"] .ui-text-preview-body');
    expect(collapsed.get("-webkit-line-clamp")).toBe("3");
    expect(expanded.get("max-height")).toBe("min(320px, 40dvh)");
    expect(expanded.get("overflow")).toBe("auto");
    expect(declarations('.team-shell .ui-chat-panel .ui-text-preview:not([data-expanded="true"]) .ui-text-preview-body')
      .get("-webkit-line-clamp")).toBe("2");
    const containers: string[] = [];
    parse(css).walkAtRules("container", rule => { containers.push(rule.params); });
    expect(containers).toContain("workspace (max-width: 720px)");
    expect(containers).toContain("workspace (max-width: 800px)");
    expect(declarations(".team-shell .ui-main").get("min-height")).toBe("0");
  });

  it("keeps component cards translucent without fading their text or duplicating the skin", () => {
    const glass = declarations(".team-shell :is(.plate, .ui-card, .ui-column, .ui-task-card, .ui-page-head, .ui-snapshot-warning)");
    expect(glass.get("background")).toBe("var(--ui-glass-surface)");
    expect(glass.get("backdrop-filter")).toContain("blur(");
    expect(glass.get("box-shadow")).toContain("var(--ui-glass-highlight)");
    expect(glass.has("opacity")).toBe(false);
    expect(glass.get("--ui-muted")).toBe("var(--ui-text-secondary)");
    for (const theme of ["dark", "light"]) {
      const surface = declarations(`.team-shell[data-ui-theme="${theme}"]`).get("--ui-glass-surface");
      const alpha = Number(surface?.match(/\/\s*([.\d]+)\)/)?.[1]);
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(0.7);
    }
    expect(css).not.toMatch(/url\([^)]*skins\//);
    expect(declarations(".team-shell .ui-command-hero").has("background")).toBe(false);
    expect(declarations(".team-shell .ui-command-hero > div:first-child").has("background")).toBe(false);
  });

  it("avoids a second glass layer in sheets and retains solid input and diff surfaces", () => {
    const sheet = declarations(".team-shell .sheet-body .plate");
    expect(sheet.get("background")).toBe("none");
    expect(sheet.get("backdrop-filter")).toBe("none");
    expect(sheet.get("box-shadow")).toBe("none");
    for (const selector of [".team-shell .input", ".team-shell .diff", ".team-shell .composer textarea"]) {
      expect(declarations(selector).get("background")).toBe("var(--surface)");
    }
  });

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
