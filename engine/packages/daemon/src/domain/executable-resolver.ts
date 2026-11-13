import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * U1 / KTD2 — the one place that turns a client name into a real executable.
 *
 * `claude`, `codex`, `gh` and `git` are all resolved here, in one order:
 *
 * 1. an explicit configured path (an operator override, or a test fixture);
 * 2. the bundled resource, for `gh` only, because the installer ships `gh.exe`;
 * 3. PATH probing, using `PATHEXT` on Windows.
 *
 * The bundled resource is looked up under the running install's own `plugins/github-cli`
 * directory, derived from this module's URL (`resources/engine/plugins/github-cli` in the
 * installer's tree, `engine/plugins/github-cli` in a checkout where it does not exist). A caller
 * may name other roots instead, which is how a test proves the order without a real install.
 *
 * Two things are Windows-specific and both are load-bearing. npm installs `claude` and `codex` as
 * `.cmd`/`.ps1` shims, and Node refuses to spawn a `.cmd` with `shell: false` (EINVAL, its
 * CVE-2024-27980 mitigation), so a shim is never a launch target: it is *followed* to the real
 * `.exe` it forwards to, and a client whose install is only a script is refused with a reason. And
 * an npm shim names its program without an extension, so PATH probing must append `PATHEXT` —
 * `join(path, "gh")` never matches `gh.exe`.
 *
 * A resolution never throws for a missing client: the first-run check reports what was found and
 * what was not, so a missing dependency is a value, not an exception.
 */

export type ResolverClient = "claude" | "codex" | "gh" | "git";

export type ResolutionFailure =
  /** Nothing by that name on PATH, in the bundled resources, or at the configured path. */
  | "not-found"
  /** The only match is a script shim that does not forward to a real executable. */
  | "shim-without-executable"
  /** The configured path exists but is not an executable file this host can launch. */
  | "not-executable";

export type Resolution =
  | { ok: true; client: ResolverClient; path: string; source: "configured" | "bundled" | "path" | "shim" }
  | { ok: false; client: ResolverClient; reason: ResolutionFailure; tried: string[] };

export interface ResolverOptions {
  /** An operator- or test-supplied path. Checked first, and a broken one is not silently skipped. */
  configuredPath?: string;
  /** Directories that hold installer-bundled resources. Defaults to the running install's own. */
  bundledRoots?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: "win32" | "posix";
}

/** Script extensions Windows treats as spawn targets, none of which may be launched directly. */
const SCRIPT_EXTENSIONS = [".cmd", ".bat", ".ps1", ".vbs", ".js", ".mjs", ".cjs"];

const EXECUTABLE_EXTENSIONS = [".exe", ".com"];

/** A bounded shim is a few hundred bytes; anything larger is not an npm launcher. */
const MAX_SHIM_BYTES = 64 * 1024;

/** The two launcher shapes npm writes for an installed bin, probed after the real executables. */
const SHIM_EXTENSIONS = [".cmd", ".ps1"];

/** `%dp0%\node_modules\...\claude.exe` — the cmd shim's forward target, when it names an executable. */
const CMD_SHIM_TARGET = /%dp0%[^"\r\n]*?[\\/]([^"\r\n]+?\.(?:exe|com))"/i;

/** `%dp0%\node_modules\...\codex.js` — the cmd shim's forward target, when it names a JS entry. */
const CMD_SHIM_TARGET_SCRIPT = /%dp0%[^"\r\n]*?[\\/]([^"\r\n]+?\.(?:js|mjs|cjs))"/i;

/** `"$basedir/node_modules/.../codex.js"` — the ps1 shim's forward target. */
const PS1_SHIM_TARGET = /\$basedir[/\\]([^"\r\n]+?)"/i;

export function resolveExecutable(client: ResolverClient, options: ResolverOptions = {}): Resolution {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? (process.platform === "win32" ? "win32" : "posix")) === "win32";
  const tried: string[] = [];

  // 1. The explicit path. It is the operator's decision, so a path that does not resolve to a
  // launchable file is reported rather than skipped: silently launching a different client would
  // hide a misconfiguration.
  const configured = options.configuredPath?.trim();
  if (configured) {
    const resolved = resolveConfigured(configured, windows);
    if (resolved) return { ok: true, client, path: resolved, source: "configured" };
    return { ok: false, client, reason: "not-executable", tried: [configured] };
  }

  // 2. The bundled resource, for `gh` only: the installer ships `gh.exe` so GitHub sign-in needs
  // no separate install. A bundled copy is a plain executable, never a shim.
  if (client === "gh") {
    for (const root of options.bundledRoots ?? defaultBundledRoots()) {
      for (const extension of windows ? EXECUTABLE_EXTENSIONS : [""]) {
        const candidate = join(root, client + extension);
        tried.push(candidate);
        if (isLaunchableFile(candidate, windows)) return { ok: true, client, path: candidate, source: "bundled" };
      }
    }
  }

  // 3. PATH, with PATHEXT on Windows. Every candidate is examined, because the first match may be
  // a script shim and the real executable is what may be launched.
  const directories = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const extensions = windows ? pathExtensions(env) : [""];
  const shims: string[] = [];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, client + extension);
      tried.push(candidate);
      if (!isExistingFile(candidate)) continue;
      if (windows && isScript(candidate)) { shims.push(candidate); continue; }
      if (!isLaunchableFile(candidate, windows)) continue;
      return { ok: true, client, path: candidate, source: "path" };
    }
  }

  // A script shim on PATH is how npm installs both clients on Windows, so follow it to the
  // executable it forwards to. The shim itself is never the answer.
  for (const shim of shims) {
    const target = followShim(shim, windows);
    if (target === null) continue;
    tried.push(target);
    if (isLaunchableFile(target, windows)) return { ok: true, client, path: target, source: "shim" };
  }

  return { ok: false, client, reason: shims.length > 0 ? "shim-without-executable" : "not-found", tried };
}

/**
 * Resolve every client the product launches, for first-run reporting.
 *
 * The result carries the resolved path or the reason it is missing, so the caller can explain a
 * missing dependency with the paths it actually looked at.
 */
export function resolveClientDependencies(options: ResolverOptions = {}): Resolution[] {
  return (["claude", "codex", "git", "gh"] as const).map(client => resolveExecutable(client, options));
}

/**
 * The installer's bundled-resource directory, as the running install sees it.
 *
 * This module is `resources/engine/packages/daemon/dist/domain/executable-resolver.js` in the
 * packaged tree and `engine/packages/daemon/dist/domain/` in a checkout, so four levels up lands
 * on the engine root in both. The installer stages `gh.exe` at `plugins/github-cli` beneath it;
 * nothing exists there in a checkout, which simply leaves PATH as the only candidate.
 */
export function defaultBundledRoots(): string[] {
  return [fileURLToPath(new URL("../../../../plugins/github-cli", import.meta.url))];
}

/** The extensions this host searches on Windows: real executables first, then npm's launchers. */
function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const declared = (env.PATHEXT ?? "").split(";").map(part => part.trim().toLowerCase()).filter(part => part.startsWith("."));
  // `PATHEXT` decides which real executables exist here; the two launcher shapes are always probed,
  // because following a shim to its executable is the whole point on Windows and a `PATHEXT` that
  // omits `.CMD` must not hide an npm install.
  const executables = declared.filter(extension => EXECUTABLE_EXTENSIONS.includes(extension));
  return [...(executables.length > 0 ? executables : EXECUTABLE_EXTENSIONS), ...SHIM_EXTENSIONS];
}

/** Whether a path is a regular file the host would run. */
function isLaunchableFile(path: string, windows: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!windows) {
      accessSync(path, constants.X_OK);
      return true;
    }
    return EXECUTABLE_EXTENSIONS.includes(extensionOf(path));
  } catch { return false; }
}

const isExistingFile = (path: string): boolean => {
  try { return statSync(path).isFile(); } catch { return false; }
};

const extensionOf = (path: string): string => {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
};

const isScript = (path: string): boolean => SCRIPT_EXTENSIONS.includes(extensionOf(path));

/**
 * The configured path, as a launchable file.
 *
 * A configured path is the operator's (or a fixture's) decision, so it is used as given when it is
 * a regular file: unlike PATH probing it is not restricted to `.exe`/`.com`, which keeps a
 * deliberately named launcher working. A script shim is still followed rather than launched,
 * because Node refuses to spawn one with `shell: false`.
 */
function resolveConfigured(configured: string, windows: boolean): string | null {
  const path = isAbsolute(configured) || win32.isAbsolute(configured) ? configured : join(process.cwd(), configured);
  if (!isExistingFile(path)) return null;
  if (!isScript(path)) return path;
  return followShim(path, windows);
}

/**
 * The executable an npm launcher forwards to, or `null` when the launcher does not name one.
 *
 * npm writes two files per installed bin: a `.cmd` that either calls the package's binary directly
 * (Claude Code ships a real `claude.exe`) or runs a JS entry with Node (Codex), and a `.ps1` with
 * the same shape. Both name their target relative to the shim's own directory (`%dp0%`,
 * `$basedir`), so the target is read from the shim's text and resolved next to it. A JS entry is
 * then followed through the package it lives in to the vendored executable, because a Node
 * launcher is a script too.
 */
function followShim(shim: string, windows: boolean): string | null {
  let text: string;
  try {
    if (statSync(shim).size > MAX_SHIM_BYTES) return null;
    text = readFileSync(shim, "utf8");
  } catch { return null; }
  const directory = shim.slice(0, Math.max(shim.lastIndexOf("/"), shim.lastIndexOf("\\")));
  // The `.cmd` launcher names an executable when the package ships one (Claude Code) and a JS entry
  // when it does not (Codex); the `.ps1` launcher always names the JS entry. Both are tried, because
  // which shape a package uses is the package's decision, and an executable match is preferred only
  // when it is not Node's own launcher (which the `.cmd` header names first).
  const relative = extensionOf(shim) === ".ps1"
    ? PS1_SHIM_TARGET.exec(text)?.[1]
    : [CMD_SHIM_TARGET.exec(text)?.[1], CMD_SHIM_TARGET_SCRIPT.exec(text)?.[1]]
      .find(candidate => candidate !== undefined && !/(^|[\\/])node\.exe$/i.test(candidate));
  if (!relative) return null;
  const target = join(directory, ...relative.split(/[/\\]+/).filter(Boolean));
  if (!existsSync(target)) return null;
  if (isLaunchableFile(target, windows)) return realpathOrSelf(target);
  // A Node launcher (Codex's `bin/codex.js`) resolves its own vendored binary; the vendor path is
  // the package's platform-specific `vendor/<triple>/bin/<name>.exe`, which is what this looks for.
  return isScript(target) ? vendoredExecutable(target, windows) : null;
}

/**
 * The vendored executable a JS launcher's package carries, if it carries one.
 *
 * Codex ships a per-platform package whose `vendor/<triple>/bin/codex.exe` is the real program; the
 * JS launcher only picks it. The layout is fixed — a `vendor` directory in the package or in the
 * platform package it depends on — so this reads those levels instead of walking an arbitrary tree,
 * and a package without one yields `null` rather than a guess.
 */
function vendoredExecutable(launcher: string, windows: boolean): string | null {
  const wanted = windows ? "codex.exe" : "codex";
  const directory = launcher.slice(0, Math.max(launcher.lastIndexOf("/"), launcher.lastIndexOf("\\")));
  const packageRoot = join(directory, "..");
  const nodeModules = join(packageRoot, "node_modules");
  const vendorRoots = [join(packageRoot, "vendor")];
  for (const scope of readDirectory(nodeModules)) {
    for (const dependency of readDirectory(join(nodeModules, scope))) {
      vendorRoots.push(join(nodeModules, scope, dependency, "vendor"));
    }
  }
  for (const vendorRoot of vendorRoots) {
    for (const triple of readDirectory(vendorRoot)) {
      const candidate = join(vendorRoot, triple, "bin", wanted);
      if (isExistingFile(candidate)) return realpathOrSelf(candidate);
    }
  }
  return null;
}

function readDirectory(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch { return []; }
}

function realpathOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
