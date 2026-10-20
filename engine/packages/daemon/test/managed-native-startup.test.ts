import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
import { inspectManagedWorker, observeManagedWorkerProcess, resolveManagedWorkerScope, resolveManagedWorkerSeat, startManagedWorkerCommand, startManagedWorkerInPane } from "../src/adapters/worker-launch-control.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import type { WorkerMailboxBridge } from "../src/adapters/worker-mailbox-bridge.js";
import type { WorkerCommand, WorkerLaunchInput } from "../src/adapters/worker-launch.js";

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
    const created = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
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
      const created = governance.createTask(leadCommand("lead-task", { assignment: { taskId: "lead-task", role: "lead", paths: ["src"], dependencies: [] },
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
        const next = governance.createTask(command("next-task", { assignment: { taskId: "next-task", role: "implementer", paths: ["src"], dependencies: [] },
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
  const resolveAssignedTree = () => assignedTree;
  const inspect = () => inspectManagedWorker(context, bridge, { db, queue, governance, options, resolveAssignedTree });
  const counts = () => ["team_attempts", "team_control_requests", "chat_messages"].map(table =>
    db.prepare("SELECT count(*) AS count FROM " + table).get());
  beforeEach(() => {
    inspectionIo.execFile.mockReset(); inspectionIo.readPolicy.mockReset(); inspectionIo.end.mockReset();
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
    const task = governance.createTask(command("task", { assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
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
      network: { hostNamespace: readlinkSync("/proc/self/ns/net"), profileFingerprint: "sha256:" + "a".repeat(64) } };
    inspectionIo.readPolicy.mockImplementation(() => Buffer.from(policyBytes)); duringInspection = () => {};
    inspectionIo.execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => { duringInspection(); callback(null, JSON.stringify(reply), ""); });
      return { stdin: { end: inspectionIo.end } };
    });
  });
  afterEach(() => db.close());

  it("binds observed facts through the fixed bounded inspect command without recording an admission", async () => {
    const before = counts(), result = await inspect();
    expect(result).toMatchObject({ scope: { sessionId: "builder@rig" }, facts: reply, mailbox: endpoint });
    expect(Object.isFrozen(result.facts.installed)).toBe(true); expect(counts()).toEqual(before);
    expect(result.facts.roots.tree).not.toBe(context.binding.repository.root);
    expect(inspectionIo.execFile).toHaveBeenCalledExactlyOnceWith("/usr/bin/sudo", ["-n", "--",
      "/usr/local/libexec/multi-agent/worker-launch", "--inspect", "--worker", "ma-worker1", "--role", "implementer",
      "--tree", assignedTree, "--run", "run", "--attempt", "attempt", "--mailbox", "1:23",
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
        sourceSession: "lead@rig", destinationSession: "reviewer@rig", body: "Inspect the review tree." } }, context.binding).value as TeamTaskAuthority;
    assignedTree = assignedTree.replace("ma-worker1", "ma-worker2");
    context = { ...context, assignment: secondTask.assignment, role: "reviewer", client: "codex", workerUid: 61002,
      root: context.root.replace("ma-worker1", "ma-worker2").replace("/attempt", "/attempt-2"),
      projection: { ...context.projection, worker: "ma-worker2", workerGid: 61002, attemptId: "attempt-2" } };
    endpoint = { ...endpoint, path: endpoint.path.replace("ma-worker1", "ma-worker2").replace("/attempt/", "/attempt-2/"), ino: 24, generation: "generation-2" };
    bridge = { endpoint: bridge.endpoint, binding: { ...bridge.binding, socketPath: endpoint.path, attemptId: "attempt-2", taskId: "review-task", workerId: "reviewer", sessionId: "reviewer@rig" } };
    reply.installed.executable.path = reply.installed.executable.realpath = reply.installed.executable.path.replace("/claude", "/codex");
    reply = { ...reply, worker: { name: "ma-worker2", uid: 61002, gid: 61002 },
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

  it.each(["schema", "worker", "control", "namespace", "tree", "executable", "file-owner", "file-mode", "policy-hash", "egress-hash"])(
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
      else reply.network.profileFingerprint = "sha256:" + "e".repeat(64);
      const before = counts(); await expect(inspect()).rejects.toThrow("managed_inspection_unverified"); expect(counts()).toEqual(before);
      expect(inspectionIo.execFile).toHaveBeenCalledOnce();
    });

  it.each(["policy", "mailbox", "assignment", "revocation", "cancellation"])("rechecks %s after asynchronous inspection", async field => {
    duringInspection = () => {
      if (field === "policy") policyBytes = Buffer.concat([policyBytes, Buffer.from("\n")]);
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
});
