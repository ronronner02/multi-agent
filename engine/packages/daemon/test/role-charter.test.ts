import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { REVIEW_SEVERITIES, parseFindings, recordReview, type ReviewFinding } from "../src/domain/review-evidence.js";
import { coreInstructions, instructionVersion, roleCharters, roleConfiguration, roleInstructionEntries } from "../src/integrations/framework/context-manifest.js";
import type { TeamRole } from "../src/contracts/team-control.js";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { leadActivation, leadInstructions, planningInstructions } from "../src/domain/lead-proposal.js";
import { leadProtocol, LEAD_PROTOCOL_VERSION } from "../src/integrations/framework/context-manifest.js";

// KTD28 / U14: the charters are pinned source, the reviewer charter's report
// format is the one the ledger records, and every role has a planted-defect
// fixture for the owner-granted live check. Nothing here calls a provider.

const repo = (path: string) => new URL(`../../../../${path}`, import.meta.url);
const plan = readFileSync(repo("docs/plans/2026-10-13-001-feat-multi-agent-team-plan.md"), "utf8");
const roles = Object.keys(roleConfiguration) as TeamRole[];

describe("role charters", () => {
  it("keeps the higher-priority lead protocol consistent with staged discussion", () => {
    expect(leadProtocol).toContain("brainstorm");
    expect(leadProtocol).toContain("requirements");
    expect(leadProtocol).toContain("one focused question");
    expect(leadProtocol).not.toContain("During planning, write only the plan and");
  });

  it("gives every role a versioned charter under one versioned core", () => {
    expect(instructionVersion(coreInstructions)).toBe("3");
    for (const role of roles) {
      expect(instructionVersion(roleCharters[role])).toMatch(/^\d+$/);
      expect(roleInstructionEntries(role)[0]).toEqual(["core", coreInstructions]);
    }
    expect(new Set(roles.map(role => roleCharters[role])).size).toBe(roles.length);
  });

  it("projects protocol 6 and keeps each composed role prompt within 16 KiB", () => {
    expect(LEAD_PROTOCOL_VERSION).toBe("6");
    expect(instructionVersion(leadProtocol)).toBe("6");
    for (const role of roles) {
      const brief = role === "lead" ? Math.max(leadInstructions("A".repeat(300)).length,
        planningInstructions("A".repeat(300), "docs/plan.md", true).length) : 1_024;
      const bytes = Buffer.byteLength([coreInstructions, roleCharters[role], role === "lead" ? leadProtocol : ""].join("\n")) + brief;
      expect(bytes, role).toBeLessThanOrEqual(16_384);
    }
    expect(planningInstructions("Build a feature", "docs/plan.md", true, 4)).toContain("docs/lead-roster.json");
    expect(planningInstructions("Build a feature", "docs/plan.md", true, 4)).toContain("at most 4");
    expect(coreInstructions).toContain("rules enforced by the daemon; the core and role charters; the task brief");
  });

  it.each([6, 64])("keeps a %i-seat planning activation within both instruction and composed-prompt budgets", seatCount => {
    const db = createDb();
    try {
      initializeDatabase(db);
      const teamName = "x".repeat(100);
      db.prepare("INSERT INTO rigs (id, name) VALUES ('budget-rig', ?)").run(teamName);
      for (let index = 0; index < seatCount; index++) {
        const id = "node-" + index, member = "impl-" + (index + 1) + "@" + teamName;
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, 'budget-rig', ?, ?, ?)")
          .run(id, id, index === seatCount - 1 ? "reviewer" : "implementer", index % 2 ? "codex" : "claude-code");
        db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run("session-" + index, id, member);
      }
      const activation = leadActivation(db, { rigId: "budget-rig", roles: ["lead", "implementer", "reviewer"],
        seat: "lead@" + teamName, goal: "A".repeat(300), activationId: "budget", phase: "planning",
        planRef: "docs/plan.md", buildRoster: true, maxSeats: seatCount });
      expect(activation.roster).toHaveLength(seatCount);
      expect(activation.roster).toContainEqual({ member: "impl-" + seatCount + "@" + teamName,
        role: "reviewer", mailbox: "impl-" + seatCount + "@" + teamName });
      expect(activation.instructions.length).toBeLessThanOrEqual(8_192);
      expect(activation.instructions).toContain(JSON.stringify([
        { role: "implementer", client: "claude-code", model: null, count: seatCount / 2 },
        { role: "implementer", client: "codex", model: null, count: seatCount / 2 - 1 },
        { role: "reviewer", client: "codex", model: null, count: 1 },
      ]));
      const prompt = [coreInstructions, roleCharters.lead, leadProtocol, activation.instructions].join("\n");
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(16_384);
    } finally { db.close(); }
  });

  it("keeps worker report permissions outside the frozen candidate and states the resolution contract", () => {
    for (const role of ["implementer", "reviewer"] as const) {
      expect(instructionVersion(roleCharters[role])).toBe("3");
      expect(roleCharters[role]).toContain("task-report.json");
      expect(roleCharters[role]).toContain("16,384");
      expect(roleCharters[role]).toContain("500");
      expect(roleCharters[role]).toContain("outside");
    }
    expect(leadProtocol).toContain("resolutions");
    expect(leadProtocol).toContain("reassign");
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
