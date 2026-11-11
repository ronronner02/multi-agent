import nodePath from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { launchManagedHarness, checkManagedReady, type WorkerLauncher } from "./worker-launch.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import type { ProjectionPlan } from "../domain/projection-planner.js";

export interface CodexAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
  readdir?(dirPath: string): string[];
  homedir?: string;
}
function targetFor(entry: ProjectionPlan["entries"][number], cwd: string): string {
  switch (entry.category) {
    case "skill": return nodePath.join(cwd, ".agents", "skills", entry.effectiveId);
    case "plugin": return nodePath.join(cwd, ".codex", "plugins", entry.effectiveId);
    case "subagent": return nodePath.join(cwd, ".agents", `${entry.effectiveId}.md`);
    case "runtime_resource": return nodePath.join(cwd, ".agents", "extensions", entry.effectiveId);
    case "guidance": return entry.target ? nodePath.resolve(cwd, entry.target) : nodePath.join(cwd, "AGENTS.md");
  }
}
function projectFiles(fs: CodexAdapterFsOps, source: string, target: string): void {
  const writeOne = (sourcePath: string, targetPath: string) => {
    fs.mkdirp(nodePath.dirname(targetPath));
    const content = fs.readFile(sourcePath);
    if (!fs.exists(targetPath) || fs.readFile(targetPath) !== content) fs.writeFile(targetPath, content);
    if (fs.statMode && fs.chmod) fs.chmod(targetPath, fs.statMode(sourcePath) & 0o777);
  };
  if (fs.readdir) {
    const walk = (sourceDir: string, targetDir: string) => {
      for (const name of fs.readdir!(sourceDir)) {
        const sourcePath = nodePath.join(sourceDir, name);
        const targetPath = nodePath.join(targetDir, name);
        try { walk(sourcePath, targetPath); } catch { writeOne(sourcePath, targetPath); }
      }
    };
    try { walk(source, target); return; } catch { /* file-shaped source */ }
  }
  if (fs.listFiles) {
    for (const relative of fs.listFiles(source)) writeOne(nodePath.join(source, relative), nodePath.join(target, relative));
    return;
  }
  writeOne(source, target);
}
function sourceExists(fs: CodexAdapterFsOps, source: string): boolean {
  return fs.exists(source) || Boolean(fs.listFiles?.(source)?.length);
}
/** Native Codex adapter. Provider turns are always handed to DirectWorkerLauncher. */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "codex";
  readonly managedTransport = "direct" as const;
  private readonly workerLauncher?: WorkerLauncher;
  private readonly fs: CodexAdapterFsOps;
  private readonly codexHome: string | null;
  constructor(deps: { fsOps: CodexAdapterFsOps; workerLauncher?: WorkerLauncher; codexHome?: string; [key: string]: unknown }) {
    this.workerLauncher = deps.workerLauncher;
    this.fs = deps.fsOps;
    this.codexHome = deps.codexHome ?? (deps.fsOps.homedir ? nodePath.join(deps.fsOps.homedir, ".codex") : null);
  }
  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const root = nodePath.join(binding.cwd, ".agents", "skills");
    if (!this.fs.exists(root) || !this.fs.listFiles) return [];
    return this.fs.listFiles(root).map(file => ({ effectiveId: file, category: "skill", installedPath: nodePath.join(root, file) }));
  }
  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [], skipped: string[] = [], failed: Array<{ effectiveId: string; error: string }> = [];
    for (const entry of plan.entries) {
      if (entry.classification === "no_op") { skipped.push(entry.effectiveId); continue; }
      if (entry.category === "plugin") {
        const pluginType = entry.pluginType ?? "auto";
        if (pluginType === "claude" || (pluginType === "auto" && !sourceExists(this.fs, nodePath.join(entry.absolutePath, ".codex-plugin")))) {
          skipped.push(entry.effectiveId);
          continue;
        }
      }
      try { if (!sourceExists(this.fs, entry.absolutePath)) throw new Error("projection source is missing"); projectFiles(this.fs, entry.absolutePath, targetFor(entry, binding.cwd)); projected.push(entry.effectiveId); }
      catch (error) { failed.push({ effectiveId: entry.effectiveId, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { projected, skipped, failed };
  }
  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const failed: Array<{ path: string; error: string }> = []; let delivered = 0;
    for (const file of files) { try { const target = nodePath.isAbsolute(file.path) ? file.path : nodePath.join(binding.cwd, file.path); this.fs.mkdirp(nodePath.dirname(target)); this.fs.writeFile(target, this.fs.readFile(file.absolutePath)); delivered++; } catch (error) { failed.push({ path: file.path, error: error instanceof Error ? error.message : String(error) }); } }
    return { delivered, failed };
  }
  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string; continueSessionId?: string; forkSource?: { kind: "native_id" | "artifact_path" | "name" | "last"; value?: string } }): Promise<HarnessLaunchResult> {
    if (!binding.managedAttempt) return { ok: false, error: "Managed worker launch is unavailable" };
    return launchManagedHarness(this.workerLauncher, "codex", binding, opts);
  }
  async checkReady(binding: NodeBinding): Promise<ReadinessResult> { return binding.managedAttempt ? checkManagedReady(this.workerLauncher, binding.managedAttempt) : { ready: false, code: "managed_launch_unavailable" }; }

  ensureCodexFeatureFlag(enabled: boolean, opts: { codexVersion?: string } = {}): void {
    if (!enabled || !this.codexHome || !opts.codexVersion) return;
    const parts = opts.codexVersion.split(".").map(Number);
    if (parts.length < 2 || parts.some(Number.isNaN) || (parts[0]! > 0 || (parts[0] === 0 && parts[1]! >= 139))) return;
    const configPath = nodePath.join(this.codexHome, "config.toml");
    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    let doc: Record<string, unknown> = {};
    try { doc = existing.trim() ? (parseToml(existing) as Record<string, unknown>) : {}; } catch { return; }
    const features = isRecord(doc.features) ? { ...doc.features, codex_hooks: true } : { codex_hooks: true };
    this.fs.mkdirp(this.codexHome);
    this.fs.writeFile(configPath, stringifyToml({ ...doc, features } as never));
  }
}

const CODEX_NATIVE_CHANNEL_HOOK_TIMEOUT_SEC = 5;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
};

export function upsertCodexNativeChannelHook(content: string, relayCommand: string, keySource: string): string {
  if (relayCommand.includes("'") || /[\u0000-\u001f\u007f]/.test(relayCommand)) throw new Error("codex channel relay command must be a single-line TOML literal string");
  if (/[\u0000-\u001f\u007f]/.test(keySource)) throw new Error("codex channel key source contains unsafe characters");
  let doc: Record<string, unknown>;
  try { doc = (content.trim() ? parseToml(content) : {}) as Record<string, unknown>; } catch { return content; }
  const hooks = isRecord(doc.hooks) ? { ...doc.hooks } : {};
  const groups = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  hooks.PostToolUse = [
    ...groups.filter((group) => !(isRecord(group) && Array.isArray(group.hooks) && group.hooks.some((h) => isRecord(h) && h.command === relayCommand))),
    { hooks: [{ type: "command", command: relayCommand, timeout: CODEX_NATIVE_CHANNEL_HOOK_TIMEOUT_SEC }] },
  ];
  const features = isRecord(doc.features) ? { ...doc.features, hooks: true } : { hooks: true };
  const next = { ...doc, features, hooks };
  return stringifyToml(next as never);
}

export function codexNativeChannelDigest(content: string, relayCommand: string): string | null {
  let doc: Record<string, unknown>;
  try { doc = parseToml(content) as Record<string, unknown>; } catch { return null; }
  const hooks = isRecord(doc.hooks) ? doc.hooks : {};
  const groups = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  const handlers = groups.flatMap((group) => isRecord(group) && Array.isArray(group.hooks) ? group.hooks : []);
  const ours = handlers.filter((handler) => isRecord(handler) && handler.command === relayCommand);
  if (ours.length !== 1) return null;
  return createHash("sha256").update(JSON.stringify(canonicalJson({ features: doc.features ?? null, hooks: doc.hooks ?? null, profile: doc.profile ?? null, profiles: doc.profiles ?? null }))).digest("hex");
}
