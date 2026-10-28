import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOGS, displayWidth } from "@openrig/i18n";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle } from "../src/theme.js";

const sizes = [[160, 46], [120, 36], [90, 30], [150, 22]] as const;
for (const language of ["zh-CN", "en"] as const) {
  describe(language, () => {
    it.each(sizes)("keeps the labeled shell within %i x %i cells", (cols, rows) => {
      const snapshot = demoSnapshot(true);
      const view = createViewState({ instanceId: "team", team: { language }, getSnapshot: () => snapshot });
      expect(view.get().team?.language).toBe(language);
      for (const page of ["tasks", "details", "agents", "reviews", "logs"] as const) {
        const state = { ...view.get(), team: { ...view.get().team!, page } };
        const screen = renderScreen(state, snapshot, { cols, rows, nowMs: 0 });
        expect(screen.lines).toHaveLength(rows);
        expect(screen.lines.every(line => displayWidth(line) === cols)).toBe(true);
        expect(screen.lines[0]).toContain(language === "en" ? "SAMPLE DATA" : "\u793a\u4f8b\u6570\u636e");
        expect(screen.lines.join("\n")).toContain(CATALOGS[language]["team.awaitingDecision"]);
        expect(screen.hitMap).toEqual([]);
        expect(screen.commandMotionActive).not.toBe(true);
        expect(stylizeLines(screen, createStyle("truecolor")).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(screen.lines);
      }
    });
  });
}

it("keeps all detail and console tabs available in the presentation state", () => {
  const snapshot = demoSnapshot(true);
  const state = createViewState({ instanceId: "tabs", team: { language: "en" }, getSnapshot: () => snapshot }).get();
  for (const detailTab of ["details", "diff", "tests", "reviews", "commits", "discussion"] as const) {
    const screen = renderScreen({ ...state, team: { ...state.team!, page: "details", detailTab } }, snapshot, { cols: 90, rows: 30 });
    expect(screen.lines.join("\n")).toContain(CATALOGS.en[`team.${detailTab}`]);
    const content = detailTab === "details" ? snapshot.team!.tasks[0]!.description : detailTab === "reviews" ? ["Unavailable"] : snapshot.team!.tasks[0]![detailTab];
    expect(screen.lines.join("\n")).toContain(typeof content === "string" ? content : content[0] ?? "Unavailable");
  }
  for (const consoleTab of ["terminal", "logs", "reviews", "messages"] as const) {
    const screen = renderScreen({ ...state, team: { ...state.team!, consoleTab } }, snapshot, { cols: 160, rows: 46 });
    expect(screen.lines.join("\n")).toContain(CATALOGS.en[`team.${consoleTab}`]);
    expect(screen.lines.join("\n")).toContain(consoleTab === "logs" ? "ERROR err TASK-001/attempt-1" : consoleTab === "messages" ? "Builder: awaiting independent verification." : "Unavailable");
  }
});

it("never replaces missing live data with samples or zero-cost success", () => {
  const state = createViewState({ instanceId: "empty", team: { language: "en", runId: "run-17" } }).get();
  const text = renderScreen(state, emptySnapshot(), { cols: 120, rows: 36 }).lines.join("\n");
  expect(text).toContain("run-17");
  expect(text).toContain("Unavailable");
  expect(text).not.toMatch(/SAMPLE DATA|\$0|Healthy/);
  expect(text).not.toContain(CATALOGS.en["team.awaitingDecision"]);
});

it("shows every queue and derived status label without clipping its meaning", () => {
  const snapshot = demoSnapshot(true);
  for (const task of snapshot.team!.tasks) if (task.state !== "in-progress") task.reviews = [{ reviewer: "Stale", state: "changes-required", finding: null }];
  const state = createViewState({ instanceId: "states", team: { language: "en" }, getSnapshot: () => snapshot }).get();
  const text = renderScreen(state, snapshot, { cols: 90, rows: 30 }).lines.join("\n");
  for (const code of ["pending", "in-progress", "done", "blocked", "failed", "denied", "canceled", "handed-off"] as const)
    expect(text).toContain(CATALOGS.en[`status.queue.${code}`]);
  for (const code of ["inReview", "changesRequested", "testing"] as const)
    expect(text).toContain(CATALOGS.en[`team.${code}`]);
  expect(text.split("\n").filter(line => line.includes("TASK-")).join("\n")).not.toContain("[?]");
});

it.each(sizes)("keeps both agent status labels visible at %i x %i", (cols, rows) => {
  const snapshot = demoSnapshot(true);
  const state = createViewState({ instanceId: "agents", team: { language: "en" }, getSnapshot: () => snapshot }).get();
  const text = renderScreen({ ...state, team: { ...state.team!, page: "agents" } }, snapshot, { cols, rows }).lines.join("\n");
  expect(text).toContain("Busy / In progress");
  expect(text).toContain("Offline / Needs attention");
});

for (const language of ["zh-CN", "en"] as const) {
  it.each(sizes.flatMap(([cols, rows]) => [[cols, rows, true], [cols, rows, false]] as const))(`runs the real ${language} entrypoint at %i x %i (sample: %s) without connections or controls`, async (cols, rows, sample) => {
    const home = await mkdtemp(join(tmpdir(), "t015-entry-"));
    await writeFile(join(home, "config.json"), JSON.stringify({ ui: { language } }));
    const env = { ...process.env, HOME: home, OPENRIG_HOME: home, OPENRIG_UI_LANGUAGE: "",
      OPENRIG_TUI_CLI_ENTRY: fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url)) };
    const guard = `import net from 'node:net'; process.stdout.columns=${cols}; process.stdout.rows=${rows};
      net.Server.prototype.listen=net.Socket.prototype.connect=()=>{throw new Error('unexpected connection');};
      globalThis.fetch=()=>{throw new Error('unexpected request');};`;
    const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url)), socket = join(home, "control.sock");
    const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(guard)}`, entry, "--team", ...(sample ? ["--demo"] : ["--run", "run-17"]), "--no-color", "--socket", socket], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    const ended = once(child, "exit");
    child.stderr.on("data", chunk => { errors += String(chunk); });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("\x1b[?2026l")) resolve(); });
      child.once("exit", () => reject(new Error(errors || "No initial frame")));
    });
    try {
      await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("No initial frame")), 5000).unref())]);
      expect(output).toContain(CATALOGS[language][sample ? "team.sample" : "team.unavailable"]);
      if (!sample) { expect(output).toContain("run-17"); expect(output).not.toContain(CATALOGS[language]["team.sample"]); }
      child.stdin.write("retry TASK-001\naxtL\n");
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(child.exitCode).toBeNull();
      await expect(access(socket)).rejects.toThrow();
      child.stdin.write("q");
      expect(await ended).toEqual([0, null]);
      expect(output).toContain("\x1b[?25h\x1b[?1049l");
      expect(errors).not.toContain("unexpected");
    } finally { child.kill("SIGKILL"); await ended; await rm(home, { recursive: true, force: true }); }
  }, 10000);
}

for (const language of ["zh-CN", "en"] as const) {
  it.each(sizes)(`preserves ${language} compact metadata and every workflow stage through presentation offsets at %i x %i`, (cols, rows) => {
    const snapshot = demoSnapshot(true), data = snapshot.team!, catalog = CATALOGS[language];
    data.activity[0]!.text = "ACTIVITY-PREFIX activity-proof-suffix";
    const base = createViewState({ instanceId: "fidelity", team: { language }, getSnapshot: () => snapshot }).get();
    const frames: string[] = [], workflow: string[] = [], plan: string[] = [];
    for (let offset = 0; offset < 28; offset++) {
      const offsets = { needs: offset, agents: offset, activity: offset, system: offset, plan: offset, workflow: offset };
      for (const sideTab of ["agents", "system", "activity"] as const) {
        const screen = renderScreen({ ...base, team: { ...base.team!, page: "agents", sideTab, offsets } }, snapshot, { cols, rows });
        expect(screen.lines.every(line => displayWidth(line) === cols)).toBe(true);
        frames.push(screen.lines.join("\n"));
        if (cols < 100 || rows < 24) { workflow.push(screen.lines[3]!); plan.push(screen.lines[2]!); }
      }
    }
    const text = frames.join("\n");
    expect(text).toContain("Reviewer B");
    expect(text).toContain("activity-proof-suffix");
    if (cols >= 100 && rows >= 24) expect(text).toContain("presentation");
    if (cols < 100 || rows < 24) {
      for (const stage of data.stages) expect(workflow.join("\n")).toContain(catalog[`team.${stage.key}` as keyof typeof catalog]);
      for (const value of [data.plan!.title, data.plan!.digest, data.plan!.approvedAt]) expect(plan.join("\n")).toContain(value);
    }
  });

  it.each(sizes)(`shows actual ${language} console content through direct presentation state at %i x %i`, (cols, rows) => {
    const snapshot = demoSnapshot(true), catalog = CATALOGS[language];
    const state = createViewState({ instanceId: "console", team: { language }, getSnapshot: () => snapshot }).get();
    for (const consoleTab of ["terminal", "logs", "reviews", "messages"] as const) {
      const screen = renderScreen({ ...state, team: { ...state.team!, consoleTab, consoleExpanded: true } }, snapshot, { cols, rows });
      const text = screen.lines.join("\n");
      expect(text).toContain(consoleTab === "logs" ? "ERROR err TASK-001/attempt-1" : consoleTab === "messages"
        ? "Builder: awaiting independent verification." : catalog["team.unavailable"]);
      expect(screen.hitMap).toEqual([]);
    }
  });
}

for (const language of ["zh-CN", "en"] as const) {
  it.each([...sizes, [140, 24], [140, 30], [140, 40], [160, 30], [160, 24], [120, 24], [120, 28]])(`bounds the ${language} body viewport at %i x %i`, (cols, rows) => {
    const snapshot = demoSnapshot(true), catalog = CATALOGS[language];
    const state = createViewState({ instanceId: "viewport", team: { language }, getSnapshot: () => snapshot }).get();
    const render = (body: number) => renderScreen({ ...state, team: { ...state.team!, offsets: { body } } }, snapshot, { cols, rows }).lines;
    const frames = Array.from({ length: 41 }, (_, offset) => render(offset));
    for (const frame of frames) {
      expect(frame).toHaveLength(rows);
      expect(frame.every(line => displayWidth(line) === cols)).toBe(true);
      expect(frame.slice(-7)).toEqual(frames[0]!.slice(-7));
    }
    expect(render(-9)).toEqual(frames[0]);
    expect(render(Number.NaN)).toEqual(frames[0]);
    expect(render(1000)).toEqual(frames[40]);
    if (cols === 120 && rows === 28) {
      expect(frames[0]).not.toEqual(frames[1]);
      expect(render(2)).toEqual(frames[1]);
      expect(frames[1]!.join("\n")).toContain(catalog["team.details"]);
    }
    const text = frames.flat().join("\n"), initial = frames[0]!.join("\n");
    if (cols >= 100 && rows >= 24) {
      for (const key of ["plan", "workflow", "tasks", "details", "needs", "agents", "console"] as const)
        expect(text.toLocaleUpperCase()).toContain(catalog[`team.${key}`].toLocaleUpperCase());
      if (cols >= 140) for (const key of ["system", "activity"] as const)
        expect(text.toLocaleUpperCase()).toContain(catalog[`team.${key}`].toLocaleUpperCase());
    }
    if (sizes.some(size => size[0] === cols && size[1] === rows) || rows === 40) {
      expect(render(1000)).toEqual(frames[0]);
      expect(initial).not.toContain(catalog["team.above"]);
      expect(initial).not.toContain(catalog["team.below"]);
    } else {
      expect(initial).toContain(catalog["team.below"]);
      expect(frames[40]!.join("\n")).toContain(catalog["team.above"]);
    }
    if (cols === 140 && rows === 30) {
      const needs = snapshot.team!.needs;
      snapshot.team!.needs = [];
      expect(render(1000)).toEqual(render(0));
      expect(render(0).join("\n")).not.toContain(catalog["team.below"]);
      snapshot.team!.needs = needs;
      expect(render(1000)).toEqual(frames[40]);
    }
  });
}

it("keeps a criterion unavailable until its pass has evidence", () => {
  const snapshot = demoSnapshot(true);
  snapshot.team!.tasks[0]!.criteria = [{ text: "UNVERIFIED", state: "passed", evidence: null }];
  const state = createViewState({ instanceId: "criteria", team: { language: "en" }, getSnapshot: () => snapshot }).get();
  const text = renderScreen({ ...state, team: { ...state.team!, page: "details" } }, snapshot, { cols: 90, rows: 30 }).lines.join("\n");
  expect(text).toContain("UNVERIFIED · Unavailable");
  expect(text).not.toContain("Passed");
});

it("does not use a following flag as the explicit run identity", () => {
  const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const result = spawnSync(process.execPath, [entry, "--team", "--run", "--no-color"], {
    input: "q", encoding: "utf8", timeout: 10000,
    env: { ...process.env, OPENRIG_UI_LANGUAGE: "en", OPENRIG_TUI_CLI_ENTRY: cli },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(CATALOGS.en["team.noRun"]);
  expect(result.stdout).not.toContain("--no-color");
});
