import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, fixDaemonMode, hashBinding } from "../src/domain/plan-governance.js";
import { OwnerSessions, OWNER_CSRF_HEADER } from "../src/domain/owner-session.js";
import { TeamReadModel } from "../src/team-control-surface.js";
import type { PlanBinding } from "../src/contracts/team-control.js";
import { createTestApp } from "./helpers/test-app.js";
import { parseTeamEvent, readSSE, streamTeamEvents, type TeamEvent, type TeamEventState } from "../../ui/src/hooks/team-event-stream.js";
import type { DirectWorkerLaunchDeps } from "../src/adapters/direct-worker-launch.js";
import { WorkerEventNormalizer } from "../src/adapters/worker-event-normalizer.js";

const launch = vi.hoisted(() => ({ deps: null as DirectWorkerLaunchDeps | null }));
vi.mock("../src/adapters/direct-worker-launch.js", () => ({ DirectWorkerLauncher: class {
  constructor(deps: DirectWorkerLaunchDeps) { launch.deps = deps; }
} }));

const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: `sha256:${"a".repeat(64)}`,
  repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` }, readPaths: ["src"], writePaths: ["src"],
  roles: ["lead", "implementer", "reviewer"], policyRevision: 1, policyFingerprint: `sha256:${"c".repeat(64)}`,
  limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
};
const ownerToken = "event-owner-fixture", owner = { kind: "owner", sessionId: "owner-control" } as const;
const capability = { policyRevision: 1, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] as const };

describe("paired owner SSE and the shipped parser", () => {
  let db: ReturnType<typeof createDb>, bus: EventBus, queue: QueueRepository, governance: PlanGovernance;
  let model: TeamReadModel, app: ReturnType<typeof createTestApp>["app"];
  let browser: Record<string, string>, serial: number;
  const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost/api/team-control${path}`, {
    ...init, headers: { Host: "localhost", ...browser, ...Object.fromEntries(new Headers(init.headers)) },
  }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `key-${++serial}`, payload });
  beforeEach(async () => {
    serial = 0; browser = {};
    db = createDb(); initializeDatabase(db); fixDaemonMode(db, true);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'SSE fixture')").run();
    bus = new EventBus(db); queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => capability);
    governance.createRun({ id: "run", rigId: "rig", binding });
    model = new TeamReadModel({ db, governance, events: bus, readTaskRows: () => [] });
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      ownerSessions: new OwnerSessions(db), teamControl: { credentials: { ownerToken }, readModel: model, resolveBinding: () => binding,
        readPolicyCapability: () => capability } } }).app;
    const minted = await request("/owner-session/pairing", { method: "POST", headers: { Authorization: `Bearer ${ownerToken}` } });
    const exchanged = await request("/owner-session/exchange", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ code: (await minted.json()).code }) });
    expect(exchanged.status).toBe(200);
    browser = { Origin: "http://localhost", Cookie: exchanged.headers.get("Set-Cookie")!.split(";")[0]!,
      [OWNER_CSRF_HEADER]: (await exchanged.json()).antiForgeryToken };
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  async function until(response: Response, action: string) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2_000);
    const records: TeamEvent[] = [];
    try {
      for await (const message of readSSE(response.body!, controller.signal)) {
        if (message.event !== "message") continue;
        const record = parseTeamEvent(JSON.parse(message.data), "run"); records.push(record);
        expect(message.id).toBe(String(record.seq));
        if (record.action === action) break;
      }
    } finally { clearTimeout(timer); }
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
    return records;
  }

  it("requires the owner cookie plus the exact anti-forgery header on a stream read", async () => {
    const denied = await request("/runs/run/events/stream", { headers: { [OWNER_CSRF_HEADER]: "" } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "owner_anti_forgery_required" });
    const response = await request("/runs/run/events/stream");
    expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const records = await until(response, "run.created");
    expect(records.some(record => record.action === "run.created")).toBe(true);
  });

  it("resumes after Last-Event-ID, retaining task and attempt identity", async () => {
    governance.recordAttemptLifecycle({ runId: "run", attemptId: "attempt", taskId: "task", fact: "attempt.started" });
    const cursor = model.read("run").replay.latestSeq;
    const response = await request("/runs/run/events/stream", { headers: { "Last-Event-ID": String(cursor) } });
    governance.recordAttemptLifecycle({ runId: "run", attemptId: "attempt", taskId: "task", fact: "attempt.acknowledged" });
    const records = await until(response, "attempt.acknowledged");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ taskId: "task", attemptId: "attempt", action: "attempt.acknowledged" });
    expect(records.every(record => record.seq > cursor)).toBe(true);
  });

  it("streams a real governed lead-to-worker handoff through the new fetch client and parser", async () => {
    expect(governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), owner).status).toBe("accepted");
    expect(governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }), owner, binding).status).toBe("accepted");
    const cursor = model.read("run").replay.latestSeq;
    let current: TeamEventState = { events: [], cursor, window: model.read("run").replay, gap: false, initialized: true,
      trimmedThrough: 0, attempts: {}, connection: "connecting" };
    const controller = new AbortController(), invalidated = vi.fn();
    const headers: string[] = [];
    const running = streamTeamEvents({ runId: "run", signal: controller.signal, read: () => current,
      update: state => { current = state; }, invalidate: invalidated, permissionFailure: () => false,
      replay: async afterSeq => (await request(`/runs/run/replay?afterSeq=${afterSeq}`)).json(),
      open: async (path, init) => { headers.push(new Headers(init.headers).get("Last-Event-ID")!); return request(path, init); } });
    try {
      await vi.waitFor(() => expect(current.connection).toBe("live"));
      const receipt = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
        outputs: [], permissions: [], sourceSession: "lead", destinationSession: "implementer@rig", body: "Implement the status filter" }), binding);
      expect(receipt.status).toBe("accepted");
      const qitemId = (receipt.value as { qitemId: string }).qitemId;
      expect(queue.getById(qitemId)).toMatchObject({ destinationSession: "implementer@rig", state: "pending" });
      await vi.waitFor(() => expect(current.events.some(event => event.action === "task.created")).toBe(true));
      const handoff = current.events.find(event => event.action === "task.created")!;
      expect(handoff).toMatchObject({ runId: "run", taskId: "task" });
      expect(handoff.seq).toBeGreaterThan(cursor);
      expect(invalidated).toHaveBeenCalled(); expect(headers).toEqual([String(cursor)]);
    } finally { controller.abort(); await running; }
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
  });

  it("announces a retained-history gap before sending the replayed tail", async () => {
    governance.recordAttemptLifecycle({ runId: "run", attemptId: "attempt", taskId: "task", fact: "attempt.started" });
    const cursor = model.read("run").replay.latestSeq;
    governance.recordAttemptLifecycle({ runId: "run", attemptId: "attempt", taskId: "task", fact: "attempt.acknowledged" });
    db.prepare("DELETE FROM events WHERE seq <= ?").run(cursor);
    const response = await request("/runs/run/events/stream", { headers: { "Last-Event-ID": String(cursor) } });
    const controller = new AbortController(), frames = [];
    for await (const message of readSSE(response.body!, controller.signal)) { frames.push(message); if (frames.length === 2) break; }
    expect(frames[0].event).toBe("gap");
    expect(JSON.parse(frames[0].data)).toMatchObject({ runId: "run", afterSeq: cursor, retainedFrom: cursor + 1 });
    expect(parseTeamEvent(JSON.parse(frames[1].data), "run").action).toBe("attempt.acknowledged");
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
  });

  it("publishes provider activity from the daemon's composed native launch into the durable stream", async () => {
    const { createDaemon } = await import("../src/startup.js");
    const daemon = await createDaemon({ managedMode: true, workersIsolation: "none", dbPath: ":memory:",
      teamControl: { credentials: { ownerToken } } });
    try {
      daemon.db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'Native event fixture')").run();
      daemon.deps.teamGovernance!.createRun({ id: "native-run", rigId: "rig", binding });
      expect(launch.deps?.onEvent).toBeTypeOf("function");
      const normalizer = new WorkerEventNormalizer({ provider: "codex", attemptId: "native-attempt" });
      const events = [
        ...normalizer.normalize({ type: "thread.started", thread_id: "thread" }),
        ...normalizer.normalize({ type: "item.started", item: { id: "tool", type: "command_execution", command: "cat private-fixture.txt", status: "in_progress" } }),
        ...normalizer.normalize({ type: "item.completed", item: { id: "tool", type: "command_execution", command: "cat private-fixture.txt", status: "completed", exit_code: 0, aggregated_output: "fixture-secret-do-not-persist" } }),
        ...normalizer.normalize({ type: "item.completed", item: { id: "message", type: "agent_message", text: "private assistant content ".repeat(10_000) } }),
      ];
      for (const event of events) launch.deps!.onEvent!({ client: "codex", runId: "native-run", taskId: "task", attemptId: "native-attempt", tree: "/fixture", sessionId: "session" }, event);
      const records = daemon.deps.eventBus.replayRunSince("native-run", 0, 500);
      expect(records.map(record => (record as { action?: string }).action)).toEqual(expect.arrayContaining([
        "worker.session.started", "worker.tool.started", "worker.tool.completed", "worker.message.agent",
      ]));
      const stored = JSON.stringify(daemon.db.prepare("SELECT payload FROM events WHERE type = 'team.control'").all());
      expect(stored).not.toContain("fixture-secret-do-not-persist");
      expect(stored).not.toContain("private-fixture.txt");
      expect(stored).not.toContain("private assistant content");
      for (const record of records) {
        const envelope = record as { action?: string; payload?: unknown };
        if (envelope.action?.startsWith("worker.")) expect(Buffer.byteLength(JSON.stringify(envelope.payload))).toBeLessThan(768);
      }
      // Acknowledgment remains the lifecycle recorder's single fact.
      expect(records.filter(record => (record as { action?: string }).action === "attempt.acknowledged")).toHaveLength(0);
    } finally { daemon.db.close(); }
  });

  it("persists at most one provider heartbeat per attempt in each 15-second interval", async () => {
    const { createDaemon } = await import("../src/startup.js");
    const daemon = await createDaemon({ managedMode: true, workersIsolation: "none", dbPath: ":memory:",
      teamControl: { credentials: { ownerToken } } });
    try {
      daemon.db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'Heartbeat fixture')").run();
      daemon.deps.teamGovernance!.createRun({ id: "native-run", rigId: "rig", binding });
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const emit = (attemptId: string) => {
        const normalizer = new WorkerEventNormalizer({ provider: "claude", attemptId });
        const [event] = normalizer.normalize({ type: "system", subtype: "notification" });
        launch.deps!.onEvent!({ client: "claude-code", runId: "native-run", taskId: "task", attemptId, tree: "/fixture", sessionId: "session" }, event!);
      };
      const heartbeats = () => daemon.deps.eventBus.replayRunSince("native-run", 0, 500)
        .filter(record => (record as { action?: string }).action === "worker.heartbeat");
      emit("first"); emit("first"); emit("second");
      now = 14_999; emit("first"); emit("second");
      expect(heartbeats()).toHaveLength(2);
      now = 15_000; emit("first"); emit("first"); emit("second");
      expect(heartbeats()).toHaveLength(4);
    } finally { daemon.db.close(); }
  });
});
