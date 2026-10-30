import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBinding, hashBytes, type PlanGovernance } from "../src/domain/plan-governance.js";
import type { PlanBinding, TeamTaskAuthority } from "../src/contracts/team-control.js";
import { launchManagedHarness } from "../src/adapters/worker-launch.js";
import { createDaemon } from "../src/startup.js";

// T047: an admitted assignment reaches the privileged launch with the attempt the producer
// made for it. Every seat launch — fresh, restore and a rig-instantiated member — passes
// through `StartupOrchestrator.startNode`, so the attachment is proven through the daemon's
// own composition, not a hand-built binding. The adapter is the seam where the production
// launcher receives the binding; it reports the attempt and whether the mailbox endpoint the
// launcher would ask for is already registered at that moment. No provider session starts.

// The composed launcher's only privileged call is `/usr/bin/sudo`; everything else stays real.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => {
      if (args[0] !== "/usr/bin/sudo") return actual.execFile(...args);
      const callback = args[3] as ((error: Error, stdout: string, stderr: string) => void) | undefined;
      queueMicrotask(() => callback?.(Object.assign(new Error("exit 126"), { code: 126 }), "",
        JSON.stringify({ worker_launch_error: "unsupported-version", message: "fixture refuses the client build" }) + "\n"));
      return { stdin: { end: () => undefined } } as unknown as ReturnType<typeof actual.execFile>;
    },
  };
});

const host = vi.hoisted(() => ({ policy: "", passwd: "", group: "" }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const file = String(args[0]);
      const fake = file === "/etc/multi-agent/worker-policy.json" ? host.policy
        : file === "/etc/passwd" ? host.passwd : file === "/etc/group" ? host.group : undefined;
      return fake === undefined ? actual.readFileSync(...args) : fake;
    },
  };
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "t047-repo-"));
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

function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

describe("a managed seat launches under the attempt produced for its admitted task", () => {
  let directory: string, repo: string, assignmentRoot: string, contextRoot: string, mailboxRoot: string;
  let frameworkRoot: string, controlStateDir: string, toolchainDir: string, workerRoot: string;
  let db: Database.Database, governance: PlanGovernance, binding: PlanBinding;
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  let workerUid: number, workerGid: number, serial: number, task: TeamTaskAuthority;
  let nodeId: string, sessionId: string, seatTree: string;

  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "t047-" + ++serial, payload });
  const endpoints = () => daemon.deps.managedLaunch!.endpoints;

  beforeEach(async () => {
    launches.length = 0;
    receipts.length = 0;
    directory = mkdtempSync(join(tmpdir(), "t047-attach-"));
    chmodSync(directory, 0o755);
    repo = repository();
    assignmentRoot = join(directory, "assignments");
    contextRoot = join(directory, "context");
    controlStateDir = join(directory, "control");
    mailboxRoot = join(controlStateDir, "mailboxes");
    frameworkRoot = join(directory, "framework");
    toolchainDir = join(directory, "toolchain");
    workerRoot = join(directory, "workers");
    for (const path of [join(assignmentRoot, "ma-worker1"), frameworkRoot, controlStateDir,
      join(workerRoot, "ma-worker1", "scratch"), toolchainDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
    // The anchors a provisioned host installs: the context root is root-owned 0755 and the
    // per-worker anchors carry the worker's group, which is what the producer reads back.
    mkdirSync(contextRoot, { recursive: true, mode: 0o755 });
    chmodSync(contextRoot, 0o755);
    for (const anchor of [join(contextRoot, "ma-worker1"), join(mailboxRoot, "ma-worker1")]) mkdirSync(anchor, { recursive: true });
    chmodSync(join(contextRoot, "ma-worker1"), 0o2750);
    // The mailbox anchor is setgid for the worker, so attempt directories below it carry the
    // worker's group and the endpoint is worker-group 0660.
    chmodSync(join(mailboxRoot, "ma-worker1"), 0o2710);
    chmodSync(frameworkRoot, 0o2750);
    // The pinned entry governor the attempt's manifest binds, in the provisioned layout.
    mkdirSync(join(frameworkRoot, "skills", "using-spec-first"), { recursive: true });
    writeFileSync(join(frameworkRoot, "skills", "using-spec-first", "SKILL.md"), "pinned entry governor\n", { mode: 0o644 });
    chmodSync(join(frameworkRoot, "skills"), 0o2750);
    chmodSync(join(frameworkRoot, "skills", "using-spec-first"), 0o2750);
    workerGid = lstatSync(join(contextRoot, "ma-worker1")).gid;
    workerUid = process.getuid!() === 0 ? 60_000 : process.getuid!() + 1;
    host.passwd = `ma-worker1:x:${workerUid}:${workerGid}::/home/ma-worker1:/bin/sh\n`;
    host.group = `ma-worker:x:${workerGid}:\n`;
    host.policy = JSON.stringify({ schema: "multi-agent-worker-policy/v1", policy_revision: 5,
      worker_identities: ["ma-worker1"],
      paths: { assignment_root: assignmentRoot, control_state_dir: controlStateDir, worker_root: workerRoot,
        context_root: contextRoot, mailbox_root: mailboxRoot, framework_dir: frameworkRoot, toolchain_dir: toolchainDir } });
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"),
      repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 5, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    daemon = await createDaemon({ dbPath: join(directory, "t047.db"), managedMode: true,
      teamControl: { credentials: { ownerToken: "owner-fixture" }, resolveBinding: () => structuredClone(binding),
        readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: binding.policyFingerprint,
          verifiedProviders: ["claude", "codex"] }) },
      tmuxExec: async () => "", cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
    db = daemon.db;
    governance = daemon.deps.teamGovernance!;
    serial = 0;
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'rig')").run();
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }),
      { kind: "owner", sessionId: "owner-control" }, binding);
    seatTree = mkdtempSync(join(tmpdir(), "t047-seat-"));
    nodeId = daemon.deps.rigRepo.addNode("rig", "builder", { runtime: "claude-code", cwd: seatTree }).id;
    daemon.deps.sessionRegistry.registerSession(nodeId, "builder@rig");
    daemon.deps.sessionRegistry.updateBinding(nodeId, { tmuxSession: "builder@rig", tmuxPane: "%3" });
    sessionId = daemon.deps.sessionRegistry.findResumeContextByName("builder@rig")!.sessionId;
  });

  afterEach(async () => {
    await daemon?.deps.workflowRuntime?.closeManagedAttempts();
    if (db?.open) db.close();
    if (existsSync(directory)) { writable(directory); rmSync(directory, { recursive: true, force: true }); }
  });

  const createTask = (taskId = "task", paths = ["src"], dependencies: string[] = []) => {
    const receipt = governance.createTask(command(taskId, {
      assignment: { taskId, role: "implementer", paths, dependencies },
      outputs: [paths[0] + "/result.ts"], permissions: ["write-assigned-tree"],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file.",
    }), binding);
    if (receipt.status === "accepted") task = receipt.value as TeamTaskAuthority;
    return receipt;
  };

  /** The adapter seam: `launchManagedHarness` is what both production adapters call, so the
   *  launcher receives exactly the attempt the attachment put on the binding. The launcher
   *  itself is faked here; it reports whether the endpoint it would ask for is registered and
   *  returns the receipt the production launcher would return. */
  const launches: Array<{ attemptId: string | undefined; registered: boolean;
    previous?: import("../src/domain/runtime-adapter.js").ManagedSessionReceipt }> = [];
  const receipts: Array<import("../src/domain/runtime-adapter.js").ManagedSessionReceipt> = [];
  const launcher: import("../src/adapters/worker-launch.js").WorkerLauncher = {
    async launch(input) {
      launches.push({ attemptId: input.attempt.attemptId, registered: endpoints().has(input.attempt.attemptId),
        ...(input.attempt.previous ? { previous: input.attempt.previous } : {}) });
      const generation = (input.attempt.previous?.identity.generation ?? 0) + 1;
      const receipt = {
        identity: { nativeSessionId: input.resumeToken ?? "native-session", tmuxServer: "/tmp/tmux", paneId: "%3",
          processId: 1_000 + generation, processStart: "1", generation, policyFingerprint: binding.policyFingerprint },
        attemptId: input.attempt.attemptId, runId: "run", client: "claude-code" as const,
        contextHash: input.attempt.context.generatedHash, workerUid, processGroupId: 2_000 + generation,
        executableVersion: "2.1.296", observedContextHash: input.attempt.context.generatedHash,
        network: { namespace: "net:[9]", mode: "filtered-proxy" as const,
          profileFingerprint: binding.policyFingerprint, preflightRef: "preflight" },
        deadline: input.attempt.deadline,
      };
      receipts.push(receipt);
      // The production launcher records the attempt row before it starts; the resolver's resume
      // lookup requires the same owner record, so the fake mirrors that one write.
      if (task) {
        const now = new Date().toISOString();
        const unavailable = { value: null, reason: "Native usage has not been observed" };
        const usage = JSON.stringify({ activeMs: 0, inputTokens: unavailable,
          outputTokens: unavailable, costUsd: unavailable });
        db.prepare(`INSERT OR REPLACE INTO team_attempts
          (id, run_id, qitem_id, role, provider, identity_json, unknown_reason, state, usage_json,
           active_ms, entity_version, created_at, updated_at)
          VALUES (?, 'run', ?, 'implementer', 'claude', ?, NULL, 'stopped', ?, 0, 1, ?, ?)`)
          .run(receipt.attemptId, task.qitemId, JSON.stringify(receipt.identity), usage, now, now);
      }
      return { ok: true, managedSession: receipt, resumeToken: receipt.identity.nativeSessionId, resumeType: "claude_id" };
    },
    async checkReady() { return { ready: true }; },
  };
  const adapter = (() => ({
    runtime: "claude-code",
    async listInstalled() { return []; },
    async project() { return { warnings: [], failed: [] }; },
    async deliverStartup() { return { warnings: [], failed: [] }; },
    async checkReady() { return { ready: true }; },
    async launchHarness(bound: import("../src/domain/runtime-adapter.js").NodeBinding) {
      if (!bound.managedAttempt) {
        launches.push({ attemptId: undefined, registered: false });
        return { ok: true, resumeToken: "native-session", resumeType: "claude_id" };
      }
      return launchManagedHarness(launcher, "claude-code", bound, {});
    },
  }))() as unknown as import("../src/domain/runtime-adapter.js").RuntimeAdapter;

  const launchWith = (selected: import("../src/domain/runtime-adapter.js").RuntimeAdapter,
    isRestore = false, resumeToken?: string) => daemon.deps.startupOrchestrator!.startNode({
    rigId: "rig", nodeId, sessionId, ...(resumeToken ? { resumeToken, resumeType: "claude_id" } : {}),
    binding: { id: "binding-1", nodeId, tmuxSession: "builder@rig", tmuxWindow: null, tmuxPane: "%3",
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: seatTree },
    adapter: selected,
    plan: { runtime: "claude-code", cwd: seatTree, entries: [], diagnostics: [], conflicts: [], noOps: [] },
    resolvedStartupFiles: [], startupActions: [], isRestore, sessionName: "builder@rig",
    includeDurableObligations: false,
  });

  const launch = (isRestore = false, resumeToken?: string) => launchWith(adapter, isRestore, resumeToken);

  it("attaches the produced attempt and registers its endpoint before the launcher asks for it", async () => {
    const created = createTask();
    expect(created.status).toBe("accepted");
    task = created.value as TeamTaskAuthority;
    await launch();
    // The launch may stop later at a host-only step (the fixture has no provider session);
    // what this task owns is what the launcher received before any effect.
    expect(launches).toHaveLength(1);
    const attemptId = launches[0]!.attemptId;
    expect(attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(launches[0]!.registered).toBe(true);
    // Keyed by the produced attempt, never by the queue row or the seat.
    expect([...endpoints().keys()]).toEqual([attemptId]);
    expect(attemptId).not.toBe(task.qitemId);
    expect(attemptId).not.toBe("builder@rig");
  });

  it("attaches again on the restore path, which shares the same launch seam", async () => {
    expect(createTask().status).toBe("accepted");
    await launch();
    await launch(true);
    expect(launches.map(entry => entry.attemptId)).toHaveLength(2);
    expect(launches.every(entry => entry.registered)).toBe(true);
    expect(new Set(launches.map(entry => entry.attemptId)).size).toBe(2);
    expect(endpoints().size).toBe(2);
  });

  it("hands the registered attempt to the daemon's real composed launcher, with only sudo faked", async () => {
    createTask();
    const asked: string[] = [];
    const map = endpoints();
    const get = map.get.bind(map);
    map.get = (id: string) => { asked.push(id); return get(id); };
    const real = daemon.deps.runtimeAdapters!["claude-code"]!;
    const composed = { ...real, runtime: "claude-code",
      project: async () => ({ warnings: [], failed: [] }),
      deliverStartup: async () => ({ warnings: [], failed: [] }),
      checkReady: async () => ({ ready: true }),
      launchHarness: real.launchHarness.bind(real),
    } as unknown as import("../src/domain/runtime-adapter.js").RuntimeAdapter;
    const result = await launchWith(composed);
    // The real launcher asked for exactly the produced attempt's endpoint before its own
    // preflight refused; a missing registration would have stopped it at the mailbox seam.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors.join(" ")).not.toContain("managed_mailbox_unregistered");
    // The launcher's blocked record removes the registration, as the composed chain documents.
    expect(map.size).toBe(0);
  });

  it("resumes the recorded attempt with its exact previous receipt on a native token", async () => {
    createTask();
    await launch();
    const first = receipts[0]!;
    await daemon.deps.workflowRuntime!.retireManagedAttempt(first.attemptId);
    await launch(false, "native-session");
    expect(receipts).toHaveLength(2);
    // Same attempt, same projection, and the exact receipt the first launch returned.
    expect(launches[1]!.attemptId).toBe(first.attemptId);
    expect(launches[1]!.previous).toEqual(first);
    expect(launches[1]!.registered).toBe(true);
    expect(receipts[1]!.identity.generation).toBe(2);
    expect(endpoints().size).toBe(1);
  });

  it("shares the attachment seam with the restore and rig-instantiation paths", () => {
    // The pod instantiator launches through this same orchestrator instance, and the restore
    // orchestrator carries the resolver into the orchestrator it constructs for each node.
    expect((daemon.deps.podInstantiator as unknown as { deps: { startupOrchestrator?: unknown } })
      .deps.startupOrchestrator).toBe(daemon.deps.startupOrchestrator);
    expect(typeof (daemon.deps.restoreOrchestrator as unknown as { managedAttempt?: unknown })
      .managedAttempt).toBe("function");
  });

  it("leaves a personal seat with no attempt and no registration", async () => {
    await launch();
    expect(launches).toEqual([{ attemptId: undefined, registered: false }]);
    expect(endpoints().size).toBe(0);
  });

  it("leaves no attempt or registration when admission refuses the task", async () => {
    expect(createTask("task-dep", ["src/dep"], ["missing"]).status).toBe("accepted");
    const result = await launch();
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join(" ")).toContain("Dependency lacks validated success");
    expect(launches).toHaveLength(0);
    expect(endpoints().size).toBe(0);
  });

  it("refuses an ambiguous seat rather than attach one assignment to another's binding", async () => {
    expect(createTask().status).toBe("accepted");
    expect(createTask("task-b", ["src/other"]).status).toBe("accepted");
    const result = await launch();
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join(" ")).toContain("Managed launch task is ambiguous");
    expect(launches).toHaveLength(0);
    expect(endpoints().size).toBe(0);
  });
});