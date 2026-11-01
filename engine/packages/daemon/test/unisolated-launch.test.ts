import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import type { PlanBinding, TeamTaskAuthority } from "../src/contracts/team-control.js";
import { RestrictedWorkerLauncher } from "../src/adapters/worker-launch.js";
import { DirectWorkerLauncher } from "../src/adapters/direct-worker-launch.js";
import { createDaemon, selectIsolation } from "../src/startup.js";

// MVP slice 1 — `workers.isolation: none` runs a managed worker as the daemon's own user.
//
// Two things have to be true and are proven here against the real composition:
//   1. managed-mode startup succeeds on a host with no /etc/multi-agent at all;
//   2. an admitted task is produced and launched through the direct launcher, into a git
//      worktree this user owns, with the receipt recorded.
//
// The launch uses the real tmux server and the real stub runner, so nothing about the pane,
// the readiness signal or the receipt is faked — only the native client is replaced, which
// is the one thing that would need a provider account.

// Nothing in the unisolated cases may read the provisioned host files: a stub that throws
// proves that path never reaches for them. The hardened case boots the real installed policy,
// so it lifts the guard for its own duration and the guard is asserted where it matters.
const host = vi.hoisted(() => ({ allowProvisioned: false }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const file = String(args[0]);
      if (!host.allowProvisioned && (file.startsWith("/etc/multi-agent") || file.startsWith("/opt/multi-agent")
        || file.startsWith("/run/multi-agent") || file.startsWith("/usr/local/libexec/multi-agent"))) {
        throw new Error("provisioned host file read: " + file);
      }
      return actual.readFileSync(...args);
    },
  };
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(parent: string): string {
  const root = realpathSync(mkdtempSync(join(parent, "repo-")));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** A projection is sealed read-only, so every directory is opened before removal. */
function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

/**
 * The compiled stub runner, which stands in for the native client in the pane. It is the
 * built entry, not the TypeScript source: the pane's working directory is the candidate
 * worktree, which has no node_modules, so a loader flag could not resolve from there.
 */
const STUB_RUNNER = new URL("../dist/adapters/stub-runner.js", import.meta.url).pathname;

describe("workers.isolation: none launches a managed worker as the current user", () => {
  let directory: string, repo: string, home: string, db: Database.Database;
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  let binding: PlanBinding, task: TeamTaskAuthority, nodeId: string, sessionId: string, serial: number;
  let seatPane: string;
  let savedEnv: Record<string, string | undefined>;

  /** A tmux server of this test's own, so nothing touches the operator's sessions. */
  const tmuxRun = (...args: string[]): string =>
    execFileSync("tmux", args, { encoding: "utf8", env: { ...process.env, TMUX_TMPDIR: join(directory, "tmux") } });

  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
    expectedEntityVersion: daemon.deps.teamGovernance!.getRun("run").entityVersion,
    idempotencyKey: "mvp1-" + ++serial, payload });

  beforeEach(async () => {
    serial = 0;
    directory = realpathSync(mkdtempSync(join(tmpdir(), "mvp1-launch-")));
    home = join(directory, "home");
    mkdirSync(join(directory, "tmux"), { recursive: true });
    savedEnv = { OPENRIG_HOME: process.env.OPENRIG_HOME, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
    process.env.OPENRIG_HOME = home;
    process.env.TMUX_TMPDIR = join(directory, "tmux");
    repo = repository(directory);
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"),
      repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 4, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    daemon = await createDaemon({ dbPath: join(directory, "mvp1.db"), managedMode: true,
      teamControl: { credentials: { ownerToken: "owner-fixture" }, resolveBinding: () => structuredClone(binding),
        readPolicyCapability: () => ({ policyRevision: 4, policyFingerprint: binding.policyFingerprint,
          verifiedProviders: ["claude", "codex"] }) },
      // A real tmux adapter on this test's own server (TMUX_TMPDIR above), so the launch is
      // exercised through the same transport production uses.
      cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
      // The stub runner in place of the native client: it writes the readiness sidecar and
      // idles as the pane's foreground process, so the launch is exercised end to end.
      directLaunchCommand: facts => [process.execPath, STUB_RUNNER,
        "--session-name", facts.taskId, "--cwd", facts.tree, "--launch-id", facts.attemptId, "--posture", "floor"] });
    db = daemon.db;
    const governance = daemon.deps.teamGovernance!;
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'rig')").run();
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }),
      { kind: "owner", sessionId: "owner-control" }, binding);
    // A real tmux session is the seat's terminal: the launch types into this pane.
    tmuxRun("new-session", "-d", "-s", "builder@rig", "-c", repo);
    seatPane = tmuxRun("list-panes", "-t", "builder@rig", "-F", "#{pane_id}").trim();
    nodeId = daemon.deps.rigRepo.addNode("rig", "builder", { runtime: "claude-code", cwd: repo }).id;
    daemon.deps.sessionRegistry.registerSession(nodeId, "builder@rig");
    daemon.deps.sessionRegistry.updateBinding(nodeId, { tmuxSession: "builder@rig", tmuxPane: seatPane });
    sessionId = daemon.deps.sessionRegistry.findResumeContextByName("builder@rig")!.sessionId;
    const created = governance.createTask(command("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: ["src/result.ts"], permissions: ["write-assigned-tree"],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file.",
    }), binding);
    expect(created.status).toBe("accepted");
    task = created.value as TeamTaskAuthority;
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

  /** Launch the seat through the daemon's own adapter, exactly as a restore would. */
  const launch = () => daemon.deps.startupOrchestrator!.startNode({
    rigId: "rig", nodeId, sessionId,
    binding: { id: "binding-1", nodeId, tmuxSession: "builder@rig", tmuxWindow: null, tmuxPane: seatPane,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: repo },
    adapter: daemon.deps.runtimeAdapters!["claude-code"]!,
    plan: { runtime: "claude-code", cwd: repo, entries: [], diagnostics: [], conflicts: [], noOps: [] },
    resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "builder@rig",
    includeDurableObligations: false,
  });

  it("boots managed mode with no /etc/multi-agent and selects the direct launcher", () => {
    expect(daemon.deps.managedLaunch).toBeDefined();
    expect(daemon.deps.managedLaunch!.launcher).toBeInstanceOf(DirectWorkerLauncher);
    // Nothing was read from the provisioned host: the fs mock above would have thrown.
    expect(daemon.deps.runtimeAdapters!["claude-code"]!.workerLauncher).toBe(daemon.deps.managedLaunch!.launcher);
  });

  it.each([
    ["claude-code", "claude", "--permission-mode", undefined],
    ["claude-code", "claude", "--permission-mode", "existing-session"],
    ["codex", "codex", "-a", undefined],
    ["codex", "codex", "-a", "existing-session"],
  ] as const)("includes the %s executable %s before %s (resume: %s)", async (client, executable, firstFlag, resumeToken) => {
    // Capture before submission: exercise the default argv without starting a paid client.
    const sendText = vi.fn(async (_pane: string, _text: string) => ({ ok: false as const, code: "fixture_captured" }));
    const sendKeys = vi.fn();
    const native = new DirectWorkerLauncher({
      resolvePane: async () => seatPane,
      resolveAssignedTree: () => repo,
      tmuxServer: () => "fixture",
      tmux: { sendText, sendKeys, getPanePid: vi.fn(), getPaneCommand: vi.fn(), capturePaneScreen: vi.fn() },
    });
    vi.spyOn(daemon.deps.managedLaunch!.launcher, "launch").mockImplementation(input => native.launch({
      ...input, client, resumeToken, model: "fixture-model", effort: "high",
      attempt: { ...input.attempt, context: { ...input.attempt.context, client } },
    }));
    await launch();
    expect(sendText).toHaveBeenCalledTimes(1);
    const line = sendText.mock.calls[0]![1];
    expect(line).toContain(` && exec '${executable}' '${firstFlag}'`);
    expect(line).toContain("'--model' 'fixture-model' '--effort' 'high'");
    if (resumeToken) expect(line).toContain(`'${client === "claude-code" ? "--resume" : "resume"}' '${resumeToken}'`);
    else if (client === "claude-code") expect(line).toContain("'--session-id'");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("produces and launches the attempt into a worktree this user owns, and records the receipt", async () => {
    const result = await launch();
    const errors = result.ok ? [] : result.errors;
    expect(errors.join(" ")).not.toMatch(/\/etc\/multi-agent|sudo|ma-worker/);
    expect(result.ok, errors.join(" ")).toBe(true);

    // The candidate is a real git worktree under this user's state directory.
    const root = daemon.deps.workflowRuntime!;
    const tree = root.assignedTreeFor("run", task.assignment);
    expect(tree).toContain(join("state", "workers", "assignments", "local"));
    expect(statSync(tree).uid).toBe(process.getuid!());
    expect(git(tree, "rev-parse", "--is-inside-work-tree").trim()).toBe("true");

    // The receipt is recorded as run evidence, naming the real identity the pane runs under.
    const row = db.prepare(`SELECT payload FROM events WHERE type = 'managed.attempt.receipt' ORDER BY seq DESC LIMIT 1`)
      .get() as { payload: string };
    const receipt = (JSON.parse(row.payload) as { receipt: import("../src/domain/runtime-adapter.js").ManagedSessionReceipt }).receipt;
    expect(receipt.workerUid).toBe(process.getuid!());
    expect(receipt.network.mode).toBe("unknown");
    expect(receipt.identity.paneId).toBe(tmuxRun("list-panes", "-t", "builder@rig", "-F", "#{pane_id}").trim());
    expect(receipt.processGroupId).toBeGreaterThan(0);
    expect(receipt.contextHash).toBe(receipt.observedContextHash);
  }, 60_000);
});

describe("workers.isolation: hardened", () => {
  // The hardened path is unchanged, so this case proves only which launcher it builds. It
  // needs the installed policy to boot, which is a host-provisioning fact rather than a
  // repository one, so it skips where that is absent instead of reporting a code defect.
  const provisioned = existsSync("/etc/multi-agent/worker-policy.json");

  it.skipIf(!provisioned)("still selects the restricted launcher, not the direct one", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "mvp1-hardened-")));
    const binding: PlanBinding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"),
      repository: { root: directory, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 5, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    const hardened = await (async () => {
      host.allowProvisioned = true;
      try {
        return await createDaemon({ dbPath: join(directory, "hardened.db"), managedMode: true,
          workersIsolation: "hardened",
          teamControl: { credentials: { ownerToken: "owner-fixture" }, resolveBinding: () => structuredClone(binding),
            readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: binding.policyFingerprint,
              verifiedProviders: ["claude", "codex"] }) },
          tmuxExec: async () => "", cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
      } finally { host.allowProvisioned = false; }
    })();
    try {
      expect(hardened.deps.managedLaunch!.launcher).toBeInstanceOf(RestrictedWorkerLauncher);
      expect(hardened.deps.managedLaunch!.launcher).not.toBeInstanceOf(DirectWorkerLauncher);
    } finally {
      hardened.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("resolves the setting once, defaulting to none", () => {
    expect(selectIsolation("hardened")).toBe("hardened");
    expect(selectIsolation("none")).toBe("none");
    expect(selectIsolation(undefined)).toBe("none");
  });
});
