import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { runProgram } from "../src/cli-error.js";

const baseUrl = "http://127.0.0.1:27452";
const pending = { state: "pending", code: "ABCD-EFGH", url: "https://github.com/login/device" };
const account = { signedIn: true, login: "octocat", host: "github.com" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function run(fetchImpl: typeof fetch, options: string[] = []) {
  const out: string[] = [], err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => out.push(args.join(" ")));
  let code = 0;
  try {
    await runProgram(createProgram({ githubDeps: { baseUrl, fetchImpl, ownerToken: "owner" } }),
      ["node", "rig", "github", "sign-in", ...options], {
        out: line => out.push(line), err: line => err.push(line), exit: value => { code = value; },
      });
    return { out, err, code };
  } finally { log.mockRestore(); }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); process.exitCode = undefined; });

describe("GitHub device sign-in", () => {
  it.each([false, true])("prints the device code, polls login, and confirms the account (json=%s)", async asJson => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/healthz")) return json({});
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner");
      if (url.endsWith("/status")) return json({ ...account, token: "do-not-print" });
      return json(init?.method === "POST" ? { ...pending, token: "do-not-print" } : { state: "done" });
    });
    const result = run(fetchImpl as typeof fetch, asJson ? ["--json"] : []);
    await vi.advanceTimersByTimeAsync(1000);
    const output = await result;
    expect(output.code).toBe(0);
    expect(output.out.join("\n")).toContain(pending.code);
    expect(output.out.join("\n")).toContain(pending.url);
    expect(output.out.join("\n")).toContain("octocat");
    expect(output.out.join("\n")).not.toContain("do-not-print");
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [baseUrl + "/healthz", "GET"], [baseUrl + "/api/team-control/github/login", "POST"],
      [baseUrl + "/api/team-control/github/login", "GET"], [baseUrl + "/api/team-control/github/status", "GET"],
    ]);
    if (asJson) expect(output.out.map(line => JSON.parse(line))).toEqual([pending, account]);
  });
  it("surfaces missing gh as the daemon's named error without polling", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/healthz") ? json({})
      : json({ code: "github_cli_missing", error: "GitHub CLI is not installed." }, 503));
    const output = await run(fetchImpl as typeof fetch, ["--json"]);
    expect(output.code).toBe(1);
    expect(JSON.parse(output.out[0]!)).toMatchObject({ error: { code: "github_cli_missing" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("reports an unsuccessful device flow without starting another login", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => url.endsWith("/healthz") ? json({})
      : json(init?.method === "POST" ? pending : { state: "failed", code: "github_login_failed" }));
    const result = run(fetchImpl as typeof fetch, ["--json"]);
    await vi.advanceTimersByTimeAsync(1000);
    const output = await result;
    expect(output.code).toBe(1);
    expect(JSON.parse(output.out.at(-1)!)).toMatchObject({ error: { code: "github_login_failed" } });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("does not retry an owner authentication failure", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/healthz") ? json({})
      : json({ code: "owner_control_required", error: "An authenticated owner is required." }, 401));
    const output = await run(fetchImpl as typeof fetch, ["--json"]);
    expect(output.code).toBe(1);
    expect(JSON.parse(output.out[0]!)).toMatchObject({ error: { code: "owner_control_required" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([["start", false], ["wait", false], ["poll", false], ["wait", true]] as const)(
    "cancels during %s, sends stop once, and removes its SIGINT listener (json=%s)", async (phase, asJson) => {
      vi.useFakeTimers();
      const listenersBefore = process.listenerCount("SIGINT");
      let activeSignal: AbortSignal | undefined;
      let releaseStop!: () => void;
      const stopping = new Promise<void>(resolve => { releaseStop = resolve; });
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/healthz")) return json({});
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner");
        if (url.endsWith("/login/stop")) {
          expect(init?.method).toBe("POST");
          expect(init?.signal?.aborted).toBe(false);
          await stopping;
          return json({ state: "idle" });
        }
        if (phase === "start" || (phase === "poll" && init?.method === "GET")) {
          activeSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            activeSignal!.addEventListener("abort", () => reject(activeSignal!.reason), { once: true });
          });
        }
        return json(pending);
      });
      const result = run(fetchImpl as typeof fetch, asJson ? ["--json"] : []);
      await vi.advanceTimersByTimeAsync(phase === "poll" ? 1000 : 0);
      expect(process.listenerCount("SIGINT")).toBe(listenersBefore + 1);
      process.emit("SIGINT");
      process.emit("SIGINT");
      await vi.advanceTimersByTimeAsync(0);
      process.emit("SIGINT");
      releaseStop();
      const output = await result;
      expect(output.code).toBe(1);
      if (asJson) expect(JSON.parse(output.out.at(-1)!)).toEqual({ ok: false,
        error: { code: "github_login_cancelled", message: "GitHub sign-in cancelled." } });
      else expect(output.err).toEqual(["error: GitHub sign-in cancelled."]);
      if (phase !== "wait") expect(activeSignal?.aborted).toBe(true);
      expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/login/stop"))).toHaveLength(1);
      expect(fetchImpl.mock.calls.some(([url]) => url.endsWith("/logout") || url.endsWith("/status"))).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
      expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("reports cancellation when stop fails without retrying or logging out (json=%s)", async asJson => {
    vi.useFakeTimers();
    const listenersBefore = process.listenerCount("SIGINT");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/healthz")) return json({});
      if (url.endsWith("/login/stop")) throw new Error("connection lost");
      return json(pending);
    });
    const result = run(fetchImpl as typeof fetch, asJson ? ["--json"] : []);
    await vi.advanceTimersByTimeAsync(0);
    process.emit("SIGINT");
    const output = await result;
    expect(output.code).toBe(1);
    const message = "GitHub sign-in cancelled; daemon login stop could not be confirmed.";
    if (asJson) expect(JSON.parse(output.out.at(-1)!)).toEqual({ ok: false, error: { code: "github_login_cancelled", message } });
    else expect(output.err).toEqual(["error: " + message]);
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/login/stop"))).toHaveLength(1);
    expect(fetchImpl.mock.calls.some(([url]) => url.endsWith("/logout"))).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
    expect(vi.getTimerCount()).toBe(0);
  });
});
