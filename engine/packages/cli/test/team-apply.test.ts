import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../src/index.js";
import type { TeamStartDeps } from "../src/commands/team.js";

// MVP slice 3 — `rig team apply` and `rig team diff` against a real temp repository.
//
// The daemon is answered by an injected fetch; everything below it is real git, so the
// assertions are about the bytes landing in a tree, not about a call being made. `apply` must
// refuse a dirty target tree, because `git apply` would otherwise mix the owner's uncommitted
// work into the result nobody can then separate.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(parent: string): string {
  const root = realpathSync(mkdtempSync(join(parent, "target-")));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  writeFileSync(join(root, "base.txt"), "base\n"); writeFileSync(join(root, "other.txt"), "other\n");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "base");
  return root;
}

const PATCH = ["diff --git a/base.txt b/base.txt", "--- a/base.txt", "+++ b/base.txt", "@@ -1 +1,2 @@",
  " base", "+applied", "diff --git a/added.txt b/added.txt", "new file mode 100644", "--- /dev/null",
  "+++ b/added.txt", "@@ -0,0 +1 @@", "+new file", ""].join("\n");


function deps(fetchImpl: typeof fetch): TeamStartDeps {
  return { ownerToken: "owner-token", baseUrl: "http://127.0.0.1:7433", fetchImpl: ((url, init) =>
    String(url).endsWith("/healthz") ? Promise.resolve(new Response("{}", { status: 200 })) : fetchImpl(url, init)) as typeof fetch };
}

/** A daemon that answers the run read and the result read; `status` lets a case drive a refusal. */
function daemon(overrides: { status?: number; result?: unknown } = {}) {
  const status = overrides.status ?? 200;
  const result = overrides.result ?? { schema: "multi-agent-team-result/v1", runId: "run", taskId: "task",
    attemptId: "attempt-1", repositoryRoot: "", base: "commit", baseIdentifier: "a".repeat(40),
    manifestDigest: "sha256:" + "b".repeat(64), files: [], patch: PATCH };
  return vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/read")
    // The run read always answers: a refusal here is about the result, not the run.
    ? { protocolVersion: "1.0", read: { tasks: [{ taskId: "task", role: "implementer" }] } }
    : status === 200 ? { protocolVersion: "1.0", result }
      : { code: "team_result_unfinished", error: "The task has no finished outcome." }),
  { status: url.endsWith("/read") ? 200 : status })) as unknown as typeof fetch;
}

async function run(argv: string[], teamDeps: TeamStartDeps): Promise<string[]> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = createProgram({ teamStartDeps: teamDeps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", ...argv]);
    return lines;
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = saved;
  }
}

/** The result the daemon serves for a repository at `root`. */
const at = (repositoryRoot: string) => ({ schema: "multi-agent-team-result/v1", runId: "run", taskId: "task",
  attemptId: "attempt-1", repositoryRoot, base: "commit", baseIdentifier: "a".repeat(40),
  manifestDigest: "sha256:" + "b".repeat(64), files: [], patch: PATCH });

let directory: string;
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "mvp3-apply-"))); });
afterEach(() => { vi.restoreAllMocks(); if (existsSync(directory)) rmSync(directory, { recursive: true, force: true }); });

describe("rig team diff", () => {
  it("prints the patch unchanged", async () => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      chunks.push(String(chunk)); return true;
    }) as typeof process.stdout.write);
    try { await run(["team", "diff", "run"], deps(daemon())); } finally { write.mockRestore(); }
    expect(chunks.join("")).toBe(PATCH);
  });
});
