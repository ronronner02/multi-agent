import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const binding = { id: "binding", nodeId: "member", cwd: "/work", tmuxSession: "session", managedAttempt: {} } as NodeBinding;
function fixture() {
  const tmux = new Proxy({}, { get: (_target, _key) => vi.fn(() => { throw new Error("Legacy terminal path reached"); }) }) as TmuxAdapter;
  const fsOps = { readFile: vi.fn(), writeFile: vi.fn(), exists: () => false, mkdirp: vi.fn(), copyFile: vi.fn() };
  return { tmux, fsOps };
}
describe("restricted native launch admission", () => {
  it.each(["claude-code", "codex"] as const)("%s refuses an unconfigured worker boundary without terminal input", async runtime => {
    const deps = fixture();
    const adapter = runtime === "codex" ? new CodexRuntimeAdapter(deps) : new ClaudeCodeAdapter(deps);
    const result = await adapter.launchHarness(binding, { name: "member" });
    expect(result).toMatchObject({ ok: false, error: "Managed worker launch is unavailable" });
    expect(deps.fsOps.writeFile).not.toHaveBeenCalled();
  });
  it.each(["claude-code", "codex"] as const)("%s readiness refuses a missing worker observer", async runtime => {
    const deps = fixture();
    const adapter = runtime === "codex" ? new CodexRuntimeAdapter(deps) : new ClaudeCodeAdapter(deps);
    expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "managed_launch_unavailable" });
  });
  it.each(["claude-code", "codex"] as const)("%s legacy resume refuses a managed attempt without a worker launcher", async runtime => {
    const { tmux } = fixture();
    const adapter = runtime === "codex" ? new CodexResumeAdapter(tmux) : new ClaudeResumeAdapter(tmux);
    const result = runtime === "codex"
      ? await (adapter as CodexResumeAdapter).resume("session", "codex_id", "native", "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, binding.managedAttempt)
      : await (adapter as ClaudeResumeAdapter).resume("session", "claude_id", "native", "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, binding.managedAttempt);
    expect(result).toMatchObject({ ok: false, code: "managed_launch_unavailable" });
  });
});