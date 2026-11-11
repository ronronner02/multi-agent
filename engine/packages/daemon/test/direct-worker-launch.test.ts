import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DirectWorkerLauncher } from "../src/adapters/direct-worker-launch.js";
import type { WorkerLaunchInput } from "../src/adapters/worker-launch.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import { agentTurnOutputPaths, writeAgentTurnPrompt } from "../src/domain/agent-turn.js";
import { TEAM_CONTROL_VERSION } from "../src/contracts/team-control.js";
import type { SupervisorLaunch, SupervisorResult, SupervisedTurn } from "../src/adapters/child-process-supervisor.js";
import type { WorkerEvent } from "../src/contracts/worker-events.js";

/**
 * U3 — the launcher's side of the direct-child transport.
 *
 * The launcher no longer types a command line into a pane: it resolves the real executable
 * through U1, hands the supervisor the frozen argv, the prompt and the tree, and records a
 * receipt whose identity is the process pair. These cases pin exactly that hand-off, and then
 * run the whole daemon path against a stub client to prove a turn is swept to stopped without a
 * pane anywhere in it.
 */

const threadId = "019a527e-91e7-7000-8aac-35cd290bda12";

/** A projection is sealed read-only, so every directory is opened before removal. */
function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

/** A turn that answers the launcher without spawning, so the hand-off can be inspected. */
function fakeTurn(launch: SupervisorLaunch, onEvent: (event: WorkerEvent) => void): SupervisedTurn {
  let identity: { processId: number; processStart: string } | null = null;
  let settled: SupervisorResult | null = null;
  const events: WorkerEvent[] = [];
  const emit = (event: WorkerEvent) => { events.push(event); onEvent(event); };
  return {
    async start() {
      identity = { processId: 4242, processStart: "2026-11-10T00:00:00.000Z" };
      if (launch.provider === "codex" && launch.threadIdPath) writeFileSync(launch.threadIdPath, threadId, { mode: 0o600 });
      // A real supervisor streams provider events from stdout after `start()` returns, so the
      // first session event never precedes the `started` fact. Deferring with setTimeout (not
      // queueMicrotask) keeps that order: the `started` lifecycle fact is recorded by the launcher
      // in the same microtask/tick as `start()` resolving, and this fires in the next task.
      setTimeout(() => emit({ type: "session.started", provider: launch.provider, attemptId: launch.attemptId, sequence: 1,
        timestamp: new Date().toISOString(), rawSummary: "{}", schema: "multi-agent-worker-events/v1", protocolVersion: "1.0",
        sessionId: threadId, resumeToken: threadId } as WorkerEvent));
      return identity;
    },
    async wait() {
      settled ??= { version: 1, attemptId: launch.attemptId, provider: launch.provider, exitCode: 0, signal: null,
        acknowledged: true, noResponse: false, threadId: launch.provider === "codex" ? threadId : null,
        stderrTail: "", outputTail: "", at: new Date().toISOString(),
        identity: identity ?? { processId: 0, processStart: "" }, events, finalMessage: null, resumeToken: threadId };
      return settled;
    },
    async cancel() { return { outcome: "stopped", escalated: false, waitedMs: 0 }; },
    settled: () => settled,
    get processIdentity() { return identity; },
    get observedEvents() { return events; },
  };
}

describe("U3 the launcher hands one turn to the supervisor", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "u3-launch-"));
    for (const name of ["codex.exe", "claude.exe"]) writeFileSync(join(root, name), "");
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const context = (options: { readOnly?: boolean; role?: string; client?: "claude-code" | "codex" } = {}) => ({
    runId: "run", assignment: { taskId: "task", role: options.role ?? "implementer", paths: ["plan.md"], dependencies: [] },
    client: options.client ?? "codex", mutableStateRoot: root, projection: { attemptId: "attempt-1" },
    ...(options.readOnly ? { workflow: { readOnly: true } } : {}),
    binding: { policyFingerprint: "sha256:" + "b".repeat(64) }, generatedHash: "sha256:" + "a".repeat(64),
  }) as ContextManifest;

  const launch = async (options: Partial<WorkerLaunchInput> & { readOnly?: boolean; role?: string;
    modelRefusal?: (input: WorkerLaunchInput) => string | null; documentRefusal?: (input: WorkerLaunchInput) => string | null } = {}) => {
    const { readOnly, role, modelRefusal, documentRefusal, ...launchOptions } = options;
    const manifest = context({ readOnly, role, client: launchOptions.client });
    writeAgentTurnPrompt(manifest, "Read the assigned plan.\n");
    const launches: SupervisorLaunch[] = [];
    const lifecycle: Array<{ fact: string; attemptId: string; runId: string; taskId: string }> = [];
    const launcher = new DirectWorkerLauncher({
      modelRefusal, documentRefusal,
      resolveAssignedTree: () => join(root, "candidate tree"),
      // An explicit configured path is used as given, which is how a fixture names a stub. The
      // resolver still requires it to be a launchable file, so the fixtures are real ones.
      executablePath: client => (client === "codex" ? join(root, "codex.exe") : join(root, "claude.exe")),
      supervise: (launch, deps) => { launches.push(launch); return fakeTurn(launch, deps.onEvent); },
      // U4 — the launcher records its durable lifecycle facts through this recorder.
      lifecycle: fact => { lifecycle.push(fact); },
    });
    const input: WorkerLaunchInput = { client: "codex", attempt: { attemptId: "attempt-1", deadline: Date.now() + 60_000, context: manifest },
      ...launchOptions };
    const result = await launcher.launch(input);
    return { result, input, launcher, observed: launches[0], lifecycle };
  };

  it("starts the resolved executable with the Codex implementer argv and the prompt as stdin", async () => {
    const { result, observed } = await launch({ model: "fixture-model", effort: "high" });
    expect(result).toMatchObject({ ok: true });
    expect(observed.executable).toBe(join(root, "codex.exe"));
    expect(observed.cwd).toBe(join(root, "candidate tree"));
    expect(observed.prompt).toBe("Read the assigned plan.\n");
    expect(observed.provider).toBe("codex");
    expect(observed.args.slice(0, 4)).toEqual(["exec", "--json", "-o", join(root, "turns", "attempt-1", "last-message.txt")]);
    expect(observed.args).toContain("-C");
    expect(observed.args[observed.args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(observed.args).toContain("sandbox_workspace_write.network_access=true");
    expect(observed.args).toContain("check_for_update_on_startup=false");
    expect(observed.args).toContain("-m");
    expect(observed.args).toContain("model_reasoning_effort=high");
    expect(observed.args.at(-1)).toBe("-");
    // The thread id is captured where the receipt and the sweep read it.
    expect(observed.threadIdPath).toBe(join(root, "turns", "attempt-1", "thread-id.txt"));
    expect(result.ok && result.resumeToken).toBeUndefined();
  });

  it("keeps a reviewer read-only for both clients", async () => {
    for (const [client, expected] of [["claude-code", ["--permission-mode", "plan"]], ["codex", ["-s", "read-only"]]] as const) {
      const { observed } = await launch({ client, readOnly: true });
      const index = observed.args.indexOf(expected[0]);
      expect(index, client).toBeGreaterThanOrEqual(0);
      expect(observed.args[index + 1]).toBe(expected[1]);
    }
  });

  it.each(["resumeToken", "continueSessionId"] as const)("continues the stored conversation through %s", async key => {
    const { observed, result } = await launch({ [key]: threadId });
    expect(observed.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(observed.args.at(-2)).toBe(threadId);
    expect(observed.args.at(-1)).toBe("-");
    expect(observed.args).not.toContain("-C");
    expect(result).toMatchObject({ ok: true });
  });

  it("records an identity with a process pair and no pane", async () => {
    const { result } = await launch();
    const receipt = result.ok ? result.managedSession! : null;
    expect(receipt).not.toBeNull();
    expect(receipt!.identity).toMatchObject({ processId: 4242, processStart: "2026-11-10T00:00:00.000Z",
      paneId: null, tmuxServer: null, nativeSessionId: threadId, generation: 1 });
    // Nothing about this launch claims a network profile it does not enforce.
    expect(receipt!.network).toMatchObject({ namespace: "host", mode: "unknown" });
  });

  it("clears the attempt's stale output before the turn starts", async () => {
    const output = agentTurnOutputPaths(root, "attempt-1");
    mkdirSync(dirname(output.taskReport), { recursive: true });
    for (const path of [output.lastMessage, output.taskReport]) writeFileSync(path, "stale");
    const { observed } = await launch();
    expect(observed.attemptId).toBe("attempt-1");
    // The supervisor clears these itself; this proves the launcher did not recreate them.
    expect(readFileSync(output.lastMessage, "utf8")).toBe("stale");
    rmSync(output.lastMessage, { force: true });
  });

  it("records submitted before spawn, started after identity, and acknowledged once", async () => {
    const { lifecycle } = await launch();
    // The facts are in lifecycle order: intent before the child exists, identity after start,
    // and acknowledgment at the first provider event (the fake turn emits one session.started).
    expect(lifecycle.map(fact => fact.fact)).toEqual(["attempt.submitted", "attempt.started", "attempt.acknowledged"]);
    expect(lifecycle.every(fact => fact.attemptId === "attempt-1")).toBe(true);
    expect(lifecycle.every(fact => fact.runId === "run" && fact.taskId === "task")).toBe(true);
  });

  it.each(["--last", "with whitespace", "trailing\n", "", "x".repeat(129)])("refuses a hostile session token (%j)", async token => {
    for (const key of ["resumeToken", "continueSessionId"] as const) {
      const { result, observed } = await launch({ [key]: token });
      expect(result).toMatchObject({ ok: false });
      expect(observed).toBeUndefined();
    }
  });

  it.each([undefined, threadId])("enforces model policy before fresh or continued turns (%s)", async continueSessionId => {
    const { result, observed } = await launch({ model: "outside-allowlist", continueSessionId, modelRefusal: () => "team_model_not_allowed" });
    expect(result).toMatchObject({ ok: false, error: "Direct launch blocked: team_model_not_allowed" });
    expect(observed).toBeUndefined();
  });

  it("rechecks model policy after preparation and before the turn starts", async () => {
    const refusal = vi.fn().mockReturnValueOnce(null).mockReturnValue("team_model_not_allowed");
    const { result, observed } = await launch({ model: "changed-policy", modelRefusal: refusal });
    expect(refusal).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, error: "Direct launch blocked: team_model_not_allowed" });
    expect(observed).toBeUndefined();
  });

  it("enforces approved document versions immediately before the turn starts", async () => {
    const refusal = vi.fn().mockReturnValueOnce(null).mockReturnValue("Approved document versions changed before launch");
    const { result, observed } = await launch({ documentRefusal: refusal });
    expect(refusal).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, error: "Direct launch blocked: Approved document versions changed before launch" });
    expect(observed).toBeUndefined();
  });

  it("treats a finished turn as ready without a composer", async () => {
    const { result, input, launcher } = await launch();
    expect(result).toMatchObject({ ok: true });
    expect(await launcher.checkReady(input.attempt)).toEqual({ ready: true });
  });

  it("refuses a second launch of the same attempt", async () => {
    const { input, launcher } = await launch();
    expect(await launcher.launch(input)).toMatchObject({ ok: false, error: "Direct launch blocked: managed_attempt_already_started" });
  });
});
