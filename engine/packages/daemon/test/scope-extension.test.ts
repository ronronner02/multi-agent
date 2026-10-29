import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { teamControlRoutes } from "../src/routes/team-control.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { removeReviewPacket, type ReviewPacket } from "../src/domain/team-workspace.js";
import type { ControlRequest, PlanBinding } from "../src/contracts/team-control.js";


const policyInput = vi.hoisted(() => ({ paths: 5, extensions: 5, registries: ["registry.npmjs.org:443"] as string[] | null }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === "/etc/multi-agent/egress.json") {
      if (policyInput.registries === null) throw new Error("Egress policy unavailable");
      return JSON.stringify({ schema: "multi-agent-egress/v1", allow: policyInput.registries });
    }
    const bytes = fs.readFileSync(...args);
    if (args[0] instanceof URL && args[0].pathname.endsWith("/config/governance/low-risk-dev-dependencies.json")) {
      return JSON.stringify({ ...JSON.parse(String(bytes)), maxPathsPerRequest: policyInput.paths, maxApprovedExtensionsPerTask: policyInput.extensions });
    }
    return bytes;
  } };
});
const manifestBase = { name: "fixture", version: "1.0.0", devDependencies: {} as Record<string, string> };
type DependencyFixture = {
  manifest: typeof manifestBase & { dependencies?: Record<string, string>; scripts?: Record<string, string>; overrides?: Record<string, string> };
  lock: { name: string; version: string; lockfileVersion: number; packages: Record<string, Record<string, unknown>> };
};
const dependencyFixture = (): DependencyFixture => ({
  manifest: { ...manifestBase, devDependencies: { "@types/node": "22.0.0" } },
  lock: { name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {
    "": { ...manifestBase, devDependencies: { "@types/node": "22.0.0" } },
    "node_modules/@types/node": { version: "22.0.0", dev: true, resolved: "https://registry.npmjs.org/@types/node/-/node-22.0.0.tgz",
      integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") },
  } },
});

const owner = { kind: "owner", sessionId: "owner" } as const;
const worker = { kind: "worker", sessionId: "worker" } as const;
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("task-local scope extensions at candidate staging", () => {
  let directory: string, repo: string, db: Database.Database, governance: PlanGovernance, runtime: WorkflowRuntime, binding: PlanBinding;
  let nextKey = 0;
  const packets: ReviewPacket[] = [];
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: "1.0", runId: "run", actionId, payload,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "request-" + ++nextKey,
  });
  const open = () => {
    db = createDb(join(directory, "control.db"));
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, () => new Date("2026-10-28T08:00:00.000Z"), () => ({
      policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"],
    }));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, defaultWorker: () => "ma-worker1",
      assignmentRoot: () => join(directory, "assignments"),
      candidateRecordsRoot: () => join(directory, "candidate-records"),
      candidateRoot: (runId, taskId, workerName) => join(directory, "assignments", workerName, runId + "-" + taskId),
    });
  };
  const candidate = (taskId = "task") => runtime.candidateFor("run", taskId, "ma-worker1");
  const packet = (taskId = "task") => {
    const value = runtime.reviewPacketFor("run", taskId, join(directory, "review-" + taskId + "-" + packets.length));
    packets.push(value);
    return value;
  };

  beforeEach(() => {
    policyInput.paths = 5; policyInput.extensions = 5; policyInput.registries = ["registry.npmjs.org:443"];
    directory = mkdtempSync(join(tmpdir(), "scope-extension-"));
    repo = join(directory, "source");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(directory, "assignments", "ma-worker1"), { recursive: true });
    for (const path of ["owned.ts", "neighbor.ts", "other.ts"]) writeFileSync(join(repo, "src", path), "export const value = " + JSON.stringify(path) + ";\n");
    writeFileSync(join(repo, "plan.md"), "approved plan");
    writeFileSync(join(repo, "package.json"), JSON.stringify(manifestBase));
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": manifestBase } }));
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=fixture", "-c", "user.email=scope@test.invalid", "commit", "--quiet", "-m", "base");
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan"), repository: { root: repo, identity: "git:" + git(repo, "rev-parse", "HEAD").trim() },
      readPaths: ["src"], writePaths: ["src", "lib", "docs", "engine", "package.json", "package-lock.json", "pnpm-lock.yaml"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: 4, policyFingerprint: hashBytes("policy"), limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    nextKey = 0;
    open();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "9999-01-01T00:00:00.000Z" }), owner);
    governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }), owner, binding);
    for (const [taskId, path] of [["task", "src/owned.ts"], ["other", "src/other.ts"]]) {
      expect(governance.createTask(command(taskId, { assignment: { taskId, role: "implementer", paths: [path], dependencies: [] },
        outputs: [], permissions: [], sourceSession: "lead@rig", destinationSession: taskId + "@rig", body: "Implement the assigned file" }), binding).status).toBe("accepted");
    }
  });
  afterEach(() => {
    for (const value of packets.splice(0)) removeReviewPacket(value);
    if (db?.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });


  const extensions = () => governance.scopeForTask("run", "task").extensions;
  const decide = (id: string, decision: "approved" | "rejected" = "approved", head?: string) => {
    const approval = governance.getApproval(id)!;
    return governance.decideApproval(command(id, { approvalVersion: approval.entityVersion, decision,
      expectedChainHead: head ?? approval.payload.expectedChainHead }), owner, binding);
  };

  it("approves only this task's extension and includes its scope in review and delivery", () => {
    const before = governance.getRun("run"), otherScope = governance.scopeForTask("run", "other");
    const implementation = governance.getApproval("implementation");
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "changed\n");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(1);
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(1);
    writeFileSync(join(candidate("other").root, "src/other.ts"), "unrelated task\n");
    expect(packet("other").scope).toEqual(otherScope);
    expect(decide(extensions()[0]!.id).status).toBe("accepted");
    const approved = packet();
    expect(approved.scope!.extensions[0]).toMatchObject({ state: "approved", automatic: false, reason: "no reason given" });
    expect(approved.scope!.scopeDigest).not.toBe(otherScope.scopeDigest);
    expect(runtime.reviewProgress("run", "task").delivery).toMatchObject({ scope: approved.scope });
    const after = governance.getRun("run");
    expect([after.binding, after.bindingDigest, after.activeMs, after.state]).toEqual([before.binding, before.bindingDigest, before.activeMs, before.state]);
    expect(governance.getApproval("implementation")).toEqual(implementation);
    expect(governance.scopeForTask("run", "other")).toEqual(otherScope);
    expect(db.prepare("SELECT count(*) AS n FROM team_attempts").get()).toEqual({ n: 0 });
  });

  it("auto-records a new sibling, but not a new file in an unowned directory", () => {
    const root = candidate().root;
    writeFileSync(join(root, "src/types.ts"), "export type Value = string;\n");
    const first = packet();
    expect(first.scope!.extensions).toMatchObject([{ automatic: true, state: "approved",
      paths: [{ path: "src/types.ts", operation: "create" }] }]);
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib/types.ts"), "export type Value = number;\n");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(2);
  });

  it("stages an owned deletion and holds an unowned deletion for a decision", () => {
    const root = candidate().root;
    rmSync(join(root, "src/owned.ts"));
    expect(packet().manifest.some(file => file.path === "src/owned.ts")).toBe(false);
    rmSync(join(root, "src/neighbor.ts"));
    expect(() => packet()).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id).status).toBe("accepted");
    expect(packet().manifest.some(file => file.path === "src/neighbor.ts")).toBe(false);
  });

  it("preserves rejection across restart and unrelated candidate changes", () => {
    const root = candidate().root;
    writeFileSync(join(root, "src/neighbor.ts"), "rejected\n");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id, "rejected").status).toBe("accepted");
    db.close(); open();
    expect(() => packet()).toThrow(/extension-rejected/);
    writeFileSync(join(root, "src/owned.ts"), "unrelated new bytes\n");
    expect(() => packet()).toThrow(/extension-rejected/);
    expect(extensions()).toHaveLength(1);
    writeFileSync(join(root, "src/neighbor.ts"), "new evidence\n");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(2);
  });

  it("conflicts on a stale extension head without changing the pending decision", () => {
    const root = candidate().root;
    writeFileSync(join(root, "src/neighbor.ts"), "pending\n");
    expect(() => packet()).toThrow(/extension-pending/);
    const pending = extensions()[0]!;
    expect(() => decide(pending.id, "approved", "sha256:stale")).toThrow(/conflict/);
    expect(governance.getApproval(pending.id)!.state).toBe("pending");
    expect(decide(pending.id).status).toBe("accepted");
  });

  it("invalidates pending extensions on plan-byte drift", () => {
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "pending\n");
    expect(() => packet()).toThrow(/extension-pending/);
    writeFileSync(join(repo, "plan.md"), "new plan bytes");
    expect(() => governance.stageCandidateScope("run", "task", {
      root: repo, candidateDigest: hashBytes("changed"), files: [], changes: [],
    })).toThrow(/plan-digest/);
    expect(extensions()[0]!.state).toBe("invalidated");
    expect(governance.getRun("run").state).toBe("invalidated");
  });


  const writeDependencies = (value = dependencyFixture()) => {
    const root = candidate().root;
    writeFileSync(join(root, "package.json"), JSON.stringify(value.manifest));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(value.lock));
    return root;
  };

  it("requires an owner decision for an exact listed devDependency and binds it to its checked bytes", () => {
    writeDependencies();
    expect(() => packet()).toThrow(/extension-pending/);
    const extension = extensions()[0]!;
    expect(extension.packages).toEqual([{ name: "@types/node", version: "22.0.0", matched: "@types/*" }]);
    expect(decide(extension.id).status).toBe("accepted");
    expect(packet().scope!.extensions).toHaveLength(1);
    const changed = dependencyFixture();
    changed.manifest.dependencies = { "runtime-package": "1.0.0" };
    writeDependencies(changed);
    expect(() => packet()).toThrow(/plan-change-required/);
    expect(extensions()).toHaveLength(1);
  });

  const renameDependency = (value: DependencyFixture, name: string, version: string) => {
    value.manifest.devDependencies = { [name]: version };
    value.lock.packages[""]!.devDependencies = { [name]: version };
    const entry = value.lock.packages["node_modules/@types/node"]!;
    delete value.lock.packages["node_modules/@types/node"];
    value.lock.packages["node_modules/" + name] = { ...entry, version };
  };
  const invalidDependencies: Array<[string, string, (value: DependencyFixture) => void]> = [
    ["production dependencies", "dev-dependencies-only", value => { value.manifest.dependencies = { "@types/node": "22.0.0" }; }],
    ["unlisted name", "dependency-not-listed", value => renameDependency(value, "unlisted-package", "1.0.0")],
    ["range", "dependency-version-not-exact", value => renameDependency(value, "@types/node", "^22.0.0")],
    ["tag", "dependency-version-not-exact", value => renameDependency(value, "@types/node", "latest")],
    ["install script", "dependency-install-script", value => { value.lock.packages["node_modules/@types/node"]!.hasInstallScript = true; }],
    ["missing integrity", "dependency-integrity", value => { delete value.lock.packages["node_modules/@types/node"]!.integrity; }],
    ["unlisted registry", "dependency-registry", value => { value.lock.packages["node_modules/@types/node"]!.resolved = "https://unlisted.example/package.tgz"; }],
    ["non-dev entry", "non-dev-lock-change", value => { delete value.lock.packages["node_modules/@types/node"]!.dev; }],
    ["scripts", "dev-dependencies-only", value => { value.manifest.scripts = { postinstall: "run-command" }; }],
    ["overrides", "dev-dependencies-only", value => { value.manifest.overrides = { "@types/node": "22.0.0" }; }],
    ["old lockfile", "lockfile-v3-only", value => { value.lock.lockfileVersion = 2; }],
    ["unrelated lock entry", "unrelated-lock-change", value => { value.lock.packages["node_modules/unrelated"] = { ...value.lock.packages["node_modules/@types/node"] }; }],
    ["lock version mismatch", "lock-version-mismatch", value => { value.lock.packages["node_modules/@types/node"]!.version = "23.0.0"; }],
  ];
  it.each(invalidDependencies)("requires a plan change for %s", (_name, rule, change) => {
    const value = dependencyFixture(); change(value); writeDependencies(value);
    expect(() => packet()).toThrow(new RegExp("plan-change-required: " + rule));
    expect(extensions()).toHaveLength(0);
  });

  it("accepts only the checked transitive dev entries and asks again for a new exact version", () => {
    const value = dependencyFixture();
    value.lock.packages["node_modules/@types/node"]!.dependencies = { "undici-types": "~6.1.0" };
    value.lock.packages["node_modules/undici-types"] = { ...value.lock.packages["node_modules/@types/node"], version: "6.1.0" };
    delete value.lock.packages["node_modules/undici-types"]!.dependencies;
    writeDependencies(value); expect(() => packet()).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id).status).toBe("accepted"); packet();
    renameDependency(value, "@types/node", "23.0.0"); writeDependencies(value);
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(2);
  });

  it("limits the default task chain to five approved extensions", () => {
    const root = candidate().root;
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(root, "src/new" + index + ".ts"), "new"); packet();
    }
    expect(extensions()).toHaveLength(5);
    writeFileSync(join(root, "src/over-cap.ts"), "new");
    expect(() => packet()).toThrow(/extension-cap/);
  });

  it("uses the installed registry allowlist and fails closed when it is missing", () => {
    writeDependencies();
    policyInput.registries = null;
    expect(() => packet()).toThrow(/plan-change-required/);
    policyInput.registries = ["packages.example:443"];
    expect(() => packet()).toThrow(/plan-change-required/);
    const value = dependencyFixture();
    value.lock.packages["node_modules/@types/node"]!.resolved = "https://packages.example/node.tgz";
    writeDependencies(value);
    expect(() => packet()).toThrow(/extension-pending/);
  });

  it("keeps non-npm lockfiles and owner policy files outside the fast path", () => {
    const root = candidate().root;
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
    expect(() => packet()).toThrow(/plan-change-required/);
    rmSync(join(root, "pnpm-lock.yaml"));
    mkdirSync(join(root, "engine/config/governance"), { recursive: true });
    writeFileSync(join(root, "engine/config/governance/low-risk-dev-dependencies.json"), '{"packages":["*"]}');
    expect(() => packet()).toThrow(/protected-path/);
  });

  it.each([
    ["src/other.ts", "other-task-scope"], ["outside.txt", "outside-write-paths"],
    ["docs/plans/new.md", "protected-path"], ["src/contracts/new.ts", "protected-path"],
    ["src/migrations/001.ts", "protected-path"], ["src/.env", "protected-path"],
    ["engine/config/isolation/policy.json", "protected-path"], ["engine/packages/daemon/src/domain/queue-repository.ts", "protected-path"],
  ])("rejects %s with the failing rule", (path, rule) => {
    const root = candidate().root;
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), "changed");
    expect(() => packet()).toThrow(new RegExp("plan-change-required: " + rule));
  });

  it("enforces both caps and uses owner-adjusted limits without changing the binding", () => {
    const root = candidate().root, digest = governance.getRun("run").bindingDigest;
    for (let index = 0; index < 6; index++) writeFileSync(join(root, "src/extra" + index + ".ts"), "new");
    expect(() => packet()).toThrow(/path-cap/);
    policyInput.paths = 6;
    expect(packet().scope!.extensions).toHaveLength(1);
    policyInput.extensions = 1;
    writeFileSync(join(root, "src/last.ts"), "new");
    expect(() => packet()).toThrow(/extension-cap/);
    policyInput.extensions = 2;
    expect(packet().scope!.extensions).toHaveLength(2);
    expect(governance.getRun("run").bindingDigest).toBe(digest);
  });

  it("rechecks foreign extensions when an owner decides competing requests", () => {
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "first task");
    writeFileSync(join(candidate("other").root, "src/neighbor.ts"), "other task");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(() => packet("other")).toThrow(/extension-pending/);
    const foreign = governance.scopeForTask("run", "other").extensions[0]!;
    expect(decide(foreign.id).status).toBe("accepted");
    expect(() => decide(extensions()[0]!.id)).toThrow(/other-task-scope/);
    expect(governance.getApproval(extensions()[0]!.id)!.state).toBe("pending");
  });

  it("canonicalizes approved aliases and rejects traversal or escaping aliases", () => {
    const root = candidate().root;
    symlinkSync("neighbor.ts", join(root, "src/alias.ts"));
    const evidence = (path: string) => ({ root, candidateDigest: hashBytes(path), files: ["src/owned.ts"],
      changes: [{ path, before: null, after: Buffer.from("alias") }] });
    expect(() => governance.stageCandidateScope("run", "task", evidence("src/alias.ts"))).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id).status).toBe("accepted");
    expect(governance.stageCandidateScope("run", "task", evidence("src/alias.ts")).extensions).toHaveLength(1);
    expect(() => governance.stageCandidateScope("run", "task", evidence("../outside"))).toThrow(/path-escape/);
    symlinkSync(directory, join(root, "src/escape"));
    expect(() => governance.stageCandidateScope("run", "task", evidence("src/escape/control.db"))).toThrow(/path-escape/);
  });


  const control = () => teamControlRoutes(governance, {
    credentials: { ownerToken: "scope-owner", workers: [{ token: "scope-worker", sessionId: "worker", runId: "run" }] },
    resolveBinding: () => binding,
  }, []);
  const http = (app: ReturnType<typeof control>, path: string, body?: unknown, token = "scope-owner") =>
    app.request("http://localhost/runs/run/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { Host: "localhost", Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  it("exposes pending scope through authenticated routes and denies worker filing or decisions", async () => {
    const app = control();
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "pending");
    expect(() => packet()).toThrow(/extension-pending/);
    const extension = extensions()[0]!;
    const read = await http(app, "tasks/task/scope");
    expect(read.status).toBe(202);
    expect(await read.json()).toMatchObject({ status: "extension-pending", scope: { extensions: [{ classification: "owner-decision", state: "pending" }] } });
    expect((await http(app, "tasks/task/scope", undefined, "scope-worker")).status).toBe(403);
    const forged = command("forged", { kind: "orchestrator", action: "scope-extension", payload: {},
      targetDigest: hashBytes("forged"), expiresAt: "9999-01-01T00:00:00.000Z" });
    expect((await http(app, "approvals/request", forged, "scope-worker")).status).toBe(403);
    const decision = () => command(extension.id, { approvalVersion: 1, decision: "approved", expectedChainHead: extension.expectedChainHead });
    expect((await http(app, "approvals/decide", decision(), "scope-worker")).status).toBe(403);
    const stale = decision(); (stale.payload as Record<string, unknown>).expectedChainHead = "stale";
    expect((await http(app, "approvals/decide", stale)).status).toBe(409);
    const approved = decision();
    expect((await http(app, "approvals/decide", approved)).status).toBe(200);
    expect((await http(app, "approvals/decide", approved)).status).toBe(200);
    expect((await http(app, "tasks/task/scope")).status).toBe(200);
    expect(packet().scope!.extensions).toHaveLength(1);
  });

  it("returns the specific plan-change rule without acknowledging a refused HTTP decision", async () => {
    writeDependencies(); expect(() => packet()).toThrow(/extension-pending/);
    const extension = extensions()[0]!;
    policyInput.paths = 1;
    const result = await http(control(), "approvals/decide", command(extension.id, {
      approvalVersion: 1, decision: "approved", expectedChainHead: extension.expectedChainHead,
    }));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "plan-change-required", rule: "path-cap" });
    expect(governance.getApproval(extension.id)!.state).toBe("pending");
  });

  it("uses the same scope checks in the snapshot lane", () => {
    rmSync(join(repo, ".git"), { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    const root = candidate().root;
    writeFileSync(join(root, "src/types.ts"), "new sibling");
    expect(packet().scope!.extensions[0]!.automatic).toBe(true);
    writeFileSync(join(root, "src/neighbor.ts"), "pending neighbor");
    expect(() => packet()).toThrow(/extension-pending/);
  });

  it("does not carry approved extensions into a new binding", () => {
    writeFileSync(join(candidate().root, "src/types.ts"), "new sibling"); packet();
    const next = { ...binding, planDigest: hashBytes("new plan") };
    writeFileSync(join(repo, "plan.md"), "new plan");
    governance.createRun({ id: "next", rigId: "rig", binding: next });
    const request = (actionId: string, payload: unknown) => ({ ...command(actionId, payload), runId: "next",
      expectedEntityVersion: governance.getRun("next").entityVersion });
    governance.requestApproval(request("next-implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(next) }, targetDigest: hashBinding(next), expiresAt: "9999-01-01T00:00:00.000Z" }), owner);
    expect(governance.decideApproval(request("next-implementation", { approvalVersion: 1, decision: "approved" }), owner, next).status).toBe("accepted");
    expect(governance.createTask(request("task", { assignment: governance.findTask("run", "task")!.assignment,
      outputs: [], permissions: [], sourceSession: "lead@rig", destinationSession: "next@rig", body: "Same assignment, new binding" }), next).status).toBe("accepted");
    expect(governance.scopeForTask("next", "task").extensions).toEqual([]);
  });

  it("includes approved extensions in the live write-conflict check before launch", () => {
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "first task");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id).status).toBe("accepted");
    const assignment = { ...governance.findTask("run", "other")!.assignment, paths: ["src/neighbor.ts"] };
    const context = { runId: "run", binding, role: "implementer" } as Parameters<WorkflowRuntime["admitForLaunch"]>[1]["context"];
    expect(() => runtime.admitForLaunch("run", { attemptId: "attempt", worker: "ma-worker1",
      assignment, context, outputs: [], permissions: [],
    })).toThrow(/Dependency graph refused/);
  });

  it("returns a scope refusal for an escaping symlink at real staging", () => {
    symlinkSync(directory, join(candidate().root, "src/escape"));
    expect(() => packet()).toThrow(/plan-change-required/);
  });


  it("compares canonical foreign assignment paths, not just their alias names", () => {
    symlinkSync("neighbor.ts", join(repo, "src/alias-owned.ts"));
    expect(governance.createTask(command("alias-owner", { assignment: { taskId: "alias-owner", role: "implementer",
      paths: ["src/alias-owned.ts"], dependencies: [] }, outputs: [], permissions: [],
      sourceSession: "lead@rig", destinationSession: "alias@rig", body: "Own this alias" }), binding).status).toBe("accepted");
    expect(() => governance.stageCandidateScope("run", "task", { root: repo, candidateDigest: hashBytes("alias-conflict"),
      files: ["src/owned.ts"], changes: [{ path: "src/neighbor.ts", before: Buffer.from("before"), after: Buffer.from("after") }],
    })).toThrow(/other-task-scope/);
  });

  it("refuses an unregistered writing assignment before materializing its candidate", () => {
    const context = { runId: "run", binding, role: "implementer" } as Parameters<WorkflowRuntime["admitForLaunch"]>[1]["context"];
    expect(() => runtime.admitForLaunch("run", { attemptId: "unregistered", worker: "ma-worker1",
      assignment: { taskId: "unregistered", role: "implementer", paths: ["lib/output.ts"], dependencies: [] },
      context, outputs: [], permissions: [],
    })).toThrow(/Task not found/);
    expect(existsSync(join(directory, "assignments/ma-worker1/run-unregistered"))).toBe(false);
  });


  it.each(["Cargo.toml", "Cargo.lock", "pyproject.toml", "poetry.lock", "uv.lock", "requirements.txt",
    "requirements-dev.txt", "go.mod", "go.sum", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
    "pom.xml", "build.gradle", "pnpm-workspace.yaml", ".yarnrc.yml", ".travis.yml", "appveyor.yml",
    "bitbucket-pipelines.yml", ".drone.yml", "drone.yml", "cloudbuild.yaml", ".husky/pre-commit"])(
    "requires a plan change for the protected sibling %s", name => {
      const root = candidate().root, path = join(root, "src", name);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "configuration");
      expect(() => packet()).toThrow(/plan-change-required: protected-path/);
      expect(extensions()).toHaveLength(0);
    });

  it("retires stale pending requests and reissues an exact candidate against the current head", () => {
    const root = candidate().root, original = readFileSync(join(root, "src/neighbor.ts"));
    writeFileSync(join(root, "src/neighbor.ts"), "candidate A");
    expect(() => packet()).toThrow(/extension-pending/);
    const previous = extensions()[0]!;
    writeFileSync(join(root, "src/neighbor.ts"), original);
    writeFileSync(join(root, "src/types.ts"), "candidate B");
    const next = packet();
    expect(next.scope!.extensions.find(extension => extension.id === previous.id)!.state).toBe("invalidated");
    expect(() => decide(previous.id, "approved", previous.expectedChainHead)).toThrow(/conflict/);
    rmSync(join(root, "src/types.ts"));
    writeFileSync(join(root, "src/neighbor.ts"), "candidate A");
    expect(() => packet()).toThrow(/extension-pending/);
    const pending = extensions().filter(extension => extension.state === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(previous.id);
    expect(decide(pending[0]!.id).status).toBe("accepted");
    expect(packet().scope!.extensions.some(extension => extension.state === "pending")).toBe(false);
  });

  it("retires a pending request without a replacement and notifies scope readers", async () => {
    const root = candidate().root, original = readFileSync(join(root, "src/neighbor.ts"));
    writeFileSync(join(root, "src/neighbor.ts"), "pending neighbor");
    expect(() => packet()).toThrow(/extension-pending/);
    const previous = extensions()[0]!, version = governance.getApproval(previous.id)!.entityVersion;
    writeFileSync(join(root, "src/neighbor.ts"), original);
    const current = packet().scope!;
    expect(current.chainHead).toBe(previous.expectedChainHead);
    expect(current.extensions).toMatchObject([{ id: previous.id, state: "invalidated" }]);
    expect(governance.getApproval(previous.id)!.entityVersion).toBe(version + 1);
    expect(JSON.stringify(db.prepare("SELECT * FROM events ORDER BY rowid DESC LIMIT 1").get())).toContain("scope-extension.invalidated");
    expect((await http(control(), "tasks/task/scope")).status).toBe(200);
    const stale = command(previous.id, { approvalVersion: version + 1, decision: "approved", expectedChainHead: previous.expectedChainHead });
    expect((await http(control(), "approvals/decide", stale)).status).toBe(409);
    db.close(); open();
    expect(extensions()).toMatchObject([{ id: previous.id, state: "invalidated" }]);
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "pending neighbor");
    expect(() => packet()).toThrow(/extension-pending/);
    const pending = extensions().filter(extension => extension.state === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(previous.id);
  });

  it("preserves the bounded structured reason in review and delivery metadata", () => {
    const reason = "Worker explanation ".repeat(300);
    db.prepare("UPDATE team_queue_authority SET evidence_json = ? WHERE run_id = 'run' AND task_id = 'task'")
      .run(JSON.stringify({ scopeExtensionReason: reason }));
    writeFileSync(join(candidate().root, "src/types.ts"), "new sibling");
    const reviewed = packet();
    expect(reviewed.scope!.extensions[0]!.reason).toBe(reason.slice(0, 4096));
    expect(runtime.reviewProgress("run", "task").delivery).toMatchObject({ scope: reviewed.scope });
  });

  it("holds an existing neighboring-file edit for an owner extension decision", () => {
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "export const changed = true;\n");
    expect(() => packet()).toThrow(/extension-pending/);
  });
});
