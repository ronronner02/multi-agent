// Test suite for plugin-primitive Phase 3a slice 3.1 — projection planner
// plugin path semantics. Per velocity-guard cadence boundary (b)
// 2026-05-10: tests for ~, absolute, relative path resolution before
// any further impl on this surface.
//
// Plugin source.path can take four shapes:
//   1. absolute system path  e.g.  /Users/op/.multi-agent/plugins/multi-agent-core
//   2. tilde-home-prefixed   e.g.  ~/.multi-agent/plugins/multi-agent-core
//   3. daemon home  e.g.  multi-agent-home:plugins/multi-agent-core
//   4. relative to spec dir  e.g.  ./plugins/multi-agent-core
//
// Each must resolve to a single concrete absolute entry.absolutePath the
// adapter can use to copy the plugin tree. Tilde expansion is required
// because vendored plugins live at ~/.multi-agent/plugins/<id>/ by convention
// and operators write that literal path in their agent.yaml resources.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { normalizeAgentSpec, parseAgentSpec } from "../src/domain/agent-manifest.js";
import { planProjection, type ProjectionInput, type ProjectionFsOps } from "../src/domain/projection-planner.js";
import type { ResolvedNodeConfig, QualifiedResource, ResolvedResources } from "../src/domain/profile-resolver.js";

function emptyResources(): ResolvedResources {
  return { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] };
}

function makePluginQR(id: string, path: string, sourcePath = "/specs/test-agent"): QualifiedResource {
  return {
    effectiveId: id,
    sourceSpec: "test-agent",
    sourcePath,
    resource: { id, source: { kind: "local", path } } as QualifiedResource["resource"],
  };
}

function makeConfig(plugins: QualifiedResource[]): ResolvedNodeConfig {
  return {
    runtime: "claude-code",
    model: undefined,
    cwd: "/runtime/agent-cwd",
    restorePolicy: "resume_if_possible",
    lifecycle: undefined,
    selectedResources: { ...emptyResources(), plugins },
    startup: { files: [], actions: [] },
    resolvedSpecName: "test-agent",
    resolvedSpecVersion: "1.0",
    resolvedSpecHash: "deadbeef",
  };
}

function mockFs(): ProjectionFsOps {
  return {
    readFile: () => { throw new Error("not used"); },
    exists: () => false,
  };
}

describe("Projection planner — plugin path semantics", () => {
  it("resolves the shipped shared agent's core plugin under the configured Multi-Agent home", async () => {
    const home = mkdtempSync(nodePath.join(os.tmpdir(), "builtin-plugin-home-"));
    vi.stubEnv("MULTI_AGENT_HOME", home);
    vi.resetModules();
    try {
      const sourcePath = nodePath.resolve(import.meta.dirname, "../specs/agents/shared");
      const spec = normalizeAgentSpec(parseAgentSpec(readFileSync(nodePath.join(sourcePath, "agent.yaml"), "utf8")));
      const config = makeConfig(spec.resources.plugins.map(resource => ({
        effectiveId: resource.id, sourceSpec: spec.name, sourcePath, resource,
      })));
      const { planProjection: configuredPlan } = await import("../src/domain/projection-planner.js");
      const result = configuredPlan({ config, collisions: [], fsOps: mockFs() });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.plan.entries).toMatchObject([{
          category: "plugin", effectiveId: "multi-agent-core",
          absolutePath: nodePath.join(home, "plugins/multi-agent-core"),
        }]);
      }
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["MULTI_AGENT_HOME"])("resolves multi-agent-home: from configured %s, not later shell values", async key => {
    const config = makeConfig([makePluginQR("multi-agent-core", "multi-agent-home:plugins/multi-agent-core")]);
    vi.stubEnv("MULTI_AGENT_HOME", "");
    vi.stubEnv(key, "/isolated/daemon-home");
    vi.resetModules();
    try {
      const { planProjection: configuredPlan } = await import("../src/domain/projection-planner.js");
      vi.stubEnv("MULTI_AGENT_HOME", "/wrong-shell-home");
      vi.stubEnv("HOME", "/wrong-user-home");
      const result = configuredPlan({ config, collisions: [], fsOps: mockFs() });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.plan.entries[0]!.absolutePath).toBe("/isolated/daemon-home/plugins/multi-agent-core");
        expect(result.plan.entries[0]!.resourcePath).toBe("multi-agent-home:plugins/multi-agent-core");
      }
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });

  it("rejects an absolute suffix in the home-relative form", () => {
    const result = planProjection({ config: makeConfig([makePluginQR("p", "multi-agent-home:/elsewhere")]), collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('Plugin "p": multi-agent-home: requires a relative path.');
  });

  // ============================================================
  // Absolute paths — preserved exactly
  // ============================================================

  it("absolute plugin source.path yields entry.absolutePath = same absolute path", () => {
    const config = makeConfig([makePluginQR("multi-agent-core", "/Users/op/.multi-agent/plugins/multi-agent-core")]);
    const input: ProjectionInput = { config, collisions: [], fsOps: mockFs() };
    const result = planProjection(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const pluginEntry = result.plan.entries.find((e) => e.category === "plugin");
      expect(pluginEntry).toBeDefined();
      expect(pluginEntry!.absolutePath).toBe("/Users/op/.multi-agent/plugins/multi-agent-core");
      expect(pluginEntry!.resourcePath).toBe("/Users/op/.multi-agent/plugins/multi-agent-core");
    }
  });

  it("absolute path is NOT re-resolved against spec sourcePath", () => {
    const config = makeConfig([makePluginQR("p", "/abs/plugin", "/some/other/spec/dir")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries[0]!;
      expect(entry.absolutePath).toBe("/abs/plugin");
      // Specifically should NOT be /some/other/spec/dir/abs/plugin
      expect(entry.absolutePath).not.toMatch(/^\/some\/other\/spec\/dir/);
    }
  });

  // ============================================================
  // Tilde-home-prefixed paths — expanded to $HOME
  // ============================================================

  it("tilde-prefixed plugin source.path expands to $HOME absolute path", () => {
    const config = makeConfig([makePluginQR("multi-agent-core", "~/.multi-agent/plugins/multi-agent-core")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries[0]!;
      const expectedAbs = nodePath.join(os.homedir(), ".multi-agent/plugins/multi-agent-core");
      expect(entry.absolutePath).toBe(expectedAbs);
      expect(entry.absolutePath).not.toMatch(/^~/);
    }
  });

  it("bare tilde plugin source.path expands to $HOME exactly", () => {
    const config = makeConfig([makePluginQR("home-plugin", "~")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.absolutePath).toBe(os.homedir());
    }
  });

  it("tilde-with-username (~user/...) is preserved as-is (NOT expanded — operator path)", () => {
    // Per Node's nodePath behavior: only ~/ (with slash) expands; ~user/ doesn't.
    // We follow the same convention to avoid surprising operators with implicit lookups.
    const config = makeConfig([makePluginQR("p", "~bob/plugins/p")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // ~bob is treated as a relative path component → joined with sourcePath
      const entry = result.plan.entries[0]!;
      expect(entry.absolutePath).toContain("~bob");
    }
  });

  // ============================================================
  // Relative paths — resolved against spec sourcePath
  // ============================================================

  it("relative plugin source.path resolves against qr.sourcePath", () => {
    const config = makeConfig([makePluginQR("local-plugin", "plugins/local-plugin", "/specs/my-agent")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.absolutePath).toBe("/specs/my-agent/plugins/local-plugin");
    }
  });

  it("./-prefixed relative plugin source.path resolves correctly", () => {
    const config = makeConfig([makePluginQR("local", "./plugins/local", "/specs/my-agent")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.absolutePath).toBe("/specs/my-agent/plugins/local");
    }
  });

  // ============================================================
  // Drift discriminator — distinct values per layer (per banked
  // feedback_poc_regression_must_discriminate)
  // ============================================================

  it("three plugins with three different path shapes produce distinct absolutePaths (drift discriminator)", () => {
    const config = makeConfig([
      makePluginQR("abs-plugin", "/abs/plugins/abs-plugin", "/specs/agent-X"),
      makePluginQR("home-plugin", "~/.multi-agent/plugins/home-plugin", "/specs/agent-X"),
      makePluginQR("rel-plugin", "plugins/rel-plugin", "/specs/agent-X"),
    ]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = new Map(result.plan.entries.map((e) => [e.effectiveId, e.absolutePath]));
      expect(byId.get("abs-plugin")).toBe("/abs/plugins/abs-plugin");
      expect(byId.get("home-plugin")).toBe(nodePath.join(os.homedir(), ".multi-agent/plugins/home-plugin"));
      expect(byId.get("rel-plugin")).toBe("/specs/agent-X/plugins/rel-plugin");
      // All three distinct
      expect(new Set(Array.from(byId.values())).size).toBe(3);
    }
  });

  // ============================================================
  // Plugin entry shape preserved through planner
  // ============================================================

  it("plugin entry preserves category 'plugin' and effectiveId through planner", () => {
    const config = makeConfig([makePluginQR("multi-agent-core", "/p/multi-agent-core")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries.find((e) => e.category === "plugin");
      expect(entry).toBeDefined();
      expect(entry!.effectiveId).toBe("multi-agent-core");
      expect(entry!.sourceSpec).toBe("test-agent");
    }
  });

  it("entries are deterministically sorted: plugin (p) sorts before skill (s)", () => {
    const config: ResolvedNodeConfig = {
      ...makeConfig([makePluginQR("z-plugin", "/p/z")]),
      selectedResources: {
        ...emptyResources(),
        skills: [{
          effectiveId: "a-skill",
          sourceSpec: "test-agent",
          sourcePath: "/specs/test-agent",
          resource: { id: "a-skill", path: "skills/a" } as QualifiedResource["resource"],
        }],
        plugins: [makePluginQR("z-plugin", "/p/z")],
      },
    };
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // p < s alphabetically; plugin entry comes first
      expect(result.plan.entries[0]!.category).toBe("plugin");
      expect(result.plan.entries[1]!.category).toBe("skill");
    }
  });
});
