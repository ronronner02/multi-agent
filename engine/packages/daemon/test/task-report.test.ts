import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { agentTurnOutputPaths, managedTurnPrompt } from "../src/domain/agent-turn.js";
import { parseTaskReport } from "../src/domain/task-report.js";
import { parseLeadProposalFile } from "../src/domain/lead-proposal.js";

describe("the structured task report boundary", () => {
  const report = { status: "blocked", question: "Which response is required?", evidence: "The plan names two responses." };
  it.each(["blocked", "needs-decision", "dropped"])("accepts %s and preserves its bounded evidence", status => {
    expect(parseTaskReport({ ...report, status })).toEqual({ ...report, status });
    expect(parseTaskReport({ status, evidence: "Nothing remains in this task." })).toEqual({ status, evidence: "Nothing remains in this task." });
  });
  it.each([
    null, [], {}, { ...report, status: "done" }, { ...report, unknown: true },
    { ...report, question: "" }, { ...report, question: "x".repeat(501) }, { ...report, question: null },
    { ...report, evidence: [] }, { ...report, evidence: "" }, { ...report, evidence: "x".repeat(16_385) },
    { ...report, evidence: "before\u0000after" },
  ])("rejects malformed worker data case %#", value => {
    expect(() => parseTaskReport(value)).toThrow();
  });
  it("accepts the exact question and evidence limits", () => {
    expect(parseTaskReport({ status: "blocked", question: "x".repeat(500), evidence: "x".repeat(16_384) }).question).toHaveLength(500);
  });

  let root: string, db: Database.Database, runtime: WorkflowRuntime;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "task-report-"));
    db = createDb(); initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    db.prepare("INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at) VALUES ('run', 'rig', '{}', 'binding', 'approved', 'now', 'now')").run();
    db.prepare("INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, state, usage_json, active_ms, created_at, updated_at) VALUES ('attempt', 'run', NULL, 'reviewer', 'claude', '{}', 'stopped', '{}', 0, 'now', 'now')").run();
    const eventBus = new EventBus(db);
    runtime = new WorkflowRuntime({ db, eventBus, queueRepo: new QueueRepository(db, eventBus) });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("reads an attempt-specific report without a candidate and never borrows another attempt's report", () => {
    const path = agentTurnOutputPaths(root, "attempt").taskReport;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report));
    expect(runtime.taskReportFor("run", "attempt", root)).toEqual(report);
    expect(() => runtime.taskReportFor("other-run", "attempt", root)).toThrow(/attempt/i);
    expect(() => runtime.taskReportFor("run", "unrecorded", root)).toThrow(/attempt/i);
    rmSync(path);
    expect(runtime.taskReportFor("run", "attempt", root)).toBeNull();
  });

  it.each(["symlink", "directory", "invalid-json", "invalid-utf8", "oversized"])("does not mistake an unreadable %s report for no report", kind => {
    const path = agentTurnOutputPaths(root, "attempt").taskReport;
    mkdirSync(dirname(path), { recursive: true });
    if (kind === "symlink") {
      const outside = join(root, "outside.json"); writeFileSync(outside, JSON.stringify(report)); symlinkSync(outside, path);
    } else if (kind === "directory") mkdirSync(path);
    else writeFileSync(path, kind === "invalid-json" ? "{" : kind === "invalid-utf8" ? Buffer.from([0xc3, 0x28]) : "x".repeat(262_145));
    expect(() => runtime.taskReportFor("run", "attempt", root)).toThrow();
  });

  it("exposes only the report destination without adding a source permission", () => {
    const text = managedTurnPrompt({ identity: "", bundle: "", runId: "run", assignment: {
      taskId: "review", role: "reviewer", paths: ["src"], dependencies: [] },
    taskBody: "Review the candidate", outputs: [], permissions: [], instructions: [], continuation: null,
    taskReportPath: "/turns/attempt/report/task-report.json" });
    expect(text).toContain('Task report file: "/turns/attempt/report/task-report.json"');
    expect(text).toContain("outside the candidate");
    expect(text).toContain("Permissions: []");
  });
});

describe("explicit lead resolutions", () => {
  it("accepts a resolution-only proposal and preserves task-only proposals", () => {
    const resolutions = [{ taskId: "paused", action: "rework", body: "Use the documented response." }];
    expect(parseLeadProposalFile({ tasks: [], resolutions })).toEqual({ tasks: [], resolutions });
    const tasks = [{ taskId: "new", seat: "a@rig", paths: ["src/a.ts"], dependencies: [], body: "Implement it." }];
    expect(parseLeadProposalFile({ tasks })).toEqual({ tasks });
  });
  it.each([
    { tasks: [], resolutions: [] },
    { tasks: [], resolutions: [{ taskId: "a", action: "rework" }] },
    { tasks: [], resolutions: [{ taskId: "a", action: "reassign", seat: "b@rig", body: "extra" }] },
    { tasks: [], resolutions: [{ taskId: "a", action: "drop", paths: ["src"] }] },
    { tasks: [], resolutions: [{ taskId: "a", action: "approve" }] },
    { tasks: [], resolutions: [{ taskId: "a", action: "drop" }, { taskId: "a", action: "drop" }] },
  ])("rejects an ambiguous or empty resolution contract: %j", value => {
    expect(() => parseLeadProposalFile(value)).toThrow();
  });
});
