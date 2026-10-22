import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson, parseAttemptIdentity, type NativeAttemptIdentity } from "../contracts/team-control.js";
import type { AssignmentInput } from "../domain/team-assignment.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import type { ContextMountPolicy, ContextObservation, ManagedNativePolicy, ManagedNativePolicyObservation } from "../integrations/framework/context-manifest.js";
import type { WorkerMailboxBridge } from "./worker-mailbox-bridge.js";
import type { HarnessLaunchResult, ManagedAttempt, ManagedSessionReceipt, NodeBinding, ReadinessResult } from "../domain/runtime-adapter.js";
import type { ResumeResult } from "./claude-resume.js";

export type WorkerClient = "claude-code" | "codex";
export interface WorkerLaunchInput {
  client: WorkerClient;
  attempt: ManagedAttempt;
  resumeToken?: string;
  model?: string;
  effort?: string;
}
export interface WorkerLauncher {
  launch(input: WorkerLaunchInput): Promise<HarnessLaunchResult>;
  checkReady(attempt: ManagedAttempt): Promise<ReadinessResult>;
}

export async function launchManagedHarness(
  launcher: WorkerLauncher | undefined, client: WorkerClient, binding: NodeBinding,
  opts: { resumeToken?: string; forkSource?: unknown },
): Promise<HarnessLaunchResult> {
  if (!launcher) return { ok: false, error: "Managed worker launch is unavailable" };
  if (opts.forkSource) return { ok: false, error: "Managed attempts require a fresh session or an exact resume identity" };
  return launcher.launch({ client, attempt: binding.managedAttempt!, resumeToken: opts.resumeToken,
    model: binding.model, effort: binding.effort });
}

export async function checkManagedReady(launcher: WorkerLauncher | undefined, attempt: ManagedAttempt): Promise<ReadinessResult> {
  if (!launcher) return { ready: false, code: "managed_launch_unavailable", reason: "Managed worker launch is unavailable" };
  return launcher.checkReady(attempt);
}

export async function resumeManagedAttempt(
  launcher: WorkerLauncher | undefined, client: WorkerClient, attempt: ManagedAttempt,
  type: string | null, token: string | null, model?: string | null, effort?: string | null,
): Promise<ResumeResult> {
  if (!launcher) return { ok: false, code: "managed_launch_unavailable", message: "Managed worker launch is unavailable" };
  if (type !== (client === "codex" ? "codex_id" : "claude_id") || !token) {
    return { ok: false, code: "managed_identity_mismatch", message: "Managed resume requires an exact native session ID" };
  }
  const result = await launcher.launch({ client, attempt, resumeToken: token, model: model ?? undefined, effort: effort ?? undefined });
  return result.ok ? { ok: true, managedSession: result.managedSession, appliedLaunch: result.appliedLaunch }
    : { ok: false, code: "managed_launch_failed", message: result.error };
}

export interface WorkerMount { source: string; target: string; access: "ro" | "rw" }
export interface WorkerBoundary {
  uid: number;
  groups: number[];
  home: string;
  configHome: string;
  mountNamespace: string;
  userNamespace: string;
  networkNamespace: string;
  networkProfileFingerprint: string;
  mounts: WorkerMount[];
  inheritedDescriptors: { fd: number; kind: "tty" | "pipe" | "file" | "directory" | "socket" }[];
}
export interface WorkerLaunchPreflight {
  assignment: AssignmentInput;
  worker: { name: string; uid: number; gid: number; groups: number[]; home: string; scratch: string; tree: string };
  control: { uid: number; gid?: number; mountNamespace: string; userNamespace: string };
  executable: string;
  executableVersion: string;
  /**
   * KTD27 lock entry for this client and the executable hashes the privileged launcher observed
   * against it. `version` and `files` come from the installed lock; `observedFiles` from the inspected inodes.
   */
  clientLock: ClientLockObservation;
  generation: number;
  policyFingerprint: string;
  policyRevision: number;
  /** Root-owned installed policy observed by the control preflight, bound to the approved fingerprint. */
  installedPolicy: WorkerLaunchPolicy;
  network: WorkerNetworkPolicy;
  provider: { status: "signed_in" | "signed_out" | "unknown"; client: WorkerClient; home: string; evidenceRef: string };
  nativePolicy?: ManagedNativePolicy;
  mailbox?: ReturnType<WorkerMailboxBridge["endpoint"]>;
  previous?: ManagedSessionReceipt;
  /** Secret values are used only for output redaction, never copied to receipts or argv. */
  credentialValues: string[];
}
export interface ClientLockObservation {
  digest: string;
  version: string;
  files: { path: string; sha256: string }[];
  observedFiles: { path: string; sha256: string }[];
}
/** KTD20 treats this launch refusal as non-retryable; a mismatched client build never falls back. */
export const UNSUPPORTED_CLIENT_VERSION = "agent_error.unsupported_version";
export interface WorkerNetworkPolicy {
  mode: "isolated-allowlist" | "filtered-proxy" | "host-shared" | "unknown";
  hostNamespace: string;
  profileFingerprint: string;
  preflightRef: string;
}
export interface WorkerCommand {
  file: "/usr/bin/sudo";
  args: string[];
  attemptId: string;
  deadline: number;
  contextHash: string;
  client: WorkerClient;
  nativeArgv: string[];
  network: WorkerNetworkPolicy;
}
export interface WorkerObservation {
  identity: NativeAttemptIdentity;
  attemptId: string;
  processGroupId: number;
  boundary: WorkerBoundary;
  context: ContextObservation;
  nativePolicy?: ManagedNativePolicyObservation;
  mailbox?: Pick<NonNullable<WorkerLaunchPreflight["mailbox"]>, "uid" | "gid" | "dev" | "ino">;
  /** Observed at exec by the control transport, rather than read from pane text. */
  nativeArgv: string[];
  sessionSource: "exec" | "process_session_file";
  effectiveMode: { permissionMode?: string; approvalPolicy?: string; sandbox?: string };
  readiness: "ready" | "starting" | "prompt" | "unknown" | "unsupported";
  screen: string;
  output: { text: string; evidenceRef: string };
}
export interface WorkerQuiescenceRequest {
  command: Readonly<WorkerCommand>;
  identity?: NativeAttemptIdentity;
  processGroupId?: number;
  causeCode: string;
}
export interface WorkerQuiescenceReceipt {
  command: Readonly<WorkerCommand>;
  status: "terminated" | "quarantined" | "not_started";
  identity?: NativeAttemptIdentity;
  processGroupId?: number;
  evidenceRef: string;
}
export interface WorkerLaunchEvent {
  phase: "prepared" | "observed" | "blocked";
  attemptId: string;
  deadline: number;
  contextHash: string;
  code?: string;
  causeCode?: string;
  quiescence?: WorkerQuiescenceReceipt;
  session?: ManagedSessionReceipt;
  network?: WorkerNetworkPolicy;
  nativePolicy?: { installedDigest: string; observedDigest: string };
  clientLock?: { digest: string; version: string };
  output?: { text: string; truncated: boolean; evidenceRef: string };
}
/**
 * Control-owned capability: preflight and observation must come from the supervisor's
 * authenticated OS/native-client probes. Worker metadata and terminal output cannot
 * implement this interface. The transport executes the fixed privileged launcher,
 * closes inherited descriptors, and forwards the deadline to the U7 supervisor.
 */
export interface WorkerLaunchControl {
  preflight(input: WorkerLaunchInput): Promise<WorkerLaunchPreflight>;
  start(command: Readonly<WorkerCommand>): Promise<NativeAttemptIdentity>;
  observe(identity: NativeAttemptIdentity): Promise<WorkerObservation>;
  /**
   * Authenticated supervisor operation, registered against the immutable command
   * before start effects. Resolve only after the entire owned process group and
   * its descendants cannot execute. Locate ambiguous starts by command when no
   * valid identity was returned; not_started also excludes any future start effect.
   * Never select a target from an unverified observation or terminal output.
   */
  quiesce(request: Readonly<WorkerQuiescenceRequest>): Promise<WorkerQuiescenceReceipt>;
  record(event: Readonly<WorkerLaunchEvent>): Promise<void>;
}

/**
 * T039 — the runtime's launch-admission seam.
 *
 * The control decides the assigned tree inside its preflight, so the tree must
 * already exist and be the task's own candidate when preflight runs. Admission
 * therefore happens first and returns that exact path; anything else means the
 * launch is refused before a privileged call.
 */
export interface WorkerLaunchAdmission {
  admitForLaunch(runId: string, input: {
    assignment: AssignmentInput["assignment"];
    outputs: readonly string[];
    permissions: readonly string[];
    context: AssignmentInput["context"];
  }): { candidate: string; manifestDigest: string };
  /**
   * The full assignment preparation over the real post-preflight observation.
   *
   * T039 requires that no production path call `prepareTeamAssignment` outside
   * `WorkflowRuntime`, so the launcher reaches it through this seam even though it
   * already holds the binding the runtime would supply. The runtime is what adds
   * the approved binding and the validated-evidence dependency check; calling the
   * module directly here would let a launch skip both.
   */
  prepareAssignment(input: Omit<AssignmentInput, "binding" | "dependencySatisfied">): Promise<{ context: { generatedHash: string } }>;
  candidateSourceUnchanged(runId: string, taskId: string): { unchanged: boolean };
  releaseCandidate(runId: string, taskId: string): void;
}
type LaunchState = {
  input: WorkerLaunchInput;
  preflight?: WorkerLaunchPreflight;
  command?: WorkerCommand;
  identity?: NativeAttemptIdentity;
  startRequested?: boolean;
  processGroupId?: number;
  receipt?: ManagedSessionReceipt;
  nativePolicy?: WorkerLaunchEvent["nativePolicy"];
  blocked?: string;
  blockCause?: string;
  blocking?: Promise<void>;
  quiescence?: WorkerQuiescenceReceipt;
  evidencePersistenceFailed?: boolean;
};
class WorkerLaunchFault extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(code); }
}
function requireFact(condition: unknown, code: string): asserts condition {
  if (!condition) throw new WorkerLaunchFault(code);
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function groups(value: number[]): number[] { return [...value].sort((a, b) => a - b); }
const configHome = (client: WorkerClient) => "/home/worker/" + (client === "codex" ? ".codex" : ".claude");
/** Provisioned beside the pinned client; it keeps tools in the standard Responses request (see provision-host.sh). */
export const codexModelCatalog = (toolchainDir: string) => toolchainDir + "/clients/codex-model-catalog.json";
export interface WorkerLaunchPolicy extends ContextMountPolicy {
  paths: ContextMountPolicy["paths"] & { toolchain_dir: string; egress_socket_dir: string; control_state_dir?: string; mailbox_root?: string };
  sandbox: ContextMountPolicy["sandbox"] & { network: string; etc_ro_binds: string[]; masked_paths: string[];
    mailbox?: string; native_policy_mounts?: Record<WorkerClient, { source: string; target: string }> };
}
const reference = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/.test(value);
/** Bare version from `--version` output, e.g. "2.1.296 (Claude Code)" or "codex-cli 0.160.0". */
function reportedVersion(client: WorkerClient, raw: string): string {
  const text = raw.trim();
  const match = client === "codex" ? /^codex-cli (\S+)$/.exec(text) : /^(\S+) \(Claude Code\)$/.exec(text);
  return match?.[1] ?? text;
}

function sharedOutput(output: WorkerObservation["output"], secrets: string[]): WorkerLaunchEvent["output"] {
  requireFact(reference(output.evidenceRef), "managed_evidence_invalid");
  let text = output.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g, "");
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@");
  const bytes = Buffer.from(text);
  const bounded = bytes.subarray(0, 8192).toString("utf8").replace(/\uFFFD$/, "");
  return { text: bounded, truncated: bytes.length > 8192, evidenceRef: output.evidenceRef };
}

/** Composes assignment/context authority with the existing privileged launch boundary. */
export class RestrictedWorkerLauncher implements WorkerLauncher {
  private states = new Map<string, LaunchState>();
  private context?: typeof import("../integrations/framework/context-manifest.js");
  constructor(private control: WorkerLaunchControl, private now: () => number = Date.now, private sessionId: () => string = randomUUID,
    /**
     * T039: the only production admission path. When supplied, the launcher asks
     * the runtime to admit the assignment and place its candidate tree before the
     * control preflights anything; a refusal never reaches a privileged call.
     */
    private admission?: WorkerLaunchAdmission) {}

  async launch(input: WorkerLaunchInput): Promise<HarnessLaunchResult> {
    let state: LaunchState;
    try {
      this.context = await import("../integrations/framework/context-manifest.js");
      input = { ...input, attempt: this.context.immutable(structuredClone(input.attempt)) };
      requireFact(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.attempt.attemptId), "managed_attempt_invalid");
      requireFact(!this.states.has(input.attempt.attemptId), "managed_attempt_already_started");
      state = { input };
      this.states.set(input.attempt.attemptId, state);
    } catch { return { ok: false, error: "Managed launch blocked: managed_attempt_invalid_or_duplicate" }; }
    try {
      const { immutable } = this.context!;
      const { prepareTeamAssignment } = await import("../domain/team-assignment.js");
      const { attempt, client, resumeToken } = input;
      this.checkDeadline(attempt);
      requireFact(attempt.context.client === client, "managed_client_mismatch");
      // T039: eligibility and the candidate tree are settled before the control
      // resolves the assigned tree, because that tree must already be this task's
      // candidate. A refused assignment therefore creates no candidate and reaches
      // no privileged call, including the read-only `--inspect` preflight.
      const admitted = this.admission
        ? (() => {
            try {
              return this.admission.admitForLaunch(attempt.context.runId, {
                assignment: attempt.context.assignment, outputs: attempt.context.outputs,
                permissions: attempt.context.permissions, context: attempt.context,
              });
            } catch (error) {
              throw new WorkerLaunchFault("managed_assignment_refused", error instanceof Error ? error.message : undefined);
            }
          })()
        : undefined;
      requireFact(admitted === undefined || /^\/[^\0]{1,4095}$/.test(admitted.candidate), "managed_candidate_unavailable");
      const { assignment, ...metadata } = await this.control.preflight(input);
      const preflight = state.preflight = {
        ...immutable(structuredClone(metadata)),
        assignment: { ...assignment, observed: immutable(structuredClone(assignment.observed)) },
      };
      // The control resolves the assigned tree from the installed policy; it must
      // be the exact candidate this launch admitted, never a shared or source tree.
      requireFact(admitted === undefined || preflight.worker.tree === admitted.candidate, "managed_candidate_mismatch");
      const policy = preflight.installedPolicy;
      const network = this.networkPolicy(preflight);
      this.checkContextProjection(attempt, preflight);
      await this.checkNativePreflight(attempt, preflight);
      // Prepared through the runtime, never by calling the module directly: the
      // runtime supplies the approved binding and the validated-evidence
      // dependency check that a direct call would have to re-derive. The
      // unmanaged branch exists only for module-level callers that construct this
      // launcher without a runtime; production startup always supplies one, and
      // `managed-native-startup.test.ts` proves the composed path reaches
      // admission.
      const prepared = this.admission
        ? await this.admission.prepareAssignment({ ...preflight.assignment, context: attempt.context })
        : await prepareTeamAssignment({ ...preflight.assignment, context: attempt.context });
      requireFact(prepared.context.generatedHash === attempt.context.generatedHash, "managed_context_mismatch");
      requireFact(preflight.worker.uid !== preflight.control.uid && preflight.worker.uid > 0
        && preflight.worker.uid === attempt.context.workerUid && same(groups(preflight.worker.groups), groups(attempt.context.workerGroups)),
      "managed_worker_identity_mismatch");
      requireFact(policy.worker_identities.includes(preflight.worker.name), "managed_worker_identity_mismatch");
      requireFact(preflight.policyFingerprint === attempt.context.binding.policyFingerprint
        && preflight.policyRevision === attempt.context.binding.policyRevision && preflight.policyRevision === policy.policy_revision, "managed_policy_mismatch");
      for (const root of [preflight.worker.home, preflight.worker.scratch, preflight.worker.tree]) {
        requireFact(realpathSync(root) === root, "managed_worker_root_invalid");
      }
      requireFact(preflight.executable === policy.paths.toolchain_dir + "/clients/bin/" + (client === "codex" ? "codex" : "claude")
        && preflight.executableVersion.trim(), "managed_executable_unsupported");
      this.checkClientLock(client, preflight);
      for (const option of [input.model, input.effort]) requireFact(option === undefined
        || (option.length > 0 && option.length <= 256 && !option.startsWith("-") && !/[\x00-\x1f\x7f]/.test(option)), "managed_launch_option_invalid");
      requireFact(resumeToken === undefined || /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(resumeToken), "managed_resume_identity_mismatch");
      requireFact(preflight.provider.status === "signed_in" && preflight.provider.client === client
        && preflight.provider.home === preflight.worker.home && reference(preflight.provider.evidenceRef), "managed_provider_signin_required");
      if (resumeToken !== undefined) {
        const previous = attempt.previous;
        requireFact(previous && preflight.previous && same(previous, preflight.previous), "managed_resume_identity_mismatch");
        requireFact(previous.identity.nativeSessionId === resumeToken && previous.client === client
          && previous.runId === attempt.context.runId
          && (previous.attemptId !== attempt.attemptId || previous.contextHash === attempt.context.generatedHash)
          && previous.workerUid === preflight.worker.uid && previous.identity.policyFingerprint === preflight.policyFingerprint
          && attempt.deadline <= previous.deadline && preflight.generation === previous.identity.generation + 1
          && previous.network?.mode === network.mode && previous.network.profileFingerprint === network.profileFingerprint, "managed_resume_identity_mismatch");
      } else requireFact(!attempt.previous && !preflight.previous && preflight.generation === 1, "managed_resume_identity_mismatch");
      const nativeArgv = client === "claude-code"
        ? [preflight.executable, "--permission-mode", "bypassPermissions",
          ...(input.model ? ["--model", input.model] : []), ...(input.effort ? ["--effort", input.effort] : []),
          ...(resumeToken ? ["--resume", resumeToken] : ["--session-id", this.sessionId()])]
        : [preflight.executable, "-a", "never", "-s", "danger-full-access", "-c", "check_for_update_on_startup=false",
          "-c", "model_catalog_json=" + JSON.stringify(codexModelCatalog(policy.paths.toolchain_dir)),
          ...(input.model ? ["-m", input.model] : []), ...(input.effort ? ["-c", "model_reasoning_effort=" + JSON.stringify(input.effort)] : []),
          ...(resumeToken ? ["resume", resumeToken] : [])];
      const command: WorkerCommand = state.command = immutable({
        file: "/usr/bin/sudo", args: ["-n", "--", "/usr/local/libexec/multi-agent/worker-launch",
          ...(policy.policy_revision >= 5 ? ["--supervise"] : []),
          "--worker", preflight.worker.name, "--role", attempt.context.role, "--tree", preflight.worker.tree,
          "--run", attempt.context.runId, "--attempt", attempt.attemptId, "--client-lock", preflight.clientLock.digest,
          ...(policy.policy_revision >= 5 ? ["--mailbox", `${preflight.mailbox!.dev}:${preflight.mailbox!.ino}`] : []), "--", ...nativeArgv],
        nativeArgv, network, client, attemptId: attempt.attemptId, deadline: attempt.deadline, contextHash: attempt.context.generatedHash,
      });
      await this.record(state, { phase: "prepared" });
      this.checkDeadline(attempt);
      // Re-checked after the recorded preparation: the same runtime path, so the
      // last word on eligibility before any start effect is not a direct module call.
      await (this.admission
        ? this.admission.prepareAssignment({ ...preflight.assignment, context: attempt.context })
        : prepareTeamAssignment({ ...preflight.assignment, context: attempt.context }));
      this.checkDeadline(attempt);
      state.startRequested = true;
      state.identity = immutable(parseAttemptIdentity(await this.control.start(command)));
      const observed = await this.control.observe(state.identity);
      const receipt = this.verifyObservation(state, observed);
      await this.record(state, { phase: "observed", session: receipt, output: sharedOutput(observed.output, preflight.credentialValues) });
      state.receipt = receipt;
      return { ok: true, managedSession: receipt, resumeToken: receipt.identity.nativeSessionId, resumeType: client === "codex" ? "codex_id" : "claude_id" };
    } catch (error) {
      // A-R3: the control reports a launcher lock refusal with the same non-retryable code.
      const code = error instanceof WorkerLaunchFault ? error.code
        : error instanceof Error && error.message === UNSUPPORTED_CLIENT_VERSION ? UNSUPPORTED_CLIENT_VERSION : "managed_launch_unverified";
      await this.block(state, code);
      // The cause travels with the refusal, but never as raw error text: an
      // underlying message can carry a path, a command line or a credential, and
      // this string reaches the caller. Only codes this launcher itself assigns
      // are surfaced; anything else stays behind "managed_launch_unverified".
      const detail = error instanceof WorkerLaunchFault ? error.detail : undefined;
      return { ok: false, error: "Managed launch blocked: " + state.blocked + "; " + this.blockReason(state)
        + (detail ? "; cause: " + detail : ""), recovery: "attention_required" };
    }
  }

  async checkReady(attempt: ManagedAttempt): Promise<ReadinessResult> {
    const state = this.states.get(attempt?.attemptId);
    if (state?.blocked) {
      await state.blocking;
      return { ready: false, code: state.blocked, reason: this.blockReason(state) };
    }
    if (!state?.receipt || !state.identity) return { ready: false, code: "managed_identity_unobserved" };
    try {
      requireFact(same(attempt, state.input.attempt), "managed_context_changed");
      const receipt = this.verifyObservation(state, await this.control.observe(state.identity));
      requireFact(same(receipt, state.receipt), "managed_identity_changed");
      if (state.blocked) {
        await state.blocking;
        return { ready: false, code: state.blocked, reason: this.blockReason(state) };
      }
      return { ready: true };
    } catch (error) {
      await this.block(state, error instanceof WorkerLaunchFault ? error.code : "managed_observation_unavailable");
      return { ready: false, code: state.blocked, reason: this.blockReason(state) };
    }
  }

  private async block(state: LaunchState, causeCode: string): Promise<void> {
    state.blocked ??= causeCode;
    state.blockCause ??= causeCode;
    // Defer the operation until the shared promise is installed, including when
    // the transport synchronously triggers another readiness check.
    state.blocking ??= Promise.resolve().then(async () => {
      if (state.startRequested) {
        try {
          const request = this.context!.immutable({ command: state.command!, causeCode: state.blockCause!,
            ...(state.identity ? { identity: state.identity } : {}),
            ...(state.processGroupId ? { processGroupId: state.processGroupId } : {}) });
          const receipt = await this.control.quiesce(request);
          requireFact(receipt && same(receipt.command, request.command) && reference(receipt.evidenceRef), "managed_quiescence_unconfirmed");
          let identity: NativeAttemptIdentity | undefined;
          if (receipt.status === "not_started") {
            requireFact(!state.identity && receipt.identity === undefined && receipt.processGroupId === undefined,
              "managed_quiescence_unconfirmed");
          } else {
            requireFact(receipt.status === "terminated" || receipt.status === "quarantined", "managed_quiescence_unconfirmed");
            identity = parseAttemptIdentity(receipt.identity);
            requireFact((!state.identity || same(identity, state.identity))
              && identity.policyFingerprint === state.preflight!.policyFingerprint && identity.generation === state.preflight!.generation
              && Number.isSafeInteger(receipt.processGroupId) && receipt.processGroupId! > 0
              && (state.processGroupId === undefined || receipt.processGroupId === state.processGroupId), "managed_quiescence_unconfirmed");
          }
          state.quiescence = this.context!.immutable({ command: state.command!, status: receipt.status,
            ...(identity ? { identity, processGroupId: receipt.processGroupId } : {}), evidenceRef: receipt.evidenceRef });
        } catch { state.blocked = "managed_quiescence_unconfirmed"; }
      }
      try {
        await this.record(state, { phase: "blocked", code: state.blocked, causeCode: state.blockCause, quiescence: state.quiescence });
      } catch {
        state.evidencePersistenceFailed = true;
        if (state.blocked !== "managed_quiescence_unconfirmed") state.blocked = "managed_evidence_persistence_failed";
      }
    });
    await state.blocking;
  }

  private blockReason(state: LaunchState): string {
    return "Owner configuration check required; cause: " + state.blockCause
      + (state.evidencePersistenceFailed ? "; managed_evidence_persistence_failed" : "");
  }

  private checkDeadline(attempt: ManagedAttempt): void {
    requireFact(Number.isSafeInteger(attempt.deadline) && attempt.deadline > this.now(), "managed_deadline_expired");
  }

  private checkClientLock(client: WorkerClient, p: WorkerLaunchPreflight): void {
    const lock = p.clientLock, toolchain = p.installedPolicy.paths.toolchain_dir;
    requireFact(lock && /^sha256:[a-f0-9]{64}$/.test(lock.digest) && Array.isArray(lock.files) && lock.files.length > 0
      && lock.version === reportedVersion(client, p.executableVersion)
      && same(lock.observedFiles, lock.files.map(file => ({ path: toolchain + "/" + file.path, sha256: file.sha256 }))),
    UNSUPPORTED_CLIENT_VERSION);
  }

  private checkContextProjection(attempt: ManagedAttempt, preflight: WorkerLaunchPreflight): void {
    const projection = attempt.context.projection, policy = preflight.installedPolicy;
    requireFact(projection && projection.worker === preflight.worker.name && projection.attemptId === attempt.attemptId
      && projection.controlUid === preflight.control.uid && projection.workerGid === preflight.worker.gid
      && same(projection.policy.worker_identities, policy.worker_identities)
      && projection.policy.policy_revision === policy.policy_revision
      && projection.policy.paths.context_root === policy.paths.context_root
      && projection.policy.paths.framework_dir === policy.paths.framework_dir
      && projection.policy.sandbox.context === policy.sandbox.context
      && projection.policy.sandbox.framework === policy.sandbox.framework, "managed_context_mount_policy_mismatch");
  }

  private async checkNativePreflight(attempt: ManagedAttempt, p: WorkerLaunchPreflight): Promise<void> {
    const policy = p.installedPolicy;
    if (policy.policy_revision < 5) return;
    const expected = await this.context!.buildManagedNativePolicy(attempt.context.client, policy.paths.toolchain_dir);
    requireFact(p.nativePolicy && same(p.nativePolicy, expected) && same(attempt.context.nativePolicy, expected),
      "managed_native_policy_mismatch");
    const mount = policy.sandbox.native_policy_mounts?.[attempt.context.client];
    requireFact(mount && same(expected.aliases, [{ source: policy.sandbox.context + "/" + mount.source, target: mount.target }]),
      "managed_native_policy_mount_mismatch");
    const root = policy.paths.control_state_dir, mailboxRoot = policy.paths.mailbox_root, mailbox = p.mailbox;
    requireFact(root && root !== "/" && resolve(root) === root && mailboxRoot === root + "/mailboxes"
      && policy.sandbox.mailbox === "/run/multi-agent/mailbox.sock", "managed_mailbox_policy_mismatch");
    requireFact(mailbox && mailbox.path === mailboxRoot + "/" + p.worker.name + "/" + attempt.context.runId + "/" + attempt.attemptId + "/mailbox.sock"
      && Number.isSafeInteger(p.control.uid) && p.control.uid >= 0 && Number.isSafeInteger(p.control.gid) && p.control.gid! >= 0
      && mailbox.uid === p.control.uid && mailbox.gid === p.control.gid
      && Number.isSafeInteger(mailbox.dev) && mailbox.dev >= 0 && Number.isSafeInteger(mailbox.ino) && mailbox.ino > 0
      && typeof mailbox.generation === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(mailbox.generation),
    "managed_mailbox_identity_mismatch");
  }

  private networkPolicy(preflight: WorkerLaunchPreflight) {
    const network = preflight.network;
    requireFact(network && network.mode === "filtered-proxy" && preflight.installedPolicy.sandbox.network === "filtered-proxy"
      && /^net:\[\d+\]$/.test(network.hostNamespace) && /^sha256:[a-f0-9]{64}$/.test(network.profileFingerprint)
      && reference(network.preflightRef) && preflight.policyRevision >= 4, "managed_network_policy_unavailable");
    return { ...network, mode: network.mode };
  }

  private verifyObservation(state: LaunchState, observed: WorkerObservation): ManagedSessionReceipt {
    const { attempt, client, resumeToken } = state.input, p = state.preflight!, command = state.command!, policy = p.installedPolicy;
    const { immutable, verifyEffectiveContext, verifyEffectiveNativePolicy } = this.context!;
    state.nativePolicy = undefined;
    this.checkDeadline(attempt);
    const identity = parseAttemptIdentity(observed.identity), b = observed.boundary;
    const network = this.networkPolicy(p);
    this.checkContextProjection(attempt, p);
    requireFact(same(identity, state.identity) && identity.policyFingerprint === p.policyFingerprint
      && identity.generation === p.generation && observed.attemptId === attempt.attemptId
      && Number.isSafeInteger(observed.processGroupId) && observed.processGroupId > 0, "managed_identity_mismatch");
    state.processGroupId ??= observed.processGroupId;
    requireFact(/^net:\[\d+\]$/.test(b.networkNamespace) && b.networkNamespace !== network.hostNamespace
      && b.networkProfileFingerprint === network.profileFingerprint, "managed_network_boundary_mismatch");
    requireFact(["exec", "process_session_file"].includes(observed.sessionSource), "managed_identity_unobserved");
    requireFact(same(observed.nativeArgv, command.nativeArgv), "managed_launch_mode_mismatch");
    requireFact(b.uid === p.worker.uid && b.uid !== p.control.uid && same(groups(b.groups), groups(p.worker.groups))
      && b.home === "/home/worker" && b.configHome === configHome(client), "managed_worker_boundary_mismatch");
    requireFact(b.mountNamespace && b.userNamespace && b.mountNamespace !== p.control.mountNamespace
      && b.userNamespace !== p.control.userNamespace, "managed_worker_boundary_mismatch");
    const expected: WorkerMount[] = [
      { source: p.worker.home, target: "/home/worker", access: "rw" },
      { source: p.worker.scratch, target: "/scratch", access: "rw" },
      { source: p.worker.tree, target: "/work", access: attempt.context.role === "reviewer" ? "ro" : "rw" },
      { source: policy.paths.framework_dir, target: policy.sandbox.framework, access: "ro" },
      { source: attempt.context.root, target: policy.sandbox.context, access: "ro" },
      { source: policy.paths.egress_socket_dir, target: policy.paths.egress_socket_dir, access: "ro" },
    ];
    if (policy.policy_revision >= 5) expected.push(
      { source: p.mailbox!.path, target: policy.sandbox.mailbox!, access: "ro" },
      { source: "tmpfs", target: dirname(policy.sandbox.mailbox!), access: "ro" },
      { source: "tmpfs", target: dirname(p.nativePolicy!.selectedSource), access: "ro" },
      { source: "tmpfs", target: "/home/worker/.multi-agent/mailbox", access: "rw" },
      { source: "tmpfs", target: "/home/worker/.multi-agent/mailbox/bootstrap.json", access: "ro" },
      ...p.nativePolicy!.aliases.map(alias => ({ source: attempt.context.files.find(file => file.workerPath === alias.source)!.path,
        target: alias.target, access: "ro" as const })),
    );
    for (const mount of expected) requireFact(b.mounts.filter(m => m.target === mount.target).length === 1
      && b.mounts.some(m => same(m, mount)), "managed_worker_mount_mismatch");
    const hostReadOnly = ["/usr", policy.paths.toolchain_dir, ...policy.sandbox.etc_ro_binds];
    requireFact(b.mounts.every(m => expected.some(e => same(e, m))
      || (m.access === "ro" && m.source === m.target && hostReadOnly.includes(m.target))
      || (m.access === "ro" && m.source === "tmpfs" && policy.sandbox.masked_paths.includes(m.target))
      || (["/", "/tmp", "/run", "/dev", "/var/tmp", "/proc"].includes(m.target) && ["tmpfs", "devtmpfs", "proc"].includes(m.source))
      // The fixed device nodes and terminal mount that bubblewrap's --dev creates.
      || (m.access === "rw" && (m.source === "devtmpfs" && /^\/dev\/(?:null|zero|full|random|urandom|tty)$/.test(m.target)
        || m.source === "devpts" && m.target === "/dev/pts"))),
    "managed_worker_mount_mismatch");
    requireFact(b.inheritedDescriptors.every(d => Number.isSafeInteger(d.fd) && d.fd >= 0 && d.fd <= 2
      && ["tty", "pipe", "file"].includes(d.kind)), "managed_descriptor_leak");
    const observedContextHash = verifyEffectiveContext(attempt.context, {
      ...observed.context,
      discoveryRoots: [...observed.context.discoveryRoots].sort(),
      files: [...observed.context.files].sort((a, b) => a.path.localeCompare(b.path)),
    });
    let nativePolicy: WorkerLaunchEvent["nativePolicy"];
    if (policy.policy_revision >= 5) {
      const endpoint = p.mailbox!;
      requireFact(observed.mailbox && same(observed.mailbox, { uid: endpoint.uid, gid: endpoint.gid, dev: endpoint.dev, ino: endpoint.ino }),
        "managed_mailbox_identity_mismatch");
      requireFact(observed.nativePolicy, "managed_native_policy_unobserved");
      try {
        nativePolicy = { installedDigest: p.nativePolicy!.digest, observedDigest: verifyEffectiveNativePolicy(p.nativePolicy!, observed.nativePolicy) };
      } catch { throw new WorkerLaunchFault("managed_native_policy_mismatch"); }
    }
    if (client === "claude-code") requireFact(observed.effectiveMode.permissionMode === "bypassPermissions"
      && identity.nativeSessionId === (resumeToken ?? command.nativeArgv[command.nativeArgv.indexOf("--session-id") + 1]), "managed_launch_mode_mismatch");
    else requireFact(observed.effectiveMode.approvalPolicy === "never" && observed.effectiveMode.sandbox === "danger-full-access"
      && (!resumeToken || identity.nativeSessionId === resumeToken), "managed_launch_mode_mismatch");
    // No pane command is asserted: only the client's own interactive screen counts as ready.
    const probe = assessNativeResumeProbe({ runtime: client, paneCommand: "",
      paneContent: observed.screen, claudeAutoIdentityVerified: true, claudeResumeIdentityVerified: true });
    requireFact(observed.readiness !== "prompt" && !/(?:gate|login|auth|selection_prompt)/.test(probe.code)
      && !/permission required|approve this|allow this (?:command|tool)|requires? approval/i.test(observed.screen), "managed_native_prompt");
    requireFact(observed.readiness === "ready" && probe.status === "resumed", "managed_readiness_unknown");
    state.nativePolicy = nativePolicy;
    return immutable({ identity, attemptId: attempt.attemptId, runId: attempt.context.runId, client,
      contextHash: attempt.context.generatedHash, observedContextHash, workerUid: b.uid, deadline: attempt.deadline,
      processGroupId: observed.processGroupId, executableVersion: p.executableVersion,
      network: { namespace: b.networkNamespace, mode: network.mode, profileFingerprint: network.profileFingerprint, preflightRef: network.preflightRef } });
  }

  private async record(state: LaunchState, event: Pick<WorkerLaunchEvent, "phase" | "code" | "causeCode" | "quiescence" | "session" | "output">): Promise<void> {
    await this.control.record(this.context!.immutable({ ...event,
      ...(state.nativePolicy ? { nativePolicy: state.nativePolicy } : {}),
      ...(state.preflight?.clientLock ? { clientLock: { digest: state.preflight.clientLock.digest, version: state.preflight.clientLock.version } } : {}),
      ...(state.command ? { network: state.command.network } : {}), attemptId: state.input.attempt.attemptId,
      deadline: state.input.attempt.deadline, contextHash: state.input.attempt.context?.generatedHash ?? "unverified" }));
  }
}
