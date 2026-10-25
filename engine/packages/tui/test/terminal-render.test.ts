import ts from "typescript";
import { readFileSync } from "node:fs";
import { createInputDecoder } from "../src/input.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFrameWriter } from "../src/main.js";
import { displayWidth } from "@openrig/i18n";
import { createIcons, padDisplay, truncateDisplay } from "../src/icons.js";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createStyle, detectColorMode, type Token } from "../src/theme.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { stylizeLines } from "../src/stylize.js";

const modes = ["truecolor", "256", "16", "none"] as const;
const palette = [
  ["inkText", "201;209;217", 252, 37],
  ["inkDim", "139;148;158", 246, 90],
  ["inkMute", "110;118;129", 243, 90],
  ["inkLine", "48;54;61", 237, 90],
  ["ochre", "210;153;34", 178, 33],
  ["cinnabar", "248;81;73", 203, 31],
  ["emerald", "63;185;80", 71, 32],
] as const;
afterEach(() => vi.useRealTimers());

it.each(palette)("paints %s at each specified color depth", (token, rgb, indexed, basic) => {
  for (const [i, code] of [`38;2;${rgb}`, `38;5;${indexed}`, `${basic}`].entries())
    expect(createStyle(modes[i]!).paint(token as Token, "X")).toBe(`\x1b[${code}mX\x1b[0m`);
});
it.each([["inkSurface", "22;27;34", 234, 49], ["inkSelection", "38;79;120", 24, 44]] as const)("paints %s as the specified background", (token, rgb, indexed, basic) => {
  for (const [i, code] of [`38;2;201;209;217;48;2;${rgb}`, `38;5;252;48;5;${indexed}`, `37;${basic}`].entries())
    expect(createStyle(modes[i]!).paint("inkText" as Token, "X", { bg: token as Token })).toBe(`\x1b[${code}mX\x1b[0m`);
});
it("never paints the canvas and keeps colorless selection legible without color SGR", () => {
  for (const mode of modes) expect(createStyle(mode).paint("inkCanvas" as Token, "X")).toBe("X");
  for (const env of [{ NO_COLOR: "1", TERM: "xterm-256color" }, { TERM: "dumb" }]) {
    const style = createStyle(detectColorMode(env));
    for (const [token] of palette) expect(style.paint(token as Token, "X")).toBe("X");
    expect(style.paint("inkText" as Token, "X", { bg: "inkSelection" as Token })).toBe("\x1b[7mX\x1b[0m");
    expect(style.paint("inkText" as Token, "X", { bg: "inkCanvas" as Token })).toBe("X");
  }
});
it("preserves the pre-change legacy view bytes and every legacy palette value", () => {
  vi.useFakeTimers(); vi.setSystemTime(1700000000000);
  const snapshot = demoSnapshot(), state = createViewState({ instanceId: "t", getSnapshot: () => snapshot });
  const screen = renderScreen(state.get(), snapshot, { cols: 140, rows: 34, nowMs: Date.now() });
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  expect(sha(modes.map(mode => stylizeLines(screen, createStyle(mode))))).toBe("da4d6058b6c116f2a64fabb6d79f6717606427d01e30e3655c3204dc9d60651a");
  const legacy: Token[] = ["accent", "accentBright", "warn", "error", "ok", "info", "dim", "bright", "chrome", "selection", "actActive", "actIdle", "actDetached", "actAttention", "clawd", "clawdEye", "markInk", "markBg", "codexBlue"];
  expect(sha(modes.map(mode => legacy.map(token => createStyle(mode).paint(token, "X", { bold: true, inverse: true, bg: token, blink: true }))))).toBe("f45d1eb3396dd8d737aab7a9fe2c97b32e23c6492d3cbc2e6063a310117607f2");
});

it("requires an explicit Nerd Font opt-in and never emits PUA characters in text mode", () => {
  const labels = "[Git]|[Dir]|[AI]|[Lead]|[Dash]|[Task]|[Rev]|[Log]|[Doc]|[Set]|[OK]|[Err]|[!]|[Blk]|[Run]|[ ]|[!!]|[?]|[Lock]".split("|");
  for (const env of [{}, { NERD_FONT: "0" }, { NERD_FONT: "1", TERM: "dumb" }]) {
    const values = Object.values(createIcons(env));
    expect(values).toEqual(labels);
    expect(values.join("")).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{10FFFF}]/u);
  }
  for (const NERD_FONT of ["1", "true"]) {
    const values = Object.values(createIcons({ NERD_FONT }));
    expect(values).toEqual(Array.from("\uf126\uf07b\uf544\uf0e8\uf0e4\uf0ae\uf06e\uf15c\uf02d\uf013\uf00c\uf00d\uf071\uf05e\uf110\uf10c\uf0f3\uf128\uf023"));
    expect(values.map(displayWidth)).toEqual(Array(19).fill(1));
  }
});
it("pads and truncates mixed-width labels without splitting a wide or supplementary glyph", () => {
  expect(displayWidth("\u6587")).toBe(2);
  for (const text of ["A\u6587B", "\uf126\u6587", "\u{F0001}\u6587", "e\u0301\u6587", createIcons({}).lead])
    for (const width of [0, 1, 2, 3, 8]) expect(displayWidth(padDisplay(truncateDisplay(text, width), width))).toBe(width);
  expect(truncateDisplay("\u6587A", 2)).toBe("\u2026");
  expect(truncateDisplay("\u{F0001}\u6587", 2)).toBe("\u{F0001}\u2026");
  expect(truncateDisplay("e\u0301\u6587", 2)).toBe("e\u0301\u2026");
});

it("writes synchronized row deltas, invalidates resumed frames, and cancels pending output", () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  let rows = ["one", "two"]; const output: string[] = [];
  const writer = createFrameWriter(() => rows, bytes => output.push(bytes));
  const frame = (body: string) => `\x1b[?2026h\x1b[?7l${body}\x1b[?7h\x1b[?2026l`;
  writer.request();
  expect(output).toEqual([frame("\x1b[1;1H\x1b[2Kone\x1b[2;1H\x1b[2Ktwo")]);
  writer.request(); vi.advanceTimersByTime(33); expect(output).toHaveLength(1);
  rows = ["one", "new"]; writer.request(); vi.advanceTimersByTime(33);
  expect(output.at(-1)).toBe(frame("\x1b[2;1H\x1b[2Knew"));
  rows = ["one"]; writer.request(); vi.advanceTimersByTime(33);
  expect(output.at(-1)).toBe(frame("\x1b[2;1H\x1b[2K"));
  writer.invalidate(); writer.request(); vi.advanceTimersByTime(33);
  expect(output.at(-1)).toBe(frame("\x1b[1;1H\x1b[2Kone"));
  rows = ["pending"]; writer.request(); writer.close(); writer.request(); vi.advanceTimersByTime(100);
  expect(output).toHaveLength(4); expect(output.join("")).not.toMatch(/\x1b\[[23]J/);
});
it("coalesces 1,000 events before layout at no more than one frame per 33 ms and retains the last event", () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  let event = 0; const output: Array<{ at: number; bytes: string }> = [];
  const render = vi.fn(() => [String(event)]);
  const writer = createFrameWriter(render, bytes => output.push({ at: performance.now(), bytes }));
  for (let i = 0; i < 1000; i++) { event = i; writer.request(); vi.advanceTimersByTime(1); }
  vi.advanceTimersByTime(33); writer.close();
  expect(render.mock.calls.length).toBeLessThanOrEqual(32);
  expect(output.every((row, i) => i === 0 || row.at - output[i - 1]!.at >= 33)).toBe(true);
  expect(output.at(-1)?.bytes).toContain("999");
});
it("decodes Ctrl+C across chunks without confusing bracketed paste with an interrupt", () => {
  for (const chunks of [["\x03"], ["\x03\x03"], ["ab\x03"], ["\x1b", "\x03"]]) {
    const decoder = createInputDecoder(), events = [...chunks.flatMap(chunk => decoder.write(chunk)), ...decoder.flush()];
    expect(events.filter(event => event.type === "ctrl-c")).toHaveLength(chunks[0] === "\x03\x03" ? 2 : 1);
  }
  const decoder = createInputDecoder();
  for (const chunk of ["\x1b[20", "0~a", "\x03", "b"]) expect(decoder.write(chunk)).toEqual([]);
  expect(decoder.write("\x1b[201~\x03")).toEqual([{ type: "paste", text: "a b" }, { type: "ctrl-c" }]);
});
it("repaints both terminal-return call sites through their actual invalidating callback", () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [], functions: ts.FunctionDeclaration[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node)) functions.push(node);
    if (ts.isCallExpression(node) && ["runCopySession", "runSpecLaunch"].includes(node.expression.getText(source))) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source); expect(calls).toHaveLength(2);
  const callbacks = calls.map(call => (call.arguments[0] as ts.ObjectLiteralExpression).properties.find(p => p.name?.getText(source) === "draw")!);
  expect(callbacks.every(ts.isPropertyAssignment)).toBe(true);
  const names = callbacks.map(property => (property as ts.PropertyAssignment).initializer.getText(source));
  expect(new Set(names).size).toBe(1); expect(names[0]).not.toBe("draw");
  const helper = functions.find(fn => fn.name?.text === names[0])!; expect(helper).toBeDefined();
  const output: string[] = [], writer = createFrameWriter(() => ["one", "two"], bytes => output.push(bytes));
  writer.request(); const initial = output[0];
  const invoke = new Function("frameWriter", "draw", ts.transpileModule(helper.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + `;${names[0]}();`);
  invoke(writer, () => writer.request()); vi.advanceTimersByTime(33); writer.close();
  expect(output).toEqual([initial, initial]);
});
it.each(["input", "coalesced", "typed", "paste", "SIGINT", "error"])("restores the real TUI screen and cursor on %s exit", async mode => {
  const root = await mkdtemp(join(tmpdir(), "t050-")), cli = join(root, "rig.mjs");
  await writeFile(cli, 'console.log(\'{"value":"UTC"}\');');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENRIG_|RIGGED_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: root, OPENRIG_HOME: root, OPENRIG_TUI_CLI_ENTRY: cli, OPENRIG_TUI_SOCKET: join(root, "s") });
  const child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent('process.on("message", () => { throw new Error("terminal-fixture"); });'), fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--demo"], { env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const ended = once(child, "exit"); let output = "", errors = "";
  child.stderr!.on("data", chunk => { errors += String(chunk); });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", chunk => { output += String(chunk); if (output.includes("\x1b[?2026l")) resolve(); });
    child.once("exit", () => reject(new Error(errors || "TUI exited before its first frame")));
  });
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(errors || "No initial frame")), 5000).unref())]);
    if (mode === "paste") {
      child.stdin!.write("\x1b[200~"); await new Promise(resolve => setTimeout(resolve, 20));
      child.stdin!.write("\x03"); await new Promise(resolve => setTimeout(resolve, 75));
      expect(child.exitCode).toBeNull(); child.stdin!.write("\x1b[201~");
    }
    if (mode === "error") child.send("fail"); else if (mode === "SIGINT") child.kill("SIGINT");
    else child.stdin!.write(mode === "coalesced" ? "\x03\x03" : mode === "typed" ? "ab\x03" : "\x03");
    const [code, signal] = await ended;
    expect({ code, signal }).toEqual({ code: mode === "error" ? 1 : 0, signal: null });
    expect(output).toContain("\x1b[?1049h"); expect(output).toContain("\x1b[?25h\x1b[?1049l");
  } finally { child.kill("SIGKILL"); await ended; await rm(root, { recursive: true, force: true }); }
}, 10000);
