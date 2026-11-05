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
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const threadIdFile = argv[0] === "--thread-id-file" ? argv.splice(0, 2)[1] : undefined;
const [command, ...args] = argv;
if (!command) {
  process.stderr.write("agent-turn-view: no client command\n");
  process.exit(2);
}

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
let observedThread = false;

/** One assistant text block, one tool call, or one provider error — never raw JSON. */
function render(line) {
  let event;
  try { event = JSON.parse(line); } catch { process.stdout.write(line + "\n"); return; }
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
  if (signal) {
    // Re-raise, so the pane's exit status says "signalled" exactly as the client's would.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on("error", error => {
  // A client that is not installed is reported the way a shell reports it, because that is what
  // happened and because it is the line the completion sweep's classifier names as a missing
  // executable. A wrapper that printed its own vocabulary would leave the attempt unclassified.
  const missing = error.code === "ENOENT";
  process.stderr.write(missing ? `Error: ${command}: command not found\n` : `Error: ${error.message}\n`);
  process.exit(missing ? 127 : 1);
});
