import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { DirectWorkerLauncher } from "../src/adapters/direct-worker-launch.js";
import { composePendingDispatch, pendingTasks } from "../src/domain/pending-dispatch.js";
import { composeAttemptCompletion } from "../src/domain/attempt-completion.js";
import { agentTurnPromptPath, boundedOwnerWords, continuationNote, leadProgressNote, managedTurnPrompt, OWNER_WORDS_LIMIT, writeAgentTurnPrompt } from "../src/domain/agent-turn.js";
import type { ControlRequest, PlanBinding } from "../src/contracts/team-control.js";
import type { WorkerEvent } from "../src/contracts/worker-events.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { appendChatMessage, pendingOwnerMessages } from "../src/domain/lead-chat.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

/**
 * MVP — one attempt is one headless turn.
 *
 * The first live run could not complete a task: the managed launch started the client
 * interactively, so a finished agent waited at its prompt and never exited. These tests pin the
 * three facts that make a turn work and the two continuations it creates: the command the pane
 * runs, the slot a stopped attempt frees, and the reason a rework or a lead revision carries.
 */

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const policy = unisolatedPolicyCapability(1);
/**
 * The worker's mutable state root. A real one, because a launch records each turn's prompt and
 * its final-message file under it before the client starts.
 */
const stateRoot = mkdtempSync(join(tmpdir(), "agent-turn-state-"));
afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));

/** A launchable file the launcher may name as its client: the resolver only checks the shape. */
function executableFixture(): string {
  const path = join(stateRoot, "claude-fixture");
  writeFileSync(path, "", { mode: 0o755 });
  return path;
}

/** A manifest-shaped fixture: the launcher reads only these fields. */
function manifest(attemptId: string): ContextManifest {
  return {
    runId: "run", assignment: { taskId: "task-1", role: "implementer", paths: ["src/a.ts"], dependencies: [] },
    outputs: ["src/a.ts"], permissions: [], role: "implementer", client: "claude-code",
    binding: { policyFingerprint: "sha256:" + "b".repeat(64) } as ContextManifest["binding"],
    root: "/context", mutableStateRoot: stateRoot,
    frameworkRoot: "/framework", frameworkRevision: "pin", workerUid: 1000, workerGroups: [],
    discoveryRoots: [], files: [], workerDiscoveryRoots: [], generatedHash: "sha256:" + "a".repeat(64),
    protocolVersion: null, instructionVersions: { core: "1", charter: "1" },
    projection: { worker: "local", attemptId, controlUid: 1000, workerGid: 1000,
      policy: { policy_revision: 4, worker_identities: ["local"], paths: { context_root: "/context", framework_dir: "/framework" },
        sandbox: { context: "/context", framework: "/framework" } } },
    sameIdentity: true,
  } as ContextManifest;
}

describe("the managed turn's command line", () => {
  /**
   * U3 — a managed turn is one supervised child process, so the launcher's contract is the
   * argv, the tree and the prompt it hands the supervisor. The supervisor itself is substituted
   * here: its own behaviour is proven in `child-process-supervisor.test.ts`.
   */
  const launch = async (opts: { resumeToken?: string; continueSessionId?: string } = {}) => {
    // The launcher feeds the prompt the orchestrator already wrote, so the case writes it first.
    writeAgentTurnPrompt(manifest("attempt-1"), "Read the assigned plan.\n");
    const launches: import("../src/adapters/child-process-supervisor.js").SupervisorLaunch[] = [];
    const launcher = new DirectWorkerLauncher({ resolveAssignedTree: () => "/tree",
      // An explicit configured path is used as given; the resolver still requires a real file.
      executablePath: () => executableFixture(),
      supervise: (launch, deps) => {
        launches.push(launch);
        const events: WorkerEvent[] = [];
        return {
          async start() {
            // The client's first session event is what acknowledges the attempt, and what the
            // launcher's readiness wait is satisfied by.
            const event = { type: "session.started", provider: launch.provider, attemptId: launch.attemptId, sequence: 1,
              timestamp: new Date().toISOString(), rawSummary: "{}", schema: "multi-agent-worker-events/v1",
              protocolVersion: "1.0", sessionId: "fixture", resumeToken: "fixture" } as WorkerEvent;
            events.push(event);
            deps.onEvent(event);
            return { processId: 4242, processStart: "fixture" };
          },
          async wait() { return { version: 1 as const, attemptId: launch.attemptId, provider: launch.provider, exitCode: 0,
            signal: null, acknowledged: true, noResponse: false, threadId: null, stderrTail: "", outputTail: "",
            at: new Date().toISOString(), identity: { processId: 4242, processStart: "fixture" },
            events: [], finalMessage: null, resumeToken: null }; },
          async cancel() { return { outcome: "stopped" as const, escalated: false, waitedMs: 0 }; },
          settled() { return null; },
          get processIdentity() { return { processId: 4242, processStart: "fixture" }; },
          get observedEvents() { return events; },
        };
      } });
    const result = await launcher.launch({ client: "claude-code", resumeToken: opts.resumeToken,
      ...(opts.continueSessionId ? { continueSessionId: opts.continueSessionId } : {}),
      attempt: { attemptId: "attempt-1", deadline: Date.now() + 60_000, context: manifest("attempt-1") } });
    return { result, observed: launches[0] };
  };

  it("runs one headless turn: -p, the streaming flags, and the prompt written once on stdin", async () => {
    const { result, observed } = await launch();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(observed.executable).toBe(executableFixture());
    expect(observed.cwd).toBe("/tree");
    expect(observed.prompt).toBe("Read the assigned plan.\n");
    expect(observed.args).toContain("-p");
    expect(observed.args).toContain("bypassPermissions");
    // Measured on the installed build: `text` prints nothing until the turn ends, and
    // `stream-json` without `--verbose` is refused. This is the only mode that streams.
    expect(observed.args.join(" ")).toContain("--output-format stream-json --verbose");
    // A fresh attempt opens a conversation.
    expect(observed.args).toContain("--session-id");
    expect(observed.args).not.toContain("--resume");
    // A Claude turn has no thread id to capture; the supervisor writes its `result` text.
    expect(observed.threadIdPath).toBeUndefined();
  });

  it("continues a conversation with --resume when the seat hands one over", async () => {
    const { observed } = await launch({ continueSessionId: "11111111-2222-3333-4444-555555555555" });
    expect(observed.args).toContain("--resume");
    expect(observed.args[observed.args.indexOf("--resume") + 1]).toBe("11111111-2222-3333-4444-555555555555");
    expect(observed.args).not.toContain("--session-id");
  });

  it("writes the turn's prompt where the launcher reads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-turn-"));
    try {
      const path = agentTurnPromptPath({ ...manifest("attempt-1"), mutableStateRoot: dir } as ContextManifest);
      expect(path).toBe(join(dir, "turns", "attempt-1.prompt"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("states the task, its assignment and the instruction files it must read", () => {
    const text = managedTurnPrompt({ identity: "", bundle: "", runId: "run",
      assignment: { taskId: "task-1", role: "implementer", paths: ["src/a.ts"], dependencies: [] },
      taskBody: "Implement the scoped module", outputs: ["src/a.ts"], permissions: ["write-assigned-tree"],
      instructions: [{ path: "/context/core" }, { path: "/context/charter" }], continuation: null });
    expect(text).toContain("Managed task task-1 for run run");
    expect(text).toContain("Implement the scoped module");
    expect(text).toContain('"paths":["src/a.ts"]');
    expect(text).toContain("Read these files before you start work");
    expect(text).toContain("- /context/core");
    expect(text).toContain("- /context/charter");
    // A plain continuation says nothing about why; the reason is the continuation's own job.
    expect(text).not.toContain("continues your earlier attempt");
  });

  it("cuts owner words over the limit at a sentence boundary and says where the rest is", () => {
    const sentence = "Keep every existing route working. ";
    const long = sentence.repeat(Math.ceil(OWNER_WORDS_LIMIT / sentence.length) + 10);
    const bounded = boundedOwnerWords(long);
    expect(bounded.length).toBeLessThan(OWNER_WORDS_LIMIT + 200);
    expect(bounded).toMatch(/working\.\n\n\[Shortened here\. The full text is the run's plan and the owner's first message\.\]$/);
    expect(boundedOwnerWords("Short goal.")).toBe("Short goal.");
  });

  it.each([false, true])("only advertises a writable task report for write-enabled turns (read-only: %s)", readOnly => {
    const context = manifest("attempt-1");
    const prompt = managedTurnPrompt({ identity: "", bundle: "", runId: "run", assignment: context.assignment,
      taskBody: "Inspect the source", outputs: [], permissions: [], instructions: [], continuation: null,
      taskReportPath: "/state/task-report.json", workflow: { client: "codex", entrypoint: "spec-pov", origin: "user",
        binding: context.binding, input: "Inspect the source", readOnly, revision: "pin", nativeInvocation: "$spec-pov" } });
    expect(prompt.includes("Task report file:")).toBe(!readOnly);
    expect(prompt).toContain("<workflow-outcome>");
  });
});

describe("what a continuation is told", () => {
  let root: string, db: Database.Database, governance: PlanGovernance, binding: PlanBinding, serial = 0;
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: "1.0", runId: "run", actionId, payload,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `request-${++serial}`,
  });
  beforeEach(() => {
    serial = 0;
    root = mkdtempSync(join(tmpdir(), "agent-turn-continuation-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    binding = bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy });
    db = createDb(":memory:"); initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    for (const [nodeId, role, seatName] of [["lead-node", "lead", "lead@rig"], ["a-node", "implementer", "a@rig"],
      ["rev-node", "reviewer", "reviewer@rig"]] as const) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, 'rig', ?, ?, 'claude-code', ?)")
        .run(nodeId, nodeId, role, root);
      db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run(`s-${nodeId}`, nodeId, seatName);
    }
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-04T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding, reviewerSeat: "reviewer@rig" });
    governance.requestApproval(command("initial", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-05T00:00:00.000Z" }), owner);
    governance.decideApproval(command("initial", { approvalVersion: 1, decision: "approved" }), owner, binding);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("reports lead progress at the admission limit and keeps another run and task bodies out", () => {
    for (let index = 0; index < 100; index++) {
      const taskId = `progress-${index}`;
      const result = governance.createTask(command(taskId, { assignment: { taskId, role: "implementer", paths: ["src"], dependencies: [] },
        outputs: [], permissions: ["write-assigned-tree"], sourceSession: "lead@rig", destinationSession: "a@rig",
        body: "Task body that must not enter a progress snapshot." }), binding);
      expect(result.status, JSON.stringify(result)).toBe("accepted");
    }
    expect(governance.createTask(command("past-limit", {
      assignment: { taskId: "past-limit", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead@rig", destinationSession: "a@rig", body: "Beyond the task limit.",
    }), binding)).toMatchObject({ status: "denied", reason: "Managed task limit reached" });
    const note = leadProgressNote(db, "run", "2026-11-04T00:00:00.000Z");
    const progress = JSON.parse(note.split("\n")[1]!);
    expect(progress).toMatchObject({ runId: "run", observedAt: "2026-11-04T00:00:00.000Z", totalTasks: 100, truncated: false });
    expect(progress.tasks).toHaveLength(100);
    expect(progress.tasks[0]).toMatchObject({ taskId: "progress-0", queueState: "pending", latestAttempt: null, review: null });
    expect(note).not.toContain("Task body that must not enter");
    governance.createRun({ id: "another-run", rigId: "rig", binding });
    expect(JSON.parse(leadProgressNote(db, "another-run").split("\n")[1]!))
      .toMatchObject({ runId: "another-run", totalTasks: 0, truncated: false, tasks: [] });
  });

  it("carries only the latest recorded review verdict and its candidate, not raw findings", () => {
    for (const [taskId, role, seat] of [["impl", "implementer", "a@rig"], ["review", "reviewer", "reviewer@rig"]] as const) {
      expect(governance.createTask(command(taskId, { assignment: { taskId, role, paths: ["src"], dependencies: [],
        ...(role === "reviewer" ? { reviewOf: "impl" } : {}) }, outputs: [], permissions: [],
        sourceSession: "lead@rig", destinationSession: seat, body: "Scoped work." }), binding).status).toBe("accepted");
    }
    for (const verdict of ["changes-required", "approved"]) {
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig', 'rev-node', 'team.control', ?)")
        .run(JSON.stringify({ runId: "run", taskId: "impl", action: "review.verdict", payload: { reviewerTaskId: "review",
          verdict, candidateDigest: "sha256:candidate", recordedAt: "2026-11-04T00:00:00.000Z",
          findings: [{ scenario: "Finding body that must not enter progress." }] } }));
    }
    const note = leadProgressNote(db, "run");
    const progress = JSON.parse(note.split("\n")[1]!);
    expect(progress.tasks[1]).toMatchObject({ taskId: "review", reviewOf: "impl", latestAttempt: null,
      review: { verdict: "approved", candidateDigest: "sha256:candidate", recordedAt: "2026-11-04T00:00:00.000Z" } });
    expect(note).not.toContain("Finding body that must not enter");
  });

  it("carries the reviewer's blocking findings into the implementer's rework", () => {
    // The durable record of a round is the `review.verdict` event; nothing else stores findings.
    const event = { type: "team.control", protocolVersion: "1.0", eventId: "e1", rigId: "rig", runId: "run",
      taskId: "task-1", attemptId: null, entityId: "run", entityVersion: 2, action: "review.verdict",
      payload: { taskId: "task-1", reviewerTaskId: "task-1-review-1", round: 1, verdict: "changes-required",
        candidateDigest: null, recordedAt: "2026-11-04T00:00:00.000Z", findings: [
          { id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness", file: "src/a.ts",
            scenario: "the exported constant keeps the stale value" },
          // A residual never extends the loop, so it is not something to fix.
          { id: "R1-2", severity: "P3", citation: "KTD8", category: "style", file: "src/a.ts", scenario: "naming" },
        ] } };
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig', 'a-node', 'team.control', ?)").run(JSON.stringify(event));
    const note = continuationNote(db, "run", "task-1", "implementer")!;
    expect(note).toContain("returned the work for rework");
    expect(note).toContain("R1-1");
    expect(note).toContain("the exported constant keeps the stale value");
    expect(note).not.toContain("R1-2");
    // A reviewer's own attempt is not a rework of anything.
    expect(continuationNote(db, "run", "task-1", "reviewer")).toBeNull();
  });

  it("carries the owner's rejection reason into the lead's revision", () => {
    expect(governance.createTask(command("task-1", { assignment: { taskId: "task-1", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["request-assignment"], sourceSession: "owner", destinationSession: "lead@rig", body: "Approved goal." }), binding).status)
      .toBe("accepted");
    // The lead's own completion is the owner's action; its deliverable is the proposal.
    const qitemId = governance.findTask("run", "task-1")!.qitemId;
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitemId);
    const request = command("proposal-request", { leadProposal: { expiresAt: "2030-01-01T00:00:00.000Z" } });
    const proposed = governance.proposeLeadTasks(request, owner, binding,
      [{ taskId: "task-2", seat: "a@rig", paths: ["src/a.ts"], dependencies: [], body: "Implement task-2" }]);
    expect(proposed.status).toBe("accepted");
    const decided = governance.decideApproval(command((proposed.value as { id: string }).id, {
      approvalVersion: 1, decision: "rejected", reason: "Split this into smaller tasks that one agent can finish." }), owner, binding);
    expect(decided.status).toBe("accepted");
    // The rejection is the lead's next piece of work: the task is open again and the route
    // dispatches it, so the next attempt resumes the conversation that wrote the proposal.
    expect(governance.queueState(qitemId)).toBe("pending");
    expect(decided.revisionTaskId).toBe("task-1");
    expect(decided.effectMayStart).toBe(true);
    const note = continuationNote(db, "run", "task-1", "lead")!;
    expect(note).toContain("The owner rejected the proposal you wrote");
    expect(note).toContain("Split this into smaller tasks that one agent can finish.");
    expect(note).toContain("lead-proposal.json");
  });

  it("stops telling the lead about an approval it has already answered", () => {
    // U6 — a lead's turns continue after the approval: a wake for its team, a refusal, an
    // owner's answer. Restating "the owner approved the plan, decompose it now" in every one of
    // them makes a lead decompose the same plan again, which the daemon then refuses as
    // duplicates. A note about a past turn is news only until the lead answers it.
    expect(governance.createTask(command("task-1", { assignment: { taskId: "task-1", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["request-assignment"], sourceSession: "owner", destinationSession: "lead@rig", body: "Approved goal." }), binding).status)
      .toBe("accepted");
    const leadEvent = (action: string, payload: Record<string, unknown>) => db.prepare(
      "INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig', 'lead-node', 'team.control', ?)").run(JSON.stringify({
        type: "team.control", protocolVersion: "1.0", eventId: `e-${action}-${Math.random()}`, rigId: "rig", runId: "run",
        taskId: "task-1", attemptId: null, entityId: "run", entityVersion: 2, action, payload }));
    leadEvent("plan.approved", { note: null, reason: null });
    expect(continuationNote(db, "run", "task-1", "lead")).toContain("The owner approved the plan");
    // The turn that answered it is the lead's own outcome, and from then on the note is spent.
    leadEvent("task.outcome", { observedBy: "daemon", state: "done" });
    expect(continuationNote(db, "run", "task-1", "lead")).toBeNull();
    // A fresh fact after that turn is still news.
    leadEvent("lead.woken", { note: "Task \"Add the endpoint\" failed again on its retry.", keys: ["failed:task-2"] });
    expect(continuationNote(db, "run", "task-1", "lead")).toContain("failed again on its retry");
  });

  it("launches a lead turn whose prompt carries its task body, the owner's chat and the run's progress", async () => {
    // U20 removed the tmux launcher that composed these into the prompt, and the native launcher
    // looked the body up by the run's task id as if it were a queue id: every turn was told only
    // "Complete the assigned managed task", and the lead never read what the owner wrote.
    expect(governance.createTask(command("task-1", { assignment: { taskId: "task-1", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["request-assignment"], sourceSession: "owner", destinationSession: "lead@rig",
      body: "Lead the approved goal." }), binding).status).toBe("accepted");
    appendChatMessage(db, { id: "m1", runId: "run", body: "Please keep the API unchanged.", createdAt: "2026-11-04T00:00:01.000Z" });
    const context = { ...manifest("lead-attempt-1"),
      assignment: { taskId: "task-1", role: "lead", paths: ["src"], dependencies: [] } } as ContextManifest;
    const orchestrator = new StartupOrchestrator({ db, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db) });
    const adapter = { project: async () => ({ failed: [] }), deliverStartup: async () => ({ failed: [] }) } as unknown as RuntimeAdapter;
    const started = await orchestrator.startNode({ rigId: "rig", nodeId: "lead-node", sessionId: "s-lead-node",
      binding: { id: "direct:lead-node", nodeId: "lead-node", attachmentType: "external_cli", tmuxSession: "lead@rig", tmuxWindow: null,
        tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: root,
        managedAttempt: { attemptId: "lead-attempt-1", deadline: Date.now() + 60_000, context } },
      adapter, plan: { runtime: "claude-code", cwd: root, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "lead@rig", runId: "run", taskId: "task-1",
      skipHarnessLaunch: true });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const prompt = readFileSync(agentTurnPromptPath(context), "utf8");
    expect(prompt).toContain("Lead the approved goal.");
    expect(prompt).not.toContain("Complete the assigned managed task.");
    expect(prompt).toContain("Owner: Please keep the API unchanged.");
    expect(prompt).toContain("Team progress snapshot:");
    // The prompt is the delivery: the message is now this attempt's, so the next turn does not repeat it.
    expect(pendingOwnerMessages(db, "run")).toHaveLength(0);
  });

  it("records the receipt a launch returns, so the completion sweep can admit and close the turn", async () => {
    // 5dcfd9e rewrote the orchestrator without the receipt event. The completion sweep admits an
    // attempt only from that event, so every native turn ran, ended and was never recorded: the
    // lead's reply was lost and its task stayed pending forever.
    expect(governance.createTask(command("task-1", { assignment: { taskId: "task-1", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["request-assignment"], sourceSession: "owner", destinationSession: "lead@rig",
      body: "Lead the approved goal." }), binding).status).toBe("accepted");
    const context = { ...manifest("lead-attempt-1"),
      assignment: { taskId: "task-1", role: "lead", paths: ["src"], dependencies: [] } } as ContextManifest;
    const receipt = { attemptId: "lead-attempt-1", runId: "run", client: "codex", identity: { nativeSessionId: null, paneId: null } };
    const adapter = { project: async () => ({ failed: [] }), deliverStartup: async () => ({ failed: [] }),
      launchHarness: async () => ({ ok: true, managedSession: receipt }), checkReady: async () => ({ ready: true }) } as unknown as RuntimeAdapter;
    const orchestrator = new StartupOrchestrator({ db, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db) });
    const started = await orchestrator.startNode({ rigId: "rig", nodeId: "lead-node", sessionId: "s-lead-node",
      binding: { id: "direct:lead-node", nodeId: "lead-node", attachmentType: "external_cli", tmuxSession: "lead@rig", tmuxWindow: null,
        tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: root, model: "gpt-6.1-sol",
        managedAttempt: { attemptId: "lead-attempt-1", deadline: Date.now() + 60_000, context } },
      adapter, plan: { runtime: "codex", cwd: root, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "lead@rig", runId: "run", taskId: "task-1" });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const events = db.prepare("SELECT payload FROM events WHERE type = 'managed.attempt.receipt'").all() as { payload: string }[];
    expect(events.map(row => JSON.parse(row.payload))).toMatchObject([{ type: "managed.attempt.receipt", rigId: "rig", nodeId: "lead-node",
      sessionId: "s-lead-node", runId: "run", sessionName: "lead@rig", requestedModel: "gpt-6.1-sol", receipt }]);
  });

  /** Launch one turn through the orchestrator without starting a client, and return its prompt. */
  async function launchedPrompt(nodeId: string, seat: string, assignment: ContextManifest["assignment"], attemptId: string): Promise<string> {
    const context = { ...manifest(attemptId), assignment } as ContextManifest;
    const orchestrator = new StartupOrchestrator({ db, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db) });
    const adapter = { project: async () => ({ failed: [] }), deliverStartup: async () => ({ failed: [] }) } as unknown as RuntimeAdapter;
    const started = await orchestrator.startNode({ rigId: "rig", nodeId, sessionId: `s-${nodeId}`,
      binding: { id: `direct:${nodeId}`, nodeId, attachmentType: "external_cli", tmuxSession: seat, tmuxWindow: null,
        tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: root,
        managedAttempt: { attemptId, deadline: Date.now() + 60_000, context } },
      adapter, plan: { runtime: "claude-code", cwd: root, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: seat, runId: "run", taskId: assignment.taskId,
      skipHarnessLaunch: true });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    return readFileSync(agentTurnPromptPath(context), "utf8");
  }

  it("gives workers the owner's words verbatim and an evidence directory outside the candidate", async () => {
    // The lead's brief is not the request. A worker reads the owner's goal as written, so a
    // requirement the lead added or dropped is visible against the original.
    for (const [taskId, role, seat, body] of [["task-1", "lead", "lead@rig", "Add dark mode to the settings page, keep the API unchanged."],
      ["impl", "implementer", "a@rig", "Implement the toggle."], ["review", "reviewer", "reviewer@rig", "Review the toggle."]] as const) {
      expect(governance.createTask(command(taskId, { assignment: { taskId, role, paths: ["src"], dependencies: [],
        ...(role === "reviewer" ? { reviewOf: "impl" } : {}) }, outputs: [], permissions: [],
        sourceSession: role === "lead" ? "owner" : "lead@rig", destinationSession: seat, body }), binding).status).toBe("accepted");
    }
    const implementer = await launchedPrompt("a-node", "a@rig", { taskId: "impl", role: "implementer", paths: ["src"], dependencies: [] }, "impl-attempt-1");
    expect(implementer).toContain("The owner's words for this run, verbatim");
    expect(implementer).toContain("Add dark mode to the settings page, keep the API unchanged.");
    expect(implementer).toContain(`Evidence directory (outside the candidate): ${JSON.stringify(join(stateRoot, "turns", "impl-attempt-1", "evidence"))}`);
    // The reviewer is pointed at the latest attempt of the task it reviews, where the captures are.
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, state, identity_json, usage_json, active_ms, created_at, updated_at)
      VALUES ('impl-attempt-1', 'run', ?, 'implementer', 'claude', 'stopped', '{}', '{}', 0, '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z')`)
      .run(governance.findTask("run", "impl")!.qitemId);
    const reviewer = await launchedPrompt("rev-node", "reviewer@rig",
      { taskId: "review", role: "reviewer", paths: ["src"], dependencies: [], reviewOf: "impl" }, "review-attempt-1");
    expect(reviewer).toContain("Add dark mode to the settings page, keep the API unchanged.");
    expect(reviewer).toContain(JSON.stringify(join(stateRoot, "turns", "impl-attempt-1", "evidence")));
  });

  it("records a rejection with no reason and still reopens the lead", () => {
    expect(governance.createTask(command("task-1", { assignment: { taskId: "task-1", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["request-assignment"], sourceSession: "owner", destinationSession: "lead@rig", body: "Approved goal." }), binding).status)
      .toBe("accepted");
    const qitemId = governance.findTask("run", "task-1")!.qitemId;
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitemId);
    const proposed = governance.proposeLeadTasks(command("proposal-request", { leadProposal: { expiresAt: "2030-01-01T00:00:00.000Z" } }),
      owner, binding, [{ taskId: "task-2", seat: "a@rig", paths: ["src/a.ts"], dependencies: [], body: "Implement task-2" }]);
    governance.decideApproval(command((proposed.value as { id: string }).id, { approvalVersion: 1, decision: "rejected" }), owner, binding);
    expect(governance.queueState(qitemId)).toBe("pending");
    // With nothing said, the revision asks for a revised proposal and invents no reason.
    const note = continuationNote(db, "run", "task-1", "lead");
    expect(note).not.toBeNull();
    expect(note!).toContain("The owner rejected the proposal you wrote.");
    expect(note!).not.toContain("reason:");
  });
});

describe("a freed slot dispatches the run's next task", () => {
  let root: string, db: Database.Database, governance: PlanGovernance, binding: PlanBinding, serial = 0;
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: "1.0", runId: "run", actionId, payload,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `request-${++serial}`,
  });
  const admit = (taskId: string, seatName: string, dependencies: string[] = []) =>
    governance.createTask(command(taskId, { assignment: { taskId, role: "implementer", paths: [`src/${taskId}.ts`], dependencies },
      outputs: [], permissions: [], sourceSession: "owner", destinationSession: seatName, body: `Implement ${taskId}` }), binding);
  beforeEach(() => {
    serial = 0;
    root = mkdtempSync(join(tmpdir(), "pending-dispatch-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    // Two seats and two slots: the second task must wait for the first attempt to stop.
    binding = bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy });
    db = createDb(":memory:"); initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    for (const [nodeId, seatName] of [["a-node", "a@rig"], ["b-node", "b@rig"]] as const) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, 'rig', ?, 'implementer', 'claude-code', ?)")
        .run(nodeId, nodeId, root);
      db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run(`s-${nodeId}`, nodeId, seatName);
    }
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-04T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("initial", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-05T00:00:00.000Z" }), owner);
    governance.decideApproval(command("initial", { approvalVersion: 1, decision: "approved" }), owner, binding);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  const live = (runId: string) => (db.prepare("SELECT count(*) AS n FROM team_attempts WHERE run_id = ? AND state <> 'stopped'")
    .get(runId) as { n: number }).n;

  it("starts the second task only after the first attempt stops, at the run's limit", async () => {
    expect(admit("task-1", "a@rig").status).toBe("accepted");
    // Two independent tasks on two seats: the dependency gate is not what this case is about,
    // and the slot is. Each task names its own write path so their claims do not overlap.
    expect(admit("task-2", "b@rig").status).toBe("accepted");
    // Two tasks, one slot. The run's own binding allows two, so this case states the limit the
    // scheduler is given rather than rewriting the binding a launch would also read.
    const limit = () => 1;
    const started: string[] = [];
    const pending = composePendingDispatch({ db, dispatch: () => async (runId, taskId) => {
      // A dispatch that starts nothing leaves the slot free; one that starts records the attempt
      // the way a launch receipt would.
      started.push(taskId);
      const qitemId = governance.findTask(runId, taskId)!.qitemId;
      db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason,
        state, usage_json, active_ms, created_at, updated_at) VALUES (?, ?, ?, 'implementer', 'claude',
        ?, NULL, 'running', '{"activeMs":0,"inputTokens":{"value":null,"reason":"unobserved"},"outputTokens":{"value":null,"reason":"unobserved"},"costUsd":{"value":null,"reason":"unobserved"}}', 0, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`)
        .run(`attempt-${taskId}`, runId, qitemId, JSON.stringify({ nativeSessionId: taskId, tmuxServer: "/tmp/tmux", paneId: "%1",
          processId: process.pid, processStart: "0", generation: 1, policyFingerprint: binding.policyFingerprint }));
    }, liveSessions: live, maxSessions: limit });
    // Nothing dispatches while the run has no live attempt and no slot is used yet: the first
    // task starts.
    await pending("run");
    expect(started).toEqual(["task-1"]);
    // The slot is taken, so the second task waits — this is the bug the first live run found.
    await pending("run");
    expect(started, JSON.stringify({ live: live("run"), pending: pendingTasks(db, "run") })).toEqual(["task-1"]);
    // The first attempt stops and its seat is released; the sweep asks again.
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'attempt-task-1'").run();
    await pending("run");
    expect(started).toEqual(["task-1", "task-2"]);
  });

  it("dispatches nothing for a run that is not approved", async () => {
    expect(admit("task-1", "a@rig").status).toBe("accepted");
    expect(admit("task-2", "b@rig").status).toBe("accepted");
    const started: string[] = [];
    const pending = composePendingDispatch({ db, dispatch: () => async (_runId, taskId) => { started.push(taskId); },
      liveSessions: () => 0, maxSessions: () => 2 });
    await pending("run");
    expect(started).toEqual(["task-1", "task-2"]);
    // A canceled run keeps its queue as the cancel left it: dispatch closure is the gate every
    // command that admits work already reads, and this owner reads the same one.
    started.length = 0;
    governance.cancelRun(command("cancel-run", { reason: "The owner stopped the run" }), owner);
    await pending("run");
    expect(started).toEqual([]);
  });

  it("leaves a task alone until its owner records the outcome, and resumes it after a reopen", async () => {
    expect(admit("task-1", "a@rig").status).toBe("accepted");
    const started: string[] = [];
    const pending = composePendingDispatch({ db, dispatch: () => async (_runId, taskId) => {
      started.push(taskId);
      db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason,
        state, usage_json, active_ms, created_at, updated_at) VALUES (?, 'run', ?, 'implementer', 'claude',
        ?, NULL, 'running', '{"activeMs":0,"inputTokens":{"value":null,"reason":"unobserved"},"outputTokens":{"value":null,"reason":"unobserved"},"costUsd":{"value":null,"reason":"unobserved"}}', 0, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`)
        .run(`attempt-${taskId}`, governance.findTask("run", taskId)!.qitemId,
          JSON.stringify({ nativeSessionId: taskId, tmuxServer: "/tmp/tmux", paneId: "%1", processId: process.pid,
            processStart: "0", generation: 1, policyFingerprint: binding.policyFingerprint }));
    }, liveSessions: () => 0, maxSessions: () => 2 });
    await pending("run");
    expect(started).toEqual(["task-1"]);
    // The turn ended, but the owner has not recorded the outcome. The work may be done, so a
    // second attempt is not this scheduler's decision to make.
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'attempt-task-1'").run();
    await pending("run");
    expect(started).toEqual(["task-1"]);
    // A completion that sends the task back for rework reopens it, and that is a new attempt.
    // The reopen is written by the run's own rework path with its own note; this test drives
    // the same write the review loop makes, through the governance owner that owns it.
    const qitemId = governance.findTask("run", "task-1")!.qitemId;
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitemId);
    const rework = (governance as unknown as { startRework: (...args: unknown[]) => unknown }).startRework;
    const ctx = { run: governance.getRun("run"), register: () => {}, request: {}, now: "2026-11-04T00:00:00.000Z" };
    // The governance owner writes the queue inside the command's own transaction; a direct
    // call has to stand in one for the same grant to hold.
    const result = db.transaction(() => rework.call(governance, ctx, { taskId: "task-1", reviewerTaskId: "task-1-review-1",
      round: 1, candidateDigest: null, verdict: "changes-required", recordedAt: "2026-11-04T00:00:00.000Z",
      findings: [{ id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness", file: "src/task-1.ts",
        scenario: "the value is stale" }] }))();
    expect(result).toMatchObject({ effectMayStart: true });
    expect(governance.queueState(qitemId)).toBe("pending");
    expect(pendingTasks(db, "run")).toEqual(["task-1"]);
    await pending("run");
    expect(started).toEqual(["task-1", "task-1"]);
  });

  it("serves a reopen once, not once per freed slot", async () => {
    // Measured on the C4 rerun: the owner rejected the lead's proposal, the lead's revision
    // attempt ran and ended, and every later sweep re-named the same lead task because the
    // reopen was still the queue row's last transition. Each extra launch spent the run's
    // lead-wake budget until the run was blocked with `lead-wake:cycles`, so the revised
    // proposal could never be approved. A reopen starts one attempt.
    expect(admit("task-1", "a@rig").status).toBe("accepted");
    const started: string[] = [];
    const pending = composePendingDispatch({ db, dispatch: () => async (_runId, taskId) => {
      started.push(taskId);
      const attemptId = `attempt-${started.length}`;
      db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason,
        state, usage_json, active_ms, created_at, updated_at) VALUES (?, 'run', ?, 'implementer', 'claude',
        ?, NULL, 'running', '{"activeMs":0,"inputTokens":{"value":null,"reason":"unobserved"},"outputTokens":{"value":null,"reason":"unobserved"},"costUsd":{"value":null,"reason":"unobserved"}}', 0, ?, ?)`)
        .run(attemptId, governance.findTask("run", taskId)!.qitemId,
          JSON.stringify({ nativeSessionId: "task", tmuxServer: "/tmp/tmux", paneId: "%1", processId: process.pid,
            processStart: "0", generation: 1, policyFingerprint: binding.policyFingerprint }),
          new Date(Date.now() + started.length).toISOString(), new Date(Date.now() + started.length).toISOString());
      // The event production writes when it records an attempt; the scheduler reads it to tell
      // whether a reopen has already been served.
      db.prepare(`INSERT INTO events (rig_id, node_id, type, payload, created_at)
        VALUES ('rig', 'a-node', 'team.control', ?, '2026-11-04T00:00:00.000Z')`).run(JSON.stringify({
        type: "team.control", action: "attempt.recorded", runId: "run", attemptId, payload: { actionId: attemptId } }));
    }, liveSessions: () => 0, maxSessions: () => 2 });
    await pending("run");
    expect(started).toEqual(["task-1"]);
    // The first turn ends and the owner records it done, so the reopen below is the next work.
    // The attempt must already be stopped: a reopen while an attempt is still live is work in
    // progress, which this scheduler must not start a second time.
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'attempt-1'").run();
    const qitemId = governance.findTask("run", "task-1")!.qitemId;
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitemId);
    // The reopen is written by the run's own rework path, exactly as a blocking review writes it.
    const rework = (governance as unknown as { startRework: (...args: unknown[]) => unknown }).startRework;
    const ctx = { run: governance.getRun("run"), register: () => {}, request: {}, now: "2026-11-04T00:00:00.000Z" };
    db.transaction(() => rework.call(governance, ctx, { taskId: "task-1", reviewerTaskId: "task-1-review-1", round: 1,
      candidateDigest: null, verdict: "changes-required", recordedAt: "2026-11-04T00:00:00.000Z",
      findings: [{ id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness", file: "src/task-1.ts",
        scenario: "the value is stale" }] }))();
    // The reopen is served by exactly one launch, and the next freed slot names nothing.
    await pending("run");
    expect(started).toEqual(["task-1", "task-1"]);
    db.prepare("UPDATE team_attempts SET state = 'stopped' WHERE id = 'attempt-2'").run();
    await pending("run");
    expect(started).toEqual(["task-1", "task-1"]);
    expect(pendingTasks(db, "run")).toEqual([]);
  });

  it("names only pending tasks with no live attempt", () => {    expect(admit("task-1", "a@rig").status).toBe("accepted");
    expect(admit("task-2", "b@rig").status).toBe("accepted");
    expect(pendingTasks(db, "run")).toEqual(["task-1", "task-2"]);
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason,
      state, usage_json, active_ms, created_at, updated_at) VALUES ('attempt-task-1', 'run', ?, 'implementer', 'claude',
      ?, NULL, 'running', '{"activeMs":0,"inputTokens":{"value":null,"reason":"unobserved"},"outputTokens":{"value":null,"reason":"unobserved"},"costUsd":{"value":null,"reason":"unobserved"}}', 0, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`)
      .run(governance.findTask("run", "task-1")!.qitemId, JSON.stringify({ nativeSessionId: "task", tmuxServer: "/tmp/tmux", paneId: "%1", processId: process.pid,
        processStart: "0", generation: 1, policyFingerprint: binding.policyFingerprint }));
    expect(pendingTasks(db, "run")).toEqual(["task-2"]);
  });

  it("admits a receipt on a seat that holds two live tasks, by the pane's stamp", async () => {
    // Measured on the C4 rerun: both implementers completed, so the run created task-2-review-1
    // and task-3-review-1 on the same reviewer seat. The review turn really ran, but the receipt
    // named only the seat, the sweep found two live tasks there and recorded nothing, so the
    // owner's completion read had no attempt to record. The launch stamps its pane with the task
    // it starts, and that stamp is the answer.
    expect(admit("task-1", "a@rig").status).toBe("accepted");
    expect(admit("task-2", "a@rig").status).toBe("accepted");
    // A receipt for the seat, as a real launch writes one: the daemon's event log is its source.
    db.prepare(`INSERT INTO events (rig_id, node_id, type, payload, created_at)
      VALUES ('rig', 'a-node', 'managed.attempt.receipt', ?, '2026-11-04T00:00:01.000Z')`).run(JSON.stringify({
        sessionName: "a@rig", runId: "run", receipt: { attemptId: "attempt-stamped", runId: "run", client: "claude-code",
          identity: { nativeSessionId: "stamped", tmuxServer: "/tmp/tmux", paneId: "%9", processId: process.pid,
            processStart: "0", generation: 1, policyFingerprint: binding.policyFingerprint } } }));
    const sweepWith = async (paneTask: string | null) => {
      const completion = composeAttemptCompletion({ db, governance, sessions: { findResumeContextByName: () => null,
        updateStartupStatus: () => {} }, currentBinding: () => binding, intervalMs: 60_000, paneTask: async () => paneTask,
        // The launch's client is still running; this case is about which task it is admitted for.
        alive: () => true });
      await completion.sweep();
      completion.stop();
    };
    // Without a stamp the seat is ambiguous and nothing is recorded: the conservative answer.
    await sweepWith(null);
    expect(governance.getAttempt("attempt-stamped")).toBeNull();
    // The stamp names task-2, so that is the task the attempt belongs to.
    await sweepWith("task-2");
    expect(governance.getAttempt("attempt-stamped")).toMatchObject({ state: "running", role: "implementer" });
    expect(governance.getAttempt("attempt-stamped")?.qitemId).toBe(governance.findTask("run", "task-2")!.qitemId);
  });

  it("asks the sweep to dispatch once it has recorded a stop", async () => {
    const dispatchPending = vi.fn(async () => {});
    const completion = composeAttemptCompletion({ db, governance, sessions: { findResumeContextByName: () => null,
      updateStartupStatus: () => {} }, currentBinding: () => binding, dispatchPending, intervalMs: 60_000 });
    expect(admit("task-1", "a@rig").status).toBe("accepted");
    const qitemId = governance.findTask("run", "task-1")!.qitemId;
    // An attempt the sweep will observe gone: its identity names no live process.
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason,
      state, usage_json, active_ms, created_at, updated_at) VALUES ('attempt-gone', 'run', ?, 'implementer', 'claude',
      ?, NULL, 'running', '{"activeMs":0,"inputTokens":{"value":null,"reason":"unobserved"},"outputTokens":{"value":null,"reason":"unobserved"},"costUsd":{"value":null,"reason":"unobserved"}}',
      0, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`)
      .run(qitemId, JSON.stringify({ nativeSessionId: "gone", tmuxServer: "/tmp/tmux", paneId: "%1", processId: 999_999_999,
        processStart: "0", generation: 1, policyFingerprint: binding.policyFingerprint }));
    await completion.sweep();
    expect(governance.getAttempt("attempt-gone")?.state).toBe("stopped");
    expect(dispatchPending).toHaveBeenCalledWith("run");
    completion.stop();
  });

  it("closes a native turn from the exit facts its supervisor recorded, with no pane to read", async () => {
    // U3 — a direct child records its own end. The attempt's identity has no pane, and the
    // sweep must still stop it from the exit file rather than wait for a process that is gone.
    const dispatchPending = vi.fn(async () => {});
    const completion = composeAttemptCompletion({ db, governance, sessions: { findResumeContextByName: () => null,
      updateStartupStatus: () => {} }, currentBinding: () => binding, dispatchPending, intervalMs: 60_000,
      // A turn that reported its own end, and a liveness probe that would keep it open.
      turnExit: attemptId => attemptId === "attempt-native" ? { version: 1 as const, attemptId, provider: "claude" as const,
        exitCode: 0, signal: null, acknowledged: true, noResponse: false, threadId: null, stderrTail: "", outputTail: "",
        at: new Date().toISOString() } : null,
      alive: () => true });
    expect(admit("task-1", "a@rig").status).toBe("accepted");
    const qitemId = governance.findTask("run", "task-1")!.qitemId;
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, identity_json, unknown_reason,
      state, usage_json, active_ms, created_at, updated_at) VALUES ('attempt-native', 'run', ?, 'implementer', 'claude',
      ?, NULL, 'running', '{"activeMs":0,"inputTokens":{"value":null,"reason":"unobserved"},"outputTokens":{"value":null,"reason":"unobserved"},"costUsd":{"value":null,"reason":"unobserved"}}',
      0, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`)
      .run(qitemId, JSON.stringify({ nativeSessionId: "native", tmuxServer: null, paneId: null, processId: 4242,
        processStart: "2026-11-10T00:00:00.000Z", generation: 1, policyFingerprint: binding.policyFingerprint }));
    await completion.sweep();
    expect(governance.getAttempt("attempt-native")?.state).toBe("stopped");
    expect(dispatchPending).toHaveBeenCalledWith("run");
    completion.stop();
  });

  it("asks the scheduler for a run's pending work when the daemon starts", async () => {
    // Measured on the C4 acceptance run: the review reopened the implementer's task, then the
    // daemon restarted. Nothing was live to stop, so no freed slot asked the scheduler again and
    // the rework sat pending. A start is a freed slot too.
    expect(admit("task-1", "a@rig").status).toBe("accepted");
    const dispatchPending = vi.fn(async () => {});
    const completion = composeAttemptCompletion({ db, governance, sessions: { findResumeContextByName: () => null,
      updateStartupStatus: () => {} }, currentBinding: () => binding, dispatchPending, intervalMs: 60_000 });
    completion.start();
    // The start pass is asynchronous; give it a turn to run before asserting.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(dispatchPending).toHaveBeenCalledWith("run");
    completion.stop();
    // A run with nothing pending is not asked: the pass reads the queue, not every run ever made.
    dispatchPending.mockClear();
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?")
      .run(governance.findTask("run", "task-1")!.qitemId);
    const second = composeAttemptCompletion({ db, governance, sessions: { findResumeContextByName: () => null,
      updateStartupStatus: () => {} }, currentBinding: () => binding, dispatchPending, intervalMs: 60_000 });
    second.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(dispatchPending).not.toHaveBeenCalled();
    second.stop();
  });
});
