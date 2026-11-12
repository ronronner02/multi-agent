import type { TeamAttemptView, TeamOwnerRead, TeamReviewView, TeamRun, TeamSeatView, TeamSystemHealth } from "@multi-agent/daemon/team-control";

/**
 * One demo-shaped run, shared by the team surface's tests.
 *
 * The ids are deliberately shaped like the ones the owner complained about — a UUID run, a
 * `task-1-review-1` reviewer task — so a screen that renders one fails its no-id assertion.
 */

export const RUN_ID = "3f2b0c9e-0d1a-4c5b-8f2e-1a2b3c4d5e6f";

export const run: TeamRun = {
  id: RUN_ID, rigId: "rig-01M6P2CGXVE037YT9C19K76PWK", displayName: "Add the status filter", bindingDigest: "binding",
  state: "approved", stateReason: null, stateReasonKey: null, phase: "delivery",
  entityVersion: 3, activeMs: 252_000, accountedAt: null, retriesUsed: 0, reviewRoundsUsed: 1,
  reviewerSeat: "review@rig",
  usage: { activeMs: 252_000, inputTokens: { value: 18_700, reason: null }, outputTokens: { value: 23_400, reason: null },
    costUsd: { value: null, reason: "Not published" } },
  createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
  binding: { artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "docs/plans/fixture.md", planDigest: "a".repeat(64), repository: { root: "/fixture", identity: "fixture/repo" },
    readPaths: [], writePaths: [], roles: ["lead", "implementer", "reviewer"], policyRevision: 1, policyFingerprint: "b".repeat(64),
    limits: { maxSessions: 3, maxActiveMs: 60_000, maxRetries: 1, maxReviewRounds: 2 } },
};

export const seats: TeamSeatView[] = [
  { seat: "lead@rig", role: "lead", retired: false, client: "claude-code", index: null, displayName: "Lead · Claude Code" },
  { seat: "impl@rig", role: "implementer", retired: false, client: "codex", index: null, displayName: "Implementer · Codex" },
  { seat: "review@rig", role: "reviewer", retired: false, client: "claude-code", index: null, displayName: "Reviewer · Claude Code" },
];

export function task(overrides: Partial<TeamReviewView> = {}): TeamReviewView {
  const taskId = overrides.taskId ?? "task-1";
  return { stage: "done", seat: "impl@rig", workerReport: null, taskId, qitemId: `qitem-${taskId}`, role: "implementer", queueState: "done",
    displayName: "Status filter", displayNameParts: { kind: "task" }, title: "Status filter",
    dependencies: [], criteria: { verified: null, total: null, source: null }, currentCandidateDigest: `sha256:${"c".repeat(64)}`,
    rounds: 1, openP0P1: 0, verdicts: [], reviewAvailable: true, acceptance: null, ...overrides };
}

export function reviewTask(of = "Status filter", round = 1): TeamReviewView {
  return task({
    taskId: "task-1-review-1", qitemId: "qitem-20261105144520-11aa22bb", role: "reviewer", queueState: "in-progress", stage: "running", seat: "review@rig",
    displayName: `Review: ${of}`, displayNameParts: { kind: "review", round, of }, title: null,
  });
}

export function attempt(overrides: Partial<TeamAttemptView> = {}): TeamAttemptView {
  return { attemptId: "6b1f9a02-11c3-4d5e-9f00-aa11bb22cc33", runId: RUN_ID, taskId: "task-1",
    qitemId: "qitem-20261105144519-82c956ce", role: "implementer", provider: "claude",
    state: "stopped", unknownReason: null, session: "impl@rig", createdAt: "2026-10-31T00:00:00.000Z",
    usage: { activeMs: 0, inputTokens: { value: null, reason: "not reported" }, outputTokens: { value: null, reason: "not reported" },
      costUsd: { value: null, reason: "not reported" } }, failure: null, ...overrides };
}

export function read(overrides: Partial<TeamOwnerRead> = {}): TeamOwnerRead {
  return { schema: "multi-agent-team-read/v1", protocolVersion: "1.0", runId: RUN_ID, generatedAt: "2026-10-31T00:00:00.000Z",
    run, workflow: { current: "review", stages: [] }, tasks: [task()], seats, attempts: [], approvals: [], logs: [],
    replay: { retainedFrom: 1, latestSeq: 1 }, ...overrides };
}
export function health(): TeamSystemHealth {
  const light = { state: "unknown" as const, checkedAt: run.createdAt, evidenceRef: null, reason: "No live probe in this fixture." };
  return { schema: "multi-agent-system-health/v1", protocolVersion: "1.0", checkedAt: run.createdAt, timeoutMs: 5000,
    overall: "unknown", runtime: { isolation: "none" }, latestAttempts: {},
    lights: { database: light, queueMailbox: light, controlTmux: light, workerBoundary: light, sandboxNetwork: light, clients: light } };
}
