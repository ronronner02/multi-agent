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
  return realpathSync(root);
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
    directory = realpathSync(mkdtempSync(join(tmpdir(), "u3-team-")));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    fixDaemonMode(db, true);
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => policy);
    dispatch = vi.fn(async () => {});
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      teamControl: { credentials: { ownerToken, workers: [{ token: workerToken, sessionId: "dev@demo", runId: "other" }] },
        readPolicyCapability: () => policy, dispatch: dispatch as unknown as (runId: string, taskId: string) => Promise<void> } } }).app;
  });

  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("creates one rig with the requested seats, and returns roles and clients rather than seat names", async () => {
    const root = repository(directory);
    const response = await create({ repository: root, seats: defaultSeats });
    expect(response.status).toBe(201);
    const body = await response.json() as Created;
    expect(body.team).toEqual({ id: expect.any(String), name: "project", repository: root, seats: defaultSeats });
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
      teams: [{ id: created.team.id, name: "project", repository: root, seats: defaultSeats }] });
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
    expect(team).toEqual({ id: expect.any(String), name: "project", repository: root,
      seats: [{ role: "implementer", client: "claude-code" }, { role: "reviewer", client: "claude-code" }] });
    expect(seatsOf(team.id).map(seat => seat.seat)).toEqual(["impl-1@project", "review-1@project"]);
  });
});
