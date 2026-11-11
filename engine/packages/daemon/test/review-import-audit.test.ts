import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

const REVIEW_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/domain/review");

/** Transport/registry/I-O import specifiers forbidden in the pure review
 *  domain. fanout-contract is deliberately NOT here (see header). */
const FORBIDDEN_SPECIFIERS = [
  "hosts/remote-daemon-http",
  "hosts/hosts-registry-reader",
  "hosts/read-through",
  "node:http",
  "node:https",
  "node:net",
  "undici",
];

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

describe("MH-5 P1 — the review-domain import boundary (static audit)", () => {
  const files = readdirSync(REVIEW_DIR).filter((f) => f.endsWith(".ts"));

  it("the review dir is non-empty and carries the retained local composer", () => {
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain("compose.ts");
  });

  it("every retained review-domain module imports no hosts transport/registry or network primitive", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const specs = importSpecifiers(readFileSync(path.join(REVIEW_DIR, file), "utf-8"));
      for (const spec of specs) {
        if (FORBIDDEN_SPECIFIERS.some((f) => spec.includes(f))) {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("hosts/ imports are AT MOST the zero-I/O fanout contract", () => {
    for (const file of files) {
      const specs = importSpecifiers(readFileSync(path.join(REVIEW_DIR, file), "utf-8"));
      const hostsImports = specs.filter((s) => s.includes("/hosts/") || s.startsWith("hosts/"));
      for (const spec of hostsImports) {
        expect(spec).toContain("host-identity/fanout-contract");
      }
    }
  });
});
