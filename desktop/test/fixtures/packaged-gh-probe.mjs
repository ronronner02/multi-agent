// Prove the packaged daemon resolves the bundled gh.exe from its own module location (U18).
//
//   ELECTRON_RUN_AS_NODE=1 <packaged exe> test/fixtures/packaged-gh-probe.mjs <engine root>
//
// The probe imports the daemon's resolver from the packaged tree and asks it to resolve `gh` with
// an empty PATH, so the only candidate is the installer's bundled copy.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const engineRoot = process.argv[2];

try {
  const { resolveExecutable, defaultBundledRoots } = await import(
    pathToFileURL(path.join(engineRoot, 'packages', 'daemon', 'dist', 'domain', 'executable-resolver.js')).href);
  const resolution = resolveExecutable('gh', { env: { PATH: '', PATHEXT: '.EXE' }, platform: 'win32' });
  process.stdout.write(`${JSON.stringify({
    ok: resolution.ok === true && resolution.source === 'bundled',
    source: resolution.ok ? resolution.source : resolution.reason,
    resolvedPath: resolution.ok ? resolution.path : null,
    bundledRoots: defaultBundledRoots(),
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
  process.exitCode = 1;
}