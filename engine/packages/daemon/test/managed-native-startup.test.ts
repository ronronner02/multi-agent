import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { canonicalJson, type PlanBinding, type TeamTaskAuthority } from "../src/contracts/team-control.js";
import type { TeamControlOptions } from "../src/routes/team-control.js";
import { createManagedLaunchControl, inspectManagedWorker, observeManagedWorkerProcess, resolveManagedWorkerScope, resolveManagedWorkerSeat, startManagedWorkerCommand, startManagedWorkerInPane } from "../src/adapters/worker-launch-control.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

import { buildManagedNativePolicy, projectContext, roleConfiguration, roleInstructionEntries, type ContextManifest } from "../src/integrations/framework/context-manifest.js";
import { FRAMEWORK_PIN } from "../src/integrations/framework/catalog.js";
import type { WorkerMailboxBridge } from "../src/adapters/worker-mailbox-bridge.js";
import { RestrictedWorkerLauncher, UNSUPPORTED_CLIENT_VERSION, type WorkerCommand, type WorkerLaunchInput } from "../src/adapters/worker-launch.js";

const inspectionIo = vi.hoisted(() => ({ execFile: vi.fn(), readPolicy: vi.fn(), end: vi.fn() }));
const processIo = vi.hoisted(() => ({ list: vi.fn(), stats: new Map<string, string>() }));
vi.mock("../src/domain/native-process-lineage.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/domain/native-process-lineage.js")>(), listNativeProcesses: processIo.list,
}));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFile: inspectionIo.execFile,
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
    processIo.stats.has(String(args[0])) ? processIo.stats.get(String(args[0]))
      : args[0] === "/etc/multi-agent/worker-policy.json" ? inspectionIo.readPolicy() : actual.readFileSync(...args) };
});

const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "plan.md", planDigest: "sha256:" + "a".repeat(64), repository: { root: "/workspace/project", identity: "git:" + "b".repeat(40) },
  readPaths: ["src"], writePaths: ["src"], roles: ["implementer", "reviewer"], policyRevision: 5,
  policyFingerprint: "sha256:" + "c".repeat(64),
  limits: { maxSessions: 3, maxActiveMs: 60_000, maxRetries: 1, maxReviewRounds: 2 },
};

describe("managed launch governed scope resolution", () => {
  let db: ReturnType<typeof createDb>, queue: QueueRepository, governance: PlanGovernance;
  let options: TeamControlOptions, task: TeamTaskAuthority, serial: number, now: number;
  const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run",
    actionId, expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "scope-" + ++serial, payload });
  const context = () => ({ runId: "run", binding, assignment: task.assignment, role: task.assignment.role, client: "claude-code" as const });
  const resolve = () => resolveManagedWorkerScope(context(), { db, queue, governance, options });
  const counts = () => ({
    attempts: db.prepare("SELECT count(*) AS count FROM team_attempts").get(),
    messages: db.prepare("SELECT count(*) AS count FROM chat_messages").get(),
    requests: db.prepare("SELECT count(*) AS count FROM team_control_requests").get(),
  });
  beforeEach(() => {
    db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs(id, name) VALUES ('rig', 'fixture')").run();
    const events = new EventBus(db); queue = new QueueRepository(db, events);
    options = { credentials: { ownerToken: "owner-fixture", workers: [{ token: "worker-fixture", sessionId: "builder@rig", runId: "run" }] },
      resolveBinding: () => structuredClone(binding),
      readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] }) };
    now = Date.parse("2026-10-19T00:00:00Z");
    governance = new PlanGovernance(db, events, queue, () => new Date(now), options.readPolicyCapability);
    serial = 0;
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-10-20T00:00:00.000Z" }),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }),
      { kind: "owner", sessionId: "owner-control" }, binding);
    const created = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] }, outputs: [], permissions: [],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file." }), binding);
    expect(created.status).toBe("accepted"); task = created.value as TeamTaskAuthority;
  });
  afterEach(() => db.close());

  it("resolves the persisted task and queue destination without creating launch or message state", () => {
    const before = counts(), scope = resolve();
    expect(scope).toMatchObject({ run: { id: "run", rigId: "rig" }, task: { qitemId: task.qitemId },
      sessionId: "builder@rig", currentBinding: binding });
    expect(task.qitemId).not.toBe(task.assignment.taskId);
    expect(JSON.stringify(scope)).not.toMatch(/owner-fixture|worker-fixture/);
    expect(counts()).toEqual(before);
  });

  it.each(["missing-task", "foreign-run", "assignment", "role", "client"] as const)("rejects %s context claims without writes", field => {
    const request = structuredClone(context()), before = counts();
    if (field === "missing-task") request.assignment.taskId = "missing";
    else if (field === "foreign-run") request.runId = "foreign";
    else if (field === "assignment") request.assignment.paths = ["src/other"];
    else if (field === "role") request.role = "reviewer";
    else (request as { client: string }).client = "unknown";
    expect(() => resolveManagedWorkerScope(request, { db, queue, governance, options })).toThrow();
    expect(counts()).toEqual(before);
  });

  it.each(["missing", "foreign-run", "foreign-session", "conflict", "legacy"] as const)("rejects %s worker credentials through the shared resolver", field => {
    if (field === "missing") options.credentials.workers = [];
    else if (field === "foreign-run") options.credentials.workers = [{ token: "worker-fixture", sessionId: "builder@rig", runId: "other" }];
    else if (field === "foreign-session") options.credentials.workers = [{ token: "worker-fixture", sessionId: "other@rig", runId: "run" }];
    else if (field === "conflict") options.credentials.ownerToken = "worker-fixture";
    const before = counts();
    expect(() => resolveManagedWorkerScope(context(), { db, queue, governance, options,
      legacyTokens: field === "legacy" ? ["worker-fixture"] : [] })).toThrow();
    expect(counts()).toEqual(before);
  });

  it.each(["missing-resolver", "source-drift", "claimed-binding"] as const)("rejects %s binding evidence", field => {
    const request = structuredClone(context());
    if (field === "missing-resolver") options.resolveBinding = undefined;
    else if (field === "source-drift") options.resolveBinding = () => ({ ...binding, planDigest: "sha256:" + "d".repeat(64) });
    else request.binding.planDigest = "sha256:" + "e".repeat(64);
    const before = counts();
    expect(() => resolveManagedWorkerScope(request, { db, queue, governance, options })).toThrow();
    expect(counts()).toEqual(before);
  });

  it("re-reads cancellation and credential revocation rather than caching admission", () => {
    resolve(); options.credentials.workers = [];
    expect(resolve).toThrow();
    options.credentials.workers = [{ token: "worker-fixture", sessionId: "builder@rig", runId: "run" }];
    resolve(); governance.cancelRun(command("cancel", { reason: "Owner cancellation fixture" }), { kind: "owner", sessionId: "owner-control" });
    const before = counts(); expect(resolve).toThrow(); expect(counts()).toEqual(before);
  });

  it("rejects a blocked queue item even while its run remains approved", () => {
    governance.transitionTask(command(task.qitemId, { expectedTaskVersion: task.entityVersion, actorSession: "builder@rig",
      state: "blocked", blockedOn: "owner-decision" }), binding);
    const before = counts(); expect(resolve).toThrow(); expect(counts()).toEqual(before);
  });

  describe("persisted managed seat resolution", () => {
    let rigRepo: RigRepository, sessions: SessionRegistry, nodeId: string, tree: string;
    const seat = () => resolveManagedWorkerSeat(context(), { db, queue, governance, options, rigRepo, sessions });
    beforeEach(() => {
      tree = mkdtempSync(join(tmpdir(), "managed-assigned-tree-"));
      rigRepo = new RigRepository(db); sessions = new SessionRegistry(db);
      nodeId = rigRepo.addNode("rig", "persisted-seat", { runtime: "claude-code", cwd: tree }).id;
      sessions.registerSession(nodeId, "builder@rig");
      sessions.updateBinding(nodeId, { tmuxSession: "builder@rig", tmuxPane: "%3" });
    });
    afterEach(() => rmSync(tree, { recursive: true, force: true }));

    describe("managed process observation", () => {
      const PANE = 400, SUPERVISOR = 401, RELAY = 402, NATIVE = 403, CODEX_ENTRY = 404;
      const SESSION = "01a154fe-b417-7933-b7a4-a8c840f721e9", ns = { mountNamespace: "mnt:[7]", userNamespace: "user:[8]", networkNamespace: "net:[9]" };
      const start = (pid: number) => String(12_000 + pid);
      const hash = (digit: string) => "sha256:" + digit.repeat(64);
      const managed = "/context/native/claude/managed-settings.json", alias = "/etc/claude-code/managed-settings.json";
      let toolchain: string, node: string, input: WorkerLaunchInput, command: WorkerCommand, intent: Record<string, unknown>;
      let result: any, panePids: number[], clientLock: { files: { path: string }[] }, getIntent: ReturnType<typeof vi.spyOn>;
      const observe = (expectedSession?: { nativeSessionId: string; rollout?: { device: number; inode: number } }) =>
        observeManagedWorkerProcess(input, command, { db, queue, governance, options, rigRepo, sessions,
          tmux: { getPanePid: async () => panePids.shift() ?? PANE }, clientLock, toolchainDir: toolchain, expectedSession });
      const setStart = (pid: number, value: string) => processIo.stats.set("/proc/" + pid + "/stat",
        pid + " (fixture) S 1 " + Array(17).fill("0").join(" ") + " " + value);
      const reply = (stderr = "", before = () => {}) => inspectionIo.execFile.mockImplementation((_file, _args, _options, callback) => {
        before(); callback(null, JSON.stringify(result), stderr); return { stdin: { end: inspectionIo.end } };
      });
      const useClient = (client: "claude-code" | "codex", resumeToken?: string) => {
        const exe = toolchain + (client === "codex" ? "/clients/lib/codex-native" : "/clients/lib/claude.exe");
        const argv = client === "codex"
          ? [toolchain + "/clients/bin/codex", "-a", "never", ...(resumeToken ? ["resume", resumeToken] : [])]
          : [toolchain + "/clients/bin/claude", "--permission-mode", "bypassPermissions", ...(resumeToken ? ["--resume", resumeToken] : ["--session-id", "native-session"])];
        db.prepare("UPDATE nodes SET runtime = ?").run(client);
        clientLock = { files: client === "codex" ? [{ path: "clients/lib/codex.js" }, { path: "clients/lib/codex-native" }] : [{ path: "clients/lib/claude.exe" }] };
        input = { client, ...(resumeToken ? { resumeToken } : {}), attempt: { attemptId: "process-attempt", deadline: now + 60_000,
          context: { ...context(), client, generatedHash: hash("f"), workerUid: 992,
            files: [{ workerPath: "/context/instructions", hash: hash("1") }, { workerPath: managed, hash: hash("2") }],
            workerDiscoveryRoots: ["/context"], nativePolicy: { aliases: [{ source: managed, target: alias }] } } as unknown as ContextManifest } };
        command = { file: "/usr/bin/sudo", args: ["-n", "--", "/usr/local/libexec/multi-agent/worker-launch", "--supervise",
          "--worker", "ma-worker1", "--", ...argv], nativeArgv: argv, client, attemptId: input.attempt.attemptId,
          deadline: input.attempt.deadline, contextHash: input.attempt.context.generatedHash,
          network: { mode: "filtered-proxy", hostNamespace: "net:[1]", profileFingerprint: binding.policyFingerprint, preflightRef: "evidence.json" } };
        intent = { state: "admitted", command: structuredClone(command), commandDigest: hashBytes(canonicalJson(command)), sessionId: "builder@rig" };
        const supervisorArgv = [process.execPath, "/usr/local/libexec/multi-agent/worker-launch.mjs", "--supervise", ...command.args.slice(4)];
        processIo.list.mockResolvedValue([{ pid: SUPERVISOR, ppid: PANE, command: supervisorArgv.join(" ") },
          { pid: 499, ppid: 1, command: supervisorArgv.join(" ") }]);
        const lineage = [{ processId: RELAY, processStart: start(RELAY), executable: node },
          ...(client === "codex" ? [{ processId: CODEX_ENTRY, processStart: start(CODEX_ENTRY), executable: node }] : []),
          { processId: NATIVE, processStart: start(NATIVE), executable: exe }];
        result = { schema: "multi-agent-sandbox-control/v1", supervisor: { processId: SUPERVISOR, processStart: start(SUPERVISOR) },
          commandDigest: hashBytes(JSON.stringify(supervisorArgv)), uid: 992, pidNamespace: "pid:[2]",
          snapshot: { pane: { processId: PANE, processStart: start(PANE) }, sandbox: { ...ns }, lineage,
            process: { processId: NATIVE, processStart: start(NATIVE), processGroupId: NATIVE, namespacePids: [NATIVE, 3],
              uids: [992, 992, 992, 992], groups: [], capabilities: "0000000000000000", noNewPrivileges: "1",
              argv: [client === "codex" ? exe : argv[0], ...argv.slice(1)], executable: exe, cwd: "/work",
              environment: { HOME: "/home/worker" }, ...ns, pidNamespace: "pid:[2]" },
            mountInfo: "", stdio: [0, 1, 2].map(fd => ({ fd, kind: "tty" })), files: [{ path: "/context/instructions", hash: hash("1") }, { path: managed, hash: hash("2") },
              { path: alias, hash: hash("2") }], discoveryRoots: ["/context"],
            nativeSessions: client === "codex" ? [{ id: resumeToken ?? SESSION, createdAfterStart: !resumeToken,
              rollout: { device: 2049, inode: 77 } }] : [] } };
        reply();
      };
      beforeEach(() => {
        toolchain = realpathSync(mkdtempSync(join(tmpdir(), "managed-toolchain-")));
        for (const file of ["node/bin/node", "clients/lib/claude.exe", "clients/lib/codex.js", "clients/lib/codex-native"]) {
          mkdirSync(join(toolchain, file, ".."), { recursive: true }); writeFileSync(join(toolchain, file), "");
        }
        node = join(toolchain, "node/bin/node"); panePids = [];
        processIo.stats.clear(); processIo.list.mockReset(); inspectionIo.execFile.mockReset(); inspectionIo.end.mockReset();
        for (const pid of [PANE, SUPERVISOR, NATIVE]) setStart(pid, start(pid));
        getIntent = vi.spyOn(governance, "getNativeLaunchIntent").mockImplementation(() => intent as any);
        useClient("claude-code");
      });
      afterEach(() => { getIntent.mockRestore(); processIo.stats.clear(); rmSync(toolchain, { recursive: true, force: true }); });

      it("lets the privileged helper select the native process below the pane-bound supervisor", async () => {
        const observed = await observe();
        expect(observed).toMatchObject({ nativeSessionId: "native-session", pane: { processId: PANE, processStart: start(PANE) },
          supervisor: { processId: SUPERVISOR, processStart: start(SUPERVISOR) }, native: { processId: NATIVE, processStart: start(NATIVE) } });
        expect(inspectionIo.execFile.mock.calls[0]!.slice(0, 2)).toEqual(["/usr/bin/sudo", ["-n", "--",
          "/usr/local/libexec/multi-agent/worker-launch", "--observe", SUPERVISOR + ":" + start(SUPERVISOR), ...command.args.slice(4)]]);
        // The query names no process: worker-visible rows cannot select the native.
        expect(JSON.parse(inspectionIo.end.mock.calls[0]![0])).toEqual({ pane: { processId: PANE, processStart: start(PANE) },
          files: ["/context/instructions", managed, alias], discoveryRoots: ["/context"] });
      });

      it.each([undefined, "resumed-session"])("binds a Claude session to its control-chosen argv token (resume=%s)", async token => {
        useClient("claude-code", token);
        await expect(observe()).resolves.toMatchObject({ nativeSessionId: token ?? "native-session" });
      });

      it.each([undefined, SESSION])("adopts a Codex session only from its own fresh or exactly resumed rollout (resume=%s)", async token => {
        useClient("codex", token);
        await expect(observe()).resolves.toMatchObject({ nativeSessionId: token ?? SESSION, native: { processId: NATIVE },
          rollout: { device: 2049, inode: 77 } });
      });

      it("keeps a later observation bound to the first session and rollout file", async () => {
        useClient("codex");
        const first = await observe();
        await expect(observe({ nativeSessionId: first.nativeSessionId!, rollout: first.rollout })).resolves.toMatchObject({ nativeSessionId: SESSION });
        // After tools run, the worker can rename its rollout to another UUID or swap in a different file.
        result.snapshot.nativeSessions[0].id = "f".repeat(8) + SESSION.slice(8);
        await expect(observe({ nativeSessionId: SESSION, rollout: first.rollout })).rejects.toThrow(/^managed_process_observation_unverified$/);
        result.snapshot.nativeSessions[0] = { id: SESSION, createdAfterStart: true, rollout: { device: 2049, inode: 78 } };
        await expect(observe({ nativeSessionId: SESSION, rollout: first.rollout })).rejects.toThrow(/^managed_process_observation_unverified$/);
        useClient("claude-code");
        await expect(observe({ nativeSessionId: "other-session" })).rejects.toThrow(/^managed_process_observation_unverified$/);
      });

      it.each(["none", "two", "reused-file", "held-elsewhere", "foreign-resume", "no-rollout"])("rejects a %s Codex session claim", async field => {
        useClient("codex", field === "foreign-resume" ? SESSION : undefined);
        const sessions = result.snapshot.nativeSessions;
        if (field === "none") sessions.pop();
        else if (field === "two") sessions.push({ id: "f".repeat(8) + SESSION.slice(8), createdAfterStart: true, rollout: { device: 2049, inode: 78 } });
        else if (field === "no-rollout") delete sessions[0].rollout;
        else if (field === "reused-file") sessions[0].createdAfterStart = false;
        else if (field === "foreign-resume") sessions[0].id = "f".repeat(8) + SESSION.slice(8);
        else db.prepare(`INSERT INTO team_attempts(id, run_id, role, provider, identity_json, state, usage_json, active_ms, created_at, updated_at)
          VALUES ('earlier', 'run', 'implementer', 'codex', ?, 'stopped', '{}', 0, 'now', 'now')`).run(JSON.stringify({ nativeSessionId: SESSION }));
        await expect(observe()).rejects.toThrow(/^managed_process_observation_unverified$/);
      });

      it.each(["intent", "command-digest", "supervisor", "no-supervisor", "supervisor-outside-pane", "pane", "lineage", "replaced-executable",
        "argv0", "argv", "stdio", "uid", "capabilities", "cwd", "namespace", "file-hash", "alias-hash", "missing-file", "discovery", "stderr",
        "pane-respawn", "native-restart", "seat-drift"])("rejects %s evidence without accepting worker assertions", async field => {
        const snapshot = result.snapshot, facts = snapshot.process;
        if (field === "intent") intent.commandDigest = hash("0");
        else if (field === "command-digest") result.commandDigest = hash("0");
        else if (field === "supervisor") result.supervisor.processStart = "0";
        else if (field === "no-supervisor") processIo.list.mockResolvedValue([]);
        else if (field === "supervisor-outside-pane") processIo.list.mockResolvedValue([{ ...(await processIo.list())[0], ppid: 1 }]);
        else if (field === "pane") snapshot.pane.processStart = "0";
        else if (field === "lineage") snapshot.lineage[0].executable = "/usr/bin/node";
        // G1: an exec keeps the PID, start time and argv, but the kernel reports the replacement image.
        else if (field === "replaced-executable") facts.executable = "/scratch/impostor";
        else if (field === "argv0") facts.argv[0] = "/scratch/impostor";
        else if (field === "argv") facts.argv.push("--resume", "foreign");
        else if (field === "stdio") snapshot.stdio[1].kind = "pipe";
        else if (field === "uid") facts.uids[2] = 0;
        else if (field === "capabilities") facts.capabilities = "1";
        else if (field === "cwd") facts.cwd = "/";
        else if (field === "namespace") facts.mountNamespace = "mnt:[66]";
        else if (field === "file-hash") snapshot.files[0].hash = hash("3");
        else if (field === "alias-hash") snapshot.files[2].hash = hash("3");
        else if (field === "missing-file") snapshot.files.pop();
        else if (field === "discovery") snapshot.discoveryRoots = ["/"];
        else if (field === "stderr") reply("owner-fixture");
        // G3: the persisted pane identifier is unchanged while tmux reports a different live process.
        else if (field === "pane-respawn") panePids = [PANE, 499];
        // G2: the selected native exits and its PID is reused while the helper runs.
        else if (field === "native-restart") reply("", () => setStart(NATIVE, "99999"));
        else reply("", () => sessions.updateBinding(nodeId, { tmuxSession: "builder@rig", tmuxPane: "%9" }));
        await expect(observe()).rejects.toThrow(/^managed_process_observation_unverified$/);
      });
    });

    it("rejects two live nodes with the same governed destination name", () => {
      const other = rigRepo.addNode("rig", "duplicate-seat", { runtime: "claude-code", cwd: tree });
      sessions.registerSession(other.id, "builder@rig");
      sessions.updateBinding(other.id, { tmuxSession: "builder@rig", tmuxPane: "%4" });
      const before = counts();
      expect(seat).toThrow("managed_launch_seat_unverified");
      expect(counts()).toEqual(before);
    });

    it("uses the current session's node cwd and exact persisted pane without changing authority", () => {
      const before = counts();
      expect(seat()).toMatchObject({ nodeId, tree, pane: "%3", scope: { sessionId: "builder@rig" } });
      expect(seat().sessionRecordId).toBe(sessions.findResumeContextByName("builder@rig")!.sessionId);
      expect(counts()).toEqual(before);
      expect(JSON.stringify(seat())).not.toMatch(/owner-fixture|worker-fixture/);
    });

    it.each(["missing-session", "stopped-session", "superseded-session", "runtime", "missing-tree",
      "relative-tree", "missing-binding", "foreign-terminal", "invalid-pane"] as const)(
      "rejects %s persisted seat state without an admission or effect", field => {
        if (field === "missing-session") db.prepare("DELETE FROM sessions").run();
        else if (field === "stopped-session") db.prepare("UPDATE sessions SET status = 'stopped'").run();
        else if (field === "superseded-session") {
          const newer = sessions.registerSession(nodeId, "builder@rig");
          sessions.markSuperseded(newer.id);
        } else if (field === "runtime") db.prepare("UPDATE nodes SET runtime = 'codex'").run();
        else if (field === "missing-tree") db.prepare("UPDATE nodes SET cwd = NULL").run();
        else if (field === "relative-tree") db.prepare("UPDATE nodes SET cwd = 'relative/tree'").run();
        else if (field === "missing-binding") sessions.clearBinding(nodeId);
        else if (field === "foreign-terminal") sessions.updateBinding(nodeId, { tmuxSession: "other@rig" });
        else sessions.updateBinding(nodeId, { tmuxPane: "builder@rig:0.0" });
        const before = counts();
        expect(seat).toThrow("managed_launch_seat_unverified");
        expect(counts()).toEqual(before);
      });

    it("rejects an alias rather than resolving it to a different assigned tree", () => {
      const alias = tree + "-alias";
      symlinkSync(tree, alias);
      try {
        db.prepare("UPDATE nodes SET cwd = ?").run(alias);
        expect(seat).toThrow("managed_launch_seat_unverified");
      } finally { rmSync(alias); }
    });

    it("re-reads the tree and pane after a persisted assignment change", () => {
      expect(seat()).toMatchObject({ tree, pane: "%3" });
      sessions.updateBinding(nodeId, { tmuxPane: "%9" });
      expect(seat()).toMatchObject({ tree, pane: "%9" });
      options.credentials.workers = [];
      expect(seat).toThrow("managed_launch_seat_unverified");
    });
  });

  describe("governed start sequencing", () => {
    const launchInput = (): WorkerLaunchInput => ({ client: "claude-code", attempt: {
      attemptId: "attempt", deadline: now + 30_000,
      context: { ...context(), projection: { attemptId: "attempt" }, generatedHash: "sha256:" + "f".repeat(64) } as ContextManifest,
    } });
    const launchCommand = (): WorkerCommand => ({ file: "/usr/bin/sudo",
      args: ["-n", "--", "/usr/local/libexec/multi-agent/worker-launch", "--supervise", "--worker", "ma-worker1",
        "--role", "implementer", "--tree", "/assigned/tree", "--run", "run", "--attempt", "attempt", "--",
        "/opt/multi-agent/toolchain/clients/bin/claude", "--session-id", "native-fixture"],
      attemptId: "attempt", deadline: now + 30_000, contextHash: "sha256:" + "f".repeat(64), client: "claude-code",
      nativeArgv: ["/opt/multi-agent/toolchain/clients/bin/claude", "--session-id", "native-fixture"],
      network: { mode: "filtered-proxy", hostNamespace: "net:[1]", profileFingerprint: "sha256:" + "a".repeat(64), preflightRef: "evidence/preflight" } });
    const start = <T>(input: WorkerLaunchInput, body: WorkerCommand, effect: (command: Readonly<WorkerCommand>) => Promise<T>) =>
      startManagedWorkerCommand(input, body, { db, queue, governance, options, start: effect, now: () => now });

    it("commits the exact immutable command before entering the start transport", async () => {
      const input = launchInput(), body = launchCommand(), expected = structuredClone(body);
      const effect = vi.fn(async (received: Readonly<WorkerCommand>) => {
        expect(db.inTransaction).toBe(false);
        expect(governance.getNativeLaunchIntent("run", "attempt")).toMatchObject({
          state: "admitted", command: expected, commandDigest: hashBytes(canonicalJson(expected)), sessionId: "builder@rig" });
        expect(governance.getAttempt("attempt")).toBeNull();
        expect(Object.isFrozen(received.args)).toBe(true);
        body.args.push("changed-after-admission");
        expect(received).toEqual(expected);
        return { transportAccepted: true };
      });
      await expect(start(input, body, effect)).resolves.toEqual({ transportAccepted: true });
      expect(effect).toHaveBeenCalledTimes(1);
      await expect(start(input, expected, effect)).rejects.toThrow("managed_start_admission_denied");
      expect(effect).toHaveBeenCalledTimes(1);
    });

    it.each(["context", "deadline", "client", "attempt", "owner", "worker", "binding", "secret"])("blocks %s drift before any start effect", async field => {
      const input = launchInput(), body = launchCommand(), effect = vi.fn();
      if (field === "context") body.contextHash = "sha256:" + "e".repeat(64);
      else if (field === "deadline") body.deadline = now;
      else if (field === "client") body.client = "codex";
      else if (field === "attempt") body.attemptId = "foreign";
      else if (field === "owner") options.credentials.ownerToken = null;
      else if (field === "worker") options.credentials.workers = [];
      else if (field === "binding") options.resolveBinding = () => ({ ...binding, policyRevision: 6 });
      else body.args.push("owner-fixture");
      await expect(start(input, body, effect)).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
      expect(governance.getNativeLaunchIntent("run", "attempt")).toBeNull();
      expect(governance.getAttempt("attempt")).toBeNull();
    });

    it("does not start when durable admission fails", async () => {
      db.exec(`CREATE TRIGGER fail_start_intent BEFORE INSERT ON events
        WHEN json_extract(NEW.payload, '$.action') = 'attempt.launch-intent'
        BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END`);
      const effect = vi.fn();
      await expect(start(launchInput(), launchCommand(), effect)).rejects.toThrow("managed_start_admission_denied");
      expect(effect).not.toHaveBeenCalled();
      expect(governance.getNativeLaunchIntent("run", "attempt")).toBeNull();
    });

    it("preserves unresolved intent when the transport throws and never grants a replay", async () => {
      const effect = vi.fn(async () => { throw new Error("transport error containing owner-fixture"); });
      await expect(start(launchInput(), launchCommand(), effect)).rejects.toThrow("managed_start_unconfirmed");
      expect(governance.getNativeLaunchIntent("run", "attempt")).toMatchObject({ state: "admitted", command: launchCommand() });
      expect(governance.getAttempt("attempt")).toBeNull();
      await expect(start(launchInput(), launchCommand(), effect)).rejects.toThrow("managed_start_admission_denied");
      expect(effect).toHaveBeenCalledTimes(1);
    });

    it("rejects a concurrent start while the first transport is pending", async () => {
      let finish!: () => void;
      const effect = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
      const pending = start(launchInput(), launchCommand(), effect);
      try {
        await expect(start(launchInput(), launchCommand(), effect)).rejects.toThrow("managed_start_admission_denied");
        expect(effect).toHaveBeenCalledTimes(1);
      } finally { finish(); await pending; }
    });

    it("uses the terminal owner and exact quoted argv after admission without typing terminal input", async () => {
      const body = launchCommand(); body.args.push("quoted ' value; $(sentinel)");
      const effects: string[][] = [];
      const tmux = new TmuxAdapter(async () => { throw new Error("unexpected shell transport"); }, undefined, async argv => {
        if (argv[1] === "respawn-pane") {
          expect(governance.getNativeLaunchIntent("run", "attempt")?.command).toEqual(body);
          expect(db.inTransaction).toBe(false);
        }
        effects.push(argv); return "";
      });
      const resolvePane = vi.fn(async sessionId => { expect(sessionId).toBe("builder@rig"); return "%42"; });
      await expect(startManagedWorkerInPane(launchInput(), body, { db, queue, governance, options, tmux,
        resolvePane, now: () => now })).resolves.toEqual({ pane: "%42" });
      const respawns = effects.filter(argv => argv[1] === "respawn-pane");
      expect(respawns).toHaveLength(1);
      expect(respawns[0]!.slice(0, 6)).toEqual(["tmux", "respawn-pane", "-t", "%42", "-c", "/"]);
      const line = respawns[0]!.at(-1)!;
      expect(line.startsWith("exec ")).toBe(true);
      const parsed = spawnSync("/bin/sh", ["-c", "set -- " + line.slice(5) + "; printf '%s\\0' \"$@\""]);
      expect(parsed.status).toBe(0);
      expect(parsed.stdout.toString().split("\0").slice(0, -1)).toEqual([body.file, ...body.args]);
      expect(effects.some(argv => ["send-keys", "load-buffer", "paste-buffer"].includes(argv[1]!))).toBe(false);
    });

    it("leaves a terminal transport failure unresolved and strips its diagnostics", async () => {
      const tmux = { respawnPane: vi.fn(async () => ({ ok: false as const, code: "tmux_unavailable" as const, message: "owner-fixture" })) };
      await expect(startManagedWorkerInPane(launchInput(), launchCommand(), { db, queue, governance, options,
        tmux, resolvePane: async () => "%42", now: () => now })).rejects.toThrow(/^managed_start_unconfirmed$/);
      expect(governance.getNativeLaunchIntent("run", "attempt")?.state).toBe("admitted");
      expect(governance.getAttempt("attempt")).toBeNull();
    });

    it.each(["expiry", "owner-revocation", "worker-revocation", "run-cancellation", "task-block",
      "session-reassignment", "binding-drift", "intent-digest", "intent-command"] as const)(
      "blocks %s while the terminal owner awaits environment metadata", async field => {
      const body = launchCommand(), effects: string[][] = [];
      let entered!: () => void, release!: (value: string) => void;
      const metadataPending = new Promise<void>(resolve => { entered = resolve; });
      const tmux = new TmuxAdapter(async () => { throw new Error("unexpected shell transport"); }, undefined, async argv => {
        effects.push(argv);
        if (argv[1] === "show-environment") {
          entered(); return new Promise<string>(resolve => { release = resolve; });
        }
        return "";
      });
      const pending = startManagedWorkerInPane(launchInput(), body, { db, queue, governance, options,
        tmux, resolvePane: async () => "%42", now: () => now });
      await metadataPending;
      if (field === "expiry") now = body.deadline;
      else if (field === "owner-revocation") options.credentials.ownerToken = null;
      else if (field === "worker-revocation") options.credentials.workers = [];
      else if (field === "run-cancellation") governance.cancelRun(command("cancel", { reason: "Owner cancellation fixture" }),
        { kind: "owner", sessionId: "owner-control" });
      // Persist external queue drift directly: worker transitions are intentionally denied while a launch is unresolved.
      else if (field === "task-block") db.prepare("UPDATE queue_items SET state = 'blocked' WHERE qitem_id = ?").run(task.qitemId);
      else if (field === "session-reassignment") {
        options.credentials.workers!.push({ token: "replacement-fixture", sessionId: "replacement@rig", runId: "run" });
        db.prepare("UPDATE queue_items SET destination_session = ? WHERE qitem_id = ?").run("replacement@rig", task.qitemId);
      } else if (field === "binding-drift") options.resolveBinding = () => ({ ...binding, policyRevision: 6 });
      else {
        const intent = governance.getNativeLaunchIntent("run", "attempt")!;
        const altered = field === "intent-digest" ? { ...intent, commandDigest: "sha256:" + "e".repeat(64) }
          : { ...intent, command: { ...body, args: [...body.args, "changed-during-lookup"] } };
        vi.spyOn(governance, "getNativeLaunchIntent").mockReturnValue(altered);
      }
      release("");
      const outcome = await pending.then(value => ({ value }), error => ({ error: (error as Error).message }));
      expect(effects.filter(argv => argv[1] === "respawn-pane")).toEqual([]);
      expect(outcome).toEqual({ error: "managed_start_unconfirmed" });
      expect(governance.getNativeLaunchIntent("run", "attempt")?.state).toBe("admitted");
      expect(governance.getAttempt("attempt")).toBeNull();
    });

    it("snapshots the command before asynchronous terminal resolution", async () => {
      const input = launchInput(), body = launchCommand(), expected = structuredClone(body);
      let resolved!: (pane: string) => void;
      const tmux = { respawnPane: vi.fn(async () => ({ ok: true as const })) };
      const pending = startManagedWorkerInPane(input, body, { db, queue, governance, options, tmux,
        resolvePane: () => new Promise(resolve => { resolved = resolve; }), now: () => now });
      body.args.push("changed-while-resolving"); input.attempt.attemptId = "changed";
      resolved("%42");
      await expect(pending).resolves.toEqual({ pane: "%42" });
      expect(governance.getNativeLaunchIntent("run", "attempt")?.command).toEqual(expected);
    });
  });

  describe("owner-controlled native admission", () => {
    const owner = { kind: "owner" as const, sessionId: "owner-control" };
    const commandDigest = "sha256:" + "d".repeat(64);
    const payload = () => ({ qitemId: task.qitemId, expectedTaskVersion: task.entityVersion,
      sessionId: "builder@rig", provider: "claude", commandDigest, previousAttemptId: null, expectedPreviousVersion: null });
    const admit = (id = "attempt") => governance.admitNativeAttempt(command(id, payload()), owner, binding);

    it("persists one effect grant without claiming an observed native identity", () => {
      const request = command("attempt", payload()), first = governance.admitNativeAttempt(request, owner, binding);
      expect(first).toMatchObject({ status: "pending-execution", effectMayStart: true, replayed: false });
      expect(governance.getAttempt("attempt")).toBeNull();
      expect(governance.getNativeLaunchIntent("run", "attempt")).toMatchObject({
        state: "admitted", commandDigest, qitemId: task.qitemId, sessionId: "builder@rig", generation: 1, previous: null });
      expect(governance.getRun("run").accountedAt).toBe("2026-10-19T00:00:00.000Z");
      expect(governance.admitNativeAttempt(request, owner, binding)).toMatchObject({ replayed: true, effectMayStart: false });
      expect(() => governance.admitNativeAttempt({ ...request, payload: { ...payload(), commandDigest: "sha256:" + "e".repeat(64) } },
        owner, binding)).toThrow(/idempotency/);
      expect(admit()).toMatchObject({ status: "denied", effectMayStart: false });
    });

    describe("immutable native command snapshots", () => {
      const snapshot = () => ({ file: "/usr/bin/sudo", args: ["-n", "--", "/usr/local/libexec/multi-agent/worker-launch",
        "--worker", "ma-worker1", "--role", "implementer", "--tree", "/assigned/tree", "--run", "run", "--attempt", "attempt",
        "--mailbox", "1:23", "--", "/opt/multi-agent/toolchain/clients/bin/claude", "--session-id", "native-fixture"],
        attemptId: "attempt", deadline: now + 60_000, contextHash: "sha256:" + "f".repeat(64), client: "claude-code",
        nativeArgv: ["/opt/multi-agent/toolchain/clients/bin/claude", "--session-id", "native-fixture"],
        network: { mode: "filtered-proxy", hostNamespace: "net:[1]", profileFingerprint: "sha256:" + "a".repeat(64), preflightRef: "evidence/preflight.json" } });
      const requestFor = (body: unknown = snapshot()) => {
        const data = { ...payload(), command: body, commandDigest: hashBytes(canonicalJson(body)) };
        return { ...command("attempt", data), payload: data };
      };

      it("persists an independent command snapshot before returning the one-shot grant", () => {
        const body = snapshot(), expected = structuredClone(body), request = requestFor(body);
        expect(governance.admitNativeAttempt(request, owner, binding)).toMatchObject({ effectMayStart: true });
        body.args.push("changed-after-call");
        expect(governance.getNativeLaunchIntent("run", "attempt")?.command).toEqual(expected);
        const fetched = governance.getNativeLaunchIntent("run", "attempt")!;
        (fetched.command!.args as string[]).push("changed-after-read");
        expect(governance.getNativeLaunchIntent("run", "attempt")?.command).toEqual(expected);
        expect(governance.getAttempt("attempt")).toBeNull();
      });

      it.each(["digest", "array", "utf8-bound"])("rejects a %s snapshot before recording an intent or grant", field => {
        const request = requestFor(field === "array" ? [] : field === "utf8-bound" ? { args: ["é".repeat(40_000)] } : snapshot());
        if (field === "digest") request.payload.commandDigest = "sha256:" + "e".repeat(64);
        const before = counts(), run = governance.getRun("run");
        expect(() => governance.admitNativeAttempt(request, owner, binding)).toThrow();
        expect(counts()).toEqual(before); expect(governance.getRun("run")).toEqual(run);
        expect(governance.getNativeLaunchIntent("run", "attempt")).toBeNull();
      });

      it("recovers the exact command and denies a second grant from a reopened database", async () => {
        const request = requestFor(), expected = structuredClone(request.payload.command);
        governance.admitNativeAttempt(request, owner, binding);
        const directory = mkdtempSync(join(tmpdir(), "native-command-snapshot-")), file = join(directory, "control.sqlite");
        let reopened: ReturnType<typeof createDb> | undefined;
        try {
          await db.backup(file); reopened = createDb(file);
          const events = new EventBus(reopened), recoveredQueue = new QueueRepository(reopened, events);
          const recovered = new PlanGovernance(reopened, events, recoveredQueue, () => new Date(now), options.readPolicyCapability);
          expect(recovered.getNativeLaunchIntent("run", "attempt")?.command).toEqual(expected);
          expect(recovered.admitNativeAttempt(request, owner, binding)).toMatchObject({ replayed: true, effectMayStart: false });
          expect(() => recovered.admitNativeAttempt({ ...request, payload: { ...request.payload, command: { file: "different" } } }, owner, binding)).toThrow(/idempotency/);
        } finally { reopened?.close(); rmSync(directory, { recursive: true, force: true }); }
      });

      it("rolls back admission when its command snapshot fails to persist", () => {
        db.exec(`CREATE TRIGGER fail_command_snapshot BEFORE INSERT ON events
          WHEN json_extract(NEW.payload, '$.action') = 'attempt.launch-intent'
            AND json_type(NEW.payload, '$.payload.command') IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'fixture command snapshot write failure'); END`);
        const before = counts(), run = governance.getRun("run");
        expect(() => governance.admitNativeAttempt(requestFor(), owner, binding)).toThrow(/snapshot write failure/);
        expect(counts()).toEqual(before); expect(governance.getRun("run")).toEqual(run);
        expect(governance.getNativeLaunchIntent("run", "attempt")).toBeNull();
      });

      it("retains its exact command after confirmed no-start without inventing a native identity", () => {
        const request = requestFor(), expected = structuredClone(request.payload.command);
        governance.admitNativeAttempt(request, owner, binding);
        expect(governance.reconcileNativeAttempt(command("attempt", { commandDigest: request.payload.commandDigest,
          outcome: "not_started", identity: null, expectedAttemptVersion: null, evidenceRef: "evidence/confirmed-no-start.json" }),
        owner, binding)).toMatchObject({ status: "observed", effectMayStart: false });
        expect(governance.getNativeLaunchIntent("run", "attempt")).toMatchObject({ state: "not_started", command: expected });
        expect(governance.getAttempt("attempt")).toBeNull();
        expect(governance.admitNativeAttempt(request, owner, binding)).toMatchObject({ replayed: true, effectMayStart: false });
      });
    });

    it("denies a worker actor without recording any command or intent", () => {
      const before = counts();
      expect(() => governance.admitNativeAttempt(command("attempt", payload()), { kind: "worker", sessionId: "builder@rig" }, binding)).toThrow(/owner/);
      expect(counts()).toEqual(before); expect(governance.getNativeLaunchIntent("run", "attempt")).toBeNull();
    });

    it.each(["session", "task", "version", "provider", "digest"])("rejects an invalid %s binding before admission", field => {
      const value = payload();
      if (field === "session") value.sessionId = "other@rig";
      if (field === "task") value.qitemId = "missing";
      if (field === "version") value.expectedTaskVersion += 1;
      if (field === "provider") value.provider = "other";
      if (field === "digest") value.commandDigest = "not-a-digest";
      const result = () => governance.admitNativeAttempt(command("attempt", value), owner, binding);
      if (field === "session") expect(result()).toMatchObject({ status: "denied", effectMayStart: false });
      else expect(result).toThrow();
      expect(governance.getNativeLaunchIntent("run", "attempt")).toBeNull();
    });

    it.each(["cancel", "drift"])("keeps %s authoritative before granting any native effect", field => {
      if (field === "cancel") governance.cancelRun(command("cancel", { reason: "Owner canceled" }), owner);
      const current = field === "drift" ? { ...binding, planDigest: "sha256:" + "e".repeat(64) } : binding;
      expect(governance.admitNativeAttempt(command("attempt", payload()), owner, current)).toMatchObject({ status: "denied", effectMayStart: false });
      expect(governance.getNativeLaunchIntent("run", "attempt")).toBeNull();
    });


    const nativeIdentity = (n = 1) => ({ nativeSessionId: "observed-" + n, tmuxServer: "/control/tmux",
      paneId: "%" + n, processId: 1200 + n, processStart: "observed-start-" + n, generation: 1, policyFingerprint: binding.policyFingerprint });
    const usage = { activeMs: 0, inputTokens: { value: null, reason: "Not observed" },
      outputTokens: { value: null, reason: "Not observed" }, costUsd: { value: null, reason: "Not observed" } };

    it("counts an unresolved intent in the same live-session limit as native attempts", () => {
      for (let i = 1; i <= 2; i++) expect(governance.recordAttempt(command("live-" + i, {
        role: "implementer", provider: "claude", qitemId: null, state: "running", identity: nativeIdentity(i), unknownReason: null, usage,
      }), binding).status).toBe("observed");
      expect(admit().effectMayStart).toBe(true);
      expect(admit("fourth")).toMatchObject({ status: "denied", effectMayStart: false, reason: "Live session limit reached" });
      expect(governance.getNativeLaunchIntent("run", "fourth")).toBeNull();
    });

    it.each([true, false])("reuses Lead wake admission with self-wake=%s", selfWake => {
      const leadBinding: PlanBinding = { ...binding, roles: ["lead"] };
      governance.createRun({ id: "lead-run", rigId: "rig", binding: leadBinding });
      const leadCommand = (id: string, value: unknown) => ({ ...command(id, value), runId: "lead-run",
        expectedEntityVersion: governance.getRun("lead-run").entityVersion });
      governance.requestApproval(leadCommand("lead-implementation", { kind: "orchestrator", action: "implementation",
        payload: { bindingDigest: hashBinding(leadBinding) }, targetDigest: hashBinding(leadBinding), expiresAt: "2026-10-20T00:00:00.000Z" }), owner);
      governance.decideApproval(leadCommand("lead-implementation", { approvalVersion: 1, decision: "approved" }), owner, leadBinding);
      const created = governance.createTask(leadCommand("lead-task", { assignment: { taskId: "lead-task", role: "lead", paths: ["src"], dependencies: [] }, outputs: [], permissions: [],
        sourceSession: selfWake ? "lead@rig" : "owner@rig", destinationSession: "lead@rig", body: "Evaluate the assignment." }), leadBinding);
      const leadTask = created.value as TeamTaskAuthority;
      if (!selfWake) for (let i = 1; i <= 11; i++) expect(governance.recordAttempt(leadCommand("lead-prior-" + i, {
        role: "lead", provider: "claude", qitemId: null, state: "stopped", identity: nativeIdentity(i), unknownReason: null, usage,
      }), leadBinding).status).toBe("observed");
      const request = leadCommand("lead-attempt", { ...payload(), qitemId: leadTask.qitemId,
        expectedTaskVersion: leadTask.entityVersion, sessionId: "lead@rig" });
      const receipt = governance.admitNativeAttempt(request, owner, leadBinding);
      expect(receipt.effectMayStart).toBe(!selfWake);
      if (selfWake) expect(receipt.reason).toBe("Lead wake originates from itself");
      else {
        expect(governance.admitNativeAttempt(request, owner, leadBinding).effectMayStart).toBe(false);
        expect(governance.admitNativeAttempt(leadCommand("lead-thirteenth", request.payload), owner, leadBinding))
          .toMatchObject({ status: "denied", effectMayStart: false, reason: "lead-wake:hourly" });
        expect(governance.getRun("lead-run").stateReason).toBe("lead-wake:hourly");
      }
    });


    describe("observed native reconciliation", () => {
      const observe = (outcome: string, extra: Record<string, unknown> = {}, id = "attempt", current = binding) =>
        governance.reconcileNativeAttempt(command(id, { commandDigest: governance.getNativeLaunchIntent("run", id)?.commandDigest ?? commandDigest,
          outcome, identity: outcome === "not_started" ? null : nativeIdentity(), expectedAttemptVersion: governance.getAttempt(id)?.entityVersion ?? null,
          evidenceRef: "evidence/native-observation.json", ...extra }), owner, current);

      it.each(["running", "stopped"])("records the same admitted attempt as observed %s without a second grant", outcome => {
        admit(); now += 1000;
        expect(observe(outcome)).toMatchObject({ status: "observed", effectMayStart: false });
        expect(governance.getAttempt("attempt")).toMatchObject({ id: "attempt", state: outcome, identity: nativeIdentity(), unknownReason: null });
        expect(governance.getNativeLaunchIntent("run", "attempt")?.state).toBe(outcome);
        expect(governance.getRun("run").activeMs).toBe(1000);
        expect(governance.getRun("run").accountedAt === null).toBe(outcome === "stopped");
      });

      it("closes confirmed no-start without a fictional stopped attempt or replay permission", () => {
        const request = command("attempt", payload()); governance.admitNativeAttempt(request, owner, binding); now += 1000;
        expect(observe("not_started")).toMatchObject({ status: "observed", effectMayStart: false });
        expect(governance.getAttempt("attempt")).toBeNull();
        expect(governance.getNativeLaunchIntent("run", "attempt")?.state).toBe("not_started");
        expect(governance.getRun("run")).toMatchObject({ activeMs: 1000, accountedAt: null });
        expect(governance.admitNativeAttempt(request, owner, binding)).toMatchObject({ replayed: true, effectMayStart: false });
        expect(admit().effectMayStart).toBe(false);
        expect(observe("running").status).toBe("denied");
        expect(admit("new-attempt").effectMayStart).toBe(true);
      });

      it.each(["digest", "policy", "generation", "no-start-identity"])("leaves %s mismatches unresolved", field => {
        admit();
        const extra = field === "digest" ? { commandDigest: "sha256:" + "e".repeat(64) }
          : { identity: { ...nativeIdentity(), ...(field === "policy" ? { policyFingerprint: "sha256:" + "e".repeat(64) }
            : field === "generation" ? { generation: 2 } : {}) } };
        expect(observe(field === "no-start-identity" ? "not_started" : "running", extra)).toMatchObject({ status: "denied", effectMayStart: false });
        expect(governance.getAttempt("attempt")).toBeNull();
        expect(governance.getNativeLaunchIntent("run", "attempt")?.state).toBe("admitted");
        expect(governance.getRun("run").accountedAt).not.toBeNull();
      });

      it.each(["cancel", "drift"])("records cleanup but denies continuation after %s", field => {
        admit(); now += 1000;
        if (field === "cancel") governance.cancelRun(command("cancel", { reason: "Owner canceled after admission" }), owner);
        const current = field === "drift" ? { ...binding, planDigest: "sha256:" + "e".repeat(64) } : binding;
        expect(observe("running", {}, "attempt", current)).toMatchObject({ status: "denied", effectMayStart: false });
        expect(governance.getNativeLaunchIntent("run", "attempt")?.state).toBe("admitted");
        expect(observe("stopped", {}, "attempt", current)).toMatchObject({ status: "observed", effectMayStart: false });
        expect(governance.getAttempt("attempt")?.state).toBe("stopped");
        expect(governance.getRun("run").state).toBe(field === "cancel" ? "cancel_requested" : "invalidated");
        expect(governance.getRun("run").accountedAt).toBeNull();
      });

      it("rejects a worker observer and an unrelated legacy unknown attempt", () => {
        governance.recordAttempt(command("legacy", { role: "implementer", provider: "claude", qitemId: task.qitemId,
          state: "unknown", identity: null, unknownReason: "Prior observation was lost", usage }), binding);
        const request = command("legacy", { commandDigest, outcome: "running", identity: nativeIdentity(),
          expectedAttemptVersion: 1, evidenceRef: "evidence/native-observation.json" });
        const before = counts();
        expect(() => governance.reconcileNativeAttempt(request, { kind: "worker", sessionId: "builder@rig" }, binding)).toThrow(/owner/);
        expect(counts()).toEqual(before);
        expect(governance.reconcileNativeAttempt(request, owner, binding)).toMatchObject({ status: "denied", effectMayStart: false });
        expect(governance.getAttempt("legacy")).toMatchObject({ state: "unknown", identity: null });
      });

      it.each([true, false])("admits exact next-generation resume with same attempt ID=%s and preserves usage", sameId => {
        admit(); observe("stopped");
        governance.recordUsage(command("attempt", { expectedAttemptVersion: 1, state: "stopped", unknownReason: null,
          usage: { ...usage, activeMs: 500, inputTokens: { value: 12, reason: null } } }));
        const previous = governance.getAttempt("attempt")!, id = sameId ? "attempt" : "resumed";
        const request = command(id, { ...payload(), commandDigest: "sha256:" + "e".repeat(64),
          previousAttemptId: "attempt", expectedPreviousVersion: previous.entityVersion });
        expect(governance.admitNativeAttempt(request, owner, binding).effectMayStart).toBe(true);
        expect(governance.admitNativeAttempt(command("competing", request.payload), owner, binding).effectMayStart).toBe(false);
        expect(observe("running", { identity: { ...nativeIdentity(), generation: 2 } }, id).status).toBe("denied");
        const resumed = { ...nativeIdentity(2), nativeSessionId: previous.identity!.nativeSessionId, generation: 2 };
        expect(observe("running", { identity: resumed }, id)).toMatchObject({ status: "observed", effectMayStart: false });
        expect(governance.getAttempt(id)?.identity).toEqual(resumed);
        expect(governance.getAttempt(id)?.usage.inputTokens.value).toBe(sameId ? 12 : null);
        if (!sameId) expect(governance.getAttempt("attempt")).toEqual(previous);
        expect(observe("stopped", { identity: resumed }, id).status).toBe("observed");
        expect(observe("running", { identity: resumed }, id).status).toBe("denied");
      });


      it.each(["admitted", "not_started"])("reserves a %s identity across runs before another grant", state => {
        governance.createRun({ id: "other-run", rigId: "rig", binding });
        const otherCommand = (id: string, value: unknown) => ({ ...command(id, value), runId: "other-run",
          expectedEntityVersion: governance.getRun("other-run").entityVersion });
        governance.requestApproval(otherCommand("other-implementation", { kind: "orchestrator", action: "implementation",
          payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-10-20T00:00:00.000Z" }), owner);
        governance.decideApproval(otherCommand("other-implementation", { approvalVersion: 1, decision: "approved" }), owner, binding);
        const otherTask = governance.createTask(otherCommand("other-task", {
          assignment: { taskId: "other-task", role: "implementer", paths: ["src"], dependencies: [] },
          outputs: [], permissions: [],
          sourceSession: "lead@rig", destinationSession: "other@rig", body: "Other run assignment",
        }), binding).value as TeamTaskAuthority;
        expect(admit().effectMayStart).toBe(true);
        if (state === "not_started") expect(observe(state).status).toBe("observed");
        const original = governance.getNativeLaunchIntent("run", "attempt");
        const otherPayload = { ...payload(), qitemId: otherTask.qitemId,
          expectedTaskVersion: otherTask.entityVersion, sessionId: "other@rig" };
        expect(governance.admitNativeAttempt(otherCommand("attempt", otherPayload), owner, binding))
          .toMatchObject({ status: "denied", effectMayStart: false, reason: "Native launch identity is already reserved" });
        expect(governance.recordAttempt(otherCommand("attempt", { role: "implementer", provider: "claude",
          qitemId: otherTask.qitemId, state: "running", identity: nativeIdentity(2), unknownReason: null, usage }), binding).status).toBe("denied");
        expect(governance.getAttempt("attempt")).toBeNull();
        expect(governance.getNativeLaunchIntent("run", "attempt")).toEqual(original);
        expect(governance.getNativeLaunchIntent("other-run", "attempt")).toBeNull();
        expect(governance.getTask(otherTask.qitemId)).toEqual(otherTask);
        expect(governance.admitNativeAttempt(otherCommand("other-attempt", otherPayload), owner, binding).effectMayStart).toBe(true);
      });

      it.each([
        { resume: true, canceled: false }, { resume: false, canceled: false },
        { resume: true, canceled: true }, { resume: false, canceled: true },
      ])("waits for an unresolved task intent with resume=$resume and canceled=$canceled", ({ resume, canceled }) => {
        expect(admit().effectMayStart).toBe(true);
        expect(observe("stopped").status).toBe("observed");
        const stopped = governance.getAttempt("attempt")!, id = resume ? "attempt" : "fresh-attempt";
        expect(governance.admitNativeAttempt(command(id, { ...payload(), commandDigest: "sha256:" + "e".repeat(64),
          previousAttemptId: resume ? "attempt" : null, expectedPreviousVersion: resume ? stopped.entityVersion : null }),
        owner, binding).effectMayStart).toBe(true);
        if (canceled) governance.cancelRun(command("cancel", { reason: "Owner canceled the pending launch" }), owner);
        const beforeTask = governance.getTask(task.qitemId), beforeQueue = queue.getById(task.qitemId);
        const outcome = (state: string) => governance.recordTaskOutcome(command(task.qitemId, {
          expectedTaskVersion: task.entityVersion, state, actorSession: "builder@rig", attemptId: "attempt",
          ...(state === "done" ? { closureReason: "no-follow-on" } : {}),
          expectedAttemptVersion: stopped.entityVersion, evidence: { proof: "observed prior exit" },
        }), owner);
        for (const state of ["done", "failed", "denied", "canceled"]) {
          expect(outcome(state)).toMatchObject({ status: "denied", effectMayStart: false });
          expect(governance.getTask(task.qitemId)).toEqual(beforeTask);
          expect(queue.getById(task.qitemId)).toEqual(beforeQueue);
          expect(governance.getNativeLaunchIntent("run", id)?.state).toBe("admitted");
        }
        expect(observe("not_started", {}, id).status).toBe("observed");
        expect(outcome(canceled ? "canceled" : "failed").status).toBe("observed");
        expect(queue.getById(task.qitemId)?.state).toBe(canceled ? "canceled" : "failed");
      });

      it("does not block a stopped task outcome on another task's unresolved intent", () => {
        admit(); observe("stopped");
        const next = governance.createTask(command("next-task", {
          assignment: { taskId: "next-task", role: "implementer", paths: ["src"], dependencies: [] },
          outputs: [], permissions: [],
          sourceSession: "lead@rig", destinationSession: "second@rig", body: "Second assignment",
        }), binding).value as TeamTaskAuthority;
        expect(governance.admitNativeAttempt(command("next-attempt", { ...payload(), qitemId: next.qitemId,
          expectedTaskVersion: next.entityVersion, sessionId: "second@rig" }), owner, binding).effectMayStart).toBe(true);
        expect(governance.recordTaskOutcome(command(task.qitemId, { expectedTaskVersion: task.entityVersion,
          state: "failed", actorSession: "builder@rig", attemptId: "attempt", expectedAttemptVersion: 1,
          evidence: { proof: "observed exit" } }), owner).status).toBe("observed");
        expect(governance.getNativeLaunchIntent("run", "next-attempt")?.state).toBe("admitted");
      });

      it("atomically replaces a reserved slot with the observed native row", () => {
        governance.recordAttempt(command("other-live", { role: "reviewer", provider: "claude", qitemId: null,
          state: "running", identity: nativeIdentity(3), unknownReason: null, usage }), binding);
        admit(); observe("running");
        const next = governance.createTask(command("next-task", { assignment: { taskId: "next-task", role: "implementer", paths: ["src"], dependencies: [] }, outputs: [], permissions: [],
          sourceSession: "lead@rig", destinationSession: "second@rig", body: "Second assignment" }), binding).value as TeamTaskAuthority;
        expect(governance.admitNativeAttempt(command("third-live", { ...payload(), qitemId: next.qitemId,
          expectedTaskVersion: next.entityVersion, sessionId: "second@rig" }), owner, binding).effectMayStart).toBe(true);
      });

      it("keeps terminal task outcome separate from a confirmed no-start command", () => {
        admit(); observe("not_started");
        expect(governance.recordTaskOutcome(command(task.qitemId, { expectedTaskVersion: task.entityVersion, state: "failed",
          actorSession: "builder@rig", attemptId: "attempt", expectedAttemptVersion: 1, evidence: { proof: "no-start" } }), owner).status).toBe("denied");
        expect(queue.getById(task.qitemId)?.state).toBe("pending");
      });

      it("accepts canceled no-start cleanup and rejects missing observation evidence", () => {
        admit();
        expect(() => observe("running", { evidenceRef: "" })).toThrow();
        expect(governance.getNativeLaunchIntent("run", "attempt")?.state).toBe("admitted");
        governance.cancelRun(command("cancel", { reason: "Owner canceled" }), owner);
        expect(observe("not_started").status).toBe("observed");
        expect(governance.getAttempt("attempt")).toBeNull();
        expect(governance.getRun("run")).toMatchObject({ state: "cancel_requested", accountedAt: null });
      });

      it("reconciles a known lost observation only against its admitted command and identity", () => {
        admit(); observe("running");
        governance.recordUsage(command("attempt", { expectedAttemptVersion: 1, state: "unknown", unknownReason: "Observation interrupted", usage }));
        expect(observe("running").status).toBe("observed");
        expect(governance.getAttempt("attempt")).toMatchObject({ state: "running", identity: nativeIdentity() });
      });

      it("rejects stale observer versions and changed identity without losing the running attempt", () => {
        admit(); observe("running");
        expect(() => observe("stopped", { expectedAttemptVersion: 2 })).toThrow(/version/);
        expect(observe("stopped", { identity: nativeIdentity(2) }).status).toBe("denied");
        expect(governance.getAttempt("attempt")?.state).toBe("running");
      });
    });

    it("retains unresolved admission and its clock across owner reconstruction", () => {
      admit(); now += 10_000;
      const events = new EventBus(db); queue = new QueueRepository(db, events);
      governance = new PlanGovernance(db, events, queue, () => new Date(now), options.readPolicyCapability);
      expect(governance.getNativeLaunchIntent("run", "attempt")?.state).toBe("admitted");
      expect(governance.transitionTask(command(task.qitemId, { expectedTaskVersion: task.entityVersion,
        actorSession: "builder@rig", state: "in-progress" }), binding)).toMatchObject({ status: "denied" });
      expect(admit("second")).toMatchObject({ status: "denied", effectMayStart: false });
      expect(governance.getRun("run").activeMs).toBe(10_000);
      expect(governance.getRun("run").accountedAt).not.toBeNull();
    });
  });
});


describe("control-owned root inspection", () => {
  let db: ReturnType<typeof createDb>, queue: QueueRepository, governance: PlanGovernance, options: TeamControlOptions;
  let context: ContextManifest, policyBytes: Buffer, reply: Record<string, any>, duringInspection: () => void;
  let bridge: Pick<WorkerMailboxBridge, "binding" | "endpoint">, endpoint: ReturnType<WorkerMailboxBridge["endpoint"]>, assignedTree: string;
  const LOCK = "/etc/multi-agent/client-lock.json";
  const lock = JSON.stringify({ schema: "multi-agent-client-lock/v1", clients: {
    "claude-code": { version: "2.1.296", files: [{ path: "clients/lib/claude.exe", sha256: "sha256:" + "1".repeat(64) }] },
    codex: { version: "0.160.0", files: [{ path: "clients/lib/codex.js", sha256: "sha256:" + "2".repeat(64) },
      { path: "clients/lib/codex-native", sha256: "sha256:" + "3".repeat(64) }] } } });
  const resolveAssignedTree = () => assignedTree;
  const inspect = () => inspectManagedWorker(context, bridge, { db, queue, governance, options, resolveAssignedTree });
  const counts = () => ["team_attempts", "team_control_requests", "chat_messages"].map(table =>
    db.prepare("SELECT count(*) AS count FROM " + table).get());
  beforeEach(() => {
    inspectionIo.execFile.mockReset(); inspectionIo.readPolicy.mockReset(); inspectionIo.end.mockReset();
    processIo.stats.clear(); processIo.stats.set(LOCK, lock);
    const policy = JSON.parse(readFileSync(new URL("../../../config/isolation/worker-policy.json", import.meta.url), "utf8"));
    policyBytes = Buffer.from(JSON.stringify(policy));
    const current: PlanBinding = { ...binding, policyFingerprint: hashBytes(policyBytes) };
    assignedTree = policy.paths.assignment_root + "/ma-worker1/project";
    db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs(id, name) VALUES ('rig', 'fixture')").run();
    const events = new EventBus(db); queue = new QueueRepository(db, events);
    options = { credentials: { ownerToken: "owner-fixture", workers: [{ token: "worker-fixture", sessionId: "builder@rig", runId: "run" }] },
      resolveBinding: () => structuredClone(current),
      readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: current.policyFingerprint, verifiedProviders: ["claude", "codex"] }) };
    governance = new PlanGovernance(db, events, queue, () => new Date("2026-10-19T00:00:00Z"), options.readPolicyCapability);
    governance.createRun({ id: "run", rigId: "rig", binding: current });
    let serial = 0;
    const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
      expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: actionId + ++serial, payload });
    governance.requestApproval(command("approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(current) }, targetDigest: hashBinding(current), expiresAt: "2026-10-20T00:00:00.000Z" }),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command("approval", { approvalVersion: 1, decision: "approved" }), { kind: "owner", sessionId: "owner-control" }, current);
    const task = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] }, outputs: [], permissions: [],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Inspect the assigned worker." }), current).value as TeamTaskAuthority;
    context = { runId: "run", binding: current, assignment: task.assignment, role: "implementer", client: "claude-code",
      projection: { worker: "ma-worker1", attemptId: "attempt", controlUid: process.getuid!(), workerGid: 61001, policy },
      root: policy.paths.context_root + "/ma-worker1/run/attempt", mutableStateRoot: policy.paths.worker_root + "/ma-worker1/home",
      frameworkRoot: policy.paths.framework_dir, frameworkRevision: "fixture", workerUid: 61001, workerGroups: [],
      outputs: [], permissions: [], files: [], discoveryRoots: [], workerDiscoveryRoots: [], generatedHash: "sha256:" + "f".repeat(64), protocolVersion: null };
    endpoint = { path: policy.paths.mailbox_root + "/ma-worker1/run/attempt/mailbox.sock", dev: 1, ino: 23,
      uid: process.getuid!(), gid: process.getgid!(), generation: "generation-1" };
    bridge = { binding: { socketPath: endpoint.path, workerId: "builder", sessionId: "builder@rig", runId: "run",
      attemptId: "attempt", rigId: "rig", taskId: "task", recipients: [] }, endpoint: () => Object.freeze({ ...endpoint }) };
    const fact = (path: string, sha256 = "sha256:" + "a".repeat(64)) => ({ path, realpath: path, uid: 0, gid: 0,
      mode: 0o755, size: 12, sha256 });
    reply = { schema: "multi-agent-launch-preflight/v1", worker: { name: "ma-worker1", uid: 61001, gid: 61001 },
      control: { uid: process.getuid!(), gid: process.getgid!(), mountNamespace: readlinkSync("/proc/self/ns/mnt"), userNamespace: readlinkSync("/proc/self/ns/user") },
      roots: { home: context.mutableStateRoot, scratch: policy.paths.worker_root + "/ma-worker1/scratch",
        tree: assignedTree, context: context.root, framework: context.frameworkRoot },
      installed: { policy: { ...fact(policy.paths.installed_policy, current.policyFingerprint), size: policyBytes.length },
        launcher: fact(policy.paths.installed_launcher), executable: fact(policy.paths.toolchain_dir + "/clients/bin/claude"),
        egress: fact(policy.paths.installed_egress_config) },
      network: { hostNamespace: readlinkSync("/proc/self/ns/net"), profileFingerprint: "sha256:" + "a".repeat(64) },
      clientLock: { client: "claude-code", version: "2.1.296", digest: hashBytes(lock),
        files: [{ path: policy.paths.toolchain_dir + "/clients/lib/claude.exe", sha256: "sha256:" + "1".repeat(64) }] },
      provider: { client: "claude-code", status: "signed_in" } };
    inspectionIo.readPolicy.mockImplementation(() => Buffer.from(policyBytes)); duringInspection = () => {};
    inspectionIo.execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => { duringInspection(); callback(null, JSON.stringify(reply), ""); });
      return { stdin: { end: inspectionIo.end } };
    });
  });
  afterEach(() => { db.close(); processIo.stats.clear(); });

  it("binds observed facts through the fixed bounded inspect command without recording an admission", async () => {
    const before = counts(), result = await inspect();
    expect(result).toMatchObject({ scope: { sessionId: "builder@rig" }, facts: reply, mailbox: endpoint, clientLock: {
      digest: hashBytes(lock), version: "2.1.296", files: [{ path: "clients/lib/claude.exe", sha256: "sha256:" + "1".repeat(64) }],
      observedFiles: reply.clientLock.files } });
    expect(Object.isFrozen(result.facts.installed)).toBe(true); expect(counts()).toEqual(before);
    expect(result.facts.roots.tree).not.toBe(context.binding.repository.root);
    expect(inspectionIo.execFile).toHaveBeenCalledExactlyOnceWith("/usr/bin/sudo", ["-n", "--",
      "/usr/local/libexec/multi-agent/worker-launch", "--inspect", "--worker", "ma-worker1", "--role", "implementer",
      "--tree", assignedTree, "--run", "run", "--attempt", "attempt", "--mailbox", "1:23", "--client-lock", hashBytes(lock),
      "--", reply.installed.executable.path], expect.objectContaining({
      env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8", timeout: 10_000, maxBuffer: 65_536 }), expect.any(Function));
    expect(inspectionIo.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/owner-fixture|worker-fixture/);
  });

  it("inspects two worker trees without rewriting their common approved repository binding", async () => {
    const first = await inspect(), digest = governance.getRun("run").bindingDigest;
    options.credentials.workers!.push({ token: "worker-two-fixture", sessionId: "reviewer@rig", runId: "run" });
    const secondTask = governance.createTask({ protocolVersion: "1.0", runId: "run", actionId: "review-task", idempotencyKey: "review-task",
      expectedEntityVersion: governance.getRun("run").entityVersion, payload: {
        assignment: { taskId: "review-task", role: "reviewer", paths: ["src"], dependencies: [] },
        outputs: [], permissions: [],
        sourceSession: "lead@rig", destinationSession: "reviewer@rig", body: "Inspect the review tree." } }, context.binding).value as TeamTaskAuthority;
    assignedTree = assignedTree.replace("ma-worker1", "ma-worker2");
    context = { ...context, assignment: secondTask.assignment, role: "reviewer", client: "codex", workerUid: 61002,
      root: context.root.replace("ma-worker1", "ma-worker2").replace("/attempt", "/attempt-2"),
      projection: { ...context.projection, worker: "ma-worker2", workerGid: 61002, attemptId: "attempt-2" } };
    endpoint = { ...endpoint, path: endpoint.path.replace("ma-worker1", "ma-worker2").replace("/attempt/", "/attempt-2/"), ino: 24, generation: "generation-2" };
    bridge = { endpoint: bridge.endpoint, binding: { ...bridge.binding, socketPath: endpoint.path, attemptId: "attempt-2", taskId: "review-task", workerId: "reviewer", sessionId: "reviewer@rig" } };
    reply.installed.executable.path = reply.installed.executable.realpath = reply.installed.executable.path.replace("/claude", "/codex");
    reply = { ...reply, worker: { name: "ma-worker2", uid: 61002, gid: 61002 }, provider: { client: "codex", status: "signed_out" },
      clientLock: { client: "codex", version: "0.160.0", digest: hashBytes(lock), files: [{ path: "a", sha256: "b" }, { path: "c", sha256: "d" }] },
      roots: { ...reply.roots, tree: assignedTree, context: context.root,
        home: reply.roots.home.replace("ma-worker1", "ma-worker2"), scratch: reply.roots.scratch.replace("ma-worker1", "ma-worker2") } };
    const second = await inspect();
    expect(first.scope.currentBinding).toEqual(second.scope.currentBinding);
    expect(governance.getRun("run").bindingDigest).toBe(digest);
    expect([first.facts.roots.tree, second.facts.roots.tree]).toEqual([
      "/var/lib/multi-agent/assignments/ma-worker1/project", "/var/lib/multi-agent/assignments/ma-worker2/project"]);
  });

  it("rejects a tree registered under a different worker before inspection", async () => {
    assignedTree = assignedTree.replace("ma-worker1", "ma-worker2");
    await expect(inspect()).rejects.toThrow("managed_inspection_unverified"); expect(inspectionIo.execFile).not.toHaveBeenCalled();
  });

  it("rejects policy-byte drift before privileged I/O", async () => {
    policyBytes = Buffer.concat([policyBytes, Buffer.from("\n")]);
    const before = counts(); await expect(inspect()).rejects.toThrow("managed_inspection_unverified");
    expect(inspectionIo.execFile).not.toHaveBeenCalled(); expect(counts()).toEqual(before);
  });

  it.each(["schema", "worker", "control", "namespace", "tree", "executable", "file-owner", "file-mode", "policy-hash", "egress-hash",
    "lock-digest", "lock-version", "lock-client", "lock-files", "provider-client", "provider-status", "provider-extra", "no-provider"])(
    "rejects forged %s inspection evidence without admission", async field => {
      if (field === "schema") reply.schema = "untrusted";
      else if (field === "worker") reply.worker.uid++;
      else if (field === "control") reply.control.uid++;
      else if (field === "namespace") reply.control.mountNamespace = "mnt:[1]";
      else if (field === "tree") reply.roots.tree += "/other";
      else if (field === "executable") reply.installed.executable.path = "/usr/bin/true";
      else if (field === "file-owner") reply.installed.launcher.uid = 61001;
      else if (field === "file-mode") reply.installed.launcher.mode = 0o777;
      else if (field === "policy-hash") reply.installed.policy.sha256 = "sha256:" + "e".repeat(64);
      else if (field === "egress-hash") reply.network.profileFingerprint = "sha256:" + "e".repeat(64);
      else if (field === "lock-digest") reply.clientLock.digest = "sha256:" + "e".repeat(64);
      else if (field === "lock-version") reply.clientLock.version = "9.9.9";
      else if (field === "lock-client") reply.clientLock.client = "codex";
      else if (field === "lock-files") reply.clientLock.files.push({ path: "extra", sha256: "sha256:" + "e".repeat(64) });
      else if (field === "provider-client") reply.provider.client = "codex";
      else if (field === "provider-status") reply.provider.status = "ready";
      else if (field === "provider-extra") reply.provider.credential = "worker-fixture";
      else delete reply.provider;
      const before = counts(); await expect(inspect()).rejects.toThrow("managed_inspection_unverified"); expect(counts()).toEqual(before);
      expect(inspectionIo.execFile).toHaveBeenCalledOnce();
    });

  it.each(["policy", "lock", "mailbox", "assignment", "revocation", "cancellation"])("rechecks %s after asynchronous inspection", async field => {
    duringInspection = () => {
      if (field === "policy") policyBytes = Buffer.concat([policyBytes, Buffer.from("\n")]);
      else if (field === "lock") processIo.stats.set(LOCK, lock + "\n");
      else if (field === "mailbox") endpoint = { ...endpoint, generation: "replacement" };
      else if (field === "assignment") assignedTree += "/replacement";
      else if (field === "revocation") options.credentials.workers = [];
      else governance.cancelRun({ protocolVersion: "1.0", runId: "run", actionId: "cancel", idempotencyKey: "cancel",
        expectedEntityVersion: governance.getRun("run").entityVersion, payload: { reason: "Inspection race" } }, { kind: "owner", sessionId: "owner-control" });
    };
    await expect(inspect()).rejects.toThrow("managed_inspection_unverified");
    expect(db.prepare("SELECT count(*) AS count FROM team_attempts").get()).toEqual({ count: 0 });
  });

  it("rejects a foreign endpoint before inspection", async () => {
    bridge.binding.runId = "foreign";
    await expect(inspect()).rejects.toThrow("managed_inspection_unverified"); expect(inspectionIo.execFile).not.toHaveBeenCalled();
  });

  it("does not expose helper error output or credentials", async () => {
    inspectionIo.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(new Error("Bearer worker-fixture"), "", "owner-fixture"); return { stdin: { end: inspectionIo.end } };
    });
    await expect(inspect()).rejects.toThrow(/^managed_inspection_unverified$/);
  });

  it("maps only a launcher lock refusal to the non-retryable unsupported-version code (A-R3)", async () => {
    const refuse = (stderr: string) => inspectionIo.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(Object.assign(new Error("exit 126"), { code: 126 }), "", stderr); return { stdin: { end: inspectionIo.end } };
    });
    refuse(JSON.stringify({ worker_launch_error: "unsupported-version", message: "claude-code executable hash differs" }) + "\n");
    await expect(inspect()).rejects.toThrow(new RegExp("^" + UNSUPPORTED_CLIENT_VERSION + "$"));
    for (const stderr of [JSON.stringify({ worker_launch_error: "client-lock-changed", message: "changed" }), "unsupported-version",
      JSON.stringify({ worker_launch_error: ["unsupported-version"] })]) {
      refuse(stderr);
      await expect(inspect()).rejects.toThrow(/^managed_inspection_unverified$/);
    }
    expect(db.prepare("SELECT count(*) AS count FROM team_attempts").get()).toEqual({ count: 0 });
  });
});

// Supplementary group of the test process: the projection must be group-owned by a worker group the control is not.
const workerGroup = process.getgroups?.().find(gid => gid !== process.getgid!());

describe.skipIf(!workerGroup)("control-owned managed launch lifecycle", () => {
  const PANE = 500, SUPERVISOR = 501, RELAY = 502, LOCK = "/etc/multi-agent/client-lock.json", EGRESS = "/etc/multi-agent/egress.json";
  const SCREEN = "Claude Code vfixture\n❯", uid = process.getuid!(), gid = process.getgid!(), workerUid = uid + 100_000;
  let root: string, toolchain: string, policy: any, policyBytes: Buffer, current: PlanBinding, now: number, native: number;
  let db: ReturnType<typeof createDb>, queue: QueueRepository, governance: PlanGovernance, options: TeamControlOptions;
  let rigRepo: RigRepository, sessions: SessionRegistry, context: ContextManifest, task: TeamTaskAuthority, tree: string;
  let inspectReply: Record<string, any>, inspectError: { stderr: string } | null, observeError: boolean, quiesceError: boolean;
  let respawn: ReturnType<typeof vi.fn>, quiesced: string[], started: boolean, snapshotChange: (snapshot: any) => void, screen: string | null;
  let orphan: boolean;
  let control: ReturnType<typeof createManagedLaunchControl>, launcher: RestrictedWorkerLauncher;
  const lock = JSON.stringify({ schema: "multi-agent-client-lock/v1", clients: {
    "claude-code": { version: "2.1.296", files: [{ path: "clients/lib/claude.exe", sha256: "sha256:" + "1".repeat(64) }] },
    codex: { version: "0.160.0", files: [{ path: "clients/lib/codex.js", sha256: "sha256:" + "2".repeat(64) }] } } });
  const setStart = (pid: number, value: string) => processIo.stats.set("/proc/" + pid + "/stat",
    pid + " (fixture) S 1 " + Array(17).fill("0").join(" ") + " " + value);
  const intent = (attemptId = "attempt") => governance.getNativeLaunchIntent("run", attemptId);
  const supervisorArgv = (attemptId = "attempt") => [process.execPath, "/usr/local/libexec/multi-agent/worker-launch.mjs", "--supervise",
    ...(intent(attemptId)!.command!.args as string[]).slice(4)];
  const runningRef = (attemptId = "attempt") => (db.prepare(`SELECT json_extract(payload, '$.payload.evidenceRef') AS ref FROM events
    WHERE json_extract(payload, '$.action') = 'attempt.launch-intent' AND json_extract(payload, '$.attemptId') = ? ORDER BY seq DESC LIMIT 1`)
    .get(attemptId) as { ref: string }).ref;

  const project = (attemptId: string) => {
    const base = join(policy.paths.context_root, "ma-worker1", "run", attemptId);
    const entries = [["framework", "pinned instructions"], ["plan", "approved plan\n"], ["role", JSON.stringify(roleConfiguration)], ...roleInstructionEntries("implementer")] as const;
    const files = entries.map(([kind, content]) => ({ path: join(base, kind), hash: hashBytes(content), kind, readOnly: true as const,
        ...(kind === "framework" ? { source: join(policy.paths.framework_dir, "skill.md") } : {}) }));
    return projectContext({ nativePolicy: nativePolicyFor, runId: "run", assignment: task.assignment, outputs: ["src/result.ts"],
      permissions: ["write-assigned-tree"], role: "implementer", client: "claude-code", binding: current, root: base,
      projection: { worker: "ma-worker1", attemptId, controlUid: uid, workerGid: workerGroup!, policy: { policy_revision: 5,
        worker_identities: policy.worker_identities, paths: { context_root: policy.paths.context_root, framework_dir: policy.paths.framework_dir },
        sandbox: { context: "/context", framework: "/framework" } } },
      mutableStateRoot: join(policy.paths.worker_root, "ma-worker1", "home"), frameworkRoot: policy.paths.framework_dir,
      frameworkRevision: FRAMEWORK_PIN.revision, workerUid, workerGroups: [], discoveryRoots: [base], files },
    new Map(files.map((file, index) => [file.path, entries[index]![1]])));
  };
  let nativePolicyFor: Awaited<ReturnType<typeof buildManagedNativePolicy>>;
  const endpoint = (attemptId: string) => ({ path: join(policy.paths.mailbox_root, "ma-worker1", "run", attemptId, "mailbox.sock"),
    dev: 1, ino: 23, uid, gid, generation: "generation-1" });
  const bridgeFor = (input: Readonly<WorkerLaunchInput>) => ({ endpoint: () => Object.freeze(endpoint(input.attempt.attemptId)),
    binding: { socketPath: endpoint(input.attempt.attemptId).path, workerId: "builder", sessionId: "builder@rig", runId: "run",
      attemptId: input.attempt.attemptId, rigId: "rig", taskId: "task", recipients: [] } });
  const mountInfo = (attempt: ContextManifest) => {
    const host = (source: string, target: string, access = "ro") => `8:1 ${source} ${target} ${access},nosuid - ext4 /dev/sda rw`;
    const managed = attempt.files.find(file => file.workerPath === "/context/native/claude/managed-settings.json")!.path;
    // [parent row, mount]; the 9p drivers mount sits below the masked tmpfs, as on a WSL host.
    const rows: [number, string][] = [[-1, "0:90 / / rw - tmpfs tmpfs rw"], [0, host("/usr", "/usr")], [1, "0:36 / /usr/lib/wsl/drivers ro - 9p drivers ro"],
      [1, "0:91 / /usr/lib/wsl ro - tmpfs tmpfs rw"], [0, host("/etc/hosts", "/etc/hosts")], [0, host(toolchain, toolchain)],
      [0, host(policy.paths.framework_dir, "/framework")], [0, host(attempt.root, "/context")], [0, "0:92 / /proc rw - proc proc rw"],
      [0, "0:93 / /dev rw - tmpfs tmpfs rw"], [9, "0:6 /null /dev/null rw - devtmpfs none rw"], [9, "0:94 / /dev/pts rw - devpts devpts rw"],
      [0, "0:95 / /tmp rw - tmpfs tmpfs rw"], [0, "0:96 / /run rw - tmpfs tmpfs rw"], [13, host(policy.paths.egress_socket_dir, policy.paths.egress_socket_dir)],
      [13, "0:97 / /run/multi-agent ro - tmpfs tmpfs rw"], [15, host(endpoint(attempt.projection.attemptId).path, "/run/multi-agent/mailbox.sock")],
      [0, "0:98 / /etc/claude-code ro - tmpfs tmpfs rw"], [17, host(managed, "/etc/claude-code/managed-settings.json")],
      [0, host(join(policy.paths.worker_root, "ma-worker1/home"), "/home/worker", "rw")], [19, "0:99 / /home/worker/.multi-agent/mailbox rw - tmpfs tmpfs rw"],
      [20, "0:90 /bindfile//deleted /home/worker/.multi-agent/mailbox/bootstrap.json ro - tmpfs tmpfs rw"],
      [0, host(join(policy.paths.worker_root, "ma-worker1/scratch"), "/scratch", "rw")], [0, host(tree, "/work", "rw")]];
    return rows.map(([parent, row], index) => `${200 + index} ${200 + parent} ${row}`).join("\n") + "\n";
  };
  const snapshot = (attemptId: string, attempt: ContextManifest) => {
    const argv = intent(attemptId)!.command!.nativeArgv as string[];
    const managed = attempt.files.find(file => file.workerPath === "/context/native/claude/managed-settings.json")!;
    const value = { pane: { processId: PANE, processStart: String(30_000 + PANE) }, sandbox: { mountNamespace: "mnt:[7]", userNamespace: "user:[8]", networkNamespace: "net:[9]" },
      lineage: [{ processId: RELAY, processStart: String(30_000 + RELAY), executable: realpathSync(join(toolchain, "node/bin/node")) },
        { processId: native, processStart: String(30_000 + native), executable: realpathSync(join(toolchain, "clients/lib/claude.exe")) }],
      process: { processId: native, processStart: String(30_000 + native), processGroupId: native, namespacePids: [native, 3],
        uids: [workerUid, workerUid, workerUid, workerUid], groups: [], capabilities: "0000000000000000", noNewPrivileges: "1", argv,
        executable: realpathSync(join(toolchain, "clients/lib/claude.exe")), cwd: "/work",
        environment: { HOME: "/home/worker", CLAUDE_CONFIG_DIR: "/home/worker/.claude" },
        mountNamespace: "mnt:[7]", userNamespace: "user:[8]", networkNamespace: "net:[9]", pidNamespace: "pid:[2]" },
      mountInfo: mountInfo(attempt), stdio: [0, 1, 2].map(fd => ({ fd, kind: "tty" })),
      files: [...attempt.files.map(file => ({ path: file.workerPath, hash: file.hash })), { path: "/etc/claude-code/managed-settings.json", hash: managed.hash }],
      discoveryRoots: [...attempt.workerDiscoveryRoots], nativeSessions: [], mailbox: { uid, gid, dev: 1, ino: 23 },
      nativePolicy: { inventory: { selectedSource: "/etc/claude-code/managed-settings.json", managedDropIns: "absent", remotePolicy: "absent",
        platformPolicy: "not-applicable", nativeExceptions: "absent" } } };
    snapshotChange(value);
    return value;
  };
  const launch = (attempt: ContextManifest = context, extra: Partial<WorkerLaunchInput> = {}, attemptId = "attempt") =>
    launcher.launch({ client: "claude-code", attempt: { attemptId, deadline: now + 60_000, context: attempt }, ...extra });

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "managed-lifecycle-"))); chmodSync(root, 0o755);
    toolchain = join(root, "toolchain");
    for (const file of ["node/bin/node", "clients/lib/claude.exe"]) { mkdirSync(join(toolchain, file, ".."), { recursive: true }); writeFileSync(join(toolchain, file), ""); }
    policy = JSON.parse(readFileSync(new URL("../../../config/isolation/worker-policy.json", import.meta.url), "utf8"));
    Object.assign(policy.paths, { context_root: join(root, "context"), framework_dir: join(root, "framework"), toolchain_dir: toolchain,
      worker_root: join(root, "workers"), assignment_root: join(root, "assignments"), control_state_dir: join(root, "control"),
      mailbox_root: join(root, "control", "mailboxes") });
    policy.allowed_exec_prefixes = [toolchain + "/"];
    for (const dir of ["repo", "framework", "workers/ma-worker1/home", "workers/ma-worker1/scratch", "assignments/ma-worker1/project", "context"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    tree = join(root, "assignments/ma-worker1/project");
    writeFileSync(join(root, "repo/plan.md"), "approved plan\n"); writeFileSync(join(root, "framework/skill.md"), "pinned instructions");
    const workerRoot = join(root, "context", "ma-worker1");
    mkdirSync(workerRoot); chownSync(workerRoot, uid, workerGroup!); chmodSync(workerRoot, 0o2750);
    execFileSync("/usr/bin/setfacl", ["-b", "-k", workerRoot]);
    policyBytes = Buffer.from(JSON.stringify(policy));
    current = { ...binding, repository: { root: join(root, "repo"), identity: binding.repository.identity },
      planDigest: hashBytes("approved plan\n"), policyFingerprint: hashBytes(policyBytes) };
    now = Date.parse("2026-10-19T00:00:00Z"); native = 503;
    db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs(id, name) VALUES ('rig', 'fixture')").run();
    const events = new EventBus(db); queue = new QueueRepository(db, events);
    options = { credentials: { ownerToken: "owner-fixture", workers: [{ token: "worker-fixture", sessionId: "builder@rig", runId: "run" }] },
      resolveBinding: () => structuredClone(current),
      readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: current.policyFingerprint, verifiedProviders: ["claude", "codex"] }) };
    governance = new PlanGovernance(db, events, queue, () => new Date(now), options.readPolicyCapability);
    governance.createRun({ id: "run", rigId: "rig", binding: current });
    let serial = 0;
    const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
      expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: actionId + ++serial, payload });
    governance.requestApproval(command("approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(current) }, targetDigest: hashBinding(current), expiresAt: "2026-10-20T00:00:00.000Z" }),
    { kind: "worker", sessionId: "builder@rig" });
    governance.decideApproval(command("approval", { approvalVersion: 1, decision: "approved" }), { kind: "owner", sessionId: "owner-control" }, current);
    task = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] }, outputs: [], permissions: [],
      sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file." }), current).value as TeamTaskAuthority;
    rigRepo = new RigRepository(db); sessions = new SessionRegistry(db);
    const nodeId = rigRepo.addNode("rig", "builder", { runtime: "claude-code", cwd: tree }).id;
    sessions.registerSession(nodeId, "builder@rig"); sessions.updateBinding(nodeId, { tmuxSession: "builder@rig", tmuxPane: "%3" });
    nativePolicyFor = await buildManagedNativePolicy("claude-code", toolchain);
    context = project("attempt");
    const fact = (path: string, sha256 = "sha256:" + "a".repeat(64)) => ({ path, realpath: path, uid: 0, gid: 0, mode: 0o755, size: 12, sha256 });
    inspectReply = { schema: "multi-agent-launch-preflight/v1", worker: { name: "ma-worker1", uid: workerUid, gid: workerGroup },
      control: { uid, gid, mountNamespace: readlinkSync("/proc/self/ns/mnt"), userNamespace: readlinkSync("/proc/self/ns/user") },
      roots: { home: join(policy.paths.worker_root, "ma-worker1/home"), scratch: join(policy.paths.worker_root, "ma-worker1/scratch"),
        tree, context: context.root, framework: policy.paths.framework_dir },
      installed: { policy: { ...fact(policy.paths.installed_policy, current.policyFingerprint), size: policyBytes.length },
        launcher: fact(policy.paths.installed_launcher), egress: fact(policy.paths.installed_egress_config, hashBytes("egress profile")),
        executable: { ...fact(toolchain + "/clients/bin/claude"), realpath: toolchain + "/clients/lib/claude.exe" } },
      network: { hostNamespace: readlinkSync("/proc/self/ns/net"), profileFingerprint: hashBytes("egress profile") },
      clientLock: { client: "claude-code", version: "2.1.296", digest: hashBytes(lock),
        files: [{ path: toolchain + "/clients/lib/claude.exe", sha256: "sha256:" + "1".repeat(64) }] },
      provider: { client: "claude-code", status: "signed_in" } };
    inspectError = null; observeError = false; quiesceError = false; quiesced = []; started = false; snapshotChange = () => {};
    screen = SCREEN; orphan = false;
    processIo.stats.clear(); processIo.stats.set(LOCK, lock); processIo.stats.set(EGRESS, "egress profile");
    processIo.stats.set("/proc/self/mountinfo", "1 0 8:1 / / rw - ext4 /dev/sda rw\n");
    for (const pid of [PANE, SUPERVISOR, native]) setStart(pid, String(30_000 + pid));
    inspectionIo.execFile.mockReset(); inspectionIo.end.mockReset(); inspectionIo.readPolicy.mockReset();
    inspectionIo.readPolicy.mockImplementation(() => Buffer.from(policyBytes));
    processIo.list.mockReset();
    processIo.list.mockImplementation(async () => started ? [{ pid: SUPERVISOR, ppid: PANE, command: supervisorArgv(runningAttempt()).join(" ") },
      ...(orphan ? [{ pid: 777, ppid: 1, command: supervisorArgv(runningAttempt()).join(" ") }] : [])] : []);
    inspectionIo.execFile.mockImplementation((_file, args: string[], _options, callback) => {
      const mode = args[3], attemptId = args[args.indexOf("--attempt") + 1]!;
      queueMicrotask(() => {
        if (mode === "--inspect") return inspectError ? callback(Object.assign(new Error("exit 126"), { code: 126 }), "", inspectError.stderr)
          : callback(null, JSON.stringify(inspectReply), "");
        const observation = { schema: "multi-agent-sandbox-control/v1", supervisor: { processId: SUPERVISOR, processStart: String(30_000 + SUPERVISOR) },
          commandDigest: hashBytes(JSON.stringify(supervisorArgv(attemptId))), uid: workerUid, pidNamespace: "pid:[2]" };
        if (mode === "--quiesce") {
          quiesced.push(args[4]!);
          if (quiesceError) return callback(new Error("exit 126"), "", "{}");
          started = false; setStart(native, "0");
          return callback(null, JSON.stringify({ status: "terminated", observation }), "");
        }
        if (observeError) return callback(new Error("exit 126"), "", "{}");
        callback(null, JSON.stringify({ ...observation, snapshot: snapshot(attemptId, attemptId === "attempt" ? context : resumed!) }), "");
      });
      return { stdin: { end: inspectionIo.end } };
    });
    respawn = vi.fn(async (_pane: string, _line: string, opts: { beforeWrite: () => void }) => { opts.beforeWrite(); started = true; return { ok: true }; });
    restart();
    resumed = undefined;
  });
  let resumed: ContextManifest | undefined;
  /** A fresh control and launcher, as after a daemon restart; durable governance state is kept. */
  const restart = () => {
    control = createManagedLaunchControl({ db, queue, governance, options, rigRepo, sessions,
      tmux: { respawnPane: respawn, getPanePid: async () => PANE, capturePaneScreen: async () => screen } as any,
      resolvePane: async () => "%3", resolveAssignedTree: () => tree, mailbox: bridgeFor, dependencySatisfied: () => true,
      tmuxServer: "/tmp/tmux-" + uid + "/default", now: () => now, sleep: async ms => { now += ms; } });
    launcher = new RestrictedWorkerLauncher(control, () => now);
  };
  const runningAttempt = () => resumed && intent("attempt-2") ? "attempt-2" : "attempt";
  afterEach(() => {
    db.close(); processIo.stats.clear();
    for (const dir of [join(root, "context")]) execFileSync("/usr/bin/chmod", ["-R", "u+rwx", dir]);
    rmSync(root, { recursive: true, force: true });
  });

  it("adopts the native session at its first control observation and records the verified receipt", async () => {
    const result = await launch();
    expect(result).toMatchObject({ ok: true, resumeType: "claude_id" });
    if (!result.ok) throw new Error(result.error);
    const receipt = result.managedSession!;
    expect(receipt.identity).toMatchObject({ paneId: "%3", processId: native, processStart: String(30_000 + native), generation: 1,
      tmuxServer: "/tmp/tmux-" + uid + "/default" });
    // Governed start precedes every observation, and the start's own observation adopted the session.
    const modes = inspectionIo.execFile.mock.calls.map(call => (call[1] as string[])[3]);
    expect(modes).toEqual(["--inspect", "--observe", "--observe"]);
    expect(respawn.mock.invocationCallOrder[0]).toBeLessThan(inspectionIo.execFile.mock.invocationCallOrder[1]!);
    expect(inspectionIo.execFile.mock.calls[0]![1]).toContain("--client-lock");
    expect(governance.getAttempt("attempt")).toMatchObject({ state: "running", identity: receipt.identity });
    expect(runningRef()).toBe("managed-receipt:" + hashBytes(canonicalJson(receipt)));
    expect(await launcher.checkReady({ attemptId: "attempt", deadline: now + 60_000, context })).toEqual({ ready: true });
  });

  it.each(["remote-policy", "drop-in", "foreign-mount", "host-tmpfs", "mailbox", "native-restart", "pane-process"])(
    "quiesces and records a confirmed stop when %s drifts after readiness", async field => {
      expect(await launch()).toMatchObject({ ok: true });
      if (field === "remote-policy") snapshotChange = s => { s.nativePolicy.inventory.remotePolicy = "present"; };
      else if (field === "drop-in") snapshotChange = s => { s.nativePolicy.inventory.managedDropIns = "present"; };
      else if (field === "foreign-mount") snapshotChange = s => { s.mountInfo += "300 200 0:40 / /mnt/c rw - 9p drvfs rw\n"; };
      // The sandbox /run tmpfs device turns out to be a host mount: a bind, not a private instance.
      else if (field === "host-tmpfs") processIo.stats.set("/proc/self/mountinfo", "1 0 8:1 / / rw - ext4 /dev/sda rw\n2 1 0:96 / /run rw - tmpfs tmpfs rw\n");
      else if (field === "mailbox") snapshotChange = s => { s.mailbox.ino = 24; };
      else if (field === "native-restart") setStart(native, "99");
      else snapshotChange = s => { s.pane.processStart = "1"; };
      expect(await launcher.checkReady({ attemptId: "attempt", deadline: now + 60_000, context })).toMatchObject({ ready: false });
      expect(quiesced).toEqual([SUPERVISOR + ":" + (30_000 + SUPERVISOR)]);
      expect(governance.getAttempt("attempt")?.state).toBe("stopped");
      expect(runningRef()).toMatch(/^managed-quiescence:sha256:[a-f0-9]{64}$/);
    });

  it("keeps the WSL modules hidden below a masked path out of the boundary, but refuses them once reachable", async () => {
    snapshotChange = s => { s.mountInfo = s.mountInfo.split("\n").filter((line: string) => !line.includes(" /usr/lib/wsl ro ")).join("\n"); };
    expect(await launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_worker_mount_mismatch") });
    expect(governance.getAttempt("attempt")?.state).toBe("stopped");
  });

  it("resumes only from the exact receipt recorded for the stopped attempt", async () => {
    const first = await launch();
    if (!first.ok) throw new Error(first.error);
    snapshotChange = s => { s.mailbox.ino = 24; };
    await launcher.checkReady({ attemptId: "attempt", deadline: now + 60_000, context });
    snapshotChange = () => {};
    resumed = project("attempt-2"); native = 504; setStart(native, String(30_000 + native));
    inspectReply.roots.context = resumed.root;
    const previous = first.managedSession!, resume = { resumeToken: previous.identity.nativeSessionId };
    const forged = await launch(resumed, { ...resume, attempt: { attemptId: "attempt-2", deadline: now + 60_000, context: resumed,
      previous: { ...previous, processGroupId: previous.processGroupId + 1 } } }, "attempt-2");
    expect(forged).toMatchObject({ ok: false });
    expect(respawn).toHaveBeenCalledTimes(1);
    launcher = new RestrictedWorkerLauncher(control, () => now);
    const result = await launch(resumed, { ...resume, attempt: { attemptId: "attempt-2", deadline: now + 60_000, context: resumed, previous } }, "attempt-2");
    expect(result).toMatchObject({ ok: true, managedSession: { identity: { generation: 2, nativeSessionId: previous.identity.nativeSessionId, processId: 504 } } });
    expect(intent("attempt-2")!.command!.nativeArgv).toContain("--resume");
  });

  it.each([null, "", "Starting up..."])("never reports readiness from a %j pane screen", async value => {
    screen = value;
    expect(await launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_readiness_unknown") });
    expect(governance.getAttempt("attempt")?.state).toBe("stopped");
    expect(runningRef()).toMatch(/^managed-quiescence:/);
  });

  it("refuses to start over an unresolved intent from an earlier control, without closing it", async () => {
    observeError = true; quiesceError = true;
    expect(await launch()).toMatchObject({ ok: false });
    expect(intent()?.state).toBe("admitted");
    restart(); observeError = false; quiesceError = false;
    expect(await launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_quiescence_unconfirmed") });
    expect(respawn).toHaveBeenCalledTimes(1);
    expect(intent()?.state).toBe("admitted");
    expect(governance.getAttempt("attempt")).toBeNull();
  });

  it("never closes a concurrent start's intent after losing the admission race", async () => {
    // Another control admits the same command first; this start's own admission is then refused.
    const admit = governance.admitNativeAttempt.bind(governance);
    vi.spyOn(governance, "admitNativeAttempt").mockImplementationOnce((request, actor, current) => {
      admit(request, actor, current);
      return admit(request, actor, current);
    });
    expect(await launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_quiescence_unconfirmed") });
    expect(respawn).not.toHaveBeenCalled();
    expect(intent()?.state).toBe("admitted");
    expect(governance.getAttempt("attempt")).toBeNull();
  });

  it("leaves an ambiguous start unresolved when nothing locates its command", async () => {
    respawn.mockImplementationOnce(async () => ({ ok: false }));
    expect(await launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_quiescence_unconfirmed") });
    expect(intent()?.state).toBe("admitted");
    expect(governance.getAttempt("attempt")).toBeNull();
    expect(quiesced).toEqual([]);
  });

  it("stops an ambiguous start located by its command but never invents its native identity", async () => {
    observeError = true;
    expect(await launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_quiescence_unconfirmed") });
    expect(quiesced).toEqual([SUPERVISOR + ":" + (30_000 + SUPERVISOR)]);
    expect(intent()?.state).toBe("admitted");
    expect(governance.getAttempt("attempt")).toBeNull();
  });

  it("refuses a seat whose runtime differs from the attempt's client before any terminal write", async () => {
    db.prepare("UPDATE nodes SET runtime = 'codex'").run();
    expect(await launch()).toMatchObject({ ok: false });
    expect(respawn).not.toHaveBeenCalled();
    expect(intent()).toBeNull();
    expect(governance.getAttempt("attempt")).toBeNull();
  });

  it("closes a start refused before any terminal write as a confirmed no-start", async () => {
    options.credentials.ownerToken = undefined;
    const result = await launch();
    expect(result).toMatchObject({ ok: false });
    expect(respawn).not.toHaveBeenCalled();
    expect(intent()).toBeNull();
    expect(governance.getAttempt("attempt")).toBeNull();
  });

  it("stops a verified session whose receipt cannot be recorded, and keeps a failed stop unresolved", async () => {
    const reconcile = vi.spyOn(governance, "reconcileNativeAttempt");
    reconcile.mockImplementationOnce(() => { throw new Error("evidence store unavailable"); });
    expect(await launch()).toMatchObject({ ok: false });
    expect(quiesced).toHaveLength(1);
    // The verified receipt was never recorded, so governance goes straight from the admitted intent to the observed stop.
    expect(governance.getAttempt("attempt")?.state).toBe("stopped");
    expect(reconcile.mock.calls.map(call => (call[0].payload as { outcome: string }).outcome)).toEqual(["running", "stopped"]);
    reconcile.mockRestore();
  });

  it.each(["quiesce-error", "orphaned-supervisor"])("keeps a running attempt blocked rather than reporting an unconfirmed stop (%s)", async field => {
    expect(await launch()).toMatchObject({ ok: true });
    snapshotChange = s => { s.mailbox.ino = 24; };
    if (field === "quiesce-error") quiesceError = true; else orphan = true;
    expect(await launcher.checkReady({ attemptId: "attempt", deadline: now + 60_000, context }))
      .toMatchObject({ ready: false, code: "managed_quiescence_unconfirmed" });
    expect(governance.getAttempt("attempt")?.state).toBe("running");
    expect(runningRef()).toMatch(/^managed-receipt:/);
  });

  it("reports a launcher lock refusal as a non-retryable unsupported version before any start (A-R3)", async () => {
    inspectError = { stderr: JSON.stringify({ worker_launch_error: "unsupported-version", message: "hash differs" }) };
    const result = await launch();
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining(UNSUPPORTED_CLIENT_VERSION) });
    expect(respawn).not.toHaveBeenCalled();
    expect(inspectionIo.execFile).toHaveBeenCalledTimes(1);
  });

  it.each(["signed_out", "unknown"])("blocks a %s provider before any start", async status => {
    inspectReply.provider.status = status;
    expect(await launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_provider_signin_required") });
    expect(respawn).not.toHaveBeenCalled();
  });
});

describe("production managed launch composition", () => {
  const LOCK = "/etc/multi-agent/client-lock.json", owner = { kind: "owner" as const, sessionId: "owner-control" };
  const lock = JSON.stringify({ schema: "multi-agent-client-lock/v1", clients: {
    "claude-code": { version: "2.1.296", files: [{ path: "clients/lib/claude.exe", sha256: "sha256:" + "1".repeat(64) }] },
    codex: { version: "0.160.0", files: [{ path: "clients/lib/codex.js", sha256: "sha256:" + "2".repeat(64) }] } } });
  let scratch: string, policy: any, policyBytes: Buffer, current: PlanBinding, actualExecFile: typeof import("node:child_process").execFile;
  const boot = async (mode: "legacy" | "managed", teamControl?: TeamControlOptions) => {
    process.env.OPENRIG_HOME = join(scratch, mode);
    process.env.OPENRIG_SLICES_ROOT = join(scratch, mode + "-missions");
    mkdirSync(process.env.OPENRIG_SLICES_ROOT, { recursive: true });
    const { createDaemon } = await import("../src/startup.js");
    return createDaemon({ dbPath: join(scratch, mode + ".sqlite"), managedMode: mode === "managed", workersIsolation: "hardened", teamControl,
      tmuxExec: async () => "", cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
  };
  beforeEach(async () => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "managed-composition-")));
    policy = JSON.parse(readFileSync(new URL("../../../config/isolation/worker-policy.json", import.meta.url), "utf8"));
    // The seat's assigned tree must be a real canonical directory before any privileged call.
    policy.paths.assignment_root = join(scratch, "assignments");
    mkdirSync(join(policy.paths.assignment_root, "ma-worker1", "project"), { recursive: true });
    policyBytes = Buffer.from(JSON.stringify(policy));
    // T039: isolation stages the run's own repository rather than launching from the
    // binding's declared path, so the fixture supplies a real one. The policy and the
    // installed launcher are still faked exactly as before.
    const repositoryRoot = join(scratch, "repo");
    mkdirSync(join(repositoryRoot, "src"), { recursive: true });
    writeFileSync(join(repositoryRoot, "plan.md"), "approved plan\n");
    execFileSync("git", ["-C", repositoryRoot, "init", "--quiet", "--initial-branch=main"]);
    execFileSync("git", ["-C", repositoryRoot, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "."]);
    execFileSync("git", ["-C", repositoryRoot, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "--quiet", "-m", "base"]);
    current = { ...binding, repository: { root: repositoryRoot, identity: binding.repository.identity },
      planDigest: hashBytes("approved plan\n"), policyFingerprint: hashBytes(policyBytes) };
    actualExecFile = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).execFile;
    processIo.stats.clear(); processIo.stats.set(LOCK, lock);
    inspectionIo.readPolicy.mockReset(); inspectionIo.readPolicy.mockImplementation(() => Buffer.from(policyBytes));
    inspectionIo.execFile.mockReset(); inspectionIo.end.mockReset();
    // Only the privileged launcher is faked: it refuses the client build, as the installed launcher does for a lock mismatch.
    inspectionIo.execFile.mockImplementation((file: string, args: string[], options: unknown, callback: (...values: unknown[]) => void) => {
      if (file !== "/usr/bin/sudo") return (actualExecFile as any)(file, args, options, callback);
      queueMicrotask(() => callback(Object.assign(new Error("exit 126"), { code: 126 }), "",
        JSON.stringify({ worker_launch_error: "unsupported-version", message: "claude-code executable hash differs" }) + "\n"));
      return { stdin: { end: inspectionIo.end } };
    });
  });
  afterEach(() => { processIo.stats.clear(); rmSync(scratch, { recursive: true, force: true }); });

  it("injects one launch chain into both fresh and both resume adapters in a managed daemon only", async () => {
    const legacy = await boot("legacy");
    try {
      expect(legacy.deps.managedLaunch).toBeUndefined();
      expect((legacy.deps.runtimeAdapters!["claude-code"] as any).workerLauncher).toBeUndefined();
    } finally { legacy.deps.proofSourceWatch?.close(); legacy.deps.modelDivergenceMonitor?.stop(); legacy.deps.gatewaySubsystem?.stop(); legacy.db.close(); }
    const managed = await boot("managed");
    try {
      const launcher = managed.deps.managedLaunch!.launcher, restore = managed.deps.restoreOrchestrator as any;
      expect(launcher).toBeInstanceOf(RestrictedWorkerLauncher);
      expect([(managed.deps.runtimeAdapters!["claude-code"] as any).workerLauncher, (managed.deps.runtimeAdapters!.codex as any).workerLauncher,
        restore.claudeResume.options.workerLauncher, restore.codexResume.options.workerLauncher]).toEqual([launcher, launcher, launcher, launcher]);
      // The app's mailbox owner reads the launch chain's channel evidence, and the app shares its governance owner.
      expect(managed.deps.nativeChannelState).toBe(managed.deps.managedLaunch!.channel.read);
      expect(managed.deps.mailboxDelivery).toBeDefined();
      expect(managed.deps.teamGovernance).toBeDefined();
    } finally { managed.db.close(); }
  }, 60_000);

  it("refuses a client outside the lock on fresh launch and resume through the composed adapters (A-R3)", async () => {
    const options: TeamControlOptions = { credentials: { ownerToken: "owner-fixture",
      workers: [{ token: "worker-fixture", sessionId: "builder@rig", runId: "run" }] },
    resolveBinding: () => structuredClone(current),
    readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: current.policyFingerprint, verifiedProviders: ["claude", "codex"] }) };
    const daemon = await boot("managed", options);
    try {
      const { db } = daemon, governance = daemon.deps.teamGovernance!, launch = daemon.deps.managedLaunch!;
      let serial = 0;
      const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
        expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: actionId + ++serial, payload });
      db.prepare("INSERT INTO rigs(id, name) VALUES ('rig', 'rig')").run();
      governance.createRun({ id: "run", rigId: "rig", binding: current });
      governance.requestApproval(command("approval", { kind: "orchestrator", action: "implementation",
        payload: { bindingDigest: hashBinding(current) }, targetDigest: hashBinding(current), expiresAt: "2099-01-01T00:00:00.000Z" }),
      { kind: "worker", sessionId: "builder@rig" });
      governance.decideApproval(command("approval", { approvalVersion: 1, decision: "approved" }), owner, current);
      const task = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] }, outputs: [], permissions: [],
        sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file." }), current).value as TeamTaskAuthority;
      const tree = policy.paths.assignment_root + "/ma-worker1/project";
      const rigRepo = new RigRepository(db), sessions = new SessionRegistry(db);
      const nodeId = rigRepo.addNode("rig", "builder", { runtime: "claude-code", cwd: tree }).id;
      sessions.registerSession(nodeId, "builder@rig"); sessions.updateBinding(nodeId, { tmuxSession: "builder@rig", tmuxPane: "%3" });
      const attempt = (client: "claude-code" | "codex", attemptId = "attempt") => ({ attemptId, deadline: Date.now() + 60_000, context: {
        runId: "run", binding: current, assignment: task.assignment, role: "implementer", client,
        projection: { worker: "ma-worker1", attemptId, controlUid: process.getuid!(), workerGid: 61001, policy },
        root: policy.paths.context_root + "/ma-worker1/run/" + attemptId, mutableStateRoot: policy.paths.worker_root + "/ma-worker1/home",
        frameworkRoot: policy.paths.framework_dir, frameworkRevision: "fixture", workerUid: 61001, workerGroups: [],
        outputs: [], permissions: [], files: [], discoveryRoots: [], workerDiscoveryRoots: [], generatedHash: "sha256:" + "f".repeat(64),
        protocolVersion: null } as unknown as ContextManifest });
      const node = (client: "claude-code" | "codex", attemptId?: string) => ({ id: "binding", nodeId: "builder", cwd: tree, tmuxSession: "builder@rig",
        managedAttempt: attempt(client, attemptId) }) as any;
      const adapters = daemon.deps.runtimeAdapters!, restore = daemon.deps.restoreOrchestrator as any;
      // Without a registered endpoint nothing reaches the privileged launcher.
      expect(await adapters["claude-code"]!.launchHarness(node("claude-code"), { name: "builder" })).toMatchObject({ ok: false });
      expect(inspectionIo.execFile.mock.calls.filter(call => call[0] === "/usr/bin/sudo")).toHaveLength(0);
      // Each path is its own attempt: a refusal blocks that attempt in the shared launcher.
      const register = (attemptId: string) => {
        const endpoint = { path: policy.paths.mailbox_root + "/ma-worker1/run/" + attemptId + "/mailbox.sock", dev: 1, ino: 23,
          uid: process.getuid!(), gid: process.getgid!(), generation: "generation-1" };
        launch.endpoints.set(attemptId, { endpoint: () => Object.freeze({ ...endpoint }), binding: { socketPath: endpoint.path, workerId: "builder",
          sessionId: "builder@rig", runId: "run", attemptId, rigId: "rig", taskId: "task", recipients: [] } });
        return attemptId;
      };
      const results = [], digest = "sha256:" + "e".repeat(64);
      // Each attempt's own block must close the channel through the production guard, which the launcher's record reaches.
      const open = (attemptId: string, client: "claude-code" | "codex") => {
        launch.channel.verified(attemptId, "builder@rig", client, client === "codex" ? "0.160.0" : "2.1.296", digest);
        expect(launch.channel.read("builder@rig")).not.toBeNull();
      };
      for (const client of ["claude-code", "codex"] as const) {
        open(register(client + "-fresh"), client);
        results.push(await adapters[client]!.launchHarness(node(client, client + "-fresh"), { name: "builder" }));
        expect(launch.channel.read("builder@rig")).toBeNull();
        const resume = attempt(client, register(client + "-resume"));
        open(client + "-resume", client);
        results.push(client === "codex"
          ? await restore.codexResume.resume("builder@rig", "codex_id", "native-session", tree, undefined, undefined, undefined, undefined, undefined, undefined, undefined, resume)
          : await restore.claudeResume.resume("builder@rig", "claude_id", "native-session", tree, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, resume));
        expect(launch.channel.read("builder@rig")).toBeNull();
      }
      for (const result of results) expect(JSON.stringify(result)).toContain(UNSUPPORTED_CLIENT_VERSION);
      // A blocked attempt's endpoint registration is dropped; it can never launch again.
      for (const id of ["claude-code-fresh", "claude-code-resume", "codex-fresh", "codex-resume"]) expect(launch.endpoints.has(id)).toBe(false);
      // Another attempt's block leaves the seat's verified channel open.
      open("verified-elsewhere", "claude-code");
      expect(await adapters["claude-code"]!.launchHarness(node("claude-code", register("claude-code-other")), { name: "builder" })).toMatchObject({ ok: false });
      expect(launch.channel.read("builder@rig")).not.toBeNull();
      const inspections = inspectionIo.execFile.mock.calls.filter(call => call[0] === "/usr/bin/sudo");
      expect(inspections).toHaveLength(5);
      for (const call of inspections) expect(call[1]).toEqual(expect.arrayContaining(["--inspect", "--client-lock", hashBytes(lock)]));
      // A seat whose tree is an alias of its assigned directory never reaches the privileged launcher.
      const alias = tree + "-alias";
      symlinkSync(tree, alias);
      db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(alias, nodeId);
      expect(await adapters["claude-code"]!.launchHarness(node("claude-code", register("claude-code-aliased")), { name: "builder" }))
        .toMatchObject({ ok: false });
      expect(inspectionIo.execFile.mock.calls.filter(call => call[0] === "/usr/bin/sudo")).toHaveLength(5);
      db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(tree, nodeId);
      // A seat whose persisted terminal binding names another session never reaches the privileged launcher.
      sessions.updateBinding(nodeId, { tmuxSession: "other@rig", tmuxPane: "%3" });
      expect(await adapters["claude-code"]!.launchHarness(node("claude-code", register("claude-code-rebound")), { name: "builder" }))
        .toMatchObject({ ok: false });
      expect(inspectionIo.execFile.mock.calls.filter(call => call[0] === "/usr/bin/sudo")).toHaveLength(5);
      for (const id of ["claude-code-fresh", "claude-code-resume", "codex-fresh", "codex-resume", "claude-code-other"]) {
        expect(governance.getNativeLaunchIntent("run", id)).toBeNull();
      }
    } finally { daemon.db.close(); }
  }, 60_000);
});

describe("offline fixture-daemon restart", () => {
  // Each phase is a separate daemon process on the same database file; nothing but durable state carries over.
  const source = `
    const { createDaemon } = await import(process.env.T041_STARTUP);
    const { LeadWakePolicy } = await import(process.env.T041_WAKE);
    const binding = JSON.parse(process.env.T041_BINDING), phase = process.env.T041_PHASE;
    const teamControl = { credentials: { ownerToken: "owner-fixture", workers: [{ token: "worker-fixture", sessionId: "builder@rig", runId: "run" }] },
      resolveBinding: () => structuredClone(binding),
      readPolicyCapability: () => ({ policyRevision: 5, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"] }) };
    // Every terminal command this daemon sends; a native start is a respawn-pane.
    const tmuxCommands = [];
    const daemon = await createDaemon({ dbPath: process.env.OPENRIG_DB, managedMode: true, workersIsolation: "hardened", teamControl,
      tmuxExec: async command => { tmuxCommands.push(command); return ""; },
      cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
    const { db, deps } = daemon, governance = deps.teamGovernance, launch = deps.managedLaunch, owner = { kind: "owner", sessionId: "owner-control" };
    let serial = 0;
    const command = (actionId, payload) => ({ protocolVersion: "1.0", runId: "run", actionId,
      expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: phase + actionId + ++serial, payload });
    const scope = { rigId: "rig", recipient: "builder@rig", taskId: "task", runId: "run", capability: "mailbox:" + "c".repeat(43) };
    const deliver = (acknowledgedMessageIds = []) => deps.mailboxDelivery.deliverToNativeChannel({ ...scope, consumedBy: "builder@rig", acknowledgedMessageIds });
    const summary = result => ({ status: result.status, reason: result.reason, messageIds: result.messageIds,
      rejected: result.rejectedMessageIds, receipts: result.receipts.length });
    // The daemon's own activity evidence for this occupant, observed after this process started.
    const promptClear = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      const nodeId = db.prepare("SELECT node_id AS nodeId FROM sessions WHERE session_name = 'builder@rig'").get().nodeId;
      deps.agentActivityStore.recordHookEvent({ runtime: "claude-code", sessionName: "builder@rig", hookEvent: "Stop",
        generation: deps.sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid });
    };
    // Stands in for the launcher's verified receipt; the guard that applies it has its own contract tests.
    const verify = () => launch.channel.verified("attempt", "builder@rig", "claude-code", "2.1.296", "sha256:" + "e".repeat(64));
    const out = { injected: [deps.runtimeAdapters["claude-code"].workerLauncher, deps.runtimeAdapters.codex.workerLauncher,
      deps.restoreOrchestrator.claudeResume.options.workerLauncher, deps.restoreOrchestrator.codexResume.options.workerLauncher]
      .every(value => value === launch.launcher) };
    if (phase === "first") {
      db.prepare("INSERT INTO rigs(id, name) VALUES ('rig', 'rig')").run();
      const nodeId = deps.rigRepo.addNode("rig", "builder", { runtime: "claude-code", cwd: "/work" }).id;
      deps.sessionRegistry.registerSession(nodeId, "builder@rig");
      governance.createRun({ id: "run", rigId: "rig", binding });
      governance.requestApproval(command("approval", { kind: "orchestrator", action: "implementation",
        payload: { bindingDigest: process.env.T041_BINDING_DIGEST }, targetDigest: process.env.T041_BINDING_DIGEST,
        expiresAt: "2099-01-01T00:00:00.000Z" }), { kind: "worker", sessionId: "builder@rig" });
      governance.decideApproval(command("approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
      const task = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] }, outputs: [], permissions: [],
        sourceSession: "lead@rig", destinationSession: "builder@rig", body: "Implement the assigned file." }), binding).value;
      deps.chatRepo.sendMailbox("rig", "lead@rig", { messageId: "durable-message", recipient: "builder@rig", taskId: "task", runId: "run",
        body: "durable peer note", capability: scope.capability });
      const run = governance.getRun("run");
      deps.eventBus.withNotifyEnvelope(register => new LeadWakePolicy(db, deps.eventBus).save(run, { pending: {},
        activations: Array.from({ length: 12 }, () => Date.now()), cycles: {}, grant: 0, cycleBlock: null }, register));
      out.admitted = governance.admitNativeAttempt(command("attempt", { qitemId: task.qitemId, expectedTaskVersion: task.entityVersion,
        sessionId: "builder@rig", provider: "claude", commandDigest: "sha256:" + "d".repeat(64), previousAttemptId: null,
        expectedPreviousVersion: null }), owner, binding).effectMayStart;
      out.unverified = summary(deliver());
      launch.endpoints.set("attempt", { endpoint: () => ({}), binding: {} });
      verify();
      out.promptUnknown = summary(deliver());
      await promptClear();
      // A real handout: the message reaches this boundary but stays pending until a later boundary acknowledges it.
      out.handedOut = summary(deliver());
    } else {
      out.endpoints = launch.endpoints.size;
      out.channel = deps.nativeChannelState("builder@rig");
      out.beforeObservation = summary(deliver(["durable-message"]));
      verify();
      // The first process's hook is still stored, but it predates this daemon, so the boundary is not observed.
      out.priorPrompt = summary(deliver(["durable-message"]));
      await promptClear();
      // The handout from the earlier process is no consumption right: the ack is refused and the message is handed out again.
      out.staleAck = summary(deliver(["durable-message"]));
      out.freshAck = summary(deliver(["durable-message"]));
      out.pending = deps.chatRepo.countPendingMailbox(scope);
      out.wake = new LeadWakePolicy(db, deps.eventBus).check(governance.getRun("run"), null, new Date().toISOString()).reason;
      // The admitted intent from the first process grants no start here: with no fresh endpoint registration and
      // observation the production adapter refuses it before any terminal write.
      const stale = await deps.runtimeAdapters["claude-code"].launchHarness({ id: "binding", nodeId: "builder", cwd: "/work",
        tmuxSession: "builder@rig", managedAttempt: { attemptId: "attempt", deadline: Date.now() + 60_000,
          context: { runId: "run", client: "claude-code" } } }, { name: "builder" });
      out.staleLaunch = { ok: stale.ok, respawned: tmuxCommands.filter(command => command.includes("respawn-pane")).length,
        attemptRow: governance.getAttempt("attempt") };
      out.intent = governance.getNativeLaunchIntent("run", "attempt")?.state;
    }
    process.stdout.write("T041-RESULT " + JSON.stringify(out) + "\\n");
    process.exit(0);
  `;
  let scratch: string;
  beforeEach(() => { scratch = realpathSync(mkdtempSync(join(tmpdir(), "managed-restart-"))); });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));
  const run = (phase: "first" | "second") => {
    const env: NodeJS.ProcessEnv = { ...process.env, T041_PHASE: phase, OPENRIG_HOME: join(scratch, "home"),
      OPENRIG_DB: join(scratch, "daemon.sqlite"), OPENRIG_SLICES_ROOT: join(scratch, "missions"),
      T041_STARTUP: new URL("../src/startup.ts", import.meta.url).href,
      T041_WAKE: new URL("../src/domain/lead-wake-policy.ts", import.meta.url).href,
      T041_BINDING: JSON.stringify(binding), T041_BINDING_DIGEST: hashBinding(binding) };
    mkdirSync(env.OPENRIG_SLICES_ROOT!, { recursive: true });
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: new URL("..", import.meta.url).pathname, env, encoding: "utf8", timeout: 90_000 });
    const line = child.stdout.split("\n").find(row => row.startsWith("T041-RESULT "));
    if (child.status !== 0 || !line) throw new Error("fixture daemon failed: " + child.stderr.slice(-2_000));
    return JSON.parse(line.slice("T041-RESULT ".length));
  };

  it("keeps durable messages, wake limits and unresolved intents, but not admission or handout rights", () => {
    const first = run("first");
    const hold = (reason: string, rejected: string[] = []) => ({ status: "pending", reason, messageIds: [], rejected, receipts: 0 });
    expect(first).toEqual({ injected: true, admitted: true, unverified: hold("channel_config_absent"),
      // The composed reader admits the channel; the daemon's prompt evidence then decides the boundary.
      promptUnknown: hold("prompt_not_clear"),
      handedOut: { status: "delivered", reason: null, messageIds: ["durable-message"], rejected: [], receipts: 0 } });
    const second = run("second");
    expect(second).toEqual({ injected: true, endpoints: 0, channel: null,
      beforeObservation: hold("channel_config_absent", ["durable-message"]),
      priorPrompt: hold("prompt_not_clear", ["durable-message"]),
      staleAck: { status: "delivered", reason: null, messageIds: ["durable-message"], rejected: ["durable-message"], receipts: 0 },
      // Only a handout made by this process can be acknowledged, and then it is consumed once.
      freshAck: { status: "empty", reason: null, messageIds: [], rejected: [], receipts: 1 },
      pending: 0, wake: "lead-wake:hourly", staleLaunch: { ok: false, respawned: 0, attemptRow: null }, intent: "admitted" });
  }, 180_000);
});
