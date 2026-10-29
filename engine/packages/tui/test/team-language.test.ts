import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterfaceI18n } from "@openrig/i18n";
import { createTeamControls, createTuiLanguagePreference } from "../src/main.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { decodeInput } from "../src/input.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "t015-language-"));
  vi.stubEnv("OPENRIG_HOME", home);
  vi.stubEnv("OPENRIG_UI_LANGUAGE", "");
  vi.stubEnv("OPENRIG_TUI_CLI_ENTRY", fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url)));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

it("reads Chinese by default and persists English through the real CLI across restarts", async () => {
  const config = join(home, "config.json");
  await writeFile(config, JSON.stringify({ ui: { timezone: "Asia/Singapore" }, sentinel: "preserved" }));
  const first = await createInterfaceI18n({ preference: createTuiLanguagePreference() });
  expect(first.language).toBe("zh-CN");
  await first.changeLanguage("en");
  const restarted = await createInterfaceI18n({ preference: createTuiLanguagePreference() });
  expect(restarted.language).toBe("en");
  expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ ui: { timezone: "Asia/Singapore", language: "en" }, sentinel: "preserved" });
  await writeFile(config, JSON.stringify({ ui: { language: "unsupported" } }));
  expect((await createInterfaceI18n({ preference: createTuiLanguagePreference() })).language).toBe("zh-CN");
}, 10000);

it("keeps the previous language when the real CLI write fails", async () => {
  const blocked = join(home, "not-a-directory");
  await writeFile(blocked, "preserved");
  vi.stubEnv("OPENRIG_HOME", blocked);
  const language = await createInterfaceI18n({ preference: createTuiLanguagePreference() });
  await expect(language.changeLanguage("en")).rejects.toThrow();
  expect(language.language).toBe("zh-CN");
  expect(await readFile(blocked, "utf8")).toBe("preserved");
}, 10000);

it("changes only this view's locale, preserving selection, codes and agent text", () => {
  const snapshot = demoSnapshot(true), before = JSON.stringify(snapshot);
  const first = createViewState({ instanceId: "first", team: {}, getSnapshot: () => snapshot });
  const second = createViewState({ instanceId: "second", team: {}, getSnapshot: () => snapshot });
  const previous = first.get();
  first.dispatch({ type: "team-language", language: "en" });
  expect(first.get()).toEqual({ ...previous, team: { ...previous.team, language: "en" } });
  expect(second.get().team?.language).toBe("zh-CN");
  expect(JSON.stringify(snapshot)).toBe(before);
  for (const [page, value] of [["tasks", "TASK-001"], ["details", "Preserve task identity"], ["agents", "Checking outcomes"], ["logs", "TASK-001/attempt-1"]] as const) {
    const frames = [previous, first.get()].map(state => renderScreen({ ...state, team: { ...state.team!, page } }, snapshot, { cols: 90, rows: 30 }).lines.join("\n"));
    for (const frame of frames) expect(frame).toContain(value);
    expect(frames[0]).not.toBe(frames[1]);
  }
});

it("reports an effective-language override without changing the stored preference", async () => {
  const config = join(home, "config.json");
  await writeFile(config, JSON.stringify({ ui: { language: "zh-CN" } }));
  vi.stubEnv("OPENRIG_UI_LANGUAGE", "en");
  const language = await createInterfaceI18n({ preference: createTuiLanguagePreference() });
  await expect(language.changeLanguage("zh-CN")).rejects.toThrow("OPENRIG_UI_LANGUAGE");
  expect(language.language).toBe("en");
  expect(JSON.parse(await readFile(config, "utf8")).ui.language).toBe("zh-CN");
});


it.each([false, true])("persists the decoded L key and preserves view language on write failure: %s", async blocked => {
  if (blocked) {
    const file = join(home, "blocked-config"); await writeFile(file, "preserved"); vi.stubEnv("OPENRIG_HOME", file);
  }
  const language = await createInterfaceI18n({ preference: createTuiLanguagePreference() }), snapshot = demoSnapshot(true);
  const view = createViewState({ instanceId: "t016-language", team: { language: language.language }, getSnapshot: () => snapshot });
  const controls = createTeamControls({ view, language, getSnapshot: () => snapshot, client: null, refresh: async () => {}, quit: () => {} });
  const selected = view.get().team!.selectedTaskId;
  try { for (const event of decodeInput("L")) await controls.handle(event); } finally { controls.close(); }
  expect(view.get().team!.language).toBe(blocked ? "zh-CN" : "en"); expect(view.get().team!.selectedTaskId).toBe(selected);
  expect((await createInterfaceI18n({ preference: createTuiLanguagePreference() })).language).toBe(blocked ? "zh-CN" : "en");
  if (blocked) expect(view.get().team!.notice?.key).toBe("languageFailed");
}, 10000);
