import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const view = fileURLToPath(new URL("../assets/agent-turn-view.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/agent-streams/", import.meta.url));
const recordings = ["claude-initial", "claude-resumed", "codex-initial", "codex-resumed"];

interface Recording {
  client: "claude" | "codex";
  events: Array<Record<string, unknown>>;
  exitCode: number;
  signal: null;
  nativeLastMessage: string | null;
}

// Reproduce the native -o side effect as well as its stream: the wrapper never writes Codex's final message.
const replay = `import { readFileSync, writeFileSync } from 'node:fs';
const [fixture, result, chunking] = process.argv.slice(2);
const recording = JSON.parse(readFileSync(fixture, 'utf8'));
writeFileSync(result + '.stdin', readFileSync(0));
const text = recording.events.map(event => JSON.stringify(event)).join('\\n') + (chunking === 'no-newline' ? '' : '\\n');
const bytes = Buffer.from(text), size = chunking === 'chunks' ? 17 : bytes.length;
for (let i = 0; i < bytes.length; i += size) process.stdout.write(bytes.subarray(i, i + size));
if (recording.nativeLastMessage !== null) writeFileSync(result, recording.nativeLastMessage);
process.exitCode = recording.exitCode;
`;

describe("recorded native turn output", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "turn-telemetry-")); writeFileSync(join(root, "replay.mjs"), replay); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(recordings.flatMap(recording => ["complete", "chunks", "no-newline"].map(mode => ({ recording, mode }))))
  ("preserves $recording pane, terminal result, final message and stdin under $mode", ({ recording, mode }) => {
    const fixture = join(fixtures, recording + ".json"), data = JSON.parse(readFileSync(fixture, "utf8")) as Recording;
    const lastMessage = join(root, "last-message.txt"), thread = join(root, "thread-id.txt");
    const result = spawnSync(process.execPath, [view, "--result-file", lastMessage, "--thread-id-file", thread,
      process.execPath, join(root, "replay.mjs"), fixture, lastMessage, mode],
    { input: "The bounded fixture request.\n", encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(data.exitCode); expect(result.signal).toBe(data.signal); expect(result.stderr).toBe("");
    expect(result.stdout).toBe(readFileSync(join(fixtures, recording + ".pane.txt"), "utf8"));
    expect(readFileSync(lastMessage + ".stdin", "utf8")).toBe("The bounded fixture request.\n");
    const expected = data.nativeLastMessage ?? data.events.find(event => event.type === "result")!.result;
    expect(readFileSync(lastMessage, "utf8")).toBe(expected);
    if (data.client === "codex") expect(readFileSync(thread, "utf8")).toBe("00000000-0000-4000-8000-000000000002");
  });
});

interface ActivityRecord { id: string; seq: number; at: string; tool: string; summary: string; status: string }
interface NativeUsage { available: boolean; client: string | null; nativeSessionId: string | null; model: string | null;
  mode: string | null; resumed: boolean; counts: Record<string, number | null> | null }

describe("turn telemetry sidecars", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "turn-sidecar-")); writeFileSync(join(root, "replay.mjs"), replay); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const sidecars = () => ({
    activity: readFileSync(join(root, "activity.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as ActivityRecord),
    usage: JSON.parse(readFileSync(join(root, "usage.json"), "utf8")) as NativeUsage,
  });
  const run = (recording: string) => spawnSync(process.execPath, [view, "--result-file", join(root, "last-message.txt"),
    process.execPath, join(root, "replay.mjs"), join(fixtures, recording + ".json"), join(root, "last-message.txt"), "chunks",
    ...(recording.endsWith("resumed") ? ["--resume", "fixture-session"] : []), "-m", "fixture-model"],
  { input: "Fixture request.", encoding: "utf8", timeout: 10_000 });

  it.each(recordings)("records one settled call and the native usage from $0", recording => {
    expect(run(recording).status).toBe(0);
    const { activity, usage } = sidecars();
    expect(activity.map(record => record.status)).toEqual(["running", "completed"]);
    expect(activity.map(record => record.seq)).toEqual([1, 2]);
    expect(activity[0]!.id).toBe(activity[1]!.id);
    expect(activity[0]!.summary).toContain(recording.endsWith("resumed") ? "cat result.txt" : "cat input.txt");
    expect(usage.available).toBe(true);
    expect(usage.mode).toBe(recording.startsWith("claude") ? "turn" : "cumulative");
    expect(usage.nativeSessionId).toBe("00000000-0000-4000-8000-00000000000" + (recording.startsWith("claude") ? "1" : "2"));
    expect(usage.counts?.outputTokens).toBe(({ "claude-initial": 145, "claude-resumed": 77,
      "codex-initial": 101, "codex-resumed": 190 } as Record<string, number>)[recording]);
    expect(usage.counts?.inputTokens).toBe(({ "claude-initial": 4760, "claude-resumed": 5080,
      "codex-initial": 11248, "codex-resumed": 11736 } as Record<string, number>)[recording]);
    const text = JSON.stringify({ activity, usage });
    expect(text).not.toContain("Private reasoning"); expect(text).not.toContain("initial complete");
    expect(text).not.toContain("resumed complete"); expect(text).not.toMatch(/cost/i);
  });

  const synthetic = (events: unknown[], end = "process.exitCode = 0;", resultFile = join(root, "last-message.txt")) => {
    writeFileSync(join(root, "events.mjs"), `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event)); ${end}`);
    return spawnSync(process.execPath, [view, "--result-file", resultFile, process.execPath, join(root, "events.mjs")],
      { input: "", encoding: "utf8", timeout: 10_000 });
  };

  it("redacts before truncating and settles duplicate call observations only once", () => {
    const secret = "sk-" + "a".repeat(64), bearer = "Bearer " + "b".repeat(64);
    const event = { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash",
      input: { command: "x ".repeat(245) + " " + secret + " " + bearer } }] } };
    const result = synthetic([event, event, { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tool-1", is_error: true }, { type: "tool_result", tool_use_id: "tool-1", is_error: true }] } }]);
    expect(result.status).toBe(0); expect(result.stdout).toContain(secret);
    const { activity, usage } = sidecars();
    expect(activity.map(record => record.status)).toEqual(["running", "failed"]);
    const text = JSON.stringify({ activity, usage });
    expect(text).not.toContain(secret); expect(text).not.toContain(bearer); expect(text).not.toContain("sk-");
    expect(activity.every(record => record.summary.length <= 512)).toBe(true);
  });

  it("settles open calls as aborted while preserving a child's signal and unavailable usage", () => {
    const result = synthetic([{ type: "item.started", item: { id: "item-1", type: "command_execution", command: "sleep 10", status: "in_progress" } }],
      "process.kill(process.pid, 'SIGTERM');");
    expect(result.signal).toBe("SIGTERM"); expect(result.stdout).toBe("[command] sleep 10\n");
    const { activity, usage } = sidecars();
    expect(activity.map(record => record.status)).toEqual(["running", "aborted"]);
    expect(usage.available).toBe(false); expect(usage.counts).toBeNull();
  });

  it("records terminal-only file, MCP and search calls without tool output or agent messages", () => {
    const result = synthetic([
      { type: "item.completed", item: { id: "f", type: "file_change", status: "completed", changes: [{ kind: "update", path: "src/a.ts" }] } },
      { type: "item.started", item: { id: "m", type: "mcp_tool_call", server: "fixture", tool: "lookup", arguments: { query: "status" }, status: "in_progress" } },
      { type: "item.completed", item: { id: "m", type: "mcp_tool_call", server: "fixture", tool: "lookup", result: "PRIVATE TOOL OUTPUT", status: "completed" } },
      { type: "item.completed", item: { id: "s", type: "web_search", query: "fixture docs" } },
      { type: "item.completed", item: { id: "a", type: "agent_message", text: "PRIVATE AGENT MESSAGE" } },
    ]);
    expect(result.status).toBe(0);
    const { activity } = sidecars();
    expect(activity.filter(record => record.status !== "running").map(record => record.tool)).toEqual(["file_change", "fixture/lookup", "web_search"]);
    expect(JSON.stringify(activity)).not.toContain("PRIVATE");
  });

  it.each(["missing-helper", "missing-redactor", "missing-both", "complete-package"])
  ("keeps native behavior under the %s asset layout", layout => {
    const packageRoot = join(root, "package"), assets = join(packageRoot, "assets"), domain = join(packageRoot, "dist", "domain");
    mkdirSync(assets, { recursive: true }); mkdirSync(domain, { recursive: true });
    const packagedView = join(assets, "agent-turn-view.mjs");
    copyFileSync(view, packagedView);
    if (layout === "missing-redactor" || layout === "complete-package") {
      copyFileSync(fileURLToPath(new URL("../assets/agent-turn-telemetry.mjs", import.meta.url)), join(assets, "agent-turn-telemetry.mjs"));
    }
    if (layout === "missing-helper" || layout === "complete-package") {
      copyFileSync(fileURLToPath(new URL("../dist/domain/transcript-redaction.js", import.meta.url)), join(domain, "transcript-redaction.js"));
    }
    const recording = JSON.parse(readFileSync(join(fixtures, "codex-initial.json"), "utf8")) as Recording;
    const lastMessage = join(root, "last-message.txt"), thread = join(root, "thread-id.txt");
    const result = spawnSync(process.execPath, [packagedView, "--result-file", lastMessage, "--thread-id-file", thread,
      process.execPath, join(root, "replay.mjs"), join(fixtures, "codex-initial.json"), lastMessage, "chunks"],
    { input: "Package fixture.\n", encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(recording.exitCode);
    expect(result.signal).toBe(recording.signal); expect(result.stderr).toBe("");
    expect(result.stdout).toBe(readFileSync(join(fixtures, "codex-initial.pane.txt"), "utf8"));
    expect(readFileSync(lastMessage, "utf8")).toBe(recording.nativeLastMessage);
    expect(readFileSync(lastMessage + ".stdin", "utf8")).toBe("Package fixture.\n");
    expect(readFileSync(thread, "utf8")).toBe("00000000-0000-4000-8000-000000000002");
    expect(existsSync(join(root, "usage.json"))).toBe(layout === "complete-package");
    expect(existsSync(join(root, "activity.jsonl"))).toBe(layout === "complete-package");
  });

  it("preserves output and failure status when sidecar creation fails", () => {
    const result = synthetic([{ type: "item.started", item: { id: "item-1", type: "command_execution", command: "fixture", status: "in_progress" } }],
      "process.exitCode = 7;", "/dev/null/last-message.txt");
    expect(result.status).toBe(7); expect(result.signal).toBeNull(); expect(result.stderr).toBe("");
    expect(result.stdout).toBe("[command] fixture\n");
  });
});
