import { bindingCovers } from "./binding-scope.js";
import type Database from "better-sqlite3";
import { posix } from "node:path";
import { canonicalJson, integer, object, parseAssignment, TeamContractError, type TeamRun } from "../contracts/team-control.js";
import { QUEUE_PRIORITIES, type QueueRepository } from "./queue-repository.js";
import { dependencySatisfied, validateDependencyGraph } from "./workflow-runtime.js";
import { roleConfiguration } from "./role-configuration.js";
import { ScopeExtensions } from "./scope-extension.js";

const material = ["addTask", "removeTask", "scope", "paths", "acceptanceCriteria", "limits"];
const immediate = ["priority", "role", "order", "notes", "dependencies"];

export function readTaskEdit(db: Database.Database, runId: string, taskId: string) {
  const row = db.prepare(`SELECT a.qitem_id AS qitemId, a.assignment_json AS assignment, a.entity_version AS taskVersion,
    a.permissions_json AS permissions, q.priority, q.state FROM team_queue_authority a
    JOIN queue_items q ON q.qitem_id=a.qitem_id WHERE a.run_id=? AND a.task_id=?`).get(runId, taskId) as {
      qitemId: string; assignment: string; taskVersion: number; permissions: string | null; priority: string; state: string;
    } | undefined;
  if (!row) throw new Error("Task not found in this run");
  const raw = JSON.parse(row.assignment), assignment = parseAssignment(raw);
  return { qitemId: row.qitemId, taskId, taskVersion: row.taskVersion, state: row.state, priority: row.priority,
    role: assignment.role, paths: assignment.paths, dependencies: assignment.dependencies,
    notes: (raw.ownerEdit?.notes ?? "") as string, order: (raw.ownerEdit?.order ?? 0) as number };
}

/** Called only within the governance command transaction, never as a second control owner. */
export function applyTaskEdit(db: Database.Database, queue: QueueRepository, run: TeamRun, taskId: string, payload: unknown, now: string, eligibility: () => string | null) {
  if (!db.inTransaction) throw new Error("Task edits require the governance transaction");
  const current = readTaskEdit(db, run.id, taskId), input = object(payload, "taskEdit");
  if (Object.keys(input).some(key => !["expectedTaskVersion", "changes"].includes(key))) throw new TeamContractError("taskEdit");
  if (integer(input.expectedTaskVersion, "expectedTaskVersion", 1) !== current.taskVersion) throw new Error("Task version conflict");
  const changes = object(input.changes, "changes"), keys = Object.keys(changes);
  if (!keys.length || keys.some(key => ![...material, ...immediate].includes(key))) throw new TeamContractError("changes");
  if (changes.priority !== undefined && !QUEUE_PRIORITIES.includes(changes.priority as typeof QUEUE_PRIORITIES[number])) throw new TeamContractError("priority");
  if (changes.notes !== undefined && (typeof changes.notes !== "string" || changes.notes.length > 16384)) throw new TeamContractError("notes");
  if (changes.order !== undefined) integer(changes.order, "order", 0, 100);
  const rows = db.prepare("SELECT qitem_id AS qitemId, assignment_json AS assignment, permissions_json AS permissions FROM team_queue_authority WHERE run_id=? ORDER BY task_id")
    .all(run.id) as Array<{ qitemId: string; assignment: string; permissions: string | null }>;
  const tasks = rows.map(row => ({ ...row, parsed: parseAssignment(JSON.parse(row.assignment)) }));
  if (keys.some(key => material.includes(key))) {
    return { status: "accepted" as const, value: { classification: "plan-change-required" as const,
      task: current, affectedTasks: tasks.map(task => task.parsed.taskId), requestedChanges: changes, bindingDigest: run.bindingDigest } };
  }
  const reason = eligibility();
  if (reason) return { status: "denied" as const, reason };
  const record = tasks.find(task => task.parsed.taskId === taskId)!;
  const next = parseAssignment({ ...record.parsed, ...(changes.role === undefined ? {} : { role: changes.role }),
    ...(changes.dependencies === undefined ? {} : { dependencies: changes.dependencies }) });
  const deny = (reason: string) => ({ status: "denied" as const, reason });
  if (changes.role !== undefined || changes.dependencies !== undefined) {
    if (!["pending", "blocked"].includes(current.state)
      || db.prepare("SELECT 1 FROM team_attempts WHERE qitem_id=? AND state <> 'stopped'").get(current.qitemId)) return deny("Active or completed task assignments cannot be edited");
    if (!run.binding.roles.includes(next.role)) return deny("Role is outside the current plan binding");
    const covers = (path: string) => bindingCovers(path, run.binding.writePaths);
    const extensions = new ScopeExtensions(db);
    const graph = tasks.map(task => {
      const assignment = task.parsed.taskId === taskId ? next : task.parsed;
      const claims = [...new Set([...assignment.paths, ...extensions.records(run.id, assignment.taskId)
        .filter(extension => extension.bindingDigest === run.bindingDigest && extension.state === "approved")
        .flatMap(extension => extension.paths.flatMap(path => [path.path, path.canonicalPath]))]
        .map(path => posix.normalize(path.replaceAll("\\", "/")).replace(/\/$/, "")))];
      const paths = claims.filter(path => !claims.some(other => other !== path && path.startsWith(other + "/")));
      return { ...assignment, paths };
    });
    if (next.role !== "reviewer" && !graph.find(task => task.taskId === taskId)!.paths.every(covers)) return deny("Role edit would expand writable scope");
    if (record.permissions === null || (JSON.parse(record.permissions) as string[]).some(permission => !roleConfiguration[next.role].permissions.includes(permission))) {
      return deny("Role edit would change the recorded permission grant");
    }
    const verdict = validateDependencyGraph(graph);
    if (!verdict.ok) return deny(verdict.reason);
    if (changes.dependencies !== undefined && [...new Set([...record.parsed.dependencies, ...next.dependencies])].some(dependency =>
      !dependencySatisfied(db, queue, id => {
        const row = db.prepare("SELECT evidence_json AS evidence FROM team_queue_authority WHERE qitem_id=?").get(id) as { evidence: string | null } | undefined;
        return row?.evidence !== null && row?.evidence !== undefined && JSON.parse(row.evidence).validated === true;
      }, run.id, dependency))) return deny("Dependency edit requires validated prerequisite evidence");
  }
  // Notes and display order are owner metadata, not additions to the parsed assignment's authority.
  const ownerEdit = { notes: changes.notes ?? current.notes, order: changes.order ?? current.order };
  const updated = db.prepare("UPDATE team_queue_authority SET assignment_json=?, entity_version=entity_version+1 WHERE qitem_id=? AND entity_version=?")
    .run(canonicalJson({ ...next, ownerEdit }), current.qitemId, current.taskVersion);
  if (updated.changes !== 1) throw new Error("Task version conflict");
  if (changes.priority !== undefined) db.prepare("UPDATE queue_items SET priority=?, ts_updated=? WHERE qitem_id=?").run(changes.priority, now, current.qitemId);
  return { status: "accepted" as const, value: { classification: "applied" as const, task: readTaskEdit(db, run.id, taskId), affectedTasks: [] } };
}
