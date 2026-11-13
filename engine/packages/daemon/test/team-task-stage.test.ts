import { describe, expect, it } from "vitest";
import { teamTaskStage, type TeamTaskStageFacts } from "../src/domain/team-task-stage.js";

const idle: TeamTaskStageFacts = { ownerDecision: false, ownerQuestion: false, ownerBlocked: false, workerReport: false,
  pending: false, liveAttempt: false, awaitingReview: false };

describe("task stages", () => {
  it.each([
    ["owner/decision", { ownerDecision: true }],
    ["owner/question", { ownerQuestion: true }],
    ["owner/blocked", { ownerBlocked: true }],
    ["lead/report", { workerReport: true }],
    ["queued", { pending: true }],
    ["running", { liveAttempt: true }],
    ["review", { awaitingReview: true }],
    ["done", {}],
  ])("publishes %s from its own evidence", (stage, facts) => {
    expect(teamTaskStage({ ...idle, ...facts })).toBe(stage);
  });

  it("keeps owner decisions ahead of Resume, reports and running work", () => {
    expect(teamTaskStage({ ...idle, ownerDecision: true, ownerBlocked: true,
      workerReport: true, liveAttempt: true, awaitingReview: true })).toBe("owner/decision");
    expect(teamTaskStage({ ...idle, ownerBlocked: true, workerReport: true,
      liveAttempt: true })).toBe("owner/blocked");
    expect(teamTaskStage({ ...idle, workerReport: true, pending: true,
      liveAttempt: true })).toBe("lead/report");
  });

  it("puts a worker's question to the owner ahead of the lead's report queue", () => {
    expect(teamTaskStage({ ...idle, ownerQuestion: true, workerReport: true })).toBe("owner/question");
    expect(teamTaskStage({ ...idle, ownerDecision: true, ownerQuestion: true })).toBe("owner/decision");
  });

  it("does not call a pending queue row queued once its attempt is live", () => {
    expect(teamTaskStage({ ...idle, pending: true, liveAttempt: true })).toBe("running");
    expect(teamTaskStage({ ...idle, pending: true, awaitingReview: true })).toBe("queued");
    expect(teamTaskStage({ ...idle, liveAttempt: true, awaitingReview: true })).toBe("running");
  });
});
