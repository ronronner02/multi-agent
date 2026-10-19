import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestrictedWorkerLauncher, type WorkerClient, type WorkerLaunchControl, type WorkerLaunchEvent, type WorkerLaunchPreflight, type WorkerObservation, type WorkerQuiescenceReceipt } from "../src/adapters/worker-launch.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { isAttentionRequiredReadinessCode, type ManagedAttempt, type NodeBinding } from "../src/domain/runtime-adapter.js";
import { hashBytes } from "../src/domain/plan-governance.js";
import { buildManagedNativePolicy, createContextManifest, projectContext, roleConfiguration, type ContextInput } from "../src/integrations/framework/context-manifest.js";
import { FRAMEWORK_PIN } from "../src/integrations/framework/catalog.js";

const roots: string[] = [];
afterEach(() => {
  const writable = (p: string) => { chmodSync(p, 0o755); for (const entry of readdirSync(p, { withFileTypes: true })) if (entry.isDirectory()) writable(join(p, entry.name)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

// Real filesystem/assignment/context authority; OS transport is a bounded fixture.
// These observations do not establish native-client or host-containment acceptance.
function fixture(client: WorkerClient, revision = 4, role: "implementer" | "reviewer" = "implementer") {
  const root = mkdtempSync(join(tmpdir(), "native-contract-"));
  roots.push(root);
  chmodSync(root, 0o755);
  for (const dir of ["repo", "context", "state", "framework", "home", "scratch"]) mkdirSync(join(root, dir));
  const contextRoot = join(root, "context", "ma-worker1", "run", "attempt-1");
  const workerRoot = join(root, "context", "ma-worker1");
  for (const p of [workerRoot, join(workerRoot, "run"), contextRoot]) {
    mkdirSync(p);
    chmodSync(p, 0o2750);
  }
  execFileSync("/usr/bin/setfacl", ["-b", "-k", workerRoot]);
  execFileSync("/usr/bin/setfacl", ["-m", "u::rwx,g::r-x,m::r-x,o::---", workerRoot]);
  execFileSync("/usr/bin/setfacl", ["-m", "d:u::rwx,d:g::r-x,d:m::r-x,d:o::---", workerRoot]);
  const contextPolicy = { policy_revision: 4, worker_identities: ["ma-worker1", "ma-worker2", "ma-worker3"],
    paths: { context_root: join(root, "context"), framework_dir: join(root, "framework") }, sandbox: { context: "/context", framework: "/framework" } };
  const plan = "approved plan\n", policyFingerprint = hashBytes("policy");
  const binding: ContextInput["binding"] = {
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "plan.md", planDigest: hashBytes(plan), repository: { root: join(root, "repo"), identity: "git:" + "a".repeat(40) },
    readPaths: ["src"], writePaths: ["src"], roles: ["implementer", "reviewer"], policyRevision: 4, policyFingerprint,
    limits: { maxSessions: 3, maxActiveMs: 60000, maxRetries: 1, maxReviewRounds: 2 },
  };
  writeFileSync(join(root, "repo", "plan.md"), plan);
  const source = join(root, "framework", "skill.md");
  writeFileSync(source, "pinned instructions");
  const files = ([["framework", "pinned instructions"], ["plan", plan], ["role", JSON.stringify(roleConfiguration)]] as const).map(([kind, content]) => {
    const path = join(contextRoot, kind);
    writeFileSync(path, content, { mode: 0o440 });
    return { path, hash: hashBytes(content), kind, readOnly: true as const, ...(kind === "framework" ? { source } : {}) };
  });
  chmodSync(contextRoot, 0o550);
  const context = createContextManifest({
    projection: { worker: "ma-worker1", attemptId: "attempt-1", controlUid: process.getuid!(), workerGid: process.getgid!(), policy: contextPolicy },
    runId: "run", assignment: { taskId: "T008", role, paths: ["src"], dependencies: [] },
    outputs: role === "reviewer" ? [] : ["src/result.ts"],
    permissions: role === "reviewer" ? ["submit-review"] : ["write-assigned-tree"], role, client, binding,
    root: contextRoot, mutableStateRoot: join(root, "state"), frameworkRoot: join(root, "framework"), frameworkRevision: FRAMEWORK_PIN.revision,
    workerUid: process.getuid!() + 100000, workerGroups: [], discoveryRoots: [contextRoot], files,
  });
  const observed = { discoveryRoots: [...context.workerDiscoveryRoots], files: context.files.map(({ workerPath, hash }) => ({ path: workerPath, hash })) };
  const attempt: ManagedAttempt = { attemptId: "attempt-1", deadline: 61000, context };
  const p: WorkerLaunchPreflight = {
    assignment: { binding, currentBinding: structuredClone(binding), assignment: context.assignment, outputs: [...context.outputs],
      permissions: [...context.permissions], context, observed, dependencySatisfied: () => true },
    worker: { name: "ma-worker1", uid: context.workerUid, gid: context.projection.workerGid, groups: [], home: join(root, "home"), scratch: join(root, "scratch"), tree: join(root, "repo") },
    control: { uid: process.getuid!(), mountNamespace: "mnt:control", userNamespace: "user:control" },
    executable: "/opt/multi-agent/toolchain/clients/bin/" + (client === "codex" ? "codex" : "claude"),
    executableVersion: "fixture-version", generation: 1, policyFingerprint, policyRevision: revision,
    installedPolicy: {
      policy_revision: revision, worker_identities: ["ma-worker1", "ma-worker2", "ma-worker3"],
      paths: { ...contextPolicy.paths, toolchain_dir: "/opt/multi-agent/toolchain", egress_socket_dir: "/run/multi-agent-egress" }, sandbox: { ...contextPolicy.sandbox, network: "filtered-proxy", etc_ro_binds: ["/etc/hosts"], masked_paths: ["/usr/lib/wsl"] },
    },
    network: { mode: "filtered-proxy", hostNamespace: "net:[100]", profileFingerprint: hashBytes("approved egress profile"), preflightRef: "evidence/u1-network-preflight" },
    provider: { status: "signed_in", client, home: join(root, "home"), evidenceRef: "evidence/provider-status" },
    credentialValues: ["FIXTURE_SECRET"],
  };
  const observation: WorkerObservation = {
    identity: { nativeSessionId: "native-session", tmuxServer: "/run/control/tmux", paneId: "%1",
      processId: 4100, processStart: "100", generation: 1, policyFingerprint },
    attemptId: attempt.attemptId, processGroupId: 4100,
    boundary: { uid: context.workerUid, groups: [], home: "/home/worker", configHome: "/home/worker/" + (client === "codex" ? ".codex" : ".claude"),
      mountNamespace: "mnt:worker", userNamespace: "user:worker",
      networkNamespace: "net:[200]", networkProfileFingerprint: p.network.profileFingerprint,
      mounts: [{ source: p.worker.home, target: "/home/worker", access: "rw" }, { source: p.worker.scratch, target: "/scratch", access: "rw" },
        { source: p.worker.tree, target: "/work", access: role === "reviewer" ? "ro" : "rw" }, { source: context.frameworkRoot, target: "/framework", access: "ro" },
        { source: context.root, target: "/context", access: "ro" }, { source: "/run/multi-agent-egress", target: "/run/multi-agent-egress", access: "ro" }],
      inheritedDescriptors: [0, 1, 2].map(fd => ({ fd, kind: "tty" as const })) },
    context: structuredClone(observed), nativeArgv: [], sessionSource: client === "codex" ? "process_session_file" : "exec",
    effectiveMode: client === "codex" ? { approvalPolicy: "never", sandbox: "danger-full-access" } : { permissionMode: "bypassPermissions" },
    readiness: "ready", screen: client === "codex" ? "OpenAI Codex (vfixture)\n›" : "Claude Code vfixture\n❯",
    output: { text: "native client started", evidenceRef: "evidence/native-output" },
  };
  const events: WorkerLaunchEvent[] = [];
  let started: Pick<WorkerObservation, "identity" | "processGroupId"> | undefined;
  const control: WorkerLaunchControl = {
    preflight: vi.fn(async () => p),
    start: vi.fn(async command => {
      observation.nativeArgv = [...command.nativeArgv];
      started = { identity: structuredClone(observation.identity), processGroupId: observation.processGroupId };
      return structuredClone(observation.identity);
    }),
    observe: vi.fn(async () => structuredClone(observation)),
    quiesce: vi.fn(async request => ({ command: request.command, evidenceRef: "evidence/worker-quiescence",
      ...(started ? { status: "terminated" as const, ...structuredClone(started) } : { status: "not_started" as const }) })),
    record: vi.fn(async event => { events.push(structuredClone(event)); }),
  };
  let now = 1000;
  const launcher = new RestrictedWorkerLauncher(control, () => now, () => "native-session");
  const tmux = new Proxy({}, { get: () => vi.fn(() => { throw new Error("Legacy terminal input reached"); }) }) as TmuxAdapter;
  const fsOps = { readFile: vi.fn(), writeFile: vi.fn(), exists: () => false, mkdirp: vi.fn(), copyFile: vi.fn() };
  const adapter = client === "codex" ? new CodexRuntimeAdapter({ tmux, fsOps, workerLauncher: launcher })
    : new ClaudeCodeAdapter({ tmux, fsOps, workerLauncher: launcher });
  const node: NodeBinding = { id: "binding", nodeId: "member", cwd: "/work", tmuxSession: "session",
    launchPosture: "floor", permissionMode: "acceptEdits", codexConfigProfile: "personal", managedAttempt: attempt };
  const launch = () => adapter.launchHarness(node, { name: "member" });
  return { root, client, context, attempt, p, observation, control, events, launcher, adapter, node, fsOps, tmux, launch, setNow: (value: number) => { now = value; } };
}

function nextProjection(f: ReturnType<typeof fixture>, attemptId = "attempt-2") {
  const { generatedHash, protocolVersion, workerDiscoveryRoots, ...input } = f.context;
  const root = join(input.projection.policy.paths.context_root, input.projection.worker, input.runId, attemptId);
  const files = input.files.map(({ workerPath, ...file }) => ({ ...file, path: join(root, file.kind) }));
  const context = projectContext({ ...input, projection: { ...input.projection, attemptId }, root, discoveryRoots: [root], files },
    new Map(files.map((file, index) => [file.path, readFileSync(input.files[index]!.path)])));
  const observed = { discoveryRoots: [...context.workerDiscoveryRoots], files: context.files.map(({ workerPath, hash }) => ({ path: workerPath, hash })) };
  f.context = context; f.attempt.context = context; f.p.assignment.context = context;
  f.p.assignment.observed = structuredClone(observed); f.observation.context = structuredClone(observed);
  f.observation.boundary.mounts.find(m => m.target === "/context")!.source = root;
}

describe.each(["claude-code", "codex"] as const)("%s restricted native session", client => {
  it("preserves the revision-4 launcher entry without the new supervision flag", async () => {
    const f = fixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    const command = vi.mocked(f.control.start).mock.calls[0]![0];
    expect(command.args.slice(0, 4)).toEqual(["-n", "--", "/usr/local/libexec/multi-agent/worker-launch", "--worker"]);
    expect(command.args).not.toContain("--supervise");
  });

  it("confirms worker quiescence before reporting an initial boundary fault", async () => {
    const f = fixture(client);
    f.observation.boundary.uid = f.p.control.uid;
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_worker_boundary_mismatch") });
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
    expect(f.control.quiesce).toHaveBeenCalledWith(expect.objectContaining({
      command: vi.mocked(f.control.start).mock.calls[0]![0], identity: f.observation.identity,
      processGroupId: 4100, causeCode: "managed_worker_boundary_mismatch",
    }));
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", causeCode: "managed_worker_boundary_mismatch",
      quiescence: { status: "terminated", processGroupId: 4100, evidenceRef: "evidence/worker-quiescence" } });
  });

  it.each(["observe", "output", "observed-record"] as const)("quiesces after initial %s failure", async failure => {
    const f = fixture(client);
    if (failure === "observe") vi.mocked(f.control.observe).mockRejectedValue(new Error("FIXTURE_SECRET"));
    if (failure === "output") f.observation.output.evidenceRef = "";
    if (failure === "observed-record") vi.mocked(f.control.record).mockImplementation(async event => {
      if (event.phase === "observed") throw new Error("FIXTURE_SECRET");
      f.events.push(structuredClone(event));
    });
    const result = await f.launch();
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect(JSON.stringify(result)).not.toContain("FIXTURE_SECRET");
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", quiescence: { status: "terminated" } });
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false });
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
  });

  it.each(["boundary", "network", "observe", "identity", "process-group", "context"] as const)("quiesces a ready worker after %s drift", async failure => {
    const f = fixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    if (failure === "boundary") f.observation.boundary.uid = f.p.control.uid;
    if (failure === "network") f.observation.boundary.networkNamespace = f.p.network.hostNamespace;
    if (failure === "observe") vi.mocked(f.control.observe).mockRejectedValue(new Error("observation unavailable"));
    if (failure === "identity") f.observation.identity.processStart = "reused-pid";
    if (failure === "process-group") f.observation.processGroupId = 9999;
    if (failure === "context") f.observation.context.files[0]!.hash = hashBytes("drift");
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false });
    expect(f.control.quiesce).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ processId: 4100, processStart: "100" }), processGroupId: 4100,
    }));
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", quiescence: { status: "terminated", processGroupId: 4100 } });
  });

  it.each(["throws", "invalid-identity"] as const)("locates an ambiguous start by immutable command when start %s", async failure => {
    const f = fixture(client), start = vi.mocked(f.control.start).getMockImplementation()!;
    vi.mocked(f.control.start).mockImplementation(async command => {
      const identity = await start(command);
      if (failure === "throws") throw new Error("start acknowledgement lost");
      return { ...identity, processStart: "" };
    });
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_launch_unverified") });
    const request = vi.mocked(f.control.quiesce).mock.calls[0]![0];
    expect(request.command).toBe(vi.mocked(f.control.start).mock.calls[0]![0]);
    expect(Object.isFrozen(request)).toBe(true);
    expect(request.identity).toBeUndefined();
    expect(request.processGroupId).toBeUndefined();
    expect(f.events.at(-1)).toMatchObject({ quiescence: { status: "terminated", identity: { processStart: "100" } } });
  });

  it("accepts authenticated absence of start effects after a rejected start", async () => {
    const f = fixture(client);
    vi.mocked(f.control.start).mockRejectedValue(new Error("start rejected before execution"));
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_launch_unverified") });
    expect(f.events.at(-1)).toMatchObject({ code: "managed_launch_unverified", quiescence: { status: "not_started" } });
  });

  it.each(["policy", "generation"] as const)("rejects an ambiguous-start quiescence receipt with the wrong %s", async field => {
    const f = fixture(client), start = vi.mocked(f.control.start).getMockImplementation()!;
    vi.mocked(f.control.start).mockImplementation(async command => { await start(command); throw new Error("acknowledgement lost"); });
    const quiesce = vi.mocked(f.control.quiesce).getMockImplementation()!;
    vi.mocked(f.control.quiesce).mockImplementation(async request => {
      const receipt = structuredClone(await quiesce(request));
      if (field === "policy") receipt.identity!.policyFingerprint = hashBytes("other policy");
      else receipt.identity!.generation++;
      return receipt;
    });
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_quiescence_unconfirmed") });
    expect(f.events.at(-1)).toMatchObject({ code: "managed_quiescence_unconfirmed", causeCode: "managed_launch_unverified" });
    expect(f.events.at(-1)!.quiescence).toBeUndefined();
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.control.quiesce).mock.calls[0]![0].identity).toBeUndefined();
  });

  it("never targets the process group from an identity-mismatched observation", async () => {
    const f = fixture(client);
    vi.mocked(f.control.observe).mockImplementation(async () => ({ ...structuredClone(f.observation),
      identity: { ...f.observation.identity, processId: 9999, processStart: "unrelated-process" }, processGroupId: 9999 }));
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_identity_mismatch") });
    expect(f.control.quiesce).toHaveBeenCalledWith(expect.objectContaining({ identity: f.observation.identity }));
    expect(vi.mocked(f.control.quiesce).mock.calls[0]![0].processGroupId).toBeUndefined();
    expect(f.events.at(-1)).toMatchObject({ code: "managed_identity_mismatch", quiescence: { processGroupId: 4100 } });
  });

  it.each(["launch", "readiness"] as const)("awaits quiescence before completing a failed %s", async phase => {
    const f = fixture(client);
    if (phase === "readiness") expect(await f.launch()).toMatchObject({ ok: true });
    f.observation.boundary.uid = f.p.control.uid;
    const quiesce = vi.mocked(f.control.quiesce).getMockImplementation()!;
    let confirm!: () => void;
    let reentered: ReturnType<typeof f.adapter.checkReady> | undefined;
    let reentrySettled = false;
    vi.mocked(f.control.quiesce).mockImplementation(async request => {
      reentered = f.adapter.checkReady(f.node).then(result => { reentrySettled = true; return result; });
      await new Promise<void>(resolve => { confirm = resolve; });
      return quiesce(request);
    });
    let settled = false;
    const pending = (phase === "launch" ? f.launch() : f.adapter.checkReady(f.node)).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(f.control.quiesce).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(reentrySettled).toBe(false);
    expect(f.events.some(event => event.phase === "blocked")).toBe(false);
    confirm();
    expect(await pending).toMatchObject(phase === "launch" ? { ok: false } : { ready: false });
    expect(await reentered).toMatchObject({ ready: false, code: "managed_worker_boundary_mismatch" });
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", quiescence: { status: "terminated" } });
  });

  it.each(["launch", "readiness"] as const)("exposes invalid or failed quiescence after %s", async phase => {
    for (const failure of ["reject", "command", "pid", "start", "group", "not-started", "evidence", "status"] as const) {
      const f = fixture(client);
      if (phase === "readiness") expect(await f.launch()).toMatchObject({ ok: true });
      f.observation.boundary.uid = f.p.control.uid;
      const quiesce = vi.mocked(f.control.quiesce).getMockImplementation()!;
      vi.mocked(f.control.quiesce).mockImplementation(async request => {
        if (failure === "reject") throw new Error("FIXTURE_SECRET");
        const receipt = structuredClone(await quiesce(request));
        if (failure === "command") receipt.command = { ...receipt.command, attemptId: "other-attempt" };
        if (failure === "pid") receipt.identity!.processId++;
        if (failure === "start") receipt.identity!.processStart = "reused-pid";
        if (failure === "group") receipt.processGroupId = 9999;
        if (failure === "not-started") { receipt.status = "not_started"; delete receipt.identity; delete receipt.processGroupId; }
        if (failure === "evidence") receipt.evidenceRef = "";
        if (failure === "status") receipt.status = "running" as WorkerQuiescenceReceipt["status"];
        return receipt;
      });
      const result = phase === "launch" ? await f.launch() : await f.adapter.checkReady(f.node);
      expect(result).toMatchObject(phase === "launch"
        ? { ok: false, error: expect.stringContaining("managed_quiescence_unconfirmed"), recovery: "attention_required" }
        : { ready: false, code: "managed_quiescence_unconfirmed", reason: expect.stringContaining("managed_worker_boundary_mismatch") });
      expect(JSON.stringify(result)).not.toContain("FIXTURE_SECRET");
      expect(f.events.at(-1)).toMatchObject({ phase: "blocked", code: "managed_quiescence_unconfirmed", causeCode: "managed_worker_boundary_mismatch" });
      expect(f.events.at(-1)!.quiescence).toBeUndefined();
      expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false, code: "managed_quiescence_unconfirmed" });
      expect(f.control.quiesce).toHaveBeenCalledTimes(1);
    }
  });

  it.each([false, true])("preserves the original fault and shutdown status when blocked evidence fails (shutdown failure: %s)", async shutdownFails => {
    const f = fixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    f.observation.readiness = "prompt";
    if (shutdownFails) vi.mocked(f.control.quiesce).mockRejectedValue(new Error("FIXTURE_SECRET"));
    vi.mocked(f.control.record).mockRejectedValue(new Error("FIXTURE_SECRET"));
    const result = await f.adapter.checkReady(f.node);
    expect(result).toMatchObject({ ready: false, code: shutdownFails ? "managed_quiescence_unconfirmed" : "managed_evidence_persistence_failed",
      reason: expect.stringContaining("managed_native_prompt; managed_evidence_persistence_failed") });
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("FIXTURE_SECRET");
  });

  it("accepts confirmed quarantine without clearing the original block", async () => {
    const f = fixture(client), quiesce = vi.mocked(f.control.quiesce).getMockImplementation()!;
    vi.mocked(f.control.quiesce).mockImplementation(async request => ({ ...await quiesce(request), status: "quarantined" }));
    f.observation.readiness = "prompt";
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_native_prompt") });
    expect(f.events.at(-1)).toMatchObject({ code: "managed_native_prompt", quiescence: { status: "quarantined" } });
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false, code: "managed_native_prompt" });
  });

  it("launches through the privileged worker boundary with recorded identity, deadline and launcher-only mode", async () => {
    const f = fixture(client), personal = join(f.root, "home", "personal-config");
    writeFileSync(personal, "unchanged configuration");
    const result = await f.launch();
    expect(result).toMatchObject({ ok: true, resumeToken: "native-session", managedSession: {
      attemptId: "attempt-1", runId: "run", client, contextHash: f.context.generatedHash, workerUid: f.context.workerUid, deadline: 61000,
      network: { namespace: "net:[200]", profileFingerprint: f.p.network.profileFingerprint, preflightRef: "evidence/u1-network-preflight" },
    } });
    const command = vi.mocked(f.control.start).mock.calls[0]![0];
    expect(command).toMatchObject({ file: "/usr/bin/sudo", attemptId: "attempt-1", deadline: 61000, contextHash: f.context.generatedHash });
    expect(command.network).toEqual(f.p.network);
    expect(f.events[0]!.network).toEqual(f.p.network);
    expect(command.args.slice(0, 3)).toEqual(["-n", "--", "/usr/local/libexec/multi-agent/worker-launch"]);
    expect(command.nativeArgv).toEqual(client === "codex"
      ? [f.p.executable, "-a", "never", "-s", "danger-full-access", "-c", "check_for_update_on_startup=false",
        "-c", 'model_catalog_json="/opt/multi-agent/toolchain/clients/codex-model-catalog.json"']
      : [f.p.executable, "--permission-mode", "bypassPermissions", "--session-id", "native-session"]);
    expect(Object.isFrozen(command.args)).toBe(true);
    expect(f.events.map(e => e.phase)).toEqual(["prepared", "observed"]);
    expect(await f.adapter.checkReady(f.node)).toEqual({ ready: true });
    expect(f.fsOps.writeFile).not.toHaveBeenCalled();
    expect(readFileSync(personal, "utf8")).toBe("unchanged configuration");
  });

  it.each(["signed_out", "unknown", "wrong_home"] as const)("blocks provider %s before native execution", async status => {
    const f = fixture(client);
    if (status === "wrong_home") f.p.provider.home = "/home/owner";
    else f.p.provider.status = status;
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_provider_signin_required") });
    expect(f.control.start).not.toHaveBeenCalled();
    expect(f.control.quiesce).not.toHaveBeenCalled();
    expect(f.fsOps.writeFile).not.toHaveBeenCalled();
  });

  it.each(["unknown", "unsupported", "starting"] as const)("fails closed on %s readiness even with ready-looking terminal text", async status => {
    const f = fixture(client); f.observation.readiness = status;
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_readiness_unknown") });
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false });
  });

  it.each(["trust", "login", "update", "permission"] as const)("blocks a residual %s prompt without typing into it", async kind => {
    const f = fixture(client);
    const screens = {
      trust: "Accessing workspace:\nYes, I trust this folder",
      login: "Please sign in to continue",
      update: "Update available",
      permission: "Allow this command? Requires approval",
    };
    f.observation.screen = screens[kind];
    f.observation.readiness = "prompt";
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_native_prompt") });
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", code: "managed_native_prompt" });
    expect(f.fsOps.writeFile).not.toHaveBeenCalled();
  });

  const recognizedPrompts = client === "codex" ? [
    ["trust", "Do you trust the contents of this directory?\nYes, continue"],
    ["auth", "Your access token could not be refreshed. Please sign in again."],
    ["update", "Update available!"],
    ["permission", "Allow this command? Requires approval"],
  ] : [
    ["trust", "Accessing workspace:\nYes, I trust this folder"],
    ["login", "Not logged in\nRun /login"],
    ["permission", "Allow this command? Requires approval"],
    ["consent", "Running in Bypass Permissions mode.\n❯ No, exit\nYes, I accept\nEnter to confirm · Esc to cancel"],
  ];
  it.each(recognizedPrompts)("blocks a recognized %s screen despite ready transport metadata", async (_kind, screen) => {
    const f = fixture(client);
    f.observation.screen = screen!;
    expect(f.observation.readiness).toBe("ready");
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_native_prompt") });
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", code: "managed_native_prompt" });
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false, code: "managed_native_prompt" });
    expect(f.fsOps.writeFile).not.toHaveBeenCalled();
  });

  it.each(["uid", "groups", "namespace", "home", "config", "tree", "framework", "control-mount", "directory-fd", "extra-fd"] as const)(
    "blocks an observed boundary mismatch: %s", async kind => {
      const f = fixture(client), b = f.observation.boundary;
      if (kind === "uid") b.uid = f.p.control.uid;
      if (kind === "groups") b.groups.push(0);
      if (kind === "namespace") b.mountNamespace = f.p.control.mountNamespace;
      if (kind === "home") b.home = "/home/owner";
      if (kind === "config") b.configHome = "/home/owner/.codex";
      if (kind === "tree") b.mounts[2]!.access = "ro";
      if (kind === "framework") b.mounts[3]!.access = "rw";
      if (kind === "control-mount") b.mounts.push({ source: "/var/lib/multi-agent/control", target: "/control", access: "ro" });
      if (kind === "directory-fd") b.inheritedDescriptors[0]!.kind = "directory";
      if (kind === "extra-fd") b.inheritedDescriptors.push({ fd: 9, kind: "socket" });
      expect(await f.launch()).toMatchObject({ ok: false });
    });

  it.each(["attempt", "pid", "start", "native-session", "generation", "policy", "argv", "source", "mode"] as const)(
    "rejects mismatched process/session evidence: %s", async kind => {
      const f = fixture(client);
      vi.mocked(f.control.observe).mockImplementation(async () => {
        const o = structuredClone(f.observation);
        if (kind === "attempt") o.attemptId = "different-attempt";
        if (kind === "pid") o.identity.processId++;
        if (kind === "start") o.identity.processStart = "reused-pid";
        if (kind === "native-session") o.identity.nativeSessionId = "different-session";
        if (kind === "generation") o.identity.generation++;
        if (kind === "policy") o.identity.policyFingerprint = hashBytes("changed policy");
        if (kind === "argv") o.nativeArgv.push("--unsafe-override");
        if (kind === "source") o.sessionSource = "terminal_text" as "exec";
        if (kind === "mode") o.effectiveMode = client === "codex" ? { approvalPolicy: "on-request", sandbox: "workspace-write" } : { permissionMode: "default" };
        return o;
      });
      expect(await f.launch()).toMatchObject({ ok: false });
    });

  if (client === "codex") {
    it.each([
      ["approval", { approvalPolicy: "on-request", sandbox: "danger-full-access" }],
      ["sandbox", { approvalPolicy: "never", sandbox: "workspace-write" }],
    ] as const)("rejects an independent Codex %s mismatch on launch and later readiness", async (_kind, mode) => {
      const initial = fixture(client);
      initial.observation.effectiveMode = { ...mode };
      expect(await initial.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_launch_mode_mismatch") });
      expect(initial.events.at(-1)).toMatchObject({ phase: "blocked", code: "managed_launch_mode_mismatch" });

      const later = fixture(client);
      expect(await later.launch()).toMatchObject({ ok: true });
      later.observation.effectiveMode = { ...mode };
      expect(await later.adapter.checkReady(later.node)).toMatchObject({ ready: false, code: "managed_launch_mode_mismatch" });
      expect(later.events.at(-1)).toMatchObject({ phase: "blocked", code: "managed_launch_mode_mismatch" });
      expect(later.control.start).toHaveBeenCalledTimes(1);
    });
  }

  it.each(["path", "hash"] as const)("accepts equivalent context ordering but rejects changed %s", async field => {
    const f = fixture(client);
    const { generatedHash, protocolVersion, ...input } = f.context;
    const context = createContextManifest({ ...input, discoveryRoots: [input.root, input.frameworkRoot] });
    f.attempt.context = context;
    f.p.assignment.context = context;
    const observed = { discoveryRoots: [...context.workerDiscoveryRoots], files: context.files.map(({ workerPath, hash }) => ({ path: workerPath, hash })) };
    f.p.assignment.observed = structuredClone(observed);
    f.observation.context = structuredClone(observed);
    expect(await f.launch()).toMatchObject({ ok: true });

    f.observation.context.discoveryRoots.reverse();
    f.observation.context.files.reverse();
    expect(await f.adapter.checkReady(f.node)).toEqual({ ready: true });
    expect(f.observation.context.discoveryRoots).toEqual([...observed.discoveryRoots].reverse());
    expect(f.observation.context.files).toEqual([...observed.files].reverse());

    f.observation.context.files[0]![field] = field === "path" ? "/global/AGENTS.md" : hashBytes("changed instructions");
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false });
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked" });
    f.observation.context = structuredClone(observed);
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false });
  });

  it("rechecks context hashes and instruction discovery at native observation", async () => {
    const f = fixture(client);
    f.observation.context.files.push({ path: "/global/AGENTS.md", hash: hashBytes("global instructions") });
    expect(await f.launch()).toMatchObject({ ok: false });
  });

  it("blocks immutable context drift immediately before execution", async () => {
    const f = fixture(client);
    vi.mocked(f.control.record).mockImplementation(async event => {
      if (event.phase === "prepared") {
        const path = f.context.files[0]!.path;
        chmodSync(path, 0o644); writeFileSync(path, "changed context"); chmodSync(path, 0o440);
      }
    });
    expect(await f.launch()).toMatchObject({ ok: false });
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it.each(["/context", "/framework", "/run/multi-agent-egress"])("requires the installed read-only mount at %s", async target => {
    const f = fixture(client);
    f.observation.boundary.mounts = f.observation.boundary.mounts.filter(m => m.target !== target);
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_worker_mount_mismatch") });
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
  });

  it.each(["fresh", "resume"] as const)("refuses out-of-mount discovery before a %s start", async phase => {
    const f = fixture(client);
    if (phase === "resume") {
      const first = await f.launch();
      if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
      f.attempt.previous = first.managedSession; f.attempt.attemptId = "attempt-2"; nextProjection(f);
      f.p.previous = first.managedSession; f.p.generation = 2;
    }
    f.attempt.context = { ...f.context, discoveryRoots: [f.root] };
    expect(await f.adapter.launchHarness(f.node, { name: "member", ...(phase === "resume" ? { resumeToken: "native-session" } : {}) })).toMatchObject({ ok: false });
    expect(f.control.start).toHaveBeenCalledTimes(phase === "resume" ? 1 : 0);
  });

  it("refuses a projection whose policy differs from the installed policy", async () => {
    const f = fixture(client);
    f.p.installedPolicy.paths.context_root += "-other";
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_context_mount_policy_mismatch") });
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it("refuses to reuse an old projection for a new attempt", async () => {
    const f = fixture(client), first = await f.launch();
    if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
    f.p.previous = first.managedSession; f.p.generation = 2;
    const attempt = { ...f.attempt, attemptId: "attempt-2", previous: first.managedSession };
    expect(await f.launcher.launch({ client, attempt, resumeToken: "native-session" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("managed_context_mount_policy_mismatch") });
    expect(f.control.start).toHaveBeenCalledTimes(1);
  });

  it("reuses the same projection hash when the same attempt resumes after restart", async () => {
    const f = fixture(client), first = await f.launch();
    if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
    const attempt = { ...f.attempt, previous: first.managedSession };
    f.p.previous = first.managedSession; f.p.generation = 2; f.observation.identity.generation = 2;
    const resumed = new RestrictedWorkerLauncher(f.control, () => 1000, () => "native-session");
    expect(await resumed.launch({ client, attempt, resumeToken: "native-session" }))
      .toMatchObject({ ok: true, managedSession: { attemptId: "attempt-1", contextHash: f.context.generatedHash } });
  });

  it("resumes the exact control-recorded session through the same boundary", async () => {
    const f = fixture(client), first = await f.launch();
    expect(first.ok).toBe(true);
    if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
    const previous = first.managedSession;
    nextProjection(f);
    const attempt = { ...f.attempt, attemptId: "attempt-2", previous };
    f.p.previous = previous; f.p.generation = 2;
    f.observation.attemptId = attempt.attemptId; f.observation.identity.generation = 2;
    f.observation.identity.processId = 4200; f.observation.identity.processStart = "200";
    const adapter = client === "codex" ? new CodexResumeAdapter(f.tmux, { workerLauncher: f.launcher })
      : new ClaudeResumeAdapter(f.tmux, { workerLauncher: f.launcher });
    const result = client === "codex"
      ? await (adapter as CodexResumeAdapter).resume("session", "codex_id", "native-session", "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, attempt)
      : await (adapter as ClaudeResumeAdapter).resume("session", "claude_id", "native-session", "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, attempt);
    expect(result).toMatchObject({ ok: true, managedSession: { attemptId: "attempt-2", identity: { generation: 2, processId: 4200 } } });
    const command = vi.mocked(f.control.start).mock.calls[1]![0];
    expect(command.nativeArgv.slice(-2)).toEqual(client === "codex" ? ["resume", "native-session"] : ["--resume", "native-session"]);
    // Resume must keep the standard-request catalog, or the resumed model loses its shell tool.
    if (client === "codex") expect(command.nativeArgv).toContain('model_catalog_json="/opt/multi-agent/toolchain/clients/codex-model-catalog.json"');
  });

  it("keeps reviewer trees read-only on fresh launch and exact resume", async () => {
    const f = fixture(client, 4, "reviewer"), first = await f.launch();
    expect(first.ok).toBe(true);
    if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
    expect(await f.adapter.checkReady(f.node)).toEqual({ ready: true });
    f.attempt.previous = first.managedSession; f.attempt.attemptId = "attempt-2"; nextProjection(f);
    f.p.previous = first.managedSession; f.p.generation = 2;
    f.observation.attemptId = "attempt-2"; f.observation.identity.generation = 2;
    expect(await f.adapter.launchHarness(f.node, { name: "member", resumeToken: "native-session" })).toMatchObject({ ok: true });
    expect(await f.adapter.checkReady(f.node)).toEqual({ ready: true });
    expect(f.observation.boundary.mounts.find(m => m.target === "/work")).toMatchObject({ access: "ro" });
    for (const [command] of vi.mocked(f.control.start).mock.calls) {
      expect(command.args.slice(command.args.indexOf("--role"), command.args.indexOf("--role") + 2)).toEqual(["--role", "reviewer"]);
    }
    expect(f.control.start).toHaveBeenCalledTimes(2);
    expect(f.control.quiesce).not.toHaveBeenCalled();
  });

  it.each(["fresh", "resume"] as const)("quiesces a %s reviewer whose observed tree is writable", async phase => {
    const f = fixture(client, 4, "reviewer");
    if (phase === "resume") {
      const first = await f.launch();
      if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
      f.attempt.previous = first.managedSession; f.attempt.attemptId = "attempt-2"; nextProjection(f);
      f.p.previous = first.managedSession; f.p.generation = 2;
      f.observation.attemptId = "attempt-2"; f.observation.identity.generation = 2;
    }
    f.observation.boundary.mounts.find(m => m.target === "/work")!.access = "rw";
    expect(await f.adapter.launchHarness(f.node, { name: "member", ...(phase === "resume" ? { resumeToken: "native-session" } : {}) }))
      .toMatchObject({ ok: false, error: expect.stringContaining("managed_worker_mount_mismatch") });
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
    expect(f.control.quiesce).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({ attemptId: f.attempt.attemptId }), identity: f.observation.identity,
      processGroupId: f.observation.processGroupId, causeCode: "managed_worker_mount_mismatch",
    }));
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", code: "managed_worker_mount_mismatch",
      quiescence: { status: "terminated", identity: f.observation.identity, processGroupId: f.observation.processGroupId } });
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false, code: "managed_worker_mount_mismatch" });
    expect(f.control.start).toHaveBeenCalledTimes(phase === "resume" ? 2 : 1);
  });

  it.each(["deadline", "same-generation", "skipped-generation"] as const)("rejects an independent resume %s violation before another start", async kind => {
    const f = fixture(client), first = await f.launch();
    if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
    f.attempt.previous = first.managedSession; f.attempt.attemptId = "attempt-2"; nextProjection(f);
    f.p.previous = first.managedSession; f.p.generation = 2;
    if (kind === "deadline") f.attempt.deadline = first.managedSession.deadline + 1;
    else f.p.generation = kind === "same-generation" ? 1 : 3;
    f.observation.attemptId = "attempt-2"; f.observation.identity.generation = f.p.generation;
    expect(await f.adapter.launchHarness(f.node, { name: "member", resumeToken: "native-session" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("managed_resume_identity_mismatch") });
    expect(f.control.start).toHaveBeenCalledTimes(1);
    expect(f.control.observe).toHaveBeenCalledTimes(1);
    expect(f.control.quiesce).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", code: "managed_resume_identity_mismatch" });
    expect(f.events.at(-1)!.quiescence).toBeUndefined();
  });

  it("rejects revision-2 host-shared admission before any execution", async () => {
    const f = fixture(client, 2);
    f.p.network.mode = "host-shared";
    f.observation.boundary.networkNamespace = f.p.network.hostNamespace;
    expect(await f.launch()).toMatchObject({ ok: false });
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it.each(["shared", "isolated", "unknown", "missing", "revision", "reference"] as const)("rejects unprovisioned network policy: %s", async kind => {
    const f = fixture(client);
    if (kind === "shared") f.p.network.mode = "host-shared";
    if (kind === "isolated") f.p.network.mode = "isolated-allowlist";
    if (kind === "unknown") f.p.network.mode = "unknown";
    if (kind === "missing") delete (f.p as Partial<typeof f.p>).network;
    if (kind === "revision") { f.p.policyRevision = 2; f.p.installedPolicy.policy_revision = 2; }
    if (kind === "reference") f.p.network.preflightRef = "";
    expect(await f.launch()).toMatchObject({ ok: false });
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it.each(["host", "missing", "profile"] as const)("rejects network namespace/evidence mismatch: %s", async kind => {
    const f = fixture(client), boundary = f.observation.boundary;
    if (kind === "host") boundary.networkNamespace = f.p.network.hostNamespace;
    if (kind === "missing") delete (boundary as Partial<typeof boundary>).networkNamespace;
    if (kind === "profile") boundary.networkProfileFingerprint = hashBytes("unapproved profile");
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_network_boundary_mismatch") });
  });

  it("preserves namespace identity and egress policy on readiness rechecks", async () => {
    const f = fixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    f.observation.boundary.networkNamespace = "net:[201]";
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false, code: "managed_identity_changed" });
    expect(f.control.start).toHaveBeenCalledTimes(1);
  });

  it("blocks a resumed client that returns to the host namespace", async () => {
    const f = fixture(client), first = await f.launch();
    if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
    f.attempt.previous = first.managedSession;
    f.attempt.attemptId = "attempt-2"; nextProjection(f);
    f.p.previous = first.managedSession; f.p.generation = 2;
    f.observation.attemptId = "attempt-2"; f.observation.identity.generation = 2;
    f.observation.boundary.networkNamespace = f.p.network.hostNamespace;
    expect(await f.adapter.launchHarness(f.node, { name: "member", resumeToken: "native-session" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("managed_network_boundary_mismatch") });
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
    expect(f.control.quiesce).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({ attemptId: "attempt-2" }),
      identity: expect.objectContaining({ generation: 2 }), causeCode: "managed_network_boundary_mismatch",
    }));
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", quiescence: { identity: { generation: 2 } } });
  });

  it("rejects an egress-profile change across resume before execution", async () => {
    const f = fixture(client), first = await f.launch();
    if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
    f.attempt.previous = first.managedSession; f.attempt.attemptId = "attempt-2"; nextProjection(f);
    f.p.previous = first.managedSession; f.p.generation = 2;
    f.p.network.profileFingerprint = hashBytes("changed egress profile");
    expect(await f.adapter.launchHarness(f.node, { name: "member", resumeToken: "native-session" })).toMatchObject({ ok: false });
    expect(f.control.start).toHaveBeenCalledTimes(1);
  });

  it("rejects a resume token without the prior control-owned receipt", async () => {
    const f = fixture(client);
    expect(await f.adapter.launchHarness(f.node, { name: "member", resumeToken: "some-session" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("managed_resume_identity_mismatch") });
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it("persists and forwards the same bounded deadline, and refuses expiration before execution", async () => {
    const f = fixture(client);
    vi.mocked(f.control.record).mockImplementation(async event => {
      f.events.push(structuredClone(event));
      if (event.phase === "prepared") f.setNow(f.attempt.deadline);
    });
    expect(await f.launch()).toMatchObject({ ok: false, error: expect.stringContaining("managed_deadline_expired") });
    expect(f.events[0]).toMatchObject({ deadline: f.attempt.deadline, phase: "prepared" });
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it("does not launch when prepared evidence cannot be persisted", async () => {
    const f = fixture(client);
    vi.mocked(f.control.record).mockRejectedValue(new Error("credential=FIXTURE_SECRET"));
    const result = await f.launch();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("FIXTURE_SECRET");
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it("redacts and bounds shared output while retaining its evidence reference", async () => {
    const f = fixture(client);
    f.observation.output.text = "FIXTURE_SECRET Authorization: Bearer another-token api_key=secret password: hidden https://user:pass@fixture.test " + "x".repeat(20000);
    expect(await f.launch()).toMatchObject({ ok: true });
    const output = f.events.at(-1)!.output!;
    expect(output).toMatchObject({ truncated: true, evidenceRef: "evidence/native-output" });
    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(8192);
    for (const secret of ["FIXTURE_SECRET", "another-token", "secret", "hidden", "user:pass"]) expect(output.text).not.toContain(secret);
  });

  it.each(["FIXTURE_\u001b[0mSECRET", "FIXTURE_\u0000SECRET", "api_\u001b[0mkey=UNLISTED_SECRET"])(
    "redacts credentials reconstructed by terminal sanitization: %j", async text => {
      const f = fixture(client);
      f.observation.output.text = text;
      expect(await f.launch()).toMatchObject({ ok: true });
      const output = f.events.at(-1)!.output!;
      expect(output.text).toContain("[redacted]");
      expect(output.text).not.toContain("FIXTURE_SECRET");
      expect(output.text).not.toContain("UNLISTED_SECRET");
      expect(output.evidenceRef).toBe("evidence/native-output");
    });
  it("classifies managed readiness faults as attention-required after a healthy launch", async () => {
    const f = fixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    f.observation.screen = "Allow this command? Requires approval";
    const result = await f.adapter.checkReady(f.node);
    expect(result).toMatchObject({ ready: false, code: "managed_native_prompt" });
    expect(isAttentionRequiredReadinessCode(result.code)).toBe(true);
    expect(isAttentionRequiredReadinessCode("managed_identity_changed")).toBe(true);
    expect(isAttentionRequiredReadinessCode("managed_launch_unavailable")).toBe(true);
    expect(isAttentionRequiredReadinessCode(undefined)).toBe(false);
    expect(isAttentionRequiredReadinessCode("starting")).toBe(false);
  });

  it("keeps overlapping readiness checks blocked after the first prompt fault", async () => {
    const f = fixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    let resolvePrompt!: (value: WorkerObservation) => void;
    let resolveHealthy!: (value: WorkerObservation) => void;
    vi.mocked(f.control.observe)
      .mockReturnValueOnce(new Promise<WorkerObservation>(resolve => { resolvePrompt = resolve; }))
      .mockReturnValueOnce(new Promise<WorkerObservation>(resolve => { resolveHealthy = resolve; }));
    const first = f.adapter.checkReady(f.node);
    const second = f.adapter.checkReady(f.node);
    const quiesce = vi.mocked(f.control.quiesce).getMockImplementation()!;
    let confirm!: () => void;
    vi.mocked(f.control.quiesce).mockImplementation(async request => {
      await new Promise<void>(resolve => { confirm = resolve; });
      return quiesce(request);
    });
    const settled: string[] = [];
    void first.then(() => { settled.push("first"); });
    void second.then(() => { settled.push("second"); });
    const prompt = structuredClone(f.observation);
    prompt.readiness = "prompt";
    resolvePrompt(prompt);
    await vi.waitFor(() => expect(f.control.quiesce).toHaveBeenCalledTimes(1));
    resolveHealthy(structuredClone(f.observation));
    const third = f.adapter.checkReady(f.node);
    void third.then(() => { settled.push("third"); });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toEqual([]);
    confirm();
    for (const result of await Promise.all([first, second, third])) expect(result).toMatchObject({ ready: false, code: "managed_native_prompt" });
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
    expect(f.control.start).toHaveBeenCalledTimes(1);
  });

  it("blocks later prompt or identity drift without retrying the native command", async () => {
    const f = fixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    f.observation.readiness = "prompt";
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false, code: "managed_native_prompt" });
    f.observation.readiness = "ready";
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false });
    expect(f.control.start).toHaveBeenCalledTimes(1);
  });

  it("does not start the same attempt twice, including concurrent requests", async () => {
    const f = fixture(client);
    const results = await Promise.all([f.launch(), f.launch()]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(f.control.start).toHaveBeenCalledTimes(1);
  });

  it("rejects managed forks rather than selecting an implicit resume session", async () => {
    const f = fixture(client);
    expect(await f.adapter.launchHarness(f.node, { name: "member", forkSource: { kind: "last" } })).toMatchObject({ ok: false });
    expect(f.control.start).not.toHaveBeenCalled();
  });
});

async function fixedPolicyFixture(client: WorkerClient) {
  const f = fixture(client), nativePolicy = await buildManagedNativePolicy(client, f.p.installedPolicy.paths.toolchain_dir);
  const { generatedHash: _hash, protocolVersion: _protocol, workerDiscoveryRoots: _roots, ...input } = f.context;
  const root = join(input.projection.policy.paths.context_root, input.projection.worker, input.runId, "native-attempt");
  const files = input.files.map(({ workerPath: _worker, ...file }) => ({ ...file, path: join(root, file.kind) }));
  const binding = { ...input.binding, policyRevision: 5 };
  const context = projectContext({ ...input, binding, root, nativePolicy, files, discoveryRoots: [root],
    projection: { ...input.projection, attemptId: "native-attempt", policy: { ...input.projection.policy, policy_revision: 5 } } },
  new Map(files.map((file, index) => [file.path, readFileSync(input.files[index]!.path)])));
  f.context = context; f.attempt.context = context; f.attempt.attemptId = "native-attempt"; f.observation.attemptId = "native-attempt";
  f.p.assignment = { ...f.p.assignment, binding, currentBinding: binding, context,
    observed: { discoveryRoots: context.workerDiscoveryRoots, files: context.files.map(file => ({ path: file.workerPath, hash: file.hash })) } };
  f.observation.context = structuredClone(f.p.assignment.observed);
  f.observation.boundary.mounts.find(m => m.target === "/context")!.source = root;
  f.p.policyRevision = 5; f.p.installedPolicy.policy_revision = 5;
  f.p.control.gid = process.getgid!();
  f.p.installedPolicy.paths.control_state_dir = join(f.root, "control");
  f.p.installedPolicy.paths.mailbox_root = join(f.root, "control", "mailboxes");
  f.p.installedPolicy.sandbox.mailbox = "/run/multi-agent/mailbox.sock";
  f.p.installedPolicy.sandbox.native_policy_mounts = {
    "claude-code": { source: "native/claude/managed-settings.json", target: "/etc/claude-code/managed-settings.json" },
    codex: { source: "native/codex/requirements.toml", target: "/etc/codex/requirements.toml" },
  };
  f.p.nativePolicy = nativePolicy;
  f.p.mailbox = { path: join(f.p.installedPolicy.paths.mailbox_root, "ma-worker1", "run", "native-attempt", "mailbox.sock"),
    uid: f.p.control.uid, gid: f.p.control.gid, dev: 1, ino: 42, generation: "endpoint-generation" };
  f.observation.mailbox = { uid: f.p.mailbox.uid, gid: f.p.mailbox.gid, dev: f.p.mailbox.dev, ino: f.p.mailbox.ino };
  f.observation.nativePolicy = { files: nativePolicy.files.map(file => ({ path: file.workerPath, hash: file.hash })),
    aliases: nativePolicy.aliases.map(alias => ({ path: alias.target, hash: nativePolicy.files.find(file => file.workerPath === alias.source)!.hash })),
    inventory: { selectedSource: nativePolicy.selectedSource, managedDropIns: "absent", remotePolicy: "absent",
      platformPolicy: "not-applicable", nativeExceptions: "absent" } };
  f.observation.boundary.mounts.push(
    { source: f.p.mailbox.path, target: "/run/multi-agent/mailbox.sock", access: "ro" },
    { source: "tmpfs", target: "/run/multi-agent", access: "ro" },
    { source: "tmpfs", target: client === "codex" ? "/etc/codex" : "/etc/claude-code", access: "ro" },
    { source: "tmpfs", target: "/home/worker/.multi-agent/mailbox", access: "rw" },
    { source: "tmpfs", target: "/home/worker/.multi-agent/mailbox/bootstrap.json", access: "ro" },
    ...nativePolicy.aliases.map(alias => ({ source: root + alias.source.slice("/context".length), target: alias.target, access: "ro" as const })),
  );
  return f;
}

describe.each(["claude-code", "codex"] as const)("%s fixed policy launch boundary", client => {
  it("uses the supervised launcher entry for a fresh revision-5 session", async () => {
    const f = await fixedPolicyFixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    const command = vi.mocked(f.control.start).mock.calls[0]![0];
    expect(command.args.slice(0, 4)).toEqual(["-n", "--", "/usr/local/libexec/multi-agent/worker-launch", "--supervise"]);
    expect(command.args.filter(arg => arg === "--supervise")).toHaveLength(1);
    expect(command.nativeArgv).not.toContain("--supervise");
  });

  it("keeps the supervised entry on exact resume after launcher reconstruction", async () => {
    const f = await fixedPolicyFixture(client), first = await f.launch();
    if (!first.ok || !first.managedSession) throw new Error("Fixture launch failed");
    const previous = first.managedSession, attempt = { ...f.attempt, previous };
    f.p.previous = previous; f.p.generation = 2;
    f.observation.identity = { ...f.observation.identity, generation: 2, processId: 4200, processStart: "200" };
    f.observation.processGroupId = 4200;
    const launcher = new RestrictedWorkerLauncher(f.control, () => 1000);
    const adapter = client === "codex" ? new CodexResumeAdapter(f.tmux, { workerLauncher: launcher })
      : new ClaudeResumeAdapter(f.tmux, { workerLauncher: launcher });
    const result = client === "codex"
      ? await (adapter as CodexResumeAdapter).resume("session", "codex_id", "native-session", "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, attempt)
      : await (adapter as ClaudeResumeAdapter).resume("session", "claude_id", "native-session", "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, attempt);
    expect(result).toMatchObject({ ok: true, managedSession: { identity: { generation: 2, nativeSessionId: previous.identity.nativeSessionId } } });
    const command = vi.mocked(f.control.start).mock.calls[1]![0];
    expect(command.args.slice(0, 4)).toEqual(["-n", "--", "/usr/local/libexec/multi-agent/worker-launch", "--supervise"]);
    expect(command.args.filter(arg => arg === "--supervise")).toHaveLength(1);
    expect(command.nativeArgv).not.toContain("--supervise");
  });

  it("forwards only the registered descriptor identity and records verified effective native policy", async () => {
    const f = await fixedPolicyFixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    const command = vi.mocked(f.control.start).mock.calls[0]![0];
    const index = command.args.indexOf("--mailbox");
    expect(command.args.slice(index, index + 2)).toEqual(["--mailbox", "1:42"]);
    expect(command.args).not.toContain(f.p.mailbox!.path);
    expect(f.events.at(-1)?.nativePolicy).toEqual({ installedDigest: f.p.nativePolicy!.digest, observedDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(await f.adapter.checkReady(f.node)).toEqual({ ready: true });
  });

  it.each(["missing", "foreign-path", "owner", "generation", "inode"] as const)("blocks %s mailbox preflight before execution", async field => {
    const f = await fixedPolicyFixture(client);
    if (field === "missing") f.p.mailbox = undefined;
    else if (field === "foreign-path") f.p.mailbox = { ...f.p.mailbox!, path: f.p.mailbox!.path.replace("ma-worker1", "ma-worker2") };
    else if (field === "owner") f.p.mailbox = { ...f.p.mailbox!, uid: f.p.worker.uid };
    else if (field === "generation") f.p.mailbox = { ...f.p.mailbox!, generation: "" };
    else f.p.mailbox = { ...f.p.mailbox!, ino: Number.NaN };
    expect(await f.launch()).toMatchObject({ ok: false });
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it.each(["missing", "context", "alias", "mailbox-target"] as const)("blocks %s native policy before execution", async field => {
    const f = await fixedPolicyFixture(client);
    if (field === "missing") f.p.nativePolicy = undefined;
    else if (field === "context") f.p.nativePolicy = { ...f.p.nativePolicy!, digest: hashBytes("foreign policy") };
    else if (field === "alias") f.p.installedPolicy.sandbox.native_policy_mounts![client].target = "/etc/foreign-policy";
    else f.p.installedPolicy.sandbox.mailbox = "/run/control.sock";
    expect(await f.launch()).toMatchObject({ ok: false });
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it.each(["socket", "native-policy", "policy-parent", "bootstrap", "inventory", "socket-owner", "missing-policy", "duplicate-alias"] as const)("quiesces a ready attempt after %s evidence drifts", async field => {
    const f = await fixedPolicyFixture(client);
    expect(await f.launch()).toMatchObject({ ok: true });
    if (field === "socket") f.observation.mailbox = { ...f.observation.mailbox!, ino: f.observation.mailbox!.ino + 1 };
    else if (field === "native-policy") f.observation.nativePolicy!.files[0]!.hash = hashBytes("changed handler");
    else if (field === "policy-parent") f.observation.boundary.mounts.find(m => m.target === (client === "codex" ? "/etc/codex" : "/etc/claude-code"))!.access = "rw";
    else if (field === "bootstrap") f.observation.boundary.mounts = f.observation.boundary.mounts.filter(m => !m.target.endsWith("/bootstrap.json"));
    else if (field === "inventory") f.observation.nativePolicy!.inventory.remotePolicy = "unknown";
    else if (field === "socket-owner") f.observation.mailbox = { ...f.observation.mailbox!, gid: f.observation.mailbox!.gid + 1 };
    else if (field === "missing-policy") f.observation.nativePolicy = undefined;
    else f.observation.boundary.mounts.push({ ...f.observation.boundary.mounts.at(-1)! });
    expect(await f.adapter.checkReady(f.node)).toMatchObject({ ready: false });
    expect(f.control.quiesce).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toMatchObject({ phase: "blocked", quiescence: { status: "terminated" } });
  });
});
