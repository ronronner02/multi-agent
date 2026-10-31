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

  it("lists the runs it created, so no client has to type an id", async () => {
    const created = await (await start({ goal: "First" })).json() as Record<string, string>;
    const response = await app.request("/api/team-control/runs", { headers: { Authorization: "Bearer " + ownerToken } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(response.status).toBe(200);
    const body = await response.json() as { runs: Array<Record<string, string>> };
    expect(body.runs).toEqual([{ id: created.runId, rigId: "rig", rigName: "demo", state: "approved", planRef: "plan.md",
      createdAt: expect.any(String) }]);
  });

  it("refuses a caller that is not the owner, and creates nothing", async () => {
    // A worker credential is authenticated but is not an owner decision.
    expect((await start({ goal: "Add a health endpoint" }, workerToken)).status).toBe(403);
    // No credential at all is not an authenticated start either.
    expect((await start({ goal: "Add a health endpoint" }, null)).status).toBe(401);
    expect(governance.listRuns()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 0 });
  });
});
