import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AttemptTelemetry } from "../src/domain/attempt-telemetry.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { createTestApp } from "./helpers/test-app.js";
import { nativeUsage, toolStart, turnTelemetryFixture } from "./helpers/turn-telemetry.js";

const ownerToken = "owner-telemetry-fixture", workerToken = "worker-telemetry-fixture";
describe("owner-scoped activity and analytics routes", () => {
  let fixture: ReturnType<typeof turnTelemetryFixture>, telemetry: AttemptTelemetry;
  let app: ReturnType<typeof createTestApp>["app"];
  let readFile: ReturnType<typeof vi.fn>;
  const activity = "/api/team-control/runs/run/attempts/attempt/activity";
  const request = (path: string, token: string | null = ownerToken) => app.request(path, {
    headers: token === null ? {} : { Authorization: "Bearer " + token },
  }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  beforeEach(() => {
    fixture = turnTelemetryFixture(); fixDaemonMode(fixture.db, true);
    fixture.addAttempt("attempt");
    fixture.writeSidecars("attempt", nativeUsage(), [toolStart, { ...toolStart, seq: 2, status: "completed" }]);
    readFile = vi.fn((path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } });
    telemetry = new AttemptTelemetry(fixture.db, { turnStateRoot: fixture.turnRoot, now: fixture.clock, readFile });
    app = createTestApp(fixture.db, { appDeps: { eventBus: fixture.events, queueRepo: fixture.queue,
      teamGovernance: fixture.governance, attemptTelemetry: telemetry,
      teamControl: { credentials: { ownerToken, workers: [{ token: workerToken, sessionId: "implementer@fixture", runId: "run" }] },
        readPolicyCapability: () => fixture.policy } } }).app;
  });
  afterEach(() => fixture?.cleanup());

  it("serves live usage and cursor-filtered calls through the mounted route", async () => {
    const response = await request(activity + "?after=1");
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ activity: { source: "live", nextSeq: 2,
      usage: { status: "available", inputTokens: 100 }, records: [{ seq: 2, status: "completed" }] } });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("switches to durable data after the attempt closes", async () => {
    telemetry.capture(fixture.governance.getAttempt("attempt")!); fixture.stop("attempt");
    readFile.mockClear();
    const response = await request(activity);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ activity: { source: "stored", records: [{ seq: 1 }, { seq: 2 }] } });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([["unknown", "/api/team-control/runs/run/attempts/missing/activity"],
    ["wrong run", "/api/team-control/runs/other/attempts/attempt/activity"]])
  ("rejects %s identities before any sidecar read", async (_kind, path) => {
    const response = await request(path!);
    expect(response.status).toBe(404); expect(readFile).not.toHaveBeenCalled();
  });

  it.each(["-1", "1x", "1.5", "0x10", "1e2", "", "9007199254740992", "1&after=2"])
  ("rejects the invalid after cursor %s before reading files", async after => {
    expect((await request(activity + "?after=" + after)).status).toBe(400);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([activity, "/api/team-control/analytics"])("rejects a worker token on %s", async path => {
    expect((await request(path, workerToken)).status).toBe(403);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([activity, "/api/team-control/analytics"])("requires owner authentication on %s", async path => {
    expect((await request(path, null)).status).toBe(401);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("redacts tool inputs at the file-to-response boundary", async () => {
    const key = "sk-" + "a".repeat(64), bearer = "Bearer " + "b".repeat(64);
    fixture.writeSidecars("attempt", nativeUsage(), [{ ...toolStart, summary: "curl -H 'Authorization: " + bearer + "' --key " + key }]);
    const response = await request(activity), text = await response.text();
    expect(response.status).toBe(200); expect(text).not.toContain(key); expect(text).not.toContain(bearer);
    expect(text).toContain("[REDACTED]");
  });

  it("serves the scoped analytics aggregate without reading live files", async () => {
    fixture.setNow("2026-11-07T12:00:10.000Z");
    telemetry.capture(fixture.governance.getAttempt("attempt")!); fixture.stop("attempt");
    telemetry.recordOutcome("attempt", { outcome: "succeeded", retryScheduled: false });
    readFile.mockClear();
    const response = await request("/api/team-control/analytics?team=rig&days=1");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ analytics: { totals: { tokens: 135, activeMs: 10_000, successRate: 1, retryRate: 0 } } });
    expect(JSON.stringify(result)).not.toMatch(/cost|expense/i); expect(readFile).not.toHaveBeenCalled();
    const other = await request("/api/team-control/analytics?team=other&days=1");
    expect(await other.json()).toMatchObject({ analytics: { totals: { attempts: 0, tokens: null } } });
  });

  it.each(["0", "-1", "366", "1.5", "no", "", "1&days=2"])("rejects invalid day window %s", async days => {
    expect((await request("/api/team-control/analytics?days=" + days)).status).toBe(400);
  });
});
