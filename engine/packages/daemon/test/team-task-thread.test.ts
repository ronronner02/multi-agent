import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { agentTurnOutputPaths, agentTurnPromptPath } from "../src/domain/agent-turn.js";
import { appendChatMessage, listChatMessages, pendingOwnerMessages } from "../src/domain/lead-chat.js";
import { composeTaskThreads, listTaskComments, ownerQuestionNotices, taskCommentNotices } from "../src/domain/task-thread.js";
import { leadTeamEvents } from "../src/domain/lead-manager.js";
import type { ControlRequest, PlanBinding } from "../src/contracts/team-control.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

/**
 * Plan R7–R10 — an owner comment on a task reaches that task's own agent, a comment on work that
 * already landed starts a linked follow-up, an agent hands back what is not its task, and a held
 * task waits for the owner.
 */

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const policy = unisolatedPolicyCapability(1);
const unobserved = { value: null, reason: "unobserved" };
const USAGE = JSON.stringify({ activeMs: 0, inputTokens: unobserved, outputTokens: unobserved, costUsd: unobserved });

describe("task threads", () => {
  let root: string, stateRoot: string, db: Database.Database, governance: PlanGovernance, binding: PlanBinding, serial = 0;
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: "1.0", runId: "run", actionId, payload,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `request-${++serial}`,
  });
  const comment = (id: string, taskId: string, body: string) => governance.postTaskComment(command(id, { taskId, body }), owner, binding);
  const queueState = (taskId: string) => governance.queueState(governance.findTask("run", taskId)!.qitemId);
  const setState = (taskId: string, state: string) =>
    db.prepare("UPDATE queue_items SET state = ? WHERE qitem_id = ?").run(state, governance.findTask("run", taskId)!.qitemId);
  const attempt = (id: string, taskId: string, state: "running" | "stopped", failed = false) => db.prepare(`INSERT INTO team_attempts
    (id, run_id, qitem_id, role, provider, state, identity_json, usage_json, active_ms, created_at, updated_at, failure_json)
    VALUES (?, 'run', ?, 'implementer', 'claude', ?, '{}', ?, 0, '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z', ?)`)
    .run(id, governance.findTask("run", taskId)!.qitemId, state, USAGE, failed ? JSON.stringify({ reasonCode: "agent_error.unknown" }) : null);

  /** Launch an implementer turn through the orchestrator without a client, and return its prompt. */
  async function prompt(taskId: string, attemptId: string): Promise<string> {
    const manifest = { runId: "run", assignment: { taskId, role: "implementer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], role: "implementer", client: "claude-code", root: "/context", mutableStateRoot: stateRoot,
      files: [], projection: { attemptId } } as unknown as ContextManifest;
    const orchestrator = new StartupOrchestrator({ db, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db) });
    const adapter = { project: async () => ({ failed: [] }), deliverStartup: async () => ({ failed: [] }) } as unknown as RuntimeAdapter;
    const started = await orchestrator.startNode({ rigId: "rig", nodeId: "a-node", sessionId: "s-a-node",
      binding: { id: "direct:a-node", nodeId: "a-node", attachmentType: "external_cli", tmuxSession: "a@rig", tmuxWindow: null,
        tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: root,
        managedAttempt: { attemptId, deadline: Date.now() + 60_000, context: manifest } },
      adapter, plan: { runtime: "claude-code", cwd: root, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "a@rig", runId: "run", taskId, skipHarnessLaunch: true });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    return readFileSync(agentTurnPromptPath(manifest), "utf8");
  }

  beforeEach(() => {
    serial = 0;
    root = mkdtempSync(join(tmpdir(), "task-thread-"));
    stateRoot = mkdtempSync(join(tmpdir(), "task-thread-state-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    binding = bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy });
    db = createDb(":memory:"); initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    for (const [nodeId, role, seat] of [["lead-node", "lead", "lead@rig"], ["a-node", "implementer", "a@rig"]] as const) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, 'rig', ?, ?, 'claude-code', ?)").run(nodeId, nodeId, role, root);
      db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run(`s-${nodeId}`, nodeId, seat);
    }
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-04T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("initial", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-05T00:00:00.000Z" }), owner);
    governance.decideApproval(command("initial", { approvalVersion: 1, decision: "approved" }), owner, binding);
    for (const [taskId, role, seat, body] of [["lead", "lead", "lead@rig", "Add dark mode."], ["impl", "implementer", "a@rig", "Implement the toggle."]] as const) {
      expect(governance.createTask(command(taskId, { assignment: { taskId, role, paths: ["src"], dependencies: [] }, outputs: [],
        permissions: role === "implementer" ? ["write-assigned-tree"] : [], sourceSession: role === "lead" ? "owner" : "lead@rig",
        destinationSession: seat, body }), binding).status).toBe("accepted");
    }
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true }); });

  it("delivers a comment to the task's next turn once, and keeps it out of the lead's chat", async () => {
    const receipt = comment("c1", "impl", "Use the existing theme hook.");
    expect(receipt).toMatchObject({ status: "accepted", effectMayStart: true, revisionTaskId: "impl" });
    expect(pendingOwnerMessages(db, "run")).toEqual([]);
    expect(listChatMessages(db, "run").map(message => message.id)).not.toContain("c1");
    const first = await prompt("impl", "impl-a1");
    expect(first).toContain("The owner commented on this task:");
    expect(first).toContain("Comment c1: Use the existing theme hook.");
    expect(first).toContain(JSON.stringify(join(stateRoot, "turns", "impl-a1", "report", "handback.json")));
    // A later successful attempt does not read it again.
    attempt("impl-a1", "impl", "stopped");
    expect(await prompt("impl", "impl-a2")).not.toContain("Comment c1");
    // The lead is told, as context, without a turn of its own.
    expect(taskCommentNotices(db, "run")).toContain("impl (delivered): Use the existing theme hook.");
  });

  it("gives a comment taken by a failed attempt to the next attempt", async () => {
    comment("c1", "impl", "Keep the API unchanged.");
    expect(await prompt("impl", "impl-a1")).toContain("Comment c1");
    attempt("impl-a1", "impl", "stopped", true);
    expect(await prompt("impl", "impl-a2")).toContain("Comment c1");
  });

  it("keeps a comment for a running turn and for a held task, and the owner's release starts it", () => {
    attempt("impl-a1", "impl", "running");
    expect(comment("c1", "impl", "Also cover the empty state.")).toMatchObject({ status: "accepted", value: { queued: true } });
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'impl-a1'").run();
    expect(governance.holdTask(command("h1", { taskId: "impl", held: true }), owner)).toMatchObject({ status: "accepted", value: { held: true } });
    expect(comment("c2", "impl", "Wait for my design.")).toMatchObject({ status: "accepted", value: { queued: true } });
    const released = governance.holdTask(command("h2", { taskId: "impl", held: false }), owner);
    expect(released).toMatchObject({ status: "accepted", effectMayStart: true, revisionTaskId: "impl" });
  });

  it("starts a linked follow-up for a comment on a task whose change already landed", async () => {
    setState("impl", "done");
    attempt("impl-a1", "impl", "stopped");
    mkdirSync(agentTurnOutputPaths(stateRoot, "impl-a1").directory, { recursive: true });
    writeFileSync(agentTurnOutputPaths(stateRoot, "impl-a1").lastMessage, "DONE: the toggle reads the theme hook.");
    db.prepare("INSERT INTO team_integration_commits (run_id, task_id, commit_sha, subject, committed_at) VALUES ('run', 'impl', ?, 'impl', '2026-11-04T00:00:00Z')")
      .run("a".repeat(40));
    const receipt = comment("c1", "impl", "Rename the setting to Appearance.");
    expect(receipt).toMatchObject({ status: "accepted", effectMayStart: true, revisionTaskId: "impl-followup-1",
      value: { followUpOf: "impl", taskId: "impl-followup-1" } });
    expect(queueState("impl")).toBe("done");
    expect(listTaskComments(db, "run", "impl-followup-1").map(row => row.id)).toEqual(["c1"]);
    const text = await prompt("impl-followup-1", "f-a1");
    expect(text).toContain("This task follows up task impl");
    expect(text).toContain("Its brief:\nImplement the toggle.");
    expect(text).toContain("Its final report:\nDONE: the toggle reads the theme hook.");
    expect(text).toContain("Comment c1: Rename the setting to Appearance.");
  });

  it("holds a comment on work under review, and starts the follow-up once the change lands", () => {
    setState("impl", "done");
    expect(comment("c1", "impl", "Shorten the label.")).toMatchObject({ status: "accepted", value: { queued: true } });
    expect(governance.promoteTaskComments("run")).toEqual([]);
    db.prepare("INSERT INTO team_integration_commits (run_id, task_id, commit_sha, subject, committed_at) VALUES ('run', 'impl', ?, 'impl', '2026-11-04T00:00:00Z')")
      .run("b".repeat(40));
    expect(governance.promoteTaskComments("run")).toEqual(["impl-followup-1"]);
    // The follow-up took the comment, so a second sweep starts nothing.
    expect(governance.promoteTaskComments("run")).toEqual([]);
  });

  it("hands a comment back to the lead as an owner message", async () => {
    comment("c1", "impl", "Also redo the billing page.");
    await prompt("impl", "impl-a1");
    attempt("impl-a1", "impl", "stopped");
    const report = join(stateRoot, "turns", "impl-a1", "report");
    mkdirSync(report, { recursive: true });
    writeFileSync(join(report, "handback.json"), JSON.stringify([{ messageId: "c1", reason: "Billing is outside this task's paths." }]));
    const started: string[] = [];
    const threads = composeTaskThreads({ db, governance, turnStateRoot: stateRoot, log: () => undefined,
      dispatch: () => async (_runId, taskId) => { started.push(taskId); } });
    await threads.attemptStopped({ id: "impl-a1", runId: "run", qitemId: governance.findTask("run", "impl")!.qitemId, role: "implementer" });
    expect(pendingOwnerMessages(db, "run").map(message => message.body)).toEqual(["Also redo the billing page."]);
    expect(listTaskComments(db, "run", "impl")).toEqual([]);
    expect(started).toEqual(["lead"]);
  });

  it("sends a worker's question to the owner, not the lead, and gives the lead a copy", () => {
    // Plan KTD4: a needs-decision question waits for the owner; the lead is not woken for it.
    const report = (status: string, question?: string) => db.prepare(`UPDATE team_queue_authority SET evidence_json = ? WHERE run_id = 'run' AND task_id = 'impl'`)
      .run(JSON.stringify({ taskReport: { status, evidence: "Both callers still exist.", ...(question ? { question } : {}) }, reportedAttemptId: "impl-a1" }));
    setState("impl", "blocked");
    report("needs-decision", "Keep the v1 endpoint or remove it?");
    expect(leadTeamEvents(db, "run").filter(event => event.key.startsWith("report:"))).toEqual([]);
    expect(ownerQuestionNotices(db, "run")).toContain("impl: Keep the v1 endpoint or remove it?");
    // A blocked report with no question is still the lead's to resolve.
    report("blocked");
    expect(leadTeamEvents(db, "run").map(event => event.key)).toContain("report:impl:impl-a1");
    expect(ownerQuestionNotices(db, "run")).toBeNull();
    // The owner's answer is a comment, which resumes the paused task.
    report("needs-decision", "Keep the v1 endpoint or remove it?");
    expect(comment("c1", "impl", "Remove it.")).toMatchObject({ status: "accepted", effectMayStart: true, revisionTaskId: "impl" });
    expect(queueState("impl")).toBe("pending");
  });

  it("refuses a comment from someone who is not the owner, and on a reviewer task", () => {
    expect(() => governance.postTaskComment(command("x1", { taskId: "impl", body: "hi" }),
      { kind: "worker", sessionId: "a@rig" } as never, binding)).toThrow();
    expect(comment("x2", "missing", "hi")).toMatchObject({ status: "denied" });
    appendChatMessage(db, { id: "m1", runId: "run", body: "Lead chat stays separate.", createdAt: "2026-11-04T00:00:00Z" });
    expect(pendingOwnerMessages(db, "run").map(message => message.id)).toEqual(["m1"]);
  });
});
