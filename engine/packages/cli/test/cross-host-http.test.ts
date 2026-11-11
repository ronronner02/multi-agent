// OPR.0.4.6.MH4 C4 — the http transport branch + §4 target-sugar/precedence
// matrix for the four cross-host coordination verbs. Everything runs through
// the shipped depsOverride injection (mock clientFactory + hostRegistryLoader
// + crossHostRun) — no daemon, no tmux, no network, no real ~/.openrig.
//
// The LOCAL zero-regression half lives in the existing suites (send.test.ts,
// capture.test.ts, transcript.test.ts, broadcast.test.ts run the local paths
// against a real local server) and in cross-host-commands.test.ts (the ssh
// argv byte-identity) — both untouched by this slice and both must stay
// green; this file covers the NET-NEW http branch, the sugar, and the
// precedence contract.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCommand, type CaptureDeps } from "../src/commands/capture.js";
import { resolveCrossHostTarget } from "../src/cross-host-target.js";
import { DaemonClient, DaemonConnectionError, DaemonResponseError, DaemonTimeoutError, SENDER_IDENTITY_HEADER } from "../src/client.js";
import type { CrossHostResult } from "../src/cross-host-executor.js";
import type { HostRegistryLoadResult } from "../src/host-registry.js";

interface CapturedOutput {
  stdoutLines: string[];
  stderrLines: string[];
}

let captured: CapturedOutput;
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  captured = { stdoutLines: [], stderrLines: [] };
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => { captured.stdoutLines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { captured.stderrLines.push(args.map(String).join(" ")); };
  process.exitCode = undefined;
  delete process.env.OPENRIG_HOST_SELECTED;
  // P18: establish a RESOLVED seat so the cross-host dispatch paths render the real sender (an env-less
  // send would deliver-and-label with the `<unknown sender>` marker rather than refuse).
  vi.stubEnv("OPENRIG_SESSION_NAME", "relay@my-rig");
  vi.stubEnv("RIGGED_SESSION_NAME", "");
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  // Assertions read the LIVE process.exitCode inside test bodies (the run-1
  // preflight lesson: a copy taken here is invisible to in-body assertions
  // and made the exit-code checks vacuous). This hook only resets state.
  process.exitCode = undefined;
  delete process.env.OPENRIG_HOST_SELECTED;
  vi.unstubAllEnvs();
});

// A registry with BOTH transports + a second http host for precedence cases.
const REGISTRY: HostRegistryLoadResult = {
  ok: true,
  registry: {
    hosts: [
      { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH4_TEST_BEARER" },
      { id: "vps-c", transport: "http", url: "http://vps-c:7433", bearer_env: "MH4_TEST_BEARER" },
      { id: "anon-b", transport: "http", url: "http://anon-b:7433" },
      { id: "vm-ssh", transport: "ssh", target: "vm-ssh.local" },
    ],
  },
};
process.env["MH4_TEST_BEARER"] = "test-token";

interface RecordedCall {
  url: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  options?: { timeoutMs?: number; headers?: Record<string, string> };
}

interface MockClientHarness {
  calls: RecordedCall[];
  clientFactory: (url: string) => never;
}

function mockClient(respond: (call: RecordedCall) => { status: number; data: unknown } | Error): MockClientHarness {
  const calls: RecordedCall[] = [];
  const clientFactory = (url: string) => ({
    post: async (path: string, body?: unknown, options?: RecordedCall["options"]) => {
      const call: RecordedCall = { url, method: "POST", path, body, options };
      calls.push(call);
      const res = respond(call);
      if (res instanceof Error) throw res;
      return res;
    },
    get: async (path: string, options?: RecordedCall["options"]) => {
      const call: RecordedCall = { url, method: "GET", path, options };
      calls.push(call);
      const res = respond(call);
      if (res instanceof Error) throw res;
      return res;
    },
  }) as never;
  return { calls, clientFactory };
}

const sshRunnerNeverCalled = vi.fn(async (): Promise<CrossHostResult> => {
  throw new Error("ssh runner must not be invoked for an http host");
});

function httpDeps(harness: MockClientHarness, overrides: Partial<SendDeps & CaptureDeps & TranscriptDeps & BroadcastDeps> = {}): SendDeps & CaptureDeps & TranscriptDeps & BroadcastDeps {
  return {
    lifecycleDeps: { exists: () => false } as never,
    clientFactory: harness.clientFactory,
    hostRegistryLoader: () => REGISTRY,
    crossHostRun: sshRunnerNeverCalled as never,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §4 sugar/precedence — the pure helper contract
// ---------------------------------------------------------------------------

describe("resolveCrossHostTarget (§4 sugar + precedence)", () => {
  const loader = () => REGISTRY;

  it("plain 2-part target: untouched, no sugar, no hint, registry never loaded", () => {
    const spy = vi.fn(loader);
    const r = resolveCrossHostTarget("dev-impl@my-rig", undefined, spy);
    expect(r).toEqual({ ok: true, target: "dev-impl@my-rig", sugarHost: undefined, hint: undefined });
    expect(spy).not.toHaveBeenCalled();
  });

  it("3-part with REGISTERED suffix: host-qualified — target stripped, host extracted", () => {
    const r = resolveCrossHostTarget("dev-impl@my-rig@vps-b", undefined, loader);
    expect(r).toEqual({ ok: true, target: "dev-impl@my-rig", sugarHost: "vps-b", hint: undefined });
  });

  it("3-part with UNREGISTERED suffix: passes through UNCHANGED with the loud hint", () => {
    const r = resolveCrossHostTarget("dev-impl@my-rig@nope", undefined, loader);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("dev-impl@my-rig@nope");
      expect(r.sugarHost).toBeUndefined();
      expect(r.hint).toContain("no registered host 'nope'");
      expect(r.hint).toContain("rig host ls");
    }
  });

  it("registry load failure: passthrough + hint (a plain-target failure mode is never added)", () => {
    const r = resolveCrossHostTarget("a@b@vps-b", undefined, () => ({ ok: false, error: "no file" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("a@b@vps-b");
      expect(r.sugarHost).toBeUndefined();
      expect(r.hint).toContain("vps-b");
    }
  });

  it("--host X + sugar @Y, X≠Y: structured conflict", () => {
    const r = resolveCrossHostTarget("dev-impl@my-rig@vps-b", "vps-c", loader);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("ambiguous host");
      expect(r.error).toContain("vps-c");
      expect(r.error).toContain("@vps-b");
    }
  });

  it("--host X + sugar @X (same host twice): fine", () => {
    const r = resolveCrossHostTarget("dev-impl@my-rig@vps-b", "vps-b", loader);
    expect(r).toEqual({ ok: true, target: "dev-impl@my-rig", sugarHost: "vps-b", hint: undefined });
  });

  it("adopted/raw 4-part-ish names keep working: only the LAST @ segment is a host candidate", () => {
    const r = resolveCrossHostTarget("weird@name@extra@vps-b", undefined, loader);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("weird@name@extra");
      expect(r.sugarHost).toBe("vps-b");
    }
  });
});

// ---------------------------------------------------------------------------
// capture — the http branch
// ---------------------------------------------------------------------------

describe("capture --host (http branch)", () => {
  it("http host: POSTs the LOCAL body shape to /api/transport/capture and renders the single result under the banner", async () => {
    const h = mockClient(() => ({ status: 200, data: { content: "pane content here" } }));
    const cmd = captureCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "--lines", "50"], { from: "user" });
    expect(sshRunnerNeverCalled).not.toHaveBeenCalled();
    const call = h.calls[0]!;
    expect(call.path).toBe("/api/transport/capture");
    expect(call.body).toEqual({ lines: 50, session: "dev-impl@my-rig" });
    expect(captured.stdoutLines).toContain("[via host=vps-b (http://vps-b:7433)]");
    expect(captured.stdoutLines).toContain("pane content here");
  });

  it("anonymous (URL-only) http host: capture POSTs with NO Authorization header; still succeeds", async () => {
    const h = mockClient(() => ({ status: 200, data: { content: "pane content here" } }));
    const cmd = captureCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "anon-b", "dev-impl@my-rig"], { from: "user" });
    expect(h.calls.length).toBe(1);
    const headers = h.calls[0]!.options?.headers ?? {};
    expect("Authorization" in headers).toBe(false);
    expect(captured.stdoutLines).toContain("pane content here");
  });

  it("multi-target (--rig/--pod) rides the http branch with per-target rendering", async () => {
    const h = mockClient(() => ({
      status: 200,
      data: { results: [
        { sessionName: "a@r", ok: true, content: "aaa" },
        { sessionName: "b@r", ok: false, error: "no pane" },
      ] },
    }));
    const cmd = captureCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "--rig", "r"], { from: "user" });
    expect((h.calls[0]!.body as Record<string, unknown>).rig).toBe("r");
    expect(captured.stdoutLines).toContain("--- a@r ---");
    expect(captured.stdoutLines).toContain("aaa");
    expect(captured.stdoutLines.join("\n")).toContain("no pane");
  });

  it("sugar target routes http with the stripped session (BR-1)", async () => {
    const h = mockClient(() => ({ status: 200, data: { content: "x" } }));
    const cmd = captureCommand(httpDeps(h));
    await cmd.parseAsync(["dev-impl@my-rig@vps-b"], { from: "user" });
    expect((h.calls[0]!.body as Record<string, unknown>).session).toBe("dev-impl@my-rig");
  });

  it("ssh host still takes the ssh shell-out (branch selection)", async () => {
    const sshCalls: { argv?: readonly string[] } = {};
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = captureCommand(httpDeps(h, {
      crossHostRun: (async (_hh: never, argv: readonly string[]) => {
        sshCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: "remote pane\n", stderr: "", remoteExitCode: 0 } as CrossHostResult;
      }) as never,
    }));
    await cmd.parseAsync(["--host", "vm-ssh", "dev-impl@my-rig"], { from: "user" });
    expect(h.calls.length).toBe(0); // http client never touched for an ssh host
    expect(sshCalls.argv).toEqual(["rig", "capture", "dev-impl@my-rig"]); // no --lines: the remote's default stays the default
  });

  it("http host: an explicit --lines N cuts the remote capture to its last N lines, in text and JSON", async () => {
    const pane = Array.from({ length: 26 }, (_, i) => `row${i + 1}`).join("\n") + "\n";
    const h = mockClient(() => ({ status: 200, data: { ok: true, sessionName: "dev-impl@my-rig", content: pane, lines: 5 } }));
    await captureCommand(httpDeps(h)).parseAsync(["--host", "vps-b", "dev-impl@my-rig", "--lines", "5"], { from: "user" });
    expect(h.calls[0]!.body).toEqual({ lines: 5, session: "dev-impl@my-rig" });
    expect(captured.stdoutLines).toContain("row22\nrow23\nrow24\nrow25\nrow26\n");
    expect(captured.stderrLines).toContain("[rig capture: dev-impl@my-rig: 21 earlier lines not shown; last 5 shown]");

    captured.stdoutLines.length = 0;
    await captureCommand(httpDeps(h)).parseAsync(["--host", "vps-b", "dev-impl@my-rig", "--lines", "5", "--json"], { from: "user" });
    const parsed = JSON.parse(captured.stdoutLines[0]!) as Record<string, any>;
    expect(parsed.result.data).toMatchObject({ lines: 5, requestedLines: 5, omittedLines: 21 });
  });
});

describe("capture --host outcome status", () => {
  it.each([false, true])("preserves HTTP-200 rig capture status with expected unavailable target and json=%s", async (json) => {
    const h = mockClient(() => ({ status: 200, data: { results: [
      { ok: true, sessionName: "one@rig", content: "kept bytes" },
      { ok: false, sessionName: "two@rig", error: "external CLI capture is not available" },
    ] } }));
    await captureCommand(httpDeps(h)).parseAsync(["--host", "vps-b", "--rig", "rig", ...(json ? ["--json"] : [])], { from: "user" });
    expect(captured.stdoutLines.join("\n")).toContain("kept bytes");
    expect(captured.stdoutLines.join("\n")).toContain("external CLI capture is not available");
    expect(process.exitCode).toBeUndefined();
  });
  it("does not turn successful empty capture bytes into an error", async () => {
    const h = mockClient(() => ({ status: 200, data: { results: [{ ok: true, sessionName: "empty@rig", content: "" }] } }));
    await captureCommand(httpDeps(h)).parseAsync(["--host", "vps-b", "--rig", "rig"], { from: "user" });
    expect(captured.stdoutLines.join("\n")).not.toContain("error:");
    expect(process.exitCode).toBeUndefined();
  });
});
