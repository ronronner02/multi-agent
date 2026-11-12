import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { generatedReplyTitle } from "../src/domain/display-names.js";
import { EventBus } from "../src/domain/event-bus.js";
import { composeLeadTurnEnd, listChatMessages } from "../src/domain/lead-chat.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";

const goal = '"docs/product" Read all documents, clarify the requirements, and design the product.';
const initialName = '"docs/product" Read all documents';

describe("generated reply titles", () => {
  it("takes only the first reply heading and normalizes its spacing", () => {
    expect(generatedReplyTitle("\n#   Clarify  product requirements  \r\n\nThe full discussion follows."))
      .toBe("Clarify product requirements");
    expect(generatedReplyTitle("# Clarify requirements\n\n# Later detail"))
      .toBe("Clarify requirements");
  });

  it("keeps legacy prose and later headings from becoming a title", () => {
    for (const body of ["A full reply.\n\n# An incidental heading", "## A subsection", "# ", ""]) {
      expect(generatedReplyTitle(body)).toBeNull();
    }
  });

  it("bounds titles by Unicode characters and rejects control characters", () => {
    expect(generatedReplyTitle("# " + "a".repeat(81))).toBeNull();
    expect(generatedReplyTitle("# " + "😀".repeat(80))).toBe("😀".repeat(80));
    expect(generatedReplyTitle("# A\u0000title")).toBeNull();
  });
});

describe("lead turn title persistence", () => {
  let root: string, db: Database.Database, governance: PlanGovernance;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "generated-titles-"));
    db = createDb();
    initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'demo')").run();
    const policy = unisolatedPolicyCapability(2);
    const binding = { artifactContract: "spec-unified-plan/v1" as const, artifactReadiness: "implementation-ready" as const,
      execution: "code" as const, status: "active" as const, planRef: "plan.md", planDigest: "sha256:" + "a".repeat(64),
      repository: { root, identity: "git:" + "b".repeat(40) }, readPaths: ["plan.md", "src"], writePaths: ["plan.md"],
      roles: ["lead", "implementer", "reviewer"] as ("lead" | "implementer" | "reviewer")[],
      policyRevision: policy.policyRevision, policyFingerprint: policy.policyFingerprint,
      limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 } };
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), undefined, () => policy);
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, phase, display_name, created_at, updated_at)
      VALUES ('run', 'rig', ?, ?, 'approved', 'planning', ?, '2026-11-09', '2026-11-09')`)
      .run(JSON.stringify(binding), hashBinding(binding), initialName);
    db.prepare(`INSERT INTO queue_items
      (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES ('lead-item', '2026-11-09', '2026-11-09', 'owner', 'lead@demo', 'pending', ?)`)
      .run(goal);
    db.prepare(`INSERT INTO team_queue_authority
      (qitem_id, run_id, task_id, assignment_json, outputs_json, permissions_json, display_name)
      VALUES ('lead-item', 'run', 'task-1', ?, '[]', '[]', ?)`)
      .run(JSON.stringify({ taskId: "task-1", role: "lead", paths: ["plan.md"], dependencies: [] }), initialName);
  });
  afterEach(() => { if (db?.open) db.close(); rmSync(root, { recursive: true, force: true }); });

  const finish = async (id: string, body: string, role = "lead") => {
    const output = agentTurnOutputPaths(root, id);
    mkdirSync(output.directory, { recursive: true });
    writeFileSync(output.lastMessage, body);
    await composeLeadTurnEnd({ db, governance, turnStateRoot: root, dispatch: () => undefined })({
      id, runId: "run", qitemId: "lead-item", role,
    });
  };
  const names = () => ({ run: governance.getRun("run").displayName,
    task: (db.prepare("SELECT display_name AS name FROM team_queue_authority WHERE qitem_id = 'lead-item'")
      .get() as { name: string }).name });

  it.each(["planning", "delivery"])("replaces clipped %s labels with the model's semantic title and retains the full text", async phase => {
    db.prepare("UPDATE team_runs SET phase = ? WHERE id = 'run'").run(phase);
    const body = "# Clarify product requirements\n\nI will read the complete documents, identify the product requirements, and discuss open choices.";
    await finish("turn-1", body);
    expect(names()).toEqual({ run: "Clarify product requirements", task: "Clarify product requirements" });
    expect(listChatMessages(db, "run").map(message => message.body)).toEqual([body]);
    expect(db.prepare("SELECT body FROM queue_items WHERE qitem_id = 'lead-item'").get()).toEqual({ body: goal });
    await finish("turn-1", "# A stale replay title\n\nA changed observation of the same attempt.");
    expect(names()).toEqual({ run: "Clarify product requirements", task: "Clarify product requirements" });
    expect(listChatMessages(db, "run").map(message => message.body)).toEqual([body]);
  });

  it("keeps the existing labels for a legacy reply or a non-lead attempt", async () => {
    await finish("legacy", "I will read the documents.\n\n# A detail heading");
    await finish("implementation", "# An implementation result", "implementer");
    expect(names()).toEqual({ run: initialName, task: initialName });
    expect(listChatMessages(db, "run")).toHaveLength(1);
  });
});
