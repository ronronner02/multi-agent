import { resolve } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { canonicalJson, object, parseAssignment, parsePlanBinding, relativePath, text, type PlanBinding, type ScopedAssignment, type TeamRole } from "../contracts/team-control.js";
import { hashBinding, hashBytes } from "./plan-governance.js";
import { immutable, physicalPath, roleConfiguration, verifyEffectiveContext, type ContextManifest, type ContextObservation } from "../integrations/framework/context-manifest.js";

export interface AssignmentInput {
  binding: PlanBinding; currentBinding: PlanBinding; assignment: ScopedAssignment; outputs: string[]; permissions: string[];
  context: ContextManifest; observed: ContextObservation; dependencySatisfied: (taskId: string) => boolean;
  taskPack?: { path: string; targetRepository: string; validate: (path: string, root: string) => Promise<unknown> };
}
export function assertRolePermission(role: TeamRole, permission: string): void {
  if (!roleConfiguration[role]?.permissions.includes(permission)) throw new Error("Role permission denied");
}
export async function prepareTeamAssignment(input: AssignmentInput) {
  input = { ...input, context: immutable(structuredClone(input.context)), outputs: [...input.outputs], permissions: [...input.permissions] };
  const binding = parsePlanBinding(input.binding), assignment = parseAssignment(input.assignment), current = parsePlanBinding(input.currentBinding);
  if (hashBinding(binding) !== hashBinding(current) || hashBinding(binding) !== hashBinding(input.context.binding)) throw new Error("Plan, repository or policy changed");
  if (realpathSync(binding.repository.root) !== binding.repository.root || hashBytes(readFileSync(physicalPath(binding.repository.root, binding.planRef))) !== binding.planDigest) throw new Error("Source plan or repository changed");
  if (assignment.role !== input.context.role || !binding.roles.includes(assignment.role)) throw new Error("Assignment role is outside the approval");
  const allowed = assignment.role === "reviewer" ? [...binding.readPaths, ...binding.writePaths] : binding.writePaths;
  const covered = (path: string, paths: string[]) => paths.some(p => path === p || path.startsWith(`${p}/`));
  for (const path of [...assignment.paths, ...input.outputs]) {
    relativePath(path, "assignment.path");
    if (physicalPath(binding.repository.root, path) !== resolve(binding.repository.root, path)) throw new Error("Assignment aliases require scope reconciliation");
    if (!covered(path, allowed) || (input.outputs.includes(path) && !covered(path, assignment.paths))) throw new Error("Assignment or output expands the approved scope");
  }
  for (const permission of input.permissions) assertRolePermission(assignment.role, permission);
  if (input.outputs.length && !input.permissions.includes("write-assigned-tree")) throw new Error("Read-only roles cannot declare tree outputs");
  if (canonicalJson(input.context.assignment) !== canonicalJson(assignment) || canonicalJson(input.context.outputs) !== canonicalJson(input.outputs) || canonicalJson(input.context.permissions) !== canonicalJson(input.permissions)) throw new Error("Context differs from the exact assignment");
  if (assignment.dependencies.some(id => !input.dependencySatisfied(id))) throw new Error("Dependency lacks validated success");
  let taskPackDigest: string | null = null;
  if (input.taskPack) {
    relativePath(input.taskPack.path, "taskPack.path"); const path = physicalPath(binding.repository.root, input.taskPack.path);
    taskPackDigest = hashBytes(readFileSync(path));
    const receipt = object(await input.taskPack.validate(input.taskPack.path, binding.repository.root), "taskPack.receipt");
    const validation = object(receipt.validation, "taskPack.validation"), source = object(receipt.source_plan, "taskPack.source");
    if (receipt.identity_basis !== "source-plan-path+body-hash" || receipt.task_pack_path !== path || receipt.schema_version !== "task-pack-validation/v1" || receipt.task_pack_validity !== "valid" || receipt.deterministic_handoff !== true || receipt.artifact_root !== binding.repository.root || source.path !== binding.planRef || validation.source_plan_hash !== "matched" || validation.task_pack_contract !== "valid" || validation.source_plan_lifecycle !== "active" || validation.spec_id === "mismatch" || hashBytes(readFileSync(path)) !== taskPackDigest) throw new Error("Invalid or stale upstream task pack");
    const pack = object(receipt.task_pack, "taskPack"), contract = object(pack.contract, "taskPack.contract");
    const tasks = contract.tasks as { task_id: string; target_repo: string; files: string[]; dependencies: string[] }[];
    const task = Array.isArray(tasks) ? tasks.find(t => t.task_id === assignment.taskId) : undefined;
    if (!task || task.target_repo !== text(input.taskPack.targetRepository, "targetRepository") || !assignment.paths.every(p => task.files.includes(p)) || canonicalJson(assignment.dependencies) !== canonicalJson(task.dependencies)) throw new Error("Assignment differs from the validated task");
  }
  if (hashBytes(readFileSync(physicalPath(binding.repository.root, binding.planRef))) !== binding.planDigest || assignment.dependencies.some(id => !input.dependencySatisfied(id))) throw new Error("Source or dependency changed during preparation");
  const observedHash = verifyEffectiveContext(input.context, input.observed);
  return immutable({ binding, assignment, outputs: [...input.outputs], permissions: [...input.permissions], client: input.context.client, context: input.context, observedHash, taskPackDigest });
}
export class LeadActivation {
  private evaluation: string | null = null;
  readonly manifest: ContextManifest;
  constructor(manifest: ContextManifest, observed: ContextObservation) {
    this.manifest = immutable(structuredClone(manifest));
    if (manifest.role !== "lead") throw new Error("Lead context required"); verifyEffectiveContext(this.manifest, observed);
  }
  request(permission: string): void { assertRolePermission("lead", permission); }
  recordEvaluation(summary: string): void { text(summary, "evaluation"); if (this.evaluation !== null) throw new Error("Lead evaluation already recorded"); this.evaluation = summary; }
  finish() { return immutable({ activationId: this.manifest.lead!.activationId, contextHash: this.manifest.generatedHash, status: this.evaluation === null ? "incomplete" : "evaluated", evaluation: this.evaluation }); }
}
