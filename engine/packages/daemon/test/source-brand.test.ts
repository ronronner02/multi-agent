import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

describe("current product names", () => {
  it("keeps legacy brand names only in historical records and license files", () => {
    const scan = fileURLToPath(new URL("../../../scripts/check-brand.mjs", import.meta.url));
    expect(execFileSync(process.execPath, [scan], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
      .toContain("Source brand scan passed.");
  });
});
