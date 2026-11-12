import type Database from "better-sqlite3";
import { createDb } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/baseline.js";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { SessionRegistry } from "../../src/domain/session-registry.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { QueueRepository } from "../../src/domain/queue-repository.js";
import { TranscriptStore } from "../../src/domain/transcript-store.js";
import { ContextUsageStore } from "../../src/domain/context-usage-store.js";
import { AgentActivityStore } from "../../src/domain/agent-activity-store.js";
import { createApp } from "../../src/server.js";
import type { RuntimeAdapter } from "../../src/domain/runtime-adapter.js";

/** Create the retained team-product schema for a test. */
export function createFullTestDb(): Database.Database {
  const db = createDb();
  initializeDatabase(db);
  return db;
}

export function createTestApp(
  db: Database.Database,
  opts?: {
    adapters?: Partial<Record<string, RuntimeAdapter>>;
    activityFreshnessMs?: number;
    eventLoopMonitor?: import("../../src/domain/event-loop-monitor.js").EventLoopMonitor;
    routeTimingRecorder?: import("../../src/domain/route-timing-recorder.js").RouteTimingRecorder;
    appDeps?: Partial<import("../../src/server.js").AppDeps>;
    wireRuntimeAdapters?: boolean;
  },
) {
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const queueRepo = new QueueRepository(db, eventBus);
  const transcriptStore = new TranscriptStore("/tmp/multi-agent-test-transcripts");
  const contextUsageStore = new ContextUsageStore(db, { stateDir: "/tmp/multi-agent-test" });
  const agentActivityStore = new AgentActivityStore({
    db,
    eventBus,
    freshnessMs: opts?.activityFreshnessMs,
    resolveOccupantGeneration: nodeId => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) => sessionRegistry.isOccupantGenerationRegistered(nodeId, generation),
  });
  const testAppDeps: Record<string, unknown> = {
    rigRepo,
    sessionRegistry,
    eventBus,
    queueRepo,
    transcriptStore,
    contextUsageStore,
    agentActivityStore,
    eventLoopMonitor: opts?.eventLoopMonitor,
    routeTimingRecorder: opts?.routeTimingRecorder,
    runtimeAdapters: opts?.wireRuntimeAdapters ? opts?.adapters as Record<string, RuntimeAdapter> | undefined : opts?.adapters as Record<string, RuntimeAdapter> | undefined,
    ...opts?.appDeps,
  };
  const built = { app: createApp(testAppDeps as never) };
  return {
    app: built.app,
    db,
    rigRepo,
    sessionRegistry,
    eventBus,
    queueRepo,
    transcriptStore,
    contextUsageStore,
    agentActivityStore,
  };
}
