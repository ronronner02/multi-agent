import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { readWorkspacePath, createCandidateWorkspace, resolveWorkspaceBase, type CandidateWorkspace } from "../src/domain/team-workspace.js";
import { createTestApp } from "./helpers/test-app.js";
import { PlanGovernance, hashBytes, fixDaemonMode } from "../src/domain/plan-governance.js";
import { readManagedWorkspace } from "../src/routes/files.js";
import { workspaceBrowseRoutes } from "../src/routes/workspace.js";
import { credentialExcluded } from "../src/domain/scope-extension.js";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const tree = (root: string): unknown => readdirSync(root).sort().map(name => {
  const path = join(root, name), stat = lstatSync(path);
  return [name, stat.mode, stat.mtimeMs, stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? tree(path) : digest(readFileSync(path))];
});

describe("read-only workspace boundary", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "workspace-scope-"));
    mkdirSync(join(directory, "repo", "src"), { recursive: true });
    writeFileSync(join(directory, "repo", "src", "ok.ts"), "export const value = 1;\n");
  });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it("looks up existing candidates only and leaves database rows and filesystem unchanged", async () => {
    const db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
    const records = runtime as unknown as { candidates: Map<string, CandidateWorkspace>; invalidCandidates: Set<string> };
    const workspace = { root: join(directory, "repo"), sourceRoot: join(directory, "repo"), base: { kind: "snapshot", baselineDigest: "base", files: [] },
      source: { head: null, refsDigest: "refs", dirtyHashes: {}, statusDigest: "status" }, checkScope: vi.fn(() => { throw new Error("scope called"); }) } as CandidateWorkspace;
    records.candidates.set("run\0task", workspace);
    const create = vi.spyOn(runtime, "candidateFor").mockImplementation(() => { throw new Error("candidate creation called"); });
    const rows = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => {
      const name = (row as { name: string }).name;
      return [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()];
    });
    const governance = new PlanGovernance(db, bus, queue);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    governance.createRun({ id: "run", rigId: "rig", binding: {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("plan"), repository: { root: workspace.sourceRoot, identity: "snapshot:" + hashBytes("fixture") },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"], policyRevision: 1,
      policyFingerprint: hashBytes("policy"), limits: { maxSessions: 3, maxActiveMs: 600000, maxRetries: 1, maxReviewRounds: 2 },
    } });
    const app = workspaceBrowseRoutes(governance, { runtime, orchestratorRoot: directory, legacyTokens: [],
      credentials: { ownerToken: "fixture-owner", workers: [{ token: "fixture-worker", sessionId: "worker", runId: "run" }] } });
    const get = (url: string, token = "fixture-owner", method = "GET") => app.request(url, { method, headers: { Authorization: "Bearer " + token } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    mkdirSync(join(workspace.root, "docs", "plans"), { recursive: true });
    mkdirSync(join(directory, "docs", "solutions"), { recursive: true });
    writeFileSync(join(workspace.root, "docs", "plans", "plan.md"), "<script>alert(1)</script>");
    writeFileSync(join(workspace.root, "docs", "plans", "notes.markdown"), "# Markdown");
    writeFileSync(join(workspace.root, "docs", "plans", "extensionless"), "not Markdown");
    writeFileSync(join(workspace.root, "docs", "plans", "script.ts"), "not Markdown");
    writeFileSync(join(directory, "docs", "solutions", "solution.md"), "solution");
    writeFileSync(join(workspace.root, ".env"), "secret");
    fixDaemonMode(db, true);
    const composed = createTestApp(db, { appDeps: { workflowRuntime: runtime, teamGovernance: governance, teamControl: { credentials: { ownerToken: "fixture-owner" } } } }).app;
    const before = { rows: rows(), tree: tree(directory) };
    const ownerRequest = { headers: { Authorization: "Bearer fixture-owner" } };
    const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    const composedRead = await composed.request("http://localhost/api/team-control/runs/run/workspace?path=src/ok.ts", ownerRequest, peer);
    expect(composedRead.status, await composedRead.text()).toBe(200);
    expect((await composed.request("http://localhost/api/team-control/runs/run/workspace?taskId=task&path=src/ok.ts", ownerRequest, peer)).status).toBe(200);
    for (const path of ["files/roots", "files/read?root=repo&path=src/ok.ts", "workspace/validate"]) {
      expect((await composed.request("http://localhost/api/" + path, ownerRequest, peer)).status).toBe(403);
    }
    expect((await get("/runs/run/workspace?path=src/ok.ts")).status).toBe(200);
    expect((await get("/runs/run/workspace?taskId=task&path=src/ok.ts")).status).toBe(200);
    expect((await get("/runs/run/knowledge?path=docs/plans/plan.md")).status).toBe(200);
    expect((await get("/runs/run/knowledge?path=docs/plans/notes.markdown")).status).toBe(200);
    const knowledge = await (await get("/runs/run/knowledge?path=docs/plans")).json();
    expect(knowledge.entries.map((entry: { name: string }) => entry.name)).toEqual(["notes.markdown", "plan.md"]);
    expect((await get("/runs/run/knowledge?root=orchestrator&path=docs/solutions/solution.md")).status).toBe(200);
    for (const view of ["workspace", "knowledge"]) {
      expect((await get(`/runs/run/${view}`, "fixture-worker")).status).toBe(403);
      expect((await get(`/runs/run/${view}`, "unknown")).status).toBe(401);
      expect((await get(`/runs/run/${view}`, "fixture-owner", "POST")).status).toBe(404);
    }
    for (const url of ["workspace?taskId=missing", "workspace?root=/etc", "workspace?path=../outside.md", "workspace?path=.env",
      "knowledge?path=src/ok.ts", "knowledge?path=docs/plans/script.ts", "knowledge?path=docs/plans/extensionless", "knowledge?root=other", "knowledge?root=orchestrator&path=control.db"]) {
      const response = await get("/runs/run/" + url);
      expect(response.status, url).toBe(404);
      expect(await response.text()).not.toContain(directory);
    }

    expect(runtime.existingCandidate("run", "missing")).toBeNull();
    const candidate = runtime.existingCandidate("run", "task")!;
    expect(candidate.root).toBe(workspace.root);
    expect(candidate).not.toHaveProperty("checkScope");
    expect(readWorkspacePath(candidate.root, "src/ok.ts", credentialExcluded)).toMatchObject({ kind: "file", content: "export const value = 1;\n" });
    records.invalidCandidates.add("run\0task");
    expect(runtime.existingCandidate("run", "task")).toBeNull();
    expect((await get("/runs/run/workspace?taskId=task")).status).toBe(404);
    expect({ rows: rows(), tree: tree(directory) }).toEqual(before);
    expect(records.candidates.get("run\0task")).toBe(workspace);
    expect(create).not.toHaveBeenCalled();
    expect(workspace.checkScope).not.toHaveBeenCalled();
    db.close();
  });

  it("excludes exactly the existing credential patterns at any depth", () => {
    const original = /(^|\/)(?:\.git|\.ssh|\.aws|\.codex|\.claude|\.env[^/]*|\.npmrc|\.netrc|credentials[^/]*)(\/|$)|\.(?:pem|key)$/;
    for (const name of [".git/config", ".ssh/id_rsa", ".aws/config", ".codex/config.toml", ".claude/settings.json", ".env.local", ".npmrc", ".netrc", "credentials.json", "cert.pem", "secret.key", "src/key.ts", "README.md", "test.PEM", "ordinary.env"]) {
      for (const path of [name, "nested/" + name]) expect(credentialExcluded(path), path).toBe(original.test(path));
    }
  });

  it("refuses traversal, symlink aliases and credential files without disclosing bytes", () => {
    const root = join(directory, "repo");
    writeFileSync(join(root, ".env"), "secret");
    writeFileSync(join(directory, "outside.md"), "outside");
    symlinkSync(join(directory, "outside.md"), join(root, "escape.md"));
    symlinkSync(join(root, ".env"), join(root, "alias.md"));
    symlinkSync(join(directory), join(root, "linked"));
    for (const path of ["../outside.md", "/etc/passwd", "src/../../outside.md", "escape.md", "alias.md", "linked/outside.md", ".env"]) {
      expect(() => readWorkspacePath(root, path, credentialExcluded), path).toThrow();
    }
    expect(readWorkspacePath(root, "", credentialExcluded)).toEqual({ kind: "directory", entries: [{ name: "src", kind: "directory" }] });
  });

  it("browses created, modified and deleted candidate files without inventing baseline bytes", () => {
    const sourceRoot = join(directory, "repo"), root = join(directory, "candidate");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(sourceRoot, "removed"));
    writeFileSync(join(sourceRoot, "removed", "old.ts"), "old");
    const files = ["src/ok.ts", "removed/old.ts"].map(path => ({ path, hash: "sha256:" + digest(readFileSync(join(sourceRoot, path))), tracked: true }));
    const candidate = { sourceRoot, base: { kind: "snapshot", baselineDigest: "base", files } } as const;
    writeFileSync(join(root, "src", "ok.ts"), "changed");
    writeFileSync(join(root, "new.ts"), "new");
    expect(readManagedWorkspace(root, "src/ok.ts", candidate)).toMatchObject({ change: "modified", before: "export const value = 1;\n", content: "changed" });
    expect(readManagedWorkspace(root, "new.ts", candidate)).toMatchObject({ change: "created", baseHash: null, content: "new" });
    expect(readManagedWorkspace(root, "removed", candidate)).toMatchObject({ kind: "directory", entries: [{ name: "old.ts", kind: "file" }] });
    expect(readManagedWorkspace(root, "removed/old.ts", candidate)).toMatchObject({ kind: "missing", change: "deleted", before: "old" });
    writeFileSync(join(sourceRoot, "src", "ok.ts"), "source moved");
    expect(readManagedWorkspace(root, "src/ok.ts", candidate)).toMatchObject({ change: "modified", before: null });
  });

  it("uses committed baseline bytes even when the owner has dirty and untracked drafts", () => {
    const sourceRoot = join(directory, "repo");
    const git = (...args: string[]) => execFileSync("git", ["-C", sourceRoot, ...args], { stdio: "pipe" });
    git("init", "--quiet"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "base");
    writeFileSync(join(sourceRoot, "src", "ok.ts"), "owner draft");
    writeFileSync(join(sourceRoot, "notes.txt"), "untracked owner draft");
    const candidate = createCandidateWorkspace({ root: sourceRoot, workspaceRoot: join(directory, "commit-candidate"), label: "commit-candidate", base: resolveWorkspaceBase(sourceRoot) });
    const root = candidate.root;
    const before = tree(directory);
    expect(readManagedWorkspace(root, "src/ok.ts", candidate)).toMatchObject({ change: "unchanged", before: "export const value = 1;\n" });
    expect(readManagedWorkspace(root, "", candidate)).toMatchObject({ kind: "directory", entries: [{ name: "src", kind: "directory" }] });
    expect(() => readManagedWorkspace(root, "notes.txt", candidate)).toThrow();
    expect(tree(directory)).toEqual(before);
    writeFileSync(join(root, "src", "ok.ts"), "candidate edit");
    expect(readManagedWorkspace(root, "src/ok.ts", candidate)).toMatchObject({ change: "modified", before: "export const value = 1;\n", content: "candidate edit" });
  });

  it("refuses special files and bounds directory enumeration", () => {
    const root = join(directory, "repo");
    execFileSync("mkfifo", [join(root, "pipe")]);
    expect(() => readWorkspacePath(root, "pipe", credentialExcluded)).toThrow();
    expect(readWorkspacePath(root, "", credentialExcluded)).toMatchObject({ entries: [{ name: "src", kind: "directory" }] });
    mkdirSync(join(root, "wide"));
    for (let n = 0; n <= 1000; n++) writeFileSync(join(root, "wide", String(n)), "");
    expect(() => readWorkspacePath(root, "wide", credentialExcluded)).toThrow(/limit/);
  });

  it("bounds file reads and preserves embedded markup as text", () => {
    const root = join(directory, "repo");
    writeFileSync(join(root, "large.md"), Buffer.alloc(262145, 65));
    expect(() => readWorkspacePath(root, "large.md", credentialExcluded)).toThrow();
    const markup = '<script>globalThis.pwned = true</script><img src=x onerror="alert(1)">';
    writeFileSync(join(root, "plan.md"), markup);
    expect(readWorkspacePath(root, "plan.md", credentialExcluded)).toMatchObject({ kind: "file", content: markup });
  });
});
