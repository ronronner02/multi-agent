import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import type { PlanBinding } from "../src/contracts/team-control.js";
import { createTestApp } from "./helpers/test-app.js";

// MVP slice 3 — the owner reads a finished task's patch from the team-control surface.
//
// The patch is the candidate's own computation, so this exercises the real runtime over a real
// git candidate rather than a stub: the point of the endpoint is that the bytes a worker wrote
// reach the owner unchanged. Authentication is proven on both sides — the owner reads, a worker
// credential does not — because a patch is worker-written content and a worker must not be able
// to read another task's work.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(parent: string): string {
  const root = realpathSync(mkdtempSync(join(parent, "repo-")));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** A projection is sealed read-only, so every directory is opened before removal. */
function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

describe("the owner result read", () => {
  let directory: string, repo: string, db: Database.Database, app: ReturnType<typeof createTestApp>["app"];
  let governance: PlanGovernance, runtime: WorkflowRuntime, binding: PlanBinding, qitemId: string, serial = 0;

  const request = (path: string, token: string | null = "owner-fixture") => app.request(`http://localhost${path}`,
    { headers: { Host: "localhost", ...(token === null ? {} : { Authorization: `Bearer ${token}` }) } },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "mvp3-" + ++serial, payload });

  beforeEach(() => {
    serial = 0;
    directory = realpathSync(mkdtempSync(join(tmpdir(), "mvp3-result-")));
    repo = repository(directory);
    const assignmentRoot = join(directory, "assignments");
    mkdirSync(join(assignmentRoot, "local"), { recursive: true });
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan"), repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 4, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    db = createDb(); initializeDatabase(db);
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    const capability = () => ({ policyRevision: 4, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] as const });
    governance = new PlanGovernance(db, bus, queue, undefined, capability);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, assignmentRoot: () => assignmentRoot,
      candidateRoot: (runId, taskId, worker) => join(assignmentRoot, worker, `${runId}-${taskId}`), defaultWorker: () => "local" });
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'rig')").run();
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }),
      { kind: "owner", sessionId: "owner-control" }, binding);
    const created = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer",
      paths: ["src"], dependencies: [] }, outputs: ["src/result.ts"], permissions: ["write-assigned-tree"],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file." }), binding);
    expect(created.status).toBe("accepted");
    qitemId = (created.value as { qitemId: string }).qitemId;
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      workflowRuntime: runtime, teamControl: { credentials: { ownerToken: "owner-fixture" },
        resolveBinding: () => structuredClone(binding), readPolicyCapability: capability } } }).app;
    // The worker wrote into the candidate the runtime admitted for it, and the owner recorded
    // the outcome — the two facts the route reads.
    writeFileSync(join(runtime.candidateFor("run", "task").root, "src", "result.ts"), "export const result = 42;\n");
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitemId);
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (existsSync(directory)) { writable(directory); rmSync(directory, { recursive: true, force: true }); }
  });

  it("returns the patch and the manifest for a finished task", async () => {
    const response = await request("/api/team-control/runs/run/tasks/task/result");
    expect(response.status).toBe(200);
    const body = await response.json() as { result: Record<string, unknown> };
    expect(body.result).toMatchObject({ schema: "multi-agent-team-result/v1", runId: "run", taskId: "task",
      repositoryRoot: repo, base: "commit" });
    // The patch is the candidate's own bytes: the file the worker wrote, as an addition.
    expect(body.result.patch).toContain("diff --git a/src/result.ts b/src/result.ts");
    expect(body.result.patch).toContain("+export const result = 42;");
    // The manifest is the complete candidate, not only the changed path.
    expect((body.result.files as Array<{ path: string }>).map(file => file.path))
      .toEqual(["plan.md", "src/base.ts", "src/result.ts"]);
    expect(body.result.manifestDigest).toBe(runtime.candidateIdentityFor("run", "task").manifestDigest);
  });

  it("re-adopts an intact candidate after restart when the run is no longer approved", async () => {
    db.prepare("UPDATE team_runs SET state = 'blocked' WHERE id = 'run'").run();
    const restartedBus = new EventBus(db);
    const restartedQueue = new QueueRepository(db, restartedBus);
    const assignmentRoot = join(directory, "assignments");
    runtime = new WorkflowRuntime({ db, eventBus: restartedBus, queueRepo: restartedQueue,
      assignmentRoot: () => assignmentRoot,
      candidateRoot: (runId, taskId, worker) => join(assignmentRoot, worker, `${runId}-${taskId}`),
      defaultWorker: () => "local" });
    app = createTestApp(db, { appDeps: { eventBus: restartedBus, queueRepo: restartedQueue,
      teamGovernance: governance, workflowRuntime: runtime,
      teamControl: { credentials: { ownerToken: "owner-fixture" },
        resolveBinding: () => structuredClone(binding), readPolicyCapability: () => ({
          policyRevision: 4, policyFingerprint: binding.policyFingerprint,
          verifiedProviders: ["claude", "codex"] as const }) } } }).app;

    const response = await request("/api/team-control/runs/run/tasks/task/result");
    expect(response.status).toBe(200);
    expect((await response.json() as { result: { patch: string } }).result.patch)
      .toContain("+export const result = 42;");
  });

  it("refuses an unfinished task, and one this run never recorded", async () => {
    db.prepare("UPDATE queue_items SET state = 'in-progress' WHERE qitem_id = ?").run(qitemId);
    const unfinished = await request("/api/team-control/runs/run/tasks/task/result");
    expect(unfinished.status).toBe(409);
    expect((await unfinished.json() as { code: string }).code).toBe("team_result_unfinished");
    const unknown = await request("/api/team-control/runs/run/tasks/unknown/result");
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { code: string }).code).toBe("control_not_found");
  });

  it("requires the owner credential, and refuses a worker's", async () => {
    const anonymous = await request("/api/team-control/runs/run/tasks/task/result", null);
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json() as { code: string }).code).toBe("control_auth_required");
    // A worker credential is scoped to its own run's mailbox and control actions, never to a
    // read that would hand it another task's work.
    const workerApp = createTestApp(db, { appDeps: { teamGovernance: governance, workflowRuntime: runtime,
      teamControl: { credentials: { ownerToken: "owner-fixture",
        workers: [{ token: "worker-fixture", sessionId: "builder@rig", runId: "run" }] } } } }).app;
    const worker = await workerApp.request("http://localhost/api/team-control/runs/run/tasks/task/result",
      { headers: { Host: "localhost", Authorization: "Bearer worker-fixture" } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(worker.status).toBe(403);
    expect((await worker.json() as { code: string }).code).toBe("owner_control_required");
  });

});
