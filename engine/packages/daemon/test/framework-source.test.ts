import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FRAMEWORK_CATALOG } from "../src/integrations/framework/catalog.js";
import { frameworkInstructionSources, installPinnedFramework, localFrameworkRoot, verifyFrameworkSource } from "../src/integrations/framework/source.js";
import { writeFrameworkFixture } from "./helpers/framework-source.js";

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "workflow-source-")); roots.push(root); writeFrameworkFixture(root); return root; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("complete pinned workflow source", () => {
  it("resolves all catalog entries and their governor from canonical source, without a per-attempt package copy", () => {
    const root = fixture();
    for (const entry of FRAMEWORK_CATALOG) {
      expect(frameworkInstructionSources(root, entry.name)).toContainEqual({ path: entry.sourcePath, source: join(root, entry.sourcePath) });
    }
  });
  it("rejects a changed supporting reference, not just a changed entry file", () => {
    const root = fixture();
    writeFileSync(join(root, "skills/spec-work/references/check.md"), "substituted instructions");
    expect(() => verifyFrameworkSource(root)).toThrow(/bytes differ/);
  });
  it("rejects extra files and symlink substitutions", () => {
    const root = fixture();
    symlinkSync(join(root, "skills/spec-work/SKILL.md"), join(root, "unexpected.md"));
    expect(() => verifyFrameworkSource(root)).toThrow(/link/);
  });
  it("keeps legacy unconfigured launches compatible but blocks an explicit workflow without source", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-empty-")); roots.push(root);
    expect(frameworkInstructionSources(root)).toEqual([]);
    expect(() => frameworkInstructionSources(root, "spec-work")).toThrow();
  });
  it("reuses an explicitly configured verified source without changing the installation", () => {
    const root = fixture(); vi.stubEnv("MULTI_AGENT_FRAMEWORK_ROOT", root);
    expect(localFrameworkRoot("/unused-home")).toBe(root);
    expect(installPinnedFramework("/unused-home")).toBe(root);
  });
  it("rejects relative configuration and unverified nonempty destinations", () => {
    vi.stubEnv("MULTI_AGENT_FRAMEWORK_ROOT", "./relative");
    expect(() => localFrameworkRoot("/home")).toThrow(/absolute/);
    const root = mkdtempSync(join(tmpdir(), "workflow-existing-")); roots.push(root);
    writeFileSync(join(root, "owner-file"), "preserve");
    vi.stubEnv("MULTI_AGENT_FRAMEWORK_ROOT", root);
    expect(() => installPinnedFramework("/unused")).toThrow(/unverified/);
  });
});
