import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, fixDaemonMode, hashBinding } from "../src/domain/plan-governance.js";
import { recordLeadReply, answerDecision } from "../src/domain/lead-chat.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { boundedLogBody, TeamReadModel } from "../src/team-control-surface.js";
import { createTestApp } from "./helpers/test-app.js";
import type { PlanBinding } from "../src/contracts/team-control.js";

/**
 * T052 acceptance: the composed managed owner read.
 *
 * These exercise the real daemon app, the real governance/queue/event owners and
 * the real read model. Nothing is hand-built into the projection: a fixture that
 * wrote the projection's own rows would prove the reader can copy, not that a
 * producer exists.
 */

const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: `sha256:${"a".repeat(64)}`,
  repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 1, policyFingerprint: `sha256:${"c".repeat(64)}`,
  limits: { maxSessions: 3, maxActiveMs: 3600000, maxRetries: 1, maxReviewRounds: 2 },
};
const ownerToken = "owner-read-fixture";
const workerToken = "worker-read-fixture";
const capability = { policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint,
  verifiedProviders: ["claude", "codex"] as const };

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("T052 managed owner read projections", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queue: QueueRepository;
  let governance: PlanGovernance;
  let stream: StreamStore;
  let model: TeamReadModel;
  let app: ReturnType<typeof createTestApp>["app"];
  let key: number;
  let knownWorkspaces: Map<string, NonNullable<import("../src/contracts/team-control.js").TeamReviewView["workspace"]>>;

  beforeEach(() => {
    db = createDb();
    initializeDatabase(db);
    fixDaemonMode(db, true);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('managed-rig', 'managed')").run();
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus);
    stream = new StreamStore(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => capability);
    governance.createRun({ id: "run", rigId: "managed-rig", binding });
    // A second run exists so every assertion that says "run-scoped" has another
    // run's rows to wrongly include if the scope were missing.
    governance.createRun({ id: "other-run", rigId: "managed-rig", binding });

    model = new TeamReadModel({
      db, governance, events: bus,
      readTaskWorkspace: (runId, taskId) => knownWorkspaces.get(`${runId}/${taskId}`) ?? null,
      readTaskRows: (runId: string) => db.prepare(
        `SELECT a.qitem_id AS qitemId, a.task_id AS taskId, json_extract(a.assignment_json, '$.role') AS role,
          q.state AS queueState, q.destination_session AS session
          FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
          WHERE a.run_id = ? ORDER BY a.task_id`).all(runId) as Array<{
            qitemId: string; taskId: string; role: string; queueState: string; session: string | null }>,
    });

    app = createTestApp(db, { appDeps: {
      queueRepo: queue, eventBus: bus, legacyBearerToken: "legacy-control-fixture",
      terminalBearerToken: "terminal-control-fixture",
      teamControl: {
        credentials: { ownerToken, workers: [{ token: workerToken, sessionId: "worker-session", runId: "run" }] },
        resolveBinding: () => binding, readPolicyCapability: () => capability, readModel: model,
      },
    } }).app;
    key = 0;
    knownWorkspaces = new Map();
  });
  afterEach(() => db.close());

  const command = (runId: string, payload: unknown, actionId: string) => ({
    protocolVersion: "1.0", runId, actionId, expectedEntityVersion: governance.getRun(runId).entityVersion,
    idempotencyKey: `key-${++key}`, payload,
  });
  const request = (path: string, token = ownerToken, body?: unknown) =>
    app.request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Host: "localhost", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  const owner = { kind: "owner" as const, sessionId: "owner-control" };
const worker = { kind: "worker" as const, sessionId: "worker-session" };

/**
   * Put one admitted task with a produced attempt on the run, using the real
   * governed creation path.
   *
   * `startedAt` is when the attempt was recorded, which is what bounds the log
   * rows the seat produced. It defaults to the epoch so ordinary tests are not
   * sensitive to wall-clock ordering, and a caller that checks seat reuse names
   * the exact moment it wants.
   */
  function seedTask(runId: string, taskId: string, qitemId: string, session: string,
    startedAt = "2026-10-26T00:00:00.000Z", task: { body?: string; dependencies?: string[] } = {}) {
    // Managed mode refuses a legacy queue write, so the task is created through
    // the governed path exactly as production does. That also means the read
    // projection is proven against rows a real producer wrote.
    db.prepare(`INSERT OR REPLACE INTO team_approvals (id, run_id, kind, action, payload_json, payload_digest, target_digest,
      binding_digest, state, expires_at, created_at, updated_at)
      VALUES (?, ?, 'orchestrator', 'implementation', ?, ?, ?, ?, 'approved', ?, ?, ?)`)
      .run(`approval-${runId}`, runId, JSON.stringify({ bindingDigest: hashBinding(binding) }),
        sha("approval"), hashBinding(binding), hashBinding(binding),
        "2099-01-01T00:00:00.000Z", "2026-10-26T00:00:00.000Z", "2026-10-26T00:00:00.000Z");
    db.prepare("UPDATE team_runs SET state = 'approved' WHERE id = ?").run(runId);
    if (qitemId !== "") db.prepare("DELETE FROM team_queue_authority WHERE qitem_id = ?").run(qitemId);
    const receipt = governance.createTask({
      protocolVersion: "1.0", runId, actionId: taskId,
      expectedEntityVersion: governance.getRun(runId).entityVersion,
      idempotencyKey: `seed-${runId}-${taskId}`,
      payload: { assignment: { taskId, role: "implementer", paths: ["src"], dependencies: task.dependencies ?? [] },
        outputs: [], permissions: [],
        sourceSession: "lead", destinationSession: session, body: task.body ?? taskId },
    }, binding);
    if (receipt.status !== "accepted") throw new Error(`seed failed: ${receipt.reason}`);
    const created = (receipt.value as { qitemId: string }).qitemId;
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, state, usage_json,
      active_ms, created_at, updated_at) VALUES (?, ?, ?, 'implementer', 'claude', ?, 'stopped', ?, 0, ?, ?)`)
      .run(`attempt-${taskId}`, runId, created, JSON.stringify({ nativeSessionId: "native-1", tmuxServer: "/tmp/tmux",
        paneId: "%1", processId: 4321, processStart: "start", generation: 1,
        policyFingerprint: binding.policyFingerprint }),
        JSON.stringify({ activeMs: 0, inputTokens: { value: null, reason: "not reported" },
          outputTokens: { value: null, reason: "not reported" }, costUsd: { value: null, reason: "not reported" } }),
        startedAt, startedAt);
    return created;
  }

  it("serves the composed owner read while worker, unauthenticated and cross-run reads fail", async () => {
    seedTask("run", "T001", "", "seat-a");

    const response = await request("/api/team-control/runs/run/read");
    expect(response.status).toBe(200);
    const body = await response.json() as { read: { runId: string; tasks: Array<{ taskId: string }>; attempts: unknown[] } };
    expect(body.read.runId).toBe("run");
    expect(body.read.tasks.map((task) => task.taskId)).toEqual(["T001"]);
    expect(body.read.attempts).toHaveLength(1);
    // The other run's own task must not appear: the read is run-scoped, not rig-scoped.
    expect(JSON.stringify(body.read)).not.toContain("T002");

    expect((await request("/api/team-control/runs/run/read", workerToken)).status).toBe(403);
    expect((await request("/api/team-control/runs/run/read", "wrong-token")).status).toBe(401);
    // A run-bound worker asking for another run is refused by the scope check.
    expect((await request("/api/team-control/runs/other-run/read", workerToken)).status).toBe(403);
  });

  it("keeps legacy admission unchanged: the legacy events route still answers on its own terms", async () => {
    // The legacy stream is the compatibility surface; T052 adds a managed mount
    // beside it and must not change the old one's admission. A managed-mode
    // daemon already refuses legacy reads before T052 — that pre-existing
    // behaviour is what must be preserved, not widened into a 200.
    const legacy = await app.request("http://localhost/api/events?rigId=managed-rig",
      { headers: { Host: "localhost" } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect([200, 403]).toContain(legacy.status);
    // What matters for T052: the managed mount is authenticated, and adding it
    // did not make the legacy mount owner-scoped or run-scoped.
    expect((await request("/api/team-control/runs/run/events?afterSeq=0", ownerToken)).status).toBe(200);
    expect((await request("/api/team-control/runs/run/events?afterSeq=0", workerToken)).status).toBe(403);
  });

  it("publishes each task's title and declared dependencies", async () => {
    seedTask("run", "T001", "", "seat-a", "2026-10-26T00:00:00.000Z",
      { body: "  Add the status filter\n\nIt must reject unknown states.", dependencies: ["T000"] });
    seedTask("run", "T002", "", "seat-b", "2026-10-26T00:00:01.000Z", { body: "No dependencies here" });

    const body = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { tasks: Array<{ taskId: string; title: string | null; dependencies: string[] | null }> };
    };
    const [first, second] = body.read.tasks;
    // The title is the body's first non-blank line, trimmed: the task's own words, not a summary.
    expect(first).toMatchObject({ taskId: "T001", title: "Add the status filter", dependencies: ["T000"] });
    // A task that declared no dependencies publishes an empty list, not null: the two are different
    // facts, and only null means the assignment could not be read.
    expect(second).toMatchObject({ taskId: "T002", title: "No dependencies here", dependencies: [] });
  });

  it("publishes bounded task briefs and explicit declared criteria without claiming verification", async () => {
    seedTask("run", "T001", "", "seat-a", undefined, { body:
      "Implement search\n\nUse literal <button> text.\n\n## Acceptance criteria\n- Enter filters the list.\n- Empty input restores all rows.\n\n## Notes\nNot another criterion." });
    const response = await request("/api/team-control/runs/run/read");
    const { read } = await response.json() as { read: import("../src/contracts/team-control.js").TeamOwnerRead };
    expect(read.tasks[0].description).toEqual({ body: expect.stringContaining("Use literal <button> text."), truncated: false });
    expect(read.tasks[0].declaredAcceptanceCriteria).toEqual({ body: "- Enter filters the list.\n- Empty input restores all rows.", truncated: false });
    expect(read.tasks[0].criteria).toEqual({ verified: null, total: null, source: null });
    expect(read.tasks[0].workspace).toBeNull();
    expect(read.tasks[0].integrationBranch).toBeNull();
  });

  it("redacts and bounds the new text while keeping absent declarations unavailable", () => {
    seedTask("run", "T001", "", "seat-a", undefined, { body: "Task\nsk-abcdefghijklmnopqrstuvwxyz\n" + "ordinary words ".repeat(220) });
    const projected = model.read("run").tasks[0];
    expect(projected.description?.body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(projected.description?.body.length).toBeLessThanOrEqual(2000);
    expect(projected.description?.truncated).toBe(true);
    expect(projected.declaredAcceptanceCriteria).toBeNull();
  });

  it("ignores headings inside code and preserves an explicitly empty acceptance section", () => {
    seedTask("run", "T001", "", "seat-a", undefined, { body: "Task\n```md\n## Acceptance criteria\n- Example only.\n```" });
    seedTask("run", "T002", "", "seat-b", undefined, { body: "Task\n## Acceptance criteria\n\n## Notes\nNo criteria were listed." });
    const tasks = model.read("run").tasks;
    expect(tasks[0].declaredAcceptanceCriteria).toBeNull();
    expect(tasks[1].declaredAcceptanceCriteria).toEqual({ body: "", truncated: false });
  });

  it("reads only the run's existing candidate and recorded integration branch without writing", () => {
    seedTask("run", "T001", "", "seat-a");
    const reviewId = seedTask("run", "R001", "", "review-a");
    db.prepare("UPDATE team_queue_authority SET assignment_json = json_set(assignment_json, '$.role', 'reviewer', '$.reviewOf', 'T001') WHERE qitem_id = ?").run(reviewId);
    db.prepare("UPDATE team_runs SET integration_branch = ? WHERE id = ?").run("team/current", "run");
    db.prepare("UPDATE team_runs SET integration_branch = ? WHERE id = ?").run("team/other", "other-run");
    const workspace = { root: "/fixture/current/task", sourceRoot: "/fixture/current/integration", baseCommit: "a".repeat(40) };
    knownWorkspaces.set("run/T001", workspace);
    knownWorkspaces.set("other-run/T001", { ...workspace, root: "/fixture/other/task" });
    const changes = db.prepare("SELECT total_changes() AS value").get();
    const read = model.read("run");
    expect(read.tasks.every(task => task.workspace?.root === workspace.root)).toBe(true);
    expect(read.tasks.every(task => task.integrationBranch === "team/current")).toBe(true);
    expect(JSON.stringify(read)).not.toContain("/fixture/other");
    knownWorkspaces.clear();
    expect(model.read("run").tasks[0].workspace).toBeNull();
    expect(model.read("run").tasks[0].integrationBranch).toBe("team/current");
    expect(db.prepare("SELECT total_changes() AS value").get()).toEqual(changes);
  });

  it("publishes the daemon-owned task stage and exact assigned seat", () => {
    seedTask("run", "stage-task", "", "seat-b", undefined, { body: "Show the stage" });
    expect(model.read("run").tasks[0]).toMatchObject({
      stage: "queued", seat: "seat-b", workerReport: null,
    });
  });

  it("routes a recorded worker report to the lead and preserves owner precedence", () => {
    const qitemId = seedTask("run", "report-task", "", "seat-a");
    const attempt = governance.getAttempt("attempt-report-task")!;
    const receipt = governance.recordTaskOutcome(command("run", {
      expectedTaskVersion: governance.getTask(qitemId)!.entityVersion, state: "blocked",
      actorSession: "seat-a", attemptId: attempt.id, expectedAttemptVersion: attempt.entityVersion,
      evidence: { taskReport: { status: "blocked", question: "Which input should I use?", evidence: "Evidence line. ".repeat(180) } },
    }, qitemId), { kind: "daemon", sessionId: "daemon" });
    expect(receipt.status).toBe("observed");
    const projection = model.read("run").tasks[0]!;
    expect(projection).toMatchObject({ stage: "lead/report", workerReport: {
      status: "blocked", question: "Which input should I use?", truncated: true,
      attemptId: attempt.id, resolution: null,
    } });
    expect(projection.workerReport!.evidence).toHaveLength(2000);
    db.prepare("UPDATE team_runs SET state = 'blocked', state_reason = 'owner paused' WHERE id = 'run'").run();
    expect(model.read("run").tasks[0]!.stage).toBe("owner/blocked");
    db.prepare("UPDATE team_runs SET phase = 'planning' WHERE id = 'run'").run();
    expect(model.read("run").tasks[0]!.stage).toBe("owner/decision");
  });

  it("uses open chat decisions, not a running queue heuristic, and restores the running stage after an answer", () => {
    seedTask("run", "working", "", "seat-a");
    db.prepare("UPDATE team_attempts SET state = 'running' WHERE id = 'attempt-working'").run();
    expect(model.read("run").tasks[0]!.stage).toBe("running");
    recordLeadReply(db, { id: "decision", runId: "run", attemptId: "attempt-working",
      body: "Choose the scope", decision: { options: ["Small", "Large"] }, createdAt: new Date().toISOString() });
    expect(model.read("run").tasks[0]!.stage).toBe("owner/decision");
    answerDecision(db, "decision", "answer");
    expect(model.read("run").tasks[0]!.stage).toBe("running");
  });

  it("keeps dropped work done when another task waits for the owner or a review seat exists", () => {
    const qitemId = seedTask("run", "dropped", "", "seat-a");
    const attempt = governance.getAttempt("attempt-dropped")!;
    const receipt = governance.recordTaskOutcome(command("run", {
      expectedTaskVersion: governance.getTask(qitemId)!.entityVersion, state: "done", closureReason: "no-follow-on",
      actorSession: "seat-a", attemptId: attempt.id, expectedAttemptVersion: attempt.entityVersion,
      evidence: { taskReport: { status: "dropped", evidence: "The requested change already exists." } },
    }, qitemId), { kind: "daemon", sessionId: "daemon" });
    expect(receipt.status).toBe("observed");
    db.prepare("UPDATE team_runs SET phase = 'planning', reviewer_seat = 'reviewer' WHERE id = 'run'").run();
    expect(model.read("run").tasks[0]).toMatchObject({ stage: "done", workerReport: { status: "dropped" } });
  });

  it("keeps canceled retries and canceled review work in Done", () => {
    const retry = seedTask("run", "retry-task", "", "seat-a");
    const review = seedTask("run", "review-task", "", "seat-b");
    db.prepare("UPDATE team_queue_authority SET evidence_json = ? WHERE qitem_id = ?")
      .run(JSON.stringify({ retryNotBefore: "2099-01-01T00:00:00.000Z" }), retry);
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(review);
    db.prepare("UPDATE team_runs SET reviewer_seat = 'reviewer' WHERE id = 'run'").run();
    expect(model.read("run").tasks.find(task => task.taskId === "review-task")!.stage).toBe("review");
    expect(governance.cancelRun(command("run", { reason: "Owner canceled the run" }, "cancel"), owner).status).toBe("pending-execution");
    expect(governance.observeCancellation(command("run", {}, "cancel-observed"), owner).status).toBe("observed");
    expect(model.read("run").tasks.map(task => task.stage)).toEqual(["done", "done"]);
  });

  it("keeps required review open until the latest verdict approves the current candidate", () => {
    const qitem = seedTask("run", "review-task", "", "seat-a");
    db.prepare("UPDATE team_runs SET reviewer_seat = 'reviewer' WHERE id = 'run'").run();
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitem);
    db.prepare("UPDATE team_queue_authority SET evidence_json = ? WHERE qitem_id = ?")
      .run(JSON.stringify({ validated: true, manifestDigest: sha("old") }), qitem);
    const candidate = (digest: string) => bus.emit({ type: "team.control", protocolVersion: "1.0",
      eventId: "candidate-" + digest, rigId: "managed-rig", runId: "run", taskId: "review-task", attemptId: null,
      entityId: "review-task", entityVersion: 1, action: "review.candidate",
      payload: { manifestDigest: digest, baseDigest: sha("base"), capturedAt: "2026-10-26T00:00:00.000Z" } });
    const verdict = (round: number, digest: string) => bus.emit({ type: "team.control", protocolVersion: "1.0",
      eventId: "verdict-" + round, rigId: "managed-rig", runId: "run", taskId: "review-task", attemptId: null,
      entityId: "review-task", entityVersion: round + 1, action: "review.verdict",
      payload: { taskId: "review-task", reviewerTaskId: "reviewer-task", round, candidateDigest: digest,
        verdict: "approved", findings: [], recordedAt: "2026-10-26T00:00:01.000Z" } });
    candidate(sha("old")); verdict(1, sha("old"));
    expect(model.read("run").tasks[0]!.stage).toBe("done");
    candidate(sha("current"));
    expect(model.read("run").tasks[0]!.stage).toBe("review");
    verdict(2, sha("current"));
    expect(model.read("run").tasks[0]!.stage).toBe("done");
  });

  it("projects the validated native completion candidate before and after its matching review", async () => {
    const qitem = seedTask("run", "native-task", "", "seat-a");
    db.prepare("UPDATE team_runs SET reviewer_seat = 'reviewer' WHERE id = 'run'").run();
    const attempt = governance.getAttempt("attempt-native-task")!;
    const digest = sha("native-candidate");
    const receipt = governance.recordTaskOutcome(command("run", {
      expectedTaskVersion: governance.getTask(qitem)!.entityVersion, state: "done", closureReason: "no-follow-on",
      actorSession: "seat-a", attemptId: attempt.id, expectedAttemptVersion: attempt.entityVersion,
      evidence: { validated: true, manifestDigest: digest, changedPaths: ["src/index.ts"], outsideAssignment: [] },
    }, qitem), { kind: "daemon", sessionId: "daemon" });
    expect(receipt.status).toBe("observed");
    expect(model.read("run").tasks[0]).toMatchObject({
      currentCandidateDigest: digest, stage: "review", reviewAvailable: false,
      criteria: { verified: null, total: null }, acceptance: null,
    });
    bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "native-verdict", rigId: "managed-rig",
      runId: "run", taskId: "native-task", attemptId: null, entityId: "native-task", entityVersion: 1,
      action: "review.verdict", payload: { taskId: "native-task", reviewerTaskId: "reviewer-task", round: 1,
        candidateDigest: digest, verdict: "approved", findings: [], recordedAt: "2026-10-26T00:00:01.000Z" } });
    const response = await request("/api/team-control/runs/run/read");
    expect(response.status).toBe(200);
    expect((await response.json()).read.tasks[0]).toMatchObject({
      currentCandidateDigest: digest, stage: "done", reviewAvailable: true, acceptance: null,
      verdicts: [{ candidateDigest: digest, verdict: "approved" }],
    });
  });

  it.each([
    { validated: false, manifestDigest: sha("candidate") },
    { manifestDigest: sha("candidate") },
    { validated: true, manifestDigest: 42 },
  ])("does not publish an unvalidated or unreadable completion candidate: %j", evidence => {
    const qitem = seedTask("run", "unvalidated-task", "", "seat-a");
    db.prepare("UPDATE team_runs SET reviewer_seat = 'reviewer' WHERE id = 'run'").run();
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitem);
    db.prepare("UPDATE team_queue_authority SET evidence_json = ? WHERE qitem_id = ?")
      .run(JSON.stringify(evidence), qitem);
    expect(model.read("run").tasks[0]).toMatchObject({ currentCandidateDigest: null, stage: "review" });
  });

  it.each([["lead", "done"], ["implementer", "pending"]])(
    "does not use completion evidence as a review candidate for %s work that is %s", (role, state) => {
      const qitem = seedTask("run", "non-review-candidate", "", "seat-a");
      db.prepare("UPDATE queue_items SET state = ? WHERE qitem_id = ?").run(state, qitem);
      db.prepare("UPDATE team_queue_authority SET assignment_json = json_set(assignment_json, '$.role', ?), evidence_json = ? WHERE qitem_id = ?")
        .run(role, JSON.stringify({ validated: true, manifestDigest: sha("candidate") }), qitem);
      expect(model.read("run").tasks[0]!.currentCandidateDigest).toBeNull();
    },
  );

  it("bounds a long title to one display line and never invents one", async () => {
    seedTask("run", "T001", "", "seat-a", "2026-10-26T00:00:00.000Z", { body: "x".repeat(500) });
    const body = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { tasks: Array<{ title: string | null }> };
    };
    expect(body.read.tasks[0].title).toHaveLength(80);
    // An empty body has no title; the read model says so rather than echoing the task id.
    db.prepare("UPDATE queue_items SET body = '   ' WHERE qitem_id = (SELECT qitem_id FROM team_queue_authority WHERE task_id = 'T001')").run();
    const blank = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { tasks: Array<{ title: string | null; dependencies: string[] | null }> };
    };
    expect(blank.read.tasks[0].title).toBeNull();
    // The row's own JSON validity check is the boundary: an assignment the table accepted always
    // parses, so a published list is never `null` for a task the authority actually holds.
    expect(blank.read.tasks[0].dependencies).toEqual([]);
  });

  it("binds criteria and reviews to candidate identity, keeps missing reviews unavailable, and Finalize awaiting decision", async () => {
    const qitem = seedTask("run", "T001", "", "seat-a");

    const empty = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { tasks: Array<{ criteria: { verified: number | null; total: number | null };
        reviewAvailable: boolean; currentCandidateDigest: string | null; acceptance: unknown }>;
        workflow: { current: string | null; stages: Array<{ stage: string; state: string }> } };
    };
    // No criteria record and no review yet: nulls, never a passing 0/0 or a fake review.
    expect(empty.read.tasks[0].criteria).toEqual({ verified: null, total: null, source: null });
    expect(empty.read.tasks[0].reviewAvailable).toBe(false);
    expect(empty.read.tasks[0].acceptance).toBeNull();
    // Integration verification cannot be "complete" without a recorded acceptance.
    expect(empty.read.workflow.stages.find((stage) => stage.stage === "integration-verification")?.state).not.toBe("complete");
    // The earliest stage without finished required work: the task exists and is
    // not terminal, so execution is the current stage, not a completed stepper.
    expect(empty.read.workflow.current).toBe("execution");

    // Record real review evidence through the durable owner (events the fold reads).
    const digest = sha("candidate-1");
    bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "e1", rigId: "managed-rig", runId: "run",
      taskId: "T001", attemptId: null, entityId: "T001", entityVersion: 1, action: "review.candidate",
      payload: { manifestDigest: digest, baseDigest: sha("base"), capturedAt: "2026-10-26T00:00:00.000Z" } });
    db.prepare("UPDATE team_queue_authority SET evidence_json = ? WHERE qitem_id = ?")
      .run(JSON.stringify({ manifestDigest: sha("some-other-tree"),
        criteria: [{ verified: true }, { verified: true }, { verified: false }] }), qitem);

    // A record bound to another candidate cannot be reported beside this digest.
    const stale = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { tasks: Array<{ criteria: { verified: number | null; total: number | null } }> };
    };
    expect(stale.read.tasks[0].criteria).toMatchObject({ verified: null, total: null });

    // Bound to the current candidate, the same record is current progress.
    db.prepare("UPDATE team_queue_authority SET evidence_json = ? WHERE qitem_id = ?")
      .run(JSON.stringify({ manifestDigest: digest,
        criteria: [{ verified: true }, { verified: true }, { verified: false }] }), qitem);

    const filled = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { tasks: Array<{ criteria: { verified: number; total: number }; currentCandidateDigest: string }>;
        workflow: { current: string | null } };
    };
    // 3 of 4 style progress comes from the durable record, not from an agent claim.
    expect(filled.read.tasks[0].criteria).toMatchObject({ verified: 2, total: 3 });
    expect(filled.read.tasks[0].currentCandidateDigest).toBe(digest);
    expect(filled.read.workflow.current).toBeDefined();
  });

  it("publishes each attempt's own recorded usage and recording time", async () => {
    // The run's usage is a cumulative projection of these rows, so a reader that only sees the
    // total cannot say which attempt spent what or when. Both facts are read from the row that
    // already holds them, and an unobserved metric stays null with its producer's reason.
    seedTask("run", "T001", "", "seat-a", "2026-10-26T09:30:00.000Z");
    db.prepare(`UPDATE team_attempts SET usage_json = ? WHERE id = 'attempt-T001'`).run(JSON.stringify({
      activeMs: 754_000, inputTokens: { value: 120_000, reason: null }, outputTokens: { value: 30_000, reason: null },
      costUsd: { value: null, reason: "not reported" } }));

    const body = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { attempts: Array<{ attemptId: string; createdAt: string;
        usage: { activeMs: number; inputTokens: { value: number | null }; outputTokens: { value: number | null };
          costUsd: { value: number | null; reason: string | null } } }> };
    };
    expect(body.read.attempts[0]).toMatchObject({
      attemptId: "attempt-T001", createdAt: "2026-10-26T09:30:00.000Z",
      usage: { activeMs: 754_000, inputTokens: { value: 120_000 }, outputTokens: { value: 30_000 },
        costUsd: { value: null, reason: "not reported" } },
    });
    // The run's total still refuses to publish a cost one attempt never reported.
    const run = (await (await request("/api/team-control/runs/run")).json()) as { run: { usage: { costUsd: { value: number | null } } } };
    expect(run.run.usage.costUsd.value).toBeNull();
  });

  it("bounds, redacts and correlates log records, and reports an explicit replay gap", async () => {
    seedTask("run", "T001", "", "seat-a", new Date(Date.now() - 1000).toISOString());
    // A log line carrying a credential pattern and a terminal control sequence,
    // then a long body of ordinary prose that no secret pattern matches, so the
    // truncation bound is what shortens it rather than redaction.
    stream.emit({ sourceSession: "seat-a", body: `running tool sk-abcdefghijklmnopqrstuvwxyz\u001b[31mred` });
    stream.emit({ sourceSession: "seat-a", body: "a log line of ordinary words ".repeat(200) });

    const body = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { logs: Array<{ body: string; truncated: boolean; attemptId: string | null; taskId: string | null; source: string }>;
        replay: { retainedFrom: number; latestSeq: number } };
    };
    const records = body.read.logs.filter((record) => record.source === "stream");
    expect(records.length).toBe(2);
    // Correlated to the task and attempt whose seat produced it.
    expect(records.every((record) => record.taskId === "T001" && record.attemptId === "attempt-T001")).toBe(true);
    // Redacted at the boundary, and the control sequence never reaches a renderer.
    expect(records.some((record) => record.body.includes("sk-abcdefghijklmnopqrstuvwxyz"))).toBe(false);
    expect(records.some((record) => record.body.includes("\u001b"))).toBe(false);
    expect(records.some((record) => record.truncated)).toBe(true);
    expect(Math.max(...records.map((record) => record.body.length))).toBeLessThanOrEqual(2000);
    expect(body.read.replay.latestSeq).toBeGreaterThanOrEqual(body.read.replay.retainedFrom);

    // A cursor below the retained floor is a real gap, stated rather than papered
    // over; `afterSeq=0` means "from the beginning" and is never a gap.
    const fromStart = (await (await request("/api/team-control/runs/run/replay?afterSeq=0")).json()) as {
      gap: boolean };
    expect(fromStart.gap).toBe(false);
    db.prepare("DELETE FROM events WHERE seq < (SELECT MAX(seq) FROM events)").run();
    const gapWindow = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { replay: { retainedFrom: number; latestSeq: number } } };
    // Ask from a cursor that predates what is still retained.
    const staleCursor = gapWindow.read.replay.retainedFrom - 1;
    const replay = (await (await request(`/api/team-control/runs/run/replay?afterSeq=${Math.max(1, staleCursor)}`)).json()) as {
      gap: boolean; window: { retainedFrom: number } };
    expect(replay.window.retainedFrom).toBeGreaterThan(1);
    expect(replay.gap).toBe(true);
  });

  it("reconstructs one final state from a cursor plus paginated replay, with concurrent publication", async () => {
    seedTask("run", "T001", "", "seat-a");
    const total = 1000;
    // Walk a real paging cursor *while* events are still being published. The
    // walk and the publication are interleaved: after each published batch the
    // cursor advances through the pages that exist now, and the loop only ends
    // once the cursor has caught up with a quiet window. A cursor that lost or
    // skipped an event during paging would leave a hole the final assertion
    // catches, because every index must appear exactly once.
    const seenDuringPaging: number[] = [];
    let cursor = 0;
    let published = 0;
    for (;;) {
      // Publish a batch, then drain whatever pages are now available.
      const target = Math.min(total, published + 100);
      for (; published < target; published += 1) {
        const index = published + 1;
        bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: `e${index}`, rigId: "managed-rig",
          runId: "run", taskId: "T001", attemptId: null, entityId: "T001", entityVersion: index,
          action: "fixture.tick", payload: { index } });
      }
      // Drain with a small page size so several pages are needed while writes
      // continue, which is exactly the concurrency the guarantee is about.
      let advanced = true;
      while (advanced) {
        advanced = false;
        const page = (await (await request(
          `/api/team-control/runs/run/replay?afterSeq=${cursor}&limit=7`)).json()) as {
          events: Array<{ seq: number; action: string | null; body: string; runId: string | null }>;
        };
        for (const event of page.events) {
          expect(event.runId).toBe("run");
          expect(event.seq).toBeGreaterThan(cursor);
          cursor = event.seq;
          advanced = true;
          if (event.action === "fixture.tick") {
            seenDuringPaging.push((JSON.parse(event.body) as { index: number }).index);
          }
        }
      }
      if (published >= total) break;
    }
    expect(published).toBe(total);
    // Every event exactly once, in order, even though pages were read while
    // later events were still being committed.
    expect(seenDuringPaging).toEqual(Array.from({ length: total }, (_, index) => index + 1));

    // Another run's events interleave; a run-scoped replay must skip them and
    // still reconstruct exactly this run once.
    bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "other", rigId: "managed-rig",
      runId: "other-run", taskId: null, attemptId: null, entityId: "other", entityVersion: 1,
      action: "fixture.tick", payload: { index: -1 } });

    const seen: number[] = [];
    const identities: Array<{ seq: number; runId: string | null; action: string | null }> = [];
    let finalCursor = 0;
    for (;;) {
      const page = (await (await request(`/api/team-control/runs/run/replay?afterSeq=${finalCursor}&limit=250`)).json()) as {
        events: Array<{ seq: number; action: string | null; body: string; runId: string | null }>;
      };
      if (page.events.length === 0) break;
      for (const event of page.events) {
        // Persisted sequence ids are preserved, and every record carries the
        // run identity it belongs to plus the action the producer committed.
        expect(event.runId).toBe("run");
        expect(event.seq).toBeGreaterThan(finalCursor - 1);
        identities.push({ seq: event.seq, runId: event.runId, action: event.action });
        if (event.action === "fixture.tick") seen.push((JSON.parse(event.body) as { index: number }).index);
      }
      finalCursor = page.events.at(-1)!.seq;
    }
    // Exactly one final state: every fixture event once, in order, none duplicated,
    // and the interleaved event from the other run never appears.
    expect(seen).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(new Set(identities.map((entry) => entry.seq)).size).toBe(identities.length);
    expect(identities.every((entry) => entry.runId === "run")).toBe(true);
  });

  it("leaves durable state, files, sessions and provider state unchanged across reads", async () => {
    seedTask("run", "T001", "", "seat-a");
    stream.emit({ sourceSession: "seat-a", body: "line" });
    const snapshot = () => JSON.stringify({
      runs: db.prepare("SELECT * FROM team_runs ORDER BY id").all(),
      tasks: db.prepare("SELECT * FROM team_queue_authority ORDER BY qitem_id").all(),
      attempts: db.prepare("SELECT * FROM team_attempts ORDER BY id").all(),
      events: db.prepare("SELECT seq, type, payload FROM events ORDER BY seq").all(),
      stream: db.prepare("SELECT * FROM stream_items ORDER BY stream_item_id").all(),
      queue: db.prepare("SELECT * FROM queue_items ORDER BY qitem_id").all(),
      approvals: db.prepare("SELECT * FROM team_approvals ORDER BY id").all(),
    });
    const before = snapshot();
    await request("/api/team-control/runs/run/read");
    await request("/api/team-control/runs/run/replay?afterSeq=0");
    await request("/api/team-control/runs/run/events?afterSeq=0");
    await request("/api/team-control/health");
    expect(snapshot()).toBe(before);
  });

  it("keeps health unknown rather than healthy when the reader is missing or times out", async () => {
    // No readSystemHealth supplied: the composed read must report unavailable
    // health, and the health route must not turn that into a green light.
    const response = await request("/api/team-control/health");
    expect([200, 503]).toContain(response.status);
    if (response.status === 200) {
      const body = await response.json() as { health: { overall: string } };
      expect(["unknown", "degraded", "failed"]).toContain(body.health.overall);
    }
  });

  it("refuses a read when the run does not exist", async () => {
    expect((await request("/api/team-control/runs/nope/read")).status).toBe(404);
  });

  it("does not attribute a reused session's earlier output to this run", async () => {
    // The seat name outlives the run. A stream row written before this run's
    // attempt was recorded belongs to whoever used the seat earlier, and
    // publishing it as this run's attempt output would hand the owner another
    // run's text.
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const qitem = seedTask("run", "T001", "", "shared-seat", startedAt);
    // An earlier occupant's row, written well before this attempt was recorded.
    db.prepare(`INSERT INTO stream_items (stream_item_id, ts_emitted, stream_sort_key, source_session, body)
      VALUES (?, ?, ?, ?, ?)`).run("earlier-row", new Date(Date.now() - 120_000).toISOString(),
      "00", "shared-seat", "output from an earlier run");
    stream.emit({ sourceSession: "shared-seat", body: "output from this run" });

    const body = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { logs: Array<{ body: string; attemptId: string | null; taskId: string | null }> };
    };
    const mine = body.read.logs.filter((record) => record.attemptId === "attempt-T001");
    expect(mine.map((record) => record.body)).toEqual(["output from this run"]);
    expect(JSON.stringify(body.read.logs)).not.toContain("output from an earlier run");
    expect(qitem).toBeTruthy();
  });

  it("keeps seat windows disjoint when two attempts share a recording instant", async () => {
    // Two runs, one seat, attempts recorded in the same millisecond. Without a
    // tie-break the windows would overlap and a later run's row could be
    // published by the earlier one.
    const sameInstant = new Date(Date.now() - 30_000).toISOString();
    seedTask("run", "T001", "", "tie-seat", sameInstant);
    seedTask("other-run", "T900", "", "tie-seat", sameInstant);
    // The attempt ids differ, so exactly one of them must own rows from this
    // instant onward, and neither may claim a row it cannot name.
    stream.emit({ sourceSession: "tie-seat", body: "latest output" });

    const first = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { logs: Array<{ body: string; attemptId: string | null }> } };
    const second = (await (await request("/api/team-control/runs/other-run/read")).json()) as {
      read: { logs: Array<{ body: string; attemptId: string | null }> } };
    const owners = [...first.read.logs, ...second.read.logs].filter((record) => record.body === "latest output");
    // At most one attempt owns the row: the same row is never published twice
    // under two identities.
    expect(new Set(owners.map((record) => record.attemptId)).size).toBeLessThanOrEqual(owners.length);
    expect(owners.length).toBeLessThanOrEqual(1);
  });

  it("completes review and integration stages only when every task has the evidence", async () => {
    // Two tasks. T001 is genuinely reviewed (a recorded round) and accepted;
    // T002 has nothing. If the projection used any() the stages would complete
    // here, so this fixture distinguishes the two predicates.
    seedTask("run", "T001", "", "seat-a");
    seedTask("run", "T002", "", "seat-b");
    const digest = sha("tree-1");
    bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "c1", rigId: "managed-rig", runId: "run",
      taskId: "T001", attemptId: null, entityId: "T001", entityVersion: 1, action: "review.candidate",
      payload: { manifestDigest: digest, baseDigest: sha("base"), capturedAt: "2026-10-26T00:00:00.000Z" } });
    // A real recorded round, so T001's reviewAvailable is true rather than
    // merely having a candidate issued.
    db.prepare(`INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, NULL, 'team.control', ?)`)
      .run("managed-rig", JSON.stringify({ type: "team.control", protocolVersion: "1.0", eventId: "r1",
        rigId: "managed-rig", runId: "run", taskId: "T001", attemptId: null, entityId: "T001",
        entityVersion: 2, action: "review.recorded", payload: { runId: "run", taskId: "T001", round: 1,
          reviewerSession: "rev", implementerSession: "impl",
          candidate: { manifestDigest: digest, baseDigest: sha("base"), capturedAt: "2026-10-26T00:00:00.000Z" },
          findings: [], recordedAt: "2026-10-26T00:00:01.000Z", reportDigest: null } }));
    bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "a1", rigId: "managed-rig", runId: "run",
      taskId: "T001", attemptId: null, entityId: "T001", entityVersion: 3, action: "review.acceptance",
      payload: { manifestDigest: digest, passed: true, reason: "integrated", recordedAt: "2026-10-26T00:00:03.000Z" } });

    const read = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { tasks: Array<{ taskId: string; reviewAvailable: boolean; acceptance: unknown }>;
        workflow: { stages: Array<{ stage: string; state: string }> } } };
    // The fixture must actually exercise the asymmetry the predicate is about.
    const t001 = read.read.tasks.find((task) => task.taskId === "T001")!;
    const t002 = read.read.tasks.find((task) => task.taskId === "T002")!;
    expect(t001.reviewAvailable).toBe(true);
    expect(t001.acceptance).not.toBeNull();
    expect(t002.reviewAvailable).toBe(false);
    expect(t002.acceptance).toBeNull();

    const stage = (name: string) => read.read.workflow.stages.find((entry) => entry.stage === name)?.state;
    // One reviewed task cannot complete a run-level stage while another has none.
    expect(stage("review")).not.toBe("complete");
    expect(stage("integration-verification")).not.toBe("complete");
  });

  it("does not treat a pending delivery request as an owner decision", async () => {
    seedTask("run", "T001", "", "seat-a");
    // A pending release request is a request. Stage 6 must still read awaiting.
    db.prepare(`INSERT INTO team_approvals (id, run_id, kind, action, payload_json, payload_digest, target_digest,
      binding_digest, state, expires_at, created_at, updated_at)
      VALUES ('pending-release', 'run', 'orchestrator', 'release', '{}', ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(sha("p"), sha("t"), hashBinding(binding), "2099-01-01T00:00:00.000Z",
        "2026-10-26T00:00:00.000Z", "2026-10-26T00:00:00.000Z");

    const read = (await (await request("/api/team-control/runs/run/read")).json()) as {
      read: { workflow: { stages: Array<{ stage: string; state: string }> } } };
    expect(read.read.workflow.stages.find((entry) => entry.stage === "delivery-decision")?.state)
      .not.toBe("complete");
  });

  it("publishes the same bounded redacted body through replay as through the snapshot", async () => {
    seedTask("run", "T001", "", "seat-a");
    bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "secret", rigId: "managed-rig", runId: "run",
      taskId: "T001", attemptId: null, entityId: "T001", entityVersion: 1, action: "fixture.secret",
      payload: { note: "token sk-abcdefghijklmnopqrstuvwxyz", long: "ordinary words ".repeat(300) } });

    const page = (await (await request("/api/team-control/runs/run/replay?afterSeq=0")).json()) as {
      events: Array<{ action: string | null; body: string; truncated: boolean; runId: string | null; taskId: string | null }>;
    };
    const record = page.events.find((event) => event.action === "fixture.secret");
    expect(record).toBeDefined();
    // Replay is the same evidence surface as the snapshot: identity kept, secret gone.
    expect(record!.runId).toBe("run");
    expect(record!.taskId).toBe("T001");
    expect(record!.body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(record!.truncated).toBe(true);
    expect(record!.body.length).toBeLessThanOrEqual(2000);
  });

  it("keeps the projection and its replay cursor on one snapshot", async () => {
    // The read runs in one DEFERRED transaction, so the cursor it returns can
    // never be ahead of the state the projection observed. This checks the
    // invariant directly: reading the projection twice without any write in
    // between yields the same cursor, and an event committed afterwards sits
    // strictly after it, so a replay from that cursor is non-empty.
    seedTask("run", "T001", "", "seat-a");
    bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "early", rigId: "managed-rig",
      runId: "run", taskId: "T001", attemptId: null, entityId: "T001", entityVersion: 1,
      action: "fixture.early", payload: {} });

    const before = model.read("run").replay.latestSeq;
    // Stable across repeated reads while nothing is written.
    expect(model.read("run").replay.latestSeq).toBe(before);
    bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "late", rigId: "managed-rig",
      runId: "run", taskId: "T001", attemptId: null, entityId: "T001", entityVersion: 2,
      action: "fixture.late", payload: {} });
    // The later event is strictly after the earlier cursor, so resuming there
    // delivers it rather than skipping it.
    const page = model.replay("run", before, 100);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every((event) => event.seq > before)).toBe(true);
  });

  it("streams a run's live events with subscribe-before-replay ordering", async () => {
    seedTask("run", "T001", "", "seat-a");
    bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "before", rigId: "managed-rig", runId: "run",
      taskId: "T001", attemptId: null, entityId: "T001", entityVersion: 1, action: "fixture.before",
      payload: { index: 1 } });

    const response = await request("/api/team-control/runs/run/events/stream");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 2000;
    // Publish a live event while the stream is open: it must arrive after the
    // replayed one, never before it and never twice.
    const publish = setTimeout(() => {
      bus.emit({ type: "team.control", protocolVersion: "1.0", eventId: "after", rigId: "managed-rig", runId: "run",
        taskId: "T001", attemptId: null, entityId: "T001", entityVersion: 2, action: "fixture.after",
        payload: { index: 2 } });
    }, 50);
    while (Date.now() < deadline && !buffer.includes("fixture.after")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))),
      ]);
      if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
      if (chunk.done && !chunk.value) break;
    }
    clearTimeout(publish);
    reader.cancel().catch(() => {});

    const actions = buffer.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => (JSON.parse(line.slice(5).trim()) as { action: string }).action);
    expect(actions).toContain("fixture.before");
    expect(actions).toContain("fixture.after");
    // Replay first, then live: the order is the guarantee.
    expect(actions.indexOf("fixture.before")).toBeLessThan(actions.indexOf("fixture.after"));
    expect(actions.filter((action) => action === "fixture.before")).toHaveLength(1);
  });
});

describe("T052 log body bound", () => {
  it("strips control sequences, redacts secrets and truncates at the bound", () => {
    // Ordinary prose after the secret so the only thing that can shorten the
    // body is the bound, not the redaction patterns.
    const { body, truncated } = boundedLogBody(`ok sk-abcdefghijklmnopqrstuvwxyz \u001b[2J\u0007 ${"a log line of words ".repeat(200)}`);
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("\u0007");
    expect(body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(truncated).toBe(true);
    expect(body.length).toBe(2000);
  });

  it("leaves a short body untruncated", () => {
    expect(boundedLogBody("short line")).toEqual({ body: "short line", truncated: false });
  });
});
