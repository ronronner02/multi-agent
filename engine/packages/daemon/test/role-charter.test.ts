import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { REVIEW_SEVERITIES, parseFindings, recordReview, type ReviewFinding } from "../src/domain/review-evidence.js";
import { coreInstructions, instructionVersion, roleCharters, roleConfiguration, roleInstructionEntries } from "../src/integrations/framework/context-manifest.js";
import type { TeamRole } from "../src/contracts/team-control.js";

// KTD28 / U14: the charters are pinned source, the reviewer charter's report
// format is the one the ledger records, and every role has a planted-defect
// fixture for the owner-granted live check. Nothing here calls a provider.

const repo = (path: string) => new URL(`../../../../${path}`, import.meta.url);
const plan = readFileSync(repo("docs/plans/2026-10-13-001-feat-multi-agent-team-plan.md"), "utf8");
const roles = Object.keys(roleConfiguration) as TeamRole[];

describe("role charters", () => {
  it("gives every role a versioned charter under one versioned core", () => {
    expect(instructionVersion(coreInstructions)).toBe("1");
    for (const role of roles) {
      expect(instructionVersion(roleCharters[role])).toMatch(/^\d+$/);
      expect(roleInstructionEntries(role)[0]).toEqual(["core", coreInstructions]);
    }
    expect(new Set(roles.map(role => roleCharters[role])).size).toBe(roles.length);
  });

  it("keeps development reviews and managed reviewers on the same charter file", () => {
    const agents = readFileSync(repo("AGENTS.md"), "utf8");
    expect(agents).toContain("engine/config/team/roles/reviewer.md");
    expect(agents).not.toContain("docs/agents/reviewer-charter.md");
  });

  it("records the reviewer charter's own report example without loss", () => {
    const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(roleCharters.reviewer)![1]!) as { round: number; prior: unknown; findings: unknown[] };
    const earlier: ReviewFinding = { id: "R1-2", severity: "P1", citation: "KTD24", category: "correctness", file: "engine/packages/daemon/src/domain/workflow-runtime.ts", scenario: "round-1 defect" };
    const record = recordReview({ runId: "run", taskId: "T", round: example.round,
      reviewer: { session: "reviewer", role: "reviewer", taskId: "review" }, implementer: { session: "implementer", role: "implementer", taskId: "T" },
      candidate: { manifestDigest: `sha256:${"a".repeat(64)}`, base: "commit", baseIdentifier: "b".repeat(40), fileCount: 1 },
      currentDigest: `sha256:${"a".repeat(64)}`, findings: example.findings, recordedAt: "2026-10-22T00:00:00.000Z", reportDigest: null,
      previous: [earlier], prior: example.prior, deltaFiles: ["engine/packages/daemon/src/domain/workflow-runtime.ts"] });
    const source = example.findings[0] as Record<string, unknown>;
    expect(record.findings).toEqual([{ id: source.id, severity: source.severity, citation: source.citation, category: source.category,
      file: source.file, scenario: source.scenario, reportedInDelta: true, inDelta: true }]);
    expect(record.prior).toEqual(example.prior);
  });

  it("documents exactly the severities the ledger accepts", () => {
    for (const severity of REVIEW_SEVERITIES) expect(roleCharters.reviewer).toContain(`**${severity}**`);
    expect(() => parseFindings([{ id: "x", severity: "high", citation: "KTD8" }])).toThrow(/severity/);
  });
});

describe("planted-defect fixtures", () => {
  const directory = new URL("./fixtures/role-charters/", import.meta.url);
  const fixtures = readdirSync(directory).filter(name => name.endsWith(".json")).map(name =>
    ({ name, ...JSON.parse(readFileSync(new URL(name, directory), "utf8")) as {
      role: TeamRole; title: string; brief: { cited: string[] } & Record<string, unknown>;
      candidate: Record<string, string>; expected: Array<Record<string, unknown> & { citation: string }> } }));

  it("covers every role", () => {
    expect(new Set(fixtures.map(f => f.role))).toEqual(new Set(roles));
  });

  it.each(fixtures.map(f => [f.name, f] as const))("%s cites real plan decisions and its own planted files", (_name, fixture) => {
    expect(fixture.title.trim()).not.toBe("");
    expect(fixture.expected.length).toBeGreaterThan(0);
    for (const citation of [...fixture.brief.cited, ...fixture.expected.map(e => e.citation)]) {
      expect(citation).toMatch(/^(KTD|R)\d+$/);
      expect(plan).toMatch(new RegExp(`^- ${citation}\\. `, "m"));
    }
    for (const expected of fixture.expected) {
      if (fixture.role === "reviewer") {
        expect(REVIEW_SEVERITIES).toContain(expected.severity);
        expect(Object.keys(fixture.candidate)).toContain(expected.file);
      }
      if (fixture.role === "implementer") {
        const writePaths = fixture.brief.writePaths as string[];
        for (const path of expected.forbidden as string[]) {
          expect(Object.keys(fixture.candidate)).toContain(path);
          expect(writePaths).not.toContain(path);
        }
      }
      if (fixture.role === "lead") {
        for (const permission of expected.permissions as string[]) expect(roleConfiguration.lead.permissions).not.toContain(permission);
      }
    }
  });
});
