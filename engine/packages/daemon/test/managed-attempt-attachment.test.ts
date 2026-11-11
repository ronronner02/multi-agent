import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBinding, hashBytes, type PlanGovernance } from "../src/domain/plan-governance.js";
import type { PlanBinding, TeamTaskAuthority } from "../src/contracts/team-control.js";
import { launchManagedHarness } from "../src/adapters/worker-launch.js";
import { createDaemon } from "../src/startup.js";
import { FRAMEWORK_CATALOG } from "../src/integrations/framework/catalog.js";
import { attemptInstructionFiles, type ContextManifest } from "../src/integrations/framework/context-manifest.js";
import { recordWorkflowTurn } from "../src/domain/team-workflows.js";
import { saveTeamSoul } from "../src/domain/team-souls.js";
import { writeFrameworkFixture } from "./helpers/framework-source.js";
import { appendChatMessage } from "../src/domain/lead-chat.js";

// T047: an admitted assignment reaches the privileged launch with the attempt the producer
// made for it. Every managed seat launch passes through `StartupOrchestrator.startNode`, so
// the attachment is proven through the daemon's
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

  const command = (actionId: string, payload: unknown, runId = "run") => ({ protocolVersion: "1.0", runId, actionId,
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: "t047-" + ++serial, payload });
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
    chmodSync(join(mailboxRoot, "ma-worker1"), 0o700);
    chmodSync(frameworkRoot, 0o2750);
    // The pinned entry governor the attempt's manifest binds, in the provisioned layout.
    mkdirSync(join(frameworkRoot, "skills", "using-spec-first"), { recursive: true });
    writeFileSync(join(frameworkRoot, "skills", "using-spec-first", "SKILL.md"), "pinned entry governor\n", { mode: 0o644 });
    chmodSync(join(frameworkRoot, "skills"), 0o2750);
    chmodSync(join(frameworkRoot, "skills", "using-spec-first"), 0o2750);
    writeFrameworkFixture(frameworkRoot);
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
    daemon = await createDaemon({ dbPath: join(directory, "t047.db"), managedMode: true, workersIsolation: "hardened",
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

  const createTask = (taskId = "task", paths = ["src"], dependencies: string[] = [], runId = "run",
    workflow?: import("../src/domain/team-workflows.js").WorkflowSelection) => {
    const receipt = governance.createTask(command(taskId, {
      assignment: { taskId, role: "implementer", paths, dependencies },
      outputs: [paths[0] + "/result.ts"], permissions: ["write-assigned-tree"],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file.",
      ...(workflow ? { workflow } : {}),
    }, runId), binding);
    if (receipt.status === "accepted") task = receipt.value as TeamTaskAuthority;
    return receipt;
  };

  /** The adapter seam: `launchManagedHarness` is what both production adapters call, so the
   *  launcher receives exactly the attempt the attachment put on the binding. The launcher
   *  itself is faked here; it reports whether the endpoint it would ask for is registered and
   *  returns the receipt the production launcher would return. */
  const launches: Array<{ attemptId: string | undefined; registered: boolean;
    context?: ContextManifest;
    previous?: import("../src/domain/runtime-adapter.js").ManagedSessionReceipt }> = [];
  const receipts: Array<import("../src/domain/runtime-adapter.js").ManagedSessionReceipt> = [];
  const launcher: import("../src/adapters/worker-launch.js").WorkerLauncher = {
    async launch(input) {
      launches.push({ attemptId: input.attempt.attemptId, registered: endpoints().has(input.attempt.attemptId),
        context: input.attempt.context,
        ...(input.attempt.previous ? { previous: input.attempt.previous } : {}) });
      const generation = (input.attempt.previous?.identity.generation ?? 0) + 1;
      const receipt = {
        identity: { nativeSessionId: input.resumeToken ?? "native-session", tmuxServer: "/tmp/tmux", paneId: "%3",
          processId: 1_000 + generation, processStart: "1", generation, policyFingerprint: binding.policyFingerprint },
        attemptId: input.attempt.attemptId, runId: input.attempt.context.runId, client: "claude-code" as const,
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
          VALUES (?, ?, ?, 'implementer', 'claude', ?, NULL, 'stopped', ?, 0, 1, ?, ?)`)
          .run(receipt.attemptId, receipt.runId, task.qitemId, JSON.stringify(receipt.identity), usage, now, now);
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

  it.each(FRAMEWORK_CATALOG)("dispatches $name through task admission, native context and durable outcomes", async entry => {
    db.prepare("UPDATE nodes SET role = 'implementer' WHERE id = ?").run(nodeId);
    const workflow = { entrypoint: entry.name, readOnly: entry.name === "spec-code-review" };
    const created = entry.invocation === "caller"
      ? governance.admitLeadProposal(command("proposal", {}), { kind: "daemon", sessionId: "daemon" }, binding,
        [{ taskId: "task", seat: "builder@rig", paths: ["src"], dependencies: [], body: "Run the requested workflow.", workflow }])
      : governance.createTask(command("task", {
        assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
        outputs: [], permissions: ["write-assigned-tree"], sourceSession: "owner-control",
        destinationSession: "builder@rig", body: "Run the requested workflow.", workflow,
      }), binding);
    expect(created.status).toBe("accepted");
    task = governance.findTask("run", "task")!;
    expect(task.workflow?.origin).toBe(entry.invocation === "caller" ? "caller" : "user");
    await launch();
    if (entry.name === "spec-test-xcode" || workflow.readOnly) {
      expect(launches).toHaveLength(0);
      expect(governance.workflowOutcomes("run")).toMatchObject([{ outcome: { status: "blocked",
        reason: expect.stringContaining(workflow.readOnly ? "read-only" : "macOS") } }]);
      return;
    }
    expect(launches).toHaveLength(1);
    const context = launches[0]!.context!;
    expect(context.workflow?.entrypoint).toBe(entry.name);
    expect(context.workflow?.nativeInvocation).toContain("/" + entry.name);
    expect(attemptInstructionFiles(context).some(file => file.path.endsWith(entry.sourcePath))).toBe(true);
    expect(governance.workflowOutcomes("run")[0]?.outcome).toBeNull();
    const outcome = recordWorkflowTurn(db, governance.getAttempt(receipts[0]!.attemptId)!,
      '<workflow-outcome>{"status":"complete","artifacts":[],"summary":"The requested fixture workflow was evaluated."}</workflow-outcome>');
    expect(outcome?.status).toBe("complete");
    expect(governance.workflowOutcomes("run")).toMatchObject([{ generation: 1, outcome: { status: "complete" } }]);
  });

  it("keeps the recorded SOUL on resume and applies an owner edit only to a new attempt", async () => {
    createTask(); await launch();
    const first = receipts[0]!;
    expect(launches[0]!.context?.soul).toMatchObject({ id: "engineer", version: 1 });
    saveTeamSoul(db, "rig", "engineer", { expectedVersion: 1, name: "Updated engineer", roles: ["implementer"], content: "Use the new project conventions." });
    await daemon.deps.workflowRuntime!.retireManagedAttempt(first.attemptId);
    await launch(false, "native-session");
    expect(launches[1]!.context?.soul).toEqual(launches[0]!.context?.soul);
    expect(receipts[1]!.contextHash).toBe(first.contextHash);
    await launch(true);
    expect(launches[2]!.context?.soul).toMatchObject({ id: "engineer", version: 2 });
  });
  it("allows the Lead to assign an explicit owner workflow once without forging its input or read-only scope", () => {
    db.prepare("UPDATE nodes SET role = 'implementer' WHERE id = ?").run(nodeId);
    appendChatMessage(db, { id: "owner-request", runId: "run", body: "/spec-handoff --read-only\nSummarize the current task.",
      createdAt: new Date().toISOString() });
    const proposal = [{ taskId: "task", seat: "builder@rig", paths: ["src"], dependencies: [], body: "Prepare the handoff.",
      workflow: { entrypoint: "spec-handoff" as const, ownerMessageId: "owner-request", readOnly: false, input: "Substituted input" } }];
    expect(governance.admitLeadProposal(command("proposal", {}), { kind: "daemon", sessionId: "daemon" }, binding, proposal).status).toBe("accepted");
    const assigned = governance.findTask("run", "task")!;
    expect(assigned.workflow).toMatchObject({ origin: "user", ownerMessageId: "owner-request", readOnly: true, input: "Summarize the current task." });
    expect(assigned.permissions).not.toContain("write-assigned-tree");
    governance.admitLeadProposal(command("reuse", {}), { kind: "daemon", sessionId: "daemon" }, binding,
      [{ ...proposal[0]!, taskId: "duplicate", paths: ["src/other.ts"] }]);
    expect(governance.findTask("run", "duplicate")).toBeNull();
    governance.admitLeadProposal(command("forged", {}), { kind: "daemon", sessionId: "daemon" }, binding,
      [{ ...proposal[0]!, taskId: "forged", paths: ["src/other.ts"], workflow: { ...proposal[0]!.workflow, ownerMessageId: "invented" } }]);
    expect(governance.findTask("run", "forged")).toBeNull();
  });

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

  it("attaches again when a managed seat resumes, which shares the same launch seam", async () => {
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

  it.each(["framework source", "recorded context"])("preserves an exact resume's work after a rejected %s check and records the later result", async failure => {
    createTask("task", ["src"], [], "run", { entrypoint: "spec-work", readOnly: false });
    expect((await launch()).ok).toBe(true);
    const first = receipts[0]!, runtime = daemon.deps.workflowRuntime!;
    const tree = runtime.candidateFor("run", "task").root;
    const work = join(tree, "src", "result.ts");
    writeFileSync(work, "export const result = 42;\n");
    await runtime.retireManagedAttempt(first.attemptId);
    const file = failure === "framework source" ? join(frameworkRoot, "skills", "spec-work", "SKILL.md")
      : launches[0]!.context!.files.find(item => item.kind === "soul")!.path;
    const original = readFileSync(file), mode = lstatSync(file).mode & 0o777;
    if (failure === "framework source") rmSync(file);
    else { chmodSync(file, 0o640); writeFileSync(file, "invalid recorded context\n"); chmodSync(file, mode); }

    expect((await launch(false, "native-session")).ok).toBe(false);
    expect(launches).toHaveLength(1);
    expect(existsSync(work)).toBe(true);
    expect(readFileSync(work, "utf8")).toBe("export const result = 42;\n");
    expect(governance.workflowOutcomes("run")).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: expect.objectContaining({ status: "blocked" }) }),
    ]));

    if (existsSync(file)) chmodSync(file, 0o640);
    writeFileSync(file, original); chmodSync(file, mode);
    expect((await launch(false, "native-session")).ok).toBe(true);
    expect(receipts[1]!.attemptId).toBe(first.attemptId);
    expect(receipts[1]!.identity.generation).toBe(2);
    expect(readFileSync(work, "utf8")).toBe("export const result = 42;\n");
    const outcome = recordWorkflowTurn(db, governance.getAttempt(first.attemptId)!,
      '<workflow-outcome>{"status":"complete","artifacts":["src/result.ts"],"summary":"Completed the resumed implementation."}</workflow-outcome>');
    expect(outcome?.status).toBe("complete");
    expect(governance.workflowOutcomes("run").map(item => item.outcome?.status).sort()).toEqual(["blocked", "complete"]);
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

  const createSiblingRun = (runId: string) => {
    governance.createRun({ id: runId, rigId: "rig", binding });
    const approvalId = `implementation-${runId}`;
    governance.requestApproval(command(approvalId, { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }, runId),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command(approvalId, { approvalVersion: 1, decision: "approved" }, runId),
      { kind: "owner", sessionId: "owner-control" }, binding);
  };

  it("attaches the exact run and task beyond two other records using the same task name", async () => {
    expect(createTask("task-1", ["src/one"]).status).toBe("accepted");
    createSiblingRun("r2");
    expect(createTask("task-1", ["src/two"], [], "r2").status).toBe("accepted");
    createSiblingRun("r3");
    expect(createTask("task-1", ["src/three"], [], "r3").status).toBe("accepted");
    const result = await daemon.deps.startupOrchestrator!.startNode({
      rigId: "rig", nodeId, sessionId, runId: "r3", taskId: "task-1",
      binding: { id: "binding-1", nodeId, tmuxSession: "builder@rig", tmuxWindow: null, tmuxPane: "%3",
        cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: seatTree }, adapter,
      plan: { runtime: "claude-code", cwd: seatTree, entries: [], diagnostics: [], conflicts: [], noOps: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "builder@rig", includeDurableObligations: false,
    });
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.runId).toBe("r3");
  });

  it("rejects a wrong run or task even when the seat has only one task", async () => {
    createTask();
    for (const selector of [{ runId: "another-run", taskId: "task" }, { runId: "run", taskId: "another-task" }]) {
      const result = await daemon.deps.startupOrchestrator!.startNode({
        rigId: "rig", nodeId, sessionId, ...selector,
        binding: { id: "binding-1", nodeId, tmuxSession: "builder@rig", tmuxWindow: null, tmuxPane: "%3",
          cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: seatTree }, adapter,
        plan: { runtime: "claude-code", cwd: seatTree, entries: [], diagnostics: [], conflicts: [], noOps: [] },
        resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "builder@rig", includeDurableObligations: false,
      });
      expect(result.ok).toBe(false);
    }
    expect(launches).toHaveLength(0);
    expect(endpoints().size).toBe(0);
  });

  it("dispatches an exact run and resumes only that task's durable native conversation", async () => {
    createTask();
    await launch();
    db.prepare("UPDATE team_attempts SET state='stopped' WHERE id=?").run(receipts[0]!.attemptId);
    const sessions = daemon.deps.sessionRegistry;
    sessions.updateResumeToken(sessionId, "claude_id", "another-conversation");
    sessions.updateStartupStatus(sessionId, "pending");
    createSiblingRun("new-discussion");
    createTask("task", ["src/new"], [], "new-discussion");
    const started = vi.spyOn(daemon.deps.startupOrchestrator!, "startNode").mockResolvedValue({
      ok: true, startupStatus: "ready", continuityOutcome: "fresh",
    } as never);
    const { composeTaskDispatch } = await import("../src/domain/task-dispatch.js");
    const dispatch = composeTaskDispatch({ rigRepo: daemon.deps.rigRepo, sessions,
      tmux: { hasSession: async () => true, listPanes: async () => [{ id: "%3" }] } as never,
      startupOrchestrator: daemon.deps.startupOrchestrator!, runtimeAdapters: { "claude-code": adapter },
      maxSessions: () => 3, liveSessions: () => 0 });
    await dispatch("new-discussion", "task");
    expect(started.mock.calls[0]![0]).toMatchObject({ runId: "new-discussion", taskId: "task" });
    expect(started.mock.calls[0]![0].continueSessionId).toBeUndefined();
    await dispatch("run", "task");
    expect(started.mock.calls[1]![0]).toMatchObject({ runId: "run", taskId: "task", continueSessionId: "native-session" });
    started.mockRestore();
  });

  it("attaches the named task when the dispatcher says which of a seat's two live tasks it starts", async () => {
    // Measured on the C4 rerun: both implementers completed, so the run created two review tasks
    // on the same reviewer seat, and the next review launch refused the seat as ambiguous. The
    // dispatcher already decided which task it is starting, so it names it and the composition
    // checks that name against the seat's rows instead of refusing both.
    expect(createTask("task-a", ["src/a.ts"]).status).toBe("accepted");
    // A second task on the same seat with its own write path, so the two claims do not overlap.
    expect(createTask("task-b", ["src/other.ts"]).status).toBe("accepted");
    const result = await daemon.deps.startupOrchestrator!.startNode({
      rigId: "rig", nodeId, sessionId, taskId: "task-b",
      binding: { id: "binding-1", nodeId, tmuxSession: "builder@rig", tmuxWindow: null, tmuxPane: "%3",
        cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: seatTree },
      adapter,
      plan: { runtime: "claude-code", cwd: seatTree, entries: [], diagnostics: [], conflicts: [], noOps: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "builder@rig",
      includeDurableObligations: false,
    });
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.registered).toBe(true);
    // A name that is not one of the seat's live tasks is still refused: the dispatcher cannot
    // point this launch at work the seat does not hold.
    const wrong = await daemon.deps.startupOrchestrator!.startNode({
      rigId: "rig", nodeId, sessionId, taskId: "task-missing",
      binding: { id: "binding-1", nodeId, tmuxSession: "builder@rig", tmuxWindow: null, tmuxPane: "%3",
        cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: seatTree },
      adapter,
      plan: { runtime: "claude-code", cwd: seatTree, entries: [], diagnostics: [], conflicts: [], noOps: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "builder@rig",
      includeDurableObligations: false,
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok ? [] : wrong.errors.join(" ")).toContain("Managed launch task is ambiguous");
    expect(launches).toHaveLength(1);
  });
});
