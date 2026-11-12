import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const legacyNames = new RegExp(["open" + "rig", "rig" + "ged"].join("|"), "i");
const historicalRoots = [
  "docs/plans/", "docs/validation/", "docs/amendments/", "docs/tasks/",
  "engine/docs/as-built/", "engine/docs/releases/",
];
// Explicit third-party skill files whose source provenance is preserved verbatim.
const vendoredSkillAllowlist = new Map([
  ["engine/packages/daemon/specs/agents/shared/skills/process/agent-browser/SKILL.md", "vendored browser skill metadata"],
  [["engine", "packages", "daemon", "specs", "agents", "shared", "skills", "process", "agent-browser", "OPEN" + "RIG.md"].join("/"), "vendored browser companion provenance"],
  ["engine/packages/daemon/specs/agents/shared/skills/process/dogfood/SKILL.md", "vendored browser ecosystem metadata"],
  ["engine/packages/daemon/specs/agents/shared/skills/process/frontend-design/SKILL.md", "vendored frontend skill provenance"],
  ["engine/packages/daemon/specs/agents/shared/skills/process/systematic-debugging/SKILL.md", "vendored debugging skill metadata"],
  ["engine/packages/daemon/specs/agents/shared/skills/process/test-driven-development/SKILL.md", "vendored development skill metadata"],
  ["engine/packages/daemon/specs/agents/shared/skills/process/verification-before-completion/SKILL.md", "vendored verification skill metadata"],
  ["engine/skills/_canonical/process/agent-browser/SKILL.md", "canonical mirror of vendored browser metadata"],
  [["engine", "skills", "_canonical", "process", "agent-browser", "OPEN" + "RIG.md"].join("/"), "canonical mirror of vendored browser provenance"],
  ["engine/skills/_canonical/process/dogfood/SKILL.md", "canonical mirror of vendored browser metadata"],
  ["engine/skills/_canonical/process/frontend-design/SKILL.md", "canonical mirror of vendored frontend provenance"],
  ["engine/skills/_canonical/process/systematic-debugging/SKILL.md", "canonical mirror of vendored debugging metadata"],
  ["engine/skills/_canonical/process/test-driven-development/SKILL.md", "canonical mirror of vendored development metadata"],
  ["engine/skills/_canonical/process/verification-before-completion/SKILL.md", "canonical mirror of vendored verification metadata"],
  ["engine/scripts/skill-edge-digests.generated.json", "generated digest records a preserved companion path"],
]);

export function scanBrand(root) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  // Include new source files during an uncommitted rename as well as indexed files.
  const added = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "engine", "desktop", "scripts", ".github"],
    { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = [];
  for (const file of new Set([...tracked, ...added])) {
    if (historicalRoots.some(prefix => file.startsWith(prefix))
      || /changelog/i.test(basename(file)) || /^(LICENSE|NOTICE)(\..*)?$/i.test(basename(file))
      || vendoredSkillAllowlist.has(file)) continue;
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (legacyNames.test(line)) findings.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const findings = scanBrand(root);
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  } else console.log("Source brand scan passed.");
}
