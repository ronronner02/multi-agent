import { existsSync } from "node:fs";
import { Hono } from "hono";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { EventBus } from "../domain/event-bus.js";
import { verifyStartupProof } from "../domain/startup-proof.js";
import type { ActivityEvidence } from "../domain/activity-taxonomy.js";
import type { AgentActivity } from "../domain/types.js";
import { runtimeRungInventory } from "../domain/activity-taxonomy.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { claudeHookFromLaunchedProcess, type ClaudeLaunchedProcess, type NativeProcessLister } from "../domain/native-process-lineage.js";

// ── S19 A4 — the ingest half of the adapter seam: hook events reach the ONE oracle ──
// (SeatActivityService) through this translation, so AgentActivityStore is reduced to a
// raw-event consumer/recorder and arbitration happens in exactly one place. The store's
// ALREADY-NORMALIZED state is the input (one event-name parser, no twin).

/** Translate a recorded hook activity into oracle evidence. Returns null for states the
 *  oracle should not consume (unknown = noise, never evidence). needs_input becomes
 *  COUNT+reason on the hooks rung — never an activity value (the taxonomy's binding
 *  exclusion); the turn's working/idle stays whatever other evidence says. */
export function evidenceFromHookActivity(input: {
  seatNodeId: string;
  sessionName: string;
  runtime: string | null;
  activity: AgentActivity;
  seq: number;
}): ActivityEvidence | null {
  const base = {
    seatNodeId: input.seatNodeId,
    sessionName: input.sessionName,
    rung: "lifecycle-hooks" as const,
    sourceId: `${input.runtime ?? "unknown-runtime"}:hooks`,
    seq: input.seq,
    observedAt: input.activity.eventAt ?? input.activity.sampledAt,
  };
  switch (input.activity.state) {
    case "running":
      return { ...base, activity: "working", needsInput: { count: 0, reason: null } };
    case "idle":
      return { ...base, activity: "idle-at-prompt", needsInput: { count: 0, reason: null } };
    case "needs_input":
      return { ...base, needsInput: { count: 1, reason: input.activity.reason || "needs input" } };
    default:
      return null; // unknown = noise, never evidence
  }
}

// Per-source monotonic seq for ingested hook evidence (the relay does not mint one).
const hookEvidenceSeq = new Map<string, number>();
function nextHookSeq(key: string): number {
  const next = (hookEvidenceSeq.get(key) ?? 0) + 1;
  hookEvidenceSeq.set(key, next);
  return next;
}

export const activityHookRoutes = new Hono();

activityHookRoutes.post("/hooks", async (c) => {
  const store = c.get("agentActivityStore" as never) as AgentActivityStore | undefined;
  const expectedToken = c.get("activityHookToken" as never) as string | undefined;

  if (!store || !expectedToken) {
    return c.json({
      ok: false,
      code: "activity_hook_unconfigured",
      error: "Agent activity hook ingestion is not configured for this daemon.",
    }, 503);
  }

  const authHeader = c.req.header("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;
  const headerToken = c.req.header("x-openrig-activity-token") ?? null;
  if (bearerToken !== expectedToken && headerToken !== expectedToken) {
    return c.json({
      ok: false,
      code: "activity_hook_unauthorized",
      error: "Agent activity hook ingestion requires the configured local hook token.",
    }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, code: "invalid_json", error: "Request body must be JSON." }, 400);
  }

  if (body.eventFamily === "session_identity") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
    const sessionName = stringOrNull(body.sessionName);
    const runtime = stringOrNull(body.runtime);
    if (!sessionId || !sessionName) {
      return c.json({ ok: false, code: "missing_session_identity", error: "session_identity requires sessionId and sessionName" }, 400);
    }

    const sessionRegistry = c.get("sessionRegistry" as never) as SessionRegistry | undefined;
    const eventBus = c.get("eventBus" as never) as EventBus | undefined;
    if (!sessionRegistry || !eventBus) {
      return c.json({ ok: false, code: "identity_hook_unconfigured", error: "Session registry not available" }, 503);
    }

    const nodeId = stringOrNull(body.nodeId);
    const resolved = store.resolveSession({ sessionName, nodeId, runtime });
    if (!resolved) {
      return c.json({ ok: false, code: "session_not_found", error: `No session found for ${sessionName}` }, 404);
    }
    // OMP session identity (hook or seat) is strict: the exact seat name, the
    // seat's own runtime, the current occupant generation, and a materialized
    // session file that matches the seat's runner sidecar. Every refusal
    // reports tokenPersisted: false so the OMP runner keeps re-announcing.
    // Pi, Claude, Codex and terminal seats keep the paths below unchanged.
    if (runtime === "omp" || resolved.runtime === "omp") {
      if (sessionName !== resolved.sessionName) {
        return c.json({ ok: false, code: "session_not_found", tokenPersisted: false, error: "Session identity does not match the managed seat." }, 404);
      }
      if (runtime !== resolved.runtime) {
        return c.json({ ok: false, code: "runtime_mismatch", tokenPersisted: false, error: "Session identity runtime does not match the managed seat." }, 409);
      }
      // Same occupant-generation gate as Pi below, before any file eligibility.
      const generation = stringOrNull(body.generation);
      let reason: string | null = null;
      try {
        const current = sessionRegistry.currentOccupantTenure(resolved.nodeId);
        if (!generation) reason = "generation_unverifiable";
        else if (!current || !sessionRegistry.isOccupantGenerationRegistered(resolved.nodeId, generation)) {
          reason = "generation_unresolvable";
        } else if (current.generationUuid !== generation) reason = "generation_mismatch";
      } catch {
        return c.json({
          ok: false, code: "generation_resolver_error", tokenPersisted: false,
          error: "OMP session identity ignored: occupant generation is unavailable.",
        }, 503);
      }
      if (reason) {
        return c.json({
          ok: false, code: reason, tokenPersisted: false,
          error: "OMP session identity ignored: emitter is not the registered current occupant.",
        }, 409);
      }
      const validation = validateResumeToken("omp", stringOrNull(body.sessionFile));
      // OMP reports a path before its first turn is written. Persist only
      // materialized history; the runner can re-announce identity later.
      const adapters = c.get("runtimeAdapters" as never) as Record<string, unknown> | undefined;
      const omp = adapters?.["omp"] as { readSessionFile?: (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } } | undefined;
      const ownFile = typeof omp?.readSessionFile === "function" ? omp.readSessionFile(resolved.sessionName) : null;
      const tokenPersisted = validation.ok && ownFile?.ok === true && ownFile.sessionFile === validation.token && existsSync(validation.token)
        ? sessionRegistry.updateResumeToken(resolved.sessionId, validation.resumeType, validation.token, "hook")
          || sessionRegistry.resumeTokenMatches(resolved.sessionId, validation.resumeType, validation.token)
        : false;
      eventBus.emit({
        type: "agent.session_identity",
        rigId: resolved.rigId,
        nodeId: resolved.nodeId,
        sessionName: resolved.sessionName,
        runtime: "omp",
        sessionId,
        provenance: "rpc",
      });
      return c.json({ ok: true, sessionId, provenance: "rpc", tokenPersisted });
    }

    // OPR.0.4.6.PI1 FR-5 — Pi session identity arrives from the pi-runner's
    // RPC get_state (provenance "rpc" on the bus, never scrape). The resume
    // TOKEN for Pi is the session FILE (body.sessionFile), not the session id;
    // it is format-validated before the persist and never echoed on failure.
    if (runtime === "pi") {
      // A delayed get_state from a retired runner must not replace the successor's
      // resume token or publish a current identity. Keep resolution, this check
      // and both effects synchronous so renewal cannot interleave at an await.
      const generation = stringOrNull(body.generation);
      let reason: string | null = null;
      try {
        const current = sessionRegistry.currentOccupantTenure(resolved.nodeId);
        if (!generation) reason = "generation_unverifiable";
        else if (!current || !sessionRegistry.isOccupantGenerationRegistered(resolved.nodeId, generation)) {
          reason = "generation_unresolvable";
        } else if (current.generationUuid !== generation) reason = "generation_mismatch";
      } catch {
        return c.json({
          ok: false, code: "generation_resolver_error", tokenPersisted: false,
          error: "Pi session identity ignored: occupant generation is unavailable.",
        }, 503);
      }
      if (reason) {
        return c.json({
          ok: false, code: reason, tokenPersisted: false,
          error: "Pi session identity ignored: emitter is not the registered current occupant.",
        }, 409);
      }
      const sessionFile = stringOrNull(body.sessionFile);
      const validation = validateResumeToken("pi", sessionFile);
      if (validation.ok) {
        sessionRegistry.updateResumeToken(resolved.sessionId, "pi_session_file", validation.token, "hook");
      }
      eventBus.emit({
        type: "agent.session_identity",
        rigId: resolved.rigId,
        nodeId: resolved.nodeId,
        sessionName: resolved.sessionName,
        runtime: "pi",
        sessionId,
        provenance: "rpc",
      });
      return c.json({ ok: true, sessionId, provenance: "rpc", tokenPersisted: validation.ok });
    }

    // The resume-type label derives from the RUNTIME, never a fixed default: this line used to stamp
    // "codex_id" for every non-pi runtime, so claude-code seats carried a codex-typed label over a
    // correct token value — and a restore path selecting its resume MECHANISM by label would pick the
    // wrong one while looking healthy. The relay only posts session_identity with a runtime present;
    // an unmapped runtime skips the persist (tokenPersisted: false) rather than guessing a label.
    // tokenPersisted reports the stored state, not format validity: a higher-provenance token
    // (operator) refuses the hook write, which only counts as persisted when it already matches.
    const validation = validateResumeToken(runtime, sessionId);
    // A Claude hook also says how the session began. That only counts as evidence about this
    // seat's launch when the post carries the node's current occupant generation (#1077).
    const generation = stringOrNull(body.generation);
    let currentGeneration = false;
    try {
      currentGeneration = !!generation && sessionRegistry.currentOccupantTenure(resolved.nodeId)?.generationUuid === generation;
    } catch { /* an unreadable ledger is no evidence */ }
    const source = stringOrNull(body.source);
    const resumeLaunch = stringOrNull(body.resumeLaunch);
    // Only for a hook that could name the armed launch: was it the launch's first SessionStart (the
    // relay records that locally, so a first hook lost in delivery still counts), and was it sent
    // by the process OpenRig launched?
    let launchedProcess: ClaudeLaunchedProcess | null = null;
    const armed = runtime === "claude-code" && currentGeneration && source === "resume" && resumeLaunch
      && body.resumeLaunchFirst === true ? sessionRegistry.armedResumeLaunch(resolved.sessionId) : null;
    const hookPid = typeof body.hookPid === "number" && Number.isInteger(body.hookPid) && body.hookPid > 0 ? body.hookPid : null;
    const tmux = c.get("tmuxAdapter" as never) as { getPanePid(target: string): Promise<number | null> } | undefined;
    if (armed && armed === resumeLaunch?.trim() && hookPid && tmux) {
      const binding = sessionRegistry.getBindingForNode(resolved.nodeId);
      const target = binding?.tmuxPane ?? binding?.tmuxSession;
      if (target) {
        launchedProcess = await claudeHookFromLaunchedProcess({ target, tmux, launchToken: armed, hookPid,
          listProcesses: c.get("listProcesses" as never) as NativeProcessLister | undefined });
      }
    }
    const persistHook = (type: string, token: string): boolean => {
      if (runtime !== "claude-code") return sessionRegistry.updateResumeToken(resolved.sessionId, type, token, "hook");
      return sessionRegistry.recordHookSessionIdentity(resolved.sessionId, type, token,
        { source, currentGeneration, resumeLaunch, launchedProcess });
    };
    const tokenPersisted = validation.ok
      && (persistHook(validation.resumeType, validation.token)
        || sessionRegistry.resumeTokenMatches(resolved.sessionId, validation.resumeType, validation.token));
    eventBus.emit({
      type: "agent.session_identity",
      rigId: resolved.rigId,
      nodeId: resolved.nodeId,
      sessionName: resolved.sessionName,
      runtime: runtime ?? "codex",
      sessionId,
      provenance: "hook",
    });

    return c.json({ ok: true, sessionId, provenance: "hook", tokenPersisted });
  }

  // OPR.0.4.3.06 — startup proof ingestion. Mirrors session_identity: reuses
  // the Bearer auth + relay transport above. Identity-bound + anti-replay +
  // contract-verified; only a verified proof projects `oriented` (never
  // `ready`). A bare ACK / wrong / replayed / identity-mismatched proof is an
  // append-only rejection.
  if (body.eventFamily === "startup_proof") {
    const eventBus = c.get("eventBus" as never) as EventBus | undefined;
    if (!eventBus) {
      return c.json({ ok: false, code: "startup_proof_unconfigured", error: "Event bus not available" }, 503);
    }
    const result = verifyStartupProof({ store, eventBus }, {
      sessionName: stringOrNull(body.sessionName),
      nodeId: stringOrNull(body.nodeId),
      runtime: stringOrNull(body.runtime),
      challengeId: stringOrNull(body.challengeId),
      answer: typeof body.answer === "string" ? body.answer : null,
    });
    if (!result.ok) {
      // Identity failures (unknown identity, or a nodeId/sessionName that
      // resolve to different seats) → 404; verification failures → 422.
      const status = result.code === "identity_unbound" || result.code === "identity_mismatch" ? 404 : 422;
      return c.json({ ok: false, code: result.code, error: result.error }, status);
    }
    return c.json({ ok: true, oriented: "verified", nodeId: result.nodeId, challengeId: result.challengeId });
  }

  const result = store.recordHookEvent({
    runtime: stringOrNull(body.runtime),
    sessionName: stringOrNull(body.sessionName),
    nodeId: stringOrNull(body.nodeId),
    hookEvent: typeof body.hookEvent === "string" ? body.hookEvent : "",
    subtype: stringOrNull(body.subtype),
    occurredAt: stringOrNull(body.occurredAt),
    // W2a-1 — source-bound emitting generation, carried by managed launch/fresh-handover producers.
    // Legacy, excluded, or no-tenure emitting paths may omit it ⇒ stamped null ⇒ unresolved at read
    // (sound per-path absence; never false-fresh).
    generation: stringOrNull(body.generation),
  });

  if (!result.ok) {
    const status = result.code === "missing_session_identity" ? 400 : 404;
    return c.json({ ok: false, code: result.code, error: result.error }, status);
  }

  // S19 A4 — feed the ONE oracle through the adapter seam: the recorded (store-
  // normalized) event becomes ladder evidence on the lifecycle-hooks rung. The store
  // remains the raw-event recorder (startup-proof, delivery verification); arbitration
  // happens only in SeatActivityService.
  const oracle = c.get("seatActivityService" as never) as
    | import("../domain/seat-activity-service.js").SeatActivityService
    | undefined;
  const emitted = result.event as { nodeId?: string; sessionName?: string; runtime?: string } | undefined;
  // Recording a historical hook is valid, but its raw activity cannot staff the
  // current oracle. The store may resolve nodeId to a newer session even when
  // the emitter supplied an old sessionName, so check both identities before
  // declaring an inventory (which would reactivate a retired seat).
  const currentSession = oracle && emitted?.nodeId
    ? store.db.prepare("SELECT session_name, status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
      .get(emitted.nodeId) as { session_name: string; status: string } | undefined
    : undefined;
  const suppliedSessionName = stringOrNull(body.sessionName);
  if (oracle && emitted?.nodeId && emitted.sessionName
      && currentSession?.status === "running" && currentSession.session_name === emitted.sessionName
      && (!suppliedSessionName || suppliedSessionName === emitted.sessionName)) {
    // A same-name relaunch can have a different registered occupant generation.
    // Honor the store's positive mismatch verdict, while preserving legacy hooks
    // with unresolved provenance and the archival response below.
    if (result.activity.generation != null
        && store.getLatestForNode({ nodeId: emitted.nodeId, sessionName: emitted.sessionName })?.reason === "generation_mismatch") {
      return c.json({ ok: true, activity: result.activity });
    }
    const runtime = emitted.runtime ?? stringOrNull(body.runtime);
    // Auto-declare on first hook evidence (and after a swap cleared the inventory):
    // the runtime's inventory sets each rung's INITIAL trust (claude standing, codex
    // hooks-at-trial per AM-2) — a successor's rungs always start unpromoted.
    if (!oracle.hasRungInventory(emitted.nodeId, emitted.sessionName)) {
      oracle.declareRungInventory(
        { seatNodeId: emitted.nodeId, sessionName: emitted.sessionName },
        runtimeRungInventory(runtime),
      );
    }
    const evidence = evidenceFromHookActivity({
      seatNodeId: emitted.nodeId,
      sessionName: emitted.sessionName,
      runtime,
      activity: result.activity,
      seq: nextHookSeq(`${emitted.nodeId}:${runtime ?? "unknown-runtime"}:hooks`),
    });
    if (evidence) oracle.reportEvidence(evidence);
  }

  return c.json({ ok: true, activity: result.activity });
});


function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
