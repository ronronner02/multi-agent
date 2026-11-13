// Stage the bundled GitHub CLI the installer ships, at
// `resources/engine/plugins/github-cli/gh.exe`.
//
//   node scripts/stage-gh.mjs            download, verify and extract
//   node scripts/stage-gh.mjs --check    verify an already staged copy, download nothing
//
// The executable lives inside the staged engine tree because that is the tree the daemon
// resolves its resources from: `domain/executable-resolver.ts` derives the bundled root from its
// own module URL, so the installer's `resources/engine` and a development checkout need no
// cross-process path handoff.
//
// The release archive, its version and its SHA-256 are pinned in
// `engine/config/toolchain/gh-lock.json` next to the Linux entry `scripts/install-gh.sh` uses, so
// one file describes both products' pinned GitHub CLI.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = path.resolve(DESKTOP_ROOT, '..');
const LOCK_PATH = path.join(REPOSITORY_ROOT, 'engine', 'config', 'toolchain', 'gh-lock.json');
const ENGINE_RESOURCES = path.join(DESKTOP_ROOT, 'resources', 'engine');
const RESOURCES_ROOT = path.join(ENGINE_RESOURCES, 'plugins', 'github-cli');
const GH_EXE = path.join(RESOURCES_ROOT, 'gh.exe');
const CACHE_ROOT = process.env.GH_CLI_CACHE || path.join(DESKTOP_ROOT, '.cache', 'gh');

function fail(message) {
  console.error(`stage-gh: ${message}`);
  process.exit(1);
}

const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
const pinned = lock.windows?.amd64;
if (!pinned || !/^[a-f0-9]{64}$/.test(pinned)) fail(`${LOCK_PATH} has no windows.amd64 SHA-256`);
const archive = `gh_${lock.version}_windows_amd64.zip`;
const url = `https://github.com/cli/cli/releases/download/v${lock.version}/${archive}`;
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

if (process.argv.includes('--check')) {
  if (!existsSync(GH_EXE)) fail(`${path.relative(DESKTOP_ROOT, GH_EXE)} is missing; run npm run stage`);
  // The pinned hash covers the archive, not the extracted executable; a staged binary is checked
  // against the hash recorded beside it at extraction time.
  const record = path.join(RESOURCES_ROOT, '.gh-manifest.json');
  if (!existsSync(record)) fail(`${path.relative(DESKTOP_ROOT, record)} is missing; run npm run stage`);
  const { version, executableSha256 } = JSON.parse(readFileSync(record, 'utf8'));
  if (version !== lock.version) fail(`staged gh is ${version}, pinned is ${lock.version}`);
  const actual = sha256(GH_EXE);
  if (actual !== executableSha256) fail(`staged gh.exe is ${actual}, recorded is ${executableSha256}`);
  console.log(`stage-gh: gh ${version} (${actual}) is current`);
  process.exit(0);
}

mkdirSync(CACHE_ROOT, { recursive: true });
const downloaded = path.join(CACHE_ROOT, archive);
if (!existsSync(downloaded) || sha256(downloaded) !== pinned) {
  rmSync(downloaded, { force: true });
  // GitHub's release CDN drops connections through the local proxy; the retries are bounded.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https',
        '--connect-timeout', '20', '--max-time', '900', '-o', downloaded, url], { stdio: ['ignore', 'inherit', 'inherit'] });
      break;
    } catch {
      if (attempt === 4) fail(`download failed after 4 attempts: ${url}`);
      console.error(`stage-gh: attempt ${attempt} failed, retrying`);
    }
  }
}
const actual = sha256(downloaded);
if (actual !== pinned) fail(`${archive} is ${actual}, ${LOCK_PATH} pins ${pinned}`);
console.log(`stage-gh: verified ${archive} ${actual}`);

const extractRoot = path.join(CACHE_ROOT, 'extract');
rmSync(extractRoot, { recursive: true, force: true });
mkdirSync(extractRoot, { recursive: true });
// `unzipper` is a declared devDependency; extracting in Node keeps the step portable instead of
// depending on a system `tar`/`7z` whose presence and flags vary between hosts.
const { Open } = await import('unzipper');
const archiveDir = await Open.file(downloaded);
const entry = archiveDir.files.find(file => file.path === 'bin/gh.exe');
if (!entry) fail('the release archive has no bin/gh.exe');
const extracted = path.join(extractRoot, 'gh.exe');
writeFileSync(extracted, await entry.buffer());

rmSync(RESOURCES_ROOT, { recursive: true, force: true });
mkdirSync(RESOURCES_ROOT, { recursive: true });
renameSync(extracted, GH_EXE);
writeFileSync(path.join(RESOURCES_ROOT, '.gh-manifest.json'), JSON.stringify({
  version: lock.version, archive, archiveSha256: pinned, executableSha256: sha256(GH_EXE),
}, null, 2) + '\n');
console.log(`stage-gh: wrote ${path.relative(DESKTOP_ROOT, GH_EXE)} (gh ${lock.version})`);