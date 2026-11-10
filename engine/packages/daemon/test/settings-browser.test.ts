import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { settingsBrowser } from "../src/domain/user-settings/settings-browser.js";

describe("passive settings browser after legacy gateway deletion", () => {
  let home: string;
  let store: SettingsStore;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "settings-browser-")); store = new SettingsStore(join(home, "config.json")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  it("keeps general settings and people visible without Slack entries", () => {
    store.set("daemon.port", "7433");
    const result = settingsBrowser(store, home);
    expect(result.entries.some((entry) => entry.group === "general")).toBe(true);
    expect(result.entries.some((entry) => entry.group === "slack")).toBe(false);
    expect(result.sources.map((source) => source.id)).not.toContain("slack");
  });
  it("does not expose credential-like text from general settings", () => {
    store.set("host.name", "token=secret-value");
    const result = settingsBrowser(store, home);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
