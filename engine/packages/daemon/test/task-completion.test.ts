import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { composeAttemptCompletion, processIdentityAlive } from "../src/domain/attempt-completion.js";
import { changedPaths, leadCompletionEvidence, taskCompletionEvidence } from "../src/domain/task-completion.js";
import { reviewerTaskId } from "../src/domain/review-loop.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import type { PlanBinding } from "../src/contracts/team-control.js";
import { createTestApp } from "./helpers/test-app.js";

// MVP — the completion path: an attempt ends, the daemon says what it can verify, and the owner
// records the outcome.
//
// The gap this closes is a live-run one: a direct launch produces a receipt naming the client
// process, but nothing wrote the attempt into `team_attempts` and nothing ever closed it, so the
// owner's outcome command could never succeed outside the demos. Everything below drives the
// real owners — the governance commands, the queue, the runtime's candidate — so the two writes
// and the evidence are the production ones.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(parent: string): string {
  const root = realpathSync(mkdtempSync(join(parent, "repo-")));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan\n");
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

describe("MVP — the completion path", () => {
  let directory: string, repo: string, db: Database.Database, app: ReturnType<typeof createTestApp>["app"];
  let governance: PlanGovernance, runtime: WorkflowRuntime, binding: PlanBinding, serial = 0;
  let alive: boolean, sessions: SessionRegistry;

  const request = (path: string, token: string | null = "owner-fixture") => app.request(`http://localhost${path}`,
    { headers: { Host: "localhost", ...(token === null ? {} : { Authorization: `Bearer ${token}` }) } },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "mvp-completion-" + ++serial, payload });

  /** The receipt a direct launch records: the attempt id, the client and the process identity. */
  const receipt = (attemptId: string, seat: string, processId: number) => {
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig', 'node-1', 'managed.attempt.receipt', ?)")
      .run(JSON.stringify({ type: "managed.attempt.receipt", rigId: "rig", nodeId: "node-1", sessionId: "session-1",
        runId: "run", sessionName: seat, receipt: { attemptId, runId: "run", client: "claude-code",
          identity: { nativeSessionId: "native-" + attemptId, tmuxServer: "/control/tmux.sock", paneId: "%1",
            processId, processStart: "process-start-1", generation: 1, policyFingerprint: binding.policyFingerprint } } }));
  };

  const completion = () => composeAttemptCompletion({ db, governance, sessions, alive: () => alive,
    currentBinding: () => structuredClone(binding) });

  /** The seat's own startup status, which is what the dispatcher reads before it starts a client. */
  const seatStatus = (seat: string) => sessions.getSessionsForRig("rig")
    .find(row => row.id === sessions.findResumeContextByName(seat)!.sessionId)!.startupStatus;

  beforeEach(() => {
    serial = 0; alive = true;
    directory = realpathSync(mkdtempSync(join(tmpdir(), "mvp-completion-")));
    repo = repository(directory);
    const assignmentRoot = join(directory, "assignments");
    mkdirSync(join(assignmentRoot, "local"), { recursive: true });
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"), repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 4, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    const capability = () => ({ policyRevision: 4, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] as const });
    governance = new PlanGovernance(db, bus, queue, undefined, capability);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, assignmentRoot: () => assignmentRoot,
      candidateRoot: (runId, taskId, worker) => join(assignmentRoot, worker, `${runId}-${taskId}`), defaultWorker: () => "local" });
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'rig')").run();
    governance.createRun({ id: "run", rigId: "rig", binding, reviewerSeat: "reviewer@rig" });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }),
      { kind: "owner", sessionId: "owner-control" }, binding);
    const created = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer",
      paths: ["src"], dependencies: [] }, outputs: ["src/result.ts"], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file." }), binding);
    expect(created.status).toBe("accepted");
    // The seat the task routes to, as a start leaves it: one session, ready after its launch.
    const node = new RigRepository(db).addNode("rig", "builder", { role: "implementer", runtime: "claude-code", cwd: repo });
    sessions = new SessionRegistry(db);
    const session = sessions.registerSession(node.id, "builder@rig");
    sessions.updateStartupStatus(session.id, "ready");
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      workflowRuntime: runtime, teamControl: { credentials: { ownerToken: "owner-fixture" },
        resolveBinding: () => structuredClone(binding), readPolicyCapability: capability } } }).app;
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (existsSync(directory)) { writable(directory); rmSync(directory, { recursive: true, force: true }); }
  });

  it("admits the attempt a launch receipt names, then records it stopped when its process is gone", async () => {
    receipt("attempt-1", "builder@rig", 4242);
    const owner = completion();
    await owner.sweep();
    // The receipt is the observation that the client runs, and the attempt now names the task.
    expect(governance.getAttempt("attempt-1")).toMatchObject({ state: "running", qitemId: governance.findTask("run", "task")!.qitemId,
      identity: { processId: 4242, processStart: "process-start-1" } });
    // A second sweep over the same receipt records nothing twice.
    await owner.sweep();
    expect(governance.getAttempt("attempt-1")?.entityVersion).toBe(1);
    // The process ends: the next sweep observes it and stops the attempt.
    alive = false;
    await owner.sweep();
    expect(governance.getAttempt("attempt-1")?.state).toBe("stopped");
    // A stopped attempt is not re-observed, so a later sweep is a no-op.
    const version = governance.getAttempt("attempt-1")!.entityVersion;
    await owner.sweep();
    expect(governance.getAttempt("attempt-1")?.entityVersion).toBe(version);
  });

  it("puts the seat whose client ended back to never-launched, so the next dispatch starts it", async () => {
    // A `ready` seat is what tells the dispatcher "this seat already has an agent". It stays
    // true only while one runs: a seat whose client exited and keeps it would make the rework
    // dispatch and the reviewer's second round start nothing, and the task would wait forever.
    expect(seatStatus("builder@rig")).toBe("ready");
    receipt("attempt-1", "builder@rig", 4242);
    const owner = completion();
    await owner.sweep();
    expect(seatStatus("builder@rig")).toBe("ready");
    alive = false;
    await owner.sweep();
    expect(governance.getAttempt("attempt-1")?.state).toBe("stopped");
    expect(seatStatus("builder@rig")).toBe("pending");
  });

  it("reads only receipts it has not already read, so a tick does not rescan the log", async () => {
    // A receipt for a seat with no live task is read once and not retried: the owner action
    // refuses that task by name, so repeating the refusal every second would cost the daemon
    // more the longer it runs and tell nobody anything new.
    const owner = completion();
    receipt("attempt-orphan", "nobody@rig", 4242);
    await owner.sweep();
    expect(governance.getAttempt("attempt-orphan")).toBeNull();
    // A receipt appended later is still read: the sweep resumes where it stopped.
    receipt("attempt-1", "builder@rig", 4242);
    await owner.sweep();
    expect(governance.getAttempt("attempt-1")?.state).toBe("running");
    expect(governance.getAttempt("attempt-orphan")).toBeNull();
  });

  it("leaves a live process running, and never attaches a receipt to a seat with no single live task", async () => {
    receipt("attempt-1", "builder@rig", 4242);
    const owner = completion();
    await owner.sweep();
    expect(governance.getAttempt("attempt-1")?.state).toBe("running");
    // A second task on the same seat makes the seat ambiguous; its receipt stays unrecorded
    // rather than being attached to a guess.
    governance.createTask(command("task-2", { assignment: { taskId: "task-2", role: "implementer",
      paths: ["src"], dependencies: [] }, outputs: [], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Second task." }), binding);
    receipt("attempt-2", "builder@rig", 4343);
    await owner.sweep();
    expect(governance.getAttempt("attempt-2")).toBeNull();
    // The first attempt keeps its own identity: the ambiguity does not disturb what was recorded.
    expect(governance.getAttempt("attempt-1")?.state).toBe("running");
  });

  it("states the candidate's own evidence, and validates only a non-empty in-scope candidate", async () => {
    receipt("attempt-1", "builder@rig", 4242);
    const owner = completion();
    await owner.sweep();
    alive = false;
    await owner.sweep();
    // The launch admitted the task's candidate; nothing has been written into it yet.
    const tree = runtime.candidateFor("run", "task").root;

    // The daemon cannot validate a candidate that moves nothing.
    let body = await (await request("/api/team-control/runs/run/tasks/task/completion")).json() as {
      completion: { blockedReason: string | null; evidence: { validated: boolean; reasons: string[] }; attempt: { attemptId: string } } };
    expect(body.completion.blockedReason).toBeNull();
    expect(body.completion.attempt.attemptId).toBe("attempt-1");
    expect(body.completion.evidence.validated).toBe(false);
    expect(body.completion.evidence.reasons).toContain("The candidate moves no path");

    // The worker wrote inside its assignment: the candidate now validates.
    writeFileSync(join(tree, "src", "result.ts"), "export const result = 42;\n");
    body = await (await request("/api/team-control/runs/run/tasks/task/completion")).json() as typeof body;
    expect(body.completion.evidence).toMatchObject({ validated: true, reasons: [], changedPaths: ["src/result.ts"],
      outsideAssignment: [], base: "commit" });
    expect(body.completion.evidence.manifestDigest).toBe(runtime.candidateIdentityFor("run", "task").manifestDigest);

    // The same bytes outside the assignment are not validated work.
    writeFileSync(join(tree, "README.md"), "outside\n");
    body = await (await request("/api/team-control/runs/run/tasks/task/completion")).json() as typeof body;
    expect(body.completion.evidence).toMatchObject({ validated: false, outsideAssignment: ["README.md"] });
  });

  it("starts the C2 loop from the owner action, using only the evidence the daemon computed", async () => {
    receipt("attempt-1", "builder@rig", 4242);
    const owner = completion();
    await owner.sweep();
    alive = false;
    await owner.sweep();
    writeFileSync(join(runtime.candidateFor("run", "task").root, "src", "result.ts"), "export const result = 42;\n");
    const read = await (await request("/api/team-control/runs/run/tasks/task/completion")).json() as {
      completion: { actorSession: string; attempt: { attemptId: string; entityVersion: number }; evidence: Record<string, unknown> } };
    // The response is JSON, so the evidence is forwarded as the object the daemon computed.
    const outcome = governance.recordTaskOutcome(command(governance.findTask("run", "task")!.qitemId, {
      expectedTaskVersion: governance.getTask(governance.findTask("run", "task")!.qitemId)!.entityVersion,
      state: "done", closureReason: "no-follow-on", actorSession: read.completion.actorSession,
      attemptId: read.completion.attempt.attemptId, expectedAttemptVersion: read.completion.attempt.entityVersion,
      evidence: JSON.parse(JSON.stringify(read.completion.evidence)) }), { kind: "owner", sessionId: "owner-control" });
    expect(outcome.status).toBe("observed");
    // The completion the owner recorded is the one the loop acts on.
    expect((outcome as { reviewTaskId?: string }).reviewTaskId).toBe(reviewerTaskId("task", 1));
    expect(governance.findTask("run", reviewerTaskId("task", 1))?.assignment).toMatchObject({ role: "reviewer", reviewOf: "task" });
  });

  /**
   * C3 — a lead task's completion is recordable.
   *
   * This is the reachable defect the implementer rule causes: the lead's assignment paths are
   * the run's scope, so its proposal at the tree's root is "outside the assignment" and every
   * lead task stays open forever. The route now uses the lead's own rule, and the whole owner
   * action runs: the read validates, the outcome records, and no review task is created.
   */
  it("records a lead task done on its proposal, and starts no review", async () => {
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES ('lead-node', 'rig', 'lead', 'lead', 'codex', ?)`)
      .run(repo);
    const leadSeat = new SessionRegistry(db).registerSession("lead-node", "lead@rig");
    new SessionRegistry(db).updateStartupStatus(leadSeat.id, "ready");
    const created = governance.createTask(command("lead-task", { assignment: { taskId: "lead-task", role: "lead",
      paths: ["src"], dependencies: [] }, outputs: [], permissions: [...roleConfiguration.lead.permissions],
      sourceSession: "owner-control", destinationSession: "lead@rig", body: "Decompose the goal." }), binding);
    expect(created.status).toBe("accepted");
    receipt("attempt-lead", "lead@rig", 4444);
    const owner = completion();
    await owner.sweep();
    alive = false;
    await owner.sweep();
    const tree = runtime.candidateFor("run", "lead-task").root;
    const proposal = JSON.stringify({ tasks: [{ taskId: "task-2", seat: "builder@rig", paths: ["src/a.ts"],
      dependencies: [], body: "Implement a.ts" }] });

    // U6 — a delivery lead's turn is a management turn: answering an event without a new list
    // is a complete turn, so an untouched candidate is valid and carries no reasons.
    let body = await (await request("/api/team-control/runs/run/tasks/lead-task/completion")).json() as {
      completion: { actorSession: string; blockedReason: string | null; evidence: { validated: boolean; reasons: string[];
        outsideAssignment: string[] }; attempt: { attemptId: string; entityVersion: number } } };
    expect(body.completion.blockedReason).toBeNull();
    expect(body.completion.evidence).toMatchObject({ validated: true, reasons: [], changedPaths: [] });

    writeFileSync(join(tree, "lead-proposal.json"), proposal);
    body = await (await request("/api/team-control/runs/run/tasks/lead-task/completion")).json() as typeof body;
    expect(body.completion.evidence).toMatchObject({ validated: true, reasons: [], changedPaths: ["lead-proposal.json"],
      outsideAssignment: [] });

    // The owner action records it exactly as any other completion, and C2's loop does not start.
    const outcome = governance.recordTaskOutcome(command(governance.findTask("run", "lead-task")!.qitemId, {
      expectedTaskVersion: governance.getTask(governance.findTask("run", "lead-task")!.qitemId)!.entityVersion,
      state: "done", closureReason: "no-follow-on", actorSession: body.completion.actorSession,
      attemptId: body.completion.attempt.attemptId, expectedAttemptVersion: body.completion.attempt.entityVersion,
      evidence: JSON.parse(JSON.stringify(body.completion.evidence)) }), { kind: "owner", sessionId: "owner-control" });
    expect(outcome.status).toBe("observed");
    expect((outcome as { reviewTaskId?: string }).reviewTaskId).toBeUndefined();
    expect(governance.queueState(governance.findTask("run", "lead-task")!.qitemId)).toBe("done");
    // No review task exists for a lead's completion: the run holds its implementer and the lead.
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority WHERE run_id = 'run'").get()).toEqual({ n: 2 });
  });

  it("refuses the completion read to a worker credential", async () => {    const workerApp = createTestApp(db, { appDeps: { teamGovernance: governance, workflowRuntime: runtime,
      teamControl: { credentials: { ownerToken: "owner-fixture",
        workers: [{ token: "worker-fixture", sessionId: "builder@rig", runId: "run" }] } } } }).app;
    const response = await workerApp.request("http://localhost/api/team-control/runs/run/tasks/task/completion",
      { headers: { Host: "localhost", Authorization: "Bearer worker-fixture" } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("owner_control_required");
  });
});

describe("the completion path's pure rules", () => {
  const manifest = (patch: string, base: "commit" | "snapshot" = "commit") => ({ base, baseIdentifier: "a".repeat(40),
    files: [{ path: "plan.md" }], manifestDigest: "sha256:" + "b".repeat(64), patch });

  it("reads changed paths from the patch's own headers", () => {
    expect(changedPaths(["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts"].join("\n"))).toEqual(["src/a.ts"]);
    expect(changedPaths("")).toEqual([]);
  });

  it("validates only a candidate that moves something inside the assignment", () => {
    const patch = ["diff --git a/src/a.ts b/src/a.ts", "+++ b/src/a.ts"].join("\n");
    expect(taskCompletionEvidence({ role: "implementer", assignmentPaths: ["src"], manifest: manifest(patch) }).validated).toBe(true);
    expect(taskCompletionEvidence({ role: "implementer", assignmentPaths: ["src/a.ts"], manifest: manifest(patch) }).validated).toBe(true);
    expect(taskCompletionEvidence({ role: "implementer", assignmentPaths: ["src/other"], manifest: manifest(patch) }))
      .toMatchObject({ validated: false, outsideAssignment: ["src/a.ts"] });
    // A candidate with no base commit cannot say what moved, so it is never validated.
    expect(taskCompletionEvidence({ role: "implementer", assignmentPaths: ["src"], manifest: manifest(patch, "snapshot") }))
      .toMatchObject({ validated: false });
    // An unreadable candidate is its own reason, not an empty one.
    expect(taskCompletionEvidence({ role: "implementer", assignmentPaths: ["src"], manifest: null, unavailableReason: "gone" }))
      .toMatchObject({ validated: false, reasons: ["gone"], manifestDigest: null });
  });

  /**
   * C3 — a lead's deliverable is its proposal, not a code change.
   *
   * The implementer rule would call `lead-proposal.json` outside the lead's assignment (which is
   * the run's scope), so a lead task could never be recorded done. Its own rule validates exactly
   * the candidate that writes the proposal and nothing else, and only when that file parses.
   */
  it("validates a lead only on its proposal, and reports everything else", () => {
    const proposal = ["diff --git a/lead-proposal.json b/lead-proposal.json", "+++ b/lead-proposal.json"].join("\n");
    expect(leadCompletionEvidence({ manifest: manifest(proposal), proposal: { taskCount: 2 } }))
      .toMatchObject({ validated: true, changedPaths: ["lead-proposal.json"], outsideAssignment: [], reasons: [] });
    // A candidate that also moves something else is not a lead's deliverable.
    const extra = [proposal, "diff --git a/src/a.ts b/src/a.ts", "+++ b/src/a.ts"].join("\n");
    expect(leadCompletionEvidence({ manifest: manifest(extra), proposal: { taskCount: 2 } }))
      .toMatchObject({ validated: false, outsideAssignment: ["src/a.ts"] });
    // A candidate with no proposal at all, or one the boundary refuses, is not validated.
    expect(leadCompletionEvidence({ manifest: manifest(""), proposal: null }).reasons)
      .toEqual(["The candidate does not write lead-proposal.json", "The lead's proposal is missing or unreadable"]);
    expect(leadCompletionEvidence({ manifest: manifest(proposal), proposal: null }))
      .toMatchObject({ validated: false, reasons: ["The lead's proposal is missing or unreadable"] });
    // The snapshot lane cannot say what moved, exactly as for an implementer.
    expect(leadCompletionEvidence({ manifest: manifest(proposal, "snapshot"), proposal: { taskCount: 2 } }))
      .toMatchObject({ validated: false });
    // An unreadable candidate is its own reason, not an empty one.
    expect(leadCompletionEvidence({ manifest: null, proposal: null, unavailableReason: "gone" }))
      .toMatchObject({ validated: false, reasons: ["gone"], manifestDigest: null });
  });

  /**
   * U6 — a delivery lead's management turn.
   *
   * After the plan is approved the lead's turns answer team events and ask the owner for
   * decisions, so its candidate may hold the escalation as well as the proposal, and a turn
   * that wrote neither is a complete answer rather than a failure. What stays refused is a write
   * outside those two files, and an escalation the boundary could not read; a proposal it could
   * not read is the manager's refusal to make, so the lead hears the reason instead of a retry.
   */
  it("validates a delivery lead's management turn, and refuses writes outside its two files", () => {
    const proposal = ["diff --git a/lead-proposal.json b/lead-proposal.json", "+++ b/lead-proposal.json"].join("\n");
    const escalation = ["diff --git a/lead-escalation.json b/lead-escalation.json", "+++ b/lead-escalation.json"].join("\n");
    // An untouched candidate: nothing to admit, nothing refused.
    expect(leadCompletionEvidence({ manifest: manifest(""), proposal: null, escalation: null, managementTurn: true }))
      .toMatchObject({ validated: true, reasons: [] });
    expect(leadCompletionEvidence({ manifest: manifest(escalation), proposal: null,
      escalation: { optionCount: 2 }, managementTurn: true })).toMatchObject({ validated: true, reasons: [] });
    // An escalation the boundary refused is not a decision the owner can answer.
    expect(leadCompletionEvidence({ manifest: manifest(escalation), proposal: null, escalation: null, managementTurn: true }).reasons)
      .toEqual(["The lead's escalation is missing or unreadable"]);
    // A proposal the boundary refuses is the manager's to refuse, not invalid evidence: the lead
    // has to be told why and given the next turn, and a failed task would spend a retry on it
    // without ever saying why. This is the live acceptance run's stall.
    expect(leadCompletionEvidence({ manifest: manifest(proposal), proposal: null, escalation: null, managementTurn: true }))
      .toMatchObject({ validated: true, reasons: [] });
    // Everything but the two management files is still outside what a lead may write.
    const extra = [proposal, "diff --git a/src/a.ts b/src/a.ts", "+++ b/src/a.ts"].join("\n");
    expect(leadCompletionEvidence({ manifest: manifest(extra), proposal: { taskCount: 1 }, escalation: null, managementTurn: true }))
      .toMatchObject({ validated: false, outsideAssignment: ["src/a.ts"] });
    // Without the manager rule, C3's rule is exactly what it was.
    expect(leadCompletionEvidence({ manifest: manifest(escalation), proposal: null }).validated).toBe(false);
  });

  it.each([
    ["docs/plans/lead-roster.json", true, true],
    ["lead-roster.json", true, false],
    ["other/lead-roster.json", true, false],
    ["docs/plans/lead-roster.json.bak", true, false],
    ["docs/plans/lead-roster.json", false, false],
  ] as const)("bounds the management roster path %s (management %s)", (path, managementTurn, validated) => {
    const patch = ["diff --git a/" + path + " b/" + path, "+++ b/" + path].join("\n");
    const result = leadCompletionEvidence({ manifest: manifest(patch), proposal: { taskCount: 1 },
      managementTurn, planRef: "docs/plans/plan.md" });
    expect(result.validated).toBe(validated);
    expect(result.outsideAssignment).toEqual(validated ? [] : [path]);
  });

  it("treats a process whose start time moved as a different process, and an unreadable one as alive", () => {
    // The test's own process is alive under its recorded start; a moved start time is not it.
    const self = process.pid, stat = execFileSync("cat", ["/proc/" + self + "/stat"], { encoding: "utf8" });
    const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]!;
    expect(processIdentityAlive({ processId: self, processStart: start })).toBe(true);
    expect(processIdentityAlive({ processId: self, processStart: "not-the-start" })).toBe(false);
    // A pid that never existed is an end; a /proc that cannot be read at all is not.
    expect(processIdentityAlive({ processId: 2 ** 22 + 12345, processStart: "x" })).toBe(false);
  });
});
