import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nativeModelChoices } from "../src/domain/native-model-choices.js";

describe("local native model suggestions", () => {
  let home: string;
  const put = (file: string, value: unknown) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "native-model-choices-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("combines visible Codex catalog/cache IDs, configured models and saved client pairs", () => {
    put(join(home, ".codex", "config.toml"), 'model = "configured-model"\nmodel_catalog_json = "catalog.json"\n[profiles.review]\nmodel = "profile-model"\n');
    put(join(home, ".codex", "catalog.json"), { models: [
      { slug: "catalog-model", visibility: "list", display_name: "A friendly model" },
      { slug: "hidden-model", visibility: "hide" }, { slug: "catalog-model", visibility: "list" },
    ] });
    put(join(home, ".codex", "models_cache.json"), { models: [{ slug: "cache-model" }, { slug: "cache-hidden", visibility: "hide" }] });
    const choices = nativeModelChoices({ home, env: {}, saved: [
      { client: "claude-code", model: "custom/claude" }, { client: "codex", model: "catalog-model" },
    ] });
    expect(choices.filter(choice => choice.client === "codex").map(choice => choice.model)).toEqual([
      "cache-model", "catalog-model", "configured-model", "profile-model",
    ]);
    expect(choices).toContainEqual({ client: "claude-code", model: "custom/claude" });
    expect(choices.some(choice => /hidden/.test(choice.model))).toBe(false);
    expect(choices.every(choice => Object.keys(choice).sort().join() === "client,model")).toBe(true);
  });

  it("uses selected native homes and maps only Claude model settings and environment keys", () => {
    const codexHome = join(home, "codex-home"), claudeHome = join(home, "claude-home");
    put(join(codexHome, "config.toml"), 'model = "selected-codex"');
    put(join(claudeHome, "settings.json"), { model: "settings-claude", env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: "mapped/opus", ANTHROPIC_API_KEY: "private-secret-value",
      ANTHROPIC_BASE_URL: "https://private.invalid", UNRELATED_MODEL: "not-a-model-choice",
    } });
    put(join(codexHome, "auth.json"), { api_key: "private-auth-file-value" });
    const choices = nativeModelChoices({ home, env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
      ANTHROPIC_MODEL: "environment-claude", ANTHROPIC_DEFAULT_SONNET_MODEL: "mapped/sonnet",
      ANTHROPIC_AUTH_TOKEN: "private-environment-value" } });
    for (const model of ["settings-claude", "environment-claude", "mapped/opus", "mapped/sonnet", "opus", "sonnet", "haiku"])
      expect(choices).toContainEqual({ client: "claude-code", model });
    expect(choices).toContainEqual({ client: "codex", model: "selected-codex" });
    expect(JSON.stringify(choices)).not.toMatch(/private-|not-a-model-choice|auth\.json|codex-home|claude-home/);
  });

  it("keeps saved custom IDs and native aliases when optional files are missing or malformed", () => {
    put(join(home, ".codex", "config.toml"), "invalid = [");
    put(join(home, ".codex", "models_cache.json"), "{");
    put(join(home, ".claude", "settings.json"), "null");
    expect(nativeModelChoices({ home, env: {}, saved: [{ client: "codex", model: "custom-model" }] })).toEqual([
      { client: "claude-code", model: "haiku" }, { client: "claude-code", model: "opus" },
      { client: "claude-code", model: "sonnet" }, { client: "codex", model: "custom-model" },
    ]);
  });

  it("excludes malformed external IDs and non-model catalog data without exposing it", () => {
    put(join(home, ".codex", "models_cache.json"), { token: "private-cache-value", models: [
      null, "private-raw-value", { slug: "$(private-command)" }, { slug: "invalid model" },
      { slug: "a".repeat(129) }, { slug: "valid/model-v1" }, { token: "private-entry-value" },
    ] });
    const codex = nativeModelChoices({ home, env: {} }).filter(choice => choice.client === "codex");
    expect(codex).toEqual([{ client: "codex", model: "valid/model-v1" }]);
  });
});
