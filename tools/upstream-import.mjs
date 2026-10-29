// Pinned OpenRig source import (U1 / T002).
//
//   node tools/upstream-import.mjs fetch            download and checksum the pinned archive
//   node tools/upstream-import.mjs audit            print the audited import manifest summary
//   node tools/upstream-import.mjs import           extract the approved set into engine/
//   node tools/upstream-import.mjs verify           compare engine/ with the archive manifest
//
// The archive is parsed here rather than by a shell tar so every entry is
// checked before anything is written: the pax header must name the pinned
// commit, paths must stay inside the import root, symlinks must resolve to an
// imported file, and only regular files, directories and symlinks are allowed.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const PIN = Object.freeze({
  repository: 'mvschwarz/openrig',
  commit: 'cb79b8c980ec120c8db28d5aaf2c4bb3cc540c61',
  archiveUrl: 'https://codeload.github.com/mvschwarz/openrig/tar.gz/cb79b8c980ec120c8db28d5aaf2c4bb3cc540c61',
  archiveSha256: '9bb71fc7a227bbe311c1fe14a34483ecdcf2e6966817a9704460713f9489694b',
  // Owner-approved exclusions: upstream agent-instruction mirrors that native
  // clients would load as nested instructions, and CI that is inert below the
  // repository root.
  excluded: ['.agents/', '.claude/', '.github/'],
  // Audited manifest of the approved import set; a change means a different import.
  manifestDigest: '8efe21ebbf4e9994c8b18b362d41fc76b120f36db8a03a3ea653013493e4ef82',
  counts: { files: 3548, symlinks: 5, excluded: 18 },
  // Imported paths later changed on purpose; verify reports them as adapted.
  // Application version 0.1.0 (package identifiers kept) and the approved
  // dependency install scripts (better-sqlite3, esbuild) in allowScripts;
  // the shared authority contract, queue state tuple and additive migration registration;
  // the shared language catalog workspace and its consumer dependency declarations;
  // the KTD22 startup daemon mode, team-control wiring and owner-level managed checks.
  // Five inherited daemon fixtures account for WSL socket-close readiness,
  // private tmux server lifetime and child chdir/exec timing before assertions;
  // T041's startup assertion pins the worker launcher argument it now passes.
  adapted: [
    'package-lock.json', 'package.json', 'packages/cli/package.json', 'packages/daemon/package.json',
    'packages/cli/src/commands/release.ts',
    'packages/cli/test/lifecycle.test.ts',
    'packages/daemon/src/db/all-migrations.ts',
    'packages/daemon/src/domain/queue-repository.ts',
    'packages/daemon/src/domain/workflow-runtime.ts',
    'packages/daemon/src/server.ts',
    // T052: the committed-event reader gained a run-scoped replay query and the
    // route gained the managed mount; both are adaptations, not upstream bytes.
    'packages/daemon/src/domain/event-bus.ts',
    'packages/daemon/src/routes/events.ts',
    'packages/daemon/src/routes/terminal-ws.ts',
    'packages/daemon/test/terminal-ws-route.test.ts',
    'packages/tui/src/attention/attention-model.ts',
    'packages/tui/src/terminals/terminal-model.ts',
    'packages/daemon/src/index.ts',
    'packages/daemon/src/startup.ts',
    'packages/daemon/src/adapters/tmux.ts',
    'packages/daemon/src/domain/runtime-adapter.ts',
    'packages/daemon/src/domain/chat-repository.ts',
    'packages/daemon/src/routes/chat.ts',
    'packages/daemon/src/adapters/claude-code-adapter.ts',
    'packages/daemon/src/adapters/claude-resume.ts',
    'packages/daemon/src/adapters/codex-runtime-adapter.ts',
    'packages/daemon/src/adapters/codex-resume.ts',
    'packages/daemon/src/middleware/auth-bearer-token.ts',
    'packages/daemon/src/middleware/browser-boundary.ts',
    'packages/daemon/test/index.test.ts',
    'packages/daemon/src/domain/types.ts',
    'packages/daemon/src/domain/rig-repository.ts',
    'packages/daemon/src/domain/rig-lifecycle-service.ts',
    'packages/daemon/src/domain/rig-teardown.ts',
    'packages/daemon/src/routes/rigs.ts',
    'packages/daemon/src/routes/down.ts',
    'packages/daemon/test/rig-repository.test.ts',
    'packages/daemon/test/rigs-routes.test.ts',
    'packages/daemon/test/rig-lifecycle-route.test.ts',
    'packages/daemon/test/rig-teardown.test.ts',
    'packages/daemon/test/down-route.test.ts',
    'packages/daemon/test/helpers/test-app.ts',
    'packages/daemon/test/p34-call-site-allowlist.test.ts',
    'packages/daemon/test/crash-cart-probes.test.ts',
    'packages/daemon/test/seat-activity-retirement-hooks.test.ts',
    'packages/daemon/test/seat-activity-retirement.test.ts',
    'packages/daemon/test/tmux-pane-cwd-native.test.ts',
    'packages/daemon/test/tmux-parent-env-hook-native.test.ts',
    // T041 passes the shared worker launcher into the resume adapter, so the startup assertion follows it.
    'packages/daemon/test/s03-bound-launch.test.ts',
    'packages/tui/package.json',
    'packages/ui/package.json',
    'packages/ui/src/App.tsx',
    'packages/ui/src/routes.tsx',
    'packages/ui/src/globals.css',
    'packages/ui/src/lib/theme.ts',
    'packages/ui/src/lib/status-colors.ts',
    'packages/tui/src/theme.ts',
    'packages/tui/src/main.ts',
    'packages/tui/src/input.ts',
    'packages/tui/src/types.ts',
    'packages/tui/src/state.ts',
    'packages/tui/src/render.ts',
    'packages/tui/src/demo-data.ts',
    'packages/tui/src/daemon-client.ts',
    'packages/tui/src/hydrate.ts',
    'packages/tui/src/live-events.ts',
    'packages/tui/src/live.ts',
    'packages/cli/src/config-store.ts',
    'packages/cli/test/config-store-extended.test.ts',
  ],
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(repoRoot, 'engine');
const CACHE = path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'multi-agent', `openrig-${PIN.commit}.tar.gz`);
// Application-owned files are exact entries; only a trailing slash grants a directory subtree.
const LOCAL_ENGINE_PATHS = [
  'config/governance/low-risk-dev-dependencies.json',
  'packages/daemon/src/domain/scope-extension.ts',
  'packages/daemon/src/db/migrations/105_scope_extensions.ts',
  'packages/daemon/test/scope-extension.test.ts',
  'config/isolation/', 'test/worker-isolation-preflight.test.mjs', 'test/project-baseline.test.mjs',
  'packages/daemon/src/contracts/team-control.ts',
  'packages/daemon/src/team-control-surface.ts',
  'packages/daemon/src/domain/plan-governance.ts',
  'packages/daemon/src/domain/system-health.ts',
  'packages/daemon/test/system-health.test.ts',
  'packages/daemon/test/system-health-composition.test.ts',
  'packages/daemon/src/domain/lead-wake-policy.ts',
  'packages/daemon/test/lead-wake-policy.test.ts',
  'packages/daemon/src/routes/team-control.ts',
  'packages/daemon/src/db/migrations/104_team_governance.ts',
  'packages/daemon/src/domain/owner-session.ts',
  'packages/daemon/src/routes/owner-session.ts',
  'packages/daemon/src/domain/terminal-takeover.ts',
  'packages/daemon/src/terminal/owner-terminal-host.ts',
  'packages/daemon/test/terminal-takeover.test.ts',
  'packages/daemon/test/owner-terminal-host.test.ts',
  'packages/daemon/src/db/migrations/105_owner_sessions.ts',
  'packages/daemon/test/owner-session.test.ts',
  'packages/daemon/test/team-governance.test.ts',
  'packages/daemon/test/team-migration.test.ts',
  'packages/daemon/test/team-control-auth.test.ts',
  'packages/daemon/test/daemon-mode.test.ts',
  'packages/daemon/src/integrations/framework/catalog.ts',
  'packages/daemon/src/integrations/framework/invocation.ts',
  'packages/daemon/test/framework-catalog.test.ts',
  'packages/daemon/test/framework-invocation.test.ts',
  'packages/daemon/src/integrations/framework/context-manifest.ts',
  'packages/daemon/src/domain/team-assignment.ts',
  'packages/daemon/src/domain/team-workspace.ts',
  'packages/daemon/src/domain/review-evidence.ts',
  'packages/daemon/test/team-review-cycle.test.ts',
  'packages/daemon/test/team-read-model.test.ts',
  'packages/daemon/test/team-dependencies.test.ts',
  'packages/daemon/test/team-workspace.test.ts',
  'packages/daemon/src/domain/mailbox-delivery.ts',
  'config/team/roles.json',
  'packages/daemon/test/framework-context-manifest.test.ts',
  'packages/daemon/test/team-assignment.test.ts',
  'packages/daemon/src/adapters/worker-launch.ts',
  'packages/daemon/src/adapters/worker-launch-control.ts',
  'packages/daemon/src/adapters/worker-mailbox-bridge.ts',
  'packages/daemon/assets/managed-native-channel-relay.cjs',
  'packages/daemon/test/managed-native-startup.test.ts',
  'packages/daemon/test/worker-mailbox-bridge.test.ts',
  'packages/daemon/test/managed-native-policy.test.ts',
  'packages/daemon/test/native-session-contract.test.ts',
  'packages/daemon/test/native-channel-contract.test.ts',
  'packages/daemon/test/team-candidate-adoption.test.ts',
  'packages/daemon/test/team-candidate-launch.test.ts',
  'packages/daemon/test/managed-attempt-producer.test.ts',
  'packages/daemon/test/client-lock.test.ts',
  'packages/daemon/test/team-messaging.test.ts',
  'config/team/lead-protocol.md',
  'packages/daemon/test/lead-protocol.test.ts',
  'config/team/core.md',
  'config/team/roles/',
  'packages/daemon/test/role-charter.test.ts',
  'packages/daemon/test/fixtures/role-charters/',
  'packages/i18n/package.json',
  'packages/i18n/tsconfig.json',
  'packages/i18n/src/index.ts',
  'packages/i18n/src/catalogs/en.json',
  'packages/i18n/src/catalogs/zh-CN.json',
  'packages/i18n/src/display-width.ts',
  'packages/i18n/test/catalog-parity.test.ts',
  'packages/i18n/test/display-width.test.ts',
  'packages/tui/test/terminal-render.test.ts',
  'packages/tui/test/team-layout.test.ts',
  'packages/tui/test/team-language.test.ts',
  'packages/tui/test/team-controls.test.ts',
  'packages/tui/test/team-projection.test.ts',
  'packages/tui/src/icons.ts',
  'packages/ui/public/skins/shuimo-danqing/shuimo-danqing-loop.mp4',
  'packages/ui/public/skins/shuimo-danqing/sm-paper-grain-strong.webp',
  'packages/ui/public/skins/shuimo-danqing/sm-paper-grain.webp',
  'packages/ui/src/hooks/useOwnerSession.ts',
  'packages/ui/src/hooks/useTeamEvents.ts',
  'packages/ui/src/hooks/useTeamRun.ts',
  'packages/ui/src/skins/shuimo-danqing/ATTRIBUTION.md',
  'packages/ui/src/skins/shuimo-danqing/skin.css',
  'packages/ui/src/team/activity.tsx',
  'packages/ui/src/team/agent-status.tsx',
  'packages/ui/src/team/overview.tsx',
  'packages/ui/src/team/run-stepper.tsx',
  'packages/ui/src/team/shell.tsx',
  'packages/ui/src/team/system-status.tsx',
  'packages/ui/src/team/task-list.tsx',
  'packages/ui/test/team-overview.test.tsx',
  'packages/ui/test/team-skins.test.tsx',
  // T053: the managed attempt's production inputs are application-owned files.
  'packages/daemon/src/domain/worker-control-access.ts',
  'packages/daemon/src/domain/seat-mailbox-capability.ts',
  'packages/daemon/src/domain/worker-identity.ts',
  'packages/daemon/src/domain/role-configuration.ts',
  'packages/daemon/src/db/migrations/106_managed_attempt_inputs.ts',
  'packages/daemon/test/managed-attempt-inputs.test.ts',
  'packages/ui/src/team/bottom-panel.tsx',
  'packages/ui/src/team/decision-card.tsx',
  'packages/ui/src/team/decision-dialog.tsx',
  'packages/ui/src/team/logs.tsx',
  'packages/ui/src/team/review-decisions.tsx',
  'packages/ui/src/team/task-detail.tsx',
  'packages/ui/test/team-decisions.test.tsx',
  'packages/ui/test/team-task-detail.test.tsx',
  'packages/ui/test/team-terminal.test.tsx',
];

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const space = buf.indexOf(0x20, i);
    const len = Number(buf.subarray(i, space).toString('utf8'));
    if (!Number.isInteger(len) || len <= 0) throw new ImportError('archive-malformed', 'invalid pax record');
    const record = buf.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

function headerString(block, start, length) {
  const raw = block.subarray(start, start + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? length : nul).toString('utf8');
}

// Yields { type: 'file' | 'dir' | 'symlink', name, mode, link, data } plus the global pax comment.
export function readTarGz(gz) {
  const tar = gunzipSync(gz);
  const entries = [];
  let globalComment = null;
  let pending = {};
  let ended = false;
  for (let off = 0; off + 512 <= tar.length; ) {
    const block = tar.subarray(off, off + 512);
    if (block.every((b) => b === 0)) {
      ended = true;
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i];
    if (Number.parseInt(headerString(block, 148, 8).trim(), 8) !== sum) throw new ImportError('archive-malformed', `bad header checksum at offset ${off}`);
    const sizeField = headerString(block, 124, 12).trim();
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8);
    if (!/^[0-7]*$/.test(sizeField) || !Number.isSafeInteger(size)) throw new ImportError('archive-malformed', `unsupported size field at offset ${off}`);
    if (off + 512 + size > tar.length) throw new ImportError('archive-malformed', `truncated entry at offset ${off}`);
    const typeflag = String.fromCharCode(block[156] || 0x30);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (typeflag === 'g') {
      globalComment = parsePax(data).comment ?? null;
      continue;
    }
    if (typeflag === 'x') {
      pending = parsePax(data);
      // A pax size override would desynchronize the block walk; GitHub archives do not use it.
      if ('size' in pending) throw new ImportError('archive-malformed', 'pax size overrides are not supported');
      continue;
    }
    if (typeflag === 'L') {
      pending.path = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    const prefix = headerString(block, 345, 155);
    const name = pending.path ?? (prefix ? `${prefix}/${headerString(block, 0, 100)}` : headerString(block, 0, 100));
    const link = pending.linkpath ?? headerString(block, 157, 100);
    const mode = Number.parseInt(headerString(block, 100, 8).trim() || '0', 8);
    pending = {};
    const type = { 0: 'file', '\0': 'file', 5: 'dir', 2: 'symlink' }[typeflag];
    if (!type) throw new ImportError('archive-entry-type-denied', `entry ${name} has denied type ${typeflag}`);
    entries.push({ type, name, mode, link, data: type === 'file' ? Buffer.from(data) : null });
  }
  if (!ended) throw new ImportError('archive-malformed', 'archive has no end-of-archive marker');
  return { globalComment, entries };
}

function normalizeEntryPath(name, rootPrefix) {
  if (!name.startsWith(rootPrefix)) throw new ImportError('archive-path-escape', `entry outside archive root: ${name}`);
  const rel = name.slice(rootPrefix.length).replace(/\/$/, '');
  if (rel.includes('\\') || rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new ImportError('archive-path-escape', `entry escapes the import root: ${name}`);
  }
  if (path.posix.isAbsolute(rel)) throw new ImportError('archive-path-escape', `absolute entry: ${name}`);
  return rel;
}

const isExcluded = (rel) => PIN.excluded.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));

export function auditArchive(gz, { expectedSha256 = PIN.archiveSha256, commit = PIN.commit } = {}) {
  const archiveSha256 = sha256(gz);
  if (expectedSha256 && archiveSha256 !== expectedSha256) throw new ImportError('archive-checksum-mismatch', `archive sha256 ${archiveSha256}`);
  const { globalComment, entries } = readTarGz(gz);
  if (globalComment !== commit) throw new ImportError('archive-commit-mismatch', `archive names commit ${globalComment}`);
  if (entries.length === 0) throw new ImportError('archive-malformed', 'archive has no entries');
  const rootPrefix = `${entries[0].name.split('/')[0]}/`;
  const manifest = [];
  let excludedCount = 0;
  for (const entry of entries) {
    if (entry.name === rootPrefix || entry.name === rootPrefix.slice(0, -1)) continue;
    const rel = normalizeEntryPath(entry.name, rootPrefix);
    if (isExcluded(rel)) {
      excludedCount += 1;
      continue;
    }
    if (entry.type === 'dir') continue;
    if (entry.type === 'symlink') {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), entry.link));
      if (path.posix.isAbsolute(entry.link) || target.startsWith('..')) throw new ImportError('archive-symlink-escape', `${rel} -> ${entry.link}`);
      manifest.push({ path: rel, type: 'symlink', link: entry.link, target });
      continue;
    }
    manifest.push({ path: rel, type: 'file', mode: entry.mode & 0o111 ? 0o755 : 0o644, sha256: sha256(entry.data), data: entry.data });
  }
  // Each path appears once and no entry sits beneath a file or symlink, so a
  // later write can neither collide nor go through an earlier symlink.
  const paths = new Set();
  for (const m of manifest) {
    if (paths.has(m.path)) throw new ImportError('archive-duplicate-path', `${m.path} appears more than once`);
    paths.add(m.path);
  }
  for (const m of manifest) {
    const segments = m.path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      const parent = segments.slice(0, i).join('/');
      if (paths.has(parent)) throw new ImportError('archive-duplicate-path', `${m.path} is nested under the non-directory entry ${parent}`);
    }
  }
  const files = new Set(manifest.filter((m) => m.type === 'file').map((m) => m.path));
  for (const link of manifest.filter((m) => m.type === 'symlink')) {
    if (!files.has(link.target)) throw new ImportError('archive-symlink-escape', `${link.path} -> ${link.link} does not resolve to an imported file`);
  }
  manifest.sort((a, b) => (a.path < b.path ? -1 : 1));
  const canonical = manifest.map((m) => (m.type === 'file' ? `F ${m.mode.toString(8)} ${m.sha256} ${m.path}` : `L ${m.link} ${m.path}`)).join('\n');
  return {
    commit,
    archiveSha256,
    manifest,
    manifestDigest: sha256(Buffer.from(`${canonical}\n`)),
    counts: { files: files.size, symlinks: manifest.length - files.size, excluded: excludedCount },
  };
}

export function importInto(audit, dest) {
  for (const m of audit.manifest) {
    const target = path.join(dest, m.path);
    if (existsSync(target) || lstatExists(target)) throw new ImportError('import-would-overwrite', `${m.path} already exists`);
  }
  for (const m of audit.manifest) {
    const target = path.join(dest, m.path);
    mkdirSync(path.dirname(target), { recursive: true });
    if (m.type === 'file') {
      writeFileSync(target, m.data, { mode: m.mode, flag: 'wx' });
      chmodSync(target, m.mode); // the creation mode is subject to umask
    } else {
      symlinkSync(m.link, target);
    }
  }
}

function lstatExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function walk(root, rel = '') {
  const out = [];
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, childRel));
    else out.push(childRel);
  }
  return out;
}

export function verifyTree(audit, dest, { local = LOCAL_ENGINE_PATHS, adapted = PIN.adapted, files = walk(dest) } = {}) {
  const expected = new Map(audit.manifest.map((m) => [m.path, m]));
  const result = { missing: [], changed: [], adapted: [], extra: [] };
  for (const [rel, m] of expected) {
    const target = path.join(dest, rel);
    if (!lstatExists(target)) {
      result.missing.push(rel);
      continue;
    }
    const st = lstatSync(target);
    const same =
      m.type === 'symlink'
        ? st.isSymbolicLink() && readlinkSync(target) === m.link
        : st.isFile() && (st.mode & 0o111 ? 0o755 : 0o644) === m.mode && sha256(readFileSync(target)) === m.sha256;
    if (!same) (adapted.includes(rel) ? result.adapted : result.changed).push(rel);
  }
  for (const rel of files) {
    if (!expected.has(rel) && !local.some((entry) => entry.endsWith('/') ? rel.startsWith(entry) : rel === entry)) {
      result.extra.push(rel);
    }
  }
  return result;
}

// Tracked plus untracked-but-not-ignored files, relative to dir; build output and node_modules stay out.
export function gitListedFiles(dir) {
  return execFileSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { encoding: 'utf8' })
    .split('\u0000')
    .filter(Boolean);
}

export async function fetchArchive() {
  if (!existsSync(CACHE)) {
    const res = await fetch(PIN.archiveUrl);
    if (!res.ok) throw new ImportError('archive-download-failed', `HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    // Only a checksum-verified download is cached, so a partial file cannot stick.
    if (sha256(body) !== PIN.archiveSha256) throw new ImportError('archive-checksum-mismatch', `downloaded archive sha256 ${sha256(body)}`);
    mkdirSync(path.dirname(CACHE), { recursive: true });
    // A private temp name per download, so concurrent fetches never share a partial file.
    const part = `${CACHE}.${process.pid}.${randomBytes(6).toString('hex')}.part`;
    writeFileSync(part, body, { flag: 'wx' });
    renameSync(part, CACHE);
  }
  return readFileSync(CACHE);
}

async function main([command]) {
  const audit = auditArchive(await fetchArchive());
  const summary = { commit: audit.commit, archiveSha256: audit.archiveSha256, manifestDigest: audit.manifestDigest, ...audit.counts };
  if (command === 'fetch' || command === 'audit') {
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === 'import') {
    importInto(audit, DEST);
    console.log(JSON.stringify({ imported: true, ...summary }, null, 2));
  } else if (command === 'verify') {
    const result = verifyTree(audit, DEST, { files: gitListedFiles(DEST) });
    console.log(JSON.stringify({ ...summary, ...result }, null, 2));
    if (result.missing.length || result.changed.length || result.extra.length) process.exitCode = 1;
  } else {
    throw new ImportError('usage', 'usage: upstream-import.mjs fetch|audit|import|verify');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(JSON.stringify({ upstream_import_error: err.code ?? 'internal', message: err.message }));
    process.exit(1);
  });
}
