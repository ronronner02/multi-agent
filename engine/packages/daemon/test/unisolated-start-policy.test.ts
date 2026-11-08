import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";

// A real `workers.isolation: none` daemon is given only the owner's credentials: no policy
// reader and no binding resolver. Every other team test injects both, which is how a start that
// a real install refused went unnoticed. This one leaves them out, as `rig daemon start` does.

const ownerToken = "owner-fixture";
const SEAT = "dev-impl@team-demo";
const STUB_RUNNER = new URL("../dist/adapters/stub-runner.js", import.meta.url).pathname;

let directory: string, db: Database.Database, savedEnv: Record<string, string | undefined>;
let daemon: Awaited<ReturnType<typeof createDaemon>>;

const tmuxRun = (...args: string[]): string =>
  execFileSync("tmux", args, { encoding: "utf8", env: { ...process.env, TMUX_TMPDIR: join(directory, "tmux") } });

/** A projection is sealed read-only, so every directory is opened before removal. */
function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "start-policy-")));
  mkdirSync(join(directory, "tmux"), { recursive: true });
  savedEnv = { OPENRIG_HOME: process.env.OPENRIG_HOME, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
  process.env.OPENRIG_HOME = join(directory, "home");
  process.env.TMUX_TMPDIR = join(directory, "tmux");
  const repo = join(directory, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "plan.md"), "approved plan\n");
  writeFileSync(join(repo, "src", "base.ts"), "export const base = 1;\n");
  for (const args of [["init", "--quiet", "--initial-branch=main"], ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "test"], ["add", "."], ["commit", "--quiet", "-m", "base"]]) {
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  }
  daemon = await createDaemon({ dbPath: join(directory, "start-policy.db"), managedMode: true,
    teamControl: { credentials: { ownerToken } },
    cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
    directLaunchCommand: facts => [process.execPath, STUB_RUNNER,
      "--session-name", facts.taskId, "--cwd", facts.tree, "--launch-id", facts.attemptId, "--posture", "floor"] });
  db = daemon.db;
  // The demo seed's rows and nothing else.
  const rig = daemon.deps.rigRepo.createRig("team-demo", repo);
  const node = daemon.deps.rigRepo.addNode(rig.id, "dev.impl", { role: "implementer", runtime: "claude-code", cwd: repo });
  daemon.deps.sessionRegistry.registerSession(node.id, SEAT);
});

afterEach(async () => {
  try { tmuxRun("kill-server"); } catch { /* already gone */ }
  await daemon?.deps.workflowRuntime?.closeManagedAttempts();
  if (db?.open) db.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (existsSync(directory)) { writable(directory); rmSync(directory, { recursive: true, force: true }); }
});

it("accepts an owner's start and launches the seat with no injected policy", async () => {
  const response = await daemon.app.fetch(new Request("http://127.0.0.1/api/team-control/runs", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + ownerToken },
    body: JSON.stringify({ goal: "Say hello from the demo team" }),
  }), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  expect({ status: response.status, body: response.status === 201 ? null : await response.text() })
    .toEqual({ status: 201, body: null });
  const receipts = () => db.prepare("SELECT 1 FROM events WHERE type = 'managed.attempt.receipt'").all();
  await vi.waitFor(() => expect(receipts()).toHaveLength(1), { timeout: 60_000 });
  const row = db.prepare("SELECT payload FROM events WHERE type = 'managed.attempt.receipt'").get() as { payload: string };
  const observed = JSON.parse(row.payload) as { receipt: { identity: { tmuxServer: string } } };
  expect(observed.receipt.identity.tmuxServer).toBe(tmuxRun("display-message", "-p", "-t", SEAT, "#{socket_path}").trim());
}, 90_000);
