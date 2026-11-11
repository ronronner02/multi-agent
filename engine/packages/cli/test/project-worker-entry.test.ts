import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { projectCommand, type ProjectDeps } from "../src/commands/project.js";
import { setExperiment } from "../src/commands/project-jev.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-entry-"));
  roots.push(root);
  const clientFactory = vi.fn(() => { throw new Error("daemon contact forbidden"); });
  async function command(verb: string, extra: string[], overrides: Partial<ProjectDeps>) {
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
    try {
      await new Command().addCommand(projectCommand({
        lifecycleDeps: {}, clientFactory, ...overrides,
      } as ProjectDeps)).parseAsync(["project", verb,
        "--project", "FIX", "--taxonomy", "taxonomy", "--classifier-version", "fixture-v1",
        "--evidence-epoch", "owner-epoch", "--limit", "1", ...extra,
      ], { from: "user" });
      return JSON.parse(output.at(-1)!);
    } finally { log.mockRestore(); }
  }
  return { root, clientFactory, command };
}

describe("local experimental wake admission", () => {
  it.each(["off","missing-key"])("experimental %s reaches neither daemon nor attempt creation",async kind=>{
    const f=fixture(), config=path.join(f.root,"experiment.json");setExperiment(config,kind!=="off");
    const out=await f.command("wake",["--experiment",config],{experimentEnv:{},experimentFetch:()=>{throw Error("provider forbidden");}});
    expect(f.clientFactory).not.toHaveBeenCalled();
    if(kind==="off")expect(out.enabled).toBe(false);else expect(out.error).toBe("experiment_unavailable");
  });
});
