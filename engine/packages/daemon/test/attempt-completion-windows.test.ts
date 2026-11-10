import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TEAM_CONTROL_VERSION, type ControlRequest } from "../src/contracts/team-control.js";
import { composeAttemptCompletion, identityAlive } from "../src/domain/attempt-completion.js";
import { observeIdentity } from "../src/domain/process-termination.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PlanGovernance, hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { setHostPlatformForTests } from "../src/domain/platform.js";

/**
 * U1 / KTD5 — on Windows an unproved identity is not an end.
 *
 * The completion sweep closes every attempt whose process is gone. On POSIX that reading comes
 * from `/proc`; on Windows it comes from a CIM query that can be denied or time out. If a failed
 * query read as "gone", the first sweep after a restart would close live work. These cases pin
 * the two halves: the platform answer is `unknown` for an unavailable query, and the sweep — whose
 * default liveness probe is that same answer — leaves a running attempt alone.
 *
 * The binding is built literally rather than through `bindingForGoal`, because the contract still
 * requires a POSIX-shaped root and that path must exist for the helper; U7 owns accepting Windows
 * paths. What is under test here is the liveness answer, not the path shape.
 */

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const unavailable = { value: null, reason: "unobserved" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };

describe("U1 Windows liveness never fabricates an end", () => {
  let directory: string;
  let db: Database.Database;
  let governance: PlanGovernance;
  let planBinding: PlanBinding;
  let attemptId: string;

  const composeBinding = (): PlanBinding => {
    const policy = unisolatedPolicyCapability(1);
    return {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"), repository: { root: "/fixture/repo", identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"] as const,
      policyRevision: policy.policyRevision, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
  };

  let serial = 0;
  const request = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION, runId: "run", actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion,
    // Each command is a distinct request; the key names its digest, so it must differ per call.
    idempotencyKey: `u1-${actionId}-${++serial}`, payload,
  });

  afterEach(() => {
    setHostPlatformForTests(null);
    if (db?.open) db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("answers unknown, not dead, when the Windows query cannot be made", async () => {
    setHostPlatformForTests("win32");
    // A pid the query rejects cannot be answered: `observeIdentity` says unknown, and the sweep's
    // boolean form says "not an end" — the attempt stays open.
    expect(await observeIdentity({ processId: -5, processStart: "recorded" })).toBe("unknown");
    expect(await identityAlive({ processId: -5, processStart: "recorded" })).toBe(true);
  });

  it("leaves a running attempt open when the recorded process cannot be proved ended", async () => {
    directory = mkdtempSync(join(tmpdir(), "u1-attempt-"));
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    const bus = new EventBus(db);
    const queue = new QueueRepository(db, bus);
    const policy = unisolatedPolicyCapability(1);
    const capability = () => ({ policyRevision: policy.policyRevision, policyFingerprint: hashBytes("policy"), verifiedProviders: ["claude", "codex"] as const });
    governance = new PlanGovernance(db, bus, queue, undefined, capability);
    planBinding = composeBinding();
    governance.createRun({ id: "run", rigId: "rig", binding: planBinding });
    governance.requestApproval(request("approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(planBinding) }, targetDigest: hashBinding(planBinding), expiresAt: "2030-01-01T00:00:00.000Z" }), owner);
    governance.decideApproval(request("approval", { approvalVersion: 1, decision: "approved" }), owner, planBinding);
    const created = governance.createTask(request("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: ["src/a.ts"], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@rig", destinationSession: "implementer@rig", body: "Implement the task",
    }), planBinding);
    expect(created.status).toBe("accepted");
    attemptId = "attempt-1";
    governance.recordAttempt(request(attemptId, {
      qitemId: (created.value as { qitemId: string }).qitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "native", tmuxServer: "/tmp/tmux.sock", paneId: "%1", processId: 123,
        processStart: "start-1", generation: 1, policyFingerprint: planBinding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), planBinding);

    // The probe is the production one: `identityAlive` over a recorded identity whose Windows query
    // cannot be answered. That is `unknown`, the sweep's boolean form says "not an end", and the
    // attempt must stay running rather than being recorded stopped on evidence the daemon lacks.
    const completion = composeAttemptCompletion({
      db, governance, currentBinding: () => structuredClone(planBinding), log: () => {}, turnStateRoot: join(directory, "turns"),
      sessions: { findResumeContextByName: () => null, updateStartupStatus: () => {} },
      alive: () => identityAlive({ processId: -5, processStart: "unanswerable" }),
    });
    setHostPlatformForTests("win32");
    await completion.sweep();
    expect(governance.getAttempt(attemptId)?.state).toBe("running");
  });
});
