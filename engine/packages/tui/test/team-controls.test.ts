import { afterEach, expect, it, vi } from "vitest";
import { decodeInput, parseTeamCommand } from "../src/input.js";
import { createViewState } from "../src/state.js";
import { createTeamControls } from "../src/main.js";
import { DaemonClient } from "../src/daemon-client.js";
import { demoSnapshot } from "../src/demo-data.js";
import { CATALOGS, createInterfaceI18n } from "@openrig/i18n";

it.each(["pause", "resume", "help", "retry TASK-1", "open lead@rig"])("accepts the command allowlist: %s", command => {
  expect(parseTeamCommand(command)).not.toBeNull();
});
it.each(["hello agent", "approve TASK-1", "retry", "pause now", "pause\nresume", "open task extra"])("never interprets free text as an agent message: %s", command => {
  expect(parseTeamCommand(command)).toBeNull();
});

it("routes real decoded keys to view navigation and the command-only input", async () => {
  const snapshot = demoSnapshot(true), view = createViewState({ instanceId: "t016", team: {}, getSnapshot: () => snapshot });
  const controls = createTeamControls({ view, getSnapshot: () => snapshot, client: null,
    language: await createInterfaceI18n(), refresh: async () => {}, quit: () => {} });
  for (const event of decodeInput("3")) await controls.handle(event);
  expect(view.get().team?.page).toBe("agents");
  for (const event of decodeInput("?")) await controls.handle(event);
  expect(view.get().team?.overlay).toBe("help");
  for (const event of decodeInput("\x1b")) await controls.handle(event);
  expect(view.get().team?.overlay).toBeNull();
  controls.close();
});

import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { PlanGovernance, fixDaemonMode } from "../../daemon/src/domain/plan-governance.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import type { PlanBinding } from "../../daemon/src/contracts/team-control.js";
import { createTeamTerminal, startOwnerTerminal } from "../src/terminals/terminal-model.js";
import { renderScreen } from "../src/render.js";
import { stat, access } from "node:fs/promises";
import { dirname } from "node:path";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.restoreAllMocks(); });

async function controlsFixture() {
  const db = createDb(); cleanups.push(() => db.close()); migrate(db, ALL_MIGRATIONS); fixDaemonMode(db, true);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'rig')").run();
  const eventBus = new EventBus(db), queueRepo = new QueueRepository(db, eventBus);
  const binding: PlanBinding = {
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "docs/plan.md", planDigest: "sha256:" + "a".repeat(64),
    repository: { root: "/workspace/project", identity: "git:" + "b".repeat(40) },
    readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
    policyRevision: 1, policyFingerprint: "sha256:" + "c".repeat(64),
    limits: { maxSessions: 3, maxActiveMs: 3600000, maxRetries: 1, maxReviewRounds: 2 },
  };
  const policy = () => ({ policyRevision: 1, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] as const });
  const governance = new PlanGovernance(db, eventBus, queueRepo, undefined, policy);
  governance.createRun({ id: "run", rigId: "rig", binding });
  const approval = (id = "implementation") => {
    const run = governance.getRun("run");
    return governance.requestApproval({ protocolVersion: "1.0", runId: "run", actionId: id, expectedEntityVersion: run.entityVersion,
      idempotencyKey: "fixture-" + id, payload: { kind: "orchestrator", action: "implementation", payload: { bindingDigest: run.bindingDigest },
        targetDigest: run.bindingDigest, expiresAt: "2099-01-01T00:00:00.000Z" } }, { kind: "owner", sessionId: "owner-control" });
  };
  expect(approval().status).toBe("accepted");
  const app = createTestApp(db, { appDeps: { eventBus, queueRepo, teamGovernance: governance,
    teamControl: { credentials: { ownerToken: "t016-owner" }, resolveBinding: () => binding, readPolicyCapability: policy } } }).app;
  const mutations: Array<{ url: string; body: string }> = [];
  let response: ((value: Response) => Promise<Response>) | undefined;
  const client = new DaemonClient({ baseUrl: "http://localhost", headers: { Authorization: "Bearer t016-owner" },
    fetchImpl: async (input, init) => {
      const write = init?.method === "POST" || init?.method === "DELETE";
      if (write) mutations.push({ url: String(input), body: String(init?.body ?? "") });
      const value = await app.request(String(input), init, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
      return write && response ? response(value) : value;
    } });
  const snapshot = demoSnapshot(true);
  Object.assign(snapshot.team!, { source: "live", connection: "connected", ageSeconds: 0, read: await client.teamRead("run") });
  const view = createViewState({ instanceId: "t016", team: { language: "en" }, getSnapshot: () => snapshot }), quit = vi.fn();
  const refresh = vi.fn(async () => { snapshot.team!.read = await client.teamRead("run"); });
  const controls = createTeamControls({ view, client, getSnapshot: () => snapshot, language: await createInterfaceI18n({ preference: { read: async () => "en", write: async () => {} } }), refresh, quit });
  cleanups.push(() => controls.close());
  const press = async (text: string) => { for (const event of decodeInput(text)) await controls.handle(event); };
  return { app, governance, approval, snapshot, view, client, controls, press, mutations, refresh, quit,
    response: (next: typeof response) => { response = next; } };
}

it("confirms decoded owner input once, retaining the same request after a lost acknowledgement", async () => {
  const f = await controlsFixture();
  await f.press("a"); const request = f.view.get().team!.confirmation!.request;
  expect(f.mutations).toEqual([]); expect(request.payload).toMatchObject({ decision: "approved", approvalVersion: 1 });
  f.response(async () => { throw new Error("acknowledgement lost"); });
  await f.press("\r"); const version = f.governance.getRun("run").entityVersion;
  expect(f.view.get().team!.notice?.key).toBe("unacknowledged");
  expect(f.governance.listApprovals("run")[0]!.state).toBe("approved");
  f.response(undefined); await f.press("\r");
  expect(f.mutations[0]).toEqual(f.mutations[1]); expect(f.governance.getRun("run").entityVersion).toBe(version);
  expect(f.view.get().team!.pending).toBeNull(); expect(f.refresh).toHaveBeenCalledOnce();
});

it("suppresses duplicate Enter while a real mutation response is pending", async () => {
  const f = await controlsFixture(); let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  f.response(async value => { await hold; return value; }); await f.press("a");
  const first = f.press("\r"); await vi.waitFor(() => expect(f.mutations).toHaveLength(1));
  await f.press("\r"); expect(f.mutations).toHaveLength(1); release(); await first;
});

it("refreshes after a real version conflict and requires a fresh confirmation", async () => {
  const f = await controlsFixture(); await f.press("a");
  const old = f.view.get().team!.confirmation!.request; f.approval("second");
  await f.press("\r");
  expect(f.view.get().team!.notice?.key).toBe("conflict"); expect(f.view.get().team!.confirmation).toBeNull();
  expect(f.mutations).toHaveLength(1); expect(f.governance.listApprovals("run")[0]!.state).toBe("pending");
  await f.press("a"); const fresh = f.view.get().team!.confirmation!.request;
  expect(fresh.expectedEntityVersion).toBeGreaterThan(old.expectedEntityVersion); expect(fresh.idempotencyKey).not.toBe(old.idempotencyKey);
});

it("uses x for rejection, r only for refresh, and never sends command text to an agent", async () => {
  const f = await controlsFixture(); await f.press("rcq hello agent\r");
  expect(f.quit).not.toHaveBeenCalled(); expect(f.mutations).toEqual([]); expect(f.view.get().team!.notice?.key).toBe("commandsOnly");
  await f.press("x\r"); expect(f.governance.listApprovals("run")[0]!.state).toBe("rejected");
  expect(f.mutations).toHaveLength(1); expect(f.mutations[0]!.url).toMatch(/approvals\/decide$/);
});

it.each(["sample", "stale", "disconnected", "native", "expired", "invalidated"])("disables decisions for %s data", async kind => {
  const f = await controlsFixture(), data = f.snapshot.team!, approval = data.read!.approvals[0]!;
  if (kind === "sample") data.source = "sample";
  if (kind === "stale") data.ageSeconds = 6;
  if (kind === "disconnected") data.connection = "disconnected";
  if (kind === "native") approval.kind = "native";
  if (kind === "expired") approval.expiresAt = "2020-01-01T00:00:00.000Z";
  if (kind === "invalidated") data.read!.run.state = "invalidated";
  await f.press("a\r"); expect(f.mutations).toEqual([]); expect(f.view.get().team!.confirmation).toBeUndefined();
});

it("shows every scope and dependency field in the scrollable narrow confirmation", async () => {
  const f = await controlsFixture(), approval = f.snapshot.team!.read!.approvals[0]!;
  Object.assign(approval, { action: "scope-extension", payload: { taskId: "TASK-SCOPE", reason: "Required by the task", classification: "dependency",
    paths: [{ path: "src/scoped.ts", operation: "create" }, { path: "src/existing.ts", operation: "modify" }],
    packages: [{ name: "example-package", version: "1.2.3", matchedListEntry: "approved/example-package@1.2.3" }], expectedChainHead: "chain-1" } });
  await f.press("a"); let output = "";
  for (let offset = 0; offset < 30; offset++) {
    output += renderScreen(f.view.get(), f.snapshot, { cols: 64, rows: 20 }).lines.join("\n") + "\n"; await f.press("\x1b[B");
  }
  for (const value of ["TASK-SCOPE", "src/scoped.ts", "src/existing.ts", CATALOGS.en["team.create"], CATALOGS.en["team.modify"], "Required by the task", "dependency", "example-package", "1.2.3", "approved/example-package"])
    expect(output).toContain(value);
  expect(f.view.get().team!.confirmation!.request.payload).toMatchObject({ expectedChainHead: "chain-1" });
});

it("pairs and revokes through Settings and the actual owner-session routes", async () => {
  const f = await controlsFixture(); await f.press("sb");
  const pair = f.view.get().team!.pairing!; expect(pair.expiresAt - Date.now()).toBeGreaterThan(55000);
  const exchange = await f.app.request("http://localhost/api/team-control/owner-session/exchange", { method: "POST",
    headers: { Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ code: pair.code }) },
  { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  expect(exchange.status).toBe(200);
  await f.press("\x1bsd"); expect(f.view.get().team!.ownerSessions).toHaveLength(1);
  expect(f.view.get().team!.ownerSessions![0]!.revoked_at).not.toBeNull();
});

it("pauses the visible terminal tail without changing terminal authority, then follows again", async () => {
  const f = await controlsFixture();
  f.view.dispatch({ type: "team-update", patch: { consoleExpanded: true, focus: "console", consoleTab: "terminal",
    terminal: { session: "worker", status: "readOnly", lines: ["T016-FIRST"] } } });
  await f.press("p");
  f.view.dispatch({ type: "team-update", patch: { terminal: { session: "worker", status: "readOnly", lines: ["T016-FIRST", "T016-NEXT"] } } });
  const frame = () => renderScreen(f.view.get(), f.snapshot, { cols: 90, rows: 30 }).lines.join("\n");
  expect(frame()).toContain("T016-FIRST"); expect(frame()).not.toContain("T016-NEXT");
  await f.press("p"); expect(frame()).toContain("T016-NEXT"); expect(f.mutations).toEqual([]);
});

it.each([[120, 36, false, "en"], [120, 36, false, "zh-CN"], [90, 30, true, "en"], [90, 30, true, "zh-CN"]] as const)(
  "keeps the newest terminal output visible and preserves pause/scroll at %sx%s (expanded: %s, language: %s)", async (cols, rows, consoleExpanded, language) => {
    const f = await controlsFixture(), lines = [...Array.from({ length: 60 }, (_, i) => `history-${i}`), "T016-LATEST"];
    f.view.dispatch({ type: "team-update", patch: { language, consoleExpanded, focus: "console", consoleTab: "terminal",
      terminal: { session: "worker", status: "readOnly", lines } } });
    const render = () => renderScreen(f.view.get(), f.snapshot, { cols, rows });
    const initial = render(); expect(initial.lines.join("\n")).toContain("T016-LATEST");
    expect(initial.teamConsoleOffset).toBeGreaterThan(0);
    f.view.dispatch({ type: "team-update", patch: { offsets: { console: initial.teamConsoleOffset! } } });
    await f.press("p");
    f.view.dispatch({ type: "team-update", patch: { terminal: { session: "worker", status: "readOnly", lines: [...lines, "T016-NEXT"] } } });
    expect(render().lines.join("\n")).toContain("T016-LATEST"); expect(render().lines.join("\n")).not.toContain("T016-NEXT");
    await f.press("\x1b[A"); expect(render().teamConsoleOffset).toBe(initial.teamConsoleOffset! - 1);
    await f.press("p"); expect(render().lines.join("\n")).toContain("T016-NEXT"); expect(f.mutations).toEqual([]);
  });

it("never treats terminal output, foreign frames or late acknowledgements as take-over authority", () => {
  const sent: string[] = [], nonce = "t016-nonce";
  const ws = { url: "ws://localhost/api/terminal/worker?nonce=" + nonce, readyState: WebSocket.OPEN,
    send: (text: string) => sent.push(text), close: vi.fn(), onmessage: null as null | ((event: { data: string }) => void) };
  let state: { status: string; lines: string[] } = { status: "", lines: [] };
  const terminal = createTeamTerminal({ openTeamTerminal: () => ws as unknown as WebSocket }, value => { state = value; });
  const frame = (value: object) => ws.onmessage!({ data: JSON.stringify({ nonce, session: "worker", ...value }) });
  terminal.open("worker"); frame({ type: "ready" }); terminal.input({ type: "char", ch: "a" }); expect(sent).toEqual([]);
  terminal.takeover(); frame({ type: "output", data: JSON.stringify({ type: "takeover", status: "active" }) });
  frame({ type: "takeover", status: "active", nonce: "wrong" }); frame({ type: "takeover", status: "active", session: "another" });
  expect(state.status).toBe("requested"); expect(state.lines.join("")).toContain("takeover");
  frame({ type: "takeover", status: "active" }); terminal.input({ type: "char", ch: "b" });
  expect(JSON.parse(sent[1]!)).toEqual({ type: "text", text: "b" });
  terminal.release(); frame({ type: "takeover", status: "active" }); expect(state.status).toBe("readOnly");
  terminal.close(); frame({ type: "takeover", status: "active" }); expect(state.status).not.toBe("active");
});

it("starts a real private owner-host PTY, observes shell output and removes its sockets", async () => {
  const host = await startOwnerTerminal(); let output = "";
  try {
    expect((await stat(dirname(host.socketPath))).mode & 0o777).toBe(0o700);
    expect((await stat(host.socketPath)).mode & 0o777).toBe(0o600);
    const attachment = await host.relay.attach({ send: text => { output += text; }, close: () => {} });
    try {
      await attachment.sendInput("printf 'T016_%s\\n' READY\r");
      await vi.waitFor(() => expect(output).toContain("T016_READY"), { timeout: 3000 });
    } finally { await attachment.close(); }
  } finally { await host.close(); }
  await expect(access(host.socketPath)).rejects.toThrow(); await expect(access(host.tmuxSocket)).rejects.toThrow();
}, 10000);
