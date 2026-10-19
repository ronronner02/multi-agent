"use strict";
const fs = require("node:fs");
const net = require("node:net");
const { randomUUID } = require("node:crypto");

const SOCKET = "/run/multi-agent/mailbox.sock";
const ROOT = "/home/worker/.multi-agent/mailbox";
const BOOTSTRAP = ROOT + "/bootstrap.json";
const HANDOUTS = ROOT + "/handouts.json";
const FIELDS = ["authorization", "sessionId", "runId", "attemptId", "generation", "taskId", "capability"];

function readJson(path, maxBytes) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw new Error("Invalid private mailbox state");
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > maxBytes) throw new Error("Mailbox state exceeds its bound");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } finally { fs.closeSync(fd); }
}

function exchange(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET, () => socket.end(JSON.stringify(request) + "\n"));
    let bytes = Buffer.alloc(0);
    socket.setTimeout(2_000, () => socket.destroy(new Error("Mailbox request timed out")));
    socket.on("error", reject);
    socket.on("data", chunk => {
      if (bytes.length + chunk.length > 1_048_576) { socket.destroy(new Error("Mailbox response exceeds its bound")); return; }
      bytes = Buffer.concat([bytes, chunk]);
    });
    socket.on("end", () => {
      try {
        if (!bytes.length || bytes[bytes.length - 1] !== 10) throw new Error("Incomplete mailbox response");
        resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      } catch (error) { reject(error); }
    });
  });
}

function output(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(value) + "\n", error => error ? reject(error) : resolve());
  });
}

async function main() {
  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    if (input.length + chunk.length > 1_048_576) throw new Error("Hook input exceeds its bound");
    input = Buffer.concat([input, chunk]);
  }
  const event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  if (event.hook_event_name !== "PostToolUse") { await output({}); return; }
  const parent = fs.lstatSync(ROOT);
  if (!parent.isDirectory() || fs.realpathSync(ROOT) !== ROOT || parent.uid !== process.getuid()
    || (parent.mode & 0o7777) !== 0o700) {
    throw new Error("Invalid private mailbox directory");
  }
  const bootstrap = readJson(BOOTSTRAP, 8_192);
  const request = {};
  for (const field of FIELDS) {
    if (typeof bootstrap[field] !== "string" || !bootstrap[field] || bootstrap[field].length > 1_024) {
      throw new Error("Invalid mailbox bootstrap");
    }
    request[field] = bootstrap[field];
  }
  let previous = [];
  try {
    const state = readJson(HANDOUTS, 16_384);
    if (state.generation === bootstrap.generation && Array.isArray(state.messageIds)
      && state.messageIds.length <= 4 && state.messageIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 1_024)) {
      previous = state.messageIds;
    }
  } catch { /* Missing or interrupted consumer state causes redelivery, never fabricated consumption. */ }
  const response = await exchange({ ...request, operation: "channel", acknowledgedMessageIds: previous, limit: 4 });
  if (!response || response.ok !== true || !response.result) throw new Error("Mailbox context is not admitted");
  const result = response.result;
  if (!["pending", "empty", "delivered"].includes(result.status) || !Array.isArray(result.messageIds)
    || result.messageIds.length > 4 || result.messageIds.some(id => typeof id !== "string" || !id || id.length > 1_024)) {
    throw new Error("Invalid mailbox result");
  }
  const hook = result.hookOutput;
  if (hook !== null && (!hook || Object.keys(hook).length !== 1 || !hook.hookSpecificOutput
    || Object.keys(hook.hookSpecificOutput).sort().join(",") !== "additionalContext,hookEventName"
    || hook.hookSpecificOutput.hookEventName !== "PostToolUse" || typeof hook.hookSpecificOutput.additionalContext !== "string")) {
    throw new Error("Mailbox output is not context-only");
  }
  if (result.status === "delivered" ? hook === null || result.messageIds.length === 0
    : hook !== null || result.messageIds.length !== 0) throw new Error("Inconsistent mailbox context");
  await output(hook ?? {});
  if (result.status === "pending") return;
  // Save only after stdout drained. Lost output or state writes leave the durable message pending.
  const temporary = HANDOUTS + "." + process.pid + "." + randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify({ generation: bootstrap.generation, messageIds: result.messageIds }),
      { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, HANDOUTS);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* The atomic rename already removed this temporary name. */ }
  }
}

process.stdout.on("error", () => {});
const watchdog = setTimeout(() => { process.stderr.write("Mailbox context remains pending.\n"); process.exit(0); }, 3_000);
main().catch(() => { process.stderr.write("Mailbox context remains pending.\n"); }).finally(() => clearTimeout(watchdog));
