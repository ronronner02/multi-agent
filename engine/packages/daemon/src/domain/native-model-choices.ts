import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { modelId, type TeamModelChoice } from "./team-model-policy.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
function readObject(file: string, toml = false): Record<string, unknown> {
  try {
    const content = readFileSync(file, "utf8");
    return object(toml ? parseToml(content) : JSON.parse(content));
  } catch { return {}; }
}
const CLAUDE_MODEL_KEYS = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];

/** Local suggestions are model identifiers, not a provider availability check. */
export function nativeModelChoices(options: {
  home?: string; env?: NodeJS.ProcessEnv; saved?: readonly TeamModelChoice[];
} = {}): TeamModelChoice[] {
  const home = options.home ?? homedir(), env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME || join(home, ".codex"), claudeHome = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const choices = new Map<string, TeamModelChoice>();
  const add = (client: TeamModelChoice["client"], value: unknown) => {
    try {
      const model = modelId(value);
      choices.set(client + "/" + model, { client, model });
    } catch { /* Optional native metadata must not prevent manual model entry. */ }
  };
  const codex = readObject(join(codexHome, "config.toml"), true);
  add("codex", codex.model);
  for (const profile of Object.values(object(codex.profiles))) add("codex", object(profile).model);
  const catalogs = [join(codexHome, "models_cache.json")];
  if (typeof codex.model_catalog_json === "string") {
    const catalog = codex.model_catalog_json;
    catalogs.push(catalog.startsWith("~/") ? join(home, catalog.slice(2)) : resolve(codexHome, catalog));
  }
  for (const file of new Set(catalogs)) {
    const models = readObject(file).models;
    if (!Array.isArray(models)) continue;
    for (const entry of models) {
      const model = object(entry);
      if (model.visibility === undefined || model.visibility === "list") add("codex", model.slug);
    }
  }
  const claude = readObject(join(claudeHome, "settings.json"));
  add("claude-code", claude.model);
  for (const key of CLAUDE_MODEL_KEYS) {
    add("claude-code", object(claude.env)[key]);
    add("claude-code", env[key]);
  }
  for (const alias of ["opus", "sonnet", "haiku"]) add("claude-code", alias);
  for (const choice of options.saved ?? []) add(choice.client, choice.model);
  return [...choices.values()].sort((a, b) => a.client.localeCompare(b.client) || a.model.localeCompare(b.model));
}
