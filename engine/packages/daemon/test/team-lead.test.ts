import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { leadActivation, leadInstructions, planningInstructions, leadRoster, parseLeadProposal, LEAD_ESCALATION_PATH, LEAD_PROPOSAL_PATH } from "../src/domain/lead-proposal.js";
import { saveTeamSoul } from "../src/domain/team-souls.js";
import { saveTeamModelSettings } from "../src/domain/team-model-policy.js";
import { FRAMEWORK_CATALOG } from "../src/integrations/framework/catalog.js";
import { teamLeadRoutes, PROPOSAL_WINDOW_MS } from "../src/routes/team-lead.js";
import { teamControlRoutes } from "../src/routes/team-control.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";
import type { TeamControlEnv } from "../src/middleware/auth-bearer-token.js";
import type { ControlRequest, PlanBinding } from "../src/contracts/team-control.js";

/**
 * MVP slice C3 — a lead proposes implementer tasks and the owner decides them.
 *
 * The lead cannot admit work: it writes one file into its own candidate tree, the daemon reads
 * it at that boundary, and the batch becomes an owner decision carrying the exact tasks. These
 * tests drive the real route and the real governance owner against a repository on disk, so
 * what they assert is that nothing the lead wrote reaches the run without the owner's approval.
 */

const owner = { kind: "owner", sessionId: "owner" } as const;
const worker = { kind: "worker", sessionId: "worker" } as const;
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const policy = unisolatedPolicyCapability(1);

describe("C3 — the lead's decomposition is an owner decision", () => {
  let root: string, db: Database.Database, governance: PlanGovernance, binding: PlanBinding, serial: number;
  let app: Hono<TeamControlEnv>, proposal: unknown;
  const dispatch = vi.fn(async () => {});
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: "1.0", runId: "run", actionId, payload,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `request-${++serial}`,
  });
  const post = (path: string, request: ControlRequest<unknown>, token = "fixture-owner") => app.request(`/runs/run/tasks/task-1/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }, peer);
  /** The owner decision, on the route C1 and C2 already own. */
  const decide = (request: ControlRequest<unknown>) => app.request("/runs/run/approvals/decide", {
    method: "POST", headers: { Authorization: "Bearer fixture-owner", "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }, peer);
  const get = (path: string, token = "fixture-owner") => app.request(`/runs/run/tasks/task-1/${path}`,
    { headers: { Authorization: `Bearer ${token}` } }, peer);
  /** A proposal request, with the expiry that states the owner's decision window. */
  const proposalRequest = (actionId: string) => command(actionId,
    { leadProposal: { expiresAt: new Date(Date.parse("2026-11-04T00:00:00.000Z") + PROPOSAL_WINDOW_MS).toISOString() } });
  /** A lead task on its own seat, plus two implementer seats the lead may choose from. */
  const seat = (nodeId: string, role: string, seatName: string) => {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, 'rig', ?, ?, 'claude-code', ?)")
      .run(nodeId, nodeId, role, root);
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run(`s-${nodeId}`, nodeId, seatName);
  };
  const task = (taskId: string, seatName: string, paths: string[], dependencies: string[] = []) =>
    ({ taskId, seat: seatName, paths, dependencies, body: `Implement ${taskId}` });
  beforeEach(() => {
    serial = 0; dispatch.mockClear();
    root = mkdtempSync(join(tmpdir(), "team-lead-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    binding = bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy });
    db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    seat("lead-node", "lead", "lead@rig"); seat("a-node", "implementer", "a@rig");
    seat("b-node", "implementer", "b@rig"); seat("rev-node", "reviewer", "reviewer@rig");
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-04T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding, reviewerSeat: "reviewer@rig" });
    governance.requestApproval(command("initial", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-05T00:00:00.000Z" }), owner);
    governance.decideApproval(command("initial", { approvalVersion: 1, decision: "approved" }), owner, binding);
    expect(governance.createTask(command("task-1", { assignment: { taskId: "task-1", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["request-assignment"], sourceSession: "owner", destinationSession: "lead@rig", body: "Approved goal." }), binding).status)
      .toBe("accepted");
    proposal = { tasks: [task("task-2", "a@rig", ["src/a.ts"]), task("task-3", "b@rig", ["src/b.ts"], ["task-2"])] };
    // Both route groups, as the daemon mounts them: the proposal route records the decision and
    // `approvals/decide` is the one path that acts on it.
    app = new Hono<TeamControlEnv>();
    app.route("/", teamLeadRoutes(governance, { credentials: { ownerToken: "fixture-owner",
      workers: [{ token: "fixture-worker", runId: "run", sessionId: "worker" }] },
      readPolicyCapability: () => policy,
      runtime: { leadProposalFor: () => parseLeadProposal(proposal) } }));
    app.route("/", teamControlRoutes(governance, { credentials: { ownerToken: "fixture-owner",
      workers: [{ token: "fixture-worker", runId: "run", sessionId: "worker" }] },
      readPolicyCapability: () => policy,
      // The current binding, read the way the daemon reads it before a decision.
      resolveBinding: run => ({ ...run.binding, planDigest: hashBytes(readFileSync(join(root, "plan.md"))) }),
      dispatch }), []);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("reads the lead's proposal and admits nothing until the owner approves it", async () => {
    const read = await get("proposal");
    expect(read.status).toBe(200);
    expect((await read.json() as { proposal: { tasks: unknown[] } }).proposal.tasks).toHaveLength(2);
    // The read is not an admission: the run still holds only the lead's task.
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority").get()).toEqual({ n: 1 });

    const requested = await post("proposal", proposalRequest("proposal"));
    expect(requested.status).toBe(200);
    const receipt = await requested.json() as { status: string; value: { id: string; payload: { change: string; tasks: unknown[] } } };
    expect(receipt.status).toBe("accepted");
    expect(receipt.value.payload.change).toBe("lead-proposal");
    expect(receipt.value.payload.tasks).toHaveLength(2);
    // A recorded decision is still not an admission.
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority").get()).toEqual({ n: 1 });
    expect(governance.findTask("run", "task-2")).toBeNull();
  });

  it("admits the approved batch through the same path a start uses, and keeps the binding", async () => {
    const requested = await (await post("proposal", proposalRequest("proposal"))).json() as { value: { id: string; entityVersion: number } };
    const decided = await decide(command(requested.value.id, { approvalVersion: 1, decision: "approved" }));
    expect(decided.status).toBe(200);
    const receipt = await decided.json() as { status: string; value: { addedTasks: string[] } };
    expect(receipt.value.addedTasks).toEqual(["task-2", "task-3"]);
    expect(governance.findTask("run", "task-2")?.assignment).toEqual({ taskId: "task-2", role: "implementer", paths: ["src/a.ts"], dependencies: [] });
    expect(governance.findTask("run", "task-3")?.assignment.dependencies).toEqual(["task-2"]);
    // A lead's decomposition stays inside the approved plan, so the binding never moved.
    expect(governance.getRun("run")).toMatchObject({ state: "approved", bindingDigest: hashBinding(binding) });
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority").get()).toEqual({ n: 3 });
    // The route dispatches the tasks it admitted: nothing else would start them.
    expect(dispatch.mock.calls).toEqual([["run", "task-2"], ["run", "task-3"]]);
  });

  it("records a rejection without admitting anything or changing the binding", async () => {
    const requested = await (await post("proposal", proposalRequest("proposal"))).json() as { value: { id: string } };
    expect((await decide(command(requested.value.id, { approvalVersion: 1, decision: "rejected" }))).status).toBe(200);
    expect(governance.getApproval(requested.value.id)).toMatchObject({ state: "rejected", decisionActor: "owner-control" });
    expect(governance.findTask("run", "task-2")).toBeNull();
    expect(governance.getRun("run").bindingDigest).toBe(hashBinding(binding));
  });

  it("refuses a proposal from a worker and from a run whose task is not a lead task", async () => {
    // The read and the decision are both owner-only: the file is worker-written content and
    // the decision is the owner's.
    expect((await get("proposal", "fixture-worker")).status).toBe(403);
    expect((await post("proposal", proposalRequest("proposal"), "fixture-worker")).status).toBe(403);
    expect(governance.listApprovals("run").some(item => item.payload.change === "lead-proposal")).toBe(false);
  });

  it("refuses a batch the approved plan does not cover, before recording anything", async () => {
    proposal = { tasks: [task("task-2", "a@rig", ["outside/a.ts"])] };
    expect((await post("proposal", proposalRequest("proposal"))).status).toBe(403);
    expect(governance.listApprovals("run").filter(item => item.payload.change === "lead-proposal")).toEqual([]);
    expect(governance.findTask("run", "task-2")).toBeNull();
  });

  it("refuses a seat that does not declare the implementer role", async () => {
    proposal = { tasks: [task("task-2", "reviewer@rig", ["src/a.ts"])] };
    expect((await post("proposal", proposalRequest("proposal"))).status).toBe(403);
    expect(governance.findTask("run", "task-2")).toBeNull();
  });

  it("reports a lead that wrote nothing as a named refusal, not a crash", async () => {
    app = teamLeadRoutes(governance, { credentials: { ownerToken: "fixture-owner" },
      runtime: { leadProposalFor: () => { throw new Error(`The lead wrote no proposal at ${LEAD_PROPOSAL_PATH}`); } } });
    const read = await get("proposal");
    expect(read.status).toBe(409);
    expect(await read.json()).toMatchObject({ code: "lead_proposal_unreadable" });
  });

  it("validates the proposal shape at the boundary that reads worker-written data", () => {
    expect(parseLeadProposal(proposal)).toHaveLength(2);
    expect(() => parseLeadProposal({ tasks: [] })).toThrow();
    expect(() => parseLeadProposal({ tasks: [{ taskId: "t", seat: "a@rig", paths: [], dependencies: [], body: "x" }] })).toThrow();
    expect(() => parseLeadProposal({ tasks: [task("t", "a@rig", ["/etc/passwd"])] })).toThrow();
    expect(() => parseLeadProposal({ tasks: [task("t", "a@rig", ["src/../outside"])] })).toThrow();
    expect(() => parseLeadProposal({ tasks: [task("t", "a@rig", ["src"]), task("t", "b@rig", ["src/b"])] })).toThrow();
    expect(() => parseLeadProposal({ tasks: [{ ...task("t", "a@rig", ["src"]), extra: true }] })).toThrow();
  });

  it("accepts a concise generated task name while preserving its complete brief", () => {
    const body = "Read the full project documentation and compare the requirements with existing behavior.\nKeep every relevant detail.";
    expect(parseLeadProposal({ tasks: [{ ...task("t", "a@rig", ["src"]), displayName: "Map project requirements", body }] })[0])
      .toMatchObject({ displayName: "Map project requirements", body });
    for (const displayName of ["", "x".repeat(81), "two\nlines"]) {
      expect(() => parseLeadProposal({ tasks: [{ ...task("t", "a@rig", ["src"]), displayName }] })).toThrow();
    }
  });

  it("builds the roster from the rig's seats whose role the approval covers", () => {
    expect(leadRoster(db, { rigId: "rig", roles: binding.roles, excludeSeat: "lead@rig" }))
      .toEqual([{ member: "a@rig", role: "implementer", mailbox: "a@rig" },
        { member: "b@rig", role: "implementer", mailbox: "b@rig" },
        { member: "reviewer@rig", role: "reviewer", mailbox: "reviewer@rig" }]);
    expect(leadRoster(db, { rigId: "rig", roles: ["implementer"], excludeSeat: "lead@rig" }).map(member => member.member))
      .toEqual(["a@rig", "b@rig"]);
  });

  it("gives planning leads an actionable question protocol instead of headless interactive tools", () => {
    const instructions = planningInstructions("Explore a new feature", "plan.md", true);
    expect(instructions).toContain(LEAD_ESCALATION_PATH);
    expect(instructions).toContain('"question"');
    expect(instructions).toContain('"options"');
    expect(instructions).toContain("End the turn and wait");
    expect(instructions).toContain("Do not use terminal-only question tools");
  });

  it("states the proposal path and shape in the run instructions", () => {
    const instructions = leadInstructions("Implement the approved modules.\nSecond line.");
    expect(instructions).toContain(LEAD_PROPOSAL_PATH);
    expect(instructions).toContain('"tasks"');
    // U6 — after the plan is approved the list is admitted without a further owner decision,
    // and only the things the lead may not decide go back to the owner as a decision.
    expect(instructions).toContain("admitted without the owner");
    expect(instructions).toContain("Each task must own nonempty write paths and target an implementer");
    expect(instructions).toContain("The daemon creates reviews after implementation");
    expect(instructions).toContain("do not propose read-only reviewer tasks from the plan");
    expect(instructions).toContain(LEAD_ESCALATION_PATH);
    expect(instructions).toContain('"options"');
    // The goal's control characters are flattened: the manifest carries prose, not bytes.
    expect(instructions).not.toContain("\nSecond line");
  });

  it.each(["planning", "delivery", undefined] as const)("preserves the supplied lead phase without changing legacy activations: %s", phase => {
    const activation = leadActivation(db, { rigId: "rig", roles: binding.roles, seat: "lead@rig",
      goal: "Plan the work", activationId: "activation", ...(phase === undefined ? {} : { phase }), planRef: "plan.md" });
    if (phase === undefined) expect(activation).not.toHaveProperty("phase");
    else expect(activation).toHaveProperty("phase", phase);
    expect(activation.instructions).toContain(phase === "planning" ? "You are planning with the owner" : "The owner approved the plan");
  });

  it("shows the lead edited specialist expertise within its bounded run instructions", () => {
    const content = "Inspect owner-specific diagrams and document every compatibility decision. "
      + "Detailed specialist instruction. ".repeat(300) + " END_OF_LONG_PROFILE";
    saveTeamSoul(db, "rig", "frontend", { expectedVersion: 1, name: "Diagram specialist", roles: ["implementer"], content });
    const activation = leadActivation(db, { rigId: "rig", roles: binding.roles, seat: "lead@rig",
      goal: "Plan the work", activationId: "planning", phase: "planning", planRef: "plan.md", buildRoster: true });
    expect(activation.instructions).toContain("Inspect owner-specific diagrams and document every compatibility decision.");
    expect(activation.instructions).not.toContain("END_OF_LONG_PROFILE");
    expect(activation.instructions.length).toBeLessThanOrEqual(8_192);
    expect(activation.instructions).toContain("complete version is supplied to the selected specialist");
  });

  it.each([17, 18])("keeps complete long model policies and specialist guidance inside the activation budget: %s models", count => {
    const allowedSubagents = Array.from({ length: count }, (_, index) => ({
      client: "codex" as const, model: `model-${index}${"a".repeat(100)}`,
    }));
    saveTeamModelSettings(db, "rig", { kind: "project", lead: { client: "codex", model: "fixture" }, allowedSubagents });
    for (const phase of ["planning", "delivery"] as const) {
      const { instructions } = leadActivation(db, { rigId: "rig", roles: binding.roles, seat: "lead@rig",
        goal: "Plan the work", activationId: "activation", phase, planRef: "plan.md", buildRoster: true });
      expect(instructions.length).toBeLessThanOrEqual(8_192);
      expect(instructions).toContain(JSON.stringify(allowedSubagents));
      expect(instructions).toContain("Markdown H1");
      expect(instructions).toContain("selected response language");
      expect(instructions).toContain("coordinator: Turn the owner's goal into a right-sized plan and a small team.");
      expect(instructions).toContain("complete version is supplied to the selected specialist");
      const workflows = JSON.parse(instructions.split("Workflow entrypoints and invocation requirements (data):\n")[1]!.split("\n")[0]!) as Record<string, string[]>;
      for (const entry of FRAMEWORK_CATALOG) expect(workflows[entry.invocation]).toContain(entry.name);
    }
  });

  it("shows existing clients only to roster-enabled planning, including inactive but not retired seats", () => {
    db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = 'b-node'").run();
    db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = 'b-node'").run();
    db.prepare("UPDATE nodes SET retired_at = '2026-11-06T00:00:00.000Z' WHERE id = 'rev-node'").run();
    const input = { rigId: "rig", roles: binding.roles, seat: "lead@rig", goal: "Plan the work", activationId: "planning",
      phase: "planning" as const, planRef: "plan.md" };
    const instructions = leadActivation(db, { ...input, buildRoster: true }).instructions;
    expect(instructions).toContain(JSON.stringify([
      { role: "implementer", client: "claude-code", model: null, count: 1 },
      { role: "implementer", client: "codex", model: null, count: 1 },
    ]));
    expect(instructions).not.toContain("reviewer@rig");
    expect(instructions).not.toContain("lead@rig");
    expect(instructions.length).toBeLessThanOrEqual(8_192);
    const planningBody = planningInstructions("Plan the work", "plan.md", true);
    const bodyStart = instructions.indexOf(planningBody);
    expect(bodyStart).toBeGreaterThan(0);
    const catalogContext = instructions.slice(0, bodyStart);
    expect(catalogContext).toContain("Available specialist profiles (data):");
    expect(catalogContext).toContain("Workflow entrypoints and invocation requirements (data):");
    expect(catalogContext).not.toContain("Existing seats to reuse");
    expect(catalogContext).not.toContain('"client":');
    for (const buildRoster of [false, undefined]) {
      const withoutRoster = leadActivation(db, { ...input, buildRoster }).instructions;
      const [runInstructions, expertise] = withoutRoster.split("\n\nSpecialist expertise excerpts");
      expect(runInstructions).toBe(catalogContext + planningInstructions("Plan the work", "plan.md"));
      expect(expertise).toContain("coordinator:");
      expect(withoutRoster).not.toContain("Existing seats to reuse");
    }
    for (const phase of ["delivery", undefined] as const) {
      expect(leadActivation(db, { ...input, phase, buildRoster: true }).instructions)
        .toBe(leadActivation(db, { ...input, phase, buildRoster: false }).instructions);
    }
  });

  it("replays an identical decision instead of admitting a second batch", async () => {
    const request = proposalRequest("proposal");
    const first = await (await post("proposal", request)).json() as { value: { id: string } };
    expect((await post("proposal", request)).status).toBe(200);
    const decision = command(first.value.id, { approvalVersion: 1, decision: "approved" });
    expect((await decide(decision)).status).toBe(200);
    expect((await decide(decision)).status).toBe(200);
    expect(db.prepare("SELECT count(*) AS n FROM team_queue_authority").get()).toEqual({ n: 3 });
    expect(hashBytes(readFileSync(join(root, "plan.md")))).toBe(binding.planDigest);
  });
});
