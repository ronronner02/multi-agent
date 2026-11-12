import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK, operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const asset = fileURLToPath(new URL("../assets/claude-team-permissions.cjs", import.meta.url));
const { decide } = createRequire(import.meta.url)(asset);
const policy = { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK };
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, existsSync: vi.fn(original.existsSync) };
});

describe("Claude kernel inspection permissions", () => {
  // Exercise the actual session hook emitted by the launcher. These are inert
  // hook inputs: no command, network request, provider or multi-agent is executed.
  it.each([
    "curl -fsSL https://example.com/rigs/demo -o /tmp/page.html",
    "/usr/bin/grep -o title /tmp/page.html", "sort -u /tmp/links", "wc -c /tmp/page.html",
    "python3 -I -c 'import sys; print(open(sys.argv[1]).read())' /tmp/page.html",
    "'/opt/my tools/python3' -I -c 'print(1)'", "command -v codex", "/usr/bin/command -v claude",
    "claude auth status", "'/opt/my tools/claude' auth status", "/opt/tools/codex login status",
    "cd /project", "echo ---", "printf '%s\\n' ready",
    "git -C /project status --porcelain", "multi-agent up demo --cwd /project --target /rigs/demo --plan",
    "'/opt/my tools/multi-agent' up demo --plan", "env MULTI_AGENT_PORT=7434 /opt/tools/multi-agent ps --json",
  ])("allows a routine inspection command: %s", command => {
    const settings = JSON.parse(operationalLaunchArgs("claude-code", { kernelAuthority: true })[1]);
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    const result = spawnSync("/bin/sh", ["-c", hook.command], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, permission_mode: "acceptEdits" }), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow",
    } });
  });

  it("keeps kernel lifecycle authority distinct from team asks, with no blanket shell grant", () => {
    const kernel = { allow: KERNEL_CLAUDE_ALLOW, ask: [] };
    expect(decide("multi-agent down demo", kernel)).toBe("allow");
    expect(decide("multi-agent down demo", policy)).toBe("ask");
    for (const command of ["claude auth login", "codex login", "command -v codex", "python3 -I -c 'print(1)'"])
      expect(decide(command, policy)).toBeUndefined();
    for (const command of ["claude auth login", "codex login", "sudo multi-agent status", "./multi-agent status",
      "PATH=/tmp multi-agent status", "curl https://example.com | unknown-command", "multi-agent status > /tmp/result"])
      expect(decide(command, kernel)).toBeUndefined();
  });

  it("keeps native kernel allowances when the optional hook is absent", () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    expect(JSON.parse(operationalLaunchArgs("claude-code", { kernelAuthority: true })[1]))
      .toEqual({ permissions: { allow: KERNEL_CLAUDE_ALLOW } });
  });
});

describe("Claude team command permissions", () => {
  for (const rule of TEAM_CLAUDE_ASK) {
    const command = rule.slice(5, -3);
    it(`${command}: real action asks, help does not`, () => {
      expect(decide(`${command} example`, policy)).toBe("ask");
      for (const flag of ["--help", "-h"]) {
        expect(decide(`${command} ${flag}`, policy)).toBe("allow");
        expect(decide(`${command} example ${flag}`, policy)).toBe("allow");
        expect(decide(`${command} ${flag} example`, policy)).toBe("allow");
      }
    });
  }
  it.each([
    "multi-agent whoami --json", "multi-agent status # note", "multi-agent queue claim example", "multi-agent queue unclaim example",
    "multi-agent queue handoff example --to worker@team", "multi-agent help down",
    "/opt/tools/multi-agent status", "'/opt/my tools/multi-agent' queue list", '"/opt/my tools/multi-agent" down --help',
    "multi\\-agent down -h", "env MULTI_AGENT_PORT=7434 /opt/tools/multi-agent status", "A=value multi-agent status",
    "command -- /opt/tools/multi-agent status", "/usr/bin/env -- command multi-agent down --help",
    "exec /opt/tools/multi-agent status", "multi-agent --host remote down --help", "multi-agent --host=remote down -h",
    "npm test", "/opt/tools/npm test", "'/project/node_modules/.bin/vitest' run test/unit.test.ts",
    "/private/tmp/project/node_modules/.bin/jest test/unit.test.ts", "python3 -m pytest",
    "multi-agent send worker 'literal multi-agent down text'", "multi-agent send worker 'multiline\nmulti-agent down example'",
  ])("allows existing allowance spelling: %s", command => expect(decide(command, policy)).toBe("allow"));

  it.each([
    "/opt/tools/multi-agent down example", "'/opt/my tools/multi-agent' down example", "command multi-agent down example",
    "env A=x multi-agent up example", "multi-agent --host remote down example", "multi-agent --host=remote down example",
    "multi-agent down -- --help", "multi-agent down --cwd --help", 'multi-agent down "$TEAM"', "multi-agent down $(echo --help)",
    "multi-agent down example && multi-agent down --help", "multi-agent status; /opt/tools/multi-agent down example", "multi-agent down example | cat",
    'echo "$(multi-agent down example)"', "echo `multi-agent up example`", "cat <<EOF\n$(multi-agent down example)\nEOF",
    'git commit -m "multiline\nquoted" <<EOF\n$(multi-agent down example)\nEOF',
    "timeout 30 multi-agent down example", "time multi-agent down example", "nice -n 5 multi-agent down example",
    "nohup multi-agent down example", "stdbuf -oL multi-agent down example", "noglob multi-agent down example",
    "xargs multi-agent down", "if true; then multi-agent down example; fi",
    "for s in example; do multi-agent down $s; done", "{ multi-agent down example; }", "! multi-agent down example",
    "multi-agent -- down example", "multi-agent seat -- stop example@demo --reason maintenance",
    "multi-agent -- down --help", "multi-agent -- down -h", "multi-agent -- down --help example", "multi-agent seat -- stop --help example@demo",
    "ls # <<pwd\nmulti-agent down example\npwd", "ls # ' <<pwd\nmulti-agent down example\npwd",
    "echo $((1 <<value))\nmulti-agent down example\nvalue", "((1 <<value))\nmulti-agent down example\nvalue",
    "echo $((\n1 <<value))\nmulti-agent down example\nvalue",
    "PATH=/inert multi-agent down example", "NODE_OPTIONS=--no-warnings multi-agent down example", "./multi-agent down example",
    "ls `pwd # x`; multi-agent down example", "ls `pwd # x` && multi-agent down example",
    "ls ${x:-a #b}; multi-agent down example", "echo safe # $(multi-agent down example)",
  ])("retains lifecycle confirmation: %s", command => expect(decide(command, policy)).toBe("ask"));

  it.each([
    "echo 'multi-agent down example'", 'echo "multi-agent down example"', "cat <<'EOF'\nmulti-agent down example\nEOF",
    'git commit -m "multi\nline" <<\'EOF\'\n$(multi-agent down example)\nEOF',
    "multi-agent status | python3 -c 'print(1)'", "multi-agent status > result.txt", "multi-agent status && npm test",
    "multi-agent send worker $(cat message.txt)", 'multi-agent send worker "$MESSAGE"',
    "sudo multi-agent status", "env -i multi-agent status", "command -v rig", "node arbitrary.js", "npm install",
    "'/opt/tools/multi-agent down' example", "'A=value' multi-agent status", "not-multi-agent down example", "", "'unterminated",
    "PATH=/inert multi-agent status", "LD_PRELOAD=/inert multi-agent status", "DYLD_INSERT_LIBRARIES=/inert multi-agent status",
    "env NODE_OPTIONS=--no-warnings multi-agent status", "BASH_ENV=/inert multi-agent status", "ENV=/inert multi-agent status", "./multi-agent status",
    "cat <<'EOF' # <<OTHER\nmulti-agent down example\nEOF\nOTHER",
  ])("leaves unrelated/data/complex forms to native checks: %s", command => expect(decide(command, policy)).toBeUndefined());

  it("falls back to native lifecycle asks when the launch asset is absent", () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true });
    expect(JSON.parse(args[1])).toEqual({ permissions: { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK } });
    expect(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, permissionMode: "plan" })).toEqual([]);
  });

  it("executes the launch-provided hook via stdin without changing its input or settings", () => {
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true });
    const settings = JSON.parse(args[1]);
    expect(settings.permissions).toEqual({ allow: TEAM_CLAUDE_ALLOW });
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    expect(hook).toMatchObject({ type: "command", timeout: 5 });
    for (const [command, expected] of [["multi-agent down --help", "allow"], ["/opt/tools/multi-agent down example", "ask"]]) {
      const result = spawnSync("/bin/sh", ["-c", hook.command], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, permission_mode: "acceptEdits" }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: expected,
      } });
      expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toBeUndefined();
    }
    for (const input of ["invalid", JSON.stringify({ tool_name: "Read" }), JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install" } })]) {
      const result = spawnSync("/bin/sh", ["-c", hook.command], { input, encoding: "utf8" });
      expect(result.status).toBe(0); expect(result.stdout).toBe("");
    }
  });

  it("is self-contained under an install path with spaces and quotes", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hook 'path "));
    try {
      const copy = join(dir, "hook.cjs"); copyFileSync(asset, copy);
      const encoded = Buffer.from(JSON.stringify(policy)).toString("base64");
      const result = spawnSync("/bin/sh", ["-c", [process.execPath, copy, encoded].map(shellQuote).join(" ")], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "multi-agent down --help" } }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
      expect(readFileSync(copy)).toEqual(readFileSync(asset));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
