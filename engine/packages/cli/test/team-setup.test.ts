import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProgram } from "../src/index.js";
import { teamCommand, type TeamStartDeps } from "../src/commands/team.js";

/**
 * U3 — `rig team create <repository>`.
 *
 * The verb only carries the owner's choice: which clients the seats run and which repository
 * the team works on. The daemon owns the seats and their names, so what matters here is the
 * body that travels, the credential that authenticates it, and the next command it prints.
 */

const team = { id: "rig-1", name: "project", repository: "/work/project", seats: [
  { role: "lead", client: "claude-code" }, { role: "implementer", client: "claude-code" },
  { role: "implementer", client: "codex" }, { role: "reviewer", client: "claude-code" } ] };

function deps(fetchImpl: typeof fetch, ownerToken: string | null = "owner-token"): TeamStartDeps {
  return { ownerToken, baseUrl: "http://127.0.0.1:7433", fetchImpl: ((url, init) =>
    String(url).endsWith("/healthz") ? Promise.resolve(new Response("{}", { status: 200 })) : fetchImpl(url, init)) as typeof fetch };
}

async function run(argv: string[], createDeps: TeamStartDeps): Promise<{ lines: string[]; code: number | undefined }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = createProgram({ teamStartDeps: createDeps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", ...argv]);
    return { lines, code: process.exitCode };
  } catch (thrown) {
    const error = thrown as Error & { code?: string };
    if (["team_client_invalid", "team_options_conflict", "team_repository_unreadable"].includes(error.code ?? "")) throw thrown;
    return { lines: [...lines, error.message, error.code ?? ""], code: process.exitCode ?? 1 };
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = saved;
  }
}

const accepted = (body: unknown = { protocolVersion: "1.0", team }) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 201 })) as unknown as typeof fetch;

afterEach(() => { vi.restoreAllMocks(); });

describe("rig team create", () => {
  const preview = { repository: "/work/new-project", name: "new-project", action: "create", fileCount: 3, excludedPaths: [".env", ".ssh/"] };
  const project = { ...team, repository: preview.repository, name: preview.name, seats: [{ role: "lead", client: "claude-code" }] };
  const projectFetch = () => vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(body.dryRun ? { protocolVersion: "1.0", preview: { ...preview, repository: body.repository } }
      : { protocolVersion: "1.0", team: project }), { status: body.dryRun ? 200 : 201 });
  }) as unknown as typeof fetch;

  it("previews and confirms a named project without sending the old default seats", async () => {
    const fetchImpl = projectFetch();
    const result = await run(["team", "create", preview.repository, "--name", preview.name, "--yes"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls.map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { repository: preview.repository, name: preview.name, dryRun: true },
      { repository: preview.repository, name: preview.name },
    ]);
    expect(result.lines.join("\n")).toContain("3 files");
    expect(result.lines.join("\n")).toContain("private GitHub repository");
    expect(result.lines.join("\n")).toContain(".env");
    expect(result.lines.join("\n")).toContain('Next: rig team start "<goal>" --rig new-project --planning');
  });

  it("resolves a missing relative folder lexically for a named project", async () => {
    const fetchImpl = projectFetch();
    const result = await run(["team", "create", "missing-project-fixture", "--name", preview.name, "--dry-run", "--json"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    expect(JSON.parse(result.lines[0]!)).toMatchObject({ repository: resolve("missing-project-fixture"), fileCount: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shows a preview without uploading when a noninteractive call has not confirmed it", async () => {
    const fetchImpl = projectFetch();
    expect(process.stdin.isTTY).not.toBe(true);
    const result = await run(["team", "create", preview.repository, "--name", preview.name], deps(fetchImpl));
    expect(result.lines.join("\n")).toContain("--yes");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects mixing named-project creation with manual seats", async () => {
    const fetchImpl = projectFetch();
    await expect(run(["team", "create", preview.repository, "--name", preview.name, "--lead", "codex"], deps(fetchImpl)))
      .rejects.toMatchObject({ code: "team_options_conflict" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("creates the default seats for the repository and prints the command that starts it", async () => {
    const fetchImpl = accepted();
    const result = await run(["team", "create", "/work/project"], deps(fetchImpl));

    expect(result.code).toBeUndefined();
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7433/api/team-control/teams");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer owner-token");
    expect(JSON.parse(String(init.body))).toEqual({ repository: "/work/project", seats: [
      { role: "lead", client: "claude-code" }, { role: "implementer", client: "claude-code" },
      { role: "implementer", client: "codex" }, { role: "reviewer", client: "claude-code" } ] });
    expect(result.lines).toContain("Team project");
    expect(result.lines).toContain("Repository: /work/project");
    expect(result.lines).toContain("  implementer  codex");
    expect(result.lines.join("\n")).toContain('Next: rig team start "<goal>" --rig project');
  });

  it("accepts claude as the shorthand for claude-code and a comma-separated implementer list", async () => {
    const fetchImpl = accepted();
    const result = await run(["team", "create", "/work/project", "--lead", "claude",
      "--implementers", "codex, claude", "--reviewer", "codex"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1];
    expect(JSON.parse(String(init.body))).toMatchObject({ seats: [
      { role: "lead", client: "claude-code" }, { role: "implementer", client: "codex" },
      { role: "implementer", client: "claude-code" }, { role: "reviewer", client: "codex" } ] });
  });

  it("makes a relative repository path absolute before it sends it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rig-team-create-"));
    try {
      const fetchImpl = accepted();
      const result = await run(["team", "create", directory], deps(fetchImpl));
      expect(result.code).toBeUndefined();
      const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1];
      expect(JSON.parse(String(init.body)).repository).toBe(realpathSync(directory));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("refuses a relative path it cannot read, before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(run(["team", "create", "does-not-exist-anywhere"], deps(fetchImpl)))
      .rejects.toMatchObject({ code: "team_repository_unreadable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a client it cannot launch before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(run(["team", "create", "/work/project", "--lead", "gpt"], deps(fetchImpl)))
      .rejects.toMatchObject({ code: "team_client_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an empty implementer list before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(run(["team", "create", "/work/project", "--implementers", " , "], deps(fetchImpl)))
      .rejects.toMatchObject({ code: "team_client_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints the daemon's team as JSON, without any seat name of its own", async () => {
    const result = await run(["team", "create", "/work/project", "--json"], deps(accepted()));
    expect(result.code).toBeUndefined();
    expect(JSON.parse(result.lines[0]!)).toEqual(team);
  });

  it("refuses to create without an owner credential, before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await run(["team", "create", "/work/project"], deps(fetchImpl, null));
    expect(result.code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.lines.join("\n")).toMatch(/no owner credential.*Run \.\/setup\.sh/);
  });

  it("reports the daemon's refusal with its own reason instead of a team", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "team_exists",
      error: "The repository /work/project already has a team, rig \"project\"." }), { status: 409 })) as unknown as typeof fetch;
    const result = await run(["team", "create", "/work/project"], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("the team was refused: The repository /work/project already has a team");
    expect(result.lines.join("\n")).not.toContain("rig team start");
  });
});

describe("team command registration", () => {
  it("registers `rig team create` with the repository argument and the seat clients", () => {
    const command = teamCommand(deps(vi.fn() as unknown as typeof fetch));
    const create = command.commands.find(entry => entry.name() === "create")!;
    expect(create.registeredArguments.map(argument => argument.name())).toEqual(["repository"]);
    expect(create.options.map(option => option.long)).toEqual(["--name", "--dry-run", "--yes", "--lead", "--implementers", "--reviewer", "--json"]);
  });
});
