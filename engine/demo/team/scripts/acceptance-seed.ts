import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * C4 acceptance — the demo repository the recorded run works on.
 *
 * A fresh `git init` with a plan whose goal needs two small implementer tasks and a test
 * command that runs without installing anything, so an owner can apply the run's result and
 * check it with one command. The plan states the acceptance text precisely, including the
 * edge cases a reviewer has something real to check against.
 *
 * Usage, from `engine/`: npx tsx demo/team/scripts/acceptance-seed.ts [target-directory]
 * Prints the repository path. An existing repository is left alone.
 */

export const DEMO_FILES: Record<string, string> = {
  "plan.md": `# Text helpers

## Goal

Add two small text helpers to this repository, each with its own test file.

## Task A — \`slugify(input)\` in \`src/slugify.mjs\`

Return a lowercase slug: every run of characters that is not a letter or digit becomes a
single \`-\`, leading and trailing separators are removed, and an input with no letters or
digits at all becomes an empty string. Diacritics are not transliterated; non-ASCII letters
are not letters for this helper.

Acceptance:

- \`slugify("Hello, World!")\` is \`"hello-world"\`
- \`slugify("  a  --  b  ")\` is \`"a-b"\` (a run of separators collapses to one, both ends are trimmed)
- \`slugify("!!!")\` is \`""\`
- \`slugify("a_b")\` is \`"a-b"\` (an underscore is a separator)
- the input is never mutated

## Task B — \`titleCase(input)\` in \`src/titleCase.mjs\`

Return \`input\` with the first letter of every word uppercased and every other letter left
exactly as it was. A word starts after any character that is not a letter or digit. Existing
capitals inside a word are preserved, so \`titleCase("iOS device")\` is \`"IOS Device"\` only
if the input already had them; do not lowercase anything.

Acceptance:

- \`titleCase("hello world")\` is \`"Hello World"\`
- \`titleCase("iOS device")\` is \`"IOS Device"\`
- \`titleCase("a-b c_d")\` is \`"A-B C_D"\`
- an empty string stays empty

## Rules

- One test file per helper: \`test/slugify.test.mjs\` and \`test/titleCase.test.mjs\`.
- Use \`node:test\` and \`node:assert/strict\`. Do not add dependencies.
- \`npm test\` must pass.
`,
  "package.json": JSON.stringify({
    name: "text-helpers", version: "1.0.0", private: true, type: "module",
    scripts: { test: "node --test --test-reporter=spec 'test/*.test.mjs'" },
  }, null, 2) + "\n",
  "README.md": "# text-helpers\n\nTwo small text helpers, one module and one test file each.\n",
  ".gitignore": "node_modules/\n",
};

export function seedRepository(target: string): { root: string; created: boolean } {
  const root = resolve(target);
  const created = !existsSync(join(root, ".git"));
  if (created) {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    for (const [path, content] of Object.entries(DEMO_FILES)) writeFileSync(join(root, path), content);
    for (const args of [["init", "-q", "--initial-branch=main"],
      ["config", "user.name", "C4 Demo"], ["config", "user.email", "demo@example.invalid"],
      ["add", "."], ["commit", "-qm", "text helpers: the plan and the package"]]) {
      execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    }
  }
  return { root, created };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").at(-1)!)) {
  const target = process.argv[2] ?? "demo/team/acceptance-repository";
  const { root, created } = seedRepository(target);
  console.log(created ? `Created the demo repository at ${root}.` : `Demo repository already exists at ${root}.`);
  console.log("Run its tests with: npm test");
}
