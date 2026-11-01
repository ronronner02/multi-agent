// @vitest-environment node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { expect, it } from "vitest";

const skin = postcss.parse(readFileSync(fileURLToPath(new URL("../../skins/shuimo-danqing/skin.css", import.meta.url)), "utf8"));
const tokens: Record<string, string> = {};
skin.walkDecls(/^--ui-/, declaration => { tokens[declaration.prop] = declaration.value; });
type RGB = [number, number, number];
const hex = (value: string): RGB => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as RGB;
const color = (name: string) => hex(tokens[`--ui-${name}`]!);
function blend(top: RGB, bottom: RGB, alpha: number): RGB {
  return top.map((value, i) => value * alpha + bottom[i]! * (1 - alpha)) as RGB;
}
function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map(value => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}
function contrast(a: RGB, b: RGB): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}

it("scopes every restored style to Ink without changing layout tokens", () => {
  skin.walkRules(rule => { expect(rule.selector).toContain('.team-shell[data-ui-theme="ink"]'); });
  expect(skin.toString()).not.toContain("--team-");
  for (const name of ["sidebar", "topstrip", "gap", "radius", "sans", "mono"]) expect(tokens[`--ui-${name}`]).toBeUndefined();
  expect(skin.toString()).toContain("prefers-reduced-motion: reduce");
  expect(skin.toString()).toContain("animation: none !important");
  expect(skin.toString()).toContain("transition: none !important");
});

it("keeps readable text and controls over solid and worst-case textured surfaces", () => {
  const backgrounds = [color("canvas"), color("surface"), color("raised")];
  // White bounds every video/texture pixel; test both ends of each actual scrim gradient.
  skin.walkDecls("background", declaration => {
    for (const match of declaration.value.matchAll(/#[0-9a-f]{8}\b/g)) {
      backgrounds.push(blend(hex(match[0]), [255, 255, 255], parseInt(match[0].slice(7), 16) / 255));
    }
  });
  expect(backgrounds.length).toBe(7);
  // Selected rows and diff lines also put muted captions over tinted surfaces.
  for (const name of ["accent-soft", "add", "remove"]) {
    const parts = tokens[`--ui-${name}`]!.match(/[\d.]+/g)!.map(Number);
    for (const base of [color("canvas"), color("surface")]) backgrounds.push(blend(parts.slice(0, 3) as RGB, base, parts[3]!));
  }
  const ratios: Record<string, number> = {};
  for (const name of ["text", "muted", "accent", "ok", "warn", "error"]) {
    ratios[name] = Math.min(...backgrounds.map(background => contrast(color(name), background)));
    expect(ratios[name], name).toBeGreaterThanOrEqual(4.5);
  }
  for (const name of ["focus", "control"]) {
    ratios[name] = Math.min(...backgrounds.map(background => contrast(color(name), background)));
    expect(ratios[name], name).toBeGreaterThanOrEqual(3);
  }
  ratios.primary = contrast(color("on-accent"), color("accent"));
  expect(ratios.primary).toBeGreaterThanOrEqual(4.5);
  console.log("Ink minimum contrast ratios", Object.fromEntries(Object.entries(ratios).map(([name, value]) => [name, value.toFixed(2)])));
});

it.each([
  ["shuimo-danqing-loop.mp4", "9ee96439f9e4ded695cfc7e07c7985491d77fc91dfb722a67244e69b22fc9743"],
  ["sm-paper-grain-strong.webp", "3c16558c34ce0f9e3d1dff152d33d4e42660cf8caa40fbfbcdd8b4576903e314"],
  ["sm-paper-grain.webp", "968989ed501816a3f9339c3861472e76795dfb42bff3c9102e59ae6d3c1863ee"],
])("restores the original %s bytes", (file, digest) => {
  const media = readFileSync(fileURLToPath(new URL(`../../../public/skins/shuimo-danqing/${file}`, import.meta.url)));
  expect(createHash("sha256").update(media).digest("hex")).toBe(digest);
});
