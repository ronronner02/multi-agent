import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("NodeDetailPanel P0-2 regression: drawer fill-parent guard", () => {
  // V1 polish slice Phase 5.1 P5.1-D2: NodeDetailPanel.tsx is fully
  // RETIRED at V1 polish; the canonical agent-detail surface is now
  // LiveNodeDetails.tsx (center page). The original P0-2 ship-gate
  // bounce regression guarded NodeDetailPanel's drawer fill-parent
  // layout; now that the file is gone, the guard becomes the
  // file-doesn't-exist assertion (which lives in
  // node-selection-migration.test.tsx). This block converts to a
  // companion source-assertion on LiveNodeDetails: the canonical
  // surface must NOT regress into legacy absolute self-pinning.
  it("LiveNodeDetails.tsx does not regress into legacy 'absolute inset-y-0 right-0 w-80' self-pinning", async () => {
    const liveSrc = readFileSync(
      path.resolve(__dirname, "../src/components/LiveNodeDetails.tsx"),
      "utf8",
    );
    const codeOnly = liveSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    expect(codeOnly).not.toMatch(/absolute\s+inset-y-0\s+right-0/);
    expect(codeOnly).not.toMatch(/\bw-80\b/);
  });
});
