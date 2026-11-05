import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { LeadWakePolicy } from "../src/domain/lead-wake-policy.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import type { PlanBinding } from "../src/contracts/team-control.js";

const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: `sha256:${"a".repeat(64)}`,
  repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 2, policyFingerprint: `sha256:${"c".repeat(64)}`,
  limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
};
const usage = { activeMs: 0, inputTokens: { value: null, reason: "not reported" },
  outputTokens: { value: null, reason: "not reported" }, costUsd: { value: null, reason: "not reported" } };
const owner = { kind: "owner", sessionId: "owner" } as const;
const worker = { kind: "worker", sessionId: "worker" } as const;

describe("KTD21 Lead wake admission", () => {
  let db: ReturnType<typeof createDb>, bus: EventBus, queue: QueueRepository, governance: PlanGovernance;
  let now: Date, serial: number, directory: string, dbPath: string;
  const send = vi.fn(async () => ({ ok: true, verified: true }));
  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run",
    actionId, expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `key-${++serial}`, payload });
  const makeGovernance = () => new PlanGovernance(db, bus, queue, () => now,
    () => ({ policyRevision: 2, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] }));
  const pending = () => JSON.parse((db.prepare("SELECT payload FROM events WHERE json_extract(payload, '$.action') = 'lead.wake-state' ORDER BY seq DESC LIMIT 1")
    .get() as { payload: string }).payload).payload.pending;
  const task = (source = "peer@rig", destination = "lead@rig", role = "lead", taskId?: string) => {
    const id = taskId ?? `task-${++serial}`;
    const receipt = governance.createTask(command(id, { assignment: {
      taskId: id, role, paths: ["src"], dependencies: [] }, outputs: [], permissions: [],
      sourceSession: source, destinationSession: destination, body: "Task" }), binding);
    expect(receipt.status).toBe("accepted");
    return (receipt.value as { qitemId: string }).qitemId;
  };
  const activate = (qitemId: string | null = null, claims = {}) => {
    const id = `attempt-${++serial}`;
    const receipt = governance.recordAttempt(command(id, { qitemId, role: "lead", provider: "claude", state: "running",
      identity: { nativeSessionId: id, tmuxServer: "/control/tmux.sock", paneId: "%1", processId: 123,
        processStart: id, generation: 1, policyFingerprint: binding.policyFingerprint }, unknownReason: null, usage, ...claims }), binding);
    if (receipt.status === "observed") {
      governance.recordUsage(command(id, { expectedAttemptVersion: 1, state: "stopped", unknownReason: null, usage }));
    }
    return receipt;
  };
  const restart = () => {
    db.close(); db = createDb(dbPath); bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { transport: { send } }); governance = makeGovernance();
  };
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T00:00:00.000Z"));
    directory = mkdtempSync(join(tmpdir(), "lead-wake-")); dbPath = join(directory, "state.db");
    db = createDb(dbPath); migrate(db, ALL_MIGRATIONS); db.prepare("INSERT INTO rigs(id,name) VALUES ('rig','fixture')").run();
    bus = new EventBus(db); queue = new QueueRepository(db, bus, { transport: { send } });
    now = new Date("2026-10-17T00:00:00.000Z"); serial = 0; send.mockClear(); governance = makeGovernance();
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-10-18T00:00:00.000Z" }), worker);
    governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }), owner, binding);
  });
  afterEach(() => { db.close(); rmSync(directory, { recursive: true }); vi.useRealTimers(); });

  it("suppresses a Lead's own wake and never substitutes another recipient", async () => {
    const self = task("lead@rig");
    await queue.maybeNudge(self, "lead@rig", true);
    const peer = task("peer@rig", "builder@rig", "implementer");
    await queue.maybeNudge(peer, "lead@rig", true);
    expect(send).not.toHaveBeenCalled();
    expect(activate(self).status).toBe("denied"); expect(activate(peer).status).toBe("denied");
    await queue.maybeNudge(peer, "builder@rig", true);
    expect(send).not.toHaveBeenCalled();
    expect(pending()).toEqual({ "builder@rig": [peer] });
  });
  it("coalesces duplicate Lead triggers and retains them without terminal input", async () => {
    const id = task(), other = task();
    await Promise.all([queue.maybeNudge(id, "lead@rig", true), queue.maybeNudge(id, "lead@rig", true), queue.maybeNudge(other, "lead@rig", true)]);
    expect(send).not.toHaveBeenCalled();
    expect(pending()).toEqual({ "lead@rig": [id, other] });
    expect(activate(id).status).toBe("observed");
    expect(pending()).toEqual({ "lead@rig": [other] });
    restart(); expect(pending()).toEqual({ "lead@rig": [other] });
    expect(activate(other).status).toBe("observed"); expect(pending()).toEqual({});
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["implementer", "reviewer"])("rejects a Lead trigger registered as %s", role => {
    for (let i = 0; i < 12; i++) expect(activate().status).toBe("observed");
    expect(activate(task(), { role })).toMatchObject({ status: "denied", effectMayStart: false });
    expect((db.prepare("SELECT count(*) AS count FROM team_attempts").get() as { count: number }).count).toBe(12);
  });
  it.each(["__proto__", "constructor"])("bounds cycles for task identifier %s", taskId => {
    const id = task("peer@rig", "lead@rig", "lead", taskId);
    expect(activate(id).status).toBe("observed"); restart();
    expect(activate(id).status).toBe("observed"); expect(activate(id).status).toBe("denied");
  });
  it("does not treat unvalidated task evidence as owner progress", () => {
    const id = task(); expect(activate(id).status).toBe("observed"); expect(activate(id).status).toBe("observed");
    expect(governance.transitionTask(command(id, { expectedTaskVersion: 1, state: "in-progress",
      actorSession: "lead@rig", evidence: { checked: true }, observedBy: "owner" }), binding).status).toBe("accepted");
    restart(); expect(activate(id).status).toBe("denied");
  });
  it("counts a daemon-recorded outcome as lead-wake progress", () => {
    const id = task();
    const attempt = `attempt-${++serial}`;
    expect(governance.recordAttempt(command(attempt, { qitemId: id, role: "lead", provider: "claude", state: "running",
      identity: { nativeSessionId: attempt, tmuxServer: "/control/tmux.sock", paneId: "%1", processId: 123,
        processStart: attempt, generation: 1, policyFingerprint: binding.policyFingerprint }, unknownReason: null, usage }), binding).status).toBe("observed");
    expect(governance.recordUsage(command(attempt, { expectedAttemptVersion: 1, state: "stopped", unknownReason: null, usage })).status).toBe("observed");
    const before = new LeadWakePolicy(db, bus).check(governance.getRun("run"), id, now.toISOString()).progress;
    const outcome = governance.recordTaskOutcome(command(id, { expectedTaskVersion: 1, state: "done", actorSession: "lead@rig",
      attemptId: attempt, expectedAttemptVersion: 2, closureReason: "no-follow-on", evidence: { validated: true } }), { kind: "daemon", sessionId: "daemon" });
    expect(outcome.status).toBe("observed");
    const after = new LeadWakePolicy(db, bus).check(governance.getRun("run"), id, now.toISOString()).progress;
    expect(after).toBeGreaterThan(before);
  });
  it("blocks the third agent-only cycle across reconstruction and records an owner decision", async () => {
    const id = task();
    expect(activate(id).status).toBe("observed"); expect(activate(id).status).toBe("observed");
    restart();
    expect(activate(id, { ownerAction: true, validatedEvidence: { accepted: true }, maxCycles: 999 })).toMatchObject({ status: "denied", effectMayStart: false });
    expect(governance.getRun("run").state).toBe("blocked");
    expect(activate().status).toBe("denied");
    expect(governance.listApprovals("run").some(a => a.state === "pending" && a.action === "limit-increase")).toBe(true);
  });
  it("refuses activation thirteen, retains its trigger, and admits it after the rolling window", async () => {
    for (let i = 0; i < 12; i++) expect(activate().status).toBe("observed");
    restart(); const id = task();
    expect(activate(id, { maxActivationsPerHour: 999, ownerAction: true })).toMatchObject({ status: "denied", effectMayStart: false });
    expect(governance.getRun("run").stateReason).toMatch(/lead-wake:hourly/);
    expect(pending()["lead@rig"]).toContain(id);
    now = new Date(now.getTime() + 3_599_999); vi.setSystemTime(now); expect(activate(id).status).toBe("denied");
    now = new Date(now.getTime() + 1); vi.setSystemTime(now); restart();
    expect(activate(id).status).toBe("observed");
  });
  it.each(["cycle decision", "hourly decision", "validated outcome"])("resumes only from persisted owner action: %s", mode => {
    const id = task();
    for (let i = 0; i < (mode === "hourly decision" ? 12 : 2); i++) expect(activate(mode === "hourly decision" ? null : id).status).toBe("observed");
    expect(activate(id).status).toBe("denied");
    if (mode === "validated outcome") {
      const attempt = db.prepare("SELECT id FROM team_attempts ORDER BY rowid DESC LIMIT 1").get() as { id: string };
      expect(governance.recordTaskOutcome(command(id, { expectedTaskVersion: 1, state: "done", closureReason: "no-follow-on", transitionNote: "Owner verified the completed task", actorSession: "lead@rig",
        attemptId: attempt.id, expectedAttemptVersion: 2, evidence: { checked: true } }), owner).status).toBe("observed");
    } else {
      const approval = governance.listApprovals("run").find(a => a.action === "limit-increase" && a.state === "pending")!;
      expect(() => governance.decideApproval(command(approval.id, { approvalVersion: approval.entityVersion, decision: "approved" }), worker, binding)).toThrow();
      expect(governance.decideApproval(command(approval.id, { approvalVersion: approval.entityVersion, decision: "approved" }), owner, binding).status).toBe("accepted");
      expect(governance.getRun("run").state).toBe("blocked");
    }
    restart(); expect(activate(id).status).toBe("observed"); expect(governance.getRun("run").binding).toEqual(binding);
    if (mode === "hourly decision") {
      for (let i = 0; i < 11; i++) expect(activate().status).toBe("observed");
      restart(); expect(activate().status).toBe("denied");
      restart(); expect(activate().status).toBe("denied");
    }
  });
  it("leaves a recovered durable trigger pending before any transport claim", async () => {
    for (let i = 0; i < 12; i++) expect(activate().status).toBe("observed");
    const id = task(), outboxId = WAKE_INTENT_PREFIX + id;
    new OutboxHandler(db).record({ outboxId, auditPointer: id, senderSession: "peer@rig", destinationSession: "lead@rig", body: "trigger" });
    restart(); const outbox = new OutboxHandler(db); queue.attachOutbox(outbox);
    const delivery = queue as unknown as { deliverWakeIntent(id: string): Promise<unknown> };
    await delivery.deliverWakeIntent(outboxId); await delivery.deliverWakeIntent(outboxId);
    expect(outbox.getById(outboxId)?.deliveryState).toBe("pending"); expect(send).not.toHaveBeenCalled();
    expect(governance.getRun("run").stateReason).toBe("lead-wake:hourly");
    await expect(queue.drainPendingWakeIntents()).rejects.toMatchObject({ code: "managed_control_required" });
  });
  it.each(["current", "pre-governance"])("does not change an unbound legacy nudge (%s schema)", async schema => {
    const legacyDb = createDb(); migrate(legacyDb, schema === "current" ? ALL_MIGRATIONS : ALL_MIGRATIONS.filter(m => m.name < "104"));
    expect(legacyDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_queue_authority'").get() !== undefined).toBe(schema === "current");
    const legacyQueue = new QueueRepository(legacyDb, new EventBus(legacyDb), { transport: { send } });
    try { const item = await legacyQueue.create({ sourceSession: "sender@rig", destinationSession: "lead@rig", body: "legacy", nudge: false });
      await legacyQueue.maybeNudge(item.qitemId, "lead@rig", true); expect(send).toHaveBeenCalledTimes(1);
    } finally { legacyDb.close(); }
  });
});
