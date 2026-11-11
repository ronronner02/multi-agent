import nodePath from "node:path";
import { createHash } from "node:crypto";
import { launchManagedHarness, checkManagedReady, type WorkerLauncher } from "./worker-launch.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import type { ProjectionPlan } from "../domain/projection-planner.js";

export interface ClaudeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  copyFile(src: string, dest: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
  readdir?(dirPath: string): string[];
  homedir?: string;
}

function targetFor(entry: ProjectionPlan["entries"][number], cwd: string): string {
  switch (entry.category) {
    case "skill": return nodePath.join(cwd, ".claude", "skills", entry.effectiveId);
    case "plugin": return nodePath.join(cwd, ".claude", "plugins", entry.effectiveId);
    case "subagent": return nodePath.join(cwd, ".claude", "agents", `${entry.effectiveId}.md`);
    case "runtime_resource": return nodePath.join(cwd, ".claude", "extensions", entry.effectiveId);
    case "guidance": return entry.target ? nodePath.resolve(cwd, entry.target) : nodePath.join(cwd, "CLAUDE.md");
  }
}

function projectFiles(fs: ClaudeAdapterFsOps, source: string, target: string): void {
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
function sourceExists(fs: ClaudeAdapterFsOps, source: string): boolean {
  return fs.exists(source) || Boolean(fs.listFiles?.(source)?.length);
}

/** Native Claude adapter. Provider turns are always handed to DirectWorkerLauncher. */
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly runtime = "claude-code";
  readonly managedTransport = "direct" as const;
  readonly claudeManagedLaunch = undefined;
  private readonly workerLauncher?: WorkerLauncher;
  private readonly fs: ClaudeAdapterFsOps;

  constructor(deps: {
    fsOps: ClaudeAdapterFsOps;
    workerLauncher?: WorkerLauncher;
    [key: string]: unknown;
  }) {
    this.workerLauncher = deps.workerLauncher;
    this.fs = deps.fsOps;
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const root = nodePath.join(binding.cwd, ".claude", "skills");
    if (!this.fs.exists(root) || !this.fs.listFiles) return [];
    return this.fs.listFiles(root).map(file => ({ effectiveId: file, category: "skill", installedPath: nodePath.join(root, file) }));
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [], skipped: string[] = [], failed: Array<{ effectiveId: string; error: string }> = [];
    for (const entry of plan.entries) {
      if (entry.classification === "no_op") { skipped.push(entry.effectiveId); continue; }
      if (entry.category === "plugin") {
        const pluginType = entry.pluginType ?? "auto";
        if (pluginType === "codex" || (pluginType === "auto" && !sourceExists(this.fs, nodePath.join(entry.absolutePath, ".claude-plugin")))) {
          skipped.push(entry.effectiveId);
          continue;
        }
      }
      try {
        const target = targetFor(entry, binding.cwd);
        if (!sourceExists(this.fs, entry.absolutePath)) throw new Error("projection source is missing");
        projectFiles(this.fs, entry.absolutePath, target);
        projected.push(entry.effectiveId);
      } catch (error) { failed.push({ effectiveId: entry.effectiveId, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const failed: Array<{ path: string; error: string }> = [];
    let delivered = 0;
    for (const file of files) {
      try {
        const target = nodePath.isAbsolute(file.path) ? file.path : nodePath.join(binding.cwd, file.path);
        this.fs.mkdirp(nodePath.dirname(target));
        this.fs.writeFile(target, this.fs.readFile(file.absolutePath));
        delivered++;
      } catch (error) { failed.push({ path: file.path, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { delivered, failed };
  }

  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string; continueSessionId?: string; forkSource?: { kind: "native_id" | "artifact_path" | "name" | "last"; value?: string } }): Promise<HarnessLaunchResult> {
    if (!binding.managedAttempt) return { ok: false, error: "Managed worker launch is unavailable" };
    return launchManagedHarness(this.workerLauncher, this.runtime === "claude-code" ? "claude-code" : "claude-code", binding, opts);
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    return binding.managedAttempt ? checkManagedReady(this.workerLauncher, binding.managedAttempt) : { ready: false, code: "managed_launch_unavailable" };
  }
}

/** Retained for callers that used the old activity probe; native turns have no pane report. */
export function readClaudeSelfReportEvidence(): null { return null; }

const CLAUDE_NATIVE_CHANNEL_HOOK_TIMEOUT_SEC = 5;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hookCommand = (value: unknown): string | null => {
  if (!isRecord(value) || value.type !== "command" || typeof value.command !== "string") return null;
  return value.command;
};
const isChannelHookGroup = (value: unknown, relayCommand: string): boolean =>
  isRecord(value) && Array.isArray(value.hooks) && value.hooks.some((hook) => hookCommand(hook) === relayCommand);
const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
};

export function upsertClaudeNativeChannelHook(settingsText: string, relayCommand: string): string {
  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = settingsText.trim() === "" ? {} : JSON.parse(settingsText);
    if (!isRecord(parsed)) return settingsText;
    settings = parsed;
  } catch { return settingsText; }
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const groups = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  hooks.PostToolUse = [
    ...groups.filter((group) => !isChannelHookGroup(group, relayCommand)),
    { hooks: [{ type: "command", command: relayCommand, timeout: CLAUDE_NATIVE_CHANNEL_HOOK_TIMEOUT_SEC }] },
  ];
  return `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`;
}

export function claudeNativeChannelDigest(scopes: readonly (string | null)[], relayCommand: string): string | null {
  const hookSets: unknown[] = [];
  let channelGroups = 0;
  for (const text of scopes) {
    if (text === null || text.trim() === "") { hookSets.push(null); continue; }
    let settings: unknown;
    try { settings = JSON.parse(text); } catch { return null; }
    if (!isRecord(settings)) return null;
    const hooks = settings.hooks ?? null;
    if (hooks !== null && !isRecord(hooks)) return null;
    const post = hooks?.PostToolUse;
    if (Array.isArray(post)) channelGroups += post.filter((group) => isChannelHookGroup(group, relayCommand)).length;
    hookSets.push({ hooks, disableAllHooks: settings.disableAllHooks ?? null });
  }
  if (channelGroups !== 1) return null;
  return createHash("sha256").update(JSON.stringify(canonicalJson(hookSets))).digest("hex");
}
