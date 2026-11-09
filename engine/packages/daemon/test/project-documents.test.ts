import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBytes } from "../src/domain/plan-governance.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { createTestApp } from "./helpers/test-app.js";

import { saveTeamModelSettings } from "../src/domain/team-model-policy.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { documentPaths, documentDispatchRefusal, documentInstructions, approvalDocumentPins } from "../src/domain/project-documents.js";
import { appendChatMessage, composeLeadTurnEnd, leadChatTurnNote, responseLanguageNote, recordLeadReply, takeOwnerMessages } from "../src/domain/lead-chat.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { composeAttemptCompletion } from "../src/domain/attempt-completion.js";
import { leadActivation } from "../src/domain/lead-proposal.js";
import { parseLeadRoster } from "../src/domain/lead-roster.js";
import { commitPlan } from "../src/domain/plan-branch.js";
import { canonicalJson, type ProjectDocumentKind, type ProjectDocumentVersion, type ProjectDocumentWorkflow } from "../src/contracts/team-control.js";

const token = "document-owner-fixture";
const policy = unisolatedPolicyCapability(4);

describe("project document workflow", () => {
  let root: string, db: Database.Database, governance: PlanGovernance;
  let app: ReturnType<typeof createTestApp>["app"];
  let runtime: { documentsFor: (runId: string, taskId: string, planRef: string) => ReturnType<WorkflowRuntime["documentsFor"]> };
  let serial = 0;
  const dispatch = vi.fn(async () => {});
  const command = (runId: string, payload: unknown) => ({ protocolVersion: "1.0", runId,
    actionId: `action-${++serial}`, idempotencyKey: `key-${serial}`,
    expectedEntityVersion: governance.getRun(runId).entityVersion, payload });
  const state = (runId: string) => governance.documents(runId)!;
  const latest = (runId: string, kind: ProjectDocumentKind) => state(runId).versions.find(v => v.kind === kind)!;
  const put = (path: string, content: string) => {
    const destination = join(root, "candidate", path); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, content);
  };
  const start = async (documentWorkflow = true) => {
    const response = await call("/runs", { rig: "rig", goal: "Explore a greeting feature", planning: true, documentWorkflow });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json() as { runId: string }).runId;
  };
  const finish = async (runId: string, updates: Partial<Record<ProjectDocumentKind, string>>, id = `turn-${++serial}`, queuedBody?: string) => {
    const run = governance.getRun(runId), paths = documentPaths(run.binding.planRef);
    for (const [kind, content] of Object.entries(updates)) put(paths[kind as ProjectDocumentKind], content);
    takeOwnerMessages(db, runId, id);
    if (queuedBody) appendChatMessage(db, { id: `queued-${id}`, runId, body: queuedBody, createdAt: new Date().toISOString() });
    const output = agentTurnOutputPaths(join(root, "turns"), id);
    mkdirSync(output.directory, { recursive: true }); writeFileSync(output.lastMessage, "Saved the requested discussion document.");
    await composeLeadTurnEnd({ db, governance, turnStateRoot: join(root, "turns"), dispatch: () => dispatch,
      captureDocuments: attempt => governance.captureLeadDocuments(runId, attempt.id, runtime.documentsFor(runId, "task-1", run.binding.planRef)),
      readEscalation: (id, taskId) => WorkflowRuntime.prototype.leadEscalationFor.call({
        candidateFor: () => ({ root: join(root, "candidate") }),
      } as unknown as WorkflowRuntime, id, taskId),
    })({ id, runId, role: "lead", qitemId: governance.leadTask(runId)!.qitemId });
  };
  const stage = (runId: string, stage: string) => call(`/runs/${runId}/documents/stage`, command(runId, { stage }));
  const confirm = (runId: string, version: ProjectDocumentVersion) => call(`/runs/${runId}/documents/confirm`,
    command(runId, { kind: version.kind, versionId: version.id, hash: version.hash }));
  const ready = async () => {
    const runId = await start();
    await finish(runId, { brainstorm: "# Idea\nA small greeting function.\n## Trade-offs\nKeep it dependency-free.\n## Open questions\nNone." });
    expect((await stage(runId, "requirements")).status).toBe(200);
    await finish(runId, { requirements: "# Requirements\nR1: Greet a trimmed name.\n## Acceptance examples\nAda gives Hello, Ada!" });
    expect((await confirm(runId, latest(runId, "requirements"))).status).toBe(200);
    expect((await stage(runId, "plan")).status).toBe(200);
    put("lead-roster.json", JSON.stringify({ seats: [{ role: "implementer", client: "codex" }, { role: "reviewer", client: "codex" }] }));
    await finish(runId, { plan: "# Plan\nR1: Implement src/greet.mjs, then test src/greet.test.mjs.\n## Verification\nnode --test src/greet.test.mjs" });
    expect((await confirm(runId, latest(runId, "plan"))).status).toBe(200);
    return runId;
  };
  const approve = (runId: string, pins = approvalDocumentPins(state(runId))) => call(`/runs/${runId}/plan/approve`, command(runId, {
    documentVersions: pins, rosterDigest: hashBytes(readFileSync(join(root, "candidate/lead-roster.json"), "utf8")),
  }));
  const call = (path: string, body?: unknown, credential = token) => app.request(`/api/team-control${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  beforeEach(() => {
    serial = 0;
    root = mkdtempSync(join(tmpdir(), "project-documents-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Project fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    db = createDb(join(root, "state.sqlite")); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'documents')").run();
    for (const role of ["lead", "implementer", "reviewer"]) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, 'rig', ?, ?, 'codex', ?)").run(role, role, role, repo);
      db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run(role, role, `${role}@documents`);
    }
    const events = new EventBus(db), queue = new QueueRepository(db, events);
    governance = new PlanGovernance(db, events, queue, undefined, () => policy);
    dispatch.mockClear();
    mkdirSync(join(root, "candidate"));
    runtime = {
      documentsFor: (runId, taskId, planRef) => WorkflowRuntime.prototype.documentsFor.call({ candidateFor: () => ({ root: join(root, "candidate") }) } as unknown as WorkflowRuntime,
        runId, taskId, planRef),
    };
    const reader = { ...runtime,
      planFor: (_runId: string, _taskId: string, path: string) => { const content = readFileSync(join(root, "candidate", path), "utf8"); return { content, hash: hashBytes(content) }; },
      rosterFor: () => { const content = readFileSync(join(root, "candidate/lead-roster.json"), "utf8"); return { seats: parseLeadRoster(JSON.parse(content)), digest: hashBytes(content) }; },
    };
    app = createTestApp(db, { appDeps: { eventBus: events, queueRepo: queue, teamGovernance: governance, workflowRuntime: reader as never,
      teamControl: { credentials: { ownerToken: token, workers: [{ token: "document-worker", sessionId: "lead@documents", runId: "other" }] },
        readPolicyCapability: () => policy, planWorktreeRoot: () => join(root, "plans"), dispatch },
    } }).app;
  });
  afterEach(() => { if (db?.open) db.close(); rmSync(root, { recursive: true, force: true }); });

  it("creates a durable exploration record but no execution tasks or invented documents", async () => {
    const response = await call("/runs", { rig: "rig", goal: "Explore a greeting feature", planning: true, documentWorkflow: true });
    expect(response.status, await response.clone().text()).toBe(201);
    const { runId } = await response.json() as { runId: string };
    const result = await call(`/runs/${runId}/documents`);
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toMatchObject({ runId, workflow: { stage: "exploration", versions: [], executionVersions: null } });
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority WHERE json_extract(assignment_json, '$.role') <> 'lead'").get()).toEqual({ n: 0 });
    expect((await call(`/runs/${runId}/documents`, undefined, "document-worker")).status).toBe(403);
  });

  it("keeps legacy records readable without fabricating document history", async () => {
    const runId = await start(false);
    expect((await (await call(`/runs/${runId}/documents`)).json() as { workflow: unknown }).workflow).toBeNull();
  });

  it("requires current requirements confirmation before planning, with no implicit approval", async () => {
    const runId = await start();
    await finish(runId, {});
    const before = dispatch.mock.calls.length;
    expect((await stage(runId, "plan")).status).toBe(409);
    expect(dispatch.mock.calls.length).toBe(before);
    expect(state(runId).stage).toBe("exploration");
    expect(governance.getRun(runId).phase).toBe("planning");
  });

  it("captures a lead turn before dispatching its queued continuation and is idempotent", async () => {
    const runId = await start();
    dispatch.mockClear();
    dispatch.mockImplementationOnce(async () => {
      expect(latest(runId, "brainstorm").content).toContain("trim input?");
      expect(governance.chatMessages(runId).at(-1)?.sender).toBe("lead");
    });
    await finish(runId, { brainstorm: "# Idea\nOpen question: trim input?" }, "first-turn", "Yes, trim it.");
    expect(dispatch).toHaveBeenCalledWith(runId, "task-1");
    const version = latest(runId, "brainstorm");
    governance.captureLeadDocuments(runId, "first-turn", runtime.documentsFor(runId, "task-1", "plan.md"));
    expect(state(runId).versions).toHaveLength(1);
    expect(latest(runId, "brainstorm").id).toBe(version.id);
    expect(governance.chatMessages(runId).at(-1)?.sender).toBe("lead");
  });

  it.each(["before", "after"] as const)("keeps the exact document snapshot across interruption %s the durable stop", async edge => {
    const runId = await start(), attemptId = `interrupted-${edge}`;
    const run = governance.getRun(runId), lead = governance.leadTask(runId)!;
    const unavailable = { value: null, reason: "Fixture usage is unavailable" };
    const admitted = governance.recordAttempt({ ...command(runId, {
      qitemId: lead.qitemId, role: "lead", provider: "codex", state: "running", unknownReason: null,
      identity: { nativeSessionId: attemptId, tmuxServer: "/tmp/fixture.sock", paneId: "%1", processId: 123,
        processStart: "fixture-start", generation: 1, policyFingerprint: run.binding.policyFingerprint },
      usage: { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable },
    }), actionId: attemptId }, run.binding);
    expect(admitted.status, JSON.stringify(admitted)).toBe("observed");
    const path = documentPaths(run.binding.planRef).brainstorm;
    put(path, "# Original discussion\nKeep this turn's choices.");
    const capture = (attempt: { id: string }) => governance.captureLeadDocuments(runId, attempt.id,
      runtime.documentsFor(runId, lead.taskId, run.binding.planRef));
    const observe = () => composeAttemptCompletion({ db, governance, currentBinding: () => governance.getRun(runId).binding,
      alive: () => false, log: () => {}, sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() },
      captureTurnDocuments: capture, onAttemptStopped: async attempt => { capture(attempt); },
    });
    const record = governance.recordUsage.bind(governance);
    vi.spyOn(governance, "recordUsage").mockImplementationOnce(request => {
      if (edge === "after") record(request);
      throw new Error("Interrupted at the durable stop boundary");
    });
    await observe().sweep();
    expect(governance.getAttempt(attemptId)?.state).toBe(edge === "after" ? "stopped" : "running");
    db.close(); db = createDb(join(root, "state.sqlite")); migrate(db, ALL_MIGRATIONS);
    const events = new EventBus(db);
    governance = new PlanGovernance(db, events, new QueueRepository(db, events), undefined, () => policy);
    put(path, "# Later mutable bytes\nThese do not belong to the interrupted turn.");
    await observe().sweep();
    await observe().sweep();
    expect(governance.getAttempt(attemptId)?.state).toBe("stopped");
    expect(state(runId).versions).toEqual([expect.objectContaining({ kind: "brainstorm", version: 1,
      sourceAttemptId: attemptId, content: "# Original discussion\nKeep this turn's choices." })]);
    expect(db.prepare("SELECT count(*) AS n FROM team_document_captures WHERE run_id = ?").get(runId)).toEqual({ n: 1 });
    expect(state(runId).executionVersions).toBeNull();
  });

  it("leaves document capture retryable without dispatch when storage is interrupted", async () => {
    const runId = await start(), run = governance.getRun(runId), lead = governance.leadTask(runId)!;
    const unavailable = { value: null, reason: "Fixture usage is unavailable" };
    const admitted = governance.recordAttempt({ ...command(runId, {
      qitemId: lead.qitemId, role: "lead", provider: "codex", state: "running", unknownReason: null,
      identity: { nativeSessionId: "retry-capture", tmuxServer: "/tmp/fixture.sock", paneId: "%1", processId: 123,
        processStart: "fixture-start", generation: 1, policyFingerprint: run.binding.policyFingerprint },
      usage: { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable },
    }), actionId: "retry-capture" }, run.binding);
    expect(admitted.status, JSON.stringify(admitted)).toBe("observed");
    put(documentPaths(run.binding.planRef).brainstorm, "# Durable discussion");
    const capture = vi.fn((attempt: { id: string }) => governance.captureLeadDocuments(runId, attempt.id,
      runtime.documentsFor(runId, lead.taskId, run.binding.planRef)))
      .mockImplementationOnce(() => { throw new Error("Snapshot storage interrupted"); });
    let alive = true;
    dispatch.mockClear();
    const observe = composeAttemptCompletion({ db, governance, currentBinding: () => governance.getRun(runId).binding,
      alive: () => alive, log: () => {}, sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() },
      captureTurnDocuments: capture, onAttemptStopped: async attempt => { capture(attempt); }, dispatchPending: dispatch,
    });
    await observe.sweep();
    expect(capture).not.toHaveBeenCalled();
    alive = false;
    await observe.sweep();
    expect(governance.getAttempt("retry-capture")?.state).toBe("running");
    expect(state(runId).versions).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    await observe.sweep();
    expect(governance.getAttempt("retry-capture")?.state).toBe("stopped");
    expect(state(runId).versions).toHaveLength(1);
    expect(state(runId).executionVersions).toBeNull();
  });

  it("binds execution and admitted tasks to the confirmed document versions", async () => {
    const runId = await ready();
    const requirements = latest(runId, "requirements"), plan = latest(runId, "plan");
    expect(plan.requirementsVersionId).toBe(requirements.id);
    const response = await approve(runId);
    expect(response.status, await response.clone().text()).toBe(200);
    const run = governance.getRun(runId);
    expect(run.phase).toBe("delivery");
    expect(run.binding.documentVersions?.requirements.versionId).toBe(requirements.id);
    expect(readFileSync(join(run.binding.repository.root, requirements.path), "utf8")).toBe(requirements.content);
    const request = command(runId, { assignment: { taskId: "implementation", role: "implementer", paths: ["src/greet.mjs"], dependencies: [] },
      outputs: [], permissions: [...roleConfiguration.implementer.permissions], sourceSession: "owner", destinationSession: "implementer@documents", body: "Implement R1" });
    request.actionId = "implementation";
    const receipt = governance.createTask(request, run.binding);
    expect(receipt.status, JSON.stringify(receipt)).toBe("accepted");
    expect(db.prepare("SELECT document_versions_json AS pins FROM team_queue_authority WHERE run_id = ? AND task_id = 'implementation'").get(runId))
      .toEqual({ pins: canonicalJson(run.binding.documentVersions) });
    expect(documentDispatchRefusal(db, run, "implementer", "implementation", run.binding)).toBeNull();
  });

  it("admits project-wide application paths only after the exact document approval", async () => {
    const runId = await ready();
    const planning = governance.getRun(runId);
    expect(planning.binding.readPaths).toContain(".");
    expect(planning.binding.writePaths).not.toContain(".");
    expect(planning.binding.documentVersions).toBeUndefined();
    const response = await approve(runId);
    expect(response.status, await response.clone().text()).toBe(200);
    const approved = governance.getRun(runId);
    const paths = ["package.json", "server", "client", "index.html"];
    const result = governance.admitLeadProposal(command(runId, {}),
      { kind: "daemon", sessionId: "lead-manager" }, approved.binding,
      [{ taskId: "application", seat: "implementer@documents", paths, dependencies: [], body: "Implement the approved application." }]);
    expect(result.status, result.reason).toBe("accepted");
    expect(governance.findTask(runId, "application")?.assignment.paths).toEqual(paths);
    expect(documentDispatchRefusal(db, approved, "implementer", "application", approved.binding)).toBeNull();
    expect(approved.binding.documentVersions).toEqual(approvalDocumentPins(state(runId)));
    expect(approved.binding.limits).toEqual(planning.binding.limits);
  });

  it("retains content, versions and confirmations after reopening the database", async () => {
    const runId = await ready();
    const before = state(runId);
    db.close(); db = createDb(join(root, "state.sqlite")); migrate(db, ALL_MIGRATIONS);
    const events = new EventBus(db);
    governance = new PlanGovernance(db, events, new QueueRepository(db, events), undefined, () => policy);
    expect(state(runId)).toEqual(before);
  });

  it("rejects stale displayed versions and source edits before committing an approval", async () => {
    const runId = await ready();
    const old = latest(runId, "requirements");
    expect((await stage(runId, "requirements")).status).toBe(200);
    await finish(runId, { requirements: old.content + "\nR2: Reject non-string input." });
    expect((await confirm(runId, old)).status).toBe(409);
    expect(state(runId).confirmed.requirements).toBeNull();
    expect(state(runId).confirmed.plan).toBeNull();
    expect((await confirm(runId, latest(runId, "requirements"))).status).toBe(200);
    expect((await confirm(runId, latest(runId, "plan"))).status).toBe(409);
    const run = governance.getRun(runId), head = execFileSync("git", ["-C", run.binding.repository.root, "rev-parse", "HEAD"], { encoding: "utf8" });
    expect((await call(`/runs/${runId}/plan/approve`, command(runId, {}))).status).toBe(409);
    expect(execFileSync("git", ["-C", run.binding.repository.root, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(head);
  });

  it("rejects confirmation while an owner message is queued and after an unrecorded source edit", async () => {
    const runId = await ready(), version = latest(runId, "plan");
    const sent = await call(`/runs/${runId}/chat`, command(runId, { body: "Please revise the checks." }));
    expect(sent.status).toBe(200);
    expect((await confirm(runId, version)).status).toBe(409);
    takeOwnerMessages(db, runId, "queued-turn");
    put(version.path, version.content + "\nUnrecorded change.");
    expect((await confirm(runId, version)).status).toBe(409);
    expect((await approve(runId)).status).toBe(409);
  });

  it("preserves the approved versions while suspending an active execution revision", async () => {
    const runId = await ready(); expect((await approve(runId)).status).toBe(200);
    const before = governance.getRun(runId).binding;
    db.prepare("INSERT INTO team_attempts (id, run_id, role, provider, state, active_ms, usage_json, identity_json, created_at, updated_at) VALUES ('active', ?, 'implementer', 'codex', 'running', 0, ?, ?, datetime('now'), datetime('now'))")
      .run(runId, JSON.stringify({ activeMs: 0, inputTokens: { value: null, reason: "unknown" }, outputTokens: { value: null, reason: "unknown" }, costUsd: { value: null, reason: "unknown" } }), JSON.stringify({ nativeSessionId: "fixture-session", tmuxServer: "fixture", paneId: "%1",
        processId: 123, processStart: "456", generation: 1, policyFingerprint: policy.policyFingerprint }));
    expect((await stage(runId, "requirements")).status).toBe(202);
    expect(governance.getRun(runId).state).toBe("blocked");
    expect(governance.getRun(runId).binding).toEqual(before);
    expect(documentDispatchRefusal(db, governance.getRun(runId), "implementer")).toMatch(/revision.*pending/i);
    expect(governance.ownerCommand("resume", { ...command(runId, {}), actionId: runId }, { kind: "owner", sessionId: "owner" }, before).status).toBe("denied");
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'active'").run();
    expect((await stage(runId, "requirements")).status).toBe(200);
    expect(governance.getRun(runId).phase).toBe("planning");
    expect(state(runId).confirmed.plan).toBeNull();
    expect(documentDispatchRefusal(db, governance.getRun(runId), "implementer")).toMatch(/waits/);
  });

  it("stops dispatch when the committed requirements are changed or unreadable", async () => {
    const runId = await ready(); expect((await approve(runId)).status).toBe(200);
    const run = governance.getRun(runId), path = join(run.binding.repository.root, latest(runId, "requirements").path);
    writeFileSync(path, "An unapproved requirements change");
    expect(documentDispatchRefusal(db, run, "lead")).toMatch(/source changed/);
    rmSync(path); symlinkSync(join(root, "repo/README.md"), path);
    expect(documentDispatchRefusal(db, run, "lead")).toMatch(/unreadable/);
  });

  it("uses the existing bounded reader for missing, linked and oversized candidate documents", async () => {
    const runId = await start();
    expect(runtime.documentsFor(runId, "task-1", "plan.md")).toEqual({});
    const path = documentPaths("plan.md").requirements;
    put(path, "x".repeat(262145));
    expect(() => runtime.documentsFor(runId, "task-1", "plan.md")).toThrow(/limit/);
    rmSync(join(root, "candidate", path)); symlinkSync(join(root, "repo/README.md"), join(root, "candidate", path));
    expect(() => runtime.documentsFor(runId, "task-1", "plan.md")).toThrow();
  });

  it("does not follow a repository link when publishing confirmed documents", async () => {
    const destination = join(root, "repo/planning-docs");
    symlinkSync(join(root, "candidate"), destination);
    expect(() => commitPlan({ worktree: join(root, "repo"), planRef: "plan.md", plan: "Plan", message: "Plan",
      documents: [{ path: "planning-docs/requirements.md", content: "Requirements" }] })).toThrow(/symbolic link/);
    expect(() => readFileSync(join(root, "candidate/requirements.md"))).toThrow();
  });

  it("rejects a dangling document symlink before publishing any files", () => {
    const external = join(root, "not-a-project-document.md");
    mkdirSync(join(root, "repo/planning-docs"));
    symlinkSync(external, join(root, "repo/planning-docs/requirements.md"));
    expect(() => commitPlan({ worktree: join(root, "repo"), planRef: "plan.md", plan: "Plan", message: "Plan",
      documents: [{ path: "planning-docs/requirements.md", content: "Requirements" }] })).toThrow(/symbolic link/);
    expect(() => readFileSync(external)).toThrow();
    expect(() => readFileSync(join(root, "repo/plan.md"))).toThrow();
  });

  it("rejects binding drift before changing the published plan or repository head", async () => {
    const runId = await ready(), run = governance.getRun(runId);
    const head = execFileSync("git", ["-C", run.binding.repository.root, "rev-parse", "HEAD"], { encoding: "utf8" });
    const changed = "Owner changed the source plan outside this approval.";
    writeFileSync(join(run.binding.repository.root, run.binding.planRef), changed);
    const response = await approve(runId);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(execFileSync("git", ["-C", run.binding.repository.root, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(head);
    expect(readFileSync(join(run.binding.repository.root, run.binding.planRef), "utf8")).toBe(changed);
  });

  it("preserves optional draft brainstorm bytes for the delivery lead without approving them", async () => {
    const runId = await ready(), brainstorm = latest(runId, "brainstorm");
    expect(state(runId).confirmed.brainstorm).toBeNull();
    expect((await approve(runId)).status).toBe(200);
    const run = governance.getRun(runId);
    expect(run.binding.documentVersions?.brainstorm).toBeUndefined();
    expect(readFileSync(join(run.binding.repository.root, brainstorm.path), "utf8")).toBe(brainstorm.content);
    for (const kind of ["brainstorm", "requirements", "plan"] as const) {
      const version = latest(runId, kind);
      put(version.path, readFileSync(join(run.binding.repository.root, version.path), "utf8"));
    }
    await finish(runId, {}, "delivery-turn");
    expect(state(runId).error).toBeNull();
    expect(governance.getRun(runId).state).toBe("approved");
  });

  it.each(["Active wall-clock budget exhausted", "Provider capability is not verified", "The lead's task failed"])(
    "keeps an unrelated stop when selecting a document stage: %s", async reason => {
      const runId = await start(); await finish(runId, {});
      db.prepare("UPDATE team_runs SET state = 'blocked', state_reason = ? WHERE id = ?").run(reason, runId);
      db.prepare("UPDATE team_approvals SET state = 'invalidated' WHERE run_id = ?").run(runId);
      dispatch.mockClear();
      const response = await stage(runId, "requirements");
      expect(response.status, await response.clone().text()).toBe(409);
      expect(governance.getRun(runId)).toMatchObject({ state: "blocked", stateReason: reason });
      expect(state(runId).stage).toBe("exploration");
      expect(dispatch).not.toHaveBeenCalled();
    });

  it("supersedes failed tasks and preserves execution history when revised documents are approved", async () => {
    const runId = await ready(); expect((await approve(runId)).status).toBe(200);
    const before = governance.getRun(runId), firstPins = before.binding.documentVersions;
    const request = command(runId, { assignment: { taskId: "old-implementation", role: "implementer", paths: ["src/greet.mjs"], dependencies: [] },
      outputs: [], permissions: [...roleConfiguration.implementer.permissions], sourceSession: "owner", destinationSession: "implementer@documents", body: "Implement R1" });
    request.actionId = "old-implementation";
    expect(governance.createTask(request, before.binding).status).toBe("accepted");
    const oldTask = governance.findTask(runId, "old-implementation")!;
    db.prepare("UPDATE queue_items SET state = 'failed' WHERE qitem_id = ?").run(oldTask.qitemId);
    expect((await stage(runId, "requirements")).status).toBe(200);
    expect(governance.queueState(oldTask.qitemId)).toBe("canceled");
    expect(state(runId).executionHistory[0]?.versions).toEqual(firstPins);
    await finish(runId, { requirements: latest(runId, "requirements").content + "\nR2: Reject non-strings." });
    expect((await confirm(runId, latest(runId, "requirements"))).status).toBe(200);
    expect((await stage(runId, "plan")).status).toBe(200);
    await finish(runId, { plan: latest(runId, "plan").content + "\nTest R2 before completion." });
    expect((await confirm(runId, latest(runId, "plan"))).status).toBe(200);
    expect((await approve(runId)).status).toBe(200);
    const after = governance.getRun(runId);
    expect(state(runId).executionHistory.map(event => event.versions)).toEqual([after.binding.documentVersions, firstPins]);
    expect(documentDispatchRefusal(db, after, "implementer", "old-implementation", after.binding)).toMatch(/superseded/);
  });

  it("retains a document-control language choice without creating a chat message", async () => {
    const runId = await ready(), version = latest(runId, "plan");
    appendChatMessage(db, { id: "previous-language", runId, body: "Confirmed the previous version.", kind: "confirmation",
      createdAt: new Date().toISOString(), responseLanguage: "en" });
    const count = governance.chatMessages(runId).length;
    const response = await call(`/runs/${runId}/documents/confirm`, command(runId, {
      kind: "plan", versionId: version.id, hash: version.hash, responseLanguage: "zh-CN",
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(governance.chatMessages(runId)).toHaveLength(count);
    expect(db.prepare("SELECT response_language AS language FROM team_runs WHERE id = ?").get(runId))
      .toEqual({ language: "zh-CN" });
    expect(responseLanguageNote(governance.chatMessages(runId), "zh-CN")).toContain("Simplified Chinese (zh-CN)");
  });

  it("records a conversation confirmation atomically without queuing another lead turn", async () => {
    const runId = await ready(), version = latest(runId, "plan");
    dispatch.mockClear();
    const request = command(runId, { kind: "plan", versionId: version.id, hash: version.hash, ownerMessage: "确认计划" });
    const response = await call(`/runs/${runId}/documents/confirm`, request);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(governance.chatMessages(runId).at(-1)).toMatchObject({ sender: "owner", kind: "confirmation", body: "确认计划" });
    expect(governance.planningApprovalPending(runId)).toBe(false);
    expect(takeOwnerMessages(db, runId, "later-turn")).toEqual([]);
    expect(governance.getRun(runId).phase).toBe("planning");
    expect(dispatch).not.toHaveBeenCalled();
    expect((await call(`/runs/${runId}/documents/confirm`, request)).status).toBe(200);
    expect(governance.chatMessages(runId).filter(message => message.body === "确认计划")).toHaveLength(1);
    expect((await stage(runId, "plan")).status).toBe(200);
  });

  it("binds a conversation execution approval to the displayed plan and roster", async () => {
    const runId = await ready(), plan = latest(runId, "plan");
    const request = command(runId, { documentVersions: approvalDocumentPins(state(runId)), planHash: plan.hash,
      rosterDigest: hashBytes(readFileSync(join(root, "candidate/lead-roster.json"), "utf8")), ownerMessage: "批准执行" });
    const response = await call(`/runs/${runId}/plan/approve`, request);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(governance.getRun(runId).phase).toBe("delivery");
    expect(governance.chatMessages(runId).at(-1)).toMatchObject({ sender: "owner", kind: "confirmation", body: "批准执行" });
  });

  it("rejects a stale displayed plan hash from conversation before publishing", async () => {
    const runId = await ready(), run = governance.getRun(runId);
    const before = execFileSync("git", ["-C", run.binding.repository.root, "rev-parse", "HEAD"], { encoding: "utf8" });
    const request = command(runId, { documentVersions: approvalDocumentPins(state(runId)), planHash: "sha256:" + "0".repeat(64),
      rosterDigest: hashBytes(readFileSync(join(root, "candidate/lead-roster.json"), "utf8")), ownerMessage: "批准执行" });
    const response = await call(`/runs/${runId}/plan/approve`, request);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(execFileSync("git", ["-C", run.binding.repository.root, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(before);
    expect(governance.chatMessages(runId).some(message => message.body === "批准执行")).toBe(false);
  });

  it("still requires the displayed plan hash for a document-governed conversation approval", async () => {
    const runId = await ready();
    const response = await call(`/runs/${runId}/plan/approve`, command(runId, {
      documentVersions: approvalDocumentPins(state(runId)),
      rosterDigest: hashBytes(readFileSync(join(root, "candidate/lead-roster.json"), "utf8")), ownerMessage: "Approve execution",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "plan_changed" });
    expect(governance.getRun(runId).phase).toBe("planning");
    expect(governance.chatMessages(runId).some(message => message.body === "Approve execution")).toBe(false);
  });

  it("keeps successive planning questions and answers in context without starting execution", async () => {
    const runId = await start();
    const activation = leadActivation(db, { runId, rigId: "rig", roles: ["lead", "implementer", "reviewer"],
      seat: "lead@documents", goal: "Explore a greeting feature", activationId: "exploration", phase: "planning", planRef: "plan.md" });
    expect(activation.instructions).toContain("lead-escalation.json");
    expect(activation.instructions).toContain('"options"');
    expect(activation.instructions).toContain("End the turn and wait");
    put("lead-escalation.json", JSON.stringify({ question: "How should invalid input behave?",
      options: ["Throw TypeError", "Convert to text"], context: "Throwing makes caller mistakes visible." }));
    await finish(runId, {}, "question-one");
    let conversation = await (await call(`/runs/${runId}/chat`)).json() as { pendingDecision: { id: string; options: string[] } | null };
    expect(conversation.pendingDecision).toMatchObject({ id: "chat-question-one", options: ["Throw TypeError", "Convert to text"] });
    expect((await call(`/runs/${runId}/chat`, command(runId, { body: "Throw TypeError, including null.", answerTo: conversation.pendingDecision!.id }))).status).toBe(200);
    const prompt = leadChatTurnNote(takeOwnerMessages(db, runId, "answer-one"), governance.chatMessages(runId));
    expect(prompt).toContain("How should invalid input behave?");
    expect(prompt).toContain("Throw TypeError, including null.");
    put("lead-escalation.json", JSON.stringify({ question: "What about empty names?", options: ["Greet world", "Throw TypeError"] }));
    await finish(runId, {}, "answer-one");
    conversation = await (await call(`/runs/${runId}/chat`)).json() as typeof conversation;
    expect(conversation.pendingDecision?.id).toBe("chat-answer-one");
    expect((await call(`/runs/${runId}/chat`, command(runId, { body: "Greet world", answerTo: conversation.pendingDecision!.id }))).status).toBe(200);
    await finish(runId, { brainstorm: "# Decisions\nThrow on invalid input; greet world for empty names." }, "answer-two");
    expect(governance.chatDecision(runId)).toBeNull();
    expect(governance.chatMessages(runId).filter(message => message.kind === "decision")).toHaveLength(2);
    expect(latest(runId, "brainstorm").content).toContain("Throw on invalid input");
    expect(governance.getRun(runId).phase).toBe("planning");
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority WHERE json_extract(assignment_json, '$.role') <> 'lead'").get()).toEqual({ n: 0 });
  });

  it("retains the owner's stage request and rejects version confirmation while a question is unanswered", async () => {
    const runId = await ready();
    recordLeadReply(db, { id: "question-pending", runId, attemptId: "question-check", body: "Which edge case?",
      decision: { options: ["A", "B"] }, createdAt: new Date().toISOString() });
    expect((await confirm(runId, latest(runId, "plan"))).status).toBe(409);
    expect((await stage(runId, "requirements")).status).toBe(409);
    await call(`/runs/${runId}/chat`, command(runId, { body: "A", answerTo: "question-pending" }));
    await finish(runId, {}, "resolved-question");
    const response = await call(`/runs/${runId}/documents/stage`, command(runId, { stage: "requirements", ownerMessage: "整理需求" }));
    expect(response.status).toBe(200);
    expect(takeOwnerMessages(db, runId, "requirements-followup").map(message => message.body)).toEqual(["整理需求"]);
  });

  it("gives each lead stage its own output and evidence contract", async () => {
    const runId = await ready(), current = state(runId);
    const exploration = documentInstructions({ ...current, stage: "exploration" }, "plan.md");
    expect(exploration).toContain("Brainstorm is optional");
    expect(exploration).toContain("Prepare requirements");
    expect(exploration).toContain("Do not offer Generate plan yet");
    const requirements = documentInstructions({ ...current, stage: "requirements" }, "plan.md");
    expect(requirements).toContain("Acceptance examples");
    expect(requirements).toContain("Confirm requirements");
    expect(requirements).toContain("Generate plan");
    const plan = documentInstructions(current, "plan.md");
    expect(plan).toContain(latest(runId, "requirements").hash);
    expect(plan).toContain("only a plan");
    expect(plan).toContain("Confirm plan");
    expect(plan).toContain("Approve execution");
  });

  it("applies an owner-approved client switch to idle worker seats and clears their old continuations", async () => {
    const runId = await ready();
    saveTeamModelSettings(db, "rig", { kind: "test", lead: { client: "codex", model: "chosen-lead" },
      allowedSubagents: [{ client: "claude-code", model: "allowed-worker" }] });
    db.prepare("UPDATE sessions SET resume_type = 'codex_id', resume_token = 'old-worker-thread' WHERE node_id <> 'lead'").run();
    put("lead-roster.json", JSON.stringify({ seats: [{ role: "implementer", client: "claude-code", model: "allowed-worker" },
      { role: "reviewer", client: "claude-code", model: "allowed-worker" }] }));
    const response = await approve(runId);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(db.prepare("SELECT runtime, model FROM nodes WHERE role <> 'lead' ORDER BY role").all()).toEqual([
      { runtime: "claude-code", model: "allowed-worker" }, { runtime: "claude-code", model: "allowed-worker" },
    ]);
    expect(db.prepare("SELECT resume_token FROM sessions WHERE node_id <> 'lead'").all()).toEqual([{ resume_token: null }, { resume_token: null }]);
  });

});
