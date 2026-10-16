import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, parseAssignment, parsePlanBinding, text, type PlanBinding, type ScopedAssignment, type TeamRole } from "../../contracts/team-control.js";
import { hashBinding, hashBytes } from "../../domain/plan-governance.js";
import { FRAMEWORK_PIN } from "./catalog.js";

export interface ContextFile { path: string; hash: string; kind: "framework" | "role" | "plan" | "protocol" | "roster" | "run"; readOnly: true; source?: string }
export interface ContextInput {
  runId: string; assignment: ScopedAssignment; outputs: string[]; permissions: string[]; role: TeamRole; client: "claude-code" | "codex"; binding: PlanBinding;
  root: string; mutableStateRoot: string; frameworkRoot: string; frameworkRevision: string;
  workerUid: number; workerGroups: number[]; discoveryRoots: string[]; files: ContextFile[];
  lead?: { activationId: string; roster: { member: string; role: TeamRole; mailbox: string }[]; instructions: string };
}
export type ContextManifest = Readonly<ContextInput & { generatedHash: string; protocolVersion: string | null }>;
export interface ContextObservation { discoveryRoots: string[]; files: { path: string; hash: string }[] }
export const roleConfiguration = immutable(JSON.parse(readFileSync(new URL("../../../../../config/team/roles.json", import.meta.url), "utf8"))) as Record<TeamRole, { client: ContextInput["client"]; permissions: string[] }>;
export const leadProtocol = readFileSync(new URL("../../../../../config/team/lead-protocol.md", import.meta.url), "utf8");
export const LEAD_PROTOCOL_VERSION = "1";
export function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
export function within(root: string, path: string): boolean { const r = relative(root, path); return r === "" || (r !== ".." && !r.startsWith("../") && !isAbsolute(r)); }
export function physicalPath(root: string, path: string): string {
  let existing = resolve(root, path); const suffix: string[] = [];
  while (true) { try { lstatSync(existing); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; suffix.unshift(basename(existing)); existing = dirname(existing); } }
  const result = resolve(realpathSync(existing), ...suffix);
  if (!within(root, result)) throw new Error("Path escapes the approved repository");
  return result;
}
function locked(path: string, input: ContextInput): void {
  if (realpathSync(path) !== path) throw new Error("Context aliases are forbidden");
  for (let p = path; ; p = dirname(p)) {
    const s = lstatSync(p); const writable = s.mode & 0o022;
    const access = (s.mode >> (input.workerGroups.includes(s.gid) ? 3 : 0)) & 7, needed = s.isDirectory() ? 5 : 4;
    if ((access & needed) !== needed) throw new Error("Context is not worker-readable or searchable");
    if (s.uid === input.workerUid || (writable && !(s.isDirectory() && (s.mode & 0o1000)))) throw new Error("Context or its parents are worker-writable");
    if (p === dirname(p)) break;
  }
}
export function createContextManifest(input: ContextInput): ContextManifest {
  const spec = structuredClone(input); spec.binding = parsePlanBinding(spec.binding); spec.assignment = parseAssignment(spec.assignment);
  text(spec.runId, "runId");
  if (!spec.binding.roles.includes(spec.role) || spec.assignment.role !== spec.role || !["claude-code", "codex"].includes(spec.client) || spec.frameworkRevision !== FRAMEWORK_PIN.revision) throw new Error("Context role, client or framework mismatch");
  if (!Number.isSafeInteger(spec.workerUid) || spec.workerUid <= 0 || !spec.workerGroups.every(g => Number.isSafeInteger(g) && g >= 0)) throw new Error("Invalid worker identity");
  for (const p of [spec.root, spec.mutableStateRoot, spec.frameworkRoot, ...spec.discoveryRoots]) if (!isAbsolute(p) || realpathSync(p) !== p) throw new Error("Non-canonical context root");
  if (within(spec.root, spec.mutableStateRoot) || within(spec.mutableStateRoot, spec.root) || within(spec.binding.repository.root, spec.root)) throw new Error("Mutable state and instructions must be separate");
  if (spec.permissions.some(p => !roleConfiguration[spec.role].permissions.includes(p))) throw new Error("Context grants a prohibited role permission");
  const kinds = spec.files.map(f => f.kind);
  if (!["framework", "role", "plan"].every(k => kinds.includes(k as ContextFile["kind"])) || new Set(spec.files.map(f => f.path)).size !== spec.files.length) throw new Error("Missing or duplicate context files");
  for (const f of spec.files) {
    if (!["framework", "role", "plan", "protocol", "roster", "run"].includes(f.kind) || f.readOnly !== true || !within(spec.root, f.path) || !lstatSync(f.path).isFile() || hashBytes(readFileSync(f.path)) !== f.hash) throw new Error("Projected context changed");
    locked(f.path, spec);
    if (f.kind === "framework" && (!f.source || !within(spec.frameworkRoot, realpathSync(f.source)) || /\/(?:\.agents|\.claude|\.codex|\.opencode|\.pi)(?:\/|$)/.test(realpathSync(f.source)))) throw new Error("Framework must come from pinned source, never root runtime mirrors");
    if (f.kind === "framework") locked(f.source!, spec);
    if (f.kind === "framework" && hashBytes(readFileSync(f.source!)) !== f.hash) throw new Error("Projected framework bytes differ from pinned source");
    if (f.kind === "plan" && f.hash !== spec.binding.planDigest) throw new Error("Projected plan differs from the approval");
    if (f.kind === "role" && canonicalJson(JSON.parse(readFileSync(f.path, "utf8"))) !== canonicalJson(roleConfiguration)) throw new Error("Role configuration changed");
  }
  if (spec.role === "lead") {
    if (!spec.lead || !["protocol", "roster", "run"].every(k => kinds.filter(v => v === k).length === 1)) throw new Error("Lead activation context is incomplete");
    text(spec.lead.activationId, "activationId"); text(spec.lead.instructions, "runInstructions");
    if (!spec.lead.roster.length || new Set(spec.lead.roster.map(m => m.member)).size !== spec.lead.roster.length) throw new Error("Invalid roster");
    for (const m of spec.lead.roster) { text(m.member, "member"); text(m.mailbox, "mailbox"); if (!spec.binding.roles.includes(m.role)) throw new Error("Invalid roster role"); }
    const content = (kind: ContextFile["kind"]) => readFileSync(spec.files.find(f => f.kind === kind)!.path, "utf8");
    if (content("protocol") !== leadProtocol || canonicalJson(JSON.parse(content("roster"))) !== canonicalJson(spec.lead.roster) || content("run") !== spec.lead.instructions) throw new Error("Stale Lead protocol, roster or run instructions");
  } else if (spec.lead) throw new Error("Lead and member configuration must be separate");
  return immutable({ ...spec, protocolVersion: spec.role === "lead" ? LEAD_PROTOCOL_VERSION : null, generatedHash: hashBytes(canonicalJson({ ...spec, bindingDigest: hashBinding(spec.binding), protocolVersion: spec.role === "lead" ? LEAD_PROTOCOL_VERSION : null })) });
}
export function verifyEffectiveContext(manifest: ContextManifest, observed: ContextObservation): string {
  const { generatedHash, protocolVersion, ...input } = manifest;
  if (protocolVersion !== (input.role === "lead" ? LEAD_PROTOCOL_VERSION : null)) throw new Error("Protocol version changed");
  if (createContextManifest(input).generatedHash !== generatedHash) throw new Error("Context changed before launch or resume");
  const files = (items: ContextObservation["files"]) => [...items].sort((a, b) => a.path.localeCompare(b.path));
  if (canonicalJson([...observed.discoveryRoots].sort()) !== canonicalJson([...manifest.discoveryRoots].sort()) || canonicalJson(files(observed.files)) !== canonicalJson(files(manifest.files.map(({ path, hash }) => ({ path, hash }))))) throw new Error("Unexpected or unobserved instruction source");
  return hashBytes(canonicalJson(observed));
}
