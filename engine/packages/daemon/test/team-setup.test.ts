import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, fixDaemonMode } from "../src/domain/plan-governance.js";
import { addTeamSeats, createTeam } from "../src/domain/team-setup.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { createTestApp } from "./helpers/test-app.js";
import { listChatMessages, leadChatTurnNote, takeOwnerMessages } from "../src/domain/lead-chat.js";
import { ownerWorkflowCommand, unassignedOwnerWorkflows } from "../src/domain/team-workflows.js";
import { shortPath } from "./helpers/short-path.js";

/**
 * U3 — the owner creates a team for any local git repository.
 *
 * Everything here goes through the real route and the real repositories against repositories on
 * disk: the rig, its nodes and its sessions are the endpoint's own rows, and the seats a start
 * routes to are read back from the database rather than from the response, which deliberately
 * carries no internal names.
 */

const ownerToken = "owner-team-fixture";
const workerToken = "worker-team-fixture";
const policy = unisolatedPolicyCapability(4);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}


/** A repository on disk with one commit; `commit: false` leaves it with none. */
function repository(parent: string, name = "project", commit = true): string {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan\n");
  if (commit) {
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "base");
  }
  // The long form: a Windows `%TEMP%` may be an 8.3 short name, and the route records the long
  // spelling Git reports, so both sides of every comparison start from this one.
  return realpathSync.native(root);
}

const defaultSeats = [
  { role: "lead", client: "claude-code" },
  { role: "implementer", client: "claude-code" },
  { role: "implementer", client: "codex" },
  { role: "reviewer", client: "claude-code" },
];

interface Created { team: { id: string; name: string; repository: string; seats: unknown[] } }

describe("U3 — the owner creates a team", () => {
  let directory: string, db: Database.Database, governance: PlanGovernance, dispatch: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof createTestApp>["app"];

  const call = (path: string, init: RequestInit = {}, token: string | null = ownerToken) => app.request(path, {
    ...init, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
  }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const create = (body: unknown, token: string | null = ownerToken) =>
    call("/api/team-control/teams", { method: "POST", body: JSON.stringify(body) }, token);
  const start = (body: unknown) => call("/api/team-control/runs", { method: "POST", body: JSON.stringify(body) });

  const seatsOf = (rigId: string) => db.prepare(
    `SELECT n.role AS role, n.runtime AS client, s.session_name AS seat
      FROM nodes n JOIN sessions s ON s.node_id = n.id WHERE n.rig_id = ? ORDER BY n.logical_id`).all(rigId) as
    Array<{ role: string; client: string; seat: string }>;

  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "u3-team-")));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    fixDaemonMode(db, true);
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => policy);
    dispatch = vi.fn(async () => {});
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      teamControl: { credentials: { ownerToken, workers: [{ token: workerToken, sessionId: "dev@demo", runId: "other" }] },
        readPolicyCapability: () => policy, planWorktreeRoot: () => join(directory, "plans"),
        dispatch: dispatch as unknown as (runId: string, taskId: string) => Promise<void> } } }).app;
  });

  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("serves and versions specialist profiles only through owner controls", async () => {
    const team = createTeam(db, { repository: repository(directory), seats: defaultSeats as import("../src/domain/team-setup.js").TeamSeatInput[] });
    const path = `/api/team-control/teams/${team.id}/souls`;
    const initial = await call(path);
    expect(initial.status).toBe(200);
    const data = await initial.json() as { profiles: Array<{ id: string; version: number }>; seats: Array<{ nodeId: string; role: string }> };
    expect(data.profiles.find(item => item.id === "frontend")?.version).toBe(1);
    expect((await call(path, {}, workerToken)).status).toBe(403);
    const body = { expectedVersion: 1, name: "Project frontend", roles: ["implementer"], content: "Verify keyboard navigation." };
    expect((await call(path + "/frontend", { method: "PUT", body: JSON.stringify(body) }, workerToken)).status).toBe(403);
    const saved = await call(path + "/frontend", { method: "PUT", body: JSON.stringify(body) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ profile: { id: "frontend", version: 2, content: body.content } });
    expect((await call(path + "/frontend", { method: "PUT", body: JSON.stringify(body) })).status).toBe(409);
    const seat = data.seats.find(item => item.role === "implementer")!;
    const assigned = await call(`/api/team-control/teams/${team.id}/seats/${seat.nodeId}/soul`,
      { method: "PUT", body: JSON.stringify({ soulId: "frontend" }) });
    expect(assigned.status).toBe(200);
    expect(db.prepare("SELECT soul_id FROM nodes WHERE id = ?").get(seat.nodeId)).toEqual({ soul_id: "frontend" });
  });

  it("exposes all workflows and records explicit owner provenance without accepting a forged origin", async () => {
    const team = createTeam(db, { repository: repository(directory), seats: defaultSeats as import("../src/domain/team-setup.js").TeamSeatInput[] });
    const catalog = await call("/api/team-control/workflows");
    expect(catalog.status).toBe(200);
    expect((await catalog.json() as { workflows: unknown[] }).workflows).toHaveLength(38);
    expect((await call("/api/team-control/workflows", {}, workerToken)).status).toBe(403);
    const response = await start({ rig: team.id, goal: "Explain the design", workflow: { entrypoint: "spec-explain", readOnly: true } });
    expect(response.status).toBe(201);
    const run = await response.json() as { runId: string };
    expect(governance.findTask(run.runId, "task-1")?.workflow).toBeNull();
    const message = listChatMessages(db, run.runId)[0]!;
    expect(message).toMatchObject({ sender: "owner", body: "/spec-explain --read-only\nExplain the design" });
    expect(leadChatTurnNote([message], [])).toContain(message.id);
    takeOwnerMessages(db, run.runId, "first-chat-turn");
    expect(leadChatTurnNote([], [], unassignedOwnerWorkflows(db, run.runId))).toContain(message.id);
    const current = governance.getRun(run.runId);
    const assigned = governance.admitLeadProposal({ protocolVersion: "1.0", runId: current.id,
      actionId: "workflow-request", expectedEntityVersion: current.entityVersion, idempotencyKey: "workflow-request", payload: {} },
    { kind: "daemon", sessionId: "daemon" }, current.binding, [{ taskId: "explain", seat: "impl-1@project", paths: ["src"],
      dependencies: [], body: "Explain the design", workflow: { ...ownerWorkflowCommand(message.body)!, ownerMessageId: message.id } }]);
    expect(assigned.status, assigned.reason).toBe("accepted");
    expect(governance.findTask(run.runId, "explain")?.workflow).toMatchObject({ entrypoint: "spec-explain", origin: "user",
      readOnly: true, ownerMessageId: message.id, input: "Explain the design" });
    expect(leadChatTurnNote([], [], unassignedOwnerWorkflows(db, run.runId))).toBeNull();
    const forbidden = await start({ rig: team.id, goal: "Run a caller helper", workflow: { entrypoint: "spec-commit" } });
    expect(forbidden.status).toBe(403);
    expect((await start({ rig: team.id, goal: "Spoof", workflow: { entrypoint: "spec-work", origin: "caller" } })).status).toBe(400);
  });

  it("keeps an initial workflow request out of the long-lived planning task", async () => {
    const team = createTeam(db, { repository: repository(directory), seats: defaultSeats as import("../src/domain/team-setup.js").TeamSeatInput[] });
    const response = await start({ rig: team.id, goal: "Plan the next change", planning: true,
      workflow: { entrypoint: "spec-code-review", input: "Inspect the current interface." } });
    expect(response.status).toBe(201);
    const { runId } = await response.json() as { runId: string };
    expect(governance.findTask(runId, "task-1")).toMatchObject({ assignment: { role: "lead" }, workflow: null });
    expect(governance.getRun(runId).phase).toBe("planning");
    expect(listChatMessages(db, runId)).toMatchObject([{ sender: "owner",
      body: "/spec-code-review --read-only\nInspect the current interface." }]);
    expect(governance.workflowOutcomes(runId)).toEqual([]);
  });

  it.each([
    { name: "maximum explicit input", goal: "Evaluate the design", input: "x".repeat(65_536), readOnly: true },
    { name: "maximum fallback goal", goal: "g".repeat(65_536), input: undefined, readOnly: false },
    { name: "explicitly empty input", goal: "Keep the input empty", input: "", readOnly: false },
  ])("preserves $name when recording an initial workflow request", async ({ goal, input, readOnly }) => {
    const team = createTeam(db, { repository: repository(directory), seats: defaultSeats as import("../src/domain/team-setup.js").TeamSeatInput[] });
    const response = await start({ rig: team.id, goal, workflow: { entrypoint: "spec-pov", input, readOnly } });
    expect(response.status, await response.clone().text()).toBe(201);
    const { runId } = await response.json() as { runId: string };
    const messages = listChatMessages(db, runId);
    expect(messages).toHaveLength(1);
    const expectedInput = input ?? goal;
    expect(messages[0]!.body).toBe(`/spec-pov${readOnly ? " --read-only" : ""}\n${expectedInput}`);
    expect(ownerWorkflowCommand(messages[0]!.body)).toEqual({ entrypoint: "spec-pov", input: expectedInput, readOnly });
  });

  it.each([
    { name: "oversized explicit input", goal: "Evaluate the design", input: "x".repeat(65_537) },
    { name: "oversized fallback goal", goal: "g".repeat(65_537), input: undefined },
  ])("rejects $name before recording an initial workflow request", async ({ goal, input }) => {
    const team = createTeam(db, { repository: repository(directory), seats: defaultSeats as import("../src/domain/team-setup.js").TeamSeatInput[] });
    const response = await start({ rig: team.id, goal, workflow: { entrypoint: "spec-pov", input } });
    expect(response.status).toBe(400);
    expect(db.prepare("SELECT count(*) AS count FROM team_chat_messages").get()).toEqual({ count: 0 });
  });

  it.each([
    { path: "/api/team-control/teams", method: "POST" },
    { path: "/api/team-control/teams/unknown/souls/frontend", method: "PUT" },
  ])("retains the team request body limit on $method $path", async ({ path, method }) => {
    const body = JSON.stringify({ content: "x".repeat(65_536) });
    const response = await app.request(path, { method, body, headers: {
      "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), Authorization: "Bearer " + ownerToken,
    } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "invalid_team_contract", error: "The team request exceeds its size limit." });
    expect(db.prepare("SELECT count(*) AS count FROM rigs").get()).toEqual({ count: 0 });
  });

  it("preserves recorded conversations and their constraints when adding workflow header storage", async () => {
    const team = createTeam(db, { repository: repository(directory), seats: defaultSeats as import("../src/domain/team-setup.js").TeamSeatInput[] });
    const { runId } = await (await start({ rig: team.id, goal: "Preserve the conversation" })).json() as { runId: string };
    const legacy = createDb();
    try {
      migrate(legacy, ALL_MIGRATIONS.slice(0, ALL_MIGRATIONS.findIndex(migration => migration.name === "121_workflow_souls.sql")));
      legacy.prepare("INSERT INTO rigs (id, name) VALUES (?, 'project')").run(team.id);
      const historicalColumns = (legacy.prepare("PRAGMA table_info(team_runs)").all() as Array<{ name: string }>).map(column => column.name);
      const current = db.prepare("SELECT * FROM team_runs WHERE id = ?").get(runId) as Record<string, unknown>;
      legacy.prepare(`INSERT INTO team_runs (${historicalColumns.join(", ")}) VALUES (${historicalColumns.map(() => "?").join(", ")})`)
        .run(...historicalColumns.map(column => current[column]));
      const insert = legacy.prepare(`INSERT INTO team_chat_messages
        (rowid, id, run_id, sender, body, attempt_id, delivered_attempt, created_at, kind, options_json, answered_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(7, "owner-message", runId, "owner", "Consider these constraints", null, "lead-turn", "2026-01-01T00:00:00Z", "text", null, null);
      insert.run(19, "decision", runId, "lead", "Choose an approach", "lead-turn", null, "2026-01-01T00:00:01Z", "decision", '["A","B"]', "answer");
      insert.run(23, "answer", runId, "owner", "Use A", null, null, "2026-01-01T00:00:02Z", "confirmation", null, null);
      const before = legacy.prepare("SELECT rowid, * FROM team_chat_messages ORDER BY rowid").all();
      migrate(legacy, ALL_MIGRATIONS);
      expect(legacy.prepare("SELECT rowid, * FROM team_chat_messages ORDER BY rowid").all()).toEqual((before as Record<string, unknown>[]).map(row => ({ ...row, response_language: null })));
      expect(legacy.prepare("SELECT response_language FROM team_runs WHERE id = ?").get(runId)).toEqual({ response_language: null });
      expect(() => legacy.prepare("UPDATE team_runs SET response_language = 'invalid' WHERE id = ?").run(runId)).toThrow(/CHECK/);
      expect(() => legacy.prepare("UPDATE team_chat_messages SET response_language = 'invalid'").run()).toThrow(/CHECK/);
      expect(legacy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const append = legacy.prepare(`INSERT INTO team_chat_messages (id, run_id, sender, body, attempt_id, created_at)
        VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:03Z')`);
      expect(() => append.run("duplicate", runId, "lead", "Repeated", "lead-turn")).toThrow(/UNIQUE/);
      expect(() => append.run("too-long", runId, "owner", "x".repeat(65_537), null)).toThrow(/CHECK/);
      expect(() => append.run(runId + ":initial", runId, "lead", "x".repeat(65_537), "another-turn")).toThrow(/CHECK/);
      expect(() => append.run(runId + ":initial", runId, "owner", "x".repeat(65_793), null)).toThrow(/CHECK/);
      expect(() => append.run(runId + ":initial", runId, "owner", "/spec-pov\n" + "x".repeat(65_536), null)).not.toThrow();
    } finally { legacy.close(); }
  });

  it("creates one rig with the requested seats, and returns roles and clients rather than seat names", async () => {
    const root = repository(directory);
    const response = await create({ repository: root, seats: defaultSeats });
    expect(response.status).toBe(201);
    const body = await response.json() as Created;
    expect(body.team).toEqual({ id: expect.any(String), name: "project", kind: "project", repository: root, seats: defaultSeats });
    // The seat names are the daemon's own business: a tmux session name, not part of the contract.
    expect(JSON.stringify(body.team)).not.toContain("@project");

    const seats = seatsOf(body.team.id);
    expect(seats).toEqual([
      { role: "implementer", client: "claude-code", seat: "impl-1@project" },
      { role: "implementer", client: "codex", seat: "impl-2@project" },
      { role: "lead", client: "claude-code", seat: "lead-1@project" },
      { role: "reviewer", client: "claude-code", seat: "review-1@project" },
    ]);
    expect(new Set(seats.map(seat => seat.seat)).size).toBe(seats.length);
  });

  it("accepts a native Windows root, which the boundary previously refused", async () => {
    // R15 — a Windows daemon's own root is `C:\…`; the route must accept the shape this host
    // uses, not only a leading `/`. On POSIX the host's absolute shape is `/`, so this test runs
    // the same assertion on both: the canonical root the team records is the one Git reports.
    const root = repository(directory);
    const response = await create({ repository: root, seats: defaultSeats });
    expect(response.status).toBe(201);
    expect((await response.json() as Created).team.repository).toBe(root);
    expect(root).toBe(realpathSync.native(root));
  });

  it("records the long spelling of a repository named through its 8.3 short form", async () => {
    // GitHub's Windows runner hands `%TEMP%` as `C:\Users\RUNNER~1\…`, so an owner's root can
    // arrive in the short spelling while Git answers in the long one. The team must record one
    // spelling, and a second create through either must find that same team rather than a second.
    if (process.platform !== "win32") return;
    const long = repository(directory, "project-with-a-long-name");
    const short = shortPath(long);
    if (short === null) return; // This volume does not generate 8.3 names; the CI runner's does.
    expect(short).not.toBe(long);

    const created = await create({ repository: short, seats: defaultSeats });
    expect(created.status).toBe(201);
    expect((await created.json() as Created).team.repository).toBe(long);

    const again = await create({ repository: long, seats: defaultSeats });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "team_exists" });
  });

  it("refuses a relative repository and a path that is not absolute on this host", async () => {
    for (const repository of ["project", "C:project", "\\project"]) {
      const response = await create({ repository, seats: defaultSeats });
      expect(response.status, repository).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_team_contract" });
    }
  });

  it("makes a repeated folder name unique, so a second repository is still a team", async () => {
    const first = await (await create({ repository: repository(join(directory, "one"), "project"), seats: defaultSeats })).json() as Created;
    const second = await (await create({ repository: repository(join(directory, "two"), "project"), seats: defaultSeats })).json() as Created;
    expect([first.team.name, second.team.name]).toEqual(["project", "project-2"]);
    expect(seatsOf(second.team.id).every(seat => seat.seat.endsWith("@project-2"))).toBe(true);
  });

  it("refuses a path that is not a git repository, and one with no commit", async () => {
    const plain = join(directory, "plain");
    mkdirSync(plain);
    const notGit = await create({ repository: plain, seats: defaultSeats });
    expect(notGit.status).toBe(400);
    expect(await notGit.json()).toMatchObject({ code: "team_repository_not_git" });
    const noCommit = await create({ repository: repository(directory, "empty", false), seats: defaultSeats });
    expect(noCommit.status).toBe(400);
    expect(await noCommit.json()).toMatchObject({ code: "team_repository_no_commit" });
    expect(db.prepare("SELECT count(*) AS count FROM rigs").get()).toEqual({ count: 0 });
  });

  it("refuses a second team on the same repository root, including through a subdirectory", async () => {
    const root = repository(directory);
    expect((await create({ repository: root, seats: defaultSeats })).status).toBe(201);
    const again = await create({ repository: join(root, "src"), seats: defaultSeats, name: "another" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "team_exists" });
    expect(db.prepare("SELECT count(*) AS count FROM rigs").get()).toEqual({ count: 1 });
  });

  it("refuses a seat list the daemon cannot run, and creates nothing", async () => {
    const root = repository(directory);
    const noSeats = await create({ repository: root, seats: [] });
    expect(noSeats.status).toBe(400);
    const unknown = await create({ repository: root, seats: [{ role: "lead", client: "gpt" }] });
    expect(unknown.status).toBe(400);
    // Two leads would make the start's default ambiguous, which is what the role default resolves.
    const twoLeads = await create({ repository: root, seats: [{ role: "lead", client: "claude-code" },
      { role: "lead", client: "claude-code" }, { role: "implementer", client: "claude-code" }] });
    expect(twoLeads.status).toBe(400);
    expect(await twoLeads.json()).toMatchObject({ code: "team_seats_invalid" });
    expect(db.prepare("SELECT count(*) AS count FROM rigs").get()).toEqual({ count: 0 });
  });

  it("carries a seat's model, the one per-launch setting this slice passes through", async () => {
    const root = repository(directory);
    const seats = [{ role: "implementer", client: "claude-code", model: "claude-opus-4" },
      { role: "reviewer", client: "codex" }];
    const created = await (await create({ repository: root, seats })).json() as Created;
    expect(created.team.seats).toEqual(seats);
    expect(db.prepare("SELECT model FROM nodes WHERE role = 'implementer'").get()).toEqual({ model: "claude-opus-4" });
  });

  it("refuses the create for a worker credential, and creates nothing", async () => {
    const root = repository(directory);
    expect((await create({ repository: root, seats: defaultSeats }, workerToken)).status).toBe(403);
    expect((await create({ repository: root, seats: defaultSeats }, null)).status).toBe(401);
    expect((await call("/api/team-control/teams", {}, workerToken)).status).toBe(403);
    expect(db.prepare("SELECT count(*) AS count FROM rigs").get()).toEqual({ count: 0 });
  });

  it("lists the teams with their seats", async () => {
    const root = repository(directory);
    const created = await (await create({ repository: root, seats: defaultSeats })).json() as Created;
    const response = await call("/api/team-control/teams");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocolVersion: "1.0",
      teams: [{ id: created.team.id, name: "project", kind: "project", repository: root, seats: defaultSeats }] });
  });

  it("starts work on the team's lead and reviewer without the owner naming a seat", async () => {
    const created = await (await create({ repository: repository(directory), seats: defaultSeats })).json() as Created;
    const response = await start({ goal: "Add a health endpoint", rig: "project" });
    expect(response.status).toBe(201);
    const receipt = await response.json() as Record<string, string>;
    expect(receipt).toMatchObject({ rigId: created.team.id, seat: "lead-1@project",
      leadSeat: "lead-1@project", reviewerSeat: "review-1@project" });
    expect(governance.findTask(receipt.runId!, "task-1")!.assignment.role).toBe("lead");
    // The repository the run approves is the team's own, not a guess: nothing was passed here.
    expect(governance.getRun(receipt.runId!).binding.repository.root).toBe(created.team.repository);
  });

  it("selects the active replacement reviewer for a future run and retains retired history", async () => {
    const created = await (await create({ repository: repository(directory), seats: defaultSeats })).json() as Created;
    db.prepare("UPDATE nodes SET retired_at = CURRENT_TIMESTAMP WHERE rig_id = ? AND role = 'reviewer'").run(created.team.id);
    expect(addTeamSeats(db, created.team.id, [{ role: "reviewer", client: "codex" }])[0]!.member).toBe("review-2@project");
    const response = await start({ goal: "Add a health endpoint", rig: "project" });
    expect(response.status).toBe(201);
    const receipt = await response.json() as Record<string, string>;
    expect(receipt.reviewerSeat).toBe("review-2@project");
    expect(governance.getRun(receipt.runId!).reviewerSeat).toBe("review-2@project");
    expect(seatsOf(created.team.id).filter(seat => seat.role === "reviewer").map(seat => seat.seat))
      .toEqual(["review-1@project", "review-2@project"]);
    const listed = await (await call("/api/team-control/teams")).json() as { teams: Array<{ seats: Array<{ role: string; client: string }> }> };
    expect(listed.teams[0]!.seats.filter(seat => seat.role === "reviewer")).toEqual([{ role: "reviewer", client: "codex" }]);
  });

  it("keeps the pre-team start on a rig with no lead or reviewer role", async () => {
    const root = repository(directory, "plain-repo");
    db.prepare("INSERT INTO rigs (id, name) VALUES ('plain', 'plain')").run();
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES ('n1', 'plain', 'dev', 'implementer', 'claude-code', ?)`)
      .run(root);
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('s1', 'n1', 'dev@plain')").run();
    const receipt = await (await start({ goal: "Add a health endpoint", rig: "plain" })).json() as Record<string, string>;
    expect(receipt).toMatchObject({ seat: "dev@plain", leadSeat: null, reviewerSeat: null });
  });

  it("keeps explicit lead and reviewer seats on a team", async () => {
    await create({ repository: repository(directory), seats: defaultSeats });
    const response = await start({ goal: "Add a health endpoint", rig: "project",
      lead: "impl-1@project", reviewerSeat: "impl-2@project" });
    expect(response.status).toBe(201);
    expect(await response.json() as Record<string, string>).toMatchObject({
      seat: "impl-1@project", leadSeat: "impl-1@project", reviewerSeat: "impl-2@project" });
  });

  it("starts the run on the implementer seat of a team that has no lead", async () => {
    const root = repository(directory);
    const created = await (await create({ repository: root,
      seats: [{ role: "implementer", client: "claude-code" }] })).json() as Created;
    const response = await start({ goal: "Implement the assigned module", rig: created.team.name });
    expect(response.status).toBe(201);
    const receipt = await response.json() as Record<string, string>;
    expect(receipt).toMatchObject({ seat: "impl-1@project", leadSeat: null });
    expect(dispatch).toHaveBeenCalledWith(receipt.runId, "task-1");
  });

  it("creates the same shape through the domain function the demo seeds call", () => {
    const root = repository(directory);
    const team = createTeam(db, { repository: root, seats: [{ role: "implementer", client: "claude-code" },
      { role: "reviewer", client: "claude-code" }] });
    expect(team).toEqual({ id: expect.any(String), name: "project", kind: "project", repository: root,
      seats: [{ role: "implementer", client: "claude-code" }, { role: "reviewer", client: "claude-code" }] });
    expect(seatsOf(team.id).map(seat => seat.seat)).toEqual(["impl-1@project", "review-1@project"]);
  });
});
