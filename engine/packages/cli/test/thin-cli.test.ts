import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { DaemonClient } from "../src/client.js";
import { runProgram } from "../src/cli-error.js";
import * as localOrigin from "../src/local-origin.js";

const baseUrl = "http://127.0.0.1:27451";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function run(args: string[], fetchImpl: typeof fetch) {
  const out: string[] = [], err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => out.push(args.join(" ")));
  let code = 0;
  try {
    await runProgram(createProgram({ teamStartDeps: { baseUrl, fetchImpl, ownerToken: "owner" },
      daemonHttpDeps: { baseUrl, fetchImpl } }), ["node", "rig", ...args], {
      out: line => out.push(line), err: line => err.push(line), exit: value => { code = value; },
    });
    return { out, err, code };
  } finally { log.mockRestore(); }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); process.exitCode = undefined; });

describe("thin CLI surface", () => {
  it("lists exactly the retained command families and verbs", () => {
    const program = createProgram();
    expect(program.commands.map(command => command.name())).toEqual(["team", "daemon", "github"]);
    expect(program.commands[0]!.commands.map(command => command.name()).sort())
      .toEqual(["approve", "chat", "create", "diff", "merge", "result", "start"]);
    expect(program.commands[1]!.commands.map(command => command.name())).toEqual(["start", "stop", "status"]);
    expect(program.commands[2]!.commands.map(command => command.name())).toEqual(["status", "sign-in"]);
    expect(program.helpInformation()).not.toMatch(/terminal|config|queue|up|scope/);
  });
  it("returns Commander's normal unknown-command error for a removed command", async () => {
    const fetchImpl = vi.fn();
    const result = await run(["config", "get", "daemon.port", "--json"], fetchImpl);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({ error: { code: "commander.unknownCommand" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reads daemon status using HTTP alone", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "ok", pid: 123 }));
    const result = await run(["daemon", "status", "--json"], fetchImpl);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0]!)).toEqual({ status: "ok", pid: 123 });
    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(baseUrl + "/healthz", expect.objectContaining({ method: "GET" }));
  });
  it.each([false, true])("round-trips a Windows repository path (named=%s)", async named => {
    const repository = "D:\\work projects\\demo";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/healthz")) return json({ status: "ok" });
      const body = JSON.parse(String(init?.body));
      expect(body.repository).toBe(repository);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner");
      return named ? json({ preview: { repository, name: "demo", action: "create", fileCount: 1, excludedPaths: [] } })
        : json({ team: { id: "team", name: "demo", repository, seats: [] } }, 201);
    });
    const result = await run(["team", "create", repository, ...(named ? ["--name", "demo", "--dry-run"] : []), "--json"], fetchImpl as typeof fetch);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0]!).repository).toBe(repository);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([baseUrl + "/healthz", baseUrl + "/api/team-control/teams"]);
  });
  it.each(["start", "chat", "approve", "merge", "result"])("surfaces an auth failure for team %s without retry", async command => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/healthz") ? json({})
      : json({ code: "owner_control_required", error: "The owner credential was refused." }, 401));
    const result = await run(["team", command, "run", "--json"], fetchImpl as typeof fetch);
    expect(result.code).toBe(1);
    expect(fetchImpl.mock.calls).toHaveLength(2);
    expect(JSON.parse(result.out[0]!)).toMatchObject({ error: { code: "owner_control_required" } });
  });
  it("never reads the local identity database for an owner command", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "worker@team");
    vi.stubEnv("OPENRIG_URL", baseUrl);
    const origin = vi.spyOn(localOrigin, "readLocalOrigin").mockImplementation(() => { throw new Error("No database reads allowed"); });
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/healthz") ? json({})
      : json({ result: { schema: "multi-agent-team-result/v1" } }));
    const output = await run(["team", "result", "run", "--task", "task"], fetchImpl as typeof fetch);
    expect(output.code).toBe(0);
    expect(origin).not.toHaveBeenCalled();
  });
  it("reads a finished result without inspecting its repository", async () => {
    const result = { schema: "multi-agent-team-result/v1", taskId: "task", patch: "patch bytes", repositoryRoot: "Z:\\unmounted" };
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/healthz") ? json({}) : json({ result }));
    const output = await run(["team", "result", "run", "--task", "task"], fetchImpl as typeof fetch);
    expect(output.code).toBe(0);
    expect(JSON.parse(output.out[0]!)).toEqual(result);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([baseUrl + "/healthz", baseUrl + "/api/team-control/runs/run/tasks/task/result"]);
  });
});

describe("HTTP readiness", () => {
  it("waits for a starting listener before the command is sent", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ status: "ok" }));
    const ready = new DaemonClient(baseUrl, { fetchImpl }).waitForReady();
    await vi.advanceTimersByTimeAsync(200);
    expect((await ready).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("fails a stopped daemon within the bounded readiness window", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); });
    const ready = new DaemonClient(baseUrl, { fetchImpl }).waitForReady().catch(error => error);
    await vi.advanceTimersByTimeAsync(800);
    expect(await ready).toMatchObject({ causeCode: "ECONNREFUSED" });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
  it("never retries a health authentication failure", async () => {
    const fetchImpl = vi.fn(async () => json({ code: "control_auth_required", error: "Unauthorized" }, 401));
    await expect(new DaemonClient(baseUrl, { fetchImpl }).waitForReady()).rejects.toMatchObject({ code: "control_auth_required" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
