import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- the privileged launcher is plain ESM without type declarations
import { buildSandboxCommand, checkClientLock, validateClientLock } from "../../../config/isolation/worker-launch.mjs";

// KTD27 client lock: exact builds per client, enforced by the privileged launcher on launch and resume.
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const isolation = new URL("../../../config/isolation/", import.meta.url);
const lockRaw = readFileSync(new URL("client-lock.json", isolation), "utf8");
const lock = JSON.parse(lockRaw);
const policy = JSON.parse(readFileSync(new URL("worker-policy.json", isolation), "utf8"));
const toolchain: string = policy.paths.toolchain_dir;
const lockFile = { raw: lockRaw, sha256: "sha256:" + createHash("sha256").update(lockRaw).digest("hex") };
const entryPoint = { "claude-code": toolchain + "/clients/bin/claude", codex: toolchain + "/clients/bin/codex" } as const;
const codexArgv = [entryPoint.codex, "-a", "never", "-s", "danger-full-access", "-c", "check_for_update_on_startup=false"];

type Client = keyof typeof entryPoint;
/** Root-owned inspection fixture: pinned files report their locked hash unless overridden. */
function inspector(client: Client, change: Record<string, string> = {}) {
  const files: { path: string; sha256: string }[] = lock.clients[client].files;
  return (file: string) => {
    const pinned = files.find(entry => toolchain + "/" + entry.path === file);
    const realpath = file === entryPoint[client] ? toolchain + "/" + files[0]!.path : file;
    if (!pinned && file !== entryPoint[client]) throw new Error("not installed");
    return { path: file, realpath, sha256: change[file] ?? pinned?.sha256 ?? "sha256:" + "0".repeat(64) };
  };
}
function launchError(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return (error as { code?: string }).code; }
  return undefined;
}

describe("KTD27 client lock contract", () => {
  it("pins every client to an exact version, hashed executables and a fixture set captured for that version", () => {
    expect(validateClientLock(structuredClone(lock))).toBeTruthy();
    for (const [client, entry] of Object.entries<{ version: string; fixtures: string[] }>(lock.clients)) {
      expect(entry.fixtures.length, client).toBeGreaterThan(0);
      for (const fixture of entry.fixtures) {
        expect(existsSync(repoRoot + fixture), fixture).toBe(true);
        expect(readFileSync(repoRoot + fixture, "utf8"), `${fixture} must be captured for ${entry.version}`).toContain(entry.version);
      }
    }
  });

  it.each([
    ["no fixture set", (l: any) => { delete l.clients.codex.fixtures; }],
    ["an empty fixture set", (l: any) => { l.clients["claude-code"].fixtures = []; }],
    ["an escaping fixture path", (l: any) => { l.clients.codex.fixtures = ["../outside.md"]; }],
    ["a missing client", (l: any) => { delete l.clients.codex; }],
    ["an unhashed executable", (l: any) => { l.clients.codex.files[0].sha256 = "sha256:abc"; }],
    ["an escaping executable path", (l: any) => { l.clients["claude-code"].files[0].path = "clients/../../etc/shadow"; }],
    ["a version range", (l: any) => { l.clients.codex.version = "^0.160.0"; }],
  ])("rejects a lock entry with %s", (_name, change) => {
    const bad = structuredClone(lock);
    change(bad);
    expect(launchError(() => validateClientLock(bad))).toBe("client-lock-invalid");
  });

  it("keeps client versions out of the worker policy, so a lock change leaves policy_revision unchanged", () => {
    const policyText = JSON.stringify(policy);
    for (const entry of Object.values<{ version: string; files: { sha256: string }[] }>(lock.clients)) {
      expect(policyText).not.toContain(entry.version);
      for (const file of entry.files) expect(policyText).not.toContain(file.sha256);
    }
    expect(policyText).not.toContain("client-lock");
  });
});

describe("KTD27 launcher enforcement", () => {
  it.each(["claude-code", "codex"] as const)("admits the locked %s build and reports the lock digest", client => {
    const argv = client === "codex" ? codexArgv : [entryPoint[client], "--permission-mode", "bypassPermissions"];
    expect(checkClientLock(policy, lockFile, argv, inspector(client), lockFile.sha256)).toEqual({
      client, version: lock.clients[client].version, digest: lockFile.sha256,
      files: lock.clients[client].files.map((file: { path: string; sha256: string }) => ({ path: toolchain + "/" + file.path, sha256: file.sha256 })),
    });
  });

  it.each(["claude-code", "codex"] as const)("refuses %s whose version string matches but whose executable hash differs", client => {
    const argv = client === "codex" ? codexArgv : [entryPoint[client]];
    const last = lock.clients[client].files.at(-1);
    const changed = inspector(client, { [toolchain + "/" + last.path]: "sha256:" + "f".repeat(64) });
    expect(launchError(() => checkClientLock(policy, lockFile, argv, changed, lockFile.sha256))).toBe("unsupported-version");
  });

  it("refuses an entry point that resolves outside the locked files, or a pinned file that is missing", () => {
    const elsewhere = (file: string) => file === entryPoint["claude-code"]
      ? { path: file, realpath: toolchain + "/clients/bin/other", sha256: lock.clients["claude-code"].files[0].sha256 }
      : inspector("claude-code")(file);
    expect(launchError(() => checkClientLock(policy, lockFile, [entryPoint["claude-code"]], elsewhere, lockFile.sha256))).toBe("unsupported-version");
    const missing = (file: string) => { if (file !== entryPoint.codex) throw new Error("missing"); return inspector("codex")(file); };
    expect(launchError(() => checkClientLock(policy, lockFile, codexArgv, missing, lockFile.sha256))).toBe("unsupported-version");
  });

  it("refuses a launch that is not bound to the installed lock digest", () => {
    expect(launchError(() => checkClientLock(policy, lockFile, codexArgv, inspector("codex"), undefined))).toBe("client-lock-unbound");
    expect(launchError(() => checkClientLock(policy, lockFile, codexArgv, inspector("codex"), "sha256:" + "a".repeat(64)))).toBe("client-lock-changed");
  });

  it("refuses every native client when the installed lock is missing or invalid, and ignores non-client commands", () => {
    for (const file of [null, { raw: "{", sha256: lockFile.sha256 }, { raw: JSON.stringify({ ...lock, clients: {} }), sha256: lockFile.sha256 }]) {
      expect(launchError(() => checkClientLock(policy, file, codexArgv, inspector("codex"), lockFile.sha256))).toBe("client-lock-unavailable");
    }
    expect(checkClientLock(policy, null, [toolchain + "/node/bin/node", "-v"], inspector("codex"))).toBeNull();
  });

  it("keeps self-update off in every launched worker", () => {
    expect(launchError(() => checkClientLock(policy, lockFile, codexArgv.slice(0, -2), inspector("codex"), lockFile.sha256))).toBe("client-self-update-enabled");
    for (const reenable of [["-c", "check_for_update_on_startup=true"], ["--config", "check_for_update_on_startup = true"],
      ["--config=check_for_update_on_startup=true"], ["-ccheck_for_update_on_startup=true"]]) {
      expect(launchError(() => checkClientLock(policy, lockFile, [...codexArgv, ...reenable], inspector("codex"), lockFile.sha256)),
        reenable.join(" ")).toBe("client-self-update-enabled");
    }
    for (const client of ["claude-code", "codex"] as const) {
      const { args } = buildSandboxCommand(policy, {
        worker: { name: "ma-worker1", uid: 2001, gid: 2001 }, treeMode: "rw", tree: "/work-source", context: "/context-source",
        framework: policy.paths.framework_dir, home: "/home-source", scratch: "/scratch-source",
        env: { DISABLE_AUTOUPDATER: "0" }, command: [entryPoint[client]], client,
        nativePolicy: { target: policy.sandbox.native_policy_mounts[client].target },
      });
      const setenv = args.flatMap((arg: string, i: number) => arg === "--setenv" ? [[args[i + 1], args[i + 2]]] : []);
      expect(setenv.filter(([key]: string[]) => key === "DISABLE_AUTOUPDATER").at(-1)).toEqual(["DISABLE_AUTOUPDATER", "1"]);
    }
  });
});
