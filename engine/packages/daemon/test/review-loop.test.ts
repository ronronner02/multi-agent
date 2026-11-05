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
import { blockingFindings, recordedFindings, reviewVerdict, reviewerTaskId } from "../src/domain/review-loop.js";
import { teamControlRoutes } from "../src/routes/team-control.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";
import type { ControlRequest, PlanBinding } from "../src/contracts/team-control.js";
import type { ReviewVerdictRecord } from "../src/domain/review-evidence.js";

/**
 * MVP slice C2 — the review loop.
 *
 * An implementer that completes with validated evidence admits its reviewer task through the
 * same path a start uses; the reviewer's recorded findings either send the implementer back
 * for rework under the run's own counter or close the task. Everything below drives the real
 * governance owner and the real queue, so no row is written by hand.
 */

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const policy = unisolatedPolicyCapability(1);
const nativeIdentity = (fingerprint: string) => ({ nativeSessionId: "native-" + Math.random().toString(36).slice(2),
  tmuxServer: "/control/tmux.sock", paneId: "%1", processId: 4242, processStart: "process-start-1",
  generation: 1, policyFingerprint: fingerprint });
const unavailable = { value: null, reason: "provider did not report usage" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };

describe("MVP slice C2 — the review loop", () => {
  let root: string, db: Database.Database, governance: PlanGovernance, binding: PlanBinding, serial: number;
  let app: ReturnType<typeof teamControlRoutes>;
  const dispatch = vi.fn(async () => {});
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: "1.0", runId: "run", actionId, payload,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `request-${++serial}`,
  });
  const post = (path: string, request: ControlRequest<unknown>) => app.request(`/runs/run/${path}`, {
    method: "POST", headers: { Authorization: "Bearer fixture-owner", "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }, peer);
  const task = (taskId: string, seat: string, extra: Record<string, unknown> = {}) => ({
    assignment: { taskId, role: "implementer", paths: ["src/a.ts"], dependencies: [] },
    outputs: ["src/a.ts"], permissions: [...roleConfiguration.implementer.permissions], body: `Implement ${taskId}`,
    destinationSession: seat, sourceSession: "owner-control", ...extra,
  });
  /** A second implementer task, on its own path and its own seat, so it is a separate allowance. */
  const secondTask = () => ({
    assignment: { taskId: "B", role: "implementer", paths: ["src/b.ts"], dependencies: [] },
    outputs: ["src/b.ts"], permissions: [...roleConfiguration.implementer.permissions], body: "Implement B",
    destinationSession: "implementer-b@rig", sourceSession: "owner-control" });
  /** An owner-observed terminal outcome, which is the only managed path to a terminal task. */
  let attempts = 0;
  const observe = (taskId: string, state: "done" | "failed" | "canceled", evidence: Record<string, unknown>) => {
    const row = governance.findTask("run", taskId)!;
    const queue = new QueueRepository(db, new EventBus(db));
    const seat = queue.getById(row.qitemId)!.destinationSession;
    // Each observation is its own attempt: a rework round reopens the task and launches it again.
    const attemptId = `${taskId}-attempt-${++attempts}`;
    const recorded = governance.recordAttempt(command(attemptId, { qitemId: row.qitemId, role: row.assignment.role,
      provider: "claude", identity: nativeIdentity(governance.getRun("run").binding.policyFingerprint), unknownReason: null,
      state: "stopped", usage }), governance.getRun("run").binding);
    expect(recorded.status).toBe("observed");
    return post("tasks/outcome", command(row.qitemId, { expectedTaskVersion: governance.getTask(row.qitemId)!.entityVersion,
      state, ...(state === "done" ? { closureReason: "no-follow-on" } : {}), actorSession: seat,
      attemptId, expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion, evidence }));
  };
  const reviewerTask = (taskId = reviewerTaskId("A", 1)) => governance.findTask("run", taskId)!;

  beforeEach(() => {
    serial = 0; dispatch.mockClear();
    root = mkdtempSync(join(tmpdir(), "review-loop-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    // Two review rounds, which is the binding's own maximum: one round to send the
    // implementer back and one to approve it. The allowance is per task, so the fixture
    // declares two implementer paths and two tasks can each spend it.
    binding = { ...bindingForGoal({ root, planRef: "plan.md", writePaths: ["src/a.ts", "src/b.ts"], policy }),
      limits: { maxSessions: 1, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 } };
    db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id,name) VALUES ('rig','fixture')").run();
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-04T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding, reviewerSeat: "reviewer@rig" });
    governance.requestApproval(command("initial", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-04T01:00:00.000Z" }), owner);
    governance.decideApproval(command("initial", { approvalVersion: 1, decision: "approved" }), owner, binding);
    expect(governance.createTask(command("A", task("A", "implementer@rig")), binding).status).toBe("accepted");
    app = teamControlRoutes(governance, { credentials: { ownerToken: "fixture-owner",
      workers: [{ token: "fixture-worker", runId: "run", sessionId: "implementer@rig" }] },
      resolveBinding: run => ({ ...run.binding, planDigest: hashBytes(readFileSync(join(root, "plan.md"))) }),
      readPolicyCapability: () => policy, dispatch }, []);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("admits a reviewOf-bound reviewer task when the implementer completes with validated evidence", async () => {
    const response = await observe("A", "done", { validated: true, manifestDigest: `sha256:${"a".repeat(64)}` });
    expect(response.status).toBe(200);
    const receipt = await response.json() as { reviewTaskId?: string; effectMayStart: boolean };
    // The reviewer task is the run's own row, bound to the candidate by `reviewOf`.
    expect(receipt.reviewTaskId).toBe(reviewerTaskId("A", 1));
    expect(receipt.effectMayStart).toBe(true);
    const review = reviewerTask();
    expect(review.assignment).toMatchObject({ taskId: "A-review-1", role: "reviewer", reviewOf: "A" });
    expect(review.permissions).toEqual(roleConfiguration.reviewer.permissions);
    // It routes to the reviewer seat the run recorded, and is dispatched through the same loop.
    expect(db.prepare("SELECT destination_session AS seat FROM queue_items WHERE qitem_id = ?").get(review.qitemId)).toEqual({ seat: "reviewer@rig" });
    expect(dispatch).toHaveBeenCalledWith("run", reviewerTaskId("A", 1));
    expect(governance.getRun("run").reviewRoundsUsed).toBe(1);
  });

  it("creates no review for a completion without validated evidence, or for a run with no reviewer seat", async () => {
    // Unvalidated evidence is not a completion the run can review.
    expect((await observe("A", "done", { manifestDigest: `sha256:${"a".repeat(64)}` })).status).toBe(200);
    expect(governance.findTask("run", reviewerTaskId("A", 1))).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    // A run that named no reviewer seat keeps the pre-C2 behaviour exactly.
    const second = createDb(":memory:"); migrate(second, ALL_MIGRATIONS);
    second.prepare("INSERT INTO rigs (id,name) VALUES ('rig','fixture')").run();
    const bus = new EventBus(second);
    const plain = new PlanGovernance(second, bus, new QueueRepository(second, bus), () => new Date("2026-11-04T00:00:00.000Z"), () => policy);
    plain.createRun({ id: "run", rigId: "rig", binding });
    expect(plain.getRun("run").reviewerSeat).toBeNull();
    second.close();
  });

  it("refuses a reviewer seat that is the implementer's own seat", async () => {
    // The loop's own refusal, reached through a run created with one seat for both roles: the
    // completion stands (a task did finish) but no reviewer task is admitted.
    const second = createDb(":memory:"); migrate(second, ALL_MIGRATIONS);
    second.prepare("INSERT INTO rigs (id,name) VALUES ('rig','fixture')").run();
    const bus = new EventBus(second);
    const selfReview = new PlanGovernance(second, bus, new QueueRepository(second, bus), () => new Date("2026-11-04T00:00:00.000Z"), () => policy);
    selfReview.createRun({ id: "run", rigId: "rig", binding, reviewerSeat: "implementer@rig" });
    const request = (actionId: string, payload: unknown, key: string): ControlRequest<unknown> => ({ protocolVersion: "1.0", runId: "run",
      actionId, expectedEntityVersion: selfReview.getRun("run").entityVersion, idempotencyKey: key, payload });
    selfReview.requestApproval(request("initial", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-04T01:00:00.000Z" }, "k1"), owner);
    selfReview.decideApproval(request("initial", { approvalVersion: 1, decision: "approved" }, "k2"), owner, binding);
    selfReview.createTask(request("A", task("A", "implementer@rig"), "k3"), binding);
    const row = selfReview.findTask("run", "A")!;
    selfReview.recordAttempt(request("A-attempt", { qitemId: row.qitemId, role: "implementer", provider: "claude",
      identity: nativeIdentity(binding.policyFingerprint), unknownReason: null, state: "stopped", usage }, "k4"), binding);
    const outcome = selfReview.recordTaskOutcome(request(row.qitemId, { expectedTaskVersion: 1, state: "done",
      closureReason: "no-follow-on", actorSession: "implementer@rig", attemptId: "A-attempt", expectedAttemptVersion: 1,
      evidence: { validated: true } }, "k5"), owner);
    expect(outcome).toMatchObject({ status: "observed" });
    expect((outcome as { reviewTaskId?: string }).reviewTaskId).toBeUndefined();
    expect(selfReview.findTask("run", reviewerTaskId("A", 1))).toBeNull();
    expect(selfReview.getRun("run").reviewRoundsUsed).toBe(0);
    second.close();
  });

  it("returns the implementer to rework on blocking findings, then closes it on approval", async () => {
    expect((await observe("A", "done", { validated: true })).status).toBe(200);
    // Round 1: a cited P1 with a failing scenario sends A back.
    const findings = [{ id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness", file: "src/a.ts",
      scenario: "the boundary accepts a stale version" }];
    const first = await observe("A-review-1", "done", { findings, manifestDigest: `sha256:${"b".repeat(64)}` });
    expect(first.status).toBe(200);
    const firstReceipt = await first.json() as { reworkTaskId?: string; value: { review: ReviewVerdictRecord } };
    expect(firstReceipt.reworkTaskId).toBe("A");
    expect(firstReceipt.value.review).toMatchObject({ round: 1, verdict: "changes-required", candidateDigest: `sha256:${"b".repeat(64)}` });
    // The implementer's row is open again, and the run's own counter recorded the round.
    expect(governance.queueState(governance.findTask("run", "A")!.qitemId)).toBe("pending");
    expect(governance.getRun("run").reviewRoundsUsed).toBe(1);
    expect(dispatch).toHaveBeenLastCalledWith("run", "A");
    // Round 2: the reworked candidate is approved, which closes A.
    expect((await observe("A", "done", { validated: true })).status).toBe(200);
    const second = await observe("A-review-2", "done", { findings: [], manifestDigest: `sha256:${"c".repeat(64)}` });
    expect(second.status).toBe(200);
    const secondReceipt = await second.json() as { reworkTaskId?: string; value: { review: ReviewVerdictRecord } };
    expect(secondReceipt.reworkTaskId).toBeUndefined();
    expect(secondReceipt.value.review).toMatchObject({ round: 2, verdict: "approved" });
    expect(governance.queueState(governance.findTask("run", "A")!.qitemId)).toBe("done");
    expect(governance.getRun("run").reviewRoundsUsed).toBe(2);
  });

  it("refuses a review whose P0 has no failing scenario, leaving the reviewer task open", async () => {
    expect((await observe("A", "done", { validated: true })).status).toBe(200);
    const response = await observe("A-review-1", "done", { findings: [{ id: "R1-1", severity: "P0", citation: "KTD8",
      category: "correctness", file: "src/a.ts" }] });
    expect(response.status).toBe(403);
    // Nothing was recorded: no round, no verdict, and the reviewer task is still pending.
    expect(governance.getRun("run").reviewRoundsUsed).toBe(1);
    expect(governance.queueState(governance.findTask("run", "A-review-1")!.qitemId)).toBe("pending");
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(payload, '$.action') = 'review.verdict'").get()).toEqual({ n: 0 });
  });

  it("stops at the binding's maxReviewRounds and blocks the run", async () => {
    expect((await observe("A", "done", { validated: true })).status).toBe(200);
    const blocking = [{ id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness", file: "src/a.ts",
      scenario: "the boundary accepts a stale version" }];
    expect((await observe("A-review-1", "done", { findings: blocking })).status).toBe(200);
    expect((await observe("A", "done", { validated: true })).status).toBe(200);
    expect((await observe("A-review-2", "done", { findings: blocking })).status).toBe(200);
    expect(governance.getRun("run").reviewRoundsUsed).toBe(2);
    // The third round is beyond the binding's cap: the completion that would start one is
    // refused, no reviewer task is admitted for it, and the run blocks on the spent counter.
    expect((await observe("A", "done", { validated: true })).status).toBe(403);
    expect(governance.findTask("run", reviewerTaskId("A", 3))).toBeNull();
    expect(governance.getRun("run")).toMatchObject({ state: "blocked", stateReason: "review limit exhausted", reviewRoundsUsed: 2 });
  });

  it("gives a second implementer task its own rounds after the first task spent both", async () => {
    // The plan's Review convergence: "Each task gets two review rounds". Task A spends its
    // allowance on a change request and a second change request; that must not leave task B
    // with no round at all.
    expect((await observe("A", "done", { validated: true })).status).toBe(200);
    const blocking = [{ id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness", file: "src/a.ts",
      scenario: "the boundary accepts a stale version" }];
    expect((await observe("A-review-1", "done", { findings: blocking })).status).toBe(200);
    expect((await observe("A", "done", { validated: true })).status).toBe(200);
    expect((await observe("A-review-2", "done", { findings: blocking })).status).toBe(200);
    expect(governance.getRun("run").reviewRoundsUsed).toBe(2);
    // A second implementer task is admitted on its own path and seat, and completes.
    expect(governance.createTask(command("B", secondTask()), binding).status).toBe("accepted");
    expect((await observe("B", "done", { validated: true })).status).toBe(200);
    // Its first round is round 1 of task B, not round 3 of the run.
    const review = governance.findTask("run", reviewerTaskId("B", 1))!;
    expect(review.assignment).toMatchObject({ role: "reviewer", reviewOf: "B" });
    expect(governance.findTask("run", reviewerTaskId("B", 2))).toBeNull();
    // The run's own total still counts both tasks' rounds, which is what the owner read shows.
    expect(governance.getRun("run")).toMatchObject({ state: "approved", reviewRoundsUsed: 3 });
  });

  it("keeps a task whose attempt predates a growth decision completing and reviewed", async () => {
    // C1's `/continue` route refuses a *continuation* whose attempt carries an earlier plan
    // binding. That is a different question from completion: a task whose attempt was
    // recorded before a growth decision still has to finish and be reviewed. This drives
    // exactly that order — attempt first, growth decision second, outcome third.
    const original = governance.getRun("run").binding;
    const attemptId = "A-attempt-before-growth";
    const task = governance.findTask("run", "A")!;
    expect(governance.recordAttempt(command(attemptId, { qitemId: task.qitemId, role: "implementer", provider: "claude",
      identity: nativeIdentity(original.policyFingerprint), unknownReason: null, state: "stopped", usage }), original).status).toBe("observed");
    expect(governance.getAttempt(attemptId)?.entityVersion).toBe(1);

    const edit = governance.editTask(command("A", { expectedTaskVersion: task.entityVersion,
      changes: { addTask: { assignment: { taskId: "B", role: "implementer", paths: ["src/b.ts"], dependencies: [] },
        outputs: ["src/b.ts"], permissions: [...roleConfiguration.implementer.permissions], body: "Implement B" } } }),
    owner, original);
    expect(edit.status).toBe("accepted");
    expect(governance.getRun("run").state).toBe("invalidated");
    writeFileSync(join(root, "plan.md"), "Approved goal with a second task.\n");
    expect((await post("growth", command("growth", { writePaths: ["src/a.ts", "src/b.ts"],
      expiresAt: "2026-11-04T01:00:00.000Z",
      tasks: [{ assignment: { taskId: "B", role: "implementer", paths: ["src/b.ts"], dependencies: [] },
        outputs: ["src/b.ts"], permissions: [...roleConfiguration.implementer.permissions], body: "Implement B",
        sourceSession: "owner-control", destinationSession: "implementer@rig" }] }))).status).toBe(200);
    const grown = { ...original, planDigest: hashBytes(readFileSync(join(root, "plan.md"))) };
    app = teamControlRoutes(governance, { credentials: { ownerToken: "fixture-owner",
      workers: [{ token: "fixture-worker", runId: "run", sessionId: "implementer@rig" }] },
      resolveBinding: run => ({ ...run.binding, planDigest: grown.planDigest }),
      readPolicyCapability: () => policy, dispatch }, []);
    expect((await post("approvals/decide", command("growth", { approvalVersion: governance.getApproval("growth")!.entityVersion,
      decision: "approved" }))).status).toBe(200);
    expect(governance.getRun("run").bindingDigest).not.toBe(hashBinding(original));

    // The attempt still belongs to A, and A completes: the run records the outcome and, because
    // the run named a reviewer seat, admits the reviewer task for it.
    const response = await post("tasks/outcome", command(task.qitemId, {
      expectedTaskVersion: governance.getTask(task.qitemId)!.entityVersion, state: "done", closureReason: "no-follow-on",
      actorSession: "implementer@rig", attemptId, expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion,
      evidence: { validated: true } }));
    expect(response.status).toBe(200);
    const receipt = await response.json() as { reviewTaskId?: string };
    expect(receipt.reviewTaskId).toBe(reviewerTaskId("A", 1));
    expect(governance.queueState(task.qitemId)).toBe("done");
    expect(governance.findTask("run", reviewerTaskId("A", 1))?.assignment.reviewOf).toBe("A");
  });
});

describe("the review loop's pure rules", () => {
  it("normalizes findings and refuses a P0/P1 with no failing scenario", () => {
    expect(recordedFindings({ findings: [] })).toEqual([]);
    expect(() => recordedFindings({ findings: [{ id: "f1", severity: "P1", citation: "KTD8", category: "correctness", file: "a.ts" }] }))
      .toThrow(/no failing scenario/);
  });

  it("treats only cited P0/P1 as blocking, so a P2/P3-only review approves", () => {
    const note = { id: "n1", severity: "P2" as const, citation: "KTD9", category: "clarity", file: "a.ts" };
    const advisory = { ...note, id: "n2", severity: "P0" as const, citation: "" };
    expect(blockingFindings([note, advisory])).toEqual([]);
    expect(reviewVerdict([note, advisory])).toBe("approved");
    expect(reviewVerdict([{ ...note, severity: "P1" }])).toBe("changes-required");
  });
});
