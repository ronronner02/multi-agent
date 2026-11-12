import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfigPath, getMultiAgentHome, getStatePath, resolveDataRoots } from "@multi-agent/daemon/data-paths";
import { createProgram } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());

describe("renamed CLI package", () => {
  it("publishes only the Multi-Agent executable", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.name).toBe("@multi-agent/cli");
    expect(manifest.bin).toEqual({ "multi-agent": "dist/bin-wrapper.js" });
    expect(createProgram().helpInformation()).toContain("Usage: multi-agent");
  });

  it("uses the daemon's exported resolver for the override and derived paths", () => {
    vi.stubEnv("MULTI_AGENT_HOME", "/fixture/selected-home");
    expect(getMultiAgentHome()).toBe("/fixture/selected-home");
    expect(getStatePath("multi-agent.sqlite")).toBe(join("/fixture/selected-home", "multi-agent.sqlite"));
    expect(getConfigPath("config.json")).toBe(join("/fixture/selected-home", "config.json"));
  });

  it("exposes separate native Windows roots through the package export", () => {
    expect(resolveDataRoots({ platform: "win32", env: { LOCALAPPDATA: "D:\\Local", APPDATA: "D:\\Roaming" } }))
      .toEqual({ state: "D:\\Local\\Multi-Agent", config: "D:\\Roaming\\Multi-Agent" });
  });
});
