import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
describe.skipIf(process.platform !== "linux")("pinned GitHub CLI setup", () => {
  let root: string, home: string, bin: string, env: NodeJS.ProcessEnv, checksum: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "github-setup-"));
    home = join(root, "home"); bin = join(root, "bin");
    for (const path of [home, bin, join(root, "tmp"), join(root, "scripts"), join(root, "engine/config/toolchain")]) {
      mkdirSync(path, { recursive: true });
    }
    for (const script of ["install-gh.sh", "node-env.sh"]) {
      copyFileSync(join(repository, "scripts", script), join(root, "scripts", script));
    }
    for (const tool of ["dirname", "uname", "sha256sum", "tar", "gzip", "mktemp", "mkdir", "install", "rm"]) {
      symlinkSync("/usr/bin/" + tool, join(bin, tool));
    }
    symlinkSync(process.execPath, join(bin, "node"));
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const folder = "gh_2.103.3_linux_" + arch;
    mkdirSync(join(root, folder, "bin"), { recursive: true });
    writeFileSync(join(root, folder, "bin/gh"), "#!/bin/sh\necho pinned-gh\n");
    chmodSync(join(root, folder, "bin/gh"), 0o755);
    const archive = join(root, "fixture.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", root, folder]);
    checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(join(root, "engine/config/toolchain/gh-lock.json"), JSON.stringify({
      version: "2.103.3", linux: { amd64: checksum, arm64: checksum },
    }));
    writeFileSync(join(bin, "curl"), "#!/usr/bin/env node\n" +
      "const fs=require('node:fs'); fs.writeFileSync(process.env.DOWNLOAD_CALLED,'yes'); " +
      "fs.copyFileSync(process.env.TEST_GH_ARCHIVE,process.argv[process.argv.indexOf('-o')+1]);\n");
    chmodSync(join(bin, "curl"), 0o755);
    env = { PATH: bin, HOME: home, TMPDIR: join(root, "tmp"), TEST_GH_ARCHIVE: archive,
      DOWNLOAD_CALLED: join(root, "download-called") };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const install = () => spawnSync("/bin/bash", [join(root, "scripts/install-gh.sh")],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  it("installs only the checksum-verified executable into the user's bin", () => {
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(home, ".local/bin/gh"), "utf8")).toContain("pinned-gh");
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });

  it("rejects a mismatched archive before publishing a binary", () => {
    writeFileSync(join(root, "engine/config/toolchain/gh-lock.json"), JSON.stringify({
      version: "2.103.3", linux: { amd64: "0".repeat(64), arm64: "0".repeat(64) },
    }));
    const result = install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum does not match");
    expect(existsSync(join(home, ".local/bin/gh"))).toBe(false);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });

  it("preserves an existing gh on PATH without downloading", () => {
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho existing-gh\n");
    chmodSync(join(bin, "gh"), 0o755);
    expect(install().status).toBe(0);
    expect(existsSync(join(root, "download-called"))).toBe(false);
    expect(readFileSync(join(bin, "gh"), "utf8")).toContain("existing-gh");
  });

  it("adds the per-user bin when Node lives in another directory", () => {
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/gh"), "#!/bin/sh\n");
    chmodSync(join(home, ".local/bin/gh"), 0o755);
    const result = execFileSync("/bin/bash", ["-c", '. "$1"; command -v gh', "_",
      join(root, "scripts/node-env.sh")], { env, encoding: "utf8" });
    expect(result.trim()).toBe(join(home, ".local/bin/gh"));
  });

  it("wires the installer before setup starts the package install", () => {
    const setup = readFileSync(join(repository, "setup.sh"), "utf8");
    expect(setup.indexOf('bash "$REPO_ROOT/scripts/install-gh.sh"')).toBeGreaterThan(0);
    expect(setup.indexOf('bash "$REPO_ROOT/scripts/install-gh.sh"')).toBeLessThan(setup.indexOf("npm ci"));
    const lock = JSON.parse(readFileSync(join(repository, "engine/config/toolchain/gh-lock.json"), "utf8"));
    expect(lock.version).toBe("2.103.3");
    expect(Object.keys(lock.linux)).toEqual(["amd64", "arm64"]);
    for (const hash of Object.values(lock.linux)) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
