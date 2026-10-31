import type { TeamAttemptView, TeamOwnerRead, TeamReviewView, TeamRun } from "@openrig/daemon/team-control";

/** One run, task and attempt builder, shared by the Workspace, Reviews and Analytics tests: they
 * read the same projection, so a fixture that drifted between them would hide a real disagreement. */

export const run: TeamRun = {
  id: "RUN-0142", rigId: "work-board", bindingDigest: "binding", state: "approved", stateReason: null,
  entityVersion: 3, activeMs: 252_000, accountedAt: null, retriesUsed: 0, reviewRoundsUsed: 1,
  usage: { activeMs: 252_000, inputTokens: { value: 18_700, reason: null }, outputTokens: { value: 23_400, reason: null },
    costUsd: { value: null, reason: "Not published" } },
  createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
  binding: { artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "docs/plans/fixture.md", planDigest: "a".repeat(64), repository: { root: "/fixture", identity: "fixture/repo" },
    readPaths: [], writePaths: [], roles: ["lead", "implementer", "reviewer"], policyRevision: 1, policyFingerprint: "b".repeat(64),
    limits: { maxSessions: 3, maxActiveMs: 60_000, maxRetries: 1, maxReviewRounds: 2 } },
};

export function task(overrides: Partial<TeamReviewView> = {}): TeamReviewView {
  return { taskId: "T-102", qitemId: "q-T-102", role: "implementer", queueState: "done", title: "Status filter",
    dependencies: [], criteria: { verified: null, total: null, source: null }, currentCandidateDigest: `sha256:${"c".repeat(64)}`,
    rounds: 1, openP0P1: 1, reviewAvailable: true, acceptance: null, ...overrides };
}

/** An attempt whose usage the producer never observed, which is the state a fresh attempt is in. */
export function attempt(overrides: Partial<TeamAttemptView> = {}): TeamAttemptView {
  return { attemptId: "a1", runId: run.id, taskId: "T-102", qitemId: "q-T-102", role: "implementer", provider: "claude",
    state: "stopped", unknownReason: null, session: null, createdAt: "2026-10-31T00:00:00.000Z",
    usage: { activeMs: 0, inputTokens: { value: null, reason: "not reported" }, outputTokens: { value: null, reason: "not reported" },
      costUsd: { value: null, reason: "not reported" } }, ...overrides };
}

export function read(overrides: Partial<TeamOwnerRead> = {}): TeamOwnerRead {
  return { schema: "multi-agent-team-read/v1", protocolVersion: "1.0", runId: run.id, generatedAt: "2026-10-31T00:00:00.000Z",
    run, workflow: { current: "review", stages: [] }, tasks: [task()], attempts: [], approvals: [], logs: [],
    replay: { retainedFrom: 1, latestSeq: 1 }, ...overrides };
}
