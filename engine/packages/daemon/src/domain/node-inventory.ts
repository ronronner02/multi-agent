import type { CaptureObserver, ObservedBinding } from "./capture-observer.js";
import type Database from "better-sqlite3";
import { decodeTime } from "ulid";
import { resolveActiveOccupantRow } from "./active-occupant.js";
import type { NodeInventoryEntry, NodeDetailEntry, NodeDetailPeer, NodeDetailEdge, NodeDetailCompactSpec, NodeRestoreOutcome, NodeOriented, NodeLifecycleState, Binding, RestoreResult, NodeRecoveryGuidance, Snapshot, WorkspaceSpec, SeatIdentityVerdict, SeatIdentityVerdictKind, AgentActivity, SeatActivity } from "./types.js";
import { identityVerdictConfirmsSessionMissing, identityVerdictDownranksRunning } from "./types.js";
import { buildOrientedMap } from "./startup-proof.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { ContextUsageStore } from "./context-usage-store.js";
import type { TranscriptStore } from "./transcript-store.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import { findLatestUsableSnapshot, findLatestUsableSnapshotsForAllRigs } from "./rig-repository.js";
import { resolveNodeWorkspace } from "./workspace/workspace-resolver.js";
import { deriveCanonicalSessionName } from "./session-name.js";
import { buildNativeResumeCommand, buildCodexResumeCore } from "./native-resume-probe.js";

// -- Row types for SQL results --

interface InventoryRow {
  node_id: string;
  rig_id: string;
  rig_name: string;
  logical_id: string;
  pod_id: string | null;
  pod_namespace: string | null;
  role: string | null;
  runtime: string | null;
  model: string | null;
  codex_config_profile: string | null;
  agent_ref: string | null;
  profile: string | null;
  cwd: string | null;
  restore_policy: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
  resolved_spec_hash: string | null;
  occupant_lifecycle: string | null;
  continuity_outcome: string | null;
  handover_result: string | null;
  previous_occupant: string | null;
  handover_at: string | null;
  // Newest session fields (may be null if no session)
  session_id: string | null;
  session_name: string | null;
  session_created_at: string | null;
  session_status: string | null;
  intentionally_stopped: number | null;
  startup_status: string | null;
  resume_type: string | null;
  resume_token: string | null;
  startup_completed_at: string | null;
  binding_attachment_type: string | null;
  binding_id: string | null;
  binding_tmux_pane: string | null;
}

interface EventRow {
  seq: number;
  rig_id: string;
  node_id: string;
  type: string;
  payload: string;
  created_at: string;
}

interface StartupContextRow {
  node_id: string;
  projection_entries_json: string;
  resolved_files_json: string;
  startup_actions_json: string;
  runtime: string;
}

interface BindingRow {
  id: string;
  node_id: string;
  attachment_type: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  external_session_name: string | null;
  cmux_workspace: string | null;
  cmux_surface: string | null;
  updated_at: string;
}

// -- Helpers --

function computeResumeCommand(runtime: string | null, resumeToken: string | null, codexConfigProfile?: string | null): string | null {
  return buildNativeResumeCommand(runtime, resumeToken, null, codexConfigProfile);
}

function computeRecoveryGuidance(input: {
  runtime: string | null;
  resumeToken: string | null;
  cwd: string | null;
  sessionName: string | null;
  codexConfigProfile?: string | null;
}): NodeRecoveryGuidance | null {
  const { runtime, resumeToken, cwd, sessionName, codexConfigProfile } = input;

  if (runtime === "claude-code") {
    const commands: string[] = [];
    const notes: string[] = [];

    if (resumeToken) {
      const cmd = buildNativeResumeCommand(runtime, resumeToken, sessionName);
      if (cmd) commands.push(cmd);
    }
    if (cwd) {
      commands.push(`cd ${cwd}`);
    }
    commands.push("claude --resume");

    if (sessionName) {
      notes.push(`Look for session name: ${sessionName}`);
    }
    notes.push("Choose the full conversation option, not summary.");

    return {
      summary: resumeToken
        ? "Try native Claude resume first, then fall back to the workspace-local picker if needed."
        : "No stored Claude resume token. Use the workspace-local Claude picker fallback.",
      commands,
      notes,
    };
  }

  if (runtime === "codex") {
    const commands: string[] = [];
    const notes: string[] = [];

    if (resumeToken) {
      commands.push(buildCodexResumeCore(resumeToken, codexConfigProfile));
    }
    if (cwd) {
      commands.push(`cd ${cwd}`);
    }
    if (!resumeToken) {
      commands.push(buildCodexResumeCore("", codexConfigProfile, true));
    }

    notes.push("Use workspace and recent prompt text to identify the right conversation.");
    if (codexConfigProfile) {
      notes.push(`Preserve Codex config profile: ${codexConfigProfile}`);
    }
    if (sessionName) {
      notes.push(`If the identity anchor was captured, the picker may include: ${sessionName}`);
    }

    return {
      summary: resumeToken
        ? "Try native Codex resume first; the managed launch sets the explicit -s workspace-write floor flag unless a named config profile is present."
        : "No stored Codex resume token. Try codex -s workspace-write resume --last; the managed launch sets the explicit -s workspace-write floor flag unless a named config profile is present.",
      commands,
      notes,
    };
  }

  return null;
}

function deriveNodeKind(runtime: string | null): "agent" | "infrastructure" {
  return runtime === "terminal" ? "infrastructure" : "agent";
}

/**
 * Derives per-node lifecycle state from session/restore truth plus the rig's latest
 * usable snapshot.
 *
 * Priorities (post-L2):
 *   attention_required  — restoreOutcome=failed AND tmux session is alive
 *                         (v0 proxy for the Claude resume-prompt case; revisited in L3).
 *   running             — sessionStatus=running.
 *   recoverable         — non-running session AND the latest usable snapshot has a
 *                         non-null resume token for THIS node.
 *   detached            — anything else (no session, exited, detached without resume token).
 *
 * Permission/IO failures upstream (L1 fail-closed) leave sessionStatus unchanged, so
 * the projection stays honest without misclassifying ambiguous probe failures.
 */
export function deriveNodeLifecycleState(input: {
  sessionStatus: string | null;
  /** Startup attention is live seat state, independent of restore history. */
  startupStatus?: string | null;
  restoreOutcome: NodeRestoreOutcome;
  nodeId: string;
  usableSnapshot: Snapshot | null;
  /** OPR.0.4.3.19 — the persisted liveness identity verdict for this node.
   *  A `mismatch`/`pane_missing` verdict down-ranks a `running` session to
   *  `attention_required` (no false-green). `verified`, `tmux_unavailable`,
   *  and an absent verdict leave the projection unchanged. */
  identityVerdict?: SeatIdentityVerdictKind | null;
}): NodeLifecycleState {
  // L3: the explicit `attention_required` outcome (Claude resume-selection
  // prompt) and the L2 proxy (failed + alive tmux session) both surface as
  // lifecycleState=attention_required.
  if (
    input.startupStatus === "attention_required"
    || input.restoreOutcome === "attention_required"
    || (input.restoreOutcome === "failed" && input.sessionStatus === "running")
  ) {
    return "attention_required";
  }
  if (input.sessionStatus === "running") {
    // OPR.0.4.3.19 — a `running` session projects `running` ONLY when its
    // pane process identity is verified (or not-yet-observed). An explicit
    // mismatch/pane-missing verdict down-ranks to attention_required so a
    // dead/orphaned/squatted pane never surfaces as healthy green.
    if (identityVerdictDownranksRunning(input.identityVerdict)) return "attention_required";
    return "running";
  }
  if (input.usableSnapshot) {
    // OPR.0.5.7.1 — recoverability follows the RESOLVED occupant (the same
    // four-way ladder execution consumes), never the first matching row: a
    // token on a historical row the restore would refuse must not render
    // recoverable.
    const resolution = resolveActiveOccupantRow(
      input.usableSnapshot.data.sessions ?? [],
      input.usableSnapshot.data.activeSessionIdByNode,
      input.nodeId,
    );
    if (
      resolution.kind === "resolved"
      && typeof resolution.session.resumeToken === "string"
      && resolution.session.resumeToken.length > 0
    ) {
      return "recoverable";
    }
  }
  return "detached";
}

/**
 * Project occupant lifecycle using a verdict already gated to the current binding.
 * Confirmed session absence suppresses stored active state without rewriting it.
 */
function deriveOccupantLifecycle(
  row: InventoryRow,
  identityVerdict: SeatIdentityVerdict | null,
): NodeInventoryEntry["occupantLifecycle"] {
  if (row.occupant_lifecycle === "active" && identityVerdictConfirmsSessionMissing(identityVerdict)) {
    return "unknown";
  }
  if (row.occupant_lifecycle) {
    return row.occupant_lifecycle as NodeInventoryEntry["occupantLifecycle"];
  }
  // OPR.0.4.3.19 — the derived `active` occupant requires a verified (or
  // not-yet-observed) pane identity, mirroring the lifecycleState gate.
  if (row.session_status === "running" && !identityVerdictDownranksRunning(identityVerdict?.verdict)) {
    return "active";
  }
  return "unknown";
}

function deriveContinuityOutcome(
  row: InventoryRow,
  restore: RestoreProjection | undefined,
): NodeInventoryEntry["continuityOutcome"] {
  if (row.continuity_outcome) {
    return row.continuity_outcome as NodeInventoryEntry["continuityOutcome"];
  }
  const restoreOutcome = restore?.outcome ?? "n-a";
  if (restoreOutcome === "n-a") return null;
  // Acknowledgment and responsiveness clear attention, not conversation lineage.
  // Only the winning reconciliation's bound strict proof can infer a resume.
  // Explicit stored outcomes above remain historical facts, not fresh probes.
  if (restoreOutcome === "attention_required") return null;
  if (restoreOutcome === "operator_recovered") {
    return restore?.resumedRuntime === row.runtime ? "resumed" : null;
  }
  // OPR.0.3.4.2: a deliberate fresh-prime IS fresh continuity; awaiting-decision
  // means zero session, so no continuity outcome exists — null (the
  // restoreOutcome field carries the distinct term).
  if (restoreOutcome === "fresh-primed") return "fresh";
  if (restoreOutcome === "awaiting-decision") return null;
  return restoreOutcome;
}

interface RestoreProjection {
  outcome: NodeRestoreOutcome;
  resumedRuntime?: "claude-code" | "codex";
}

function restoreKey(rigId: string, nodeId: string): string {
  return JSON.stringify([rigId, nodeId]);
}

function eventObject(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any> : undefined;
}

// One batch for either the selected rig or the fleet. Keep the outcome arm's
// existing partial indexes; exclude the rig-only index for starts (NULL node_id)
// so the node/type index can select them, with a scan fallback if it is absent.
// UNION ALL adds attempt boundaries without a per-node receipt query.
// Ascending seq with overwrites preserves the former newest-node, first-wins
// fold. Evidence is never borrowed
// from an older reconciliation when a newer acknowledgment wins.
function buildRestoreOutcomeMap(db: Database.Database, rigId?: string): Map<string, RestoreProjection> {
  const filter = rigId ? " AND rig_id = ?" : "";
  const startsFilter = rigId ? " AND +rig_id = ?" : "";
  const rows = db.prepare(`
    SELECT type, payload, seq, rig_id, node_id FROM events
      WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled')${filter}
    UNION ALL
    SELECT type, payload, seq, rig_id, node_id FROM events
      WHERE node_id IS NULL AND type = 'restore.started'${startsFilter}
    ORDER BY seq ASC
  `).all(...(rigId ? [rigId, rigId] : [])) as {
    type: string; payload: string; seq: number; rig_id: string; node_id: string | null;
  }[];
  const map = new Map<string, RestoreProjection>();
  const attempts = new Map<string, {
    seq: number;
    start?: Record<string, any>;
    completed: boolean;
    outcomes: Map<string, string>;
  }>();
  for (const row of rows) {
    let event: Record<string, any> | undefined;
    try { event = eventObject(JSON.parse(row.payload)); } catch { /* Unknown evidence. */ }
    if (row.type === "restore.started") {
      // Even an unreadable new attempt prevents reuse of an earlier receipt.
      attempts.set(row.rig_id, { seq: row.seq, start: event, completed: false, outcomes: new Map() });
      continue;
    }
    const attempt = attempts.get(row.rig_id);
    if (row.type === "restore.completed" && attempt && !attempt.completed) {
      // Match the first completion within this attempt, as the receipt reader
      // does. Missing/corrupt receipts cannot become continuity proof.
      attempt.completed = true;
      const start = attempt.start;
      const result = eventObject(event?.result);
      const roster = start?.intendedRoster ?? result?.intendedRoster ?? result?.nodes;
      if (start?.rigId === row.rig_id && event?.rigId === row.rig_id
        && typeof start?.snapshotId === "string"
        && event?.snapshotId === start.snapshotId && result?.snapshotId === start.snapshotId
        && Array.isArray(result?.nodes) && Array.isArray(roster)) {
        const intended = new Set(roster.map((node: any) => node?.nodeId));
        for (const node of result.nodes) {
          if (typeof node?.nodeId === "string" && intended.has(node.nodeId)) {
            attempt.outcomes.set(node.nodeId, node.status);
          }
        }
      }
    }
    if (!event) continue;
    if (row.type === "restore.outcome_reconciled") {
      if (typeof event.nodeId !== "string") continue;
      const evidence = eventObject(event.evidence);
      const strict = event.rigId === row.rig_id && event.nodeId === row.node_id
        && event.to === "operator_recovered" && (event.from === "failed" || event.from === "attention_required")
        && !!attempt && attempt.seq === event.attemptId && attempt.outcomes.get(event.nodeId) === event.from
        && evidence?.tmux === true && evidence.resumeTokenUsed === true && evidence.paneState === "usable"
        && (evidence.fgProcess === "claude" || evidence.fgProcess === "codex");
      map.set(restoreKey(row.rig_id, event.nodeId), {
        outcome: mapStatus(event.to),
        ...(strict ? { resumedRuntime: evidence!.fgProcess === "claude" ? "claude-code" : "codex" } : {}),
      });
      continue;
    }
    if (!Array.isArray(event.result?.nodes)) continue;
    for (const node of [...event.result.nodes].reverse()) {
      if (typeof node?.nodeId === "string") {
        map.set(restoreKey(row.rig_id, node.nodeId), { outcome: mapStatus(node.status) });
      }
    }
  }
  return map;
}

function mapStatus(status: string): NodeRestoreOutcome {
  if (status === "resumed") return "resumed";
  if (status === "failed") return "failed";
  if (status === "rebuilt") return "rebuilt";
  if (status === "fresh") return "fresh";
  if (status === "fresh-primed") return "fresh-primed";
  if (status === "awaiting-decision") return "awaiting-decision";
  if (status === "attention_required") return "attention_required";
  if (status === "operator_recovered") return "operator_recovered";
  if (status === "checkpoint_written") return "rebuilt";
  if (status === "fresh_no_checkpoint") return "fresh";
  return "n-a";
}

function deriveHeldReason(db: Database.Database, rigId: string, nodeId: string, sessionStatus: string | null): string | null {
  if (sessionStatus === "running") return null;

  const heldRow = db.prepare(
    "SELECT seq, payload FROM events WHERE node_id = ? AND type = 'node.held' ORDER BY seq DESC LIMIT 1"
  ).get(nodeId) as { seq: number; payload: string } | undefined;
  if (!heldRow) return null;

  // Superseded by a later rig-scoped restore event containing this node.
  // restore.completed/restore.subset_completed are rig-scoped (no top-level nodeId),
  // so query by rig_id and parse payloads for node containment.
  const laterRestoreRows = db.prepare(
    "SELECT payload FROM events WHERE rig_id = ? AND type IN ('restore.completed', 'restore.subset_completed') AND seq > ? ORDER BY seq DESC"
  ).all(rigId, heldRow.seq) as { payload: string }[];
  for (const row of laterRestoreRows) {
    try {
      const event = JSON.parse(row.payload) as { result: { nodes: Array<{ nodeId: string }> } };
      if (event.result?.nodes?.some((n) => n.nodeId === nodeId)) return null;
    } catch { continue; }
  }

  try {
    const parsed = JSON.parse(heldRow.payload) as { reason?: string };
    return parsed.reason ?? null;
  } catch {
    return null;
  }
}

function getLatestError(db: Database.Database, rigId: string, nodeId: string): string | null {
  const row = db.prepare(
    "SELECT payload FROM events WHERE rig_id = ? AND node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1"
  ).get(rigId, nodeId) as { payload: string } | undefined;

  if (!row) return null;

  try {
    const event = JSON.parse(row.payload) as { error?: string };
    return event.error ?? null;
  } catch {
    return null;
  }
}

/**
 * Map persisted projection entries to the installedResources shape.
 * The startup-orchestrator persists: { category, effectiveId, sourceSpec, sourcePath, resourcePath, absolutePath, mergeStrategy, target }
 * We normalize to: { id, category, targetPath }
 */
function mapProjectionEntries(entries: unknown[]): Array<{ id: string; category: string; targetPath: string }> {
  return entries.map((e: unknown) => {
    const entry = e as Record<string, string>;
    return {
      id: entry.effectiveId ?? entry.id ?? "",
      category: entry.category ?? "",
      targetPath: entry.target ?? entry.targetPath ?? "",
    };
  });
}

/**
 * OPR.0.4.3.19 rev1-r2 B1 — gate a durable identity verdict to the CURRENT
 * binding. The verdict table is keyed only by node_id, so on rebind/relaunch
 * (same node_id, new session + new pane) the stored verdict describes a pane
 * that is no longer bound. Serving it for the new pane opens a false-green
 * window (a stale `verified` suppresses the down-rank a fresh squat/orphan
 * should trigger; a stale `mismatch` would down-rank a healthy new pane).
 *
 * Same-name/same-pane handovers also replace the occupant. The observation
 * must belong to the latest registration and follow the recorded handover.
 * observedAt is captured before the reconciler's async probes, so a sweep
 * that finishes after cutover still carries its predecessor observation time.
 * Otherwise return null — the projection treats it as ABSENT (fail-open: a
 * running seat is left unchanged, never down-ranked). This keeps the rev1-r1
 * fail-open discipline: turning a stale verdict into ABSENT never down-ranks;
 * only a matching mismatch/pane_missing does.
 */
function applicableVerdict(
  verdict: SeatIdentityVerdict | null,
  row: Pick<InventoryRow, "session_id" | "session_name" | "session_created_at" | "binding_tmux_pane" | "handover_at">,
): SeatIdentityVerdict | null {
  if (!verdict) return null;
  if (verdict.sessionName !== row.session_name) return null;
  if (verdict.evidence.registeredPane !== row.binding_tmux_pane) return null;
  const observedAt = Date.parse(verdict.observedAt);
  if (!Number.isFinite(observedAt)) return null;
  // SQLite's datetime('now') is UTC but omits the timezone suffix.
  const utcTime = (value: string) => Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? `${value.replace(" ", "T")}Z` : value);
  if (row.session_created_at && !(observedAt >= utcTime(row.session_created_at))) return null;
  // Registry session IDs are ULIDs; retain their millisecond precision when
  // two registrations share SQLite's one-second created_at timestamp.
  if (row.session_id && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(row.session_id)
    && observedAt <= decodeTime(row.session_id)) return null;
  // Equal-millisecond observations cannot establish which occupant was read.
  if (row.handover_at && !(observedAt > utcTime(row.handover_at))) return null;
  return verdict;
}

// -- Public API --

/**
 * Get the canonical node inventory for a rig.
 * Single source of truth consumed by CLI, UI, and MCP.
 */
export function getNodeInventory(db: Database.Database, rigId: string): NodeInventoryEntry[] {
  // Resolve the rig's latest usable snapshot once for the whole projection so per-node
  // recoverability checks share the same source of truth without N extra queries.
  const usableSnapshot = findLatestUsableSnapshot(db, rigId);
  // PL-007: rig's typed workspace block (if declared) loaded once per
  // projection so per-node kind resolution shares one parse.
  const workspaceSpec = readRigWorkspaceJson(db, rigId);
  // OPR.0.4.3.19: the persisted per-node liveness identity verdicts, read once
  // per projection (cheap indexed read, defensive to a missing table). Gates
  // the running/active green derivations below.
  const identityVerdicts = new Map<string, SeatIdentityVerdict>();
  // FS-1 W1.3 S1/S2 — the per-node restore-outcome + oriented reads built ONCE
  // for the rig (was a query per node inside the rows.map). rig-scoped restore
  // map = the prior WHERE rig_id=? filter; oriented map is node-scoped/global.
  const restoreOutcomes = buildRestoreOutcomeMap(db, rigId);
  const orienteds = buildOrientedMap(db);

  const rows = queryInventoryRows(db, rigId);

  return rows.map((row) =>
    buildInventoryEntry(db, row, { usableSnapshot, workspaceSpec, identityVerdicts, restoreOutcomes, orienteds }),
  );
}

/**
 * FS-1 W1.2 — the shared inventory-row query. Extracted verbatim from the prior
 * inline `getNodeInventory` SELECT so the single-rig and all-rigs paths run the
 * IDENTICAL query.
 *   - `rigId` given → one rig (`WHERE n.rig_id = ?`, `ORDER BY n.created_at`) —
 *     byte-identical to the prior per-rig read.
 *   - `rigId` omitted → ALL rigs in one pass (no WHERE; `ORDER BY n.rig_id,
 *     n.created_at` so JS grouping preserves each rig's `created_at` order,
 *     matching the per-rig ordering exactly).
 * The latest-session subquery (`s2.node_id = n.id ORDER BY id DESC LIMIT 1`)
 * rides the W1.1 index (051, idx_sessions_node_created_id).
 */
function runInventoryRowQuery(db: Database.Database, whereClause: string, orderClause: string, params: readonly string[]): InventoryRow[] {
  // Join nodes with newest session (max ULID = max session.id string comparison)
  // and the rig name
  const hasCodexConfigProfile = db.prepare("PRAGMA table_info(nodes)").all()
    .some((row) => (row as { name?: string }).name === "codex_config_profile");
  const codexConfigProfileSelect = hasCodexConfigProfile
    ? "n.codex_config_profile"
    : "NULL";
  const stmt = db.prepare(`
    SELECT
      n.id as node_id,
      n.rig_id,
      r.name as rig_name,
      n.logical_id,
      n.pod_id,
      p.namespace as pod_namespace,
      n.role,
      n.runtime,
      n.model,
      ${codexConfigProfileSelect} as codex_config_profile,
      n.agent_ref,
      n.profile,
      n.cwd,
      n.restore_policy,
      n.resolved_spec_name,
      n.resolved_spec_version,
      n.resolved_spec_hash,
      n.occupant_lifecycle,
      n.continuity_outcome,
      n.handover_result,
      n.previous_occupant,
      n.handover_at,
      s.id as session_id,
      s.session_name,
      s.created_at as session_created_at,
      s.status as session_status,
      s.intentionally_stopped,
      s.startup_status,
      s.resume_type,
      s.resume_token,
      s.startup_completed_at,
      b.attachment_type as binding_attachment_type,
      b.id as binding_id,
      b.tmux_pane as binding_tmux_pane
    FROM nodes n
    JOIN rigs r ON r.id = n.rig_id
    LEFT JOIN pods p ON p.id = n.pod_id
    LEFT JOIN sessions s ON s.node_id = n.id
      AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
    LEFT JOIN bindings b ON b.node_id = n.id
    ${whereClause}
    ORDER BY ${orderClause}
  `);
  return stmt.all(...params) as InventoryRow[];
}

// Single-rig (WHERE n.rig_id=?) or ALL-rigs (no WHERE). Byte-identical SQL/order to
// the prior inline read; existing single-rig callers are unchanged.
function queryInventoryRows(db: Database.Database, rigId?: string): InventoryRow[] {
  return runInventoryRowQuery(
    db,
    rigId ? "WHERE n.rig_id = ?" : "",
    rigId ? "n.created_at" : "n.rig_id, n.created_at",
    rigId ? [rigId] : [],
  );
}

// Scoped to a rig-id SET — every IN value bound as a parameter; per-rig created_at
// order preserved (same ORDER BY as the all-rigs path). Callers guarantee a
// non-empty list (empty set → getNodeInventoryForRigs returns early, no query run).
function queryInventoryRowsForRigs(db: Database.Database, rigIds: readonly string[]): InventoryRow[] {
  const placeholders = rigIds.map(() => "?").join(", ");
  return runInventoryRowQuery(db, `WHERE n.rig_id IN (${placeholders})`, "n.rig_id, n.created_at", rigIds);
}

/** Per-rig setup context an inventory row is built against. FS-1 W1.2: the
 *  single-rig (`getNodeInventory`) and all-rigs (`getNodeInventoryForAllRigs`)
 *  paths both build entries through THIS one function, so their output is
 *  byte-identical by construction — the collapse changes only HOW the context +
 *  rows are fetched (per-rig vs batched), never how an entry is derived. */
interface InventoryBuildContext {
  usableSnapshot: Snapshot | null;
  workspaceSpec: WorkspaceSpec | null;
  identityVerdicts: Map<string, SeatIdentityVerdict>;
  // FS-1 W1.3 S1/S2 — the once-per-rig-batched per-node reads, keyed by node_id.
  // Built ONCE per projection (rig-scoped for single-rig, all-rigs for the
  // batched path) and looked up O(1) here instead of a query per node.
  restoreOutcomes: Map<string, RestoreProjection>;
  orienteds: Map<string, NodeOriented>;
}

/**
 * Build the shared inventory projection from a registration and its rig context.
 * Apply only current-occupant identity evidence and retain stored status alongside
 * effective status so readers can distinguish absence from registration history.
 */
function buildInventoryEntry(
  db: Database.Database,
  row: InventoryRow,
  ctx: InventoryBuildContext,
): NodeInventoryEntry {
  const { usableSnapshot, workspaceSpec, identityVerdicts, restoreOutcomes, orienteds } = ctx;
  // FS-1 W1.3 S1 — O(1) lookup into the once-per-rig restore-outcome map
  // (byte-identical to the prior per-node deriveRestoreOutcome; "n-a" when a node
  // is referenced by no restore event, matching the prior fall-through).
  const restore = restoreOutcomes.get(restoreKey(row.rig_id, row.node_id));
  const restoreOutcome = restore?.outcome ?? "n-a";
  // OPR.0.4.3.19 rev1-r2 B1 — a durable verdict is keyed only by node_id, so
  // after a rebind/relaunch (same node, NEW session + NEW pane) a stale
  // `verified` verdict for the OLD pane would otherwise be served for the new
  // pane until the next 5s reconcile tick, suppressing down-rank and rendering
  // a fresh squat/orphan false-green. Make applicability LOAD-BEARING at read
  // time: a stored verdict applies ONLY when it was computed against the
  // current binding (its sessionName === the latest session AND its
  // registeredPane === the current binding pane). Otherwise treat it as ABSENT
  // (null) — a STALE verdict becomes fail-open (never down-ranks a running
  // seat), it does NOT itself down-rank. Only a MATCHING mismatch/pane_missing
  // verdict down-ranks.
  const identityVerdict = applicableVerdict(identityVerdicts.get(row.node_id) ?? null, row);
  // Keep registry history intact; only an applicable, explicit absence changes
  // the current status. Unavailable tmux and process mismatches are not absence.
  const sessionStatus = row.session_status === "running" && identityVerdictConfirmsSessionMissing(identityVerdict)
    ? "detached" : row.session_status;
  const lifecycleState = deriveNodeLifecycleState({
    sessionStatus,
    startupStatus: row.startup_status,
    restoreOutcome,
    nodeId: row.node_id,
    usableSnapshot,
    identityVerdict: identityVerdict?.verdict ?? null,
  });
  return {
    nodeId: row.node_id,
    rigId: row.rig_id,
    rigName: row.rig_name,
    logicalId: row.logical_id,
    podId: row.pod_id,
    podNamespace: row.pod_namespace,
    // OPR.0.4.6.FAC1: the seat-side role dimension (nodes.role,
    // declared in the pod-member spec) — the workflow binding layer's
    // candidate filter. null = role-less (never role-resolved).
    role: row.role,
    canonicalSessionName: row.session_name,
    attachmentType: (row.binding_attachment_type as NodeInventoryEntry["attachmentType"]) ?? null,
    nodeKind: deriveNodeKind(row.runtime),
    runtime: row.runtime,
    sessionStatus,
    storedSessionStatus: row.session_status,
    intentionallyStopped: row.intentionally_stopped === 1
      && row.session_status === "exited" && row.binding_id === null,
    // Match the graph's current-status projection without rewriting the startup
    // result. Applicable mismatch (including ambiguity) or pane_missing overrides it.
    storedStartupStatus: row.startup_status as NodeInventoryEntry["startupStatus"],
    startupStatus: sessionStatus === "running"
      && identityVerdictDownranksRunning(identityVerdict?.verdict)
      ? "attention_required"
      : row.startup_status as NodeInventoryEntry["startupStatus"],
    restoreOutcome,
    // FS-1 W1.3 S2 — O(1) lookup into the fleet-batched oriented map
    // (byte-identical to the prior per-node deriveOriented; "n-a" when a node has
    // no proof events, matching deriveOriented's no-challenge branch).
    oriented: orienteds.get(row.node_id) ?? "n-a",
    lifecycleState,
    occupantLifecycle: deriveOccupantLifecycle(row, identityVerdict),
    continuityOutcome: deriveContinuityOutcome(row, restore),
    handoverResult: row.handover_result as NodeInventoryEntry["handoverResult"] ?? null,
    previousOccupant: row.previous_occupant,
    handoverAt: row.handover_at,
    tmuxAttachCommand: null,
    resumeCommand: computeResumeCommand(row.runtime, row.resume_token, row.codex_config_profile),
    // OPR.0.4.0.26: recoveryGuidance is NOT inlined per node in the LIST
    // payload. It duplicated ~47KB of templated prose across all nodes and
    // no node-list consumer reads it. The full guidance is recomputed on
    // the single-node detail path (getNodeDetail / GET
    // /api/rigs/:rigId/nodes/:logicalId) — relocation, not loss.
    recoveryGuidance: null,
    latestError: row.startup_status === "ready" ? null : getLatestError(db, row.rig_id, row.node_id),
    // Extended fields
    model: row.model,
    agentRef: row.agent_ref,
    profile: row.profile,
    codexConfigProfile: row.codex_config_profile,
    resolvedSpecName: row.resolved_spec_name,
    resolvedSpecVersion: row.resolved_spec_version,
    resolvedSpecHash: row.resolved_spec_hash,
    cwd: row.cwd,
    restorePolicy: row.restore_policy,
    resumeType: row.resume_type,
    resumeToken: row.resume_token,
    startupCompletedAt: row.startup_completed_at,
    // PL-007 Workspace Primitive — per-node workspace summary derived
    // from cwd against the rig's typed workspace block. null when the
    // rig has no workspace declaration.
    workspace: resolveNodeWorkspace({ spec: workspaceSpec, cwd: row.cwd }),
    // OPR.0.4.3.19 — the liveness identity verdict (third axis). null when
    // never observed; carries evidence on mismatch/missing.
    identityVerdict,
    heldReason: deriveHeldReason(db, row.rig_id, row.node_id, sessionStatus),
  };
}

/** FS-1 W1.2 — all-rigs batched form of `readRigWorkspaceJson`: one query,
 *  `rigId → WorkspaceSpec`. Rigs with no/malformed workspace are absent (callers
 *  default to null — byte-identical to `readRigWorkspaceJson`'s null return). */
function readAllRigWorkspaceJson(db: Database.Database): Map<string, WorkspaceSpec> {
  const out = new Map<string, WorkspaceSpec>();
  try {
    const rows = db.prepare("SELECT id, workspace_json FROM rigs").all() as Array<{ id: string; workspace_json: string | null }>;
    for (const row of rows) {
      if (!row.workspace_json) continue;
      try { out.set(row.id, JSON.parse(row.workspace_json) as WorkspaceSpec); } catch { /* malformed → absent → caller null (matches per-rig) */ }
    }
  } catch { /* column/table absent → empty → caller null (matches per-rig defensive path) */ }
  return out;
}

/**
 * FS-1 W1.2 — the rig-level N+1 collapse. Builds inventory for ALL rigs in a
 * bounded, rig-count-INDEPENDENT set of queries: 3 batched setup reads
 * (snapshots / workspaces / identity verdicts) + 1 all-rigs node SELECT, grouped
 * by rig_id. Every entry is built through the SAME `buildInventoryEntry` that the
 * per-rig `getNodeInventory` uses, so `getNodeInventoryForAllRigs(db).get(rigId)`
 * is byte-identical to `getNodeInventory(db, rigId)` — the collapse changes only
 * HOW the context + rows are fetched (batched vs per-rig), never how an entry is
 * derived. Per-node reads inside `buildInventoryEntry` (`deriveRestoreOutcome`
 * etc.) remain per-node and ride the 047 index — NOT the rig-level N+1 removed here.
 */
// Shared batched builder — the common body of the all-rigs and scoped-rigs paths.
// Builds the fleet setup maps + EXACTLY one fleet startup-orientation
// (buildOrientedMap) and one fleet restore-outcome (buildRestoreOutcomeMap) scan
// ONCE, then builds a NodeInventoryEntry for each PROVIDED row via the SAME
// buildInventoryEntry, grouped by rig_id with per-rig created_at order preserved.
// `rows` decides the scope (all rigs vs a selected rig set); entry derivation is
// identical, so a rig's entries are byte-identical regardless of which caller ran.
function buildInventoryMapFromRows(db: Database.Database, rows: InventoryRow[]): Map<string, NodeInventoryEntry[]> {
  const snapshotByRig = findLatestUsableSnapshotsForAllRigs(db);
  const workspaceByRig = readAllRigWorkspaceJson(db);
  const verdictsByRig = new Map<string, Map<string, SeatIdentityVerdict>>();
  // FS-1 W1.3 S1/S2 — the per-node reads built ONCE (O(1) queries, not O(nodes)).
  // Restore map unscoped: a nodeId is referenced only by its own rig's restore
  // events, so each node's value equals the single-rig path.
  const restoreOutcomes = buildRestoreOutcomeMap(db); // one fleet restore-outcome scan
  const orienteds = buildOrientedMap(db);             // one fleet startup-orientation scan
  const out = new Map<string, NodeInventoryEntry[]>();
  for (const row of rows) {
    const entry = buildInventoryEntry(db, row, {
      usableSnapshot: snapshotByRig.get(row.rig_id) ?? null,
      workspaceSpec: workspaceByRig.get(row.rig_id) ?? null,
      identityVerdicts: verdictsByRig.get(row.rig_id) ?? new Map(),
      restoreOutcomes,
      orienteds,
    });
    let list = out.get(row.rig_id);
    if (!list) { list = []; out.set(row.rig_id, list); }
    list.push(entry);
  }
  return out;
}

export function getNodeInventoryForAllRigs(db: Database.Database): Map<string, NodeInventoryEntry[]> {
  return buildInventoryMapFromRows(db, queryInventoryRows(db));
}

// slice-04 — inventory for a SELECTED set of rigs only (e.g. the rigs a summary
// actually returns), so the per-node fold never widens to rigs the caller excluded
// (e.g. archived). Retains exactly one fleet startup-orientation + one fleet
// restore-outcome scan via the shared builder. Empty set → empty Map, NO scans and
// no invalid `IN ()`. getNodeInventoryForRigs(db, {r}).get(r) is byte-identical to
// the all-rigs path's entry list for r (same rows, same builder).
export function getNodeInventoryForRigs(db: Database.Database, rigIds: ReadonlySet<string>): Map<string, NodeInventoryEntry[]> {
  if (rigIds.size === 0) return new Map();
  return buildInventoryMapFromRows(db, queryInventoryRowsForRigs(db, [...rigIds]));
}

/** PL-007 — read the rig's typed workspace block from `rigs.workspace_json`
 *  defensively. Migration 038 may not yet be applied in older test fixtures
 *  that bypass the canonical migration list, so a missing column returns
 *  null cleanly. */
function readRigWorkspaceJson(db: Database.Database, rigId: string): WorkspaceSpec | null {
  try {
    const row = db.prepare("SELECT workspace_json FROM rigs WHERE id = ?")
      .get(rigId) as { workspace_json: string | null } | undefined;
    if (!row || !row.workspace_json) return null;
    return JSON.parse(row.workspace_json) as WorkspaceSpec;
  } catch {
    return null;
  }
}

/**
 * Get detailed node information including startup files, resources, and events.
 * The adapter dependency is optional — when provided, uses live listInstalled;
 * otherwise falls back to projection entries from startup context.
 */
export function getNodeDetail(
  db: Database.Database,
  rigId: string,
  logicalId: string,
  opts?: {
    adapters?: Record<string, RuntimeAdapter>;
    /** Pre-resolved installed resources from adapter.listInstalled() — route layer provides this. */
    installedResourcesOverride?: Array<{ id: string; category: string; targetPath: string }>;
  },
): NodeDetailEntry | null {
  // Get the inventory entry first
  const allEntries = getNodeInventory(db, rigId);
  const entry = allEntries.find((e) => e.logicalId === logicalId);
  if (!entry) return null;

  // Find the node ID
  const nodeRow = db.prepare(
    "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?"
  ).get(rigId, logicalId) as { id: string } | undefined;
  if (!nodeRow) return null;
  const nodeId = nodeRow.id;

  // Binding
  const bindingRow = db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeId) as BindingRow | undefined;
  const binding: Binding | null = bindingRow ? {
    id: bindingRow.id,
    nodeId,
    attachmentType: (bindingRow.attachment_type as Binding["attachmentType"]) ?? "tmux",
    tmuxSession: bindingRow.tmux_session,
    tmuxWindow: bindingRow.tmux_window,
    tmuxPane: bindingRow.tmux_pane,
    externalSessionName: bindingRow.external_session_name ?? null,
    cmuxWorkspace: bindingRow.cmux_workspace,
    cmuxSurface: bindingRow.cmux_surface,
    updatedAt: bindingRow.updated_at,
  } : null;

  // Startup context
  const ctxRow = db.prepare(
    "SELECT * FROM node_startup_context WHERE node_id = ?"
  ).get(nodeId) as StartupContextRow | undefined;

  const startupFiles = ctxRow ? JSON.parse(ctxRow.resolved_files_json) : [];
  const startupActions = ctxRow ? JSON.parse(ctxRow.startup_actions_json) : [];
  const projectionEntries = ctxRow ? JSON.parse(ctxRow.projection_entries_json) : [];

  // Installed resources: override (from async adapter call) > projection fallback
  let installedResources: NodeDetailEntry["installedResources"];
  if (opts?.installedResourcesOverride) {
    installedResources = opts.installedResourcesOverride;
  } else if (opts?.adapters?.[entry.runtime ?? ""] && binding) {
    // Adapter is available — caller should have pre-resolved via listInstalled (async).
    // If caller passed adapters but not override, try sync call for test compatibility.
    try {
      const adapter = opts.adapters[entry.runtime ?? ""]!;
      const nodeBinding = { ...binding, cwd: entry.cwd ?? "." };
      const resources = adapter.listInstalled(nodeBinding) as unknown;
      // Handle both sync (test mocks) and Promise (real adapters)
      if (Array.isArray(resources)) {
        installedResources = (resources as Array<{ effectiveId: string; category: string; installedPath: string }>).map((r) => ({
          id: r.effectiveId,
          category: r.category,
          targetPath: r.installedPath,
        }));
      } else {
        // Async — fall through to projection
        installedResources = mapProjectionEntries(projectionEntries);
      }
    } catch {
      installedResources = mapProjectionEntries(projectionEntries);
    }
  } else {
    // Projection fallback
    installedResources = mapProjectionEntries(projectionEntries);
  }

  // Recent events (last 20 for this node)
  const eventRows = db.prepare(
    "SELECT * FROM events WHERE node_id = ? ORDER BY seq DESC LIMIT 20"
  ).all(nodeId) as EventRow[];

  const recentEvents = eventRows.map((r) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload); } catch { /* empty */ }
    return {
      type: r.type,
      createdAt: r.created_at,
      payload,
    };
  });

  // Infrastructure startup command
  let infrastructureStartupCommand: string | null = null;
  if (entry.nodeKind === "infrastructure" && startupActions.length > 0) {
    const sendTextAction = startupActions.find((a: { type: string }) => a.type === "send_text");
    if (sendTextAction) {
      infrastructureStartupCommand = sendTextAction.value;
    }
  }

  // Peers: other nodes in the same rig
  const peers: NodeDetailPeer[] = allEntries
    .filter((e) => e.logicalId !== logicalId)
    .map((e) => ({
      logicalId: e.logicalId,
      canonicalSessionName: e.canonicalSessionName,
      attachmentType: e.attachmentType,
      runtime: e.runtime,
    }));

  // Edges: outgoing and incoming for this node
  const edgeRows = db.prepare(
    "SELECT e.kind, e.source_id, e.target_id, src.logical_id as src_logical, tgt.logical_id as tgt_logical " +
    "FROM edges e " +
    "JOIN nodes src ON src.id = e.source_id " +
    "JOIN nodes tgt ON tgt.id = e.target_id " +
    "WHERE e.rig_id = ? AND (e.source_id = ? OR e.target_id = ?)"
  ).all(rigId, nodeId, nodeId) as Array<{ kind: string; source_id: string; target_id: string; src_logical: string; tgt_logical: string }>;

  const nodeSessionMap = new Map(allEntries.map((e) => [e.logicalId, e.canonicalSessionName]));
  const outgoing: NodeDetailEdge[] = [];
  const incoming: NodeDetailEdge[] = [];
  for (const row of edgeRows) {
    if (row.source_id === nodeId) {
      outgoing.push({ kind: row.kind, to: { logicalId: row.tgt_logical, sessionName: nodeSessionMap.get(row.tgt_logical) ?? null } });
    }
    if (row.target_id === nodeId) {
      incoming.push({ kind: row.kind, from: { logicalId: row.src_logical, sessionName: nodeSessionMap.get(row.src_logical) ?? null } });
    }
  }

  // Compact spec summary
  const compactSpec: NodeDetailCompactSpec = {
    name: entry.resolvedSpecName,
    version: entry.resolvedSpecVersion,
    profile: entry.profile,
    skillCount: installedResources.filter((r) => r.category === "skill" || r.category === "skills").length,
    guidanceCount: installedResources.filter((r) => r.category === "guidance" || r.category === "guidance_merge").length,
  };

  return {
    ...entry,
    // OPR.0.4.0.26: the LIST omits recoveryGuidance to stay slim; the
    // single-node detail recomputes the full guidance from the entry's
    // resume fields (relocation of the per-node prose, not loss).
    recoveryGuidance: computeRecoveryGuidance({
      runtime: entry.runtime,
      resumeToken: entry.resumeToken,
      cwd: entry.cwd,
      sessionName: entry.canonicalSessionName,
      codexConfigProfile: entry.codexConfigProfile,
    }),
    binding,
    startupFiles,
    startupActions,
    installedResources,
    recentEvents,
    infrastructureStartupCommand,
    peers,
    edges: { outgoing, incoming },
    transcript: { enabled: false, path: null, tailCommand: null }, // populated by route handler
    compactSpec,
  };
}

/**
 * Context-aware wrapper: returns inventory with context usage attached.
 * Uses one daemon-owned ContextUsageStore for all reads.
 */
export function getNodeInventoryWithContext(
  db: Database.Database,
  rigId: string,
  contextUsageStore: ContextUsageStore,
  transcriptStore?: Pick<TranscriptStore, "getIngestHealth">,
): NodeInventoryEntry[] {
  const entries = getNodeInventory(db, rigId);

  // Find node IDs for batch read
  const nodeRows = db.prepare(
    "SELECT id, logical_id FROM nodes WHERE rig_id = ?"
  ).all(rigId) as Array<{ id: string; logical_id: string }>;
  const nodeIdByLogicalId = new Map(nodeRows.map((r) => [r.logical_id, r.id]));

  const contextEntries = entries.map((e) => ({
    nodeId: nodeIdByLogicalId.get(e.logicalId) ?? "",
    currentSessionName: e.canonicalSessionName,
  }));

  const contextMap = contextUsageStore.getForNodes(contextEntries);

  return entries.map((e) => {
    const nodeId = nodeIdByLogicalId.get(e.logicalId) ?? "";
    const usage = contextMap.get(nodeId) ?? contextUsageStore.unknownUsage("no_data");
    // OPR.0.4.0.26: drop the heavy `currentUsage` blob from the LIST
    // contextUsage (a serialized per-node usage payload, ~79KB across a
    // large fleet; no node-list consumer reads it). All scalars are kept so
    // the ring/table/filter consumers are unaffected. The full currentUsage
    // remains on the detail/whoami path (getNodeDetailWithContext, whoami).
    const transcriptIngest = transcriptStore && e.canonicalSessionName
      ? {
          ...transcriptStore.getIngestHealth(e.rigName, e.canonicalSessionName),
          runtime: e.runtime,
        }
      : undefined;
    return {
      ...e,
      contextUsage: { ...usage, currentUsage: null },
      ...(transcriptIngest ? { transcriptIngest } : {}),
    };
  });
}

/**
 * Context-aware wrapper: returns node detail with context usage attached.
 */
export function getNodeDetailWithContext(
  db: Database.Database,
  rigId: string,
  logicalId: string,
  contextUsageStore: ContextUsageStore,
  opts?: Parameters<typeof getNodeDetail>[3],
): NodeDetailEntry | null {
  const detail = getNodeDetail(db, rigId, logicalId, opts);
  if (!detail) return null;

  const nodeRow = db.prepare(
    "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?"
  ).get(rigId, logicalId) as { id: string } | undefined;

  if (nodeRow) {
    detail.contextUsage = contextUsageStore.getForNode(nodeRow.id, detail.canonicalSessionName);
  } else {
    detail.contextUsage = contextUsageStore.unknownUsage("no_data");
  }

  return detail;
}

/**
 * Slice 15 — populate `terminalActive` + `hasAssignedWork` per node.
 *
 * Two orthogonal enrichments computed independently (non-inference
 * contract per IMPL-PRD §2.3):
 *   - `terminalActive`: read from SeatActivityService (tmux signal)
 *   - assigned-work counts: pending, in-progress, and blocked queue_items
 *     where destination_session matches either canonical coordinate for the seat
 *
 * Pure / synchronous — keeps the projection cheap for both `rig ps` and
 * the UI which both fetch this per-request. The two enrichments do not
 * read each other's source.
 */
export function attachTerminalActivityAndWork(
  entries: NodeInventoryEntry[],
  deps: { db: Database.Database },
): NodeInventoryEntry[] {
  const assignedByDest = readAssignedWorkBySession(deps.db);
  return entries.map((entry) => {
    const work = countAssignedWorkForEntry(entry, assignedByDest);
    return {
      ...entry,
      terminalActive: undefined,
      lastActivityAt: undefined,
      activityState: undefined,
      hasAssignedWork: work.assignedWorkCount > 0,
      ...work,
    };
  });
}

/**
 * QA baseline-deep-dogfood BLOCKING-A2 (qitem-20260518063900-85745917):
 * adopted/live-session rigs do NOT surface assigned queue work because
 * the prior lookup matched destination_session ONLY against
 * canonicalSessionName.
 *
 * For MANAGED seats, canonicalSessionName equals the canonical form
 * `{pod}-{member}@{rig}` (set by deriveCanonicalSessionName at
 * materialize time) and queue operators address them by that form, so
 * the single-key lookup works.
 *
 * For ADOPTED seats, canonicalSessionName is the RAW tmux session
 * name (whatever the adopter chose, e.g., `my-existing-claude`).
 * Operators address adopted seats by the canonical form (logical
 * `{pod}-{member}@{rig}`) through `rig queue create --destination`,
 * so the single-key lookup misses.
 *
 * Resolve via BOTH forms:
 *   1. entry.canonicalSessionName (covers managed + adopted-by-raw)
 *   2. derived `{pod}-{member}@{rig}` from logicalId + rigName
 *      (covers adopted-by-canonical)
 *
 * The logicalId is the pod-aware `pod.member` form (dot-separated).
 * The canonical session form replaces the dot with a dash to match the
 * convention from deriveCanonicalSessionName (so `dev.driver-2` in
 * rig `my-rig` becomes `dev-driver-2@my-rig`).
 *
 * Sums distinct destination_session keys to avoid double-counting
 * when both forms are identical (managed seats whose
 * canonicalSessionName already equals the derived canonical form).
 */
export interface AssignedWorkCounts {
  assignedWorkCount: number;
  pendingWorkCount: number;
  inProgressWorkCount: number;
  blockedWorkCount: number;
}

export function countAssignedWorkForEntry(
  entry: NodeInventoryEntry,
  assignedByDest: Map<string, AssignedWorkCounts>,
): AssignedWorkCounts {
  const keys = new Set<string>();
  if (entry.canonicalSessionName) keys.add(entry.canonicalSessionName);
  const derived = deriveCanonicalFromEntry(entry);
  if (derived) keys.add(derived);
  const total: AssignedWorkCounts = {
    assignedWorkCount: 0,
    pendingWorkCount: 0,
    inProgressWorkCount: 0,
    blockedWorkCount: 0,
  };
  for (const key of keys) {
    const counts = assignedByDest.get(key);
    if (!counts) continue;
    total.assignedWorkCount += counts.assignedWorkCount;
    total.pendingWorkCount += counts.pendingWorkCount;
    total.inProgressWorkCount += counts.inProgressWorkCount;
    total.blockedWorkCount += counts.blockedWorkCount;
  }
  return total;
}

/** EXPORTED (OPR.0.4.6.FAC1): the derived canonical coordinate
 *  `{pod}-{member}@{rig}` for an inventory entry — the binding layer's
 *  ONE string rule (tiebreak key AND recorded destination) reuses
 *  exactly this dual-key derivation, never a parallel one. */
export function deriveCanonicalFromEntry(entry: NodeInventoryEntry): string | null {
  if (!entry.rigName || !entry.logicalId) return null;
  const dotIdx = entry.logicalId.indexOf(".");
  if (dotIdx <= 0 || dotIdx === entry.logicalId.length - 1) return null;
  const pod = entry.logicalId.slice(0, dotIdx);
  const member = entry.logicalId.slice(dotIdx + 1);
  return deriveCanonicalSessionName(pod, member, entry.rigName);
}

export function readAssignedWorkBySession(db: Database.Database): Map<string, AssignedWorkCounts> {
  const rows = db.prepare(`
    SELECT destination_session,
      COUNT(*) as assigned_count,
      SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN state = 'in-progress' THEN 1 ELSE 0 END) as in_progress_count,
      SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) as blocked_count
    FROM queue_items
    WHERE state IN ('pending', 'in-progress', 'blocked')
    GROUP BY destination_session
  `).all() as Array<{
    destination_session: string;
    assigned_count: number;
    pending_count: number;
    in_progress_count: number;
    blocked_count: number;
  }>;
  const out = new Map<string, AssignedWorkCounts>();
  for (const r of rows) {
    out.set(r.destination_session, {
      assignedWorkCount: r.assigned_count,
      pendingWorkCount: r.pending_count,
      inProgressWorkCount: r.in_progress_count,
      blockedWorkCount: r.blocked_count,
    });
  }
  return out;
}

export async function attachAgentActivity(
  entries: NodeInventoryEntry[],
  deps: { activityStore?: Pick<AgentActivityStore, "getLatestForNode">; now?: Date },
): Promise<NodeInventoryEntry[]> {
  const now = deps.now ?? new Date();
  return entries.map((entry) => {
    const activity = deps.activityStore?.getLatestForNode({ sessionName: entry.canonicalSessionName, now });
    return activity ? { ...entry, agentActivity: activity } : entry;
  });
}
