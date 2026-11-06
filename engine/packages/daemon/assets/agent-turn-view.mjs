// MVP — the readable view of one headless turn.
//
// `claude -p` streams only in `--output-format stream-json`, and that mode prints one JSON
// object per line. Measured on the installed 2.1.296 build: `text` prints nothing until the
// turn ends, and `stream-json` without `--verbose` is refused. The owner's decision is that a
// turn is watchable while it runs, so this sits between the client and the seat's pane and
// turns each event into the line a person would have read.
//
// It is deliberately not a second client: it forwards stdin, inherits stderr, and exits with
// the client's own status. A client killed by a signal re-raises that signal, so the pane
// records a signal rather than inventing a number — the completion sweep's classifier reads
// that difference and must keep seeing it.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
// The two options the launcher may put in front of the client: where this turn's final message
// is recorded, and where the client's own thread id is. They are arguments rather than
// environment variables because the pane's shell runs with the seat's PATH, and an ordinary
// command line needs nothing found on it.
let resultFile, threadIdFile;
for (;;) {
  if (argv[0] === "--result-file" && argv.length >= 2) { resultFile = argv.splice(0, 2)[1]; continue; }
  if (argv[0] === "--thread-id-file" && argv.length >= 2) { threadIdFile = argv.splice(0, 2)[1]; continue; }
  break;
}
const [command, ...args] = argv;
if (!command) {
  process.stderr.write("agent-turn-view: no client command\n");
  process.exit(2);
}

// The `result` event's own text, written when the event arrives, so a reader of the turn's end
// reads the client's answer rather than re-parsing the pane's scrollback. Codex writes the same
// file through its own `-o`, so one file is the final message for either client. A failed write
// is reported on stderr and does not change the turn's outcome; the pane output is unaffected.
function recordResult(text) {
  if (!resultFile || typeof text !== "string" || !text) return;
  try {
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, text, { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`agent-turn-view: could not record the turn's result: ${error.message}\n`);
  }
}

// The installed package carries both assets and compiled domain code. Missing telemetry support
// disables only the sidecars; the native command, pane rendering and failure result remain intact.
let telemetry = null;
try {
  const [{ createTurnTelemetry }, { redactTranscriptContent }] = await Promise.all([
    import("./agent-turn-telemetry.mjs"), import("../dist/domain/transcript-redaction.js"),
  ]);
  telemetry = createTurnTelemetry(resultFile, args, redactTranscriptContent);
} catch { /* Telemetry is best-effort, including during source-only execution before a build. */ }

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
let observedThread = false;

/** One assistant text block, one tool call, or one provider error — never raw JSON. */
function render(line) {
  let event;
  try { event = JSON.parse(line); } catch { process.stdout.write(line + "\n"); return; }
  telemetry?.observe(event);
  if (event.type === "thread.started") {
    if (!observedThread) {
      observedThread = true;
      if (threadIdFile && typeof event.thread_id === "string") writeFileSync(threadIdFile, event.thread_id, { mode: 0o600 });
    }
    return;
  }
  if (event.type === "turn.started" || event.type === "turn.completed") {
    process.stdout.write(event.type === "turn.started" ? "[turn] Started\n" : "[turn] Completed\n");
    return;
  }
  if (event.type === "error" || event.type === "turn.failed") {
    process.stdout.write(`Error: ${event.message ?? event.error?.message ?? "The turn failed"}\n`);
    return;
  }
  const item = event.item;
  if (event.type === "item.started" && item?.type === "command_execution") {
    process.stdout.write(`[command] ${item.command}\n`);
    return;
  }
  if (event.type === "item.completed" && item) {
    if ((item.type === "agent_message" || item.type === "reasoning") && item.text) {
      process.stdout.write(item.text.trimEnd() + "\n");
    } else if (item.type === "command_execution") {
      if (item.aggregated_output) process.stdout.write(item.aggregated_output.trimEnd() + "\n");
      process.stdout.write(`[command] exit ${item.exit_code ?? item.status}\n`);
    } else if (item.type === "file_change") {
      for (const change of item.changes ?? []) process.stdout.write(`[file] ${change.kind} ${change.path}\n`);
    } else if (item.type === "mcp_tool_call") {
      process.stdout.write(`[tool] ${item.server}/${item.tool}: ${item.status}\n`);
    } else if (item.type === "web_search") {
      process.stdout.write(`[search] ${item.query}\n`);
    }
    return;
  }
  if (event.type === "assistant") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text) process.stdout.write(block.text.trimEnd() + "\n");
      else if (block.type === "tool_use") process.stdout.write(`[tool] ${block.name} ${JSON.stringify(block.input ?? {})}\n`);
    }
    return;
  }
  // A retry is the one failure the client survives; it is worth watching and it reads as the
  // terminal error line the classifier's fingerprints expect.
  if (event.type === "system" && event.subtype === "api_retry") {
    process.stdout.write(`API Error: ${event.error ?? "the provider failed"}; retrying (${event.attempt}/${event.max_retries})\n`);
    return;
  }
  // The turn's own answer, or its own fatal error. Claude prints a provider failure as the
  // result, so this is the line the pane keeps for the tail the classifier reads.
  if (event.type === "result" && typeof event.result === "string" && event.result) {
    recordResult(event.result);
    process.stdout.write(event.result.trimEnd() + "\n");
  }
}

let pending = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  pending += chunk;
  for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);
    if (line) render(line);
  }
});

child.on("close", (code, signal) => {
  if (pending.trim()) render(pending.trim());
  telemetry?.finish();
  if (signal) {
    // Re-raise, so the pane's exit status says "signalled" exactly as the client's would.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on("error", error => {
  telemetry?.finish();
  // A client that is not installed is reported the way a shell reports it, because that is what
  // happened and because it is the line the completion sweep's classifier names as a missing
  // executable. A wrapper that printed its own vocabulary would leave the attempt unclassified.
  const missing = error.code === "ENOENT";
  process.stderr.write(missing ? `Error: ${command}: command not found\n` : `Error: ${error.message}\n`);
  process.exit(missing ? 127 : 1);
});
