import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { tuiCommand, TUI_RETIRED_MESSAGE, type TuiDeps } from "../src/commands/tui.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";

// The owner retired the terminal UI on 2026-10-31. The verb stays so existing
// instructions do not hit "unknown command": it names the Web UI and exits
// non-zero, so no script reads it as a successful open.

/** A lifecycle whose daemon state file exists with the given port (or is absent). */
function deps(port: number | null): TuiDeps {
  const stateFile = "/fixture/home/daemon.json";
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(),
    fetch: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === stateFile && port !== null ? JSON.stringify({ pid: process.pid, port, host: "127.0.0.1" }) : null)),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === stateFile && port !== null),
    mkdirp: vi.fn(),
    isProcessAlive: vi.fn(() => port !== null),
  } as unknown as LifecycleDeps;
  return { lifecycleDeps };
}

function programWith(d: TuiDeps) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  program.addCommand(tuiCommand(d));
  return program;
}

async function run(d: TuiDeps): Promise<string[]> {
  const lines: string[] = [];
  const err = console.error;
  console.error = (line: string) => void lines.push(String(line));
  try {
    await programWith(d).parseAsync(["node", "rig", "tui"]);
  } finally {
    console.error = err;
  }
  return lines;
}

describe("rig tui — retired verb", () => {
  it("names the Web UI dashboard on the daemon's own address and exits non-zero", async () => {
    const lines = await run(deps(7433));
    expect(lines[0]).toBe(TUI_RETIRED_MESSAGE);
    expect(lines[1]).toContain("http://127.0.0.1:7433/team");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("still names the default dashboard address when no daemon state exists", async () => {
    const lines = await run(deps(null));
    expect(lines[1]).toContain("http://127.0.0.1:7433/team");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("does not register a `commands` subcommand any more", () => {
    expect(tuiCommand(deps(null)).commands).toHaveLength(0);
  });
});
