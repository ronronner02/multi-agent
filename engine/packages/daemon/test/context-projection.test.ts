import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { getNodeInventoryWithContext, getNodeDetailWithContext } from "../src/domain/node-inventory.js";

describe("Context Usage Projection", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let store: ContextUsageStore;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    store = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test" });
  });

  afterEach(() => { db.close(); });

  const KNOWN_USAGE = {
    availability: "known" as const,
    reason: null,
    source: "claude_statusline_json" as const,
    usedPercentage: 67,
    remainingPercentage: 33,
    contextWindowSize: 200000,
    totalInputTokens: 120000,
    totalOutputTokens: 14000,
    currentUsage: "67% used",
    transcriptPath: "/tmp/test.log",
    sessionId: "sess-123",
    sessionName: "dev-impl@test-rig",
    sampledAt: new Date().toISOString(),
    fresh: true,
  };

  // T1: NodeInventoryEntry includes contextUsage for Claude node with persisted data
  it("getNodeInventoryWithContext includes known contextUsage", () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    store.persist(node.id, KNOWN_USAGE);

    const inventory = getNodeInventoryWithContext(db, rig.id, store);
    const entry = inventory.find((e) => e.logicalId === "dev.impl");

    expect(entry?.contextUsage).toBeDefined();
    expect(entry?.contextUsage?.availability).toBe("known");
    expect(entry?.contextUsage?.usedPercentage).toBe(67);
  });

  // T2: NodeInventoryEntry includes unknown contextUsage for non-Claude node
  it("getNodeInventoryWithContext returns unknown for non-Claude node", () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    setup.sessionRegistry.registerSession(node.id, "dev-qa@test-rig");

    const inventory = getNodeInventoryWithContext(db, rig.id, store);
    const entry = inventory.find((e) => e.logicalId === "dev.qa");

    expect(entry?.contextUsage?.availability).toBe("unknown");
  });

  // T3: NodeDetailEntry includes full contextUsage
  it("getNodeDetailWithContext includes full contextUsage", () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    store.persist(node.id, KNOWN_USAGE);

    const detail = getNodeDetailWithContext(db, rig.id, "dev.impl", store);
    expect(detail?.contextUsage?.availability).toBe("known");
    expect(detail?.contextUsage?.usedPercentage).toBe(67);
    expect(detail?.contextUsage?.contextWindowSize).toBe(200000);
  });

});
