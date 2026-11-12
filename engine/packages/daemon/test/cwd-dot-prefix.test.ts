import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathInsideRoot, getMultiAgentInstallCwdError } from "../src/domain/cwd-resolution.js";

describe("directory boundaries", () => {
  it("recognizes literal dot-prefixed descendants without admitting siblings", () => {
    const base = mkdtempSync(join(tmpdir(), "multi-agent-path-boundary-"));
    const root = join(base, "install");
    const inside = join(root, "..cache", "workspace");
    const sibling = join(base, "install-neighbor");
    mkdirSync(inside, { recursive: true });
    mkdirSync(sibling);
    try {
      expect(isPathInsideRoot(inside, root)).toBe(true);
      expect(getMultiAgentInstallCwdError(inside, undefined, root)).toContain("inside the Multi-Agent installation");
      expect(isPathInsideRoot(root, root)).toBe(true);
      expect(isPathInsideRoot(sibling, root)).toBe(false);
      expect(isPathInsideRoot(base, root)).toBe(false);
      expect(getMultiAgentInstallCwdError(inside, sibling, root)).toBeNull();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
