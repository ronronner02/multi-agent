import { homedir } from "node:os";
import { join, win32 } from "node:path";

export interface DataRoots {
  state: string;
  config: string;
}

/** Resolve paths without inspecting or migrating any existing installation. */
export function resolveDataRoots(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): DataRoots {
  const env = options.env ?? process.env;
  const override = env.MULTI_AGENT_HOME?.trim();
  if (override) return { state: override, config: override };
  const home = options.home ?? homedir();
  if ((options.platform ?? process.platform) === "win32") {
    return {
      state: win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "Multi-Agent"),
      config: win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "Multi-Agent"),
    };
  }
  const root = join(home, ".multi-agent");
  return { state: root, config: root };
}

export function getMultiAgentHome(): string {
  return resolveDataRoots().state;
}

export function getStatePath(filename: string): string {
  return join(getMultiAgentHome(), filename);
}

export function getConfigPath(filename: string): string {
  return join(resolveDataRoots().config, filename);
}

export const MULTI_AGENT_HOME = getMultiAgentHome();
