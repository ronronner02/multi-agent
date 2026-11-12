import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "../assets/plugins/multi-agent-core");
const EXPECTED_SKILLS = [
  "agent-operated-software",
  "agent-operated-workflows",
  "applying-a-permission-policy",
  "claude-compaction-restore",
  "delegating-work",
  "messaging-the-human",
  "software-for-agents",
];

describe("multi-agent-core plugin", () => {
  it("has both runtime manifests, the license, and the README", () => {
    expect(fs.existsSync(path.join(PLUGIN_ROOT, ".claude-plugin/plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(PLUGIN_ROOT, ".codex-plugin/plugin.json"))).toBe(true);
    expect(fs.readFileSync(path.join(PLUGIN_ROOT, "LICENSE"), "utf8")).toMatch(/Apache License/i);
    expect(fs.existsSync(path.join(PLUGIN_ROOT, "README.md"))).toBe(true);
  });

  it("ships exactly the retained native-team skill set", () => {
    const actual = fs.readdirSync(path.join(PLUGIN_ROOT, "skills")).filter((name) =>
      fs.statSync(path.join(PLUGIN_ROOT, "skills", name)).isDirectory() &&
      fs.existsSync(path.join(PLUGIN_ROOT, "skills", name, "SKILL.md")),
    ).sort();
    expect(actual).toEqual([...EXPECTED_SKILLS].sort());
    expect(fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8")).toContain(`Skills (${EXPECTED_SKILLS.length})`);
  });

  it.each(EXPECTED_SKILLS)("skill '%s' has valid frontmatter", (skillId) => {
    const content = fs.readFileSync(path.join(PLUGIN_ROOT, "skills", skillId, "SKILL.md"), "utf8");
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/^name: \S+/m);
    expect(content).toMatch(/^description:[\s\S]*?\n---/m);
  });

  it("keeps the retained activity and Claude compaction hooks wired to existing files", () => {
    const claude = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks/claude.json"), "utf8"));
    const codex = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks/codex.json"), "utf8"));
    const claudeText = JSON.stringify(claude);
    const codexText = JSON.stringify(codex);
    expect(claudeText).toContain("activity-relay.cjs");
    expect(codexText).toContain("activity-relay.cjs");
    expect(claudeText).toContain("compaction-restore-bridge.cjs");
    expect(fs.existsSync(path.join(PLUGIN_ROOT, "hooks/scripts/activity-relay.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(PLUGIN_ROOT, "hooks/scripts/compaction-restore-bridge.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(PLUGIN_ROOT, "skills/claude-compaction-restore/scripts/precompact-hook.mjs"))).toBe(true);
  });
});
