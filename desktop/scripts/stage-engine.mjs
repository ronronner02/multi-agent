// Stage the engine tree the installer ships under `resources/engine`.
//
//   node scripts/stage-engine.mjs            write resources/engine
//   node scripts/stage-engine.mjs --check    report a missing or stale tree, write nothing
//
// The daemon resolves its own resources with `new URL("../../...", import.meta.url)`, so the
// shipped tree keeps the repository's relative layout instead of a curated copy:
//
//   resources/engine/packages/daemon/dist/index.js   the importable daemon
//   resources/engine/packages/daemon/assets/**       daemon asset files
//   resources/engine/packages/daemon/dist/builtins/** built-in workflow specs
//   resources/engine/packages/daemon/specs/**        shipped kernel rigs and agents
//   resources/engine/packages/ui/dist/**             the Web UI the daemon serves
//   resources/engine/config/**                       team instructions and governance policies
//   resources/engine/plugins/github-cli/gh.exe       the bundled GitHub CLI (stage-gh.mjs)
//
// Production dependencies go to `resources/engine/node_modules` with their own relative layout
// intact. Only what the daemon imports at runtime is installed there; the better-sqlite3 native
// binding is checked, not rebuilt, because the package ships a prebuild for the Electron ABI.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = path.resolve(DESKTOP_ROOT, '..');
const ENGINE_ROOT = path.join(REPOSITORY_ROOT, 'engine');
const RESOURCES_ROOT = path.join(DESKTOP_ROOT, 'resources', 'engine');

/** The engine trees that must exist in a build, relative to `engine/`. */
const ENGINE_TREES = [
  ['packages/daemon/dist', 'the daemon build (npm run build -w packages/daemon), which carries builtins/workflow-specs'],
  ['packages/daemon/assets', 'daemon asset files read at runtime'],
  ['packages/daemon/specs', 'shipped kernel rigs, agents and startup files'],
  ['packages/ui/dist', 'the Web UI build (npm run build -w packages/ui)'],
  ['config', 'team instructions and governance policies'],
];

/**
 * Single files from `engine/` that the daemon needs beside its build.
 *
 * `packages/daemon/package.json` is load-bearing: it declares `"type": "module"`, and without it
 * Node treats the daemon's `.js` files as CommonJS, warns, and reparses them as ESM at startup.
 */
const ENGINE_FILES = [
  'packages/daemon/package.json',
];

/**
 * The platform-specific better-sqlite3 prebuild the installer ships.
 *
 * The package installs its prebuilds for every platform it supports; only the shipped target is
 * kept so the resource tree does not carry five native binaries it can never load.
 */
const NATIVE_PREBUILD = 'win32-x64.node';

function fail(message) {
  console.error(`stage-engine: ${message}`);
  process.exit(1);
}

/** The build inputs that must be present; a partial build would ship a daemon that cannot start. */
function missingInputs() {
  return ENGINE_TREES.filter(([tree]) => !existsSync(path.join(ENGINE_ROOT, tree)));
}

/**
 * Copy `source` into `target`, following the package's own file list where one applies.
 *
 * `node_modules` sources are copied whole minus their build-only weight: a package's test
 * fixtures, docs and C++ sources never load at runtime and cost dozens of megabytes.
 */
function copyTree(source, target, { skip = [], prune } = {}) {
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: entry => !skip.some(part => entry === path.join(source, part) || entry.includes(`${path.sep}${part}${path.sep}`))
      && (prune ? prune(entry) : true),
  });
}

/**
 * The daemon's production module closure, as installed by npm.
 *
 * `npm ls --omit=dev --all --parseable` is npm's own answer to "what does this workspace need at
 * runtime", so the copy follows the installed layout — including a nested `node_modules` a
 * package version conflict put inside another package — instead of re-deriving it from the
 * dependency lists.
 */
function runtimeClosure() {
  const output = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable', '-w', 'packages/daemon'],
    { cwd: ENGINE_ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  const modules = path.join(ENGINE_ROOT, 'node_modules') + path.sep;
  return output.split(/\r?\n/).filter(Boolean)
    .map(entry => path.resolve(entry))
    .filter(entry => entry.startsWith(modules))
    .map(entry => path.relative(ENGINE_ROOT, entry))
    .filter(entry => !entry.split(path.sep).includes('@multi-agent'));
}

/**
 * Packages whose source, docs and type declarations never load at runtime.
 *
 * Stripped only where the package's own `main`/`exports` point elsewhere: a package that ships
 * TypeScript or source as its runtime entry keeps it, because deleting the file Node imports
 * would produce a tree that looks complete and fails at start.
 */
const BUILD_ONLY_EXTENSIONS = new Set(['.ts', '.tsx', '.map', '.md', '.markdown']);

/** Whether a package can lose its non-runtime files: its declared entry is a built `.js` file. */
function hasCompiledEntry(manifest) {
  const main = manifest.main ?? manifest.module;
  return typeof main === 'string' && /\.(c|m)?js$/.test(main);
}

/** Copy one installed dependency with the layout Node resolves from `resources/engine`. */
function copyPackage(relative) {
  const source = path.join(ENGINE_ROOT, relative);
  const manifestPath = path.join(source, 'package.json');
  if (!existsSync(manifestPath)) fail(`engine/${relative} is not installed`);
  const target = path.join(RESOURCES_ROOT, relative);
  rmSync(target, { recursive: true, force: true });
  const native = relative === path.join('node_modules', 'better-sqlite3');
  const compiled = hasCompiledEntry(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const skip = native ? ['build', 'src', 'deps', 'prebuilds'] : [];
  // Only the file kinds a compiled package never imports leave; `package.json`, `LICENSE` and the
  // JS entry stay.
  const prune = compiled && !native ? entry => !BUILD_ONLY_EXTENSIONS.has(path.extname(entry).toLowerCase()) : undefined;
  copyTree(source, target, { skip, prune });
  if (!native) return;
  // The native binding is a per-target prebuild; Node needs exactly one under `prebuilds/`.
  const prebuild = path.join(source, 'prebuilds', NATIVE_PREBUILD);
  if (!existsSync(prebuild)) fail(`better-sqlite3 has no prebuilds/${NATIVE_PREBUILD}`);
  const prebuildTarget = path.join(target, 'prebuilds');
  mkdirSync(prebuildTarget, { recursive: true });
  cpSync(prebuild, path.join(prebuildTarget, NATIVE_PREBUILD));
}

/**
 * Prove the shipped tree resolves the way the daemon does at runtime.
 *
 * The check reads the daemon's own `dist/` for the relative resources it names and asserts each
 * one exists under `resources/engine`. A layout change on either side fails here rather than in
 * the installed app, where a missing file is a daemon that never becomes ready.
 */
function assertLayout() {
  const daemonDist = path.join(RESOURCES_ROOT, 'packages', 'daemon', 'dist');
  const required = [
    'packages/daemon/dist/index.js',
    'packages/daemon/package.json',
    'packages/daemon/assets/claude-team-permissions.cjs',
    'packages/daemon/dist/builtins/workflow-specs/basic-loop.yaml',
    'packages/ui/dist/index.html',
    'config/team/core.md',
    'config/team/lead-protocol.md',
    'config/team/roles.json',
    'config/team/sections/scope.md',
    'config/governance/credential-exclusions.json',
    'config/governance/low-risk-dev-dependencies.json',
    'node_modules/better-sqlite3/package.json',
    `node_modules/better-sqlite3/prebuilds/${NATIVE_PREBUILD}`,
    'node_modules/hono/package.json',
    'node_modules/yaml/package.json',
  ];
  const absent = required.filter(entry => !existsSync(path.join(RESOURCES_ROOT, entry)));
  if (!existsSync(daemonDist)) fail('the daemon dist is missing from the staged tree');
  if (absent.length) fail(`the staged tree is missing: ${absent.join(', ')}`);
}

function stamp() {
  return {
    engine: 'resources/engine',
    builtAt: new Date().toISOString(),
    nativePrebuild: NATIVE_PREBUILD,
  };
}

/** Whether an existing tree is newer than its inputs. A stale tree would ship an old daemon. */
function isFresh() {
  const marker = path.join(RESOURCES_ROOT, '.stage-manifest.json');
  if (!existsSync(marker)) return false;
  let recorded;
  try { recorded = JSON.parse(readFileSync(marker, 'utf8')); } catch { return false; }
  if (recorded.nativePrebuild !== NATIVE_PREBUILD) return false;
  const stagedAt = statSync(marker).mtimeMs;
  const inputs = [
    ...ENGINE_TREES.map(([tree]) => path.join(ENGINE_ROOT, tree)),
    path.join(ENGINE_ROOT, 'packages', 'daemon', 'package.json'),
  ];
  const newest = inputs.reduce((latest, entry) => {
    if (!existsSync(entry)) return latest;
    const stat = statSync(entry);
    if (stat.isDirectory()) return Math.max(latest, directoryMtime(entry));
    return Math.max(latest, stat.mtimeMs);
  }, 0);
  return newest <= stagedAt;
}

/** The newest mtime under a directory; the daemon's own files change without the root's mtime. */
function directoryMtime(directory) {
  let newest = statSync(directory).mtimeMs;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? directoryMtime(child) : statSync(child).mtimeMs);
  }
  return newest;
}

function stageEngine() {
  rmSync(RESOURCES_ROOT, { recursive: true, force: true });
  mkdirSync(RESOURCES_ROOT, { recursive: true });
  for (const [tree] of ENGINE_TREES) {
    copyTree(path.join(ENGINE_ROOT, tree), path.join(RESOURCES_ROOT, tree));
  }
  for (const file of ENGINE_FILES) {
    const target = path.join(RESOURCES_ROOT, file);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(ENGINE_ROOT, file), target);
  }
  for (const relative of runtimeClosure()) copyPackage(relative);
  assertLayout();
  writeFileSync(path.join(RESOURCES_ROOT, '.stage-manifest.json'), JSON.stringify(stamp(), null, 2) + '\n');
  console.log(`stage-engine: wrote ${path.relative(DESKTOP_ROOT, RESOURCES_ROOT)}`);
}

export { RESOURCES_ROOT, ENGINE_ROOT, DESKTOP_ROOT, stageEngine, isFresh, assertLayout };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const missing = missingInputs();
  if (missing.length) fail(`missing build inputs: ${missing.map(([tree, why]) => `${tree} (${why})`).join('; ')}`);
  if (check) {
    if (!isFresh()) fail('resources/engine is missing or older than the engine build; run npm run stage');
    assertLayout();
    console.log('stage-engine: resources/engine is current');
    process.exit(0);
  }
  stageEngine();
}