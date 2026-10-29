import { afterEach, expect, it } from "vitest";
import { CATALOGS } from "@openrig/i18n";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { DaemonClient } from "../src/daemon-client.js";
import { createTeamLive } from "../src/live.js";
import { hydrateTeam } from "../src/hydrate.js";
import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { PlanGovernance, fixDaemonMode } from "../../daemon/src/domain/plan-governance.js";
import { TeamReadModel } from "../../daemon/src/team-control-surface.js";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import type { PlanBinding } from "../../daemon/src/contracts/team-control.js";

it.each(["zh-CN", "en"] as const)("renders %s log controls inert while preserving stream, attempt and exit identity", language => {
  const snapshot = demoSnapshot(true), data = snapshot.team!;
  data.logs[0]!.text = "\x1b]52;c;clipboard\x07\x1b[2J\u202e inert text";
  const state = createViewState({ instanceId: "logs", team: { language }, getSnapshot: () => snapshot }).get();
  const screen = renderScreen({ ...state, team: { ...state.team!, page: "logs" } }, snapshot, { cols: 90, rows: 30 });
  const text = screen.lines.join("\n");
  expect(screen.lines.every(line => !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(line))).toBe(true);
  expect(text).toContain("ERROR err TASK-001/attempt-1");
  expect(text).toContain(`${CATALOGS[language]["team.exit"]}=1`);
  for (const key of ["redacted", "truncated", "gap"] as const) expect(text).toContain(CATALOGS[language][`team.${key}`]);
});

it("keeps unavailable reviews and unknown health distinct from pass and verified progress", () => {
  const snapshot = demoSnapshot(true), task = snapshot.team!.tasks[0]!;
  const state = createViewState({ instanceId: "gate", team: { language: "en" }, getSnapshot: () => snapshot }).get();
  for (const reviews of [[], [{ reviewer: "Reviewer C", state: "crashed", finding: null }]]) {
    task.reviews = reviews;
    const text = renderScreen({ ...state, team: { ...state.team!, page: "reviews" } }, snapshot, { cols: 90, rows: 30 }).lines.join("\n");
    expect(text).toContain("Unavailable");
    expect(text).not.toContain("Passed");
  }
  task.criteria[0]!.evidence = null;
  const text = renderScreen(state, snapshot, { cols: 90, rows: 30 }).lines.join("\n");
  expect(text).toContain("0/3");
  for (const connection of ["connected", "stale", "disconnected", "unavailable"] as const) {
    snapshot.team!.connection = connection;
    const screen = renderScreen({ ...state, team: { ...state.team!, page: "agents", sideTab: "system" } }, snapshot, { cols: 90, rows: 30 });
    expect(screen.lines.join("\n")).toContain("Unknown");
    expect(screen.lines.join("\n")).not.toContain("Healthy");
    expect(screen.hitMap).toEqual([]);
    expect(screen.contentTargets).toEqual([]);
  }
});

const databases: Array<ReturnType<typeof createDb>> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function managedRead(withTask = false) {
  const db = createDb();
  databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  fixDaemonMode(db, true);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('managed-rig', 'managed')").run();
  const bus = new EventBus(db), queue = new QueueRepository(db, bus);
  const binding: PlanBinding = {
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "docs/plan.md", planDigest: "sha256:" + "a".repeat(64),
    repository: { root: "/workspace/project", identity: "git:" + "b".repeat(40) },
    readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
    policyRevision: 1, policyFingerprint: "sha256:" + "c".repeat(64),
    limits: { maxSessions: 3, maxActiveMs: 3600000, maxRetries: 1, maxReviewRounds: 2 },
  };
  const governance = new PlanGovernance(db, bus, queue, undefined, () => ({
    policyRevision: 1, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"],
  }));
  governance.createRun({ id: "run", rigId: "managed-rig", binding });
  let key = 0, qitemId: string | null = null;
  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "fixture-" + key++, payload });
  if (withTask) {
    const digest = governance.getRun("run").bindingDigest, owner = { kind: "owner" as const, sessionId: "owner" };
    expect(governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: digest }, targetDigest: digest, expiresAt: "2099-01-01T00:00:00.000Z" }), owner).status).toBe("accepted");
    expect(governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }), owner, binding).status).toBe("accepted");
    const created = governance.createTask(command("TASK-READ", {
      assignment: { taskId: "TASK-READ", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead", destinationSession: "seat-read", body: "Managed task",
    }), binding);
    expect(created.status).toBe("accepted");
    qitemId = (created.value as { qitemId: string }).qitemId;
  }
  const model = new TeamReadModel({ db, governance, events: bus, readTaskRows: runId => db.prepare(
    "SELECT a.qitem_id AS qitemId, a.task_id AS taskId, json_extract(a.assignment_json, '$.role') AS role, " +
    "q.state AS queueState, q.destination_session AS session FROM team_queue_authority a " +
    "JOIN queue_items q ON q.qitem_id = a.qitem_id WHERE a.run_id = ? ORDER BY a.task_id").all(runId) as never[] });
  const app = createTestApp(db, { appDeps: { queueRepo: queue, eventBus: bus,
    teamControl: { credentials: { ownerToken: "owner-read", workers: [{ token: "worker-read", sessionId: "worker", runId: "run" }] },
      readModel: model } } }).app;
  const fetchImpl: typeof fetch = async (input, init) => app.request(String(input), init,
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const client = (token = "owner-read") => new DaemonClient({ baseUrl: "http://localhost", fetchImpl,
    headers: token ? { Authorization: "Bearer " + token } : {} });
  return { db, bus, governance, model, app, fetchImpl, client, command, binding, qitemId };
}

it("consumes the composed owner read, replay and health without admitting a worker or legacy token", async () => {
  const fixture = managedRead(), client = fixture.client();
  const read = await client.teamRead("run");
  expect(read.schema).toBe("multi-agent-team-read/v1");
  expect(read.runId).toBe("run");
  expect(read.run).toEqual(fixture.governance.getRun("run"));
  const replay = await client.teamReplay("run", 0);
  expect(replay.window).toEqual(read.replay);
  expect((await client.teamHealth()).overall).toBe("unknown");
  for (const [token, status] of [["worker-read", 403], ["", 401], ["legacy-terminal", 401]] as const)
    await expect(fixture.client(token).teamRead("run")).rejects.toThrow(String(status));
});

it("recovers the exact run from 1,000 durable events within two seconds and deduplicates replay", async () => {
  const fixture = managedRead(true);
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await fixture.fetchImpl(input, init);
    return String(input).includes("/events/stream") ? new Response(response.body!.pipeThrough(new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); controller.enqueue(chunk); },
    })), { headers: response.headers }) : response;
  };
  const client = new DaemonClient({ baseUrl: "http://localhost", fetchImpl, headers: { Authorization: "Bearer owner-read" } });
  const live = createTeamLive(client, "run", () => {});
  try {
    await expect.poll(() => live.snapshot().team?.connection).toBe("connected");
    expect(live.snapshot().team!.tasks[0]!.state).toBe("pending");
    const start = performance.now(), before = fixture.bus.replayWindow().latestSeq;
    expect(fixture.governance.transitionTask(fixture.command(fixture.qitemId!, {
      expectedTaskVersion: 1, actorSession: "seat-read", state: "in-progress" }),
      fixture.binding).status).toBe("accepted");
    const transitions = fixture.bus.replayRunSince("run", before, 2000).length;
    for (let i = transitions; i < 999; i++) fixture.bus.emit({
      type: "team.control", protocolVersion: "1.0", eventId: "event-" + i, rigId: "managed-rig",
      runId: "run", taskId: "TASK-READ", attemptId: "attempt-read", entityId: "run", entityVersion: i,
      action: "fixture.update", payload: { agentPercentage: 100, message: "event " + i },
    });
    fixture.governance.cancelRun({ protocolVersion: "1.0", runId: "run", actionId: "cancel",
      expectedEntityVersion: fixture.governance.getRun("run").entityVersion, idempotencyKey: "cancel",
      payload: { reason: "Observed final decision" } }, { kind: "owner", sessionId: "owner" });
    const last = fixture.bus.replayWindow().latestSeq;
    expect(fixture.bus.replayRunSince("run", before, 2000)).toHaveLength(1000);
    await expect.poll(() => live.snapshot().team?.activity.at(-1)?.seq, { interval: 5 }).toBe(last);
    await live.tick();
    const result = live.snapshot().team!;
    expect(result.read!.run).toEqual(fixture.governance.getRun("run"));
    expect(result.read!.run.state).toBe("cancel_requested");
    const expected = fixture.model.read("run");
    const { controlVersions, ...projected } = result.read!;
    expect({ ...projected, generatedAt: expected.generatedAt }).toEqual(expected);
    expect(controlVersions).toEqual({
      tasks: { [fixture.qitemId!]: fixture.governance.getTask(fixture.qitemId!)!.entityVersion },
      attempts: {}, latestAttempts: {},
    });
    expect(result.tasks[0]).toMatchObject({ id: "TASK-READ", state: "in-progress" });
    expect(result.read!.replay.latestSeq).toBe(last);
    expect(result.activity).toHaveLength(200);
    expect(new Set(result.activity.map(event => event.seq)).size).toBe(200);
    expect(result.activity[0]!.text).toContain("attempt-read");
    expect(performance.now() - start).toBeLessThan(2000);
  } finally { live.close(); }
});

it("keeps missing evidence unavailable and renders shared log identities and final decisions", async () => {
  const read = await managedRead().client().teamRead("run");
  read.tasks = [{ taskId: "TASK-READ", qitemId: "q-read", role: "implementer", queueState: "in-progress",
    criteria: { verified: null, total: null, source: null }, currentCandidateDigest: null,
    rounds: 0, openP0P1: 0, reviewAvailable: false, acceptance: null }];
  read.attempts = [{ attemptId: "attempt-read", runId: "run", taskId: "TASK-READ", qitemId: "q-read",
    role: "implementer", provider: "codex", state: "stopped", unknownReason: null, session: "seat-read" }];
  read.logs = [{ source: "stream", streamItemId: "stream-read", ts: "17:30:00", runId: "run",
    taskId: "TASK-READ", attemptId: "attempt-read", session: "seat-read",
    body: "stderr: [REDACTED] \u001b[2J failure", truncated: true, exitOutcome: "failed" }];
  read.workflow.stages[6]!.state = "complete";
  const snapshot = { ...demoSnapshot(false), team: hydrateTeam(read, null, [], true) };
  const view = createViewState({ instanceId: "read", team: { language: "en" }, getSnapshot: () => snapshot }).get();
  let text = renderScreen(view, snapshot, { cols: 160, rows: 46 }).lines.join("\n");
  for (const invented of ["0/0", "P0", "Pnull", "Passed"]) expect(text).not.toContain(invented);
  expect(snapshot.team.cost).toBeNull();
  expect(snapshot.team.tokens).toBeNull();
  expect(snapshot.team.systems.every(light => light.state === "unknown")).toBe(true);
  expect(text).toContain("Finalize: Completed");
  read.tasks[0]!.criteria = { verified: 3, total: 4, source: "candidate-read" };
  snapshot.team = hydrateTeam(read, null, [], true);
  text = renderScreen(view, snapshot, { cols: 160, rows: 46 }).lines.join("\n");
  expect(text).toContain("3/4");
  text = renderScreen({ ...view, team: { ...view.team!, page: "logs" } }, snapshot, { cols: 90, rows: 30 }).lines.join("\n");
  for (const part of ["stream", "TASK-READ/attempt-read", "exit=failed", "stderr:",
    CATALOGS.en["team.redacted"], CATALOGS.en["team.truncated"], CATALOGS.en["team.gap"]]) expect(text).toContain(part);
  expect(text).not.toContain("\u001b");
});

it.each(["zh-CN", "en"] as const)("shows the %s open-session notice for durable native requests", async language => {
  const fixture = managedRead(), targetDigest = fixture.governance.getRun("run").bindingDigest;
  expect(fixture.governance.requestApproval(fixture.command("native-request", {
    kind: "orchestrator", action: "implementation", payload: { bindingDigest: targetDigest }, targetDigest, expiresAt: "2099-01-01T00:00:00.000Z",
  }), { kind: "owner", sessionId: "owner" }).status).toBe("accepted");
  // Current handlers reject new native approvals; inherited rows remain part of the read contract.
  fixture.db.prepare("UPDATE team_approvals SET kind = 'native', action = 'native-tool' WHERE id = 'native-request'").run();
  const read = await fixture.client().teamRead("run");
  expect(read.approvals[0]).toMatchObject({ kind: "native", awaitingDecision: true });
  const snapshot = { ...demoSnapshot(false), team: hydrateTeam(read, null, [], false) };
  const view = createViewState({ instanceId: "native", team: { language }, getSnapshot: () => snapshot }).get();
  for (const [cols, rows] of [[160, 46], [90, 30]] as const) {
    const screen = renderScreen({ ...view, team: { ...view.team!, page: "reviews" } }, snapshot, { cols, rows });
    expect(screen.lines.join("\n")).toContain(CATALOGS[language]["team.native"]);
    expect(screen.hitMap).toEqual([]);
  }
});

it("shows source staleness and disconnects, recovers a retention gap and stops work on close", async () => {
  const fixture = managedRead();
  let clock = Date.now(), opened = 0, frames = 0, closeStream!: ReadableStreamDefaultController<Uint8Array>;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).includes("/events/stream") && ++opened === 1)
      return new Response(new ReadableStream({ start(controller) { closeStream = controller; } }),
        { headers: { "Content-Type": "text/event-stream" } });
    const response = await fixture.fetchImpl(input, init);
    if (!String(input).endsWith("/read")) return response;
    const result = await response.json();
    result.read.generatedAt = new Date(clock - 4000).toISOString();
    return Response.json(result);
  };
  const client = new DaemonClient({ baseUrl: "http://localhost", fetchImpl, headers: { Authorization: "Bearer owner-read" } });
  const live = createTeamLive(client, "run", () => { frames++; }, () => clock);
  try {
    await expect.poll(() => live.snapshot().team?.connection).toBe("connected");
    clock += 2000;
    expect(live.snapshot().team?.connection).toBe("stale");
    for (let i = 0; i < 12; i++) fixture.bus.emit({
      type: "team.control", protocolVersion: "1.0", eventId: "gap-" + i, rigId: "managed-rig",
      runId: "run", taskId: null, attemptId: null, entityId: "run", entityVersion: i, action: "fixture.update", payload: {},
    });
    fixture.db.prepare("DELETE FROM events WHERE seq < ?").run(fixture.bus.replayWindow().latestSeq - 3);
    closeStream.close();
    await expect.poll(() => live.snapshot().team?.connection).toBe("disconnected");
    await expect.poll(() => live.snapshot().team?.gap, { timeout: 2500 }).toBe(true);
    await expect.poll(() => live.snapshot().team?.connection).toBe("connected");
  } finally { live.close(); }
  const stopped = frames;
  await live.tick();
  expect(frames).toBe(stopped);
  const unavailable = createTeamLive(fixture.client(""), "run", () => {});
  try { await unavailable.ready; expect(unavailable.snapshot().team).toBeUndefined(); }
  finally { unavailable.close(); }
});

it("connects the actual team entrypoint without passing its owner credential to child processes", async () => {
  const fixture = managedRead(), requests: string[] = [];
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request, env) => {
    requests.push(request.method + " " + new URL(request.url).pathname);
    return fixture.app.fetch(request, env);
  } });
  await once(server, "listening");
  const home = mkdtempSync(join(tmpdir(), "t015-entry-"));
  const guard = "import c from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; " +
    "const original=c.execFile; c.execFile=(...args)=>{ if(process.env.MULTI_AGENT_OWNER_TOKEN) " +
    "throw new Error('Owner credential inherited'); return original(...args); }; syncBuiltinESMExports(); " +
    "Object.defineProperties(process.stdout,{columns:{value:160},rows:{value:46}});";
  const child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(guard),
    fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--team", "--run", "run", "--no-color",
    "--url", "http://127.0.0.1:" + (server.address() as { port: number }).port], {
    env: { ...process.env, OPENRIG_HOME: home, OPENRIG_UI_LANGUAGE: "en", MULTI_AGENT_OWNER_TOKEN: "owner-read",
      OPENRIG_TUI_CLI_ENTRY: fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url)) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", bytes => { output += String(bytes); });
  child.stderr.on("data", bytes => { errors += String(bytes); });
  try {
    await expect.poll(() => output.includes("/workspace/project"), { timeout: 5000 }).toBe(true);
    expect(requests).toContain("GET /api/team-control/runs/run/read");
    expect(requests.every(request => request.startsWith("GET /api/team-control/"))).toBe(true);
    expect(errors).not.toContain("Owner credential inherited");
    expect(output).not.toContain(CATALOGS.en["team.sample"]);
  } finally {
    if (child.exitCode === null) { child.stdin.write("q"); await once(child, "exit"); }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);
