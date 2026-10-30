import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { canonicalJson, type PlanBinding, type ScopeExtension, type ScopeProjection, type TeamApproval, type TeamRun, type TeamTaskAuthority } from "../contracts/team-control.js";
import { candidatePath } from "./team-workspace.js";

export interface CandidateScopeEvidence {
  root: string;
  candidateDigest: string;
  files: readonly string[];
  changes: Array<{ path: string; before: Buffer | null; after: Buffer | null }>;
}
const hash = (value: unknown) => "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex");
const canonical = (root: string, path: string) => relative(realpathSync(root), candidatePath(root, path, true)).replaceAll("\\", "/");
const covers = (path: string, paths: readonly string[]) => paths.some(owned => path === owned || path.startsWith(owned + "/"));
const credentialPatterns: RegExp[] = JSON.parse(readFileSync(
  new URL("../../../../config/governance/credential-exclusions.json", import.meta.url), "utf8",
)).patterns.map((pattern: string) => new RegExp(pattern));
export const credentialExcluded = (path: string): boolean => credentialPatterns.some(pattern => pattern.test(path));

const protectedPath = (path: string) =>
  /^(docs\/(?:plans|tasks)|engine\/config\/(?:isolation|governance))(\/|$)/.test(path)
  || /(^|\/)(contracts|migrations|\.github|\.circleci|\.buildkite|\.husky)(\/|$)/.test(path)
  || /(^|\/)(?:all-migrations\.ts|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/.test(path)
  || /(^|\/)(?:Cargo\.(?:toml|lock)|pyproject\.toml|(?:poetry|uv)\.lock|requirements[^/]*\.txt|go\.(?:mod|sum)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|pnpm-workspace\.ya?ml|\.yarnrc\.ya?ml)$/.test(path)
  || /(^|\/)(?:Jenkinsfile|(?:\.gitlab-ci|azure-pipelines|\.travis|\.?appveyor|bitbucket-pipelines|\.?drone|cloudbuild)\.ya?ml)$/.test(path)
  || /^engine\/packages\/daemon\/src\/(?:index\.ts|startup\.ts|server\.ts|domain\/(?:plan-governance|queue-repository|workflow-runtime|scope-extension)\.ts|adapters\/(?:tmux\.ts|worker-launch[^/]*\.ts)|middleware\/|routes\/team-control\.ts)/.test(path)
  || credentialExcluded(path);

export class ScopeExtensionError extends Error {
  constructor(readonly code: "extension-pending" | "plan-change-required", readonly rule: string, readonly extension?: ScopeExtension) {
    super(code + ": " + rule);
  }
}


interface ScopePolicy { packages: string[]; maxPathsPerRequest: number; maxApprovedExtensionsPerTask: number; }
function scopePolicy(): ScopePolicy {
  try {
    const policy = JSON.parse(readFileSync(new URL("../../../../config/governance/low-risk-dev-dependencies.json", import.meta.url), "utf8")) as ScopePolicy;
    if (!Array.isArray(policy.packages) || !policy.packages.every(value => typeof value === "string" && value.length > 0)
      || ![policy.maxPathsPerRequest, policy.maxApprovedExtensionsPerTask].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error();
    return policy;
  } catch { throw new ScopeExtensionError("plan-change-required", "scope-policy-unavailable"); }
}
const dependencyPath = (path: string) => /(^|\/)(package\.json|package-lock\.json)$/.test(path);
const matches = (name: string, pattern: string) => new RegExp("^" + pattern.split("*")
  .map(part => part.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&")).join("[^/]+") + "$").test(name);
const exactVersion = (version: unknown): version is string => typeof version === "string"
  && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version);
type Document = Record<string, unknown>;
function document(value: unknown): Document {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScopeExtensionError("plan-change-required", "dependency-format");
  return value as Document;
}
const without = (value: Document, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const differs = (left: unknown, right: unknown) => canonicalJson(left ?? null) !== canonicalJson(right ?? null);
const keys = (left: Document, right: Document) => [...new Set([...Object.keys(left), ...Object.keys(right)])];

/** Inspect only the frozen diff. No package manager, candidate configuration or network request is executed. */
function checkDependencies(changes: CandidateScopeEvidence["changes"], policy: ScopePolicy): ScopeExtension["packages"] {
  const fail = (rule: string): never => { throw new ScopeExtensionError("plan-change-required", rule); };
  const locks = changes.filter(change => basename(change.path) === "package-lock.json");
  if (locks.length !== 1 || changes.length < 2) return fail("dependency-pair");
  const lock = locks[0]!, root = dirname(lock.path);
  const parse = (bytes: Buffer | null) => {
    if (bytes === null) return fail("dependency-file-created-or-deleted");
    try { return document(JSON.parse(bytes.toString("utf8"))); } catch { return fail("dependency-format"); }
  };
  const before = parse(lock.before), after = parse(lock.after);
  if (before.lockfileVersion !== 3 || after.lockfileVersion !== 3
    || differs(without(before, "packages"), without(after, "packages"))) return fail("lockfile-v3-only");
  const oldEntries = document(before.packages), newEntries = document(after.packages);
  const packageChanges: ScopeExtension["packages"] = [], roots: Array<{ key: string; names: string[] }> = [];
  const manifests = new Set<string>();
  for (const change of changes.filter(change => change !== lock)) {
    if (basename(change.path) !== "package.json") return fail("dependency-pair");
    const key = relative(root, dirname(change.path)).replaceAll("\\", "/");
    if (key === ".." || key.startsWith("../")) return fail("dependency-pair");
    manifests.add(key);
    const oldManifest = parse(change.before), newManifest = parse(change.after);
    if (differs(without(oldManifest, "devDependencies"), without(newManifest, "devDependencies"))) return fail("dev-dependencies-only");
    const oldDev = document(oldManifest.devDependencies ?? {}), newDev = document(newManifest.devDependencies ?? {});
    const names = keys(oldDev, newDev).filter(name => differs(oldDev[name], newDev[name]));
    if (!names.length) return fail("no-dependency-change");
    const oldRoot = document(oldEntries[key]), newRoot = document(newEntries[key]);
    if (differs(oldRoot.devDependencies ?? {}, oldDev) || differs(newRoot.devDependencies ?? {}, newDev)
      || differs(without(oldRoot, "devDependencies"), without(newRoot, "devDependencies"))) return fail("lock-manifest-mismatch");
    for (const name of names) {
      const version = newDev[name] ?? oldDev[name], matched = policy.packages.find(pattern => matches(name, pattern));
      if (!matched) return fail("dependency-not-listed");
      if (!exactVersion(version)) return fail("dependency-version-not-exact");
      packageChanges.push({ name, version, matched });
    }
    roots.push({ key, names });
  }
  let allow: string[];
  try {
    const network = JSON.parse(readFileSync("/etc/multi-agent/egress.json", "utf8"));
    if (network.schema !== "multi-agent-egress/v1" || !Array.isArray(network.allow)
      || !network.allow.every((entry: unknown) => typeof entry === "string")) throw new Error();
    allow = network.allow;
  } catch { return fail("registry-policy-unavailable"); }
  const reachable = new Set<string>();
  for (const entries of [oldEntries, newEntries]) {
    const resolvePackage = (from: string, name: string): string | undefined => {
      let at = from;
      while (true) {
        const key = (at ? at + "/" : "") + "node_modules/" + name;
        if (Object.hasOwn(entries, key)) return key;
        if (!at) return undefined;
        at = dirname(at); if (at === ".") at = "";
      }
    };
    const pending: string[] = [];
    for (const entry of roots) {
      const direct = document(document(entries[entry.key]).devDependencies ?? {});
      for (const name of entry.names) {
        if (!Object.hasOwn(direct, name)) continue;
        const key = resolvePackage(entry.key, name);
        if (!key || document(entries[key]).version !== direct[name]) return fail("lock-version-mismatch");
        pending.push(key);
      }
    }
    const visited = new Set<string>();
    while (pending.length) {
      const key = pending.pop()!;
      if (visited.has(key)) continue;
      visited.add(key); reachable.add(key);
      const entry = document(entries[key]);
      for (const name of keys(document(entry.dependencies ?? {}), document(entry.optionalDependencies ?? {}))) {
        const child = resolvePackage(key, name);
        if (child) pending.push(child);
      }
    }
  }
  for (const key of keys(oldEntries, newEntries).filter(key => differs(oldEntries[key], newEntries[key]) && !manifests.has(key))) {
    if (!reachable.has(key)) return fail("unrelated-lock-change");
    for (const value of [oldEntries[key], newEntries[key]].filter(value => value !== undefined)) {
      const entry = document(value);
      if (entry.dev !== true) return fail("non-dev-lock-change");
      if (Object.hasOwn(entry, "hasInstallScript")) return fail("dependency-install-script");
      if (!exactVersion(entry.version)) return fail("lock-version-not-exact");
      if (typeof entry.integrity !== "string" || !/^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
        || Buffer.from(entry.integrity.split("-")[1]!, "base64").length !== Number(entry.integrity.slice(3).split("-")[0]) / 8) return fail("dependency-integrity");
      try {
        const url = new URL(String(entry.resolved));
        if (url.protocol !== "https:" || url.username || url.password || !allow.includes(url.hostname + ":" + (url.port || "443"))) return fail("dependency-registry");
      } catch { return fail("dependency-registry"); }
    }
  }
  return packageChanges;
}

export class ScopeExtensions {
  constructor(private readonly db: Database.Database) {}

  currentBinding(run: TeamRun): PlanBinding | null {
    try {
      const bytes = readFileSync(candidatePath(run.binding.repository.root, run.binding.planRef));
      return { ...run.binding, planDigest: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
    } catch { return null; }
  }

  records(runId: string, taskId: string): ScopeExtension[] {
    const rows = this.db.prepare("SELECT a.id, a.binding_digest AS bindingDigest, a.state, a.decision_actor AS decisionActor, " +
      "a.payload_json AS payload, e.chain_head AS chainHead, e.automatic FROM team_scope_extensions e " +
      "JOIN team_approvals a ON a.id = e.approval_id WHERE a.run_id = ? AND e.task_id = ? ORDER BY e.rowid")
      .all(runId, taskId) as Array<{ id: string; bindingDigest: string; state: TeamApproval["state"]; decisionActor: string | null; payload: string; chainHead: string | null; automatic: number }>;
    return rows.map(({ payload, automatic, ...row }) => ({ ...JSON.parse(payload), ...row, automatic: automatic === 1 }));
  }

  projection(run: TeamRun, task: TeamTaskAuthority): ScopeProjection {
    const extensions = this.records(run.id, task.assignment.taskId);
    const current = extensions.filter(record => record.bindingDigest === run.bindingDigest && record.state === "approved");
    const chainHead = current.at(-1)?.chainHead ?? hash({ bindingDigest: run.bindingDigest, taskId: task.assignment.taskId });
    return { chainHead, scopeDigest: hash({ assignmentDigest: hash(task.assignment), chainHead }), extensions };
  }

  stage(run: TeamRun, task: TeamTaskAuthority, evidence: CandidateScopeEvidence, now: string):
    { projection: ScopeProjection; created: ScopeExtension | null; invalidated: string[]; refusal: ScopeExtensionError | null } {
    const projection = this.projection(run, task), invalidated: string[] = [];
    for (const item of projection.extensions) {
      if (item.bindingDigest !== run.bindingDigest || item.state !== "pending"
        || (item.candidateDigest === evidence.candidateDigest && item.expectedChainHead === projection.chainHead)) continue;
      this.db.prepare("UPDATE team_approvals SET state = 'invalidated', entity_version = entity_version + 1, updated_at = ? WHERE id = ?")
        .run(now, item.id);
      item.state = "invalidated";
      invalidated.push(item.id);
    }
    const approved = projection.extensions.filter(item => item.bindingDigest === run.bindingDigest && item.state === "approved");
    const effective = [...task.assignment.paths, ...approved.flatMap(item => item.paths.flatMap(path => [path.path, path.canonicalPath]))];
    let paths: ScopeExtension["paths"] = [];
    const dependencyEdits: CandidateScopeEvidence["changes"] = [];
    for (const change of evidence.changes) {
      let canonicalPath: string;
      try { canonicalPath = canonical(evidence.root, change.path); }
      catch { throw new ScopeExtensionError("plan-change-required", "path-escape"); }
      if (covers(change.path, task.assignment.paths) && covers(canonicalPath, task.assignment.paths)) continue;
      const dependency = dependencyPath(change.path);
      if (!dependency && covers(change.path, effective) && covers(canonicalPath, effective)) continue;
      if (!covers(change.path, run.binding.writePaths) || !covers(canonicalPath, run.binding.writePaths)) {
        throw new ScopeExtensionError("plan-change-required", "outside-write-paths");
      }
      if (change.path === run.binding.planRef || canonicalPath === run.binding.planRef || protectedPath(change.path) || protectedPath(canonicalPath)) {
        throw new ScopeExtensionError("plan-change-required", "protected-path");
      }
      if (dependency) {
        if (change.path !== canonicalPath) throw new ScopeExtensionError("plan-change-required", "dependency-alias");
        dependencyEdits.push(change);
      }
      paths.push({ path: change.path, canonicalPath, operation: change.before === null ? "create" : "modify",
        evidenceDigest: hash([change.before, change.after].map(bytes => bytes === null ? null : createHash("sha256").update(bytes).digest("hex"))) });
    }
    if (!paths.length) return { projection, created: null, invalidated, refusal: null };
    this.checkForeign(run, task, paths);
    const policy = scopePolicy();
    const packages = dependencyEdits.length ? checkDependencies(dependencyEdits, policy) : [];
    const dependencyDigest = dependencyEdits.length ? hash(paths.filter(path => dependencyPath(path.path))) : null;
    if (dependencyDigest && approved.some(item => item.dependencyDigest === dependencyDigest)) paths = paths.filter(path => !dependencyPath(path.path));
    if (!paths.length) return { projection, created: null, invalidated, refusal: null };
    const rejected = projection.extensions.find(item => item.bindingDigest === run.bindingDigest && item.state === "rejected"
      && item.paths.some(previous => paths.some(path => path.canonicalPath === previous.canonicalPath && path.evidenceDigest === previous.evidenceDigest)));
    if (rejected) return { projection, created: null, invalidated, refusal: new ScopeExtensionError("plan-change-required", "extension-rejected", rejected) };
    const prior = projection.extensions.find(item => item.bindingDigest === run.bindingDigest && item.state === "pending"
      && item.candidateDigest === evidence.candidateDigest && item.expectedChainHead === projection.chainHead
      && canonicalJson(item.paths) === canonicalJson(paths));
    if (prior) return { projection, created: null, invalidated, refusal: new ScopeExtensionError("extension-pending", "owner-decision", prior) };
    if (paths.length > policy.maxPathsPerRequest) throw new ScopeExtensionError("plan-change-required", "path-cap");
    if (approved.length >= policy.maxApprovedExtensionsPerTask) throw new ScopeExtensionError("plan-change-required", "extension-cap");
    const ownedFiles = effective.filter(path => evidence.files.includes(path));
    const automatic = packages.length === 0 && paths.every(path => path.operation === "create" && path.path === path.canonicalPath
      && ownedFiles.some(owned => dirname(owned) === dirname(path.path)));
    const attempt = this.db.prepare("SELECT id FROM team_attempts WHERE run_id = ? AND qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(run.id, task.qitemId) as { id: string } | undefined;
    const reason = typeof task.evidence?.scopeExtensionReason === "string" ? task.evidence.scopeExtensionReason.slice(0, 4096) : "no reason given";
    const payload = { runId: run.id, taskId: task.assignment.taskId, attemptId: attempt?.id ?? null, paths, reason,
      candidateDigest: evidence.candidateDigest, assignmentDigest: hash(task.assignment), expectedChainHead: projection.chainHead, packages, dependencyDigest,
      classification: automatic ? "new-sibling" : packages.length ? "low-risk-dev-dependencies" : "owner-decision" };
    const id = randomUUID(), payloadDigest = hash(payload);
    const chainHead = automatic ? hash({ previous: projection.chainHead, id, payloadDigest }) : null;
    this.db.prepare("INSERT INTO team_approvals (id, run_id, kind, action, payload_json, payload_digest, target_digest, binding_digest, state, " +
      "expires_at, decision_actor, created_at, updated_at) VALUES (?, ?, 'orchestrator', 'scope-extension', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, run.id, canonicalJson(payload), payloadDigest, hash({ bindingDigest: run.bindingDigest, ...payload }), run.bindingDigest,
        automatic ? "approved" : "pending", "9999-12-31T23:59:59.999Z", automatic ? "daemon:auto-scope" : null, now, now);
    this.db.prepare("INSERT INTO team_scope_extensions (approval_id, task_id, chain_head, automatic) VALUES (?, ?, ?, ?)")
      .run(id, task.assignment.taskId, chainHead, automatic ? 1 : 0);
    const current = this.projection(run, task), created = current.extensions.find(item => item.id === id)!;
    return { projection: current, created, invalidated, refusal: automatic ? null : new ScopeExtensionError("extension-pending", "owner-decision", created) };
  }

  private checkForeign(run: TeamRun, task: TeamTaskAuthority, paths: ScopeExtension["paths"]): void {
    const others = this.db.prepare("SELECT assignment_json FROM team_queue_authority WHERE run_id = ? AND task_id <> ?")
      .all(run.id, task.assignment.taskId) as Array<{ assignment_json: string }>;
    for (const row of others) {
      const assignment = JSON.parse(row.assignment_json) as TeamTaskAuthority["assignment"];
      if (assignment.role === "reviewer") continue;
      const foreign = [...assignment.paths.flatMap(path => [path, canonical(run.binding.repository.root, path)]), ...this.records(run.id, assignment.taskId)
        .filter(item => item.bindingDigest === run.bindingDigest && item.state === "approved").flatMap(item => item.paths.flatMap(path => [path.path, path.canonicalPath]))];
      if (paths.some(path => covers(path.path, foreign) || covers(path.canonicalPath, foreign)
        || foreign.some(other => covers(other, [path.path, path.canonicalPath])))) {
        throw new ScopeExtensionError("plan-change-required", "other-task-scope");
      }
    }
  }

  decide(run: TeamRun, task: TeamTaskAuthority, approval: TeamApproval, expectedChainHead: unknown, decision: "approved" | "rejected"): void {
    const current = this.projection(run, task);
    const extension = current.extensions.find(item => item.id === approval.id);
    if (!extension || extension.bindingDigest !== run.bindingDigest) throw new Error("Scope extension not found in this binding");
    if (expectedChainHead !== extension.expectedChainHead || expectedChainHead !== current.chainHead) throw new Error("Scope extension chain head conflict");
    if (decision === "approved") {
      if (extension.assignmentDigest !== hash(task.assignment)) throw new Error("Scope extension assignment conflict");
      this.checkForeign(run, task, extension.paths);
      const policy = scopePolicy();
      if (extension.paths.length > policy.maxPathsPerRequest) throw new ScopeExtensionError("plan-change-required", "path-cap");
      if (current.extensions.filter(item => item.bindingDigest === run.bindingDigest && item.state === "approved").length >= policy.maxApprovedExtensionsPerTask) {
        throw new ScopeExtensionError("plan-change-required", "extension-cap");
      }
      this.db.prepare("UPDATE team_scope_extensions SET chain_head = ? WHERE approval_id = ?")
        .run(hash({ previous: current.chainHead, id: approval.id, payloadDigest: approval.payloadDigest }), approval.id);
    }
  }
}
