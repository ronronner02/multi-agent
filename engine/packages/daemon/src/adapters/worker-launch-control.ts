import { execFile } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import type Database from "better-sqlite3";
import { canonicalJson, parsePlanBinding } from "../contracts/team-control.js";
import { hashBinding, hashBytes, type PlanGovernance } from "../domain/plan-governance.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import { listNativeProcesses, type NativeProcessRow } from "../domain/native-process-lineage.js";
import { immutable, within, type ContextManifest } from "../integrations/framework/context-manifest.js";
import { resolveTeamControlCredential } from "../middleware/auth-bearer-token.js";
import type { TeamControlOptions } from "../routes/team-control.js";
import type { ClientLockObservation, WorkerCommand, WorkerLaunchInput, WorkerLaunchPolicy } from "./worker-launch.js";
import type { WorkerMailboxBridge } from "./worker-mailbox-bridge.js";
import type { TmuxAdapter } from "./tmux.js";

interface ManagedWorkerScopeDependencies {
  db: Database.Database;
  governance: PlanGovernance;
  queue: QueueRepository;
  options: TeamControlOptions;
  legacyTokens?: readonly (string | null | undefined)[];
}

/** Resolves existing authority records; this does not reserve or authorize a process effect. */
export function resolveManagedWorkerScope(
  context: Pick<ContextManifest, "runId" | "binding" | "assignment" | "role" | "client">,
  { db, governance, queue, options, legacyTokens = [] }: ManagedWorkerScopeDependencies,
) {
  try {
    if (queue.db !== db || !options.resolveBinding || !["claude-code", "codex"].includes(context.client)) throw new Error();
    const run = governance.getRun(context.runId), currentBinding = parsePlanBinding(options.resolveBinding(run));
    if (run.state !== "approved" || hashBinding(context.binding) !== run.bindingDigest
      || hashBinding(currentBinding) !== run.bindingDigest) throw new Error();
    // The plan's task identifier is not the queue primary key. Resolve the persisted association before using its owner.
    const rows = db.prepare("SELECT qitem_id AS qitemId FROM team_queue_authority WHERE run_id = ? AND task_id = ? LIMIT 2")
      .all(run.id, context.assignment.taskId) as { qitemId: string }[];
    if (rows.length !== 1) throw new Error();
    const task = governance.getTask(rows[0]!.qitemId), item = queue.getById(rows[0]!.qitemId);
    if (!task || !item || task.runId !== run.id || canonicalJson(task.assignment) !== canonicalJson(context.assignment)
      || task.assignment.role !== context.role || !["pending", "in-progress"].includes(item.state)) throw new Error();
    const credential = options.credentials.workers?.find(worker => worker.sessionId === item.destinationSession && worker.runId === run.id);
    const auth = resolveTeamControlCredential(credential ? "Bearer " + credential.token : undefined, options.credentials, legacyTokens);
    if (!auth.ok || auth.actor.kind !== "worker" || auth.actor.sessionId !== item.destinationSession || auth.runId !== run.id) throw new Error();
    return immutable({ run, task, sessionId: item.destinationSession, currentBinding });
  } catch {
    throw new Error("managed_launch_scope_unverified");
  }
}


/** Uses the persisted seat owners; neither a worker name nor a context path selects a worktree. */
export function resolveManagedWorkerSeat(
  context: Parameters<typeof resolveManagedWorkerScope>[0],
  dependencies: ManagedWorkerScopeDependencies & {
    rigRepo: Pick<RigRepository, "db" | "getRig">;
    sessions: Pick<SessionRegistry, "db" | "findResumeContextByName" | "getLatestLiveSessions">;
  },
) {
  try {
    const scope = resolveManagedWorkerScope(context, dependencies);
    const { db, rigRepo, sessions } = dependencies;
    if (rigRepo.db !== db || sessions.db !== db) throw new Error();
    const session = sessions.findResumeContextByName(scope.sessionId);
    const live = sessions.getLatestLiveSessions(scope.run.rigId)
      .filter(row => row.sessionName === scope.sessionId);
    const rig = rigRepo.getRig(scope.run.rigId);
    const node = rig?.nodes.find(row => row.id === session?.nodeId);
    if (!session || session.rigId !== scope.run.rigId || session.runtime !== context.client
      || live.length !== 1 || live[0]!.sessionId !== session.sessionId
      || !node || node.runtime !== context.client || live[0]!.nodeId !== node.id
      || !node.cwd || posix.resolve(node.cwd) !== node.cwd || realpathSync(node.cwd) !== node.cwd
      || !node.binding || node.binding.attachmentType !== "tmux"
      || node.binding.tmuxSession !== scope.sessionId || !/^%[0-9]+$/.test(node.binding.tmuxPane ?? "")) throw new Error();
    return immutable({ scope, nodeId: node.id, sessionRecordId: session.sessionId,
      tree: node.cwd, pane: node.binding.tmuxPane! });
  } catch { throw new Error("managed_launch_seat_unverified"); }
}

/** Sequences the existing governance transaction before entering the control-owned start transport. */
export async function startManagedWorkerCommand<T>(
  rawInput: WorkerLaunchInput, rawCommand: Readonly<WorkerCommand>,
  dependencies: ManagedWorkerScopeDependencies & {
    start: (command: Readonly<WorkerCommand>, beforeWrite: () => void) => Promise<T>;
    now?: () => number;
  },
): Promise<T> {
  let command: Readonly<WorkerCommand>, beforeWrite: () => void;
  try {
    const input = immutable(structuredClone(rawInput));
    command = immutable(structuredClone(rawCommand));
    const context = input.attempt.context, scope = resolveManagedWorkerScope(context, dependencies);
    const { governance, options, legacyTokens = [] } = dependencies;
    const owner = resolveTeamControlCredential(options.credentials.ownerToken ? "Bearer " + options.credentials.ownerToken : undefined,
      options.credentials, legacyTokens);
    const serialized = canonicalJson(command);
    const secrets = [options.credentials.ownerToken, ...options.credentials.workers?.map(worker => worker.token) ?? [], ...legacyTokens];
    if (!owner.ok || owner.actor.kind !== "owner" || command.file !== "/usr/bin/sudo"
      || command.attemptId !== input.attempt.attemptId || command.attemptId !== context.projection.attemptId
      || command.contextHash !== context.generatedHash || command.client !== input.client || input.client !== context.client
      || command.deadline !== input.attempt.deadline || !Number.isSafeInteger(command.deadline)
      || command.deadline <= (dependencies.now ?? Date.now)()
      || secrets.some(secret => !!secret && serialized.includes(JSON.stringify(secret).slice(1, -1)))) throw new Error();
    const previousReceipt = input.attempt.previous, previous = previousReceipt ? governance.getAttempt(previousReceipt.attemptId) : null;
    if (previousReceipt && (!previous?.identity || previous.runId !== scope.run.id || previous.qitemId !== scope.task.qitemId
      || previousReceipt.runId !== scope.run.id || previousReceipt.client !== input.client
      || canonicalJson(previous.identity) !== canonicalJson(previousReceipt.identity))) throw new Error();
    const generation = previous?.identity ? previous.identity.generation + 1 : 1;
    const receipt = governance.admitNativeAttempt({ protocolVersion: "1.0", runId: scope.run.id,
      actionId: command.attemptId, expectedEntityVersion: scope.run.entityVersion,
      idempotencyKey: "native-start:" + command.attemptId + ":" + generation,
      payload: { qitemId: scope.task.qitemId, expectedTaskVersion: scope.task.entityVersion, sessionId: scope.sessionId,
        provider: input.client === "codex" ? "codex" : "claude", command: JSON.parse(serialized), commandDigest: hashBytes(serialized),
        previousAttemptId: previous?.id ?? null, expectedPreviousVersion: previous?.entityVersion ?? null } },
    owner.actor, scope.currentBinding);
    if (receipt.status !== "pending-execution" || !receipt.effectMayStart || receipt.replayed) throw new Error();
    // The terminal owner repeats this synchronous check after its awaited lookups, immediately before each write.
    beforeWrite = () => {
      const current = resolveManagedWorkerScope(context, dependencies);
      const currentOwner = resolveTeamControlCredential(options.credentials.ownerToken ? "Bearer " + options.credentials.ownerToken : undefined,
        options.credentials, legacyTokens);
      const intent = governance.getNativeLaunchIntent(scope.run.id, command.attemptId);
      if (!currentOwner.ok || currentOwner.actor.kind !== "owner"
        || current.sessionId !== scope.sessionId || current.task.qitemId !== scope.task.qitemId
        || !intent || intent.state !== "admitted" || intent.qitemId !== current.task.qitemId
        || intent.sessionId !== current.sessionId || intent.taskVersion !== current.task.entityVersion
        || intent.bindingDigest !== current.run.bindingDigest || intent.policyFingerprint !== current.run.binding.policyFingerprint
        || intent.provider !== (input.client === "codex" ? "codex" : "claude") || intent.generation !== generation
        || intent.commandDigest !== hashBytes(serialized) || canonicalJson(intent.command) !== serialized
        || command.deadline <= (dependencies.now ?? Date.now)()) throw new Error("managed_start_authority_denied");
    };
    beforeWrite();
  } catch { throw new Error("managed_start_admission_denied"); }
  try { return await dependencies.start(command, beforeWrite); }
  catch {
    // A transport error is not proof of no-start. Retain the bound unresolved intent for observed cleanup.
    throw new Error("managed_start_unconfirmed");
  }
}

/** Enters the existing terminal owner only after governance commits the command. */
export async function startManagedWorkerInPane(
  input: WorkerLaunchInput, command: Readonly<WorkerCommand>,
  dependencies: ManagedWorkerScopeDependencies & {
    tmux: Pick<TmuxAdapter, "respawnPane">;
    resolvePane: (sessionId: string) => Promise<string>;
    now?: () => number;
  },
): Promise<Readonly<{ pane: string }>> {
  let pane: string;
  try {
    input = immutable(structuredClone(input)); command = immutable(structuredClone(command));
    const scope = resolveManagedWorkerScope(input.attempt.context, dependencies);
    pane = await dependencies.resolvePane(scope.sessionId);
    const current = resolveManagedWorkerScope(input.attempt.context, dependencies);
    if (!/^%[0-9]+$/.test(pane) || current.sessionId !== scope.sessionId || current.task.qitemId !== scope.task.qitemId) throw new Error();
  } catch { throw new Error("managed_start_terminal_unverified"); }
  return startManagedWorkerCommand(input, command, { ...dependencies, start: async (admitted, beforeWrite) => {
    const argv = [admitted.file, ...admitted.args];
    if (argv.some(value => typeof value !== "string" || value.includes("\0"))) throw new Error();
    const line = "exec " + argv.map(value => "'" + value.replace(/'/g, "'\\''") + "'").join(" ");
    const result = await dependencies.tmux.respawnPane(pane, line, { cwd: "/", beforeWrite });
    if (!result.ok) throw new Error();
    return Object.freeze({ pane });
  } });
}

const INSTALLED_POLICY = "/etc/multi-agent/worker-policy.json";
const INSTALLED_LAUNCHER = "/usr/local/libexec/multi-agent/worker-launch";
const INSTALLED_EGRESS = "/etc/multi-agent/egress.json";
type InspectionPolicy = WorkerLaunchPolicy & {
  paths: WorkerLaunchPolicy["paths"] & { worker_root: string; assignment_root: string; installed_policy: string;
    installed_launcher: string; installed_egress_config: string };
  allowed_exec_prefixes: string[];
};
interface InstalledFileFact { path: string; realpath: string; uid: number; gid: number; mode: number; size: number; sha256: string }
interface RootInspection {
  schema: "multi-agent-launch-preflight/v1";
  worker: { name: string; uid: number; gid: number };
  control: { uid: number; gid: number; mountNamespace: string; userNamespace: string };
  roots: { home: string; scratch: string; tree: string; context: string; framework: string };
  installed: Record<"policy" | "launcher" | "executable" | "egress", InstalledFileFact>;
  network: { hostNamespace: string; profileFingerprint: string };
}

/** Collects point-in-time root facts, not an admission grant, provider sign-in or runtime observation. */
export async function inspectManagedWorker(
  rawContext: ContextManifest, bridge: Pick<WorkerMailboxBridge, "binding" | "endpoint">,
  dependencies: ManagedWorkerScopeDependencies & {
    resolveAssignedTree: (scope: ReturnType<typeof resolveManagedWorkerScope>, worker: string) => string;
  },
) {
  try {
    const context = immutable(structuredClone(rawContext));
    const scope = resolveManagedWorkerScope(context, dependencies);
    const policyBytes = readFileSync(INSTALLED_POLICY);
    if (policyBytes.length > 65_536 || hashBytes(policyBytes) !== context.binding.policyFingerprint) throw new Error();
    const policy = JSON.parse(policyBytes.toString("utf8")) as InspectionPolicy;
    const { worker: name, attemptId } = context.projection, paths = policy.paths;
    const controlUid = process.getuid!(), controlGid = process.getgid!();
    const mailbox = immutable({ ...bridge.endpoint() }), registration = immutable(structuredClone(bridge.binding));
    const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
    const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
    if (policy.policy_revision < 5 || policy.policy_revision !== context.binding.policyRevision
      || paths.installed_policy !== INSTALLED_POLICY || paths.installed_launcher !== INSTALLED_LAUNCHER + ".mjs"
      || paths.installed_egress_config !== INSTALLED_EGRESS || !policy.worker_identities.includes(name)
      || ![name, context.runId, attemptId].every(id) || context.projection.controlUid !== controlUid
      || !Number.isSafeInteger(context.workerUid) || context.workerUid <= 0 || context.workerUid === controlUid
      || !Number.isSafeInteger(context.projection.workerGid) || context.projection.workerGid <= 0 || context.projection.workerGid === controlGid
      || registration.runId !== scope.run.id || registration.rigId !== scope.run.rigId
      || registration.taskId !== scope.task.assignment.taskId || registration.sessionId !== scope.sessionId
      || registration.attemptId !== attemptId || registration.socketPath !== mailbox.path
      || mailbox.path !== posix.join(paths.mailbox_root!, name, context.runId, attemptId, "mailbox.sock")
      || mailbox.uid !== controlUid || mailbox.gid !== controlGid
      || !Number.isSafeInteger(mailbox.dev) || mailbox.dev < 0 || !Number.isSafeInteger(mailbox.ino) || mailbox.ino <= 0
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(mailbox.generation)) throw new Error();
    // The original repository binding is shared by the run, not a worker-specific mount selection.
    const tree = dependencies.resolveAssignedTree(scope, name), workerRoot = posix.join(paths.worker_root, name);
    if (posix.resolve(tree) !== tree || !within(posix.join(paths.assignment_root, name), tree)
      || context.root !== posix.join(paths.context_root, name, context.runId, attemptId)
      || context.frameworkRoot !== paths.framework_dir) throw new Error();
    const executable = paths.toolchain_dir + "/clients/bin/" + (context.client === "codex" ? "codex" : "claude");
    const args = ["-n", "--", INSTALLED_LAUNCHER, "--inspect", "--worker", name, "--role", context.role,
      "--tree", tree, "--run", context.runId, "--attempt", attemptId, "--mailbox", mailbox.dev + ":" + mailbox.ino, "--", executable];
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile("/usr/bin/sudo", args, { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C" },
        encoding: "utf8", timeout: 10_000, maxBuffer: 65_536 }, (error, stdout, stderr) => {
        if (error || stderr.trim()) reject(new Error("managed_inspection_unverified")); else resolve(stdout);
      });
      child.stdin?.end();
    });
    const facts = JSON.parse(output) as RootInspection;
    if (facts.schema !== "multi-agent-launch-preflight/v1"
      || !same(Object.keys(facts).sort(), ["control", "installed", "network", "roots", "schema", "worker"])
      || !same(facts.worker, { name, uid: context.workerUid, gid: context.projection.workerGid })
      || !same(facts.control, { uid: controlUid, gid: controlGid,
        mountNamespace: readlinkSync("/proc/self/ns/mnt"), userNamespace: readlinkSync("/proc/self/ns/user") })
      || !same(facts.roots, { home: posix.join(workerRoot, "home"), scratch: posix.join(workerRoot, "scratch"), tree,
        context: context.root, framework: context.frameworkRoot })
      || !same(Object.keys(facts.installed).sort(), ["egress", "executable", "launcher", "policy"])) throw new Error();
    const expectedFiles = { policy: INSTALLED_POLICY, launcher: INSTALLED_LAUNCHER + ".mjs", executable, egress: INSTALLED_EGRESS };
    for (const key of Object.keys(expectedFiles) as (keyof typeof expectedFiles)[]) {
      const fact = facts.installed[key];
      if (!same(Object.keys(fact).sort(), ["gid", "mode", "path", "realpath", "sha256", "size", "uid"])
        || fact.path !== expectedFiles[key] || fact.uid !== 0 || fact.gid !== 0
        || !Number.isSafeInteger(fact.mode) || fact.mode < 0 || fact.mode > 0o7777 || (fact.mode & 0o022)
        || !Number.isSafeInteger(fact.size) || fact.size < 0 || fact.size > 512 * 1024 * 1024
        || !/^sha256:[a-f0-9]{64}$/.test(fact.sha256) || typeof fact.realpath !== "string" || posix.resolve(fact.realpath) !== fact.realpath
        || (key === "executable" ? !(fact.mode & 0o001) || !policy.allowed_exec_prefixes.some(prefix => fact.realpath.startsWith(prefix))
          : fact.realpath !== expectedFiles[key])) throw new Error();
    }
    if (facts.installed.policy.sha256 !== context.binding.policyFingerprint || facts.installed.policy.size !== policyBytes.length
      || !same(facts.network, { hostNamespace: readlinkSync("/proc/self/ns/net"), profileFingerprint: facts.installed.egress.sha256 })
      || hashBytes(readFileSync(INSTALLED_POLICY)) !== hashBytes(policyBytes)
      || process.getuid!() !== controlUid || process.getgid!() !== controlGid
      || !same(bridge.binding, registration) || !same(bridge.endpoint(), mailbox)
      || !same(resolveManagedWorkerScope(context, dependencies), scope)
      || dependencies.resolveAssignedTree(scope, name) !== tree) throw new Error();
    return immutable({ scope, policy, facts, mailbox });
  } catch {
    // Never propagate subprocess output, installed bytes or credential resolver details.
    throw new Error("managed_inspection_unverified");
  }
}

type ProcessSelector = { processId: number; processStart: string };
interface ManagedProcessSnapshot {
  pane: ProcessSelector;
  sandbox: { mountNamespace: string; userNamespace: string; networkNamespace: string };
  lineage: (ProcessSelector & { executable: string })[];
  process: ProcessSelector & { processGroupId: number; namespacePids: number[]; uids: number[]; groups: number[];
    capabilities: string; noNewPrivileges: string; argv: string[]; executable: string; cwd: string;
    environment: Record<string, string>; mountNamespace: string; userNamespace: string; networkNamespace: string; pidNamespace: string };
  mountInfo: string; stdio: { fd: number; kind: "tty" | "pipe" | "file" | "directory" | "socket" }[];
  files: { path: string; hash: string }[]; discoveryRoots: string[];
  nativeSessions: { id: string; createdAfterStart: boolean; rollout: { device: number; inode: number } }[];
}

/** Start time in clock ticks since boot: the kernel's identity for one process instance. */
function processStart(pid: number): string {
  const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
  const value = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  if (!value || !/^(0|[1-9]\d{0,19})$/.test(value)) throw new Error();
  return value;
}

/**
 * Pane and process rows only nominate the supervisor. The privileged helper selects the native process from
 * kernel structure below the pinned sandbox init and authenticates every image against the client lock.
 */
export async function observeManagedWorkerProcess(
  input: WorkerLaunchInput, command: Readonly<WorkerCommand>,
  dependencies: ManagedWorkerScopeDependencies & {
    rigRepo: Pick<RigRepository, "db" | "getRig">;
    sessions: Pick<SessionRegistry, "db" | "findResumeContextByName" | "getLatestLiveSessions">;
    tmux: Pick<TmuxAdapter, "getPanePid">;
    clientLock: Pick<ClientLockObservation, "files">;
    toolchainDir: string;
    /**
     * The session adopted by this attempt's first observation, which must precede any task input. Later
     * observations must find that exact session and, for Codex, the same rollout file.
     */
    expectedSession?: { nativeSessionId: string; rollout?: { device: number; inode: number } };
  },
) {
  try {
    input = immutable(structuredClone(input)); command = immutable(structuredClone(command));
    const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
    const seat = resolveManagedWorkerSeat(input.attempt.context, dependencies);
    const intent = dependencies.governance.getNativeLaunchIntent(seat.scope.run.id, command.attemptId);
    const context = input.attempt.context, policy = context.nativePolicy, toolchain = dependencies.toolchainDir;
    if (!intent || intent.state !== "admitted" && intent.state !== "running" || !policy
      || canonicalJson(intent.command) !== canonicalJson(command) || intent.commandDigest !== hashBytes(canonicalJson(command))
      || intent.sessionId !== seat.scope.sessionId || command.client !== input.client
      || command.attemptId !== input.attempt.attemptId || command.contextHash !== context.generatedHash
      || canonicalJson(command.args.slice(0, 4)) !== canonicalJson(["-n", "--", INSTALLED_LAUNCHER, "--supervise"])) throw new Error();
    // The kernel reports resolved images, so each locked path is resolved before comparison.
    const locked = dependencies.clientLock.files.map(file => realpathSync(posix.join(toolchain, file.path)));
    const node = realpathSync(toolchain + "/node/bin/node");
    if (!locked.length) throw new Error();
    // The egress relay spawns the client; the Codex entry script is a Node program that spawns its native binary.
    const chain = input.client === "codex" ? [node, node, locked.at(-1)!] : [node, locked[0]!];
    const panePid = await dependencies.tmux.getPanePid(seat.pane);
    if (!Number.isSafeInteger(panePid) || panePid! <= 1) throw new Error();
    const pane = { processId: panePid!, processStart: processStart(panePid!) };
    const supervisorArgv = [process.execPath, INSTALLED_LAUNCHER + ".mjs", "--supervise", ...command.args.slice(4)];
    const rows = await listNativeProcesses();
    const descends = (row: NativeProcessRow | undefined, depth: number): boolean => !!row && depth < 3
      && (row.ppid === pane.processId || descends(rows.find(parent => parent.pid === row.ppid), depth + 1));
    const supervisors = rows.filter(row => row.command.startsWith(supervisorArgv.slice(0, 3).join(" ") + " ") && descends(row, 0));
    if (supervisors.length !== 1) throw new Error();
    const supervisor = { processId: supervisors[0]!.pid, processStart: processStart(supervisors[0]!.pid) };
    const expectedFiles = context.files.map(file => ({ path: file.workerPath, hash: file.hash }));
    for (const alias of policy.aliases) expectedFiles.push({ path: alias.target, hash: expectedFiles.find(file => file.path === alias.source)?.hash ?? "" });
    const query = { pane, files: [...new Set(expectedFiles.map(file => file.path))], discoveryRoots: [...context.workerDiscoveryRoots] };
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile("/usr/bin/sudo", ["-n", "--", INSTALLED_LAUNCHER, "--observe", supervisor.processId + ":" + supervisor.processStart,
        ...command.args.slice(4)], { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C" },
        encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (error, output, stderr) => {
        if (error || stderr.trim()) reject(new Error()); else resolve(output);
      });
      child.stdin?.end(JSON.stringify(query));
    });
    const result = JSON.parse(stdout) as { schema: string; supervisor: ProcessSelector; commandDigest: string;
      pidNamespace: string; uid: number; snapshot: ManagedProcessSnapshot };
    const snapshot = result.snapshot, facts = snapshot?.process, native = snapshot?.lineage?.at(-1);
    const sorted = (files: { path: string; hash: string }[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));
    if (result.schema !== "multi-agent-sandbox-control/v1" || !same(result.supervisor, supervisor)
      || result.commandDigest !== hashBytes(JSON.stringify(supervisorArgv)) || result.uid !== context.workerUid
      || !facts || !native || !same(snapshot.pane, pane) || !same(snapshot.lineage.map(row => row.executable), chain)
      || facts.processId !== native.processId || facts.processStart !== native.processStart || facts.executable !== chain.at(-1)
      // argv is worker-writable after exec, so it confirms the admitted command but never selects the process.
      || facts.argv[0] !== (input.client === "codex" ? chain.at(-1) : command.nativeArgv[0])
      || !same(facts.argv.slice(1), command.nativeArgv.slice(1))
      || facts.uids.length !== 4 || facts.uids.some(uid => uid !== context.workerUid) || facts.pidNamespace !== result.pidNamespace
      || !same(snapshot.sandbox, { mountNamespace: facts.mountNamespace, userNamespace: facts.userNamespace, networkNamespace: facts.networkNamespace })
      // The interactive client inherits the pane terminal on every standard stream.
      || !same(snapshot.stdio, [0, 1, 2].map(fd => ({ fd, kind: "tty" })))
      || facts.cwd !== "/work" || !Number.isSafeInteger(facts.processGroupId) || facts.processGroupId <= 0
      || facts.environment.HOME !== "/home/worker" || facts.capabilities !== "0000000000000000" || facts.noNewPrivileges !== "1"
      || !same(sorted(snapshot.files), sorted(expectedFiles))
      || !same([...snapshot.discoveryRoots].sort(), [...context.workerDiscoveryRoots].sort())) throw new Error();
    const token = input.client === "claude-code"
      ? command.nativeArgv[command.nativeArgv.indexOf(input.resumeToken ? "--resume" : "--session-id") + 1] : input.resumeToken;
    let nativeSessionId = token, rollout: { device: number; inode: number } | undefined;
    if (input.client === "codex") {
      const sessions = snapshot.nativeSessions, session = sessions?.[0];
      // A fresh session must be a rollout created by this process, and never an ID another attempt holds.
      // The worker can rename its own rollout once tools run, so later observations bind to this file identity.
      if (!Array.isArray(sessions) || sessions.length !== 1 || !session
        || !Number.isSafeInteger(session.rollout?.device) || session.rollout.device < 0
        || !Number.isSafeInteger(session.rollout?.inode) || session.rollout.inode <= 0
        || (token !== undefined ? session.id !== token : !session.createdAfterStart || dependencies.db.prepare(
          "SELECT 1 FROM team_attempts WHERE json_extract(identity_json, '$.nativeSessionId') = ? AND id <> ? LIMIT 1")
          .get(session.id, command.attemptId))) throw new Error();
      nativeSessionId = session.id; rollout = { device: session.rollout.device, inode: session.rollout.inode };
    }
    const expected = dependencies.expectedSession;
    // A respawned pane keeps its persisted identifier, so the live pane process is rechecked as well.
    if (!nativeSessionId || expected && (expected.nativeSessionId !== nativeSessionId || !same(expected.rollout ?? null, rollout ?? null))
      || await dependencies.tmux.getPanePid(seat.pane) !== pane.processId
      || processStart(pane.processId) !== pane.processStart || processStart(supervisor.processId) !== supervisor.processStart
      || processStart(native.processId) !== native.processStart
      || canonicalJson(resolveManagedWorkerSeat(context, dependencies)) !== canonicalJson(seat)) throw new Error();
    return immutable({ seat, pane, supervisor, native: { processId: native.processId, processStart: native.processStart },
      nativeSessionId, ...(rollout ? { rollout } : {}), snapshot });
  } catch { throw new Error("managed_process_observation_unverified"); }
}
