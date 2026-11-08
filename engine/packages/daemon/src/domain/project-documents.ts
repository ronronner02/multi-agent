import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { canonicalJson, TeamContractError, type DocumentPins, type PlanBinding, type ProjectDocumentKind,
  type ProjectDocumentStage, type ProjectDocumentVersion, type ProjectDocumentWorkflow, type TeamRun } from "../contracts/team-control.js";
import { readWorkspacePath } from "./team-workspace.js";

export const DOCUMENT_KINDS = ["brainstorm", "requirements", "plan"] as const;
export type DocumentEvidence = Partial<Record<ProjectDocumentKind, { content: string; hash: string }>>;
export const documentHash = (content: string): string => "sha256:" + createHash("sha256").update(content).digest("hex");

export function documentPaths(planRef: string): Record<ProjectDocumentKind, string> {
  const folder = posix.dirname(planRef);
  return { brainstorm: posix.join(folder, "planning-docs/brainstorm.md"),
    requirements: posix.join(folder, "planning-docs/requirements.md"), plan: planRef };
}
export function documentKind(value: unknown): ProjectDocumentKind {
  if (!DOCUMENT_KINDS.includes(value as ProjectDocumentKind)) throw new TeamContractError("document.kind");
  return value as ProjectDocumentKind;
}
export function documentStage(value: unknown): ProjectDocumentStage {
  if (value !== "exploration" && value !== "requirements" && value !== "plan") throw new TeamContractError("document.stage");
  return value;
}
export function initializeDocuments(db: Database.Database, runId: string): void {
  db.prepare("INSERT INTO team_document_workflows (run_id, stage) VALUES (?, 'exploration')").run(runId);
}
export function readDocuments(db: Database.Database, run: Pick<TeamRun, "id" | "binding">): ProjectDocumentWorkflow | null {
  const state = db.prepare(`SELECT stage, confirmed_brainstorm AS brainstorm, confirmed_requirements AS requirements,
    confirmed_plan AS plan, pending_stage AS pendingStage, error FROM team_document_workflows WHERE run_id = ?`).get(run.id) as
    { stage: ProjectDocumentStage; brainstorm: string | null; requirements: string | null; plan: string | null;
      pendingStage: ProjectDocumentStage | null; error: string | null } | undefined;
  if (!state) return null;
  const versions = db.prepare(`SELECT id, kind, version, path, content, hash, requirements_version_id AS requirementsVersionId,
    source_attempt_id AS sourceAttemptId, created_at AS createdAt, confirmed_at AS confirmedAt, confirmed_by AS confirmedBy
    FROM team_document_versions WHERE run_id = ? ORDER BY rowid DESC`).all(run.id) as ProjectDocumentVersion[];
  const approvals = db.prepare(`SELECT json_extract(payload, '$.payload.documentVersions') AS pins,
    json_extract(payload, '$.payload.bindingDigest') AS bindingDigest, created_at AS createdAt FROM events
    WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ?
    AND json_extract(payload, '$.action') = 'documents.execution-approved' ORDER BY seq DESC`).all(run.id) as
    Array<{ pins: string; bindingDigest: string; createdAt: string }>;
  return { stage: state.stage, confirmed: { brainstorm: state.brainstorm, requirements: state.requirements, plan: state.plan },
    pendingStage: state.pendingStage, error: state.error, versions, executionVersions: run.binding.documentVersions ?? null,
    executionHistory: approvals.map(row => ({ bindingDigest: row.bindingDigest, versions: JSON.parse(row.pins) as DocumentPins, createdAt: row.createdAt })) };
}
export const latestDocument = (state: ProjectDocumentWorkflow, kind: ProjectDocumentKind): ProjectDocumentVersion | undefined =>
  state.versions.find(version => version.kind === kind);
export function currentConfirmed(state: ProjectDocumentWorkflow, kind: ProjectDocumentKind): ProjectDocumentVersion | null {
  const version = latestDocument(state, kind);
  return version && version.id === state.confirmed[kind] && version.content.trim() ? version : null;
}

/** Called inside governance's transaction after native lead exit, before persisting its stop; never from a read. */
export function captureDocuments(db: Database.Database, run: TeamRun, attemptId: string, evidence: DocumentEvidence,
  now: string): { changed: boolean; invalidated: boolean } {
  const state = readDocuments(db, run);
  if (!state || !db.prepare("INSERT OR IGNORE INTO team_document_captures (run_id, attempt_id) VALUES (?, ?)").run(run.id, attemptId).changes) {
    return { changed: false, invalidated: false };
  }
  const paths = documentPaths(run.binding.planRef);
  let changed = false, invalidated = false, error: string | null = null;
  for (const kind of DOCUMENT_KINDS) {
    const source = evidence[kind], previous = latestDocument(state, kind);
    // The bootstrap plan is a dispatch anchor, not a document produced by discussion.
    if (kind === "plan" && !previous && (state.stage !== "plan" || source?.hash === run.binding.planDigest)) continue;
    if (!source) {
      if (previous) error = `${kind} is missing from the lead's document files.`;
      continue;
    }
    if (Buffer.byteLength(source.content, "utf8") > 262144 || source.content.includes("\u0000") || source.hash !== documentHash(source.content)) {
      throw new TeamContractError("document.content");
    }
    if (!source.content.trim()) { if (previous) error = `${kind} is empty.`; continue; }
    const requirementsId = kind === "plan" ? state.confirmed.requirements : null;
    if (previous?.hash === source.hash && !(kind === "plan" && state.stage === "plan" && requirementsId
      && previous.requirementsVersionId !== requirementsId)) continue;
    db.prepare(`INSERT INTO team_document_versions
      (id, run_id, kind, version, path, content, hash, requirements_version_id, source_attempt_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), run.id, kind, (previous?.version ?? 0) + 1,
      paths[kind], source.content, source.hash, requirementsId, attemptId, now);
    changed = true;
    db.prepare(`UPDATE team_document_workflows SET confirmed_${kind} = NULL WHERE run_id = ?`).run(run.id);
    state.confirmed[kind] = null;
    if (kind === "requirements") {
      db.prepare("UPDATE team_document_workflows SET confirmed_plan = NULL, stage = 'requirements' WHERE run_id = ?").run(run.id);
      state.confirmed.plan = null;
    }
    if (kind !== "brainstorm" || run.binding.documentVersions?.brainstorm) invalidated = true;
  }
  db.prepare("UPDATE team_document_workflows SET error = ? WHERE run_id = ?").run(error, run.id);
  return { changed, invalidated: invalidated || error !== null };
}

export function approvalDocumentPins(state: ProjectDocumentWorkflow): DocumentPins {
  if (state.error || state.pendingStage) throw new Error(state.error ?? "Finish the pending document revision first.");
  const requirements = currentConfirmed(state, "requirements"), plan = currentConfirmed(state, "plan");
  if (state.stage !== "plan" || !requirements || !plan) throw new Error("Confirm the current requirements and plan before approving execution.");
  if (plan.requirementsVersionId !== requirements.id) throw new Error("The plan must be regenerated from the confirmed requirements version.");
  const pin = (v: ProjectDocumentVersion) => ({ versionId: v.id, hash: v.hash });
  const brainstorm = currentConfirmed(state, "brainstorm");
  return { requirements: pin(requirements), plan: pin(plan), ...(brainstorm ? { brainstorm: pin(brainstorm) } : {}) };
}

export function documentSourceRefusal(state: ProjectDocumentWorkflow, evidence: DocumentEvidence,
  kinds: readonly ProjectDocumentKind[] = DOCUMENT_KINDS): string | null {
  for (const kind of kinds) {
    const current = latestDocument(state, kind);
    if (current && (!evidence[kind] || evidence[kind]!.hash !== current.hash || documentHash(evidence[kind]!.content) !== current.hash)) {
      return `The ${kind} source changed. Wait for the lead's next saved version before confirming.`;
    }
  }
  return null;
}

/** Used at admission and again at the actual native launch, including resumed attempts. */
export function documentDispatchRefusal(db: Database.Database, run: TeamRun, role: string,
  taskId?: string, expectedBinding?: PlanBinding): string | null {
  const state = readDocuments(db, run);
  if (!state) return null;
  if (state.pendingStage) return "Document revision is pending; execution is suspended";
  if (expectedBinding && canonicalJson(expectedBinding.documentVersions ?? null) !== canonicalJson(run.binding.documentVersions ?? null)) {
    return "Approved document versions changed before launch";
  }
  if (run.phase === "planning") return role === "lead" ? null : "Execution waits for approved document versions";
  let pins: DocumentPins;
  try { pins = approvalDocumentPins(state); } catch (error) { return (error as Error).message; }
  if (canonicalJson(pins) !== canonicalJson(run.binding.documentVersions ?? null)) return "Approved document versions are no longer current";
  if (taskId && role !== "lead") {
    const task = db.prepare("SELECT document_versions_json AS pins FROM team_queue_authority WHERE run_id = ? AND task_id = ?")
      .get(run.id, taskId) as { pins: string | null } | undefined;
    if (!task?.pins || canonicalJson(JSON.parse(task.pins)) !== canonicalJson(pins)) return "This task belongs to superseded document versions";
  }
  try {
    const paths = documentPaths(run.binding.planRef);
    for (const kind of DOCUMENT_KINDS) {
      if (!pins[kind]) continue;
      const source = readWorkspacePath(run.binding.repository.root, paths[kind], () => false);
      if (source.kind !== "file" || source.hash !== pins[kind]!.hash) return "Approved document source changed before launch";
    }
  } catch { return "Approved document source is unreadable"; }
  return null;
}

/** Stage semantics are product-owned; uninstalled workflow catalogs are not execution evidence. */
export function documentInstructions(state: ProjectDocumentWorkflow, planRef: string, maxSeats = 6): string {
  const paths = documentPaths(planRef);
  const requirements = currentConfirmed(state, "requirements");
  const common = "Planning discussion only: do not implement, review, run subagents, or create executable task proposals. " +
    "The owner controls stage transitions and confirms exact versions in chat or the document center. Your prose never approves a document. " +
    "Answer in the owner's conversation language. Keep the document appropriate to this project's size. " +
    "Ask unresolved decisions through the conversation question file before treating the document as ready. " +
    "End with a brief summary of the document updated and the next owner action.\n\n";
  if (state.stage === "exploration") return common +
    `Explore the idea, users, desired outcome, scope, alternatives and trade-offs. Ask focused questions rather than inventing answers. ` +
    `When discovery is worth retaining, write ${paths.brainstorm} with sections: Idea and outcome; Options and trade-offs; ` +
    "Decisions; Open questions; Scope boundaries. Brainstorm is optional when the request is already clear. " +
    "Do not write requirements or an execution plan at this stage. When choices are settled, ask the owner to select Prepare requirements. " +
    "Do not offer Generate plan yet; requirements must be written and confirmed first.";
  if (state.stage === "requirements") return common +
    `Read the discussion and optional ${paths.brainstorm}. Write or revise ${paths.requirements} as a PRD or right-sized requirements document. ` +
    "Include Summary; Change delta; numbered Requirements; concrete Acceptance examples; Scope boundaries; Evidence and assumptions; " +
    "Open questions. Preserve confirmed decisions and distinguish assumptions from facts. Do not decide implementation tasks here. " +
    "Do not change the plan; it will be derived after the owner confirms this requirements version. When questions are resolved, " +
    "ask the owner to Confirm requirements, then select Generate plan. Neither action starts execution.";
  return common + `The owner confirmed requirements version ${requirements?.version ?? "(missing)"}, id ${requirements?.id ?? "(missing)"}, ` +
    `hash ${requirements?.hash ?? "(missing)"}. Read ${paths.requirements} and use exactly that version; if it needs a change, ask the owner ` +
    "to return to Requirements instead of silently changing it.\n\n" +
    `Write ${paths.plan} with Goal; Approved requirements reference; Approach and trade-offs; ordered Tasks with dependencies and touched files; ` +
    "Verification per task; Risks and open decisions. Link each task to requirement IDs. " +
    `Write ${posix.join(posix.dirname(planRef), "lead-roster.json")} as {"seats":[{"role":"implementer","client":"codex","model":"<allowed model>"},` +
    `{"role":"reviewer","client":"claude-code","model":"<allowed model>"}]}. Those clients are examples; use only the owner's allowed pairs. ` +
    `Choose at least one implementer, at most one reviewer and at most ${maxSeats} non-lead seats. ` +
    "This is only a plan: execution tasks are admitted after the owner separately approves execution. " +
    "Ask the owner to Confirm plan; only a separate Approve execution starts work.";
}
