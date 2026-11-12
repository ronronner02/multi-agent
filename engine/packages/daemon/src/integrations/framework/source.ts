import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FRAMEWORK_CATALOG, FRAMEWORK_PIN, frameworkEntry } from "./catalog.js";

const receiptName = ".framework-receipt.json";
const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");

export function localFrameworkRoot(home: string): string {
  const path = process.env.MULTI_AGENT_FRAMEWORK_ROOT ?? join(home, "framework", FRAMEWORK_PIN.revision);
  if (!isAbsolute(path)) throw new Error("The configured framework source must be an absolute path");
  return resolve(path);
}
function packageFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && (entry.name === ".git" || entry.name === receiptName)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
      else throw new Error("Framework source contains a link or special file");
    }
  };
  walk(root);
  return files.sort();
}

/** Verify the complete package: relative references are executable inputs too. */
export function verifyFrameworkSource(root: string): void {
  if (realpathSync(root) !== resolve(root) || /\/(?:\.agents|\.claude|\.codex|\.opencode|\.pi)(?:\/|$)/.test(root.replaceAll("\\", "/"))) {
    throw new Error("Framework source must be canonical source, not a runtime mirror");
  }
  const receiptPath = join(root, receiptName);
  if (!lstatSync(receiptPath).isFile()) throw new Error("Framework source receipt is not a regular file");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { revision?: string; files?: Record<string, { sha256?: string }> };
  if (receipt.revision !== FRAMEWORK_PIN.revision || !receipt.files || typeof receipt.files !== "object") {
    throw new Error("Framework source receipt does not match the catalog pin");
  }
  const actual = packageFiles(root), recorded = Object.keys(receipt.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(recorded)) throw new Error("Framework source file set differs from its receipt");
  for (const path of actual) {
    if (hash(readFileSync(join(root, path))) !== receipt.files[path]?.sha256) throw new Error("Framework source bytes differ from their receipt: " + path);
  }
  for (const entry of FRAMEWORK_CATALOG) {
    if (!receipt.files[entry.sourcePath]) throw new Error("Framework source is missing " + entry.name);
  }
}

export function frameworkInstructionSources(root: string, entrypoint?: string): Array<{ path: string; source: string }> {
  if (!existsSync(join(root, receiptName)) && entrypoint === undefined) return [];
  verifyFrameworkSource(root);
  const names = [...new Set(["using-spec-first", ...(entrypoint ? [entrypoint] : [])])];
  return names.map(name => {
    const entry = frameworkEntry(name);
    if (!entry) throw new Error("Unknown framework entrypoint");
    return { path: entry.sourcePath, source: join(root, entry.sourcePath) };
  });
}

/** Explicit setup operation; native launch only reads the installed package. */
export function installPinnedFramework(home: string): string {
  const root = localFrameworkRoot(home);
  if (existsSync(join(root, receiptName))) { verifyFrameworkSource(root); return root; }
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  if (existsSync(root) && (!lstatSync(root).isDirectory() || readdirSync(root).length)) {
    throw new Error("Framework destination already contains unverified files");
  }
  const stage = mkdtempSync(join(dirname(root), ".framework-install-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", stage, ...args], {
    windowsHide: true,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  try {
    git("init", "--quiet");
    git("fetch", "--quiet", "--depth", "1", `https://github.com/${FRAMEWORK_PIN.repository}.git`, FRAMEWORK_PIN.revision);
    // Keep runtime-mirror link blobs inert; canonical workflow source never follows them.
    git("-c", "core.symlinks=false", "checkout", "--quiet", "--detach", "FETCH_HEAD");
    if (git("rev-parse", "HEAD") !== FRAMEWORK_PIN.revision) throw new Error("Downloaded framework revision differs from the catalog pin");
    const files = Object.fromEntries(packageFiles(stage).map(path => [path, { sha256: hash(readFileSync(join(stage, path))) }]));
    writeFileSync(join(stage, receiptName), JSON.stringify({ revision: FRAMEWORK_PIN.revision, files }), { mode: 0o600 });
    verifyFrameworkSource(stage);
    if (existsSync(root)) rmdirSync(root);
    renameSync(stage, root);
    return root;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true });
  }
}
