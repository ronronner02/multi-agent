import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { teamControlRoutes } from "../src/routes/team-control.js";
import type { ControlRequest, PlanBinding } from "../src/contracts/team-control.js";

const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const owner = { kind: "owner", sessionId: "owner" } as const;
const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: hashBytes("plan"), repository: { root: "/workspace/project", identity: "snapshot:" + hashBytes("repository") },
  readPaths: ["src", "test"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 1, policyFingerprint: hashBytes("policy"), limits: { maxSessions: 3, maxActiveMs: 600000, maxRetries: 1, maxReviewRounds: 2 },
};

describe("versioned owner task edits", () => {
  let db: Database.Database, governance: PlanGovernance, queue: QueueRepository;
  let app: ReturnType<typeof teamControlRoutes>, serial: number;
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({ protocolVersion: "1.0", runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `request-${++serial}`, payload });
  const create = (taskId: string, dependencies: string[] = [], role = "implementer", paths = [`src/${taskId}.ts`]) => {
    const result = governance.createTask(command(taskId, { assignment: { taskId, role, paths, dependencies }, outputs: [], permissions: [],
      sourceSession: "lead", destinationSession: `seat-${taskId}`, body: `Task ${taskId}` }), binding);
    expect(result.status).toBe("accepted");
    return governance.findTask("run", taskId)!;
  };
  const read = async (taskId = "A") => {
    const response = await app.request(`/runs/run/tasks/${taskId}/edit`, { headers: { Authorization: "Bearer fixture-owner" } }, peer);
    expect(response.status).toBe(200);
    return response.json();
  };
  const requestFor = (changes: unknown, taskId = "A") => command(taskId, { expectedTaskVersion: governance.findTask("run", taskId)?.entityVersion, changes });
  const post = (request: ControlRequest<unknown>, token = "fixture-owner") => app.request(`/runs/run/tasks/${request.actionId}/edit`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(request),
  }, peer);
  const rows = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => {
    const name = (row as { name: string }).name;
    return [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()];
  });
  beforeEach(() => {
    serial = 0; db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id,name) VALUES ('rig','fixture')").run();
    const bus = new EventBus(db); queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, () => new Date("2026-10-30T00:00:00.000Z"), () => ({
      policyRevision: 1, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"],
    }));
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("approval", { kind: "orchestrator", action: "implementation", targetDigest: hashBinding(binding),
      payload: { bindingDigest: hashBinding(binding) }, expiresAt: "2026-10-30T01:00:00.000Z" }), owner);
    governance.decideApproval(command("approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    create("A"); create("B");
    app = teamControlRoutes(governance, { credentials: { ownerToken: "fixture-owner", workers: [{ token: "fixture-worker", runId: "run", sessionId: "worker" }] },
      resolveBinding: () => binding }, []);
  });
  afterEach(() => db.close());

  it("applies priority, notes and ordering once and preserves authority across reload", async () => {
    const before = governance.getRun("run").bindingDigest;
    const request = requestFor({ priority: "urgent", notes: "Owner note", order: 2 });
    expect((await post(request)).status).toBe(200);
    const state = await read();
    expect(state.task).toMatchObject({ priority: "urgent", notes: "Owner note", order: 2, taskVersion: 2 });
    const saved = rows();
    expect(await (await post(request)).json()).toMatchObject({ replayed: true, value: { classification: "applied" } });
    expect(rows()).toEqual(saved);
    expect(queue.getById(state.task.qitemId)?.priority).toBe("urgent");
    expect(governance.getRun("run").bindingDigest).toBe(before);
    expect(governance.findTask("run", "A")?.assignment.paths).toEqual(["src/A.ts"]);
  });

  it.each(["addTask", "removeTask", "scope", "paths", "acceptanceCriteria", "limits"])("records %s as a plan-change request and atomically invalidates the binding", async field => {
    const before = governance.findTask("run", "A");
    const response = await post(requestFor({ [field]: "proposed change", notes: "must not partially apply" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ value: { classification: "plan-change-required", affectedTasks: ["A", "B"], requestedChanges: { [field]: "proposed change" } } });
    expect(governance.getRun("run")).toMatchObject({ state: "invalidated", stateReason: "plan-change-required", bindingDigest: hashBinding(binding) });
    expect(governance.findTask("run", "A")).toEqual(before);
    expect(governance.getApproval("approval")?.state).toBe("invalidated");
    expect(governance.ownerCommand("resume", command("run", {}), owner, binding).status).toBe("denied");
    expect(governance.createTask(command("C", { assignment: { taskId: "C", role: "implementer", paths: ["src/C.ts"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead", destinationSession: "C", body: "C" }), binding).status).toBe("denied");
  });

  it("rolls back the request, authority and suspension together when persistence fails", async () => {
    db.exec("CREATE TRIGGER reject_edit BEFORE INSERT ON team_control_requests WHEN json_extract(NEW.response_json, '$.value.classification') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const before = rows();
    expect((await post(requestFor({ acceptanceCriteria: ["new criterion"] }))).status).toBe(500);
    expect(rows()).toEqual(before);
  });

  it("rejects stale versions and changed idempotent payloads without overwriting", async () => {
    const request = requestFor({ notes: "first" });
    expect((await post(request)).status).toBe(200);
    const before = rows();
    expect((await post({ ...request, idempotencyKey: "stale" })).status).toBe(409);
    expect((await post({ ...request, payload: { ...(request.payload as object), changes: { notes: "replacement" } } })).status).toBe(409);
    expect((await post({ ...request, expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "stale-task" })).status).toBe(409);
    expect(rows()).toEqual(before);
  });

  it("refuses workers, route mismatch and malformed fields before mutation", async () => {
    const before = rows();
    expect((await post(requestFor({ notes: "worker" }), "fixture-worker")).status).toBe(403);
    expect((await post(requestFor({ notes: "unknown" }), "unknown")).status).toBe(401);
    expect((await post({ ...requestFor({ notes: "wrong run" }), runId: "other" })).status).toBe(403);
    for (const changes of [{ unknown: true }, { order: -1 }, { priority: "invalid" }, { notes: 42 }]) expect((await post(requestFor(changes))).status).toBe(400);
    expect(rows()).toEqual(before);
  });

  it("rejects cycles, unknown links and removal of unvalidated prerequisites", async () => {
    const a = governance.findTask("run", "A")!;
    db.prepare("UPDATE team_queue_authority SET assignment_json=? WHERE qitem_id=?").run(JSON.stringify({ ...a.assignment, dependencies: ["B"] }), a.qitemId);
    expect(await (await post(requestFor({ dependencies: ["A"] }, "B"))).json()).toMatchObject({ status: "denied" });
    expect(await (await post(requestFor({ dependencies: [] }))).json()).toMatchObject({ status: "denied" });
    expect(await (await post(requestFor({ dependencies: ["missing"] }))).json()).toMatchObject({ status: "denied" });
    expect(governance.findTask("run", "A")?.assignment.dependencies).toEqual(["B"]);
  });

  it("permits existing validated links and a scope-preserving role edit", async () => {
    const b = governance.findTask("run", "B")!;
    db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(b.qitemId);
    db.prepare("UPDATE team_queue_authority SET evidence_json=? WHERE qitem_id=?").run(JSON.stringify({ validated: true }), b.qitemId);
    expect(await (await post(requestFor({ dependencies: ["B"], role: "lead" }))).json()).toMatchObject({ value: { classification: "applied" } });
    expect(governance.findTask("run", "A")?.assignment).toMatchObject({ role: "lead", dependencies: ["B"], paths: ["src/A.ts"] });
  });

  it("rejects edits racing with active work and role changes that gain write scope", async () => {
    const a = governance.findTask("run", "A")!;
    db.prepare("UPDATE queue_items SET state='in-progress' WHERE qitem_id=?").run(a.qitemId);
    expect(await (await post(requestFor({ role: "lead" }))).json()).toMatchObject({ status: "denied" });
    const review = create("R", [], "reviewer", ["test/read-only.ts"]);
    expect(await (await post(requestFor({ role: "implementer" }, "R"))).json()).toMatchObject({ status: "denied" });
    expect(governance.getTask(review.qitemId)?.assignment.role).toBe("reviewer");
  });
  it("keeps edit reads side-effect-free and owner-only", async () => {
    const before = rows(); await read();
    expect((await app.request("/runs/run/tasks/A/edit", { headers: { Authorization: "Bearer fixture-worker" } }, peer)).status).toBe(403);
    expect(rows()).toEqual(before);
  });

  it("checks dispatch races against the same run version and suspends future work without rewriting an admitted outcome", async () => {
    const stale = requestFor({ acceptanceCriteria: ["new"] });
    const a = governance.findTask("run", "A")!;
    const started = governance.transitionTask(command(a.qitemId, { expectedTaskVersion: a.entityVersion, state: "in-progress", actorSession: "seat-A" }), binding);
    expect(started.status).toBe("accepted");
    expect((await post(stale)).status).toBe(409);
    expect(governance.getRun("run").state).toBe("approved");
    expect(await (await post(requestFor({ acceptanceCriteria: ["new"] }))).json()).toMatchObject({ value: { classification: "plan-change-required" } });
    expect(queue.getById(a.qitemId)?.state).toBe("in-progress");
    expect(governance.getRun("run").state).toBe("invalidated");
  });

  it.each([["src/A.ts", "src/new.ts"], ["src/owned", "src/owned/new.ts"]])("keeps approved extension claims for %s without self-overlap", async (owned, added) => {
    const a = governance.findTask("run", "A")!, b = governance.findTask("run", "B")!;
    db.prepare("UPDATE team_queue_authority SET assignment_json=? WHERE qitem_id=?").run(JSON.stringify({ ...a.assignment, paths: [owned] }), a.qitemId);
    const extension = { ...(db.prepare("SELECT * FROM team_approvals WHERE id='approval'").get() as Record<string, unknown>),
      id: "extension", action: "scope-extension", payload_json: JSON.stringify({ paths: [{ path: added, canonicalPath: added, operation: "create" }] }) };
    db.prepare("INSERT INTO team_approvals (" + Object.keys(extension).join(",") + ") VALUES (" + Object.keys(extension).map(() => "?").join(",") + ")").run(...Object.values(extension));
    db.prepare("INSERT INTO team_scope_extensions (approval_id,task_id,chain_head,automatic) VALUES ('extension','A',?,1)").run(hashBytes("extension"));
    expect(await (await post(requestFor({ role: "lead" }, "B"))).json()).toMatchObject({ value: { classification: "applied" } });
    db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(b.qitemId);
    db.prepare("UPDATE team_queue_authority SET evidence_json=? WHERE qitem_id=?").run(JSON.stringify({ validated: true }), b.qitemId);
    expect(await (await post(requestFor({ role: "lead", dependencies: ["B"] }))).json()).toMatchObject({ value: { classification: "applied" } });
    create("R", [], "reviewer", [added]);
    expect(await (await post(requestFor({ role: "implementer" }, "R"))).json()).toMatchObject({ status: "denied" });
  });

  it("records material suspension during native launch admission without changing its admitted intent", async () => {
    const a = governance.findTask("run", "A")!, b = governance.findTask("run", "B")!;
    const launch = (task: typeof a, sessionId: string) => ({ qitemId: task.qitemId, expectedTaskVersion: task.entityVersion,
      provider: "codex", sessionId, commandDigest: hashBytes("command"), previousAttemptId: null, expectedPreviousVersion: null });
    const stale = requestFor({ acceptanceCriteria: ["new"] });
    expect(governance.admitNativeAttempt(command("attempt", launch(a, "seat-A")), owner, binding)).toMatchObject({ status: "pending-execution", effectMayStart: true });
    const intent = governance.getNativeLaunchIntent("run", "attempt");
    expect((await post(stale)).status).toBe(409);
    expect(await (await post(requestFor({ notes: "not while admitting" }))).json()).toMatchObject({ status: "denied" });
    expect(await (await post(requestFor({ acceptanceCriteria: ["new"] }))).json()).toMatchObject({ value: { classification: "plan-change-required" } });
    expect(governance.getRun("run")).toMatchObject({ state: "invalidated", stateReason: "plan-change-required" });
    expect(governance.getApproval("approval")?.state).toBe("invalidated");
    expect(governance.getNativeLaunchIntent("run", "attempt")).toEqual(intent);
    expect(governance.admitNativeAttempt(command("later", launch(b, "seat-B")), owner, binding).status).toBe("denied");
    expect(governance.reconcileNativeAttempt(command("attempt", { commandDigest: hashBytes("command"), expectedAttemptVersion: null,
      outcome: "not_started", identity: null, evidenceRef: "fixture:no-start" }), owner, binding).status).toBe("observed");
    expect(governance.getRun("run").state).toBe("invalidated");
  });

});
