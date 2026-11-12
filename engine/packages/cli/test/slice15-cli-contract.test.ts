import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/index.js";
import { runProgram } from "../src/cli-error.js";

async function runCli(args: string[]) {
  const out: string[] = [], err: string[] = [];
  let exitCode = 0;
  await runProgram(createProgram(), ["node", "multi-agent", ...args], {
    out: line => out.push(line), err: line => err.push(line), exit: code => { exitCode = code; },
  });
  return { out: out.join("\n"), err: err.join("\n"), exitCode };
}
afterEach(() => { process.exitCode = undefined; });

describe("shared CLI error path", () => {
  it("under --json, a validation failure emits a parseable JSON error object + nonzero exit", async () => {
    const result = await runCli(["team", "start", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: { code: "commander.missingArgument" } });
  });
  it("without --json, the same failure is plain text on stderr (no JSON on stdout) + nonzero exit", async () => {
    const result = await runCli(["team", "start"]);
    expect(result.exitCode).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/missing required argument/);
  });
  it("the error path is shared across command families", async () => {
    const result = await runCli(["github", "status", "--json", "--no-such-flag"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: { code: "commander.unknownOption" } });
  });
  it("--help passes through cleanly (exit 0, no error object)", async () => {
    expect((await runCli(["--help"])).exitCode).toBe(0);
  });
});
