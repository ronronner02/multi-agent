import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { dependencySatisfied, validateDependencyGraph } from "../src/domain/workflow-runtime.js";
import { TEAM_CONTROL_VERSION, type ControlRequest, type PlanBinding } from "../src/team-control-surface.js";

// T011: dependency eligibility. Only an evidence-backed completion unlocks a
// dependent; a handed-off row never satisfies a dependency by itself.
const sha = (value: string) => `sha256:${value.repeat(64)}`;
const owner = { kind: "owner", sessionId: "owner-session" } as const;
const worker = { kind: "worker", sessionId: "worker-session" } as const;
const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: sha("a"), repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src", "test"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 2, policyFingerprint: sha("c"),
  limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
};
const verifiedPolicy = () => ({ policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint,
  verifiedProviders: ["claude", "codex"] as const });
const unavailable = { value: null, reason: "provider did not report usage" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };
const identity = { nativeSessionId: "native-session", tmuxServer: "/control/tmux.sock", paneId: "%1", processId: 123,
  processStart: "process-start-1", generation: 1, policyFingerprint: binding.policyFingerprint };

describe("managed dependency eligibility", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queue: QueueRepository;
  let governance: PlanGovernance;
  let now: Date;
  let nextKey: number;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'test')").run();
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus);
    now = new Date("2026-10-20T00:00:00.000Z");
    governance = new PlanGovernance(db, bus, queue, () => now, verifiedPolicy);
    nextKey = 0;
    governance.createRun({ id: "run-1", rigId: "rig-1", binding });
    requestPlan();
    governance.decideApproval(command("plan-approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
  });
  afterEach(() => {
    if (db.open) db.close();
  });

  const command = (actionId: string, payload: unknown, key?: string): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId: "run-1", actionId,
    expectedEntityVersion: governance.getRun("run-1").entityVersion,
    idempotencyKey: key ?? `key-${++nextKey}`, payload,
  });
  function requestPlan() {
    governance.requestApproval(command("plan-approval", {
      kind: "orchestrator", action: "implementation", payload: { bindingDigest: hashBinding(binding) },
      targetDigest: hashBinding(binding), expiresAt: "2026-10-20T01:00:00.000Z",
    }), worker);
  }
  const createTask = (taskId: string, dependencies: string[] = [], paths = [`src/${taskId}.ts`], destinationSession = `${taskId}@rig-1`) =>
    governance.createTask(command(taskId, {
      assignment: { taskId, role: "implementer", paths, dependencies },
      sourceSession: "lead@rig-1", destinationSession, body: `Implement ${taskId}`,
    }), binding);
  const qitemOf = (taskId: string) => (createTask(taskId).value as { qitemId: string }).qitemId;
  /** A dependent row parked on `blockerId`: the shape `--on <qitem> --state blocked` writes. */
  function parkDependent(taskId: string, blockerId: string, dependencies: string[]) {
    const qitemId = qitemOf(taskId);
    governance.transitionTask(command(qitemId, {
      expectedTaskVersion: 1, state: "blocked", actorSession: `${taskId}@rig-1`,
      blockedOn: blockerId, transitionNote: `waiting on ${dependencies.join(", ")}`,
    }), binding);
    return qitemId;
  }
  /** An owner-observed terminal outcome, the only managed path to a terminal queue state. */
  function observeOutcome(qitemId: string, taskId: string, state: "done" | "failed" | "denied" | "canceled", evidence: Record<string, unknown> = { receipt: "verified-exit" }) {
    governance.recordAttempt(command(`${taskId}-attempt`, {
      qitemId, role: "implementer", provider: "claude", identity, unknownReason: null, state: "stopped", usage,
    }), binding);
    return governance.recordTaskOutcome(command(qitemId, {
      expectedTaskVersion: governance.getTask(qitemId)!.entityVersion, state,
      ...(state === "done" ? { closureReason: "no-follow-on" } : {}),
      actorSession: `${taskId}@rig-1`, attemptId: `${taskId}-attempt`, expectedAttemptVersion: 1, evidence,
    }), owner);
  }

  it("unparks a dependent only when the blocker completed with validated evidence", () => {
    const prerequisite = createTask("prereq");
    const prerequisiteId = (prerequisite.value as { qitemId: string }).qitemId;
    const dependentId = parkDependent("consumer", prerequisiteId, ["prereq"]);
    expect(queue.getById(dependentId)).toMatchObject({ state: "blocked", blockedOn: prerequisiteId });

    expect(observeOutcome(prerequisiteId, "prereq", "done", { receipt: "verified-exit", validated: true }).status).toBe("observed");

    expect(queue.getById(dependentId)).toMatchObject({ state: "pending", blockedOn: null });
    const transitions = queue.listTransitions(dependentId).map(transition => transition.transitionNote);
    expect(transitions).toContainEqual(expect.stringContaining("auto-unparked"));
    expect(transitions.some(note => note?.includes("withheld"))).toBe(false);
  });

  it.each(["failed", "denied", "canceled"] as const)("never unlocks a dependent on a %s prerequisite", (state) => {
    const prerequisite = createTask("prereq");
    const prerequisiteId = (prerequisite.value as { qitemId: string }).qitemId;
    const dependentId = parkDependent("consumer", prerequisiteId, ["prereq"]);

    expect(observeOutcome(prerequisiteId, "prereq", state, { receipt: "observed-outcome", validated: true }).status).toBe("observed");

    expect(queue.getById(dependentId)).toMatchObject({ state: "blocked", blockedOn: prerequisiteId });
    expect(queue.getById(prerequisiteId)?.state).toBe(state);
    expect(queue.listTransitions(dependentId).map(transition => transition.transitionNote))
      .toContainEqual(expect.stringContaining(`withheld: blocker ${prerequisiteId} ended '${state}' without validated success`));
  });

  it("withholds a dependent when a done prerequisite lacks validated evidence", () => {
    const prerequisite = createTask("prereq");
    const prerequisiteId = (prerequisite.value as { qitemId: string }).qitemId;
    const dependentId = parkDependent("consumer", prerequisiteId, ["prereq"]);

    expect(observeOutcome(prerequisiteId, "prereq", "done", { receipt: "exit-zero-only" }).status).toBe("observed");

    expect(queue.getById(dependentId)).toMatchObject({ state: "blocked", blockedOn: prerequisiteId });
    expect(queue.listTransitions(dependentId).map(transition => transition.transitionNote))
      .toContainEqual(expect.stringContaining("without validated success"));
  });

  it("records the withholding once per blocked row and leaves unrelated rows alone", () => {
    const prerequisite = createTask("prereq");
    const prerequisiteId = (prerequisite.value as { qitemId: string }).qitemId;
    const first = parkDependent("consumer-one", prerequisiteId, ["prereq"]);
    const second = parkDependent("consumer-two", prerequisiteId, ["prereq"]);
    const unrelated = createTask("unrelated");
    const unrelatedId = (unrelated.value as { qitemId: string }).qitemId;

    observeOutcome(prerequisiteId, "prereq", "failed");

    for (const dependentId of [first, second]) {
      const withheld = queue.listTransitions(dependentId).filter(transition => transition.transitionNote?.includes("withheld"));
      expect(withheld).toHaveLength(1);
      expect(queue.getById(dependentId)?.state).toBe("blocked");
    }
    expect(queue.getById(unrelatedId)?.state).toBe("pending");
  });

  it("refuses to park a dependent on a blocker that already ended", () => {
    const prerequisite = createTask("prereq");
    const prerequisiteId = (prerequisite.value as { qitemId: string }).qitemId;
    observeOutcome(prerequisiteId, "prereq", "failed");
    const dependentId = qitemOf("consumer");

    expect(() => governance.transitionTask(command(dependentId, {
      expectedTaskVersion: 1, state: "blocked", actorSession: "consumer@rig-1",
      blockedOn: prerequisiteId, transitionNote: "waiting on prereq",
    }), binding)).toThrow(/blocked_on names a resolved qitem/);
    expect(queue.getById(dependentId)?.state).toBe("pending");
  });
});
describe("declared work graph", () => {
  const task = (taskId: string, dependencies: string[] = [], paths: string[] = [`src/${taskId}`], role = "implementer") =>
    ({ taskId, role, paths, dependencies });

  it("accepts a consistent graph, including disjoint files under one directory", () => {
    expect(validateDependencyGraph([
      task("schema"), task("api", ["schema"], ["src/api"]), task("ui", ["schema"], ["src/ui"]),
      task("review", ["api"], [], "reviewer"),
    ])).toEqual({ ok: true });
  });

  it("rejects a dependency cycle", () => {
    const verdict = validateDependencyGraph([task("a", ["b"]), task("b", ["c"]), task("c", ["a"])]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toMatch(/dependency cycle/);
  });

  it("rejects a dependency on a task the run does not declare", () => {
    expect(validateDependencyGraph([task("a", ["ghost"])])).toMatchObject({ ok: false, reason: expect.stringContaining("unknown task") });
  });

  it.each([
    ["identical", ["src/api", "src/api"]],
    ["nested", ["src", "src/api"]],
    ["differently spelled", ["src/api", "./src/api/"]],
    ["backslash spelled", ["src/api", "src\\api"]],
    ["duplicate separator", ["src/api", "src//api"]],
    ["dot segment", ["src/api", "src/./api"]],
  ])("rejects %s overlapping write ownership", (_kind, [first, second]) => {
    expect(validateDependencyGraph([task("one", [], [first!]), task("two", [], [second!])]))
      .toMatchObject({ ok: false, reason: expect.stringContaining("overlaps") });
  });

  it("refuses a run that declares more tasks than the admission limit", () => {
    const many = Array.from({ length: 101 }, (_, index) => task(`t${index}`, [], [`src/t${index}`]));
    expect(validateDependencyGraph(many)).toMatchObject({ ok: false, reason: expect.stringContaining("100-task limit") });
    expect(validateDependencyGraph(many.slice(0, 100))).toEqual({ ok: true });
  });
});

describe("handoff custody never satisfies a dependency by itself", () => {
  let db: Database.Database | undefined;
  afterEach(() => { if (db?.open) db.close(); db = undefined; });
  /** Real queue rows, so the resolver walks the same tables production does. */
  function fixture(rows: Record<string, { state: string; destination?: string; handedOffTo?: string | null; handedOffFrom?: string | null }>, authorities: Array<[string, string]>, validated: string[]) {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'test')").run();
    for (const [id, row] of Object.entries(rows)) {
      db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state,
        priority, tier, body, handed_off_to, handed_off_from) VALUES (?, ?, ?, ?, ?, ?, 0, 'default', 'task body', ?, ?)`)
        .run(id, "2026-10-20T00:00:00.000Z", "2026-10-20T00:00:00.000Z", "lead@rig-1", row.destination ?? "seat@rig-1", row.state, row.handedOffTo ?? null, row.handedOffFrom ?? null);
    }
    db.prepare(`INSERT INTO team_runs (id, rig_id, state, binding_json, binding_digest, created_at, updated_at)
      VALUES ('run-1', 'rig-1', 'approved', '{}', 'd', ?, ?)`).run("2026-10-20T00:00:00.000Z", "2026-10-20T00:00:00.000Z");
    for (const [taskId, qitemId] of authorities) {
      db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json) VALUES (?, 'run-1', ?, ?)`)
        .run(qitemId, taskId, JSON.stringify({ taskId, role: "implementer", paths: ["src"], dependencies: [] }));
    }
    const queue = new QueueRepository(db, new EventBus(db));
    return { queue, validated: (id: string) => validated.includes(id) };
  }

  it("follows a handoff to a successor that completed with validated evidence", () => {
    const built = fixture({
      "q-original": { state: "handed-off", handedOffTo: "successor@rig-1" },
      "q-successor": { state: "done", destination: "successor@rig-1", handedOffFrom: "q-original" },
    }, [["task-a", "q-original"]], ["q-successor"]);
    expect(dependencySatisfied(db!, built.queue, built.validated, "run-1", "task-a")).toBe(true);
  });

  it("does not satisfy a dependency when the successor has not completed", () => {
    const built = fixture({
      "q-original": { state: "handed-off", handedOffTo: "successor@rig-1" },
      "q-successor": { state: "in-progress", destination: "successor@rig-1", handedOffFrom: "q-original" },
    }, [["task-a", "q-original"]], []);
    expect(dependencySatisfied(db!, built.queue, built.validated, "run-1", "task-a")).toBe(false);
  });

  it("does not satisfy a dependency when the successor completed without validated evidence", () => {
    const built = fixture({
      "q-original": { state: "handed-off", handedOffTo: "successor@rig-1" },
      "q-successor": { state: "done", destination: "successor@rig-1", handedOffFrom: "q-original" },
    }, [["task-a", "q-original"]], []);
    expect(dependencySatisfied(db!, built.queue, built.validated, "run-1", "task-a")).toBe(false);
  });

  it("stops on a handoff chain that closes on itself", () => {
    const built = fixture({
      "q-one": { state: "handed-off", handedOffTo: "two@rig-1" },
      "q-two": { state: "handed-off", destination: "two@rig-1", handedOffTo: "one@rig-1", handedOffFrom: "q-one" },
    }, [["task-one", "q-one"], ["task-two", "q-two"]], []);
    expect(dependencySatisfied(db!, built.queue, built.validated, "run-1", "task-one")).toBe(false);
  });
});
