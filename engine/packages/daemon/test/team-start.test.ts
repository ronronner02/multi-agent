import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, fixDaemonMode, hashBytes } from "../src/domain/plan-governance.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { listChatMessages, responseLanguageNote } from "../src/domain/lead-chat.js";
import { createTestApp } from "./helpers/test-app.js";

/**
 * MVP slice 2 acceptance: the owner starts team work.
 *
 * Drives the real route, the real governance owner and the real queue against a repository
 * on disk. Nothing is hand-written into the tables: the run, its approval and its task all
 * come from the endpoint, which is the thing under test.
 */

const ownerToken = "owner-start-fixture";
const workerToken = "worker-start-fixture";
const policy = unisolatedPolicyCapability(4);

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mvp2-start-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  return root;
}

describe("MVP slice 2 — the owner starts team work", () => {
  let directory: string, db: Database.Database, governance: PlanGovernance;
  let app: ReturnType<typeof createTestApp>["app"];

  const start = (body: unknown, token: string | null = ownerToken) => app.request("/api/team-control/runs", {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
  }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  beforeEach(() => {
    directory = repository();
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    fixDaemonMode(db, true);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'demo')").run();
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('node', 'rig', 'dev', 'claude-code', ?)`)
      .run(directory);
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => policy);
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      teamControl: { credentials: { ownerToken, workers: [{ token: workerToken, sessionId: "dev@demo", runId: "other" }] },
        readPolicyCapability: () => policy } } }).app;
  });

  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("creates the run and the task that puts an agent on the owner's goal", async () => {
    const response = await start({ goal: "Add a health endpoint" });
    expect(response.status).toBe(201);
    const receipt = await response.json() as Record<string, string>;
    expect(receipt).toMatchObject({ runId: expect.any(String), taskId: "task-1", seat: "dev@demo", state: "approved" });

    // The durable rows are the endpoint's, not a fixture's.
    const run = governance.getRun(receipt.runId!);
    expect(run.state).toBe("approved");
    expect(run.rigId).toBe("rig");
    // U9 — the run is named from the goal it was started with, so a client can list it by name.
    expect(run.displayName).toBe("Add a health endpoint");
    expect(run.binding.repository).toEqual({ root: directory, identity: expect.stringMatching(/^git:[a-f0-9]{40}$/) });
    expect(run.binding.planDigest).toBe(hashBytes("approved plan\n"));
    expect(run.binding.policyFingerprint).toBe(policy.policyFingerprint);
    expect(governance.listApprovals(run.id).map(approval => [approval.action, approval.state, approval.decisionActor]))
      .toEqual([["implementation", "approved", "owner-control"]]);
    const task = governance.findTask(run.id, "task-1")!;
    expect(task.assignment).toEqual({ taskId: "task-1", role: "implementer", paths: ["src"], dependencies: [] });
    expect(task.permissions).toEqual(["write-assigned-tree", "submit-evidence"]);
    // The queue row is what a launch resolves the seat from, so the seat has to be on it.
    const row = db.prepare("SELECT destination_session AS seat, body FROM queue_items WHERE qitem_id = ?").get(receipt.qitemId!) as
      { seat: string; body: string };
    expect(row).toEqual({ seat: "dev@demo", body: "Add a health endpoint" });
  });

  it("keeps a long direct task brief outside chat storage while retaining its reply language", async () => {
    const goal = "Implement the supplied requirements.\n" + "x".repeat(70_000);
    const response = await start({ goal, responseLanguage: "zh-CN" });
    expect(response.status, await response.clone().text()).toBe(201);
    const receipt = await response.json() as { runId: string; qitemId: string };
    expect(db.prepare("SELECT body FROM queue_items WHERE qitem_id = ?").get(receipt.qitemId)).toEqual({ body: goal });
    expect(listChatMessages(db, receipt.runId)).toEqual([]);
    const row = db.prepare("SELECT response_language AS language FROM team_runs WHERE id = ?").get(receipt.runId) as
      { language: "zh-CN" };
    expect(row.language).toBe("zh-CN");
    expect(responseLanguageNote([], row.language)).toContain("Simplified Chinese (zh-CN)");
  });

  it("preserves derived Unicode names and accepts an explicit semantic title", async () => {
    const goal = "😀".repeat(60);
    const derived = await start({ goal });
    expect(derived.status, await derived.clone().text()).toBe(201);
    const first = await derived.json() as { runId: string };
    expect(db.prepare("SELECT display_name AS name FROM team_queue_authority WHERE run_id = ?").get(first.runId))
      .toEqual({ name: "😀".repeat(48) });
    const named = await start({ goal, displayName: "Render the greeting animation" });
    expect(named.status).toBe(201);
    const second = await named.json() as { runId: string };
    expect(governance.getRun(second.runId).displayName).toBe("Render the greeting animation");
    expect(db.prepare("SELECT display_name AS name FROM team_queue_authority WHERE run_id = ?").get(second.runId))
      .toEqual({ name: "Render the greeting animation" });
  });

  it("pins an owner-selected workflow and removes write permission for a read-only request", async () => {
    const response = await start({ goal: "Inspect the design", workflow: { entrypoint: "spec-pov", readOnly: true } });
    expect(response.status).toBe(201);
    const receipt = await response.json() as { runId: string };
    const task = governance.findTask(receipt.runId, "task-1")!;
    expect(task.workflow).toMatchObject({ entrypoint: "spec-pov", origin: "user", readOnly: true });
    expect(task.permissions).not.toContain("write-assigned-tree");
  });

  it.each([
    { entrypoint: "spec-commit" },
    { entrypoint: "spec-pov", origin: "caller" },
    { entrypoint: "spec-pov", ownerMessageId: "another-run-request" },
  ])("rejects invalid workflow provenance before creating a run (%j)", async workflow => {
    expect((await start({ goal: "Inspect the design", workflow })).status).toBeGreaterThanOrEqual(400);
    expect(governance.listRuns()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 0 });
  });

  it("lists the runs it created, so no client has to type an id", async () => {
    const created = await (await start({ goal: "First" })).json() as Record<string, string>;
    const response = await app.request("/api/team-control/runs", { headers: { Authorization: "Bearer " + ownerToken } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(response.status).toBe(200);
    const body = await response.json() as { runs: Array<Record<string, string>> };
    expect(body.runs).toEqual([{ id: created.runId, rigId: "rig", rigName: "demo", state: "approved", planRef: "plan.md",
      displayName: "First", createdAt: expect.any(String), phase: "delivery", messageCount: 0, executionTaskCount: 1, resultCount: 0 }]);
  });

  /**
   * The goal is a paragraph the owner types into a textarea, and it becomes the task's brief.
   *
   * Its line breaks are part of it: a goal written as a short list reached the route as a
   * malformed request, because the shared `text` validator refuses every C0 control character.
   */
  it("accepts a goal written in more than one line, and keeps its line breaks", async () => {
    const goal = "Add two helpers to src/.\n\n1. chunk\n2. formatBytes\n\nLeave npm test green.";
    const response = await start({ goal });
    expect(response.status).toBe(201);
    const receipt = await response.json() as Record<string, string>;
    const row = db.prepare("SELECT body FROM queue_items WHERE qitem_id = ?").get(receipt.qitemId!) as { body: string };
    expect(row.body).toBe(goal);
    // A character no textarea can produce is still refused, so this did not weaken the contract.
    expect((await start({ goal: "Add a helper\u0007" })).status).toBe(400);
  });

  it("refuses a caller that is not the owner, and creates nothing", async () => {
    // A worker credential is authenticated but is not an owner decision.
    expect((await start({ goal: "Add a health endpoint" }, workerToken)).status).toBe(403);
    // No credential at all is not an authenticated start either.
    expect((await start({ goal: "Add a health endpoint" }, null)).status).toBe(401);
    expect(governance.listRuns()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 0 });
  });

  /**
   * C3 — the lead is opt-in, and a start without one is exactly the pre-C3 start.
   *
   * With a lead the run's first task is the lead's own: it carries the lead role and its
   * permission vocabulary, so the launch path projects the protocol, roster and run
   * instructions for it. A rig with no implementer seat has nobody to delegate to, which is a
   * refusal at the start rather than a lead that can propose nothing.
   */
  it("starts the run with a lead task when the owner names a lead seat", async () => {
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES ('builder', 'rig', 'builder', 'implementer', 'claude-code', ?)`)
      .run(directory);
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('s-builder', 'builder', 'builder@demo')").run();
    const response = await start({ goal: "Add a health endpoint", lead: "dev@demo", reviewerSeat: "builder@demo" });
    expect(response.status).toBe(201);
    const receipt = await response.json() as Record<string, string>;
    expect(receipt).toMatchObject({ taskId: "task-1", seat: "dev@demo", leadSeat: "dev@demo" });
    const task = governance.findTask(receipt.runId!, "task-1")!;
    expect(task.assignment).toEqual({ taskId: "task-1", role: "lead", paths: ["src"], dependencies: [] });
    expect(task.permissions).toEqual(["request-assignment", "record-evaluation", "propose-acceptance", "yield"]);
    expect(db.prepare("SELECT destination_session AS seat FROM queue_items WHERE qitem_id = ?").get(receipt.qitemId!))
      .toEqual({ seat: "dev@demo" });
  });

  it("refuses a lead with no implementer seat, and a lead that is also the reviewer", async () => {
    const empty = await start({ goal: "Add a health endpoint", lead: "dev@demo" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ code: "lead_roster_empty" });
    const sameSeat = await start({ goal: "Add a health endpoint", lead: "dev@demo", reviewerSeat: "dev@demo" });
    expect(sameSeat.status).toBe(400);
    expect(await sameSeat.json()).toMatchObject({ code: "lead_seat_invalid" });
    expect(db.prepare("SELECT count(*) AS count FROM team_runs").get()).toEqual({ count: 0 });
  });

  it("keeps the pre-C3 start unchanged when no lead is named", async () => {
    const receipt = await (await start({ goal: "Add a health endpoint" })).json() as Record<string, string>;
    expect(receipt.leadSeat).toBeNull();
    expect(governance.findTask(receipt.runId!, "task-1")!.assignment.role).toBe("implementer");
  });
});
