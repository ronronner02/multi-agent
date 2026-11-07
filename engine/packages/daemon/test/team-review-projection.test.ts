import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { turnTelemetryFixture } from "./helpers/turn-telemetry.js";
import { TeamReadModel } from "../src/team-control-surface.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

describe("review and seat projections", () => {
  let fixture: ReturnType<typeof turnTelemetryFixture>;
  let model: TeamReadModel;
  beforeEach(() => {
    fixture = turnTelemetryFixture();
    fixture.db.prepare("UPDATE nodes SET role = 'implementer' WHERE id = 'node'").run();
    new SessionRegistry(fixture.db).registerSession("node", "implementer@fixture");
    model = new TeamReadModel({ db: fixture.db, governance: fixture.governance, events: fixture.events,
      readTaskRows: runId => fixture.db.prepare(
        "SELECT a.qitem_id AS qitemId, a.task_id AS taskId, json_extract(a.assignment_json, '$.role') AS role, q.state AS queueState, q.destination_session AS session FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id WHERE a.run_id = ? ORDER BY a.task_id"
      ).all(runId) as Array<{ qitemId: string; taskId: string; role: string; queueState: string; session: string | null }> });
  });
  afterEach(() => fixture.cleanup());

  it("publishes each verdict's bounded finding records beside its existing counts", () => {
    fixture.events.emit({ type: "team.control", protocolVersion: "1.0", eventId: "review-record",
      rigId: "rig", runId: "run", taskId: "task", attemptId: null, entityId: "task", entityVersion: 2,
      action: "review.verdict", payload: { taskId: "task", reviewerTaskId: "review-task", round: 1,
        candidateDigest: "sha256:" + "a".repeat(64), verdict: "changes-required", recordedAt: "2026-11-07T12:00:00.000Z",
        findings: [
          { id: "finding-1", severity: "P1", file: "src/filter.ts", category: "Wrong default", citation: "R8",
            scenario: "An empty selection hides every result." },
          { id: "finding-2", severity: "P3", file: "src/label.ts", category: "Use a clearer label", citation: "" },
        ] } });
    expect(model.read("run").tasks[0]!.verdicts[0]).toMatchObject({ findings: 2, blocking: 1,
      findingRecords: [
        { id: "finding-1", severity: "P1", file: "src/filter.ts", summary: "An empty selection hides every result." },
        { id: "finding-2", severity: "P3", file: "src/label.ts", summary: "Use a clearer label" },
      ] });
  });

  it("bounds and redacts finding summaries before returning the read", () => {
    fixture.events.emit({ type: "team.control", protocolVersion: "1.0", eventId: "long-review",
      rigId: "rig", runId: "run", taskId: "task", attemptId: null, entityId: "task", entityVersion: 2,
      action: "review.verdict", payload: { taskId: "task", reviewerTaskId: "review-task", round: 1,
        candidateDigest: null, verdict: "changes-required", recordedAt: "2026-11-07T12:00:00.000Z",
        findings: [{ id: "finding-1", severity: "P1", file: "src/filter.ts", category: "Credential in output", citation: "R8",
          scenario: "Authorization: Bearer fixture-sensitive-token\\n" + "Ordinary evidence text. ".repeat(200) }] } });
    const verdict = model.read("run").tasks[0]!.verdicts[0] as unknown as { findingRecords: Array<{ summary: string }> };
    expect(verdict.findingRecords[0]!.summary).not.toContain("fixture-sensitive-token");
    expect(verdict.findingRecords[0]!.summary.length).toBeLessThanOrEqual(2000);
  });

  it("keeps retired seats readable without presenting them as active", () => {
    expect(model.read("run").seats[0]).toMatchObject({ seat: "implementer@fixture", retired: false });
    fixture.db.prepare("UPDATE nodes SET retired_at = '2026-11-07T12:00:00.000Z' WHERE id = 'node'").run();
    expect(model.read("run").seats).toHaveLength(1);
    expect(model.read("run").seats[0]).toMatchObject({ seat: "implementer@fixture", retired: true });
  });
});
