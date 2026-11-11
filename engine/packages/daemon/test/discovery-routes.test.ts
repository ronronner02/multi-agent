import { describe, expect, it } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createApp } from "../src/server.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";

describe("retained discovery repository dependency", () => {
  it("createApp rejects mismatched discoveryRepo db handle", () => {
    const db = createFullTestDb(), otherDb = createFullTestDb();
    try {
      const setup = createTestApp(db);
      expect(() => createApp({ ...setup, discoveryRepo: new DiscoveryRepository(otherDb) }))
        .toThrow(/discoveryRepo.*same db handle/);
    } finally { otherDb.close(); db.close(); }
  });
});
