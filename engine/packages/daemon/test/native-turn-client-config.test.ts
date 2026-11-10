import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { writeAgentTurnPrompt } from "../src/domain/agent-turn.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";

/**
 * U3 — a native managed turn writes no client configuration.
 *
 * The daemon's legacy adapters project managed activity hooks into the client's own home: Codex
 * gets `[hooks]` and `[hooks.state."<key>"]` records in `config.toml`, Claude gets onboarding and
 * workspace trust in `.claude.json` plus a status-line collector in the seat's settings. On
 * 2026-11-10 that projection appended a duplicate `[hooks.state]` key to the owner's real Codex
 * config, and Codex refused to start.
 *
 * A supervised turn needs none of it: its activity arrives as the child's JSONL stream. This case
 * drives the production startup path against temp client homes and asserts that nothing in them
 * changed — and, in the same file, that the same adapter still writes what it always wrote for a
 * pane-era launch, so the guard is a routing decision rather than a deleted feature.
 */

const BINDING_ID = "binding";
const SEAT = "seat";

interface Fixture {
  root: string; cwd: string; codexHome: string; claudeHome: string; home: string; db: Database.Database;
  codex: CodexRuntimeAdapter; claude: ClaudeCodeAdapter; tmux: TmuxAdapter;
  binding: NodeBinding; writes: string[]; cleanup: Array<() => void>;
}

const fixtures: Fixture[] = [];

function fsOps(home: string, writes: string[]): ClaudeAdapterFsOps & CodexAdapterFsOps {
  return {
    homedir: home,
    exists: existsSync,
    mkdirp: (path: string) => { mkdirSync(path, { recursive: true }); },
    readFile: (path: string) => readFileSync(path, "utf8"),
    writeFile: (path: string, text: string) => { writes.push(path); writeFileSync(path, text); },
    copyFile: (src: string, dest: string) => { writes.push(dest); writeFileSync(dest, readFileSync(src)); },
    listFiles: (path: string) => readdirSync(path),
    readdir: (path: string) => readdirSync(path),
    statMode: (path: string) => statSync(path).mode,
    chmod: () => {},
  };
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "u3-client-config-")));
  const cwd = join(root, "seat project");
  const home = join(root, "daemon-home");
  // Both client homes are named and do not exist yet: any write would create them.
  const codexHome = join(root, "temp-codex-home");
  const claudeHome = join(root, "temp-claude-home");
  for (const directory of [cwd, home]) mkdirSync(directory, { recursive: true });
  const writes: string[] = [];
  const ops = fsOps(home, writes);
  const tmux = {
    sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"), capturePaneContent: vi.fn(async () => ""),
    getPaneExit: vi.fn(async () => ({ dead: false, code: null })), listPanes: vi.fn(async () => []),
    hasSession: vi.fn(async () => true),
  } as unknown as TmuxAdapter;
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);
    CREATE TABLE node_permission_selections(node_id TEXT, runtime TEXT, mode TEXT);`);
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec(`INSERT INTO bindings VALUES ('${BINDING_ID}','node','${SEAT}','%1');
    INSERT INTO occupant_tenures VALUES ('node','generation',1);`);
  const claudeManagedLaunch = new ClaudeManagedLaunch(db, { HOME: home, PATH: "/usr/bin:/bin" }, {});
  const claude = new ClaudeCodeAdapter({ tmux, fsOps: ops, claudeManagedLaunch, sleep: async () => {} });
  const codex = new CodexRuntimeAdapter({ tmux, fsOps: ops, codexHome });
  const binding = { id: BINDING_ID, nodeId: "node", cwd, tmuxSession: SEAT, tmuxPane: "%1" } as NodeBinding;
  const created: Fixture = { root, cwd, codexHome, claudeHome, home, db, codex, claude, tmux, binding, writes, cleanup: [] };
  created.cleanup.push(() => db.close(), () => rmSync(root, { recursive: true, force: true }));
  fixtures.push(created);
  return created;
}

afterEach(() => {
  for (const created of fixtures.splice(0)) {
    for (const close of created.cleanup.reverse()) { try { close(); } catch { /* already gone */ } }
  }
});

/** A manifest-shaped managed attempt: the launcher and the orchestrator read only these fields. */
function managedAttempt(attemptId: string, mutableStateRoot: string) {
  return { attemptId, deadline: Date.now() + 60_000, context: {
    runId: "run", assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
    client: "claude-code", mutableStateRoot, projection: { attemptId },
    binding: { policyFingerprint: "sha256:" + "b".repeat(64) }, generatedHash: "sha256:" + "a".repeat(64),
  } as ContextManifest };
}

/** The startup inputs a managed launch needs, with an empty projection plan. */
function startupInput(created: Fixture, runtime: "claude-code" | "codex", attemptId: string) {
  const attempt = managedAttempt(attemptId, join(created.root, "state"));
  writeAgentTurnPrompt(attempt.context, "Reply with the single word OK\n");
  const adapter = runtime === "codex" ? created.codex : created.claude;
  const binding: NodeBinding = { ...created.binding, managedAttempt: attempt };
  return { rigId: "rig", nodeId: "node", sessionId: "session", binding, adapter,
    plan: { runtime, cwd: created.cwd, entries: [], diagnostics: [], conflicts: [], noOps: [] },
    resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: SEAT, includeDurableObligations: false } as const;
}

function orchestrator(created: Fixture) {
  const registry = { db: created.db, currentOccupantTenure: () => null, updateStartupStatus: () => {},
    updateResumeToken: () => {}, recordResumeLaunch: () => {}, recordResumeAttempt: () => {} } as unknown as SessionRegistry;
  const eventBus = { db: created.db, emit: () => {} } as unknown as EventBus;
  return new StartupOrchestrator({ db: created.db, sessionRegistry: registry, eventBus, tmuxAdapter: created.tmux });
}

describe("U3 a native turn writes no client configuration", () => {
  it.each(["claude-code", "codex"] as const)("leaves %s's client home untouched", async runtime => {
    const created = fixture();
    // The native transport's launch is not this case's subject, so it is stubbed out; everything
    // that writes client configuration runs before it, which is exactly what this case watches.
    const adapter = runtime === "codex" ? created.codex : created.claude;
    vi.spyOn(adapter, "launchHarness").mockResolvedValue({ ok: true });
    vi.spyOn(adapter, "checkReady").mockResolvedValue({ ready: true });
    await orchestrator(created).startNode(startupInput(created, runtime, "attempt-1"));
    expect(existsSync(created.codexHome)).toBe(false);
    expect(existsSync(created.claudeHome)).toBe(false);
    // Claude's classic bootstrap writes onboarding and trust into `$HOME/.claude.json` when no
    // permission mode selects a config directory, so that path is watched too.
    expect(existsSync(join(created.home, ".claude.json"))).toBe(false);
    // Nothing was written outside the attempt's own state either.
    expect(created.writes.filter(path => !path.startsWith(join(created.root, "state")))).toEqual([]);
  });

  it("still writes the client home for a pane-era launch, so the guard is a routing decision", async () => {
    // The same adapter with no managed attempt is the legacy path: it must keep projecting the
    // trust record its pane-hosted seat depends on.
    const created = fixture();
    await created.codex.deliverStartup([], created.binding);
    expect(existsSync(join(created.codexHome, "config.toml"))).toBe(true);
  });
});
