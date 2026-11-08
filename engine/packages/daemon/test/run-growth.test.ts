import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import { teamControlRoutes } from "../src/routes/team-control.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";
import type { ControlRequest, PlanBinding, TeamApproval } from "../src/contracts/team-control.js";

const owner = { kind: "owner", sessionId: "owner" } as const;
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const policy = unisolatedPolicyCapability(1);

describe("owner-approved run growth", () => {
  let root: string, db: Database.Database, governance: PlanGovernance, binding: PlanBinding;
  let app: ReturnType<typeof teamControlRoutes>, serial: number;
  const dispatch = vi.fn(async () => {});
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: "1.0", runId: "run", actionId, payload,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `request-${++serial}`,
  });
  const task = (taskId = "B", paths = [`src/${taskId}.ts`], dependencies: string[] = []) => ({
    assignment: { taskId, role: "implementer", paths, dependencies },
    outputs: paths, permissions: [...roleConfiguration.implementer.permissions], body: `Implement ${taskId}`,
    destinationSession: `seat-${taskId}`,
  });
  const post = (path: string, request: ControlRequest<unknown>, token = "fixture-owner") => app.request(`/runs/run/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }, peer);
  const suspend = async () => {
    const response = await post("tasks/A/edit", command("A", {
      expectedTaskVersion: governance.findTask("run", "A")!.entityVersion, changes: { addTask: task() },
    }));
    expect(response.status).toBe(200);
    writeFileSync(join(root, "plan.md"), "Approved goal with an additional scoped task.\n");
  };
  const proposal = (tasks = [task()]) => command("growth", {
    writePaths: ["src/A.ts", "src/B.ts", "src/C.ts"], tasks, expiresAt: "2026-11-04T01:00:00.000Z",
  });
  const decide = (decision: "approved" | "rejected" = "approved") => command("growth", {
    approvalVersion: governance.getApproval("growth")!.entityVersion, decision,
  });

  beforeEach(() => {
    serial = 0; dispatch.mockClear();
    root = mkdtempSync(join(tmpdir(), "run-growth-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Initial approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    binding = bindingForGoal({ root, planRef: "plan.md", writePaths: ["src/A.ts"], policy });
    db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id,name) VALUES ('rig','fixture')").run();
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-04T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("initial", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-04T01:00:00.000Z" }), owner);
    governance.decideApproval(command("initial", { approvalVersion: 1, decision: "approved" }), owner, binding);
    expect(governance.createTask(command("A", { ...task("A"), sourceSession: "owner" }), binding).status).toBe("accepted");
    app = teamControlRoutes(governance, { credentials: { ownerToken: "fixture-owner",
      workers: [{ token: "fixture-worker", runId: "run", sessionId: "worker" }] },
      resolveBinding: run => ({ ...run.binding, planDigest: hashBytes(readFileSync(join(root, "plan.md"))) }),
      readPolicyCapability: () => policy, dispatch }, []);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("keeps the old binding suspended until approval, then atomically binds and admits exactly once", async () => {
    await suspend();
    db.prepare("UPDATE team_runs SET active_ms=1200,retries_used=1,review_rounds_used=1 WHERE id='run'").run();
    const request = proposal([task(), task("C", ["src/C.ts"], ["B"])]);
    expect((await post("growth", request)).status).toBe(200);
    const approval = governance.getApproval("growth")!;
    expect(approval).toMatchObject({ action: "scope-change", state: "pending", bindingDigest: hashBinding(binding) });
    expect(governance.getRun("run")).toMatchObject({ state: "invalidated", bindingDigest: hashBinding(binding) });
    expect(governance.findTask("run", "B")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await (await post("growth", request)).json()).replayed).toBe(true);
    const decision = decide();
    expect((await post("approvals/decide", decision)).status).toBe(200);
    expect(governance.getRun("run")).toMatchObject({ state: "approved", activeMs: 1200, retriesUsed: 1, reviewRoundsUsed: 1,
      binding: { planDigest: hashBytes(readFileSync(join(root, "plan.md"))), writePaths: ["src/A.ts", "src/B.ts", "src/C.ts"] } });
    expect(governance.findTask("run", "B")?.assignment.paths).toEqual(["src/B.ts"]);
    expect(governance.findTask("run", "C")?.assignment.dependencies).toEqual(["B"]);
    expect(governance.getApproval("growth")?.decisionActor).toBe("owner-control");
    expect(governance.listApprovals("run").some(item => item.action === "implementation"
      && item.state === "approved" && item.bindingDigest === governance.getRun("run").bindingDigest)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith("run", "B");
    expect(dispatch).toHaveBeenCalledWith("run", "C");
    expect((await (await post("approvals/decide", decision)).json()).replayed).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority").get()).toEqual({ n: 3 });
  });

  it("requires an explicit owner decision to expand an existing run to project-wide scope", async () => {
    await suspend();
    const old = governance.getRun("run");
    const request = command("growth", { writePaths: ["."], tasks: [task("B", ["package.json", "server"])],
      expiresAt: "2026-11-04T01:00:00.000Z" });
    const response = await post("growth", request);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(governance.getRun("run").bindingDigest).toBe(old.bindingDigest);
    expect(governance.findTask("run", "B")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await post("approvals/decide", decide(), "fixture-worker")).status).toBe(403);
    expect(governance.getRun("run").bindingDigest).toBe(old.bindingDigest);
    expect((await post("approvals/decide", decide())).status).toBe(200);
    const expanded = governance.getRun("run");
    expect(expanded.binding.writePaths).toEqual(["."]);
    expect(expanded.binding.limits).toEqual(old.binding.limits);
    expect(expanded.binding.repository).toEqual(old.binding.repository);
    expect(governance.findTask("run", "B")?.assignment.paths).toEqual(["package.json", "server"]);
    expect(dispatch).toHaveBeenCalledWith("run", "B");
  });

  it("records rejection without changing the binding, admitting tasks or dispatching", async () => {
    await suspend();
    expect((await post("growth", proposal())).status).toBe(200);
    expect((await post("approvals/decide", decide("rejected"))).status).toBe(200);
    expect(governance.getApproval("growth")).toMatchObject({ state: "rejected", decisionActor: "owner-control" });
    expect(governance.getRun("run")).toMatchObject({ state: "invalidated", bindingDigest: hashBinding(binding) });
    expect(governance.findTask("run", "B")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await post("growth", { ...proposal(), actionId: "renamed" })).status).toBe(403);
  });

  it("refuses a decision after the proposed plan bytes drift and leaves tasks absent", async () => {
    await suspend();
    expect((await post("growth", proposal())).status).toBe(200);
    writeFileSync(join(root, "plan.md"), "Unapproved later edit.\n");
    expect((await post("approvals/decide", decide())).status).toBe(403);
    expect(governance.getRun("run").bindingDigest).toBe(hashBinding(binding));
    expect(governance.findTask("run", "B")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    () => [task("A")],
    () => [task("B", ["src/A.ts"])],
    () => [task("B", ["outside/B.ts"])],
    () => [task("B", ["src/B.ts"], ["missing"])],
    () => [task("B", ["src/B.ts"], ["C"]), task("C", ["src/C.ts"], ["B"])],
    () => [{ ...task(), outputs: ["outside/result.txt"] }],
    () => [{ ...task(), permissions: ["owner-approval"] }],
  ])("refuses an invalid task batch before recording a proposal", async tasks => {
    await suspend();
    const result = await post("growth", proposal(tasks()));
    expect([400, 403]).toContain(result.status);
    expect(governance.getApproval("growth")).toBeNull();
    expect(governance.findTask("run", "B")).toBeNull();
  });

  it("refuses workers, unsuspended runs and stale versions", async () => {
    expect((await post("growth", proposal())).status).toBe(403);
    await suspend();
    const request = proposal();
    expect((await post("growth", request, "fixture-worker")).status).toBe(403);
    expect((await post("growth", { ...request, expectedEntityVersion: 1 })).status).toBe(409);
    expect(governance.getApproval("growth")).toBeNull();
  });

  it("rolls back the approval, replacement and all tasks if any admission write fails", async () => {
    await suspend();
    expect((await post("growth", proposal([task(), task("C")]))).status).toBe(200);
    db.exec("CREATE TRIGGER reject_c BEFORE INSERT ON team_queue_authority WHEN NEW.task_id='C' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    expect((await post("approvals/decide", decide())).status).toBe(500);
    expect(governance.getApproval("growth")?.state).toBe("pending");
    expect(governance.getRun("run").bindingDigest).toBe(hashBinding(binding));
    expect(governance.findTask("run", "B")).toBeNull();
    expect(governance.findTask("run", "C")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retains the pending proposal across a governance restart", async () => {
    await suspend();
    expect((await post("growth", proposal())).status).toBe(200);
    const saved = governance.getApproval("growth") as TeamApproval;
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-04T00:00:00.000Z"), () => policy);
    expect(governance.getApproval("growth")).toEqual(saved);
    expect(governance.getRun("run").state).toBe("invalidated");
  });
});
