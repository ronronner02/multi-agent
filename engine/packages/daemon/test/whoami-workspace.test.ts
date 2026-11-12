// PL-007 Workspace Primitive v0 — whoami workspace block tests.
//
// Pins:
//   - whoami returns workspace block populated when rig has workspace
//     declared via setRigWorkspace
//   - whoami returns workspace=null when rig has no workspace
//   - per-node workspace.activeRepo resolves from cwd against repos[]

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";

let db: Database.Database;
let rigRepo: RigRepository;
let whoami: WhoamiService;

function makeFixture(): void {
  db = createDb();
  initializeDatabase(db);
  rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const transcriptStore = new TranscriptStore({ enabled: false, baseDir: "/tmp" });
  whoami = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore });
}

beforeEach(() => makeFixture());
afterEach(() => db.close());

describe("whoami workspace block (PL-007)", () => {
  it("returns workspace block when rig has workspace declared", () => {
    const rig = rigRepo.createRig("alpha-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/Users/op/hub/main/sub" });
    rigRepo.setRigWorkspace(rig.id, {
      workspaceRoot: "/Users/op/hub",
      repos: [
        { name: "main", path: "/Users/op/hub/main", kind: "project" },
      ],
      defaultRepo: "main",
      knowledgeRoot: "/Users/op/knowledge",
    });

    const result = whoami.resolve({ nodeId: node.id });
    expect(result).not.toBeNull();
    expect(result?.workspace).toBeDefined();
    expect(result?.workspace?.workspaceRoot).toBe("/Users/op/hub");
    expect(result?.workspace?.activeRepo).toBe("main");
    expect(result?.workspace?.knowledgeKind).toBe("knowledge");
  });

  it("honors caller-supplied target repo override for CLI-scoped whoami", () => {
    const rig = rigRepo.createRig("alpha-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/Users/op/hub/main/sub" });
    rigRepo.setRigWorkspace(rig.id, {
      workspaceRoot: "/Users/op/hub",
      repos: [
        { name: "main", path: "/Users/op/hub/main", kind: "project" },
        { name: "internal", path: "/Users/op/hub/internal", kind: "project" },
      ],
      defaultRepo: "main",
    });

    const result = whoami.resolve({ nodeId: node.id, targetRepoOverride: "internal" });
    expect(result?.workspace?.activeRepo).toBe("internal");
  });

  it("returns workspace=null when rig has no workspace declared", () => {
    const rig = rigRepo.createRig("plain-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/x" });

    const result = whoami.resolve({ nodeId: node.id });
    expect(result?.workspace).toBeNull();
  });
});
