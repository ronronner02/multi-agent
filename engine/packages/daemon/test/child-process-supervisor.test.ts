import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CANCEL_GRACE_MS, ChildProcessSupervisor, OUTPUT_TAIL_LIMIT, STDERR_TAIL_LIMIT, UNOBSERVED_PROCESS_START,
  readSpawnCreationTime, readSupervisorExit, type SupervisorLaunch,
} from "../src/adapters/child-process-supervisor.js";
import { workerArgv } from "../src/adapters/worker-launch-argv.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { setHostPlatformForTests } from "../src/domain/platform.js";

/**
 * U3 — the pipe-based child-process supervisor and the frozen launch contract.
 *
 * Two things are pinned here. The **argv matrix** is the contract the plan freezes: fresh and
 * continuation, implementer and reviewer, for both clients, including every flag that makes a
 * turn watchable, resumable and confined. The **supervisor** is the transport: one prompt on
 * stdin, incremental JSONL parsing, bounded tails, one exit fact, and a cancellation that ends
 * the whole tree. The child in these cases is this Node binary running a small script — a real
 * executable started with `shell: false`, exactly as a resolved client would be.
 */

const windows = process.platform === "win32";
const directories: string[] = [];
const temporary = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  setHostPlatformForTests(null);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A stub client: it records its argv, its stdin and its cwd, then prints the given lines. */
function stubScript(root: string, lines: readonly string[], options: { exitCode?: number; stderr?: string } = {}): string {
  const path = join(root, "stub.cjs");
  writeFileSync(path, `const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(join(root, "observed.json"))}, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }));
${options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : ""}
for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n");
process.exitCode = ${options.exitCode ?? 0};
`);
  return path;
}

function launchFor(root: string, script: string, extra: Partial<SupervisorLaunch> = {}): SupervisorLaunch {
  return {
    executable: process.execPath,
    args: [script],
    cwd: root,
    prompt: "Reply with the single word OK\n",
    mutableStateRoot: join(root, "state"),
    attemptId: "attempt-1",
    provider: "codex",
    ...extra,
  };
}

describe("U3 the frozen worker launch argv", () => {
  const output = agentTurnOutputPaths("/state", "attempt-1");
  const base = { tree: "/tree", output, role: "implementer", sessionId: "11111111-2222-3333-4444-555555555555" };

  it("opens a fresh Claude implementer conversation with the streaming, bypassing flags", () => {
    const argv = workerArgv({ ...base, client: "claude-code", readOnly: false, continuing: false, model: "claude-x", effort: "high" });
    expect(argv).toEqual(["-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json",
      "--verbose", "--include-partial-messages", "--model", "claude-x", "--effort", "high",
      "--session-id", base.sessionId]);
  });

  it("keeps a Claude reviewer read-only and without inherited tools", () => {
    const argv = workerArgv({ ...base, client: "claude-code", readOnly: true, continuing: false });
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("bypassPermissions");
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--effort");
  });

  it.each(["resumeToken", "continueSessionId"])("continues a Claude conversation instead of opening one (%s)", () => {
    const argv = workerArgv({ ...base, client: "claude-code", readOnly: false, continuing: true });
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(base.sessionId);
    expect(argv).not.toContain("--session-id");
  });

  it("runs a fresh Codex implementer with a final-message file, writable roots and the stdin marker", () => {
    const argv = workerArgv({ ...base, client: "codex", readOnly: false, continuing: false, model: "gpt-x", effort: "high" });
    expect(argv.slice(0, 3)).toEqual(["exec", "--json", "-o"]);
    expect(argv[3]).toBe(output.lastMessage);
    expect(argv).toContain("-C");
    expect(argv[argv.indexOf("-C") + 1]).toBe("/tree");
    expect(argv[argv.indexOf("-s") + 1]).toBe("workspace-write");
    expect(argv).toContain("sandbox_workspace_write.network_access=true");
    expect(argv).toContain("check_for_update_on_startup=false");
    expect(argv).toContain("sandbox_workspace_write.writable_roots=" + JSON.stringify([output.taskReport]));
    expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-x");
    expect(argv).toContain("model_reasoning_effort=high");
    // The trailing marker is Codex's stdin: the prompt is never on the command line.
    expect(argv.at(-1)).toBe("-");
    expect(argv).not.toContain(base.sessionId);
  });

  it("keeps a fresh Codex reviewer read-only, with no writable roots and no network grant", () => {
    const argv = workerArgv({ ...base, client: "codex", readOnly: true, continuing: false });
    expect(argv[argv.indexOf("-s") + 1]).toBe("read-only");
    expect(argv).toContain("approval_policy=never");
    expect(argv).not.toContain("workspace-write");
    expect(argv.join(" ")).not.toContain("writable_roots");
    expect(argv.join(" ")).not.toContain("network_access");
  });

  it("continues a Codex conversation through the config sandbox, the session id and the stdin marker", () => {
    const argv = workerArgv({ ...base, client: "codex", readOnly: false, continuing: true });
    expect(argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(argv).toContain("sandbox_mode=workspace-write");
    expect(argv).not.toContain("-C");
    expect(argv).not.toContain("-s");
    expect(argv.at(-2)).toBe(base.sessionId);
    expect(argv.at(-1)).toBe("-");
  });

  it("keeps a continued Codex reviewer read-only", () => {
    const argv = workerArgv({ ...base, client: "codex", readOnly: true, continuing: true });
    expect(argv).toContain("sandbox_mode=read-only");
    expect(argv).toContain("approval_policy=never");
    expect(argv.join(" ")).not.toContain("workspace-write");
  });

  it("gives a lead no writable report root, because only implementers and reviewers report", () => {
    const argv = workerArgv({ ...base, client: "codex", readOnly: false, continuing: false, role: "lead" });
    expect(argv.join(" ")).not.toContain("writable_roots");
  });
});

describe("U3 the supervisor runs one turn", () => {
  let root: string;
  beforeEach(() => { root = temporary("u3-supervisor-"); });

  it("writes the prompt exactly once, clears the attempt's output, and records one exit", async () => {
    const output = agentTurnOutputPaths(join(root, "state"), "attempt-1");
    // A previous turn's output must not survive into this one: a stale report is what a stale
    // completion would otherwise read.
    mkdirSync(dirname(output.taskReport), { recursive: true });
    for (const path of [output.lastMessage, output.threadId, output.exit, output.taskReport]) writeFileSync(path, "stale");
    const script = stubScript(root, ['{"type":"thread.started","thread_id":"00000000-0000-4000-8000-000000000002"}',
      '{"type":"turn.completed"}'], { exitCode: 3 });
    const supervisor = new ChildProcessSupervisor(launchFor(root, script, { threadIdPath: output.threadId }));
    const identity = await supervisor.start();
    expect(identity.processId).toBeGreaterThan(0);
    const result = await supervisor.wait();
    const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8")) as { prompt: string; args: string[]; cwd: string };
    expect(observed.prompt).toBe("Reply with the single word OK\n");
    // The script is the whole argv: the child was started with `shell: false` and nothing else.
    expect(observed.args).toEqual([]);
    expect(result).toMatchObject({ exitCode: 3, signal: null, acknowledged: true, noResponse: false });
    // The exit is recorded once, and a second read is the same fact rather than a second exit.
    expect(await supervisor.wait()).toBe(result);
    expect(readSupervisorExit(join(root, "state"), "attempt-1")).toMatchObject({ exitCode: 3, attemptId: "attempt-1", provider: "codex" });
    // The client's own thread id is captured from its first session event.
    expect(readFileSync(output.threadId, "utf8")).toBe("00000000-0000-4000-8000-000000000002");
    expect(result.threadId).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("normalizes a malformed line into one bounded error and keeps parsing after it", async () => {
    const script = stubScript(root, ["not json at all", '{"type":"thread.started","thread_id":"t-1"}',
      '{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"OK"}}']);
    const supervisor = new ChildProcessSupervisor(launchFor(root, script));
    await supervisor.start();
    const result = await supervisor.wait();
    expect(result.events[0]).toMatchObject({ type: "provider.error", code: "malformed_json", terminal: false });
    // The events after the bad line still arrive, in order, and only the first provider session
    // acknowledges the attempt — the acknowledgment is recorded at the event that established it.
    expect(result.events.map(event => event.type)).toEqual(["provider.error", "attempt.acknowledged", "session.started", "message.agent"]);
    expect(result.events.filter(event => event.type === "attempt.acknowledged")).toHaveLength(1);
    expect(result.acknowledged).toBe(true);
  });

  it("leaves a child that says nothing as no-response", async () => {
    const supervisor = new ChildProcessSupervisor(launchFor(root, stubScript(root, [])));
    await supervisor.start();
    expect(await supervisor.wait()).toMatchObject({ acknowledged: false, noResponse: true, exitCode: 0 });
  });

  it.each(["claude", "codex"] as const)("publishes %s public progress before a provider event invalidates live projections", async provider => {
    const lines = provider === "codex" ? ['{"type":"thread.started","thread_id":"t-1"}',
      '{"type":"item.completed","item":{"id":"first","type":"agent_message","text":"First"}}',
      '{"type":"item.completed","item":{"id":"second","type":"agent_message","text":"Second"}}']
      : ['{"type":"system","subtype":"init","session_id":"s-1"}',
        '{"type":"assistant","message":{"id":"first","content":[{"type":"text","text":"First"}]}}',
        '{"type":"assistant","message":{"id":"second","content":[{"type":"text","text":"Second"}]}}'];
    const script = stubScript(root, lines);
    const output = agentTurnOutputPaths(join(root, "state"), "attempt-1");
    const snapshots: string[][] = [];
    const supervisor = new ChildProcessSupervisor(launchFor(root, script, { provider }), { onEvent: event => {
      if (event.type !== "message.agent") return;
      const progress = JSON.parse(readFileSync(join(output.directory, "progress.json"), "utf8")) as { blocks: { text: string }[] };
      snapshots.push(progress.blocks.map(block => block.text));
    } });
    await supervisor.start();
    await supervisor.wait();
    expect(snapshots).toEqual([["First"], ["First", "Second"]]);
  });

  it("bounds stderr and the rendered output while keeping the newest bytes", async () => {
    const script = join(root, "flood.cjs");
    writeFileSync(script, `const line = '{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"' + 'x'.repeat(4096) + '"}}';
for (let i = 0; i < 40; i++) process.stdout.write(line + "\\n");
process.stderr.write("e".repeat(${STDERR_TAIL_LIMIT * 3}));
process.stderr.write("LAST-ERROR-LINE\\n");
`);
    const supervisor = new ChildProcessSupervisor(launchFor(root, script));
    await supervisor.start();
    const result = await supervisor.wait();
    expect(Buffer.byteLength(result.outputTail)).toBeLessThanOrEqual(OUTPUT_TAIL_LIMIT + 8192);
    expect(result.outputTail.length).toBeLessThan(OUTPUT_TAIL_LIMIT + 8192);
    expect(Buffer.byteLength(result.stderrTail)).toBeLessThanOrEqual(STDERR_TAIL_LIMIT + 64);
    expect(result.stderrTail).toContain("LAST-ERROR-LINE");
    // Every line still reached the normalizer, even though the retained tail is bounded.
    expect(result.events).toHaveLength(40);
  });

  // Windows has no signals: `process.kill(pid, 'SIGTERM')` there is a terminate with an exit
  // code, which is why the supervisor records both fields and never invents either.
  it.skipIf(windows)("records a signal rather than inventing an exit code", async () => {
    const script = join(root, "signalled.cjs");
    writeFileSync(script, `process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);`);
    const supervisor = new ChildProcessSupervisor(launchFor(root, script));
    await supervisor.start();
    const result = await supervisor.wait();
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("refuses a turn whose prompt file is not readable", async () => {
    const supervisor = new ChildProcessSupervisor(launchFor(root, stubScript(root, []), { attemptId: "attempt-missing" }));
    // The prompt itself is passed in, so a missing prompt is a launcher-level refusal; this case
    // proves the supervisor's own contract: a child started with an empty prompt still ends.
    await supervisor.start();
    expect(await supervisor.wait()).toMatchObject({ noResponse: true });
  });

  it("reports an unobserved start marker for a child the OS no longer knows", async () => {
    const script = stubScript(root, ['{"type":"turn.completed"}']);
    const supervisor = new ChildProcessSupervisor(launchFor(root, script), { creationTime: async () => null, startTick: () => null });
    const identity = await supervisor.start();
    expect(identity.processStart).toBe(UNOBSERVED_PROCESS_START);
    await supervisor.wait();
  });
});

describe("U3 cancellation", () => {
  let root: string;
  beforeEach(() => { root = temporary("u3-cancel-"); });

  it("lets a child that honours EOF leave on its own, without a kill", async () => {
    const script = join(root, "eof.cjs");
    writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`);
    let terminated = false;
    const supervisor = new ChildProcessSupervisor(launchFor(root, script), {
      terminate: async () => { terminated = true; return { outcome: "stopped", escalated: true, waitedMs: 0 }; },
      observe: async () => "dead",
    });
    await supervisor.start();
    const result = await supervisor.cancel();
    expect(result).toMatchObject({ outcome: "stopped", escalated: false });
    expect(terminated).toBe(false);
    // The turn is over, so nothing is left holding the temporary directory.
    await supervisor.wait();
  });

  it("ends a recorded tree that ignores the closed stdin", async () => {
    const script = join(root, "stubborn.cjs");
    writeFileSync(script, `process.stdin.resume(); setInterval(() => {}, 1000);`);
    const targets: number[] = [];
    const supervisor = new ChildProcessSupervisor(launchFor(root, script), {
      // The child is real; the tree kill is what this case decides, so the recorded identity is
      // answered by the injected observer and the termination is recorded rather than faked.
      observe: async () => "alive",
      terminate: async identity => { targets.push(identity.processId); return { outcome: "stopped", escalated: true, waitedMs: CANCEL_GRACE_MS }; },
      sleep: async () => {},
    });
    const identity = await supervisor.start();
    try {
      const result = await supervisor.cancel();
      expect(result).toMatchObject({ outcome: "stopped", escalated: true });
      expect(targets).toEqual([identity.processId]);
    } finally {
      // The injected observer said alive, so the real child is still running: end it here, and
      // only then is the turn's own exit fact available.
      spawnSync("taskkill", ["/PID", String(identity.processId), "/T", "/F"], { windowsHide: true });
      try { process.kill(identity.processId, "SIGKILL"); } catch { /* Already gone on Windows. */ }
    }
    expect((await supervisor.wait()).cancellation).toMatchObject({ outcome: "stopped", escalated: true });
  }, 60_000);
});

describe.skipIf(!windows)("U3 Windows tree kill", () => {
  let root: string;
  beforeEach(() => { root = temporary("u3-tree-"); });

  it("ends a child and the grandchild it spawned with one recorded identity", async () => {
    // Measured on Windows: `child.kill()` reaches the direct child only and leaves the grandchild
    // running, which is why cancellation goes through `taskkill /T /F` and re-proves the identity.
    const script = join(root, "tree.cjs"), pidFile = join(root, "grandchild.pid");
    writeFileSync(script, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
setInterval(() => {}, 1000);
`);
    const supervisor = new ChildProcessSupervisor(launchFor(root, script, { provider: "claude" }));
    const identity = await supervisor.start();
    // The grandchild is a real second process: its pid is read from the file the child writes,
    // rather than from the provider stream, because it is not a provider event.
    let grandchild = 0;
    for (let attempt = 0; attempt < 200 && grandchild === 0; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      if (existsSync(pidFile)) grandchild = Number(readFileSync(pidFile, "utf8"));
    }
    expect(grandchild).toBeGreaterThan(0);
    expect(identity.processId).toBeGreaterThan(0);
    const result = await supervisor.cancel();
    expect(result.outcome).toBe("stopped");
    // The recorded identity is gone, and so is everything it started.
    expect(await readSpawnCreationTime(identity.processId)).toBeNull();
    expect(await readSpawnCreationTime(grandchild)).toBeNull();
  }, 60_000);

  it("runs a compiled stub .exe with shell:false and reads its JSONL", async () => {
    // A real `.exe` is the launch contract's target, and Node refuses to spawn a `.cmd` with
    // `shell: false`. `csc.exe` ships with every supported Windows version, so a genuine native
    // stub is compiled here rather than checked in as a binary.
    const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    if (!existsSync(compiler)) return;
    const source = join(root, "Stub.cs");
    writeFileSync(source, `using System;
using System.IO;
public class Stub {
  public static int Main(string[] args) {
    File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("STUB_DIR"), "observed.txt"),
      string.Join("\\n", args) + "\\n--prompt--\\n" + Console.In.ReadToEnd());
    Console.Out.WriteLine("{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"stub-thread\\"}");
    Console.Out.WriteLine("{\\"type\\":\\"turn.completed\\"}");
    Console.Out.Flush();
    return 0;
  }
}
`);
    const exe = join(root, "stub.exe");
    const compiled = spawnSync(compiler, ["/nologo", "/out:" + exe, source], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const supervisor = new ChildProcessSupervisor(launchFor(root, exe, {
      executable: exe, args: ["exec", "--json", "-"], provider: "codex", env: { STUB_DIR: root },
    }));
    await supervisor.start();
    const result = await supervisor.wait();
    expect(result).toMatchObject({ exitCode: 0, acknowledged: true });
    const observed = readFileSync(join(root, "observed.txt"), "utf8");
    expect(observed).toContain("exec\n--json\n-");
    expect(observed).toContain("--prompt--\nReply with the single word OK");
  }, 60_000);
});
