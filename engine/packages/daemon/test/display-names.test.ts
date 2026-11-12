import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createDb } from "../src/db/connection.js";
import { BASELINE_VERSION, initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, fixDaemonMode, hashBinding } from "../src/domain/plan-governance.js";
import { TeamReadModel } from "../src/team-control-surface.js";
import {
  clientLabel, ordinalRunName, ordinalTaskName, reviewName, roleLabel, runName, seatName, shortenTitle, taskName,
} from "../src/domain/display-names.js";
import { reviewRoundFor, reviewerTaskId } from "../src/domain/review-loop.js";
import type { PlanBinding } from "../src/contracts/team-control.js";

/**
 * U9 / KTD8 — the names the owner read publishes beside the ids.
 *
 * The unit cases pin the naming rules; the read-model cases drive the real governance, queue and
 * event owners, so what is asserted is what a producer wrote or what the read derived from a
 * real row — never a projection copying a value the test hand-built into it.
 */

const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: `sha256:${"a".repeat(64)}`,
  repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 1, policyFingerprint: `sha256:${"c".repeat(64)}`,
  limits: { maxSessions: 3, maxActiveMs: 3600000, maxRetries: 1, maxReviewRounds: 2 },
};
const capability = { policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint,
  verifiedProviders: ["claude", "codex"] as const };

/** The goal a demo run starts from: a title line and the rest of the brief. */
const DEMO_GOAL = "Add a titleCase helper\n\nThe helper lower-cases the first word and keeps the rest.";

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("display names", () => {
  describe("the naming rules", () => {
    it("shortens a long goal at a word boundary and never ends on a cut-off word", () => {
      const goal = "Show the autonomous team run view with every seat named, and never render an internal identifier";
      const name = runName(goal)!;
      expect(name.length).toBeLessThanOrEqual(48);
      // The name is a prefix of the goal, and the goal's next character is the space the cut
      // landed on: no word is shown half-written.
      expect(goal.startsWith(name)).toBe(true);
      expect(goal[name.length]).toBe(" ");
      expect(name.endsWith(" ")).toBe(false);
      expect(name).not.toMatch(/[,.;:!?]$/u);
    });

    it("cuts a goal with no spaces by character and drops its trailing punctuation", () => {
      const goal = "把任务标题改成小写，并且给每个任务加一个中文显示名称，这样界面上就看不到内部编号了。";
      const name = runName(goal)!;
      // Chinese has no word boundary to cut at, so the limit is a character count.
      expect(name.length).toBeLessThanOrEqual(48);
      expect(goal.startsWith(name)).toBe(true);
      expect(name.endsWith("。")).toBe(false);
      expect(runName("修正标题大小写。")).toBe("修正标题大小写");
    });

    it("takes a task's name from its title, which is the first line of its body", () => {
      expect(taskName("\n## Add titleCase\n\nIt must reject unknown states.")).toBe("Add titleCase");
      expect(taskName("Add titleCase.")).toBe("Add titleCase");
      expect(taskName("   \n  ")).toBeNull();
    });

    it("names a review after the task it reviews, and only the second round carries a number", () => {
      expect(reviewName("Add titleCase", 1)).toBe("Review: Add titleCase");
      expect(reviewName("Add titleCase", 2)).toBe("Review 2: Add titleCase");
    });

    it("names a seat from its role and client, numbering only a repeating pair", () => {
      expect(seatName({ role: "implementer", client: "codex" })).toBe("Implementer · Codex");
      expect(seatName({ role: "implementer", client: "codex", index: 1 })).toBe("Implementer · Codex 1");
      expect(seatName({ role: "implementer", client: "codex", index: 2 })).toBe("Implementer · Codex 2");
      expect(seatName({ role: "reviewer", client: "claude-code" })).toBe("Reviewer · Claude Code");
      expect(roleLabel("lead")).toBe("Lead");
      expect(clientLabel("codex")).toBe("Codex");
      // A runtime this module does not label is shown as it is rather than hidden.
      expect(clientLabel("omp")).toBe("omp");
    });

    it("keeps the two fallbacks and the reviewer round derivation readable", () => {
      expect(ordinalRunName(2)).toBe("Run 2");
      expect(ordinalTaskName(3)).toBe("Task 3");
      expect(shortenTitle("alpha beta gamma", 12)).toBe("alpha beta");
      expect(reviewRoundFor("task-1", reviewerTaskId("task-1", 2))).toBe(2);
      expect(reviewRoundFor("task-1", "task-1")).toBeNull();
      expect(reviewRoundFor("task-1", "task-1-review-x")).toBeNull();
    });
  });

  describe("the owner read", () => {
    let db: Database.Database;
    let governance: PlanGovernance;
    let model: TeamReadModel;

    beforeEach(() => {
      db = createDb();
      initializeDatabase(db);
      fixDaemonMode(db, true);
      db.prepare("INSERT INTO rigs (id, name) VALUES ('demo-rig', 'demo')").run();
      // The rig a demo run starts on: a Claude Code lead, two implementers on Codex and one on
      // Claude Code, and a reviewer on Codex.
      const node = db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, 'demo-rig', ?, ?, ?)");
      const session = db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)");
      for (const [id, role, runtime] of [["lead", "lead", "claude-code"], ["impl.a", "implementer", "claude-code"],
        ["impl.b", "implementer", "codex"], ["impl.c", "implementer", "codex"], ["reviewer", "reviewer", "codex"]] as const) {
        node.run(`node-${id}`, id, role, runtime);
        session.run(`session-${id}`, `node-${id}`, `${id}@demo`);
      }
      const bus = new EventBus(db);
      const queue = new QueueRepository(db, bus);
      governance = new PlanGovernance(db, bus, queue, undefined, () => capability);
      model = new TeamReadModel({
        db, governance, events: bus,
        readTaskRows: (runId: string) => db.prepare(
          `SELECT a.qitem_id AS qitemId, a.task_id AS taskId, json_extract(a.assignment_json, '$.role') AS role,
            q.state AS queueState, q.destination_session AS session
            FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
            WHERE a.run_id = ? ORDER BY a.task_id`).all(runId) as Array<{
              qitemId: string; taskId: string; role: string; queueState: string; session: string | null }>,
      });
      governance.createRun({ id: "run", rigId: "demo-rig", binding, displayName: runName(DEMO_GOAL) });
      approve("run");
    });
    afterEach(() => db.close());

    /** An approved implementation approval, so the governed task write admits the task exactly as a start does. */
    function approve(runId: string) {
      db.prepare(`INSERT OR REPLACE INTO team_approvals (id, run_id, kind, action, payload_json, payload_digest,
        target_digest, binding_digest, state, expires_at, created_at, updated_at)
        VALUES (?, ?, 'orchestrator', 'implementation', ?, ?, ?, ?, 'approved', ?, ?, ?)`)
        .run(`approval-${runId}`, runId, JSON.stringify({ bindingDigest: hashBinding(binding) }), sha("approval"),
          hashBinding(binding), hashBinding(binding), "2099-01-01T00:00:00.000Z",
          "2026-11-05T00:00:00.000Z", "2026-11-05T00:00:00.000Z");
      db.prepare("UPDATE team_runs SET state = 'approved' WHERE id = ?").run(runId);
    }

    function createTask(runId: string, taskId: string, body: string,
      input: { role?: "lead" | "implementer" | "reviewer"; reviewOf?: string; seat?: string } = {}) {
      const assignment = { taskId, role: input.role ?? "implementer", paths: ["src"], dependencies: [],
        ...(input.reviewOf === undefined ? {} : { reviewOf: input.reviewOf }) };
      const receipt = governance.createTask({
        protocolVersion: "1.0", runId, actionId: taskId,
        expectedEntityVersion: governance.getRun(runId).entityVersion,
        idempotencyKey: `seed-${runId}-${taskId}`,
        payload: { assignment, outputs: [], permissions: [],
          sourceSession: "lead@demo", destinationSession: input.seat ?? "impl.a@demo", body },
      }, binding);
      if (receipt.status !== "accepted") throw new Error(`create failed: ${receipt.reason}`);
    }

    /** The demo's shape: two implementer tasks and the first task's review round. */
    function demoRun() {
      createTask("run", "task-1", "Add titleCase");
      createTask("run", "task-2", "Cover it with tests", { seat: "impl.b@demo" });
      createTask("run", "task-1-review-1", "Review task-1's candidate (round 1).",
        { role: "reviewer", reviewOf: "task-1", seat: "reviewer@demo" });
    }

    it("includes run and task names in the baseline", () => {
      const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns("team_runs")).toContain("display_name");
      expect(columns("team_queue_authority")).toContain("display_name");
      expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
    });

    it("stores each name on the row it names when the row is created", () => {
      demoRun();
      // The name is written with the row, not derived by every later reader.
      expect(db.prepare("SELECT display_name AS name FROM team_runs WHERE id = 'run'").get())
        .toEqual({ name: "Add a titleCase helper" });
      expect(db.prepare("SELECT task_id AS taskId, display_name AS name FROM team_queue_authority ORDER BY task_id").all())
        .toEqual([
          { taskId: "task-1", name: "Add titleCase" },
          { taskId: "task-1-review-1", name: "Review: Add titleCase" },
          { taskId: "task-2", name: "Cover it with tests" },
        ]);
    });

    it("names the run, every task and every seat of a demo-shaped run", () => {
      demoRun();
      createTask("run", "task-1-review-2", "Review task-1's candidate (round 2).",
        { role: "reviewer", reviewOf: "task-1", seat: "reviewer@demo" });

      const read = model.read("run");
      expect(read.run.displayName).toBe("Add a titleCase helper");
      // Every task carries a name and a localisable shape of it, and no name is the task id.
      for (const task of read.tasks) {
        expect(task.displayName.trim()).not.toBe("");
        expect(task.displayName.startsWith(task.taskId)).toBe(false);
      }
      const byId = new Map(read.tasks.map((task) => [task.taskId, task]));
      expect(byId.get("task-1")).toMatchObject({ displayName: "Add titleCase", displayNameParts: { kind: "task" } });
      expect(byId.get("task-2")).toMatchObject({ displayName: "Cover it with tests", displayNameParts: { kind: "task" } });
      // A review's name is its subject, and the round is published as a part so a zh-CN client
      // can translate "Review 2" without the stored English text.
      expect(byId.get("task-1-review-1")).toMatchObject({ displayName: "Review: Add titleCase",
        displayNameParts: { kind: "review", round: 1, of: "Add titleCase" } });
      expect(byId.get("task-1-review-2")).toMatchObject({ displayName: "Review 2: Add titleCase",
        displayNameParts: { kind: "review", round: 2, of: "Add titleCase" } });

      // Every seat is named from its role and client; the Codex implementers are numbered.
      expect(read.seats).toEqual([
        { seat: "impl.a@demo", role: "implementer", retired: false, client: "claude-code", index: null, displayName: "Implementer · Claude Code" },
        { seat: "impl.b@demo", role: "implementer", retired: false, client: "codex", index: 1, displayName: "Implementer · Codex 1" },
        { seat: "impl.c@demo", role: "implementer", retired: false, client: "codex", index: 2, displayName: "Implementer · Codex 2" },
        { seat: "lead@demo", role: "lead", retired: false, client: "claude-code", index: null, displayName: "Lead · Claude Code" },
        { seat: "reviewer@demo", role: "reviewer", retired: false, client: "codex", index: null, displayName: "Reviewer · Codex" },
      ]);
    });

    it("names a row recorded before the migration on read, from the rows it already has", () => {
      demoRun();
      // A run and tasks written before 112 held no name. What they held is their goal, their
      // body and their assignment, and that is what the read names them from.
      db.prepare("UPDATE team_runs SET display_name = NULL").run();
      db.prepare("UPDATE team_queue_authority SET display_name = NULL").run();

      const read = model.read("run");
      expect(read.run.displayName).toBe("Run 1");
      const byId = new Map(read.tasks.map((task) => [task.taskId, task]));
      expect(byId.get("task-1")).toMatchObject({ displayName: "Add titleCase", displayNameParts: { kind: "task" } });
      expect(byId.get("task-2")).toMatchObject({ displayName: "Cover it with tests" });
      // The review's round is not stored anywhere but the id it was admitted under, and the
      // task it reviews supplies the name.
      expect(byId.get("task-1-review-1")).toMatchObject({ displayName: "Review: Add titleCase",
        displayNameParts: { kind: "review", round: 1, of: "Add titleCase" } });
    });

    it("numbers an unnamed run by its creation order on its rig", () => {
      // Two runs on one rig: the second is "Run 2" and does not collide with the first, which
      // was named from its goal.
      governance.createRun({ id: "second", rigId: "demo-rig", binding });
      db.prepare("UPDATE team_runs SET display_name = NULL WHERE id = 'run'").run();
      expect(model.read("run").run.displayName).toBe("Run 1");
      expect(model.read("second").run.displayName).toBe("Run 2");
    });
  });
});