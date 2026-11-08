import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FRAMEWORK_CATALOG, FRAMEWORK_PIN } from "../../src/integrations/framework/catalog.js";

export function writeFrameworkFixture(root: string): void {
  const files: Record<string, { sha256: string }> = {};
  for (const entry of FRAMEWORK_CATALOG) {
    for (const [path, content] of [[entry.sourcePath, `# ${entry.name}\nRead references/check.md.\n`],
      [`skills/${entry.name}/references/check.md`, "Check the caller's real capabilities before effects.\n"]]) {
      mkdirSync(dirname(join(root, path!)), { recursive: true });
      writeFileSync(join(root, path!), content!);
      files[path!] = { sha256: createHash("sha256").update(content!).digest("hex") };
    }
  }
  writeFileSync(join(root, ".framework-receipt.json"), JSON.stringify({ revision: FRAMEWORK_PIN.revision, files }));
}
