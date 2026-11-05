import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TeamSeatInput } from "../../../packages/daemon/src/domain/team-setup.js";

/**
 * C4 acceptance rework run — the demo repositories and the two seats that work on them.
 *
 * A fresh `git init` whose `plan.md` states one helper and its acceptance list. The
 * repository already carries one helper and its test, so `npm test` is a real, green suite
 * before the run starts. Two variants exist because the run needed a second fresh task:
 *
 * - `truncate` (the run's first task) — a character is a Unicode code point, not a UTF-16
 *   code unit.
 * - `format-bytes` (the run's second task) — the unit a size is reported in is chosen from
 *   the value *after* rounding, not before.
 *
 * Neither variant's seeded suite covers its own helper: the run's task is to implement it,
 * and the review is what checks the plan's clauses.
 *
 * Usage, from `engine/` after `npm run build`:
 *   npx tsx demo/team/scripts/acceptance-rework-seed.ts [--task truncate|format-bytes] <target>
 *   npx tsx demo/team/scripts/acceptance-rework-seed.ts --seats <repository> [rig-name]
 */

export const REWORK_RIG_NAME = "rework";

/**
 * The two seats the rework run uses. There is no lead: the lead protocol is already proven.
 *
 * A seat name is a tmux session name, so it has to be unique on the daemon, not only within its
 * rig. `createTeam` derives it from the role, its index and the rig name, so two rigs cannot
 * register the same seat — the C4 acceptance run once found two live seats called `impl@rework`
 * and the dispatcher refused the launch.
 */
export function reworkSeats(): readonly TeamSeatInput[] {
  return [
    { role: "implementer", client: "claude-code" },
    { role: "reviewer", client: "claude-code" },
  ];
}

/** The seeded suite every variant shares: a real helper with real tests, and nothing else. */
const SHARED_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "text-helpers", version: "1.0.0", private: true, type: "module",
    scripts: { test: "node --test --test-reporter=spec 'test/*.test.mjs'" },
  }, null, 2) + "\n",
  "README.md": "# text-helpers\n\nSmall text helpers, one module and one test file each.\n",
  ".gitignore": "node_modules/\n",
  "src/joinLines.mjs": `/**
 * Join lines into one string, separated by a newline.
 *
 * An empty array is an empty string, and a single line is returned as it is.
 */
export function joinLines(lines) {
  if (!Array.isArray(lines)) throw new TypeError("joinLines expects an array of strings");
  for (const line of lines) {
    if (typeof line !== "string") throw new TypeError("joinLines expects an array of strings");
  }
  return lines.join("\\n");
}
`,
  "test/joinLines.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { joinLines } from "../src/joinLines.mjs";

test("joins lines with a newline", () => {
  assert.equal(joinLines(["a", "b"]), "a\\nb");
});

test("an empty list is an empty string", () => {
  assert.equal(joinLines([]), "");
});

test("a single line is returned unchanged", () => {
  assert.equal(joinLines(["only"]), "only");
});

test("a non-string member is refused", () => {
  assert.throws(() => joinLines(["a", 1]), TypeError);
});
`,
};

export const TASK_VARIANTS = {
  truncate: {
    plan: `# Text helpers

## Goal

Add one text helper to this repository, with its own test file.

The repository already contains \`src/joinLines.mjs\` and \`test/joinLines.test.mjs\`. That
helper is not part of this task.

## Task A — \`truncate(text, maxLength)\` in \`src/truncate.mjs\`

Return the first \`maxLength\` characters of \`text\`. A character is a Unicode code point, not a
UTF-16 code unit: a character outside the Basic Multilingual Plane (an emoji, for example)
counts as one character and is never split, so the result never ends with a lone surrogate.
Surrogate pairs inside the kept prefix are counted once each, and a string no longer than
\`maxLength\` characters is returned unchanged.

Acceptance:

- \`truncate("abcdef", 3)\` is \`"abc"\`
- \`truncate("abc", 5)\` is \`"abc"\` (a string no longer than \`maxLength\` is returned unchanged)
- \`truncate("abcdef", 0)\` is \`""\`
- a negative or non-integer \`maxLength\` throws a \`RangeError\`
- the input is never mutated

## Rules

- One test file: \`test/truncate.test.mjs\`.
- Use \`node:test\` and \`node:assert/strict\`. Do not add dependencies.
- \`npm test\` must pass.
`,
    taskId: "task-1",
  },
  "format-bytes": {
    plan: `# Text helpers

## Goal

Add one formatting helper to this repository, with its own test file.

The repository already contains \`src/joinLines.mjs\` and \`test/joinLines.test.mjs\`. That
helper is not part of this task.

## Task B — \`formatBytes(bytes)\` in \`src/formatBytes.mjs\`

Return a human-readable size for a count of bytes.

Below 1024 bytes the value is reported in bytes with no decimal point. At or above 1024 bytes
it is reported in binary units — \`KiB\`, \`MiB\`, \`GiB\`, \`TiB\` — to one decimal place, and a
trailing \`.0\` is dropped.

The unit is chosen from the value **after** rounding, not before. The value is rounded to one
decimal place in its unit; if that rounded value reaches 1024, the next unit is used instead
and the rounding is redone there.

Acceptance:

- \`formatBytes(0)\` is \`"0 B"\`
- \`formatBytes(512)\` is \`"512 B"\`
- \`formatBytes(1023)\` is \`"1023 B"\`
- \`formatBytes(1024)\` is \`"1 KiB"\`
- \`formatBytes(1536)\` is \`"1.5 KiB"\`
- \`formatBytes(1048576)\` is \`"1 MiB"\`
- a negative number, a non-integer, \`NaN\` or \`Infinity\` throws a \`RangeError\`

## Rules

- One test file: \`test/formatBytes.test.mjs\`.
- Use \`node:test\` and \`node:assert/strict\`. Do not add dependencies.
- \`npm test\` must pass.
`,
    taskId: "task-2",
  },
} as const;

export type TaskVariant = keyof typeof TASK_VARIANTS;

export function demoFiles(variant: TaskVariant): Record<string, string> {
  return { "plan.md": TASK_VARIANTS[variant].plan, ...SHARED_FILES };
}

export function seedRepository(target: string, variant: TaskVariant = "truncate"): { root: string; created: boolean } {
  const root = resolve(target);
  const created = !existsSync(join(root, ".git"));
  if (created) {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    for (const [path, content] of Object.entries(demoFiles(variant))) writeFileSync(join(root, path), content);
    for (const args of [["init", "-q", "--initial-branch=main"],
      ["config", "user.name", "C4 Demo"], ["config", "user.email", "demo@example.invalid"],
      ["add", "."], ["commit", "-qm", "text helpers: the plan and the package"]]) {
      execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    }
  }
  return { root, created };
}

/** The two seats as rows only: nothing is started here, exactly as a fresh install leaves it. */
export async function seedSeats(repository: string, rigName = REWORK_RIG_NAME): Promise<{ rigId: string; created: boolean }> {
  const { createDb } = await import("../../../packages/daemon/src/db/connection.js");
  const { migrate } = await import("../../../packages/daemon/src/db/migrate.js");
  const { ALL_MIGRATIONS } = await import("../../../packages/daemon/src/db/all-migrations.js");
  const { resolveDaemonDbPath } = await import("../../../packages/daemon/src/daemon-db-path.js");
  const { OPENRIG_HOME } = await import("../../../packages/cli/src/openrig-compat.js");
  const { RigRepository } = await import("../../../packages/daemon/src/domain/rig-repository.js");
  const { createTeam } = await import("../../../packages/daemon/src/domain/team-setup.js");
  const db = createDb(resolveDaemonDbPath(process.env.OPENRIG_DB, OPENRIG_HOME));
  try {
    migrate(db, ALL_MIGRATIONS);
    const existing = new RigRepository(db).findRigsByName(rigName)[0];
    if (existing) return { rigId: existing.id, created: false };
    const team = createTeam(db, { repository, name: rigName, seats: reworkSeats() });
    return { rigId: team.id, created: true };
  } finally {
    db.close();
  }
}

const invoked = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
if (invoked) {
  const args = process.argv.slice(2);
  if (args[0] === "--seats") {
    const repository = args[1];
    if (!repository) throw new Error("usage: acceptance-rework-seed.ts --seats <repository> [rig-name]");
    const rigName = args[2] ?? REWORK_RIG_NAME;
    const { rigId, created } = await seedSeats(repository, rigName);
    console.log(created ? `Created rig "${rigName}" (${rigId}).` : `Rig already exists (${rigId}); left alone.`);
    for (const seat of reworkSeats()) console.log(`  ${seat.role.padEnd(12)} ${seat.client}`);
  } else {
    let variant: TaskVariant = "truncate";
    let target = args[0] ?? "demo/team/rework-repository";
    if (args[0] === "--task") {
      variant = args[1] as TaskVariant;
      if (!(variant in TASK_VARIANTS)) throw new Error(`unknown task variant: ${variant}`);
      target = args[2] ?? "demo/team/rework-repository";
    }
    const { root, created } = seedRepository(target, variant);
    console.log(created ? `Created the ${variant} demo repository at ${root}.` : `Demo repository already exists at ${root}.`);
    console.log("Run its tests with: npm test");
  }
}
