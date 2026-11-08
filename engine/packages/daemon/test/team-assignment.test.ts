import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTeamAssignment, type AssignmentInput } from "../src/domain/team-assignment.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import type { TeamRun, TeamTaskAuthority } from "../src/contracts/team-control.js";
import { PlanGovernance, hashBytes } from "../src/domain/plan-governance.js";
vi.mock("../src/integrations/framework/context-manifest.js", async original => ({ ...await original<typeof import("../src/integrations/framework/context-manifest.js")>(), verifyEffectiveContext: vi.fn(() => "observed-hash") }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture(): AssignmentInput {
  const root = mkdtempSync(join(tmpdir(), "assignment-test-")); roots.push(root); mkdirSync(join(root, "src")); writeFileSync(join(root, "plan.md"), "approved plan");
  const binding: AssignmentInput["binding"] = { artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active", planRef: "plan.md", planDigest: hashBytes("approved plan"), repository: { root, identity: "git:" + "a".repeat(40) }, readPaths: ["test"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"], policyRevision: 2, policyFingerprint: hashBytes("policy"), limits: { maxSessions: 3, maxActiveMs: 60000, maxRetries: 1, maxReviewRounds: 2 } };
  const assignment: AssignmentInput["assignment"] = { taskId: "T007", role: "implementer", paths: ["src"], dependencies: [] }, outputs = ["src/result.ts"], permissions = ["write-assigned-tree"];
  return { binding, currentBinding: structuredClone(binding), assignment, outputs, permissions, context: { runId: "run", binding, assignment, outputs, permissions, role: "implementer", client: "claude-code" } as AssignmentInput["context"], observed: { files: [], discoveryRoots: [] }, dependencySatisfied: () => false };
}
function receipt(input: AssignmentInput) { return { identity_basis: "source-plan-path+body-hash", task_pack_path: join(input.binding.repository.root, "tasks.md"), schema_version: "task-pack-validation/v1", task_pack_validity: "valid", deterministic_handoff: true, artifact_root: input.binding.repository.root, source_plan: { path: "plan.md" }, validation: { source_plan_hash: "matched", task_pack_contract: "valid", source_plan_lifecycle: "active" }, task_pack: { contract: { tasks: [{ task_id: "T007", target_repo: "fixture", files: ["src"], dependencies: [] }] } } }; }
it("supports direct plan assignment with minimal staffing and immutable scope", async () => { const input = fixture(), result = await prepareTeamAssignment(input); expect(result.assignment.role).toBe("implementer"); expect(result.client).toBe("claude-code"); expect(result.observedHash).toBe("observed-hash"); expect(Object.isFrozen(result.binding.writePaths)).toBe(true); expect(input.binding.writePaths).toEqual(["src"]); });
it("prepares project-wide assignments while retaining concrete outputs and protected paths", async () => {
  const input = fixture();
  input.binding.readPaths = ["."];
  input.binding.writePaths = ["."];
  input.currentBinding = structuredClone(input.binding);
  input.assignment.paths = ["package.json", "server", "client", "index.html"];
  input.outputs = ["package.json", "server/main.ts", "client/main.ts", "index.html"];
  input.context = { ...input.context, outputs: input.outputs };
  expect((await prepareTeamAssignment(input)).assignment.paths).toEqual(input.assignment.paths);
  input.outputs = ["server/.env.local"];
  input.context = { ...input.context, outputs: input.outputs };
  await expect(prepareTeamAssignment(input)).rejects.toThrow(/expands the approved scope/);
  input.outputs = ["outside-task.ts"];
  input.context = { ...input.context, outputs: input.outputs };
  await expect(prepareTeamAssignment(input)).rejects.toThrow(/expands the approved scope/);
  symlinkSync(tmpdir(), join(input.binding.repository.root, "server"));
  input.outputs = ["server/external.ts"];
  await expect(prepareTeamAssignment(input)).rejects.toThrow();
});
it.each(["repository", "policy", "digest", "inactive", "role", "path", "output", "permission", "dependency", "symlink", "source", "internal-path", "internal-output"])("rejects invalid assignment: %s", async kind => { const input = fixture(); if (kind === "repository") input.currentBinding.repository.identity = "git:" + "b".repeat(40); if (kind === "policy") input.currentBinding.policyRevision++; if (kind === "digest") input.currentBinding.planDigest = hashBytes("changed"); if (kind === "inactive") input.currentBinding.status = "completed" as "active"; if (kind === "role") input.assignment.role = "reviewer"; if (kind === "path") input.assignment.paths = ["outside"]; if (kind === "output") input.outputs = ["test/report.md"]; if (kind === "permission") input.permissions = ["merge"]; if (kind === "dependency") input.assignment.dependencies = ["T006"]; if (kind === "symlink") { symlinkSync(tmpdir(), join(input.binding.repository.root, "src", "escape")); input.outputs = ["src/escape/new.ts"]; } if (kind.startsWith("internal-")) { mkdirSync(join(input.binding.repository.root, "test")); symlinkSync("../test", join(input.binding.repository.root, "src", "alias")); input.outputs[0] = "src/alias/result.ts"; if (kind === "internal-path") input.assignment.paths = ["src/alias"]; } if (kind === "source") writeFileSync(join(input.binding.repository.root, "plan.md"), "changed plan"); await expect(prepareTeamAssignment(input)).rejects.toThrow(); });
it.each(["lead", "reviewer"] as const)("%s never acquires assigned-tree writes", async role => { const input = fixture(); input.assignment.role = role; input.context = { ...input.context, role, client: "codex" }; await expect(prepareTeamAssignment(input)).rejects.toThrow("Role permission denied"); });
it.each(["valid", "stale", "invalid", "task", "changed"])("honors upstream task-pack validation: %s", async kind => { const input = fixture(); writeFileSync(join(input.binding.repository.root, "tasks.md"), "task pack"); const validate = vi.fn(async () => { const r = receipt(input); if (kind === "stale") r.validation.source_plan_hash = "mismatch"; if (kind === "invalid") r.task_pack_validity = "invalid"; if (kind === "task") r.task_pack.contract.tasks[0]!.files = ["other"]; if (kind === "changed") writeFileSync(join(input.binding.repository.root, "tasks.md"), "changed"); return r; }); input.taskPack = { path: "tasks.md", targetRepository: "fixture", validate }; if (kind === "valid") expect((await prepareTeamAssignment(input)).taskPackDigest).toBe(hashBytes("task pack")); else await expect(prepareTeamAssignment(input)).rejects.toThrow(); expect(validate).toHaveBeenCalledOnce(); });
it("accepts the actual upstream validator receipt for a real task pack", async () => {
  const repo = resolve(fileURLToPath(new URL("../../../..", import.meta.url))), planRef = "docs/plans/2026-10-13-001-feat-multi-agent-team-plan.md", path = "docs/tasks/2026-10-13-001-feat-multi-agent-team-tasks.md";
  const root = mkdtempSync(join(tmpdir(), "assignment-pack-")); roots.push(root); mkdirSync(join(root, "docs/plans"), { recursive: true }); mkdirSync(join(root, "docs/tasks"), { recursive: true });
  const planText = readFileSync(join(repo, planRef), "utf8").replace(/^status: partially-shipped$/m, "status: active");
  writeFileSync(join(root, planRef), planText);
  const planLines = planText.split("\n"), body = planLines.slice(planLines.findIndex((line, i) => i > 0 && line === "---") + 1).join("\n");
  writeFileSync(join(root, path), readFileSync(join(repo, path), "utf8").replace(/^source_plan_hash: .*$/m, `source_plan_hash: sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`));
  const input = fixture();
  input.binding.planRef = planRef;
  input.binding.planDigest = hashBytes(planText);
  input.binding.repository.root = root;
  input.binding.writePaths = ["engine/packages/daemon/src/domain/team-assignment.ts"];
  input.currentBinding = structuredClone(input.binding);
  input.assignment.paths = [...input.binding.writePaths];
  input.assignment.dependencies = ["T006"];
  input.outputs = [...input.assignment.paths];
  input.dependencySatisfied = () => true;
  input.taskPack = { path, targetRepository: "ronronner02/multi-agent", validate: async (pack, testRoot) => JSON.parse(execFileSync(process.execPath, ["/mnt/d/dev/npm-global/node_modules/spec-first/bin/spec-first.js", "tasks", "validate", pack, "--repo", testRoot, "--json"], { cwd: testRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })) };
  input.context = { ...input.context, assignment: input.assignment, outputs: input.outputs };
  expect((await prepareTeamAssignment(input)).taskPackDigest).toBe(hashBytes(readFileSync(resolve(root, path))));
});
it.each([["done", true, true], ["done", false, false], ["handed-off", true, false], ["failed", true, false], ["pending", true, false]] as const)("runtime dependency %s with validated=%s has eligibility=%s", async (state, validated, eligible) => {
  const input = fixture(); input.assignment.dependencies = ["T006"];
  vi.spyOn(PlanGovernance.prototype, "getRun").mockReturnValue({ binding: input.binding, state: "approved" } as TeamRun);
  vi.spyOn(PlanGovernance.prototype, "getTask").mockReturnValue({ evidence: { validated } } as TeamTaskAuthority);
  const all = vi.fn(() => [{ id: "queue-6" }]), get = vi.fn(() => undefined);
  const db = { prepare: vi.fn(() => ({ all, get })) };
  const runtime = Object.assign(Object.create(WorkflowRuntime.prototype) as WorkflowRuntime, { db, eventBus: { db }, queueRepo: { db, getById: () => ({ qitemId: "queue-6", state }) } });
  const result = runtime.prepareTeamAssignment("run", input);
  if (eligible) expect((await result).assignment.taskId).toBe("T007"); else await expect(result).rejects.toThrow("Dependency lacks validated success");
  expect(all).toHaveBeenCalledWith("run", "T006");
  if (state === "done" && validated) expect(get).toHaveBeenCalledWith("queue-6"); else expect(get).not.toHaveBeenCalled();
});
it.each(["pending", "invalidated", "cancel_requested"] as const)("runtime blocks an assignment for a %s run", state => {
  const input = fixture(), db = {}, runtime = Object.assign(Object.create(WorkflowRuntime.prototype) as WorkflowRuntime, { db, eventBus: { db }, queueRepo: { db } });
  vi.spyOn(PlanGovernance.prototype, "getRun").mockReturnValue({ binding: input.binding, state } as TeamRun);
  expect(() => runtime.prepareTeamAssignment("run", input)).toThrow("Run is not approved");
});
it.each(["lead", "reviewer"] as const)("%s rejects tree outputs and accepts a read-only assignment", async role => {
  const input = fixture(); input.assignment.role = role; input.permissions = role === "lead" ? ["request-assignment"] : ["submit-review"]; input.context = { ...input.context, role, client: "codex", permissions: input.permissions };
  await expect(prepareTeamAssignment(input)).rejects.toThrow("Read-only roles"); input.outputs = []; input.context = { ...input.context, outputs: [] }; expect((await prepareTeamAssignment(input)).outputs).toEqual([]);
});
it("Lead activation uses a freshly supplied policy binding", async () => {
  const input = fixture(), db = {}, runtime = Object.assign(Object.create(WorkflowRuntime.prototype) as WorkflowRuntime, { db, eventBus: { db }, queueRepo: { db } });
  vi.spyOn(PlanGovernance.prototype, "getRun").mockReturnValue({ binding: input.binding, state: "approved" } as TeamRun); input.currentBinding.policyRevision++; input.assignment.role = "lead"; input.outputs = []; input.permissions = ["request-assignment"]; input.context = { ...input.context, role: "lead", client: "codex", outputs: [], permissions: input.permissions, lead: { activationId: "activation-1", roster: [], instructions: "current run" } };
  await expect(runtime.startLeadActivation(input.context, input.observed, input.currentBinding)).rejects.toThrow("Run is not approved");
});
