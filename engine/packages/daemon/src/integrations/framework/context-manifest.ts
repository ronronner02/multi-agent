import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, parseAssignment, parsePlanBinding, text, type PlanBinding, type ScopedAssignment, type TeamRole } from "../../contracts/team-control.js";
// T053: the role configuration and the freeze helper live in a dependency-free module, so
// the governance owner can validate a task's permissions without importing this one back.
import { immutable, roleConfiguration } from "../../domain/role-configuration.js";
import { hashBinding, hashBytes } from "../../domain/plan-governance.js";
import { FRAMEWORK_PIN } from "./catalog.js";

export interface ContextFile { path: string; hash: string; kind: "framework" | "role" | "plan" | "protocol" | "roster" | "run" | "native-policy" | "core" | "charter"; readOnly: true; source?: string }
export interface ContextMountPolicy {
  policy_revision: number; worker_identities: string[];
  paths: { context_root: string; framework_dir: string };
  sandbox: { context: string; framework: string };
}
export interface ContextInput {
  nativePolicy?: ManagedNativePolicy;
  projection: { worker: string; attemptId: string; controlUid: number; workerGid: number; policy: ContextMountPolicy };
  runId: string; assignment: ScopedAssignment; outputs: string[]; permissions: string[]; role: TeamRole; client: "claude-code" | "codex"; binding: PlanBinding;
  root: string; mutableStateRoot: string; frameworkRoot: string; frameworkRevision: string;
  workerUid: number; workerGroups: number[]; discoveryRoots: string[]; files: ContextFile[];
  lead?: { activationId: string; roster: { member: string; role: TeamRole; mailbox: string }[]; instructions: string };
}
export type ContextManifest = Readonly<Omit<ContextInput, "files"> & { files: (ContextFile & { workerPath: string })[]; workerDiscoveryRoots: string[]; generatedHash: string; protocolVersion: string | null; instructionVersions: InstructionVersions }>;
export interface InstructionVersions { core: string; charter: string }
export interface ContextObservation { discoveryRoots: string[]; files: { path: string; hash: string }[] }
export const leadProtocol = readFileSync(new URL("../../../../../config/team/lead-protocol.md", import.meta.url), "utf8");
export const LEAD_PROTOCOL_VERSION = "1";
/** An instruction file without a `Version:` line cannot be projected. */
export function instructionVersion(content: string): string {
  const version = /^Version: (\S+)$/m.exec(content)?.[1];
  if (!version) throw new Error("Instruction file has no version");
  return version;
}
/**
 * KTD28: conduct shared by every role, and one charter per role. The Lead's charter is its protocol.
 * Read on every call, so a new attempt picks up a charter edit without a daemon restart; an
 * existing attempt keeps the bytes its projection recorded.
 */
export function loadRoleInstructions(role: TeamRole): { core: string; charter: string } {
  const read = (path: string) => readFileSync(new URL(`../../../../../config/team/${path}`, import.meta.url), "utf8");
  return { core: read("core.md"), charter: role === "lead" ? leadProtocol : read(`roles/${role}.md`) };
}
/** Load-time snapshots, for callers and tests that need the bytes without a projection. */
export const coreInstructions = loadRoleInstructions("implementer").core;
export const roleCharters: Readonly<Record<TeamRole, string>> = Object.freeze({ lead: leadProtocol,
  implementer: loadRoleInstructions("implementer").charter, reviewer: loadRoleInstructions("reviewer").charter });
for (const content of [coreInstructions, ...Object.values(roleCharters)]) instructionVersion(content);
if (instructionVersion(leadProtocol) !== LEAD_PROTOCOL_VERSION) throw new Error("Lead protocol version mismatch");
/** The instruction entries a new attempt's projection carries for its role: the core, then the role's charter. */
export function roleInstructionEntries(role: TeamRole): [["core", string], ["protocol" | "charter", string]] {
  const current = loadRoleInstructions(role);
  return [["core", current.core], [role === "lead" ? "protocol" : "charter", current.charter]];
}
export { immutable, roleConfiguration };
export function within(root: string, path: string): boolean { const r = relative(root, path); return r === "" || (r !== ".." && !r.startsWith("../") && !isAbsolute(r)); }
export function physicalPath(root: string, path: string): string {
  let existing = resolve(root, path); const suffix: string[] = [];
  while (true) { try { lstatSync(existing); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; suffix.unshift(basename(existing)); existing = dirname(existing); } }
  const result = resolve(realpathSync(existing), ...suffix);
  if (!within(root, result)) throw new Error("Path escapes the approved repository");
  return result;
}
function projectionRoot(input: ContextInput): string {
  const { worker, attemptId, controlUid, workerGid, policy } = input.projection;
  if (![worker, input.runId, attemptId].every(id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))
    || !policy.worker_identities.includes(worker) || policy.policy_revision < 4
    || input.binding.policyRevision !== policy.policy_revision
    || !Number.isSafeInteger(controlUid) || controlUid < 0 || controlUid === input.workerUid
    || !Number.isSafeInteger(workerGid) || workerGid <= 0) throw new Error("Invalid context projection identity");
  for (const root of [policy.paths.context_root, policy.paths.framework_dir]) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new Error("Non-canonical context policy root");
  }
  if (within(policy.paths.context_root, policy.paths.framework_dir) || within(policy.paths.framework_dir, policy.paths.context_root)
    || policy.sandbox.context !== "/context" || policy.sandbox.framework !== "/framework") throw new Error("Invalid context mount policy");
  return resolve(policy.paths.context_root, worker, input.runId, attemptId);
}

/** The only host-to-worker translation: both prefixes come from the installed policy. */
export function workerContextPath(policy: ContextMountPolicy, attemptRoot: string, hostPath: string): string {
  if (!isAbsolute(hostPath) || resolve(hostPath) !== hostPath) throw new Error("Non-canonical context path");
  for (const [host, worker] of [[attemptRoot, policy.sandbox.context], [policy.paths.framework_dir, policy.sandbox.framework]]) {
    if (within(host!, hostPath)) return resolve(worker!, relative(host!, hostPath));
  }
  throw new Error("Context is outside every admitted worker mount");
}

function privateProjection(input: ContextInput): void {
  const { worker, controlUid, workerGid, policy } = input.projection;
  const workerRoot = resolve(policy.paths.context_root, worker);
  for (let p = input.root; ; p = dirname(p)) {
    const s = lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== controlUid || s.gid !== workerGid || (s.mode & 0o027)
      || (p === input.root && (s.mode & 0o222))) throw new Error("Context projection is not private and control-owned");
    if (p === workerRoot) break;
  }
}


function nativePolicyContextFiles(input: ContextInput): ContextFile[] {
  const policy = input.nativePolicy;
  if (!policy) {
    if (input.projection.policy.policy_revision >= 5) throw new Error("Managed native policy is required");
    return [];
  }
  const { digest, ...body } = policy;
  const fixedSource = input.client === "codex" ? "/etc/codex/requirements.toml" : "/etc/claude-code/managed-settings.json";
  const source = input.client === "codex" ? "/context/native/codex/requirements.toml" : "/context/native/claude/managed-settings.json";
  const required = ["/context/native/managed-native-channel-relay.cjs", source,
    ...(input.client === "codex" ? ["/context/native/codex/hooks/hooks.json"] : [])];
  if (policy.client !== input.client || digest !== hashBytes(canonicalJson(body)) || policy.selectedSource !== fixedSource
    || canonicalJson(policy.aliases) !== canonicalJson([{ source, target: fixedSource }])
    || canonicalJson(policy.files.map(f => f.workerPath).sort()) !== canonicalJson(required.sort())) {
    throw new Error("Invalid native policy identity or source paths");
  }
  return policy.files.map(file => {
    if (file.hash !== hashBytes(file.content)) throw new Error("Changed native policy bytes");
    return { path: resolve(input.root, relative("/context", file.workerPath)), hash: file.hash, kind: "native-policy", readOnly: true };
  });
}

/** Create an attempt once; failed or cancelled projections remain with the run evidence. */
export function projectContext(input: ContextInput, contents: ReadonlyMap<string, string | Uint8Array>): ContextManifest {
  if (input.root !== projectionRoot(input)) throw new Error("Context projection path mismatch");
  const nativeFiles = nativePolicyContextFiles(input);
  const providedNative = input.files.filter(f => f.kind === "native-policy");
  if (new Set(providedNative.map(f => f.path)).size !== providedNative.length
    || providedNative.some(f => !nativeFiles.some(expected => expected.path === f.path && expected.hash === f.hash && f.readOnly === true && f.source === undefined))
    || input.files.some(f => f.kind !== "native-policy" && nativeFiles.some(expected => expected.path === f.path))) {
    throw new Error("Invalid native policy projection descriptors");
  }
  if (nativeFiles.length) {
    const expanded = new Map(contents);
    nativeFiles.forEach((file, index) => {
      if (expanded.has(file.path) && hashBytes(expanded.get(file.path)!) !== file.hash) throw new Error("Changed native policy projection bytes");
      expanded.set(file.path, input.nativePolicy!.files[index]!.content);
    });
    input = { ...input, files: [...input.files.filter(f => f.kind !== "native-policy"), ...nativeFiles] };
    contents = expanded;
  }
  const projected = input.files.filter(f => within(input.root, f.path));
  if (projected.some(f => f.path === input.root)) throw new Error("Context files must be strict descendants of the projection root");
  if (contents.size !== projected.length || projected.some(f => !contents.has(f.path) || hashBytes(contents.get(f.path)!) !== f.hash)) {
    throw new Error("Context projection bytes mismatch");
  }
  const workerRoot = dirname(dirname(input.root)), worker = lstatSync(workerRoot);
  if (realpathSync(workerRoot) !== workerRoot || worker.uid !== input.projection.controlUid
    || worker.gid !== input.projection.workerGid || (worker.mode & 0o027)) throw new Error("Context worker directory is not private and control-owned");
  locked(workerRoot, input);
  const runRoot = dirname(input.root);
  try { mkdirSync(runRoot, { mode: 0o2750 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const run = lstatSync(runRoot);
  if (realpathSync(runRoot) !== runRoot || run.uid !== worker.uid || run.gid !== worker.gid || (run.mode & 0o027) || !(run.mode & 0o2000)) {
    throw new Error("Context run directory is not private, setgid and control-owned");
  }
  mkdirSync(input.root, { mode: 0o2750 });
  const directories = new Set([input.root]);
  try {
    for (const f of projected) {
      workerContextPath(input.projection.policy, input.root, f.path);
      let parent = dirname(f.path);
      while (parent !== input.root) {
        if (!within(input.root, parent)) throw new Error("Context file parent escapes the projection root");
        directories.add(parent);
        const next = dirname(parent);
        if (next === parent) throw new Error("Context file parent walk escaped the projection root");
        parent = next;
      }
      mkdirSync(dirname(f.path), { recursive: true, mode: 0o2750 });
      writeFileSync(f.path, contents.get(f.path)!, { flag: "wx", mode: 0o440 });
      chmodSync(f.path, 0o440);
    }
  } finally {
    for (const dir of [...directories].sort((a, b) => b.length - a.length)) chmodSync(dir, 0o550);
  }
  return createContextManifest(input);
}

function locked(path: string, input: ContextInput): void {
  if (realpathSync(path) !== path) throw new Error("Context aliases are forbidden");
  for (let p = path; ; p = dirname(p)) {
    const s = lstatSync(p); const writable = s.mode & 0o022;
    const access = (s.mode >> ((s.gid === input.projection.workerGid || input.workerGroups.includes(s.gid)) ? 3 : 0)) & 7, needed = s.isDirectory() ? 5 : 4;
    if ((access & needed) !== needed) throw new Error("Context is not worker-readable or searchable");
    if (s.uid === input.workerUid || (writable && !(s.isDirectory() && (s.mode & 0o1000)))) throw new Error("Context or its parents are worker-writable");
    if (p === dirname(p)) break;
  }
}
/** Build the manifest for a new attempt: its core and charter must be the current pinned source. */
export function createContextManifest(input: ContextInput): ContextManifest { return buildContextManifest(input, "create"); }
/**
 * Rebuild an existing attempt's manifest from its own projection. The core and charter are held to
 * the hashes that projection recorded, not to today's source, so a later charter edit never breaks
 * the attempt's resume.
 */
export function recordedContextManifest(input: ContextInput): ContextManifest { return buildContextManifest(input, "recorded"); }
function buildContextManifest(input: ContextInput, mode: "create" | "recorded"): ContextManifest {
  const spec = structuredClone(input); spec.binding = parsePlanBinding(spec.binding); spec.assignment = parseAssignment(spec.assignment);
  const nativeFiles = nativePolicyContextFiles(spec);
  const sortedNative = (files: ContextFile[]) => files.map(f => ({ path: f.path, hash: f.hash })).sort((a, b) => a.path.localeCompare(b.path));
  if (canonicalJson(sortedNative(spec.files.filter(f => f.kind === "native-policy"))) !== canonicalJson(sortedNative(nativeFiles))) {
    throw new Error("Missing or changed native policy projection");
  }
  text(spec.runId, "runId");
  if (spec.root !== projectionRoot(spec) || spec.frameworkRoot !== spec.projection.policy.paths.framework_dir) throw new Error("Context projection path mismatch");
  if (!spec.binding.roles.includes(spec.role) || spec.assignment.role !== spec.role || !["claude-code", "codex"].includes(spec.client) || spec.frameworkRevision !== FRAMEWORK_PIN.revision) throw new Error("Context role, client or framework mismatch");
  if (!Number.isSafeInteger(spec.workerUid) || spec.workerUid <= 0 || !spec.workerGroups.every(g => Number.isSafeInteger(g) && g >= 0)) throw new Error("Invalid worker identity");
  // Every path here but the mutable state root is control-owned, so the control identity can
  // resolve it and a real path is required.
  for (const p of [spec.root, spec.frameworkRoot, ...spec.discoveryRoots]) if (!isAbsolute(p) || realpathSync(p) !== p) throw new Error("Non-canonical context root");
  // The mutable state root is the worker's own scratch: worker-owned and 0700, so the control
  // identity cannot traverse it and a realpath here fails with EACCES on every real host — the
  // producer would refuse every attempt it is asked to produce. Its canonical form is required
  // lexically instead, and the privileged launcher verifies it physically: it opens the
  // directory O_NOFOLLOW and requires the descriptor's own path to be the expected one beneath
  // the worker directory (worker-launch.mjs `openVerifiedDirectory`), which is the identity that
  // can actually see the path.
  if (!isAbsolute(spec.mutableStateRoot) || resolve(spec.mutableStateRoot) !== spec.mutableStateRoot) throw new Error("Non-canonical context root");
  privateProjection(spec);
  locked(spec.root, spec); locked(spec.frameworkRoot, spec);
  for (const root of spec.discoveryRoots) workerContextPath(spec.projection.policy, spec.root, root);
  if (within(spec.root, spec.mutableStateRoot) || within(spec.mutableStateRoot, spec.root) || within(spec.binding.repository.root, spec.root)) throw new Error("Mutable state and instructions must be separate");
  if (spec.permissions.some(p => !roleConfiguration[spec.role].permissions.includes(p))) throw new Error("Context grants a prohibited role permission");
  const kinds = spec.files.map(f => f.kind);
  if (!["framework", "role", "plan"].every(k => kinds.includes(k as ContextFile["kind"])) || new Set(spec.files.map(f => f.path)).size !== spec.files.length) throw new Error("Missing or duplicate context files");
  for (const f of spec.files) {
    if (!["framework", "role", "plan", "protocol", "roster", "run", "native-policy", "core", "charter"].includes(f.kind) || f.readOnly !== true || (f.kind !== "framework" && !within(spec.root, f.path)) || !lstatSync(f.path).isFile() || hashBytes(readFileSync(f.path)) !== f.hash) throw new Error("Projected context changed");
    workerContextPath(spec.projection.policy, spec.root, f.path);
    if (within(spec.root, f.path)) {
      const s = lstatSync(f.path);
      if (s.uid !== spec.projection.controlUid || s.gid !== spec.projection.workerGid || (s.mode & 0o227)) throw new Error("Context file is not private and read-only");
    }
    locked(f.path, spec);
    if (f.kind === "framework" && (!f.source || !within(spec.frameworkRoot, realpathSync(f.source)) || /\/(?:\.agents|\.claude|\.codex|\.opencode|\.pi)(?:\/|$)/.test(realpathSync(f.source)))) throw new Error("Framework must come from pinned source, never root runtime mirrors");
    if (f.kind === "framework") locked(f.source!, spec);
    if (f.kind === "framework" && hashBytes(readFileSync(f.source!)) !== f.hash) throw new Error("Projected framework bytes differ from pinned source");
    if (f.kind === "plan" && f.hash !== spec.binding.planDigest) throw new Error("Projected plan differs from the approval");
    if (f.kind === "role" && canonicalJson(JSON.parse(readFileSync(f.path, "utf8"))) !== canonicalJson(roleConfiguration)) throw new Error("Role configuration changed");
  }
  const single = (kind: ContextFile["kind"]) => spec.files.filter(f => f.kind === kind);
  // Each file's bytes already match its recorded hash above; a new attempt must also match today's source.
  const current = mode === "create" ? loadRoleInstructions(spec.role) : null;
  const cores = single("core");
  if (cores.length !== 1 || (current && readFileSync(cores[0]!.path, "utf8") !== current.core)) throw new Error("Missing, duplicate or changed core instructions");
  const charters = single("charter");
  if (spec.role === "lead" ? charters.length !== 0
    : charters.length !== 1 || (current && readFileSync(charters[0]!.path, "utf8") !== current.charter)) throw new Error("Missing, duplicate, changed or foreign role charter");
  if (spec.role !== "lead" && spec.files.some(f => f.kind === "protocol" || f.kind === "roster" || f.kind === "run")) {
    throw new Error("Lead-only context in a member manifest");
  }
  const charterFile = spec.role === "lead" ? single("protocol")[0] : charters[0];
  const instructionVersions: InstructionVersions = { core: instructionVersion(readFileSync(cores[0]!.path, "utf8")),
    charter: charterFile ? instructionVersion(readFileSync(charterFile.path, "utf8")) : "" };
  if (spec.role === "lead") {
    if (!spec.lead || !["protocol", "roster", "run"].every(k => kinds.filter(v => v === k).length === 1)) throw new Error("Lead activation context is incomplete");
    text(spec.lead.activationId, "activationId"); text(spec.lead.instructions, "runInstructions");
    if (!spec.lead.roster.length || new Set(spec.lead.roster.map(m => m.member)).size !== spec.lead.roster.length) throw new Error("Invalid roster");
    for (const m of spec.lead.roster) { text(m.member, "member"); text(m.mailbox, "mailbox"); if (!spec.binding.roles.includes(m.role)) throw new Error("Invalid roster role"); }
    const content = (kind: ContextFile["kind"]) => readFileSync(spec.files.find(f => f.kind === kind)!.path, "utf8");
    if (content("protocol") !== leadProtocol || canonicalJson(JSON.parse(content("roster"))) !== canonicalJson(spec.lead.roster) || content("run") !== spec.lead.instructions) throw new Error("Stale Lead protocol, roster or run instructions");
  } else if (spec.lead) throw new Error("Lead and member configuration must be separate");
  const mapped = { ...spec, files: spec.files.map(f => ({ ...f, workerPath: workerContextPath(spec.projection.policy, spec.root, f.path) })),
    workerDiscoveryRoots: spec.discoveryRoots.map(p => workerContextPath(spec.projection.policy, spec.root, p)),
    protocolVersion: spec.role === "lead" ? LEAD_PROTOCOL_VERSION : null, instructionVersions };
  return immutable({ ...mapped, generatedHash: hashBytes(canonicalJson({ ...mapped, bindingDigest: hashBinding(spec.binding) })) });
}
export function verifyEffectiveContext(manifest: ContextManifest, observed: ContextObservation): string {
  const { generatedHash, protocolVersion, instructionVersions: recorded, ...input } = manifest;
  if (protocolVersion !== (input.role === "lead" ? LEAD_PROTOCOL_VERSION : null)) throw new Error("Protocol version changed");
  const rebuilt = recordedContextManifest(input);
  if (canonicalJson(recorded) !== canonicalJson(rebuilt.instructionVersions)) throw new Error("Role instruction version changed");
  if (rebuilt.generatedHash !== generatedHash) throw new Error("Context changed before launch or resume");
  const files = (items: ContextObservation["files"]) => [...items].sort((a, b) => a.path.localeCompare(b.path));
  if (canonicalJson([...observed.discoveryRoots].sort()) !== canonicalJson([...manifest.workerDiscoveryRoots].sort()) || canonicalJson(files(observed.files)) !== canonicalJson(files(manifest.files.map(({ workerPath, hash }) => ({ path: workerPath, hash }))))) throw new Error("Unexpected or unobserved instruction source");
  return hashBytes(canonicalJson(observed));
}

export interface ManagedNativePolicy {
  client: ContextInput["client"];
  selectedSource: string;
  relayCommand: string;
  hookDigest: string;
  files: { workerPath: string; content: string; hash: string }[];
  aliases: { source: string; target: string }[];
  digest: string;
}
export interface ManagedNativePolicyObservation {
  files: { path: string; hash: string }[];
  aliases: { path: string; hash: string }[];
  /** Supplied by the control observer after inventory, never inferred from expected configuration. */
  inventory: {
    selectedSource: string | null;
    managedDropIns: "absent" | "present" | "unknown";
    remotePolicy: "absent" | "present" | "unknown";
    platformPolicy: "not-applicable" | "present" | "unknown";
    nativeExceptions: "absent" | "present" | "unknown";
  };
}

/** Build only immutable policy bytes. Provider sign-in and writable native state stay in the worker home. */
export async function buildManagedNativePolicy(client: ContextInput["client"], toolchainDir: string): Promise<ManagedNativePolicy> {
  if (!isAbsolute(toolchainDir) || resolve(toolchainDir) !== toolchainDir || toolchainDir === "/"
    || /[^A-Za-z0-9._/-]/.test(toolchainDir)) throw new Error("Invalid native policy toolchain path");
  if (client !== "claude-code" && client !== "codex") throw new Error("Invalid native policy client");
  const relayPath = "/context/native/managed-native-channel-relay.cjs";
  const relayCommand = '"' + toolchainDir + '/node/bin/node" "' + relayPath + '"';
  const files = [{ workerPath: relayPath,
    content: readFileSync(new URL("../../../assets/managed-native-channel-relay.cjs", import.meta.url), "utf8") }];
  const aliases: ManagedNativePolicy["aliases"] = [];
  let selectedSource: string, hookDigest: string | null;
  if (client === "claude-code") {
    const { upsertClaudeNativeChannelHook, claudeNativeChannelDigest } = await import("../../adapters/claude-code-adapter.js");
    const content = upsertClaudeNativeChannelHook('{"allowManagedHooksOnly":true,"disableAllHooks":false}', relayCommand);
    const workerPath = "/context/native/claude/managed-settings.json";
    selectedSource = "/etc/claude-code/managed-settings.json";
    files.push({ workerPath, content }); aliases.push({ source: workerPath, target: selectedSource });
    hookDigest = claudeNativeChannelDigest([content], relayCommand);
  } else {
    const { upsertCodexNativeChannelHook, codexNativeChannelDigest } = await import("../../adapters/codex-runtime-adapter.js");
    const { parse, stringify } = await import("smol-toml");
    const hooksPath = "/context/native/codex/hooks/hooks.json";
    const installed = parse(upsertCodexNativeChannelHook("", relayCommand, hooksPath));
    const hooks = { PostToolUse: (installed.hooks as { PostToolUse: unknown }).PostToolUse };
    // Managed JSON hooks are trusted by their immutable source, not a mutable user trust table.
    files.push({ workerPath: hooksPath, content: JSON.stringify({ hooks }, null, 2) + "\n" });
    const workerPath = "/context/native/codex/requirements.toml";
    selectedSource = "/etc/codex/requirements.toml";
    files.push({ workerPath, content: 'allow_managed_hooks_only = true\n[features]\nhooks = true\n[hooks]\nmanaged_dir = "/context/native/codex/hooks"\n' });
    aliases.push({ source: workerPath, target: selectedSource });
    hookDigest = codexNativeChannelDigest(stringify({ features: { hooks: true }, hooks }), relayCommand);
  }
  if (!hookDigest) throw new Error("Invalid native policy hook configuration");
  const body = { client, selectedSource, relayCommand, hookDigest, aliases,
    files: files.map(file => ({ ...file, hash: hashBytes(file.content) })) };
  return immutable({ ...body, digest: hashBytes(canonicalJson(body)) });
}

/** Compare actual fixed aliases, handlers and source-selection facts; this function does not observe a process. */
export function verifyEffectiveNativePolicy(policy: ManagedNativePolicy, observed: ManagedNativePolicyObservation): string {
  const { digest, ...body } = policy;
  const inventory: ManagedNativePolicyObservation["inventory"] = { selectedSource: policy.selectedSource,
    managedDropIns: "absent", remotePolicy: "absent", platformPolicy: "not-applicable", nativeExceptions: "absent" };
  const files = policy.files.map(f => ({ path: f.workerPath, hash: hashBytes(f.content) }));
  const aliases = policy.aliases.map(alias => ({ path: alias.target, hash: files.find(f => f.path === alias.source)?.hash }));
  const sorted = <T extends { path: string }>(items: T[]) => [...items].sort((a, b) => a.path.localeCompare(b.path));
  if (digest !== hashBytes(canonicalJson(body)) || policy.files.some(f => f.hash !== hashBytes(f.content))
    || Object.keys(observed.inventory ?? {}).length !== Object.keys(inventory).length
    || Object.entries(inventory).some(([key, value]) => observed.inventory?.[key as keyof typeof inventory] !== value)
    || canonicalJson(sorted(observed.files)) !== canonicalJson(sorted(files))
    || canonicalJson(sorted(observed.aliases)) !== canonicalJson(sorted(aliases))) {
    throw new Error("Unobserved or altered effective native policy");
  }
  return hashBytes(canonicalJson({ policyDigest: digest, inventory: observed.inventory,
    files: sorted(observed.files), aliases: sorted(observed.aliases) }));
}
