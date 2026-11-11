#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { daemonCommand } from "./commands/daemon.js";
import { teamCommand, type TeamStartDeps } from "./commands/team.js";
import { githubCommand } from "./commands/github.js";
import type { LifecycleDeps } from "./daemon-lifecycle.js";
import { CLI_VERSION } from "./version.js";

export interface ProgramDeps {
  daemonDeps?: LifecycleDeps;
  daemonHttpDeps?: { baseUrl?: string; fetchImpl?: typeof fetch };
  teamStartDeps?: TeamStartDeps;
  githubDeps?: TeamStartDeps;
}

export function createProgram(depsOverride?: ProgramDeps): Command {
  const program = new Command()
    .name("rig")
    .description("Manage local teams through the daemon HTTP API")
    .version(CLI_VERSION);
  program.addCommand(teamCommand(depsOverride?.teamStartDeps));
  program.addCommand(daemonCommand(depsOverride?.daemonDeps, depsOverride?.daemonHttpDeps));
  program.addCommand(githubCommand(depsOverride?.githubDeps));
  return program;
}

export function isDirectRun(argv1 = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argv1) return false;

  try {
    return realpathSync.native(argv1) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Slice 15 — the shared CLI error/exit path (re-exported for bin-wrapper + tests).
export { runProgram, wantsJsonOutput } from "./cli-error.js";

// Only parse when executed directly (not imported for testing)
if (isDirectRun()) {
  const { runProgram: runProgramDirect } = await import("./cli-error.js");
  await runProgramDirect(createProgram(), process.argv);
}
