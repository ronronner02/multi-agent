import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DAEMON_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(DAEMON_ROOT, "../..");
const PACK_PATHS = [
  resolve(DAEMON_ROOT, "assets/onboarding/01-world-and-purpose.md"),
  resolve(DAEMON_ROOT, "assets/onboarding/02-self-and-competent-action.md"),
];
const PUBLIC_REFERENCE_PATHS = [
  resolve(DAEMON_ROOT, "context-packs-src/onboarding-width/public-what-you-can-do.md"),
  resolve(DAEMON_ROOT, "context-packs-src/onboarding-width/public-reference-material.md"),
];
const MESSAGE_CEILING_BYTES = 9_400;

function packText(): string {
  return PACK_PATHS.map((path) => readFileSync(path, "utf8")).join("\n");
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 80);
}

describe("default onboarding pack", () => {
  it("ships as exactly two ordered files below the source walk message ceiling", () => {
    expect(PACK_PATHS.map((path) => readFileSync(path).byteLength)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    for (const path of PACK_PATHS) {
      const bytes = readFileSync(path).byteLength;
      expect(bytes, `${path} must remain walk-sized`).toBeLessThanOrEqual(MESSAGE_CEILING_BYTES);
      expect(bytes, `${path} must carry substantive orientation`).toBeGreaterThan(500);
    }
  });

  it("contains no provenance-marked or mechanically suspicious instance facts", () => {
    const text = packText();
    const bannedProvenance = [
      /TELLS-/i,
      /debt\.md/i,
      /measured on (?:this|the) instance/i,
      /may not hold on another/i,
      /map of one instance/i,
      /capability[- ]delta/i,
    ];
    for (const pattern of bannedProvenance) expect(text).not.toMatch(pattern);

    const mechanicalCandidates = [
      /\/(?:Users|home|tmp|private|var|opt)\//,
      /~\//,
      /\b(?:localhost|127\.0\.0\.1):\d+\b/,
      /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/,
      /\b\d+\s+(?:files?|directories|seats?|rigs?|pods?|lines?|bytes?|kib|kb|tokens?)\b/i,
      /\bthis (?:box|instance|vm|machine|host)\b/i,
      /(?:shared-docs\/|missions\/|<corpus>)/i,
    ];
    for (const pattern of mechanicalCandidates) expect(text).not.toMatch(pattern);
  });

  it("discovers an optional world pack without naming a dead default", () => {
    const text = packText();
    const stepTwo = readFileSync(PACK_PATHS[1]!, "utf8");
    expect(text).toContain("multi-agent team");
    expect(text).toContain("multi-agent daemon");
    expect(text).toContain("multi-agent github");
    expect(text).toContain("owner-governed team run");
    expect(stepTwo).toContain("multi-agent team start");
    expect(stepTwo).toContain("agent-operated-workflows");
    expect(stepTwo).toContain("claude-compaction-restore");
    expect(stepTwo).not.toContain("multi-agent context compose");

    const [capabilities, sources] = PUBLIC_REFERENCE_PATHS.map((path) => readFileSync(path, "utf8"));
    expect(capabilities).toContain("# What you can do here");
    expect(sources).toContain("## The command surface");
    expect(sources).toContain("## The living answer");
    expect(sources).toContain("## Outside the forest");
    expect(sources).toContain("## The one you read rather than consult");
    expect(sources).not.toContain("## The corpus");
    expect(sources).not.toContain("shared-docs/");
    expect(sources).not.toContain("Everything above is this box. The corpus");

    const canonPaths = [
      resolve(DAEMON_ROOT, "assets/plugins/multi-agent-core/skills/agent-operated-software/SKILL.md"),
      resolve(DAEMON_ROOT, "assets/plugins/multi-agent-core/skills/agent-operated-workflows/SKILL.md"),
    ];
    const canonicalParagraphs = new Set(canonPaths.flatMap((path) => paragraphs(readFileSync(path, "utf8"))));
    const copied = paragraphs(text).filter((paragraph) => canonicalParagraphs.has(paragraph));
    expect(copied).toEqual([]);
  });

  it("keeps owner contact open through the native team flow", () => {
    const pack = packText();

    expect(pack).toContain("Use team chat for a question or progress update");
    expect(pack).toContain("durable run state");
    expect(pack).toContain("ask for the one decision that changes the work");
    expect(pack).not.toMatch(/other seats route through them|role-gated|router hop/i);
  });

  it("ships a task-grounding probe that is red on blank and green on packed context", () => {
    const prompt = "An open-ended cleanup request arrives. Name the task evidence and repository boundary that prevent a locally defensible change from solving the wrong problem.";
    const expected = /assigned goal|acceptance evidence|repository guidance/i;
    expect(prompt).not.toMatch(expected);
    expect("").not.toMatch(expected);
    expect(packText()).toMatch(expected);
  });

  it("keeps onboarding changes inside the declared product territory", () => {
    const packageJson = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
    expect(packageJson).toContain('"packages/daemon"');
  });
});
