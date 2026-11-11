import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { type TeamStartDeps } from "../src/commands/team.js";
import { runProgram } from "../src/cli-error.js";

function deps(fetchImpl: typeof fetch, ownerToken: string | null = "owner-github-fixture"): TeamStartDeps {
  return { ownerToken, baseUrl: "http://127.0.0.1:7433", fetchImpl: ((url, init) =>
    String(url).endsWith("/healthz") ? Promise.resolve(new Response("{}", { status: 200 })) : fetchImpl(url, init)) as typeof fetch };
}

async function run(options: string[], githubDeps: TeamStartDeps) {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    await runProgram(createProgram({ githubDeps }), ["node", "rig", "github", "status", ...options],
      { out: line => lines.push(line), err: line => lines.push(line), exit: code => { process.exitCode = code; } });
    return { lines, code: process.exitCode };
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = saved;
  }
}

const response = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
afterEach(() => vi.restoreAllMocks());

describe("rig github status", () => {
  it("uses the owner-authenticated daemon route and prints the login", async () => {
    const fetchImpl = response({ signedIn: true, login: "octocat", host: "github.com" });
    const result = await run([], deps(fetchImpl));
    expect(result.code ?? 0).toBe(0);
    expect(result.lines).toEqual(["Signed in to github.com as octocat."]);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:7433/api/team-control/github/status",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({
        Authorization: "Bearer owner-github-fixture",
      }) }));
  });

  it("returns a nonzero status when signed out", async () => {
    const result = await run([], deps(response({ signedIn: false, login: null, host: "github.com" })));
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(["Not signed in to GitHub."]);
  });

  it("prints only status fields in JSON mode", async () => {
    const result = await run(["--json"], deps(response({
      signedIn: true, login: "octocat", host: "github.com", token: "ghp_fixture_DO_NOT_EXPOSE",
    })));
    expect(JSON.parse(result.lines[0])).toEqual({ signedIn: true, login: "octocat", host: "github.com" });
  });

  it("requests no route without an owner credential", async () => {
    const fetchImpl = response({});
    const result = await run([], deps(fetchImpl, null));
    expect(result.code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.lines.join(" ")).toContain("No owner credential");
  });

  it.each([401, 403, 503])("handles HTTP %s without printing raw daemon errors", async status => {
    const result = await run([], deps(response({ code: "github_cli_missing", error: "ghp_fixture_DO_NOT_EXPOSE" }, status)));
    expect(result.code).toBe(1);
    expect(result.lines.join(" ")).not.toContain("ghp_fixture");
  });

  it("handles a failed daemon request without printing its exception", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ghp_fixture_DO_NOT_EXPOSE"); }) as unknown as typeof fetch;
    const result = await run([], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join(" ")).toContain("Check that the daemon is running");
    expect(result.lines.join(" ")).not.toContain("ghp_fixture");
  });
});
