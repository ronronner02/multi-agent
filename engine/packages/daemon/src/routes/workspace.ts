// PL-007 Workspace Primitive v0 — workspace HTTP routes.
//
// Read-only endpoints:
//
//   POST /api/workspace/validate
//     body: { root: string; workspaceKind?: WorkspaceKind;
//              recursive?: boolean; requireFrontmatter?: boolean;
//              maxFiles?: number }
//     response: FrontmatterValidationReport
//
//   POST /api/workspace/doctor  (slice-21 FR-5)
//     body (all optional): { workspaceRoot?: string;
//                            filesAllowlistOverride?: string }
//     response: DoctorReport (8-check workspace-readiness report)
//
// No filesystem mutation. Operator picks the root + kind per invocation.
//
// Whoami / node-inventory surface workspace data through their existing
// routes; no separate /api/workspace/whoami.

import { Hono } from "hono";
import { TEAM_CONTROL_VERSION, parseProtocolVersion } from "../contracts/team-control.js";
import type { PlanGovernance } from "../domain/plan-governance.js";
import type { WorkflowRuntime } from "../domain/workflow-runtime.js";
import { credentialExcluded } from "../domain/scope-extension.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";
import { readWorkspacePath, readCommittedWorkspacePath, type CandidateWorkspace } from "../domain/team-workspace.js";
import * as path from "node:path";
import {
  validateWorkspaceFrontmatter,
  type ValidateOpts,
} from "../domain/workspace/frontmatter-validator.js";
import { WORKSPACE_KINDS, type WorkspaceKind } from "../domain/types.js";
import {
  runWorkspaceDoctor,
  type WorkspaceRootSource,
} from "../domain/workspace/workspace-doctor.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";

export function workspaceRoutes(): Hono {
  const app = new Hono();

  app.post("/validate", async (c) => {
    const body = await c.req.json<{
      root?: string;
      workspaceKind?: string;
      recursive?: boolean;
      requireFrontmatter?: boolean;
      maxFiles?: number;
    }>().catch(() => ({} as never));

    if (!body.root || typeof body.root !== "string") {
      return c.json({ error: "root_required", message: "root is required" }, 400);
    }
    let kind: WorkspaceKind | undefined;
    if (body.workspaceKind !== undefined) {
      if (!(WORKSPACE_KINDS as readonly string[]).includes(body.workspaceKind)) {
        return c.json({
          error: "invalid_workspace_kind",
          message: `workspaceKind must be one of: ${[...WORKSPACE_KINDS].join(", ")}`,
        }, 400);
      }
      kind = body.workspaceKind as WorkspaceKind;
    }

    const opts: ValidateOpts = {
      root: body.root,
      ...(kind !== undefined ? { workspaceKind: kind } : {}),
      ...(body.recursive !== undefined ? { recursive: body.recursive } : {}),
      ...(body.requireFrontmatter !== undefined ? { requireFrontmatter: body.requireFrontmatter } : {}),
      ...(body.maxFiles !== undefined ? { maxFiles: body.maxFiles } : {}),
    };
    try {
      const report = validateWorkspaceFrontmatter(opts);
      return c.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return c.json({ error: "validate_failed", message }, 500);
    }
  });

  // Slice-21 FR-5 — workspace doctor.
  //
  // Resolves all inputs from the daemon's SettingsStore (matching
  // /api/config), runs the 8-check orchestrator, and returns the
  // DoctorReport. Caller can override the workspace under check via
  // body.workspaceRoot — useful for `multi-agent workspace doctor --workspace
  // <path>` to probe an alternate workspace without restarting the
  // daemon. When overridden, the daemon-side workspace.root is still
  // resolved for check #4 (daemon-points-at-this-workspace).
  app.post("/doctor", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);

    const body = await c.req.json<{
      workspaceRoot?: string;
      filesAllowlistOverride?: string;
    }>().catch(
      () => ({} as { workspaceRoot?: string; filesAllowlistOverride?: string }),
    );

    try {
      const daemonResolved = store.resolveOne("workspace.root");
      const workspaceUnderCheck =
        typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0
          ? body.workspaceRoot
          : (daemonResolved.value as string);
      // Caller-supplied workspaceRoot is treated as an explicit
      // operator choice for fix-hint purposes (akin to env). When
      // not supplied, source is the daemon's actual resolution
      // channel (env / file / default).
      const workspaceRootSource: WorkspaceRootSource =
        typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0
          ? "env"
          : (daemonResolved.source as WorkspaceRootSource);

      // When caller overrode workspace, slicesRoot defaults to
      // `<workspaceRoot>/missions` (the same derivation ConfigStore
      // would apply for an unset workspace.slices_root). When not
      // overridden, honor the daemon's resolved slicesRoot.
      const slicesRoot =
        typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0
          ? path.join(body.workspaceRoot, "missions")
          : (store.resolveOne("workspace.slices_root").value as string);

      // FR-5e A2 — files.allowlist CLI-side env overlay. When the
      // CLI sets files.allowlist in its own shell, the
      // daemon's SettingsStore can't observe that env (different
      // process); the CLI forwards the raw value as
      // body.filesAllowlistOverride and we honor it here with
      // source="env" so check #3's fix-hint targets the right
      // remediation channel.
      const allowlistResolved = store.resolveOne("files.allowlist");
      const usingAllowlistOverride =
        typeof body.filesAllowlistOverride === "string"
        && body.filesAllowlistOverride.length > 0;
      const allowlistValue = usingAllowlistOverride
        ? body.filesAllowlistOverride!
        : (allowlistResolved.value as string);
      const allowlistSource: WorkspaceRootSource = usingAllowlistOverride
        ? "env"
        : (allowlistResolved.source as WorkspaceRootSource);

      // Daemon start time captured from process.uptime() at request
      // time. Per banked discipline (cited in workspace-doctor.ts:
      // CheckDaemonReloadInput.daemonStartTime JSDoc), this is a
      // pragmatic approximation — sufficient for "did config change
      // since startup" but does not account for explicit clock skew.
      const daemonStartTime = new Date(Date.now() - process.uptime() * 1000);

      const report = runWorkspaceDoctor({
        workspaceRoot: workspaceUnderCheck,
        workspaceRootSource,
        slicesRoot,
        allowlistValue,
        allowlistSource,
        daemonResolvedWorkspaceRoot: daemonResolved.value as string,
        configFilePath: store.configPath,
        daemonStartTime,
      });
      return c.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return c.json({ error: "doctor_failed", message }, 500);
    }
  });

  return app;
}

/** Managed browsing reads the live workspace plus the recorded candidate base. */
function readManagedWorkspace(root: string, relativePath: string,
  candidate?: Pick<CandidateWorkspace, "sourceRoot" | "base">, excluded = credentialExcluded) {
  let read = readWorkspacePath(root, relativePath, excluded);
  const committed = candidate?.base.kind === "commit"
    ? readCommittedWorkspacePath(candidate.sourceRoot, candidate.base.commit, relativePath)
    : undefined;
  const baselineFiles = candidate?.base.kind === "snapshot" ? candidate.base.files : [];
  if (read.kind === "missing" && (committed?.kind === "directory"
    || baselineFiles.some(file => file.path.startsWith(relativePath + "/") && !excluded(file.path)))) {
    read = { kind: "directory", entries: [] };
  }
  const base = committed?.kind === "file" ? { hash: committed.hash } : baselineFiles.find(file => file.path === relativePath);
  if (read.kind === "missing" && !base) throw new Error("Workspace path not available");
  if (!candidate) return { ...read, path: relativePath };
  if (read.kind === "directory") {
    const entries = [...read.entries];
    const prefix = relativePath ? relativePath + "/" : "";
    if (committed?.kind === "directory") for (const entry of committed.entries) {
      if (!excluded(prefix + entry.name) && !entries.some(existing => existing.name === entry.name)) entries.push(entry);
    }
    for (const file of baselineFiles) {
      if (excluded(file.path) || !file.path.startsWith(prefix)) continue;
      const name = file.path.slice(prefix.length).split("/")[0]!;
      if (!entries.some(entry => entry.name === name)) entries.push({ name, kind: file.path.slice(prefix.length).includes("/") ? "directory" : "file" });
    }
    if (entries.length > 1000) throw new Error("Workspace directory exceeds browse limit");
    return { ...read, path: relativePath, entries };
  }
  let before: string | null = committed?.kind === "file" ? committed.content : null;
  if (base && !committed) {
    try {
      const source = readWorkspacePath(candidate.sourceRoot, relativePath, excluded);
      if (source.kind === "file" && source.hash === base.hash) before = source.content;
    } catch { /* Changed or unavailable source bytes are never presented as the recorded baseline. */ }
  }
  return { ...read, path: relativePath, before, baseHash: base?.hash ?? null,
    change: read.kind === "missing" ? "deleted" : !base ? "created" : read.hash === base.hash ? "unchanged" : "modified" };
}


export function workspaceBrowseRoutes(governance: PlanGovernance, options: {
  credentials: TeamControlCredentials; legacyTokens: readonly (string | null | undefined)[];
  runtime?: WorkflowRuntime; orchestratorRoot: string;
}): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  for (const view of ["workspace", "knowledge"] as const) {
    const route = `/runs/:runId/${view}`;
    app.use(route, teamControlAuthentication(() => options.credentials, options.legacyTokens));
    app.get(route, c => {
      if (c.get("controlActor").kind !== "owner" || (c.get("controlRunId") !== null && c.get("controlRunId") !== c.req.param("runId"))) {
        return c.json({ code: "owner_control_required" }, 403);
      }
      try {
        parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
        const run = governance.getRun(c.req.param("runId")!);
        const query = c.req.query(), relativePath = query.path ?? "";
        if (Object.keys(query).some(key => !(view === "workspace" ? ["path", "taskId"] : ["path", "root"]).includes(key))) throw new Error();
        let root = run.binding.repository.root;
        let candidate: ReturnType<WorkflowRuntime["existingCandidate"]> = null;
        let excluded = credentialExcluded;
        if (view === "workspace" && query.taskId) {
          candidate = options.runtime?.existingCandidate(run.id, query.taskId) ?? null;
          if (!candidate || candidate.sourceRoot !== root) throw new Error();
          root = candidate.root;
        }
        if (view === "knowledge") {
          if (query.root && !["target", "orchestrator"].includes(query.root)) throw new Error();
          if (query.root === "orchestrator") root = options.orchestratorRoot;
          const prefixes = ["docs/plans", "docs/requirements", "docs/solutions"];
          const plan = query.root === "orchestrator" ? "" : run.binding.planRef;
          excluded = name => credentialExcluded(name) || !(name === "" || (plan && (name === plan || plan.startsWith(name + "/")))
            || prefixes.some(prefix => prefix === name || prefix.startsWith(name + "/") || (name.startsWith(prefix + "/") && (!path.extname(name) || /\.(?:md|mdown|markdown)$/i.test(name)))));
        }
        const read = readManagedWorkspace(root, relativePath, candidate ?? undefined, excluded);
        if (view === "knowledge" && read.kind === "file" && !/\.(?:md|mdown|markdown)$/i.test(relativePath)) throw new Error();
        if (view === "knowledge" && read.kind === "directory") {
          read.entries = read.entries.filter(entry => entry.kind === "directory" || /\.(?:md|mdown|markdown)$/i.test(entry.name));
        }
        c.header("Cache-Control", "no-store");
        c.header("X-Content-Type-Options", "nosniff");
        return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...read });
      } catch {
        return c.json({ protocolVersion: TEAM_CONTROL_VERSION, code: "workspace_not_available", error: "Not available" }, 404);
      }
    });
  }
  return app;
}
