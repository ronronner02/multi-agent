import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FRAMEWORK_CATALOG, FRAMEWORK_PIN, frameworkEntry } from "../src/integrations/framework/catalog.js";

describe("pinned framework catalog", () => {
  it("accounts for exactly the upstream entrypoints at the approved revision", () => {
    const names = FRAMEWORK_CATALOG.map(entry => entry.name).sort();
    expect(FRAMEWORK_PIN.revision).toBe("74655dc86b1270bb52239e0f8bc9517de7a7071c");
    expect(names).toHaveLength(38);
    expect(new Set(names).size).toBe(38);
    expect(createHash("sha256").update(names.join("\n")).digest("hex"))
      .toBe("56a8997eaf50bf658f444cf254c850e788afb9f92d5cda55e8af21092d8f66f5");
  });
  it("classifies every entry and exposes a prerequisite for gated or deferred capabilities", () => {
    for (const entry of FRAMEWORK_CATALOG) {
      expect(["supported", "gated", "deferred"]).toContain(entry.status);
      expect(entry.sourcePath).toBe(`skills/${entry.name}/SKILL.md`);
      if (entry.status !== "supported") expect(entry.prerequisite.trim()).not.toBe("");
    }
    expect(frameworkEntry("spec-test-xcode")).toMatchObject({ status: "gated" });
    expect(frameworkEntry("spec-test-xcode")?.prerequisite).toContain("macOS");
    expect(frameworkEntry("review")).toBeUndefined();
  });
  it("retains explicit user invocation and caller-owned delivery boundaries", () => {
    for (const name of ["spec-lfg", "spec-handoff", "spec-prototype"]) {
      expect(frameworkEntry(name)).toMatchObject({ status: "gated", invocation: "user" });
    }
    for (const name of ["spec-commit", "spec-commit-push-pr", "spec-worktree"]) {
      expect(frameworkEntry(name)).toMatchObject({ status: "gated", invocation: "caller" });
    }
  });
});
