import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../src/index.js";
import { teamCommand, type TeamStartDeps } from "../src/commands/team.js";

/**
 * MVP slice 2 — `rig team start "<goal>"`.
 *
 * Drives the registered verb through the real Commander program, with the daemon answered by
 * an injected fetch. What matters is the contract with the endpoint: the goal and the named
 * options travel as one body, the owner credential authenticates it, and the printed run id is
 * the one the daemon returned.
 */

const receipt = { protocolVersion: "1.0", runId: "run-1", rigId: "rig", approvalId: "approval-1",
  taskId: "task-1", qitemId: "qitem-1", seat: "dev@demo", state: "approved" };

function deps(fetchImpl: typeof fetch, ownerToken: string | null = "owner-token"): TeamStartDeps {
  return { ownerToken, baseUrl: "http://127.0.0.1:7433", fetchImpl: ((url, init) =>
    String(url).endsWith("/healthz") ? Promise.resolve(new Response("{}", { status: 200 })) : fetchImpl(url, init)) as typeof fetch };
}

async function run(argv: string[], startDeps: TeamStartDeps): Promise<{ lines: string[]; code: number | undefined }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = createProgram({ teamStartDeps: startDeps });
    program.exitOverride();
    program.commands.find(command => command.name() === "team")!.commands
      .find(command => command.name() === "start")!;
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

afterEach(() => { vi.restoreAllMocks(); });

describe("rig team start", () => {
  it.each([false, true])("sends the selected workflow with read-only set to %s", async readOnly => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 }));
    const result = await run(["team", "start", "Inspect the current plan", "--workflow", "spec-plan",
      ...(readOnly ? ["--read-only"] : [])], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    expect(JSON.parse(String(init.body))).toEqual({ goal: "Inspect the current plan", workflow: { entrypoint: "spec-plan", readOnly } });
  });

  it("rejects --read-only without a selected workflow before contacting the daemon", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 }));
    const result = await run(["team", "start", "Inspect the current plan", "--read-only"], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("--read-only requires --workflow");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the goal with the named options and prints the run to watch", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 })) as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint", "--rig", "demo", "--seat", "dev@demo",
      "--repository", "/work/repo", "--plan", "docs/plan.md", "--write", "src", "docs"], deps(fetchImpl));

    expect(result.code).toBeUndefined();
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7433/api/team-control/runs");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer owner-token");
    expect(JSON.parse(String(init.body))).toEqual({ goal: "Add a health endpoint", rig: "demo", seat: "dev@demo",
      repository: { root: "/work/repo", planRef: "docs/plan.md" }, writePaths: ["src", "docs"] });
    expect(result.lines).toContain("Run:  run-1");
    expect(result.lines).toContain("Task: task-1 on dev@demo");
    expect(result.lines.join("\n")).toContain("http://127.0.0.1:7433/team?run=run-1");
  });

  it("names the reviewer seat so the run's review rounds have somewhere to go", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 })) as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint", "--seat", "dev@demo", "--reviewer", "rev@demo"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1];
    expect(JSON.parse(String(init.body))).toMatchObject({ seat: "dev@demo", reviewerSeat: "rev@demo" });
  });

  // C3 — the lead is opt-in, and a start with one points the owner at the proposal verb.
  it("names the lead seat and points at the team dashboard", async () => {
    const withLead = { ...receipt, leadSeat: "lead@demo" };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(withLead), { status: 201 })) as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint", "--lead", "lead@demo"], deps(fetchImpl));
    expect(result.code).toBeUndefined();
    const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1];
    expect(JSON.parse(String(init.body))).toEqual({ goal: "Add a health endpoint", lead: "lead@demo" });
    expect(result.lines.join("\n")).toContain("/team?run=run-1");
  });

  it("uses the owner token ./setup.sh wrote when this shell has none", async () => {
    // The README's quick start: start.sh loads owner.env into the daemon only, so a fresh
    // shell has the daemon running and no credential of its own.
    const configHome = mkdtempSync(join(tmpdir(), "mvp2-owner-"));
    mkdirSync(join(configHome, "multi-agent"));
    writeFileSync(join(configHome, "multi-agent", "owner.env"),
      "MULTI_AGENT_MODE=managed\nMULTI_AGENT_OWNER_TOKEN=token-from-owner-env\n");
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 201 })) as unknown as typeof fetch;
      const result = await run(["team", "start", "Add a health endpoint"], { ...deps(fetchImpl, null), ownerToken: undefined });
      expect(result.code).toBeUndefined();
      const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1];
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer token-from-owner-env");
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved;
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("refuses to start without an owner credential, before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint"], deps(fetchImpl, null));
    expect(result.code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.lines.join("\n")).toContain("no owner credential. Set MULTI_AGENT_OWNER_TOKEN or configure the owner token.");
  });

  it("reports the daemon's refusal instead of printing a run", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "start_refused", error: "Implementation approval is not active" }),
      { status: 409 })) as unknown as typeof fetch;
    const result = await run(["team", "start", "Add a health endpoint"], deps(fetchImpl));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toMatch(/the start was refused: Implementation approval is not active/);
    expect(result.lines.join("\n")).not.toMatch(/team\?run=/);
  });
});

describe("team command registration", () => {
  it("is reachable as `rig team start` and takes the goal as its one argument", () => {
    const command = teamCommand(deps(vi.fn() as unknown as typeof fetch));
    const start = command.commands.find(entry => entry.name() === "start")!;
    expect(start.description()).toMatch(/create a run and a task/);
    expect(start.registeredArguments.map(argument => argument.name())).toEqual(["goal"]);
  });
});
