import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatCommand } from "../src/commands/seat.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

afterEach(() => vi.restoreAllMocks());
async function capture(command: Command, args: string[]) {
  const logs: string[] = []; const errors: string[] = []; const saved = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  process.exitCode = undefined;
  try { await new Command().addCommand(command).parseAsync(["node", "rig", ...args]); return { logs, errors, exit: process.exitCode }; }
  finally { log.mockRestore(); error.mockRestore(); process.exitCode = saved; }
}
describe("S03 policy permissions compatibility", () => {
  it("seat command posts one explicit selection and preserves refusal JSON/exit", async () => {
    const posts: unknown[] = []; const response = { ok: false, code: "permission_selection_refused", message: "native options unavailable" };
    const deps = { lifecycleDeps: {
      readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "inert.sqlite", startedAt: "2026-09-27T00:00:00Z" }) : null,
      exists: (p: string) => p === STATE_FILE, isProcessAlive: () => true, fetch: async () => ({ ok: true }),
    }, clientFactory: () => ({ post: async (...a: unknown[]) => { posts.push(a); return { status: 409, data: response }; } }) };
    const result = await capture(seatCommand(deps as never), ["seat", "set-permissions", "owner@inert", "--mode", "auto", "--reason", "user chose", "--json"]);
    expect(posts).toEqual([["/api/seat/set-permissions/owner%40inert", { mode: "auto", reason: "user chose" }, { timeoutMs: 10_000 }]]);
    expect(result.exit).toBe(1); expect(JSON.parse(result.logs.join(""))).toEqual(response); expect(result.errors).toEqual([]);
  });
});
