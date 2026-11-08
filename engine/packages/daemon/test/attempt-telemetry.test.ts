import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { classificationFor } from "../src/domain/attempt-failure.js";
import { composeAttemptCompletion } from "../src/domain/attempt-completion.js";
import { AttemptTelemetry } from "../src/domain/attempt-telemetry.js";
import { nativeThread, nativeUsage, tokenCounts, toolStart, turnTelemetryFixture } from "./helpers/turn-telemetry.js";

describe("attempt telemetry persistence and per-turn usage", () => {
  let fixture: ReturnType<typeof turnTelemetryFixture>, store: AttemptTelemetry;
  beforeEach(() => {
    fixture = turnTelemetryFixture();
    store = new AttemptTelemetry(fixture.db, { turnStateRoot: fixture.turnRoot, now: fixture.clock });
  });
  afterEach(() => fixture?.cleanup());

  const capture = (id: string) => {
    const attempt = fixture.governance.getAttempt(id)!;
    store.capture(attempt);
    return fixture.stop(id);
  };

  it("reads a bounded public progress snapshot, redacts at the boundary and leaves history unchanged", () => {
    const attempt = fixture.addAttempt("live-progress"), paths = fixture.writeSidecars(attempt.id, undefined, []);
    expect(store.readProgress(attempt)).toBeNull();
    const secret = "sk-" + "a".repeat(64);
    writeFileSync(join(paths.directory, "progress.json"), JSON.stringify({ version: 1, sequence: 3, at: "2026-11-08T01:00:00Z",
      status: "responding", blocks: [{ id: "text-1", text: "Checking " + secret + "\u001b[0m", complete: false,
        reasoning: "PRIVATE REASONING" }], truncated: false, hidden: "PRIVATE REASONING" }));
    const progress = store.readProgress(attempt);
    expect(progress).toMatchObject({ sequence: 3, status: "responding", blocks: [{ id: "text-1", complete: false }] });
    expect(progress?.blocks[0]?.text).toContain("[REDACTED]");
    expect(JSON.stringify(progress)).not.toContain(secret); expect(JSON.stringify(progress)).not.toContain("PRIVATE REASONING");
    expect(progress?.blocks[0]?.text).not.toContain("\u001b");
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM team_chat_messages").get()).toEqual({ n: 0 });
  });

  it.each([
    { status: "invented" }, { sequence: -1 }, { at: "not a date" }, { truncated: "yes" },
    { blocks: [{ id: "text-1", text: "x".repeat(65_537), complete: true }] },
    { blocks: [{ id: "text-1", text: "one", complete: true }, { id: "text-1", text: "duplicate", complete: true }] },
  ])("keeps malformed public progress unavailable: %j", patch => {
    const attempt = fixture.addAttempt("bad-progress"), paths = fixture.writeSidecars(attempt.id, undefined, []);
    writeFileSync(join(paths.directory, "progress.json"), JSON.stringify({ version: 1, sequence: 1, at: "2026-11-08T01:00:00Z",
      status: "working", blocks: [], truncated: false, ...patch }));
    expect(store.readProgress(attempt)).toBeNull();
  });

  it("persists invocation usage, duration and tool records once and reads them after reopening the database", () => {
    const attempt = fixture.addAttempt("first");
    fixture.writeSidecars(attempt.id, nativeUsage(), [toolStart, { ...toolStart, seq: 2, status: "completed" }]);
    fixture.setNow("2026-11-07T12:00:10.000Z");
    const stopped = capture(attempt.id);
    const result = store.read(stopped);
    expect(result).toMatchObject({ source: "stored", activeMs: 10_000, startedAt: "2026-11-07T12:00:00.000Z",
      stoppedAt: "2026-11-07T12:00:10.000Z", nextSeq: 2, activityStatus: "available",
      usage: { status: "available", model: "fixture-model", ...tokenCounts } });
    fixture.setNow("2026-11-07T12:00:50.000Z");
    fixture.writeSidecars(attempt.id, nativeUsage({ counts: { ...tokenCounts, inputTokens: 999 } }));
    store.capture(stopped);
    rmSync(fixture.turnRoot, { recursive: true });
    const reopened = createDb(fixture.dbPath), reader = new AttemptTelemetry(reopened);
    try { expect(reader.read(stopped)).toEqual(result); } finally { reopened.close(); }
    expect(fixture.governance.getAttempt(attempt.id)!.usage.inputTokens.value).toBeNull();
    expect(fixture.governance.getAttempt(attempt.id)!.usage.costUsd.value).toBeNull();
  });

  it("keeps resumed Claude invocation counts instead of subtracting the previous invocation", () => {
    fixture.addAttempt("first"); fixture.writeSidecars("first", nativeUsage()); capture("first");
    fixture.addAttempt("resumed");
    fixture.writeSidecars("resumed", nativeUsage({ resumed: true, counts: { ...tokenCounts, inputTokens: 80, outputTokens: 7 } }));
    expect(store.read(capture("resumed")).usage).toMatchObject({ status: "available", inputTokens: 80, outputTokens: 7 });
  });

  it("subtracts recorded totals only for the same resumed Codex thread", () => {
    const first = { inputTokens: 11_248, cacheReadInputTokens: 18_304, cacheWriteInputTokens: null,
      outputTokens: 101, reasoningOutputTokens: 26 };
    const second = { inputTokens: 11_736, cacheReadInputTokens: 47_744, cacheWriteInputTokens: null,
      outputTokens: 190, reasoningOutputTokens: 38 };
    fixture.addAttempt("first", { provider: "codex" });
    fixture.writeSidecars("first", nativeUsage({ client: "codex", counts: first })); capture("first");
    const next = fixture.addAttempt("resumed", { provider: "codex" });
    fixture.writeSidecars(next.id, nativeUsage({ client: "codex", resumed: true, counts: second }));
    expect(store.read(next).usage).toMatchObject({ inputTokens: 488, cacheReadInputTokens: 29_440, outputTokens: 89, reasoningOutputTokens: 12 });
    expect(store.read(capture(next.id)).usage).toMatchObject({ status: "available", inputTokens: 488,
      cacheReadInputTokens: 29_440, cacheWriteInputTokens: null, outputTokens: 89, reasoningOutputTokens: 12 });
    expect(store.analytics({ days: 1 }).totals.tokens).toBe(59_480 + 190);
  });

  it("does not subtract a different native thread on the same seat", () => {
    fixture.addAttempt("old", { provider: "codex" });
    fixture.writeSidecars("old", nativeUsage({ client: "codex" })); capture("old");
    fixture.addAttempt("fresh", { provider: "codex" });
    fixture.writeSidecars("fresh", nativeUsage({ client: "codex", thread: "00000000-0000-4000-8000-000000000002" }));
    expect(store.read(capture("fresh")).usage).toMatchObject({ status: "available", ...tokenCounts });
  });

  it("keeps a missing resumed baseline unavailable, but retains its total for the next turn", () => {
    fixture.addAttempt("resumed", { provider: "codex" });
    fixture.writeSidecars("resumed", nativeUsage({ client: "codex", resumed: true }));
    expect(store.read(capture("resumed")).usage).toMatchObject({ status: "unavailable", inputTokens: null, outputTokens: null });
    fixture.addAttempt("next", { provider: "codex" });
    fixture.writeSidecars("next", nativeUsage({ client: "codex", resumed: true,
      counts: { ...tokenCounts, inputTokens: 110, outputTokens: 12 } }));
    expect(store.read(capture("next")).usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });

  it("does not skip an unavailable intermediate attempt on a resumed thread", () => {
    fixture.addAttempt("first", { provider: "codex" });
    fixture.writeSidecars("first", nativeUsage({ client: "codex" })); capture("first");
    fixture.addAttempt("missing", { provider: "codex" });
    const paths = fixture.writeSidecars("missing", undefined, [toolStart]);
    writeFileSync(paths.threadId, nativeThread);
    capture("missing");
    fixture.addAttempt("next", { provider: "codex" });
    fixture.writeSidecars("next", nativeUsage({ client: "codex", resumed: true,
      counts: { ...tokenCounts, inputTokens: 140, outputTokens: 20 } }));
    expect(store.read(capture("next")).usage).toMatchObject({ status: "unavailable", inputTokens: null });
  });

  it("does not bridge a stopped attempt with no captured telemetry row", () => {
    fixture.addAttempt("first", { provider: "codex" });
    fixture.writeSidecars("first", nativeUsage({ client: "codex" })); capture("first");
    fixture.addAttempt("uncaptured", { provider: "codex" }); fixture.stop("uncaptured");
    fixture.addAttempt("next", { provider: "codex" });
    fixture.writeSidecars("next", nativeUsage({ client: "codex", resumed: true }));
    expect(store.read(capture("next")).usage.status).toBe("unavailable");
  });

  it("does not bridge an unidentifiable attempt on the same seat", () => {
    fixture.addAttempt("first", { provider: "codex" });
    fixture.writeSidecars("first", nativeUsage({ client: "codex" })); capture("first");
    fixture.addAttempt("missing", { provider: "codex" }); capture("missing");
    fixture.addAttempt("next", { provider: "codex" });
    fixture.writeSidecars("next", nativeUsage({ client: "codex", resumed: true }));
    expect(store.read(capture("next")).usage.status).toBe("unavailable");
  });

  it("does not turn decreasing cumulative counters into zero spend", () => {
    fixture.addAttempt("first", { provider: "codex" });
    fixture.writeSidecars("first", nativeUsage({ client: "codex" })); capture("first");
    fixture.addAttempt("next", { provider: "codex" });
    fixture.writeSidecars("next", nativeUsage({ client: "codex", resumed: true, counts: { ...tokenCounts, outputTokens: 1 } }));
    expect(store.read(capture("next")).usage).toMatchObject({ status: "unavailable", outputTokens: null });
  });

  it("reads a partial stream, redacts before truncation and aborts open calls when the wrapper did not finalize", () => {
    const attempt = fixture.addAttempt("killed"), secret = "sk-" + "a".repeat(64);
    const paths = fixture.writeSidecars(attempt.id, undefined, [{ ...toolStart, summary: "x ".repeat(245) + secret }]);
    appendFileSync(paths.activity, '{"seq":2,"status":');
    fixture.setNow("2026-11-07T12:00:09.000Z");
    const result = store.read(capture(attempt.id));
    expect(result).toMatchObject({ activeMs: 9000, activityStatus: "partial", nextSeq: 2, usage: { status: "unavailable" } });
    expect(result.records.map(record => record.status)).toEqual(["running", "aborted"]);
    expect(result.records.map(record => record.id)).toEqual(["call-1", "call-1"]);
    expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain("sk-");
    expect(result.records.every(record => record.summary.length <= 512)).toBe(true);
  });

  it("returns live records after the sequence cursor and never rereads stopped sidecars", () => {
    const attempt = fixture.addAttempt("live");
    fixture.writeSidecars(attempt.id, nativeUsage(), [toolStart, { ...toolStart, seq: 2, status: "completed" }]);
    expect(store.read(attempt, 1)).toMatchObject({ source: "live", nextSeq: 2, records: [{ seq: 2, status: "completed" }] });
    const stopped = capture(attempt.id), readFile = vi.fn((path: string) => readFileSync(path, "utf8"));
    const reader = new AttemptTelemetry(fixture.db, { turnStateRoot: fixture.turnRoot, readFile, now: fixture.clock });
    expect(reader.read(stopped, 2).records).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects malformed or cross-provider usage without manufacturing counts", () => {
    const attempt = fixture.addAttempt("invalid");
    fixture.writeSidecars(attempt.id, nativeUsage({ client: "codex" }));
    expect(store.read(attempt).usage.status).toBe("unavailable");
    fixture.writeSidecars(attempt.id, { ...nativeUsage(), counts: { ...tokenCounts, inputTokens: -1, outputTokens: "12" } });
    expect(store.read(attempt).usage).toMatchObject({ status: "unavailable", inputTokens: null, outputTokens: null });
    fixture.writeSidecars(attempt.id, { ...nativeUsage(), counts: { inputTokens: 10 } });
    expect(store.read(attempt).usage).toMatchObject({ status: "partial", inputTokens: 10, outputTokens: null });
  });

  it("persists before pane/seat release and stores the outcome before dispatch", async () => {
    const attempt = fixture.addAttempt("complete");
    fixture.writeSidecars(attempt.id, nativeUsage(), [toolStart, { ...toolStart, seq: 2, status: "completed" }]);
    fixture.setNow("2026-11-07T12:00:10.000Z");
    const order: string[] = [];
    const completion = composeAttemptCompletion({ db: fixture.db, governance: fixture.governance,
      currentBinding: () => fixture.binding, turnStateRoot: fixture.turnRoot, telemetry: store,
      alive: () => false, paneExit: async () => ({ dead: true, code: 0 }),
      releasePane: async () => {
        expect(store.read(attempt)).toMatchObject({ source: "stored", activeMs: 10_000 }); order.push("pane");
      },
      sessions: { findResumeContextByName: () => ({ sessionId: "session" }) as never,
        updateStartupStatus: () => {
          expect(store.read(fixture.governance.getAttempt(attempt.id)!)).toMatchObject({ source: "stored", outcome: "succeeded" });
          order.push("seat");
        } },
      candidateManifestFor: () => ({ base: "commit", baseIdentifier: "a".repeat(40), files: [{ path: "src/result.txt" }],
        manifestDigest: "sha256:" + "b".repeat(64), patch: "diff --git a/src/result.txt b/src/result.txt\n+++ b/src/result.txt\n" }),
      dispatchPending: async () => {
        expect(store.analytics({ days: 1 }).totals.succeeded).toBe(1); order.push("dispatch");
      },
    });
    await completion.sweep();
    expect(order).toEqual(["pane", "seat", "dispatch"]);
    expect(fixture.governance.getAttempt(attempt.id)!.usage.inputTokens.value).toBeNull();
    await completion.sweep(); expect(order).toHaveLength(3);
  });

  it("retains failed attempt history while a provider retry waits in the queue", async () => {
    const attempt = fixture.addAttempt("failed-turn");
    fixture.writeSidecars(attempt.id, nativeUsage());
    fixture.setNow("2026-11-07T12:00:10.000Z");
    const completion = composeAttemptCompletion({ db: fixture.db, governance: fixture.governance,
      currentBinding: () => fixture.binding, turnStateRoot: fixture.turnRoot, telemetry: store, alive: () => false,
      sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() },
      now: fixture.clock, paneExit: async () => ({ dead: true, code: 1 }),
      paneTail: async () => "Error: connect ECONNRESET",
    });
    await completion.sweep();
    expect(fixture.governance.queueState(fixture.qitemId)).toBe("pending");
    expect(fixture.governance.getTask(fixture.qitemId)!.evidence).toMatchObject({ retryNotBefore: "2026-11-07T12:02:10.000Z" });
    expect(store.read(fixture.governance.getAttempt(attempt.id)!)).toMatchObject({ outcome: "failed", activeMs: 10_000 });
    expect(store.analytics({ days: 1 }).totals).toMatchObject({ failed: 1, succeeded: 0, retryCount: 1 });
  });

  it("retries a database capture failure before recording the stop or releasing the seat", async () => {
    const attempt = fixture.addAttempt("capture-retry");
    fixture.writeSidecars(attempt.id, nativeUsage());
    const capture = vi.spyOn(store, "capture").mockImplementationOnce(() => { throw new Error("fixture database unavailable"); });
    const released = vi.fn(), completion = composeAttemptCompletion({ db: fixture.db, governance: fixture.governance,
      currentBinding: () => fixture.binding, telemetry: store, alive: () => false, log: vi.fn(),
      sessions: { findResumeContextByName: () => ({ sessionId: "session" }) as never, updateStartupStatus: released },
    });
    await completion.sweep();
    expect(fixture.governance.getAttempt(attempt.id)!.state).toBe("running"); expect(released).not.toHaveBeenCalled();
    await completion.sweep();
    expect(capture).toHaveBeenCalledTimes(2); expect(released).toHaveBeenCalledTimes(1);
    expect(store.read(fixture.governance.getAttempt(attempt.id)!).source).toBe("stored");
  });

  it("keeps an unknown outcome and releases the seat if the outcome metadata write fails", async () => {
    const attempt = fixture.addAttempt("outcome-write-failure");
    fixture.writeSidecars(attempt.id, nativeUsage());
    vi.spyOn(store, "recordOutcome").mockImplementationOnce(() => { throw new Error("fixture write failure"); });
    const released = vi.fn(), log = vi.fn();
    const completion = composeAttemptCompletion({ db: fixture.db, governance: fixture.governance,
      currentBinding: () => fixture.binding, telemetry: store, alive: () => false, log,
      sessions: { findResumeContextByName: () => ({ sessionId: "session" }) as never, updateStartupStatus: released },
    });
    await completion.sweep();
    expect(fixture.governance.getAttempt(attempt.id)!.state).toBe("stopped"); expect(released).toHaveBeenCalledTimes(1);
    expect(store.read(fixture.governance.getAttempt(attempt.id)!)).toMatchObject({ source: "stored", outcome: "unknown" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("telemetry outcome"));
  });

  it("counts an accepted owner retry from its event, not from the number of native attempts", () => {
    fixture.addAttempt("owner-retry");
    fixture.writeSidecars("owner-retry", nativeUsage());
    const stopped = capture("owner-retry");
    store.recordOutcome(stopped.id, { outcome: "failed", retryScheduled: false });
    fixture.governance.recordUsage(fixture.request("run", stopped.id, { expectedAttemptVersion: stopped.entityVersion,
      state: "stopped", usage: stopped.usage, failure: classificationFor("agent_error.provider_network") }));
    const failed = fixture.governance.getAttempt(stopped.id)!;
    const outcome = fixture.governance.recordTaskOutcome(fixture.request("run", fixture.qitemId, {
      expectedTaskVersion: fixture.governance.getTask(fixture.qitemId)!.entityVersion, state: "failed", actorSession: "implementer@fixture",
      attemptId: failed.id, expectedAttemptVersion: failed.entityVersion, evidence: { validated: false, reasonCode: "agent_error.provider_network" },
    }), fixture.owner);
    expect(outcome.status).toBe("observed");
    const retry = fixture.governance.ownerCommand("retry", fixture.request("run", fixture.qitemId, {
      expectedTaskVersion: fixture.governance.getTask(fixture.qitemId)!.entityVersion,
      attemptId: failed.id, expectedAttemptVersion: failed.entityVersion,
    }), fixture.owner, fixture.binding);
    expect(retry.status).toBe("accepted");
    expect(store.analytics({ days: 1 }).totals).toMatchObject({ attempts: 1, retryCount: 1, retryRate: 1 });
  });

  it("uses the same native thread baseline even when the invocation has a different seat", () => {
    fixture.addAttempt("first", { provider: "codex" });
    fixture.writeSidecars("first", nativeUsage({ client: "codex" })); capture("first");
    const task = fixture.addTask("other-seat-task", "run", "other@fixture");
    fixture.addAttempt("next", { provider: "codex", task });
    fixture.writeSidecars("next", nativeUsage({ client: "codex", resumed: true,
      counts: { ...tokenCounts, inputTokens: 125, outputTokens: 15 } }));
    expect(store.read(capture("next")).usage).toMatchObject({ status: "available", inputTokens: 25, outputTokens: 5 });
  });

  it("uses null metrics for an empty population and isolates the run filter", () => {
    expect(store.analytics({ days: 1 }).totals).toMatchObject({ attempts: 0, tokens: null, successRate: null, retryRate: null, medianDurationMs: null });
    fixture.addAttempt("first"); fixture.writeSidecars("first", nativeUsage()); capture("first");
    expect(store.analytics({ days: 1, runId: "other" }).totals.attempts).toBe(0);
  });

  it("registers a real attempt foreign key", () => {
    expect(fixture.db.prepare("PRAGMA foreign_key_list(attempt_telemetry)").all())
      .toContainEqual(expect.objectContaining({ table: "team_attempts", from: "attempt_id", to: "id" }));
  });

  it("aggregates captured outcomes, counted retries, UTC days and historical seats without cost", () => {
    fixture.addAttempt("failed");
    fixture.writeSidecars("failed", nativeUsage());
    fixture.setNow("2026-11-07T12:00:10.000Z");
    capture("failed"); store.recordOutcome("failed", { outcome: "failed", retryScheduled: true });
    fixture.addAttempt("succeeded");
    fixture.writeSidecars("succeeded", nativeUsage({ model: "second-model" }));
    fixture.setNow("2026-11-07T12:00:30.000Z");
    capture("succeeded"); store.recordOutcome("succeeded", { outcome: "succeeded", retryScheduled: false });
    fixture.addAttempt("unknown");
    fixture.setNow("2026-11-07T12:01:00.000Z"); capture("unknown");
    fixture.db.prepare("UPDATE nodes SET retired_at = ? WHERE id = 'node'").run(fixture.clock().toISOString());
    const analytics = store.analytics({ days: 1, teamId: "rig" });
    expect(analytics.totals).toMatchObject({ attempts: 3, measuredAttempts: 2, tokens: 270, activeMs: 60_000,
      succeeded: 1, failed: 1, unknown: 1, retryCount: 1, successRate: 0.5, retryRate: 1 / 3, medianDurationMs: 20_000 });
    expect(analytics.byDay).toMatchObject([{ day: "2026-11-07", tokens: 270 }]);
    expect(analytics.byModel).toHaveLength(3);
    expect(analytics.bySeat).toMatchObject([{ seat: "implementer@fixture", tokens: 270 }]);
    expect(JSON.stringify(analytics)).not.toMatch(/cost|expense/i);
  });
});
