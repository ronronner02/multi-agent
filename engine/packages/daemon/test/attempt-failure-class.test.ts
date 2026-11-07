import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TEAM_CONTROL_VERSION, type PlanBinding } from "../src/contracts/team-control.js";
import { classificationFor, classifyAttemptFailure, parseAttemptClassification, OWNER_ACTIONS } from "../src/domain/attempt-failure.js";
import { composeAttemptCompletion } from "../src/domain/attempt-completion.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { composePendingDispatch, pendingTasks } from "../src/domain/pending-dispatch.js";
import { appendChatMessage, composeLeadTurnEnd, leadChatTurnNote, pendingOwnerMessages, takeOwnerMessages } from "../src/domain/lead-chat.js";
import { leadTeamEvents } from "../src/domain/lead-manager.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";

const owner = { kind: "owner", sessionId: "owner" } as const;
const unavailable = { value: null, reason: "not reported" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };
const digest = `sha256:${"c".repeat(64)}`;
const binding: PlanBinding = { artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "plan.md", planDigest: digest, repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"], policyRevision: 2, policyFingerprint: digest,
  limits: { maxSessions: 2, maxActiveMs: 7_200_000, maxRetries: 3, maxReviewRounds: 2 } };

const classify = (terminalTail: string, now = new Date("2026-11-07T00:00:00.000Z")) =>
  classifyAttemptFailure({ canceled: false, exit: { code: 1 }, terminalTail, now });

describe("U11 failure classes", () => {
  it.each([
    ["API Error: 429 rate_limit_error", "agent_error.provider_rate_limit", "transient"],
    ["API Error: 429 insufficient_quota", "agent_error.provider_quota", "quota"],
    ["Error: 429 credit balance is too low", "agent_error.provider_quota", "quota"],
    ["503 Service Unavailable", "agent_error.provider_server_error", "transient"],
    ["API Error: 502 Bad Gateway", "agent_error.provider_server_error", "transient"],
    ["Error: connect ECONNRESET", "agent_error.provider_network", "transient"],
    ["401 authentication_error: API key is invalid.", "agent_error.provider_auth_or_access", "environment"],
  ])("classifies %s without making provider waits owner blockers", (tail, reasonCode, failureClass) => {
    expect(classify(tail)).toMatchObject({ reasonCode, failureClass, retryEligible: failureClass === "transient" || failureClass === "quota" });
  });

  it("routes invalid evidence, missing reviews and no progress to the lead", () => {
    for (const reason of ["evidence_invalid", "review_report_missing", "no_progress"] as const) {
      expect(classificationFor(reason)).toMatchObject({ failureClass: "judgment", retryEligible: false });
    }
  });

  it("reads a current Codex reset as the next local occurrence and persists an absolute timestamp", () => {
    const now = new Date(2026, 10, 7, 1, 0);
    const tail = "\u25a0 You've hit your usage limit.\nUpgrade or try again at 4:14 AM.\n";
    const failure = classify(tail, now)!;
    expect(failure).toMatchObject({ failureClass: "quota", resetAt: new Date(2026, 10, 7, 4, 14).toISOString() });
    expect(parseAttemptClassification(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
    expect(classify(tail, new Date(2026, 10, 7, 5))).toMatchObject({ resetAt: new Date(2026, 10, 8, 4, 14).toISOString() });
  });

  it("does not use a quoted or stale banner as quota evidence", () => {
    for (const tail of ["```\n\u25a0 You've hit your usage limit. try again at 4:14 AM.\n```",
      "\u25a0 You've hit your usage limit. try again at 4:14 AM.\nRecovered and completed the work."]) {
      expect(classify(tail)?.reasonCode).toBe("agent_error.unknown");
    }
  });

  it("reads historical eligibility without allowing forged current metadata", () => {
    const oldQuota = { reasonCode: "agent_error.provider_quota", resumeSafe: true, retryEligible: false,
      ownerAction: OWNER_ACTIONS["agent_error.provider_quota"] };
    expect(parseAttemptClassification(oldQuota)).toMatchObject({ failureClass: "quota", retryEligible: true });
    expect(parseAttemptClassification({ reasonCode: "evidence_invalid", resumeSafe: true, retryEligible: true,
      ownerAction: "The daemon could not validate the task's candidate evidence; retry the task once." }))
      .toMatchObject({ failureClass: "judgment", retryEligible: false });
    expect(() => parseAttemptClassification({ ...classificationFor("agent_error.provider_quota"), failureClass: "environment" })).toThrow();
    expect(() => parseAttemptClassification({ ...classificationFor("agent_error.provider_quota"), resetAt: "tomorrow" })).toThrow();
  });
});

describe("U11 persistent retry scheduling", () => {
  let root: string, db: Database.Database, governance: PlanGovernance, now: Date, qitemId: string, serial: number;
  let tail: string;
  const setupGovernance = () => {
    const events = new EventBus(db);
    governance = new PlanGovernance(db, events, new QueueRepository(db, events), () => now,
      () => ({ policyRevision: 2, policyFingerprint: digest, verifiedProviders: ["claude", "codex"] }));
  };
  const request = (actionId: string, payload: unknown) => ({ protocolVersion: TEAM_CONTROL_VERSION, runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: `request-${++serial}`, payload });
  const launch = (id: string) => governance.recordAttempt(request(id, { qitemId, role: governance.getTask(qitemId)!.assignment.role, provider: "codex",
    identity: { nativeSessionId: id, tmuxServer: "/control/tmux", paneId: "%1", processId: 123,
      processStart: "start", generation: 1, policyFingerprint: digest }, state: "running", unknownReason: null, usage }), binding);
  const completion = (dispatchPending?: (runId: string) => Promise<void>,
    onAttemptStopped?: (attempt: { id: string; runId: string; qitemId: string | null; role: string }) => Promise<void>) => composeAttemptCompletion({ db, governance,
    currentBinding: () => binding, now: () => now, alive: () => false, turnStateRoot: root,
    sessions: { findResumeContextByName: () => null, updateStartupStatus: () => {} },
    paneExit: async () => ({ dead: true, code: 1 }), paneTail: async () => tail, dispatchPending, onAttemptStopped, log: () => {},
    // A partial candidate must never overrule a provider failure.
    candidateManifestFor: () => ({ base: "commit", baseIdentifier: "a".repeat(40), files: [{ path: "src/a.ts" }],
      manifestDigest: digest, patch: "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n" }),
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "retry-schedule-"));
    db = createDb(join(root, "state.db")); migrate(db, ALL_MIGRATIONS);
    now = new Date("2026-11-07T00:00:00.000Z"); serial = 0; tail = "API Error: 429 rate_limit_error";
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run(); setupGovernance();
    governance.createRun({ id: "run", rigId: "rig", binding });
    governance.requestApproval(request("approval", { kind: "orchestrator", action: "implementation", payload: { bindingDigest: hashBinding(binding) },
      targetDigest: hashBinding(binding), expiresAt: "2026-11-08T00:00:00.000Z" }), owner);
    governance.decideApproval(request("approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    const created = governance.createTask(request("task", { assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [...roleConfiguration.implementer.permissions], sourceSession: "lead@rig", destinationSession: "worker@rig", body: "Work" }), binding);
    qitemId = (created.value as { qitemId: string }).qitemId;
    expect(launch("attempt-1").status).toBe("observed");
  });
  afterEach(() => { if (db?.open) db.close(); if (root) rmSync(root, { recursive: true, force: true }); });

  it("waits 2, 5 and 15 minutes, spends each retry once and stops at the run budget", async () => {
    for (const [index, delay] of [2, 5, 15].entries()) {
      await completion().sweep();
      const due = new Date(now.getTime() + delay * 60_000);
      expect(governance.getTask(qitemId)!.evidence).toMatchObject({ retryNotBefore: due.toISOString() });
      expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: index + 1 });
      expect(governance.chatDecision("run")).toBeNull();
      expect(pendingTasks(db, "run", new Date(due.getTime() - 1))).toEqual([]);
      expect(launch(`too-soon-${index}`).status).toBe("denied");
      now = due;
      expect(pendingTasks(db, "run", now)).toEqual(["task"]);
      expect(launch(`attempt-${index + 2}`).status).toBe("observed");
    }
    await completion().sweep();
    expect(governance.queueState(qitemId)).toBe("failed");
    expect(governance.getRun("run").retriesUsed).toBe(3);
    expect(leadTeamEvents(db, "run").some(event => event.key.startsWith("failed:task"))).toBe(true);
  });

  it("preserves the delay across reopening the database and dispatches it on an idle sweep", async () => {
    await completion().sweep();
    db.close(); db = createDb(join(root, "state.db")); setupGovernance();
    const dispatch = vi.fn(async () => {});
    const schedule = composePendingDispatch({ db, now: () => now, dispatch: () => dispatch, liveSessions: () => 0, maxSessions: () => 2 });
    const observe = completion(schedule);
    now = new Date("2026-11-07T00:01:59.999Z"); await observe.sweep(); expect(dispatch).not.toHaveBeenCalled();
    now = new Date("2026-11-07T00:02:00.000Z"); await observe.sweep(); expect(dispatch).toHaveBeenCalledWith("run", "task");
  });

  it("serializes idle sweeps while a due dispatch is still starting", async () => {
    await completion().sweep();
    now = new Date("2026-11-07T00:02:00.000Z");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const dispatch = vi.fn(() => held);
    const observe = completion(dispatch);
    const first = observe.sweep();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const second = observe.sweep();
    await Promise.resolve();
    try { expect(dispatch).toHaveBeenCalledTimes(1); }
    finally { release(); await Promise.all([first, second]); }
  });

  it.each(["planning", "delivery"])("redelivers unanswered owner messages after a %s lead's delayed retry", async phase => {
    db.prepare("UPDATE team_runs SET phase = ? WHERE id = 'run'").run(phase);
    db.prepare("UPDATE team_queue_authority SET assignment_json = json_set(assignment_json, '$.role', 'lead') WHERE qitem_id = ?").run(qitemId);
    db.prepare("UPDATE team_attempts SET role = 'lead' WHERE id = 'attempt-1'").run();
    appendChatMessage(db, { id: "owner-message", runId: "run", body: "What is the current result?", createdAt: now.toISOString() });
    takeOwnerMessages(db, "run", "attempt-1");
    const delivered: string[] = [];
    const dispatch = vi.fn(async () => {
      expect(launch("lead-retry").status).toBe("observed");
      delivered.push(leadChatTurnNote(takeOwnerMessages(db, "run", "lead-retry"))!);
    });
    const schedule = composePendingDispatch({ db, now: () => now, dispatch: () => dispatch, liveSessions: () => 0, maxSessions: () => 2 });
    const turnEnd = composeLeadTurnEnd({ db, governance, turnStateRoot: root, now: () => now, dispatch: () => schedule });
    const observe = completion(schedule, turnEnd);
    await observe.sweep();
    expect(pendingOwnerMessages(db, "run").map(message => message.id)).toEqual(["owner-message"]);
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    now = new Date("2026-11-07T00:02:00.000Z");
    await observe.sweep();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("What is the current result?");
    expect(pendingOwnerMessages(db, "run")).toEqual([]);
  });

  it.each(["stated", "unstated", "HTTP 429"])("waits for quota reset (%s), then retries only once", async scenario => {
    const stated = scenario === "stated";
    now = new Date(2026, 10, 7, 9, 0);
    tail = scenario === "HTTP 429" ? "API Error: 429 insufficient_quota"
      : "\u25a0 You've hit your usage limit." + (stated ? " try again at 12:14 PM." : "");
    await completion().sweep();
    const due = stated ? new Date(2026, 10, 7, 12, 14) : new Date(now.getTime() + 30 * 60_000);
    expect(governance.getTask(qitemId)!.evidence).toMatchObject({ retryNotBefore: due.toISOString() });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 1 });
    now = due; expect(launch("quota-retry").status).toBe("observed");
    await completion().sweep();
    expect(governance.queueState(qitemId)).toBe("failed");
    expect(governance.getRun("run").retriesUsed).toBe(1);
    expect(leadTeamEvents(db, "run").some(event => event.key.startsWith("failed:task"))).toBe(true);
  });

  it("keeps the authentication repair sentence as the owner's blocked-run action", async () => {
    tail = "401 authentication_error: API key is invalid."; await completion().sweep();
    expect(governance.queueState(qitemId)).toBe("failed");
    expect(governance.getRun("run")).toMatchObject({ state: "blocked", retriesUsed: 0,
      stateReason: OWNER_ACTIONS["agent_error.provider_auth_or_access"] });
  });

  it("schedules a planning lead's provider failure instead of silently ignoring it", async () => {
    db.prepare("UPDATE team_runs SET phase = 'planning' WHERE id = 'run'").run();
    db.prepare("UPDATE team_queue_authority SET assignment_json = json_set(assignment_json, '$.role', 'lead') WHERE qitem_id = ?").run(qitemId);
    db.prepare("UPDATE team_attempts SET role = 'lead' WHERE id = 'attempt-1'").run();
    await completion().sweep();
    expect(governance.getTask(qitemId)!.evidence).toMatchObject({ retryNotBefore: "2026-11-07T00:02:00.000Z" });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 1 });
  });
});
