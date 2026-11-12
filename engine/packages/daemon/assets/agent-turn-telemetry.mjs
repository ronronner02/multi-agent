import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sessionId = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;

/** Public text and activity state only; reasoning bodies and tool results never enter this snapshot. */
function createTurnProgress(directory, redact) {
  const path = join(directory, "progress.json"), blocks = new Map();
  let status = "working", sequence = 0, nextBlock = 0, message = "initial", truncated = false;
  let previous = "", timer = null, lastWrite = 0;
  const publish = () => {
    timer = null;
    try {
      let remaining = 65_536;
      const visible = [...blocks.values()].map(block => {
        // Hold an unfinished ASCII token until its boundary, so split credentials are redacted together.
        const text = block.complete ? block.text : block.text.replace(/[A-Za-z0-9._~+/=-]+$/, "");
        const cleaned = redact(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
        if (cleaned.length > remaining) truncated = true;
        const bounded = cleaned.slice(0, remaining); remaining -= bounded.length;
        return { id: block.id, text: bounded, complete: block.complete };
      });
      const body = JSON.stringify({ status, blocks: visible, truncated });
      if (body === previous) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = path + ".tmp";
      writeFileSync(temporary, JSON.stringify({ version: 1, sequence: ++sequence, at: new Date().toISOString(),
        status, blocks: visible, truncated }) + "\n", { mode: 0o600 });
      renameSync(temporary, path); previous = body; lastWrite = Date.now();
    } catch { /* A missing progress snapshot does not change native execution. */ }
  };
  const schedule = () => {
    if (timer) return;
    if (Date.now() - lastWrite >= 80) publish();
    else { timer = setTimeout(publish, 80); timer.unref(); }
  };
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    publish();
  };
  const put = (key, text, append = false, complete = false) => {
    if (typeof text !== "string") return;
    const old = blocks.get(key);
    if (append && old?.clipped) return;
    const combined = (append ? old?.text ?? "" : "") + text, clipped = combined.length > 65_536;
    if (clipped) truncated = true;
    blocks.set(key, { id: old?.id ?? `text-${++nextBlock}`, text: clipped ? redact(combined).slice(0, 65_536) : combined,
      complete: complete && !clipped, clipped });
    if (blocks.size > 32) { blocks.delete(blocks.keys().next().value); truncated = true; }
    status = "responding";
  };
  return {
    flush,
    observe(event) {
      const item = event.item;
      if (["item.started", "item.updated", "item.completed"].includes(event.type) && item) {
        if (item.type === "agent_message" && typeof item.id === "string") {
          put(`codex:${item.id}`, item.text, false, event.type === "item.completed");
        } else status = item.type === "reasoning" ? "thinking" : "working";
      }
      if (event.type === "stream_event" && event.event) {
        const part = event.event;
        if (part.type === "message_start") { message = part.message?.id ?? `message-${nextBlock + 1}`; status = "working"; }
        const key = `claude:${message}:${part.index}`;
        if (part.type === "content_block_start") {
          if (part.content_block?.type === "text") put(key, part.content_block.text ?? "");
          else status = part.content_block?.type === "thinking" ? "thinking" : "working";
        }
        if (part.type === "content_block_delta") {
          if (part.delta?.type === "text_delta") put(key, part.delta.text, true);
          else status = part.delta?.type === "thinking_delta" ? "thinking" : "working";
        }
        if (part.type === "content_block_stop" && blocks.has(key) && !blocks.get(key).clipped) blocks.get(key).complete = true;
      }
      if (event.type === "assistant") {
        const id = event.message?.id ?? event.uuid ?? message;
        for (const [index, block] of (event.message?.content ?? []).entries()) {
          if (block.type === "text") put(`claude:${id}:${index}`, block.text, false, true);
          else if (block.type === "thinking") status = "thinking";
          else if (block.type === "tool_use") status = "working";
        }
      }
      if (event.type === "result") {
        if (typeof event.result === "string" && event.result) {
          const texts = [...blocks.values()].map(block => block.text), result = event.result.trim();
          if (![texts.at(-1)?.trim(), texts.join("").trim(), texts.join("\n\n").trim()].includes(result)) put("result", event.result, false, true);
        }
        status = event.is_error ? "failed" : "completed";
      }
      if (event.type === "turn.completed") status = "completed";
      if (event.type === "error" || event.type === "turn.failed") status = "failed";
      schedule();
    },
    finish() {
      if (status !== "completed" && status !== "failed") status = "stopped";
      flush();
    },
  };
}

/** Sidecars are observations only. Every entrypoint isolates its failures from the native turn. */
export function createTurnTelemetry(resultFile, args, redact) {
  if (!resultFile) return null;
  const directory = dirname(resultFile), activityPath = join(directory, "activity.jsonl"), usagePath = join(directory, "usage.json");
  const clean = (value, limit = 512) => redact(String(value ?? "")).slice(0, limit);
  const flag = args.findIndex(arg => arg === "-m" || arg === "--model");
  let model = flag >= 0 ? clean(args[flag + 1], 128) || null : null;
  const resumed = args.includes("--resume") || (args.includes("exec") && args.includes("resume"));
  let client = null, nativeSessionId = null, usage = null, seq = 0, calls = 0, finished = false;
  const open = new Map(), settled = new Set();
  const progress = createTurnProgress(directory, redact);
  const quiet = action => { try { action(); } catch { /* Observations never change pane output or native status. */ } };
  const emit = (call, status) => quiet(() => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(activityPath, JSON.stringify({ ...call, seq: ++seq, at: new Date().toISOString(), status }) + "\n", { mode: 0o600 });
  });
  function start(key, tool, summary) {
    if (finished || settled.has(key) || open.has(key)) return;
    const call = { id: `call-${++calls}`, tool: clean(tool, 128), summary: clean(summary) };
    open.set(key, call); emit(call, "running");
  }
  function end(key, status, tool, summary) {
    if (finished || settled.has(key)) return;
    const call = open.get(key) ?? { id: `call-${++calls}`, tool: clean(tool, 128), summary: clean(summary) };
    open.delete(key); settled.add(key); emit(call, status);
  }
  const codexCall = item => {
    if (item.type === "command_execution") return ["command_execution", item.command];
    if (item.type === "file_change") return ["file_change", (item.changes ?? []).map(change => `${change.kind} ${change.path}`).join("; ")];
    if (item.type === "mcp_tool_call") return [`${item.server}/${item.tool}`, JSON.stringify(item.arguments ?? {})];
    if (item.type === "web_search") return ["web_search", item.query];
    return null;
  };
  function observe(event) {
    if (finished) return;
    progress.observe(event);
    if (event.type === "thread.started") { client = "codex"; nativeSessionId ??= sessionId(event.thread_id); }
    if (event.type === "assistant" || event.type === "user" || event.type === "result") {
      client = "claude-code"; nativeSessionId ??= sessionId(event.session_id);
      if (event.message?.model) model = clean(event.message.model, 128);
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use" && typeof block.id === "string") start(block.id, block.name, JSON.stringify(block.input ?? {}));
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          // A result carries tool output, which is deliberately not retained in telemetry.
          if (open.has(block.tool_use_id)) end(block.tool_use_id, block.is_error ? "failed" : "completed");
        }
      }
    }
    if ((event.type === "item.started" || event.type === "item.completed") && event.item && typeof event.item.id === "string") {
      client = "codex";
      const item = event.item, call = codexCall(item);
      if (call) {
        if (event.type === "item.started") start(item.id, ...call);
        else end(item.id, item.status === "failed" || item.error != null || (item.exit_code != null && item.exit_code !== 0)
          ? "failed" : "completed", ...call);
      }
    }
    if (event.type === "result" && event.usage) {
      const u = event.usage;
      // Recorded resume: result.usage is this invocation; modelUsage instead carries session totals.
      usage = { mode: "turn", counts: { inputTokens: count(u.input_tokens), cacheReadInputTokens: count(u.cache_read_input_tokens),
        cacheWriteInputTokens: count(u.cache_creation_input_tokens), outputTokens: count(u.output_tokens),
        reasoningOutputTokens: count(u.output_tokens_details?.thinking_tokens) } };
    }
    if (event.type === "turn.completed" && event.usage) {
      client = "codex";
      const u = event.usage, input = count(u.input_tokens), read = count(u.cached_input_tokens), write = count(u.cache_write_input_tokens);
      usage = { mode: "cumulative", counts: {
        inputTokens: input !== null && read !== null ? count(input - read - (write ?? 0)) : null,
        cacheReadInputTokens: read, cacheWriteInputTokens: write, outputTokens: count(u.output_tokens),
        reasoningOutputTokens: count(u.reasoning_output_tokens) } };
    }
  }
  function finish() {
    if (finished) return;
    progress.finish();
    for (const [key] of open) end(key, "aborted");
    finished = true;
    quiet(() => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Atomic publication keeps a live reader from interpreting half-written JSON as final usage.
      const temporary = usagePath + ".tmp";
      writeFileSync(temporary, JSON.stringify({ version: 1, available: usage !== null, client, nativeSessionId, model, resumed,
        mode: usage?.mode ?? null, counts: usage?.counts ?? null,
        reason: usage === null ? "The native client did not report final usage." : null }) + "\n", { mode: 0o600 });
      renameSync(temporary, usagePath);
    });
  }
  return { observe: event => quiet(() => observe(event)), flush: () => quiet(progress.flush), finish: () => quiet(finish) };
}
