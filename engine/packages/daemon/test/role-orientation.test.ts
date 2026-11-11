import { describe, expect, it } from "vitest";
import { validateAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";
import { resolveStartup } from "../src/domain/startup-resolver.js";

describe("explicit role orientation", () => {
  it("validates the marker and preserves it through normalization and startup layering", () => {
    const spec = { name: "worker", version: "1.0", startup: { files: [
      { path: "instructions.md", orientation: "role" }, { path: "setup.md" },
    ] } };
    expect(validateAgentSpec(spec).valid).toBe(true);
    const normalized = normalizeAgentSpec(spec);
    const resolved = resolveStartup({ specStartup: normalized.startup });
    expect(resolved.files[0]).toHaveProperty("orientation", "role");
    expect(resolved.files[1]).not.toHaveProperty("orientation");
    for (const orientation of ["roles", "", null, true, {}]) {
      expect(validateAgentSpec({ ...spec, startup: { files: [{ path: "role.md", orientation }] } }).valid).toBe(false);
    }
  });
});
