import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBundledRoots, resolveClientDependencies, resolveExecutable } from "../src/domain/executable-resolver.js";

/**
 * `engine/` — the root the resolver's own module is four levels below. The test file lives at
 * `engine/packages/daemon/test/`, which is three levels below the same root.
 */
const engineRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/**
 * U1 / KTD2 — one resolver for `claude`, `codex`, `gh` and `git`.
 *
 * Every case builds its own PATH and its own shim tree, so what is proved is the resolution order
 * and the shim walk, not what happens to be installed on the machine running the test. The
 * Windows branches run through the resolver's `platform` option, so they are exercised on POSIX
 * too; the two cases that need real Windows files (a junction, an npm install) are pinned.
 */

const directories: string[] = [];
const temporary = (): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "u1-resolver-")));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** An npm `.cmd` launcher that forwards to a package binary, the shape npm writes. */
const cmdShim = (directory: string, name: string, target: string): string => {
  const path = join(directory, name + ".cmd");
  writeFileSync(path, `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nendLocal & "%_prog%"  "%dp0%\\${target}" %*\r\n`);
  return path;
};

/** A fake executable. Windows has no mode bit that decides this, so any regular file is one. */
const executable = (directory: string, name: string): string => {
  const path = join(directory, name);
  writeFileSync(path, "");
  return path;
};

const windowsEnv = (path: string): NodeJS.ProcessEnv => ({ PATH: path, PATHEXT: ".COM;.EXE;.BAT;.CMD" });

describe("U1 executable resolver", () => {
  it("prefers an explicit configured path over everything else", () => {
    const directory = temporary();
    const configured = executable(directory, "custom-claude.exe");
    const result = resolveExecutable("claude", { configuredPath: configured, platform: "win32", env: windowsEnv(temporary()) });
    expect(result).toMatchObject({ ok: true, path: configured, source: "configured" });
  });

  it("refuses a configured path that is not launchable instead of falling back to PATH", () => {
    const directory = temporary();
    const missing = join(directory, "nowhere", "claude.exe");
    const result = resolveExecutable("claude", { configuredPath: missing, platform: "win32", env: windowsEnv(temporary()) });
    expect(result).toMatchObject({ ok: false, reason: "not-executable", tried: [missing] });
  });

  it("finds gh.exe on PATH, which a bare name join never would", () => {
    const directory = temporary();
    const gh = executable(directory, "gh.exe");
    const result = resolveExecutable("gh", { platform: "win32", env: windowsEnv(directory) });
    expect(result).toMatchObject({ ok: true, path: gh, source: "path" });
  });

  it("prefers the bundled gh.exe for gh only, and never for another client", () => {
    const bundled = temporary();
    const gh = executable(bundled, "gh.exe");
    const path = temporary();
    const pathGh = executable(path, "gh.exe");
    const claude = executable(path, "claude.exe");
    expect(resolveExecutable("gh", { bundledRoots: [bundled], platform: "win32", env: windowsEnv(path) }))
      .toMatchObject({ ok: true, path: gh, source: "bundled" });
    // `claude` is not looked up in the bundled roots at all: only gh ships with the installer.
    expect(resolveExecutable("claude", { bundledRoots: [bundled], platform: "win32", env: windowsEnv(path) }))
      .toMatchObject({ ok: true, path: claude, source: "path" });
    // Without a bundle, the PATH gh.exe is the fallback.
    expect(resolveExecutable("gh", { platform: "win32", env: windowsEnv(path) })).toMatchObject({ ok: true, path: pathGh });
  });

  it("follows an npm cmd shim to the real executable it names, never launching the shim", () => {
    const directory = temporary();
    const packageBin = join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin");
    mkdirSync(packageBin, { recursive: true });
    const real = executable(packageBin, "claude.exe");
    cmdShim(directory, "claude", "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    const result = resolveExecutable("claude", { platform: "win32", env: windowsEnv(directory) });
    expect(result).toMatchObject({ ok: true, path: realpathSync(real), source: "shim" });
    // The `.cmd` itself is not the answer, and a spawn of it would be EINVAL.
    if (result.ok) expect(result.path).not.toMatch(/\.cmd$/i);
  });

  it("follows a cmd shim that runs a JS launcher through to the vendored executable", () => {
    const directory = temporary();
    const packageBin = join(directory, "node_modules", "@openai", "codex", "bin");
    const vendorBin = join(directory, "node_modules", "@openai", "codex", "node_modules", "@openai",
      "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
    mkdirSync(packageBin, { recursive: true });
    mkdirSync(vendorBin, { recursive: true });
    writeFileSync(join(packageBin, "codex.js"), "#!/usr/bin/env node\n");
    const real = executable(vendorBin, "codex.exe");
    cmdShim(directory, "codex", "node_modules\\@openai\\codex\\bin\\codex.js");
    const result = resolveExecutable("codex", { platform: "win32", env: windowsEnv(directory) });
    expect(result).toMatchObject({ ok: true, path: realpathSync(real), source: "shim" });
  });

  it("refuses a shim that forwards nowhere, naming that reason", () => {
    const directory = temporary();
    writeFileSync(join(directory, "claude.cmd"), "@ECHO off\r\n");
    const result = resolveExecutable("claude", { platform: "win32", env: windowsEnv(directory) });
    expect(result).toMatchObject({ ok: false, reason: "shim-without-executable" });
  });

  it("finds nothing on an empty PATH", () => {
    const result = resolveExecutable("git", { platform: "win32", env: windowsEnv("") });
    expect(result).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("derives the installer's bundled gh root from its own module location", () => {
    // U18: the installer stages gh.exe under `<engine root>/plugins/github-cli`, and the daemon
    // finds it without any path handed in from Electron. This daemon runs from
    // `engine/packages/daemon/dist/domain/`, so four levels up is `engine/` — the test asserts the
    // shape, and whether the file exists is the packaged-engine test's job.
    const roots = defaultBundledRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(join(engineRoot, "plugins", "github-cli"));
  });

  it("falls back to PATH when the bundled gh.exe is absent", () => {
    const path_ = temporary();
    const pathGh = executable(path_, "gh.exe");
    const missingBundle = join(temporary(), "plugins", "github-cli");
    expect(resolveExecutable("gh", { bundledRoots: [missingBundle], platform: "win32", env: windowsEnv(path_) }))
      .toMatchObject({ ok: true, path: pathGh, source: "path" });
  });

  it("resolves every dependency for first-run reporting, with the paths it tried", () => {
    const directory = temporary();
    executable(directory, "gh.exe");
    const results = resolveClientDependencies({ platform: "win32", env: windowsEnv(directory) });
    expect(results.map(result => result.client)).toEqual(["claude", "codex", "git", "gh"]);
    const gh = results.find(result => result.client === "gh");
    expect(gh).toMatchObject({ ok: true, path: join(directory, "gh.exe") });
    const claude = results.find(result => result.client === "claude");
    expect(claude?.ok).toBe(false);
    if (claude && !claude.ok) expect(claude.tried).toContain(join(directory, "claude.exe"));
  });

  it("handles a PATH directory with spaces", () => {
    const directory = join(temporary(), "Program Files", "node");
    mkdirSync(directory, { recursive: true });
    const git = executable(directory, "git.exe");
    expect(resolveExecutable("git", { platform: "win32", env: windowsEnv(directory) }))
      .toMatchObject({ ok: true, path: git });
  });

  it("rejects a .ps1 shim as a launch target and looks for its forward target", () => {
    const directory = temporary();
    const packageBin = join(directory, "node_modules", "@openai", "codex", "bin");
    const vendorBin = join(directory, "node_modules", "@openai", "codex", "node_modules", "@openai",
      "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
    mkdirSync(packageBin, { recursive: true });
    mkdirSync(vendorBin, { recursive: true });
    writeFileSync(join(packageBin, "codex.js"), "#!/usr/bin/env node\n");
    const real = executable(vendorBin, "codex.exe");
    writeFileSync(join(directory, "codex.ps1"), '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "$basedir/node_modules/@openai/codex/bin/codex.js" $args\n');
    const result = resolveExecutable("codex", { platform: "win32", env: windowsEnv(directory) });
    expect(result).toMatchObject({ ok: true, path: realpathSync(real) });
    if (result.ok) expect(result.path).not.toMatch(/\.ps1$/i);
  });

  it.skipIf(process.platform !== "win32")("resolves the machine's real npm installs to .exe files", () => {
    const claude = resolveExecutable("claude");
    const codex = resolveExecutable("codex");
    // A machine without either install is a valid state; what must never happen is a script target.
    for (const result of [claude, codex]) {
      if (result.ok) expect(result.path).toMatch(/\.exe$/i);
    }
  }, 30_000);
});
