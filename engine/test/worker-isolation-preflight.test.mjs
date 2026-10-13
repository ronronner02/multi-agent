// Worker-isolation preflight (U1 / T001).
//
// Offline section: always runs on any platform and exercises the real launcher
// validation and sandbox-argv construction against the checked-in policy.
//
// Host section: runs only with MA_PREFLIGHT=1 inside the provisioned WSL host.
// It launches real worker subprocesses through the installed launcher and
// checks what they can and cannot reach. It never contacts a model provider.
//
//   MA_PREFLIGHT=1 /opt/multi-agent/toolchain/node/bin/node --test engine/test/worker-isolation-preflight.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  LaunchError,
  validatePolicy,
  parseLaunchArgs,
  resolveLaunchRequest,
  buildSandboxCommand,
  assertSafeStdio,
  MOUNT_FD,
} from '../config/isolation/worker-launch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyPath = path.join(here, '..', 'config', 'isolation', 'worker-policy.json');
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));

const USERS = {
  'ma-control': { name: 'ma-control', uid: 990, gid: 990, groups: ['ma-control'] },
  'ma-worker1': { name: 'ma-worker1', uid: 991, gid: 991, groups: ['ma-worker1'] },
  'ma-worker2': { name: 'ma-worker2', uid: 992, gid: 992, groups: ['ma-worker2', 'sudo'] },
  leo: { name: 'leo', uid: 1000, gid: 1000, groups: ['leo', 'sudo'] },
};

function fakeFacts(overrides = {}) {
  const links = {
    '/var/lib/multi-agent/assignments/ma-worker1/escape': '/var/lib/multi-agent/control',
  };
  return {
    callerUid: 990,
    lookupUser: (name) => USERS[name] ?? null,
    realpath: (p) => {
      const normalized = path.posix.normalize(p);
      if (links[normalized]) return links[normalized];
      return normalized;
    },
    isDirectory: () => true,
    legacyTiocsti: 0,
    ...overrides,
  };
}

function launch(argv, factsOverrides) {
  const request = parseLaunchArgs(argv);
  return resolveLaunchRequest(policy, request, fakeFacts(factsOverrides));
}

function expectLaunchError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof LaunchError, `expected LaunchError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

const TREE = '/var/lib/multi-agent/assignments/ma-worker1/task-1';
const NODE = '/opt/multi-agent/toolchain/node/bin/node';

describe('offline: worker policy', () => {
  test('checked-in policy is valid', () => {
    assert.doesNotThrow(() => validatePolicy(policy));
  });

  test('control identity is never a worker identity', () => {
    const bad = structuredClone(policy);
    bad.worker_identities.push(bad.control_identity);
    expectLaunchError(() => validatePolicy(bad), 'policy-invalid');
  });

  test('assignment root must not overlap the control state directory', () => {
    const bad = structuredClone(policy);
    bad.paths.assignment_root = '/var/lib/multi-agent/control/assign';
    expectLaunchError(() => validatePolicy(bad), 'policy-invalid');
  });

  test('exec prefixes may not include Windows mounts', () => {
    const bad = structuredClone(policy);
    bad.allowed_exec_prefixes.push('/mnt/c/');
    expectLaunchError(() => validatePolicy(bad), 'policy-invalid');
  });
});

describe('offline: launch request validation', () => {
  test('accepts an approved worker, assigned tree and toolchain command', () => {
    const resolved = launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE, '--attempt', 'a-1', '--', NODE, '-v']);
    assert.equal(resolved.worker.uid, 991);
    assert.equal(resolved.tree, TREE);
    assert.equal(resolved.treeMode, 'rw');
    assert.deepEqual(resolved.command, [NODE, '-v']);
    assert.equal(resolved.env.MA_ATTEMPT_ID, 'a-1');
  });

  test('rejects a caller that is not the control identity', () => {
    expectLaunchError(
      () => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE, '--', NODE], { callerUid: 1000 }),
      'caller-not-allowed',
    );
  });

  test('rejects an identity outside the worker allow-list', () => {
    expectLaunchError(() => launch(['--worker', 'leo', '--role', 'implementer', '--tree', TREE, '--', NODE]), 'worker-not-allowed');
    expectLaunchError(() => launch(['--worker', 'ma-control', '--role', 'implementer', '--tree', TREE, '--', NODE]), 'worker-not-allowed');
  });

  test('rejects an allow-listed worker that holds a privileged group', () => {
    expectLaunchError(
      () => launch(['--worker', 'ma-worker2', '--role', 'implementer', '--tree', '/var/lib/multi-agent/assignments/ma-worker2/t', '--', NODE]),
      'worker-privileged-group',
    );
  });

  test('rejects a missing worker account distinctly', () => {
    expectLaunchError(() => launch(['--worker', 'ma-worker3', '--role', 'implementer', '--tree', TREE, '--', NODE]), 'worker-account-missing');
  });

  test('rejects trees outside the worker assignment directory, including via symlink', () => {
    expectLaunchError(() => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', '/var/lib/multi-agent/control', '--', NODE]), 'tree-outside-assignment');
    expectLaunchError(
      () => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', '/var/lib/multi-agent/assignments/ma-worker1/../ma-worker2/t', '--', NODE]),
      'tree-outside-assignment',
    );
    expectLaunchError(
      () => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', '/var/lib/multi-agent/assignments/ma-worker1/escape', '--', NODE]),
      'tree-outside-assignment',
    );
    expectLaunchError(
      () => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', '/var/lib/multi-agent/assignments/ma-worker1', '--', NODE]),
      'tree-outside-assignment',
    );
  });

  test('rejects unknown roles, unlisted env keys and non-allow-listed commands', () => {
    expectLaunchError(() => launch(['--worker', 'ma-worker1', '--role', 'lead-owner', '--tree', TREE, '--', NODE]), 'role-not-allowed');
    expectLaunchError(() => launch(['--worker', 'ma-worker1', '--role', 'constructor', '--tree', TREE, '--', NODE]), 'role-not-allowed');
    expectLaunchError(() => parseLaunchArgs(['toString', 'x', '--', NODE]), 'argument-unknown');
    expectLaunchError(() => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE, '--env', 'LD_PRELOAD=/x', '--', NODE]), 'env-not-allowed');
    expectLaunchError(() => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE, '--', 'node']), 'command-not-allowed');
    expectLaunchError(() => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE, '--', '/mnt/c/Windows/System32/cmd.exe']), 'command-not-allowed');
    expectLaunchError(() => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE, '--', '/usr/bin/../../mnt/c/x']), 'command-not-allowed');
  });

  test('rejects malformed arguments and attempt ids', () => {
    expectLaunchError(() => parseLaunchArgs(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE]), 'command-missing');
    expectLaunchError(() => parseLaunchArgs(['--bind', '/', '/', '--', NODE]), 'argument-unknown');
    expectLaunchError(() => parseLaunchArgs(['--worker', 'ma-worker1', '--attempt', '../x', '--', NODE]), 'argument-invalid');
  });

  test('rejects a directory descriptor on any standard stream', () => {
    assert.doesNotThrow(() => assertSafeStdio(['other', 'other', 'closed']));
    for (const fd of [0, 1, 2]) {
      const kinds = ['other', 'other', 'other'];
      kinds[fd] = 'directory';
      expectLaunchError(() => assertSafeStdio(kinds), 'stdio-not-allowed');
    }
  });

  test('refuses an interactive launch when legacy TIOCSTI injection is enabled', () => {
    expectLaunchError(
      () => launch(['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE, '--', NODE], { legacyTiocsti: 1 }),
      'host-tiocsti-enabled',
    );
  });
});

describe('offline: sandbox command construction', () => {
  const resolvedFor = (role) =>
    launch(['--worker', 'ma-worker1', '--role', role, '--tree', TREE, '--env', 'TERM=xterm-256color', '--', NODE, '-e', '1']);

  test('drops to the worker identity with no new privileges before entering bwrap', () => {
    const { file, args } = buildSandboxCommand(policy, resolvedFor('implementer'));
    assert.equal(file, '/usr/bin/setpriv');
    for (const flag of ['--reuid=991', '--regid=991', '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all']) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    assert.ok(args.indexOf('/usr/bin/bwrap') > args.indexOf('--no-new-privs'));
  });

  test('isolates processes, environment and inherited sessions', () => {
    const { args } = buildSandboxCommand(policy, resolvedFor('implementer'));
    for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--clearenv']) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    const tmpfs = args.flatMap((a, i) => (a === '--tmpfs' ? [args[i + 1]] : []));
    assert.deepEqual(tmpfs.sort(), ['/run', '/tmp', '/usr/lib/wsl']);
    const mask = args.indexOf('/usr/lib/wsl');
    assert.ok(mask > args.indexOf('/usr'), 'the WSL mask must be mounted over the /usr bind');
    assert.deepEqual(args.slice(mask + 1, mask + 3), ['--remount-ro', '/usr/lib/wsl']);
  });

  test('never exposes control state, Windows mounts, interop sockets or other workers', () => {
    const { args } = buildSandboxCommand(policy, resolvedFor('implementer'));
    const joined = args.join('\n');
    for (const forbidden of ['/var/lib/multi-agent/control', '/mnt', '/run/WSL', '/home/leo', '/var/lib/multi-agent/workers/ma-worker2', '/init']) {
      assert.ok(!joined.split('\n').some((a) => a === forbidden || a.startsWith(`${forbidden}/`)), `exposes ${forbidden}`);
    }
  });

  test('writable sources are mounted from launcher-held descriptors, never re-resolved paths', () => {
    const impl = buildSandboxCommand(policy, resolvedFor('implementer'));
    const rev = buildSandboxCommand(policy, resolvedFor('reviewer'));
    const triple = (args, dest) => {
      const i = args.findIndex((a, j) => a.endsWith('bind-fd') && args[j + 2] === dest);
      return args.slice(i, i + 3);
    };
    assert.deepEqual(triple(impl.args, '/work'), ['--bind-fd', String(MOUNT_FD.tree), '/work']);
    assert.deepEqual(triple(rev.args, '/work'), ['--ro-bind-fd', String(MOUNT_FD.tree), '/work']);
    assert.deepEqual(triple(impl.args, '/home/worker'), ['--bind-fd', String(MOUNT_FD.home), '/home/worker']);
    assert.deepEqual(triple(impl.args, '/scratch'), ['--bind-fd', String(MOUNT_FD.scratch), '/scratch']);
    assert.ok(!impl.args.includes(TREE), 'the tree path must not reach bwrap');
    assert.deepEqual(impl.mountSources, {
      home: '/var/lib/multi-agent/workers/ma-worker1/home',
      scratch: '/var/lib/multi-agent/workers/ma-worker1/scratch',
      tree: TREE,
    });
  });

  test('passes only allow-listed environment and the command after a separator', () => {
    const { args } = buildSandboxCommand(policy, resolvedFor('implementer'));
    const setenv = [];
    for (let i = 0; i < args.length; i += 1) if (args[i] === '--setenv') setenv.push(args[i + 1]);
    assert.deepEqual(setenv.sort(), ['HOME', 'PATH', 'TERM', 'TMPDIR', 'USER'].sort());
    const sep = args.lastIndexOf('--');
    assert.deepEqual(args.slice(sep + 1), [NODE, '-e', '1']);
  });
});

// ---------------------------------------------------------------------------
// Host preflight (MA_PREFLIGHT=1). Requires the provisioning in
// engine/config/isolation/provision-host.sh and passwordless preflight access
// from the owner account to the control and worker identities.

const HOST = process.env.MA_PREFLIGHT === '1';
const hostSkip = HOST ? false : 'set MA_PREFLIGHT=1 inside the provisioned WSL host';

const P = policy.paths;
const LAUNCHER = '/usr/local/libexec/multi-agent/worker-launch';
const TOOL_NODE = `${P.toolchain_dir}/node/bin/node`;
const SANDBOX_PATH = policy.sandbox.path;
const WINDOWS_PE = '/mnt/c/Windows/System32/whoami.exe';
const WINDOWS_CURL = '/mnt/c/Windows/System32/curl.exe';
const CODEX = `${P.toolchain_dir}/clients/bin/codex`;
// Codex's own Linux sandbox must keep enforcing its profiles inside the worker boundary.
const CODEX_SANDBOX_CASES = [
  // Positive control for the profile itself: a denial below must not be a startup failure.
  { id: 'read-only-run', expect: 'allow', args: ['sandbox', '-P', ':read-only', '-C', '/work', '--', '/usr/bin/true'] },
  { id: 'read-only-write', expect: 'deny', target: '/work/codex-read-only', args: ['sandbox', '-P', ':read-only', '-C', '/work', '--', '/usr/bin/touch', '/work/codex-read-only'] },
  { id: 'workspace-write', expect: 'allow', target: '/work/codex-workspace', args: ['sandbox', '-P', ':workspace', '-C', '/work', '--', '/usr/bin/touch', '/work/codex-workspace'] },
  { id: 'workspace-outside-write', expect: 'deny', target: '/scratch/codex-outside', args: ['sandbox', '-P', ':workspace', '-C', '/work', '--', '/usr/bin/touch', '/scratch/codex-outside'] },
  {
    id: 'workspace-network',
    expect: 'deny',
    baseline: ['/usr/bin/curl', '-s', '-m', '10', '-o', '/dev/null', 'https://registry.npmjs.org/'],
    args: ['sandbox', '-P', ':workspace', '-C', '/work', '--', '/usr/bin/curl', '-s', '-m', '10', '-o', '/dev/null', 'https://registry.npmjs.org/'],
  },
];

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 60_000, ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.code ?? null };
}
const asUser = (user, file, args, opts) => run('/usr/bin/sudo', ['-n', '-u', user, '--', file, ...args], opts);
const asControl = (file, args, opts) => asUser(policy.control_identity, file, args, opts);
const launcherViaControl = (args, opts) => asControl('/usr/bin/sudo', ['-n', LAUNCHER, ...args], opts);
const launcherError = (r) => {
  const line = r.stderr.split('\n').find((l) => l.includes('worker_launch_error'));
  return line ? JSON.parse(line).worker_launch_error : null;
};
const execFileAsync = promisify(execFile);
const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// Runs inside the sandbox as the worker. Prints one JSON object.
const PROBE = String.raw`
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
const input = JSON.parse(process.argv[1]);
const attempt = (fn) => { try { const v = fn(); return { ok: true, v }; } catch (e) { return { ok: false, code: e.code ?? String(e.message).slice(0, 60) }; } };
const connect = (p) => new Promise((resolve) => {
  const s = net.connect(p);
  const done = (r) => { s.destroy(); resolve(r); };
  s.once('connect', () => done({ ok: true }));
  s.once('error', (e) => done({ ok: false, code: e.code }));
  setTimeout(() => done({ ok: false, code: 'TIMEOUT' }), 3000);
});
const status = fs.readFileSync('/proc/self/status', 'utf8');
const field = (k) => (status.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) ?? [])[1];
const out = {
  identity: { uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), status_uid: field('Uid'), uid_map: fs.readFileSync('/proc/self/uid_map', 'utf8').trim(), no_new_privs: field('NoNewPrivs'), cap_eff: field('CapEff') },
  fd_targets: fs.readdirSync('/proc/self/fd').map((fd) => attempt(() => fs.readlinkSync('/proc/self/fd/' + fd)).v ?? null),
  env_keys: Object.keys(process.env).sort(),
  pid_count: fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).length,
  kill_host_pid: attempt(() => process.kill(input.hostPid, 0)),
  read: {}, write: {}, list: {}, connect: {},
};
for (const p of input.denyRead) out.read[p] = attempt(() => fs.readFileSync(p).length);
for (const p of input.denyWrite) out.write[p] = attempt(() => fs.closeSync(fs.openSync(p, 'r+')));
for (const p of input.denyList) out.list[p] = attempt(() => fs.readdirSync(p).length);
for (const p of input.denySockets) out.connect[p] = await connect(p);
const pe = spawnSync(input.windowsPe, [], { encoding: 'utf8', timeout: 5000 });
out.exec_windows_pe = { present: fs.existsSync(input.windowsPe), ran: pe.status === 0 && !pe.error, status: pe.status, error: pe.error?.code ?? null };
out.allow_scratch = attempt(() => { fs.writeFileSync('/scratch/' + input.marker, 'ok'); return fs.readFileSync('/scratch/' + input.marker, 'utf8'); });
out.allow_work = attempt(() => { fs.writeFileSync('/work/' + input.marker, 'ok'); return true; });
out.abstract_sockets = fs.readFileSync('/proc/net/unix', 'utf8').split('\n').filter((l) => / @/.test(l)).length;
// Covered (shadowed) mounts still appear in mountinfo; what matters is whether their path resolves.
out.windows_mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean)
  .map((l) => ({ point: l.split(' ')[4], fstype: l.split(' - ')[1]?.split(' ')[0] }))
  .filter((m) => ['9p', 'drvfs', 'virtiofs'].includes(m.fstype))
  .map((m) => ({ ...m, reachable: fs.existsSync(m.point) }));
out.usr_lib_wsl = attempt(() => fs.readdirSync('/usr/lib/wsl'));
out.usr_lib_wsl_write = attempt(() => fs.writeFileSync('/usr/lib/wsl/planted.so', 'x'));
const nested = spawnSync('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--dev', '/dev', '/usr/bin/true'], { encoding: 'utf8' });
out.nested_bwrap = { status: nested.status, stderr: (nested.stderr ?? '').slice(0, 120) };
out.socat = fs.existsSync('/usr/bin/socat');
for (const [name, args] of [['claude', ['--version']], ['codex', ['--version']]]) {
  const r = spawnSync(name, args, { encoding: 'utf8', timeout: 30000 });
  out[name + '_version'] = { status: r.status, stdout: (r.stdout ?? '').trim().slice(0, 80) };
}
const codexCases = {};
for (const c of input.codexSandboxCases) {
  // Positive control: the same probe must succeed outside the Codex sandbox, so a denial is the sandbox's doing.
  const baseline = c.baseline ? spawnSync(c.baseline[0], c.baseline.slice(1), { encoding: 'utf8', timeout: 30000, cwd: '/work' }) : null;
  const r = spawnSync(input.codex, c.args, { encoding: 'utf8', timeout: 30000, cwd: '/work' });
  codexCases[c.id] = {
    status: r.status, signal: r.signal, error: r.error?.code ?? null, stderr: (r.stderr ?? '').slice(0, 160),
    baseline_status: baseline ? baseline.status : null,
    target_exists: c.target ? fs.existsSync(c.target) : null,
  };
}
out.codex_sandbox = codexCases;
process.stdout.write(JSON.stringify(out));
`;

describe('host: worker isolation preflight', { skip: hostSkip }, () => {
  const ctx = { blockers: [], facts: {}, cleanup: [] };
  const tag = `preflight-${randomBytes(4).toString('hex')}`;
  const stageDir = `${P.control_state_dir}/${tag}`;
  const sentinels = {
    ownerToken: `${stageDir}/owner.token`,
    database: `${stageDir}/state.db`,
    wal: `${stageDir}/state.db-wal`,
    shm: `${stageDir}/state.db-shm`,
    browserSessions: `${stageDir}/browser-sessions.json`,
    supervisorSocket: `${stageDir}/supervisor.sock`,
    controlTmux: `${stageDir}/tmux.sock`,
  };
  const implTree = `${P.assignment_root}/ma-worker1/${tag}`;
  const revTree = `${P.assignment_root}/ma-worker2/${tag}`;
  const escapeLink = `${P.assignment_root}/ma-worker1/${tag}-escape`;
  let ownerTmuxSocket = `/tmp/tmux-${process.getuid?.()}/ma-${tag}`;

  function blocked(t) {
    if (ctx.blockers.length) assert.fail(`blocked by prerequisites: ${ctx.blockers.join(', ')}`);
  }

  function probe(worker, role, tree, extra = {}) {
    const input = {
      marker: `${tag}-${worker}`,
      hostPid: ctx.supervisorPid,
      windowsPe: `${policy.sandbox.scratch}/${tag}-whoami.exe`,
      denyRead: [sentinels.ownerToken, sentinels.database, sentinels.browserSessions, '/mnt/c/Windows/win.ini', '/mnt/d', `/home/${process.env.USER}`, '/etc/shadow', '/etc/sudoers'],
      denyWrite: [sentinels.database, sentinels.wal, sentinels.shm, `${P.installed_policy}`],
      denyList: [P.control_state_dir, '/mnt/c', '/run/WSL', `${P.worker_root}/ma-worker2`, `${P.worker_root}/ma-worker3`, `/tmp/tmux-${process.getuid?.()}`],
      denySockets: [sentinels.supervisorSocket, sentinels.controlTmux, ownerTmuxSocket, '/run/WSL/1_interop', process.env.WSL_INTEROP ?? '/run/WSL/2_interop'],
      codex: CODEX,
      codexSandboxCases: CODEX_SANDBOX_CASES,
      ...extra,
    };
    // fd 3 is an open owner-side file; the worker must not inherit it.
    const leaked = openSync(policyPath, 'r');
    try {
      const r = launcherViaControl(
        ['--worker', worker, '--role', role, '--tree', tree, '--attempt', tag, '--env', 'TERM=xterm-256color', '--', TOOL_NODE, '--input-type=module', '-e', PROBE, JSON.stringify(input)],
        { stdio: ['ignore', 'pipe', 'pipe', leaked], timeout: 180_000 },
      );
      if (r.status !== 0) return { launch_failed: true, status: r.status, code: launcherError(r), stderr: r.stderr.slice(0, 400) };
      return JSON.parse(r.stdout);
    } finally {
      closeSync(leaked);
    }
  }

  before(() => {
    // Distinct prerequisite codes; any one blocks the dependent checks and T002.
    for (const tool of ['/usr/bin/bwrap', '/usr/bin/setpriv', '/usr/bin/tmux', '/usr/bin/sudo', '/usr/bin/setfacl', TOOL_NODE]) {
      if (!existsSync(tool)) ctx.blockers.push(`tool-missing:${tool}`);
    }
    for (const name of [policy.control_identity, ...policy.worker_identities]) {
      if (run('/usr/bin/id', ['-u', name]).status !== 0) ctx.blockers.push(`identity-missing:${name}`);
    }
    if (!existsSync(LAUNCHER) || !existsSync(P.installed_policy)) ctx.blockers.push('launcher-not-installed');
    const tiocsti = run('/usr/sbin/sysctl', ['-n', 'dev.tty.legacy_tiocsti']).stdout.trim();
    if (tiocsti !== '0') ctx.blockers.push(`kernel-legacy-tiocsti:${tiocsti || 'unknown'}`);
    if (Number(readFileSync('/proc/sys/user/max_user_namespaces', 'utf8')) < 1) ctx.blockers.push('kernel-userns-disabled');
    if (asControl('/usr/bin/true', []).status !== 0) ctx.blockers.push('preflight-access-missing:control');
    if (asUser('ma-worker1', '/usr/bin/true', []).status !== 0) ctx.blockers.push('preflight-access-missing:worker');
    if (ctx.blockers.length) return;

    // Control-owned sentinels standing in for the token, database and sockets.
    const secret = randomBytes(16).toString('hex');
    const stage = asControl(TOOL_NODE, ['-e', `
      const fs = require('node:fs');
      fs.mkdirSync(${JSON.stringify(stageDir)}, { mode: 0o700 });
      for (const f of ${JSON.stringify([sentinels.ownerToken, sentinels.database, sentinels.wal, sentinels.shm, sentinels.browserSessions])}) fs.writeFileSync(f, ${JSON.stringify(secret)}, { mode: 0o600 });
      fs.mkdirSync(${JSON.stringify(implTree)}, { mode: 0o770 });
      fs.mkdirSync(${JSON.stringify(revTree)}, { mode: 0o770 });
      fs.writeFileSync(${JSON.stringify(`${revTree}/candidate.txt`)}, 'candidate');
      fs.symlinkSync(${JSON.stringify(P.control_state_dir)}, ${JSON.stringify(escapeLink)});
    `]);
    if (stage.status !== 0) {
      ctx.blockers.push(`stage-failed:${stage.stderr.trim().slice(0, 120)}`);
      return;
    }
    ctx.cleanup.push(() => asControl('/usr/bin/rm', ['-rf', stageDir, implTree, revTree, escapeLink]));

    const listener = spawn('/usr/bin/sudo', ['-n', '-u', policy.control_identity, '--', TOOL_NODE, '-e', `
      const net = require('node:net');
      net.createServer((s) => s.end('supervisor')).listen(${JSON.stringify(sentinels.supervisorSocket)}, () => console.log(process.pid));
      setTimeout(() => process.exit(0), 600000);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    ctx.cleanup.push(() => listener.kill('SIGTERM'));
    ctx.listener = listener;

    if (asControl('/usr/bin/tmux', ['-f', '/dev/null', '-S', sentinels.controlTmux, 'new-session', '-d', '-s', tag, '/usr/bin/sleep', '600']).status !== 0) {
      ctx.blockers.push('fixture-failed:control-tmux');
    }
    ctx.cleanup.push(() => asControl('/usr/bin/tmux', ['-S', sentinels.controlTmux, 'kill-server']));
    if (run('/usr/bin/tmux', ['-f', '/dev/null', '-L', `ma-${tag}`, 'new-session', '-d', '-s', tag, '/usr/bin/sleep', '600']).status !== 0) {
      ctx.blockers.push('fixture-failed:owner-tmux');
    }
    ctx.cleanup.push(() => run('/usr/bin/tmux', ['-L', `ma-${tag}`, 'kill-server']));
    ownerTmuxSocket = run('/usr/bin/tmux', ['-L', `ma-${tag}`, 'display-message', '-p', '#{socket_path}']).stdout.trim() || ownerTmuxSocket;

    const scratch = `${P.worker_root}/ma-worker1/scratch`;
    ctx.peStaged = asUser('ma-worker1', '/usr/bin/cp', [WINDOWS_PE, `${scratch}/${tag}-whoami.exe`]).status === 0;
    asUser('ma-worker1', '/usr/bin/chmod', ['0700', `${scratch}/${tag}-whoami.exe`]);
    ctx.cleanup.push(() => asUser('ma-worker1', '/usr/bin/rm', ['-f', `${scratch}/${tag}-whoami.exe`, `${scratch}/${tag}-ma-worker1`]));
  });

  before(async () => {
    if (ctx.blockers.length) return;
    ctx.supervisorPid = await new Promise((resolve) => {
      ctx.listener.stdout.once('data', (d) => resolve(Number(String(d).trim())));
      setTimeout(() => resolve(null), 10_000);
    });
    // Every denial target must be live from its owner's side, or a denial proves nothing.
    if (!Number.isInteger(ctx.supervisorPid)) ctx.blockers.push('fixture-failed:supervisor-listener');
    const ready = asControl(TOOL_NODE, ['-e', `
      const fs = require('node:fs');
      const net = require('node:net');
      for (const f of ${JSON.stringify([sentinels.ownerToken, sentinels.database, sentinels.wal, sentinels.shm, sentinels.browserSessions])}) fs.accessSync(f, fs.constants.R_OK | fs.constants.W_OK);
      const sockets = ${JSON.stringify([sentinels.supervisorSocket, sentinels.controlTmux])};
      Promise.all(sockets.map((p) => new Promise((ok, no) => { const s = net.connect(p); s.once('connect', () => { s.destroy(); ok(); }); s.once('error', no); })))
        .then(() => process.exit(0), (e) => { console.error(e.code); process.exit(1); });
    `]);
    if (ready.status !== 0) ctx.blockers.push(`fixture-failed:control-targets:${ready.stderr.trim().slice(0, 60)}`);
    const ownerReady = await new Promise((resolve) => {
      const s = createConnection(ownerTmuxSocket);
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (!ownerReady) ctx.blockers.push('fixture-failed:owner-tmux-socket');
    if (ctx.blockers.length) return;
    ctx.impl = probe('ma-worker1', 'implementer', implTree);
    ctx.rev = probe('ma-worker2', 'reviewer', revTree, { windowsPe: WINDOWS_PE, codexSandboxCases: [] });
  });

  after(() => {
    for (const fn of ctx.cleanup.reverse()) {
      try {
        fn();
      } catch {
        // Cleanup is best effort; leftovers are inside control-owned paths.
      }
    }
    const receiptDir = path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? '/tmp', '.local', 'state'), 'multi-agent', 'preflight');
    mkdirSync(receiptDir, { recursive: true });
    const receipt = {
      schema: 'multi-agent-isolation-preflight/v1',
      recorded_at: new Date().toISOString(),
      blockers: ctx.blockers,
      facts: ctx.facts,
      implementer_probe: ctx.impl ?? null,
      reviewer_probe: ctx.rev ?? null,
    };
    writeFileSync(path.join(receiptDir, `${tag}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`# preflight receipt: ${path.join(receiptDir, `${tag}.json`)}\n`);
  });

  test('records host, kernel and toolchain facts', () => {
    const os = Object.fromEntries(readFileSync('/etc/os-release', 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')).map(([k, v]) => [k, v?.replace(/^"|"$/g, '')]));
    Object.assign(ctx.facts, {
      os: os.PRETTY_NAME,
      kernel: readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(),
      legacy_tiocsti: run('/usr/sbin/sysctl', ['-n', 'dev.tty.legacy_tiocsti']).stdout.trim(),
      interop: existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') ? readFileSync('/proc/sys/fs/binfmt_misc/WSLInterop', 'utf8').split('\n')[0] : 'absent',
      node: run(TOOL_NODE, ['-v']).stdout.trim(),
      bwrap: run('/usr/bin/bwrap', ['--version']).stdout.trim(),
      tmux: run('/usr/bin/tmux', ['-V']).stdout.trim(),
      setpriv: run('/usr/bin/setpriv', ['--version']).stdout.trim(),
      claude: run(`${P.toolchain_dir}/clients/bin/claude`, ['--version'], { env: { PATH: SANDBOX_PATH } }).stdout.trim(),
      codex: run(`${P.toolchain_dir}/clients/bin/codex`, ['--version'], { env: { PATH: SANDBOX_PATH } }).stdout.trim(),
      policy_revision: policy.policy_revision,
    });
    blocked();
    assert.match(ctx.facts.node, /^v24\./);
  });

  test('installed launcher and policy match the reviewed sources and are root-owned', () => {
    blocked();
    const installed = {
      [LAUNCHER]: null,
      [P.installed_launcher]: path.join(here, '..', 'config', 'isolation', 'worker-launch.mjs'),
      [P.installed_policy]: policyPath,
    };
    ctx.facts.installed = {};
    for (const [file, source] of Object.entries(installed)) {
      const st = statSync(file);
      const mode = (st.mode & 0o7777).toString(8);
      ctx.facts.installed[file] = { sha256: sha256File(file), uid: st.uid, gid: st.gid, mode };
      assert.equal(st.uid, 0, `${file} must be root-owned`);
      assert.equal(st.mode & 0o022, 0, `${file} must not be group/other writable`);
      if (source) assert.equal(sha256File(file), sha256File(source), `${file} differs from ${source}`);
    }
    const sudoers = statSync('/etc/sudoers.d/multi-agent-launcher');
    ctx.facts.installed['/etc/sudoers.d/multi-agent-launcher'] = { uid: sudoers.uid, gid: sudoers.gid, mode: (sudoers.mode & 0o7777).toString(8) };
    assert.equal(sudoers.uid, 0);
    assert.equal(sudoers.mode & 0o7777, 0o440);
    // The control identity's effective sudo grant is exactly the launcher.
    const grants = asControl('/usr/bin/sudo', ['-n', '-l']).stdout;
    const commands = grants.slice(grants.indexOf('may run the following commands')).split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    ctx.facts.control_sudo_grants = commands;
    assert.deepEqual(commands, [`(root) NOPASSWD: ${LAUNCHER}`]);
    const writable = run('/usr/bin/find', [P.toolchain_dir, '-not', '-type', 'l', '(', '-perm', '/022', '-o', '-not', '-user', 'root', ')', '-print', '-quit']);
    assert.equal(writable.status, 0, `find failed: ${writable.stderr}`);
    assert.equal(writable.stdout.trim(), '', 'toolchain must be root-owned and not group/other writable');
    // The sudo-reachable wrapper must be exactly the environment-clearing exec written by provisioning.
    assert.equal(readFileSync(LAUNCHER, 'utf8'), `#!/bin/sh\nexec /usr/bin/env -i SUDO_UID="$SUDO_UID" PATH=/usr/bin:/bin "${TOOL_NODE}" "${P.installed_launcher}" "$@"\n`);
  });

  test('identities are distinct, unprivileged and cannot reach each other or the launcher', () => {
    blocked();
    const uids = new Set();
    for (const name of [policy.control_identity, ...policy.worker_identities]) {
      const groups = run('/usr/bin/id', ['-Gn', name]).stdout.trim().split(/\s+/);
      assert.deepEqual(groups, [name], `${name} must hold only its own group`);
      uids.add(run('/usr/bin/id', ['-u', name]).stdout.trim());
    }
    assert.equal(uids.size, 1 + policy.worker_identities.length);
    assert.ok(!uids.has(String(process.getuid())), 'owner must differ from control and workers');
    // Second layer: ownership denies access even outside the sandbox.
    assert.notEqual(asUser('ma-worker1', '/usr/bin/cat', [sentinels.ownerToken]).status, 0);
    assert.notEqual(asUser('ma-worker1', '/usr/bin/ls', [`${P.worker_root}/ma-worker2`]).status, 0);
    // Only the control identity may invoke the launcher.
    assert.notEqual(asUser('ma-worker1', '/usr/bin/sudo', ['-n', LAUNCHER, '--worker', 'ma-worker1', '--', TOOL_NODE]).status, 0);
  });

  test('launcher rejects out-of-policy requests with distinct codes', () => {
    blocked();
    const base = ['--role', 'implementer', '--', TOOL_NODE, '-v'];
    const cases = [
      [['--worker', policy.control_identity, '--tree', implTree, ...base], 'worker-not-allowed'],
      [['--worker', 'ma-worker1', '--tree', stageDir, ...base], 'tree-outside-assignment'],
      [['--worker', 'ma-worker1', '--tree', escapeLink, ...base], 'tree-outside-assignment'],
      [['--worker', 'ma-worker1', '--tree', implTree, '--env', 'LD_PRELOAD=/x', ...base], 'env-not-allowed'],
      [['--worker', 'ma-worker1', '--tree', implTree, '--role', 'implementer', '--', WINDOWS_PE], 'command-not-allowed'],
    ];
    for (const [args, code] of cases) {
      const r = launcherViaControl(args);
      assert.equal(r.status, 126, `expected rejection for ${code}`);
      assert.equal(launcherError(r), code);
    }
    // A host directory on stdin would let the worker openat() outside its mounts.
    const dirFd = openSync('/', 'r');
    try {
      const r = launcherViaControl(['--worker', 'ma-worker1', '--tree', implTree, ...base], { stdio: [dirFd, 'pipe', 'pipe'] });
      assert.equal(r.status, 126, 'a directory on stdin must be rejected');
      assert.equal(launcherError(r), 'stdio-not-allowed');
    } finally {
      closeSync(dirFd);
    }
  });

  test('worker runs as its own identity with no privileges or inherited descriptors', () => {
    blocked();
    const impl = ctx.impl;
    assert.ok(!impl.launch_failed, `implementer launch failed: ${JSON.stringify(impl)}`);
    const uid = Number(run('/usr/bin/id', ['-u', 'ma-worker1']).stdout.trim());
    assert.equal(impl.identity.uid, uid);
    // bwrap nests a second user namespace, so uid_map shows the intermediate
    // namespace; the real/effective/saved/fs ids and host-side ownership are the proof.
    assert.deepEqual(impl.identity.status_uid.split(/\s+/), [String(uid), String(uid), String(uid), String(uid)]);
    assert.equal(impl.identity.no_new_privs, '1');
    assert.equal(impl.identity.cap_eff, '0000000000000000');
    // Node opens its own pipes/epoll/eventfd descriptors; only path-backed ones matter.
    const sandboxRoots = ['/dev/', '/proc/', '/work', '/scratch', '/home/worker', '/tmp', '/opt/multi-agent/', '/usr/'];
    const foreign = impl.fd_targets.filter((t) => t && t.startsWith('/') && !sandboxRoots.some((r) => t.startsWith(r)));
    assert.deepEqual(foreign, [], `worker inherited host descriptors: ${foreign}`);
    assert.ok(!impl.fd_targets.some((t) => t?.includes('worker-policy.json')), 'the owner-side fd 3 must not be inherited');
    for (const key of ['WSL_INTEROP', 'TMUX', 'SUDO_UID', 'SUDO_USER', 'SSH_AUTH_SOCK', 'WSLENV']) {
      assert.ok(!impl.env_keys.includes(key), `leaked env ${key}`);
    }
    // Real host identity: the scratch marker is owned by the worker uid.
    const owner = asUser('ma-worker1', '/usr/bin/stat', ['-c', '%u', `${P.worker_root}/ma-worker1/scratch/${tag}-ma-worker1`]).stdout.trim();
    assert.equal(owner, String(uid));
  });

  test('worker cannot reach control token, database/WAL/shared memory, sockets or owner panes', () => {
    blocked();
    for (const probeResult of [ctx.impl, ctx.rev]) {
      assert.ok(!probeResult.launch_failed, JSON.stringify(probeResult));
      for (const [kind, entries] of Object.entries({ read: probeResult.read, write: probeResult.write, list: probeResult.list, connect: probeResult.connect })) {
        for (const [target, result] of Object.entries(entries)) assert.equal(result.ok, false, `${kind} ${target} must be denied`);
      }
    }
  });

  test('no host-process or Windows-interoperation path escapes the boundary', () => {
    blocked();
    assert.equal(ctx.impl.kill_host_pid.ok, false, 'host process must be invisible');
    assert.ok(ctx.impl.pid_count < 10, `sandbox sees ${ctx.impl.pid_count} processes`);
    assert.ok(ctx.peStaged, 'a Windows executable copy must be staged to test interop');
    assert.equal(ctx.impl.exec_windows_pe.present, true, 'the staged Windows executable must be visible inside the sandbox');
    assert.equal(ctx.impl.exec_windows_pe.ran, false, 'a copied Windows executable must not run');
    assert.equal(ctx.rev.exec_windows_pe.ran, false, 'a Windows-mounted executable must not run');
    ctx.facts.abstract_unix_sockets_visible = ctx.impl.abstract_sockets;
    // Windows-backed filesystems (drvfs/9p) must not appear anywhere in the sandbox, including under /usr.
    ctx.facts.sandbox_windows_mounts = ctx.impl.windows_mounts;
    for (const m of ctx.impl.windows_mounts) assert.equal(m.reachable, false, `sandbox exposes ${m.fstype} mount ${m.point}`);
    assert.deepEqual(ctx.impl.usr_lib_wsl, { ok: true, v: [] }, 'the WSL driver and GPU trees must be masked');
    assert.equal(ctx.impl.usr_lib_wsl_write.code, 'EROFS', 'the mask must be read-only');
  });

  test('assigned scratch and implementer tree are writable; reviewer candidate is read-only', () => {
    blocked();
    assert.equal(ctx.impl.allow_scratch.ok, true, JSON.stringify(ctx.impl.allow_scratch));
    assert.equal(ctx.impl.allow_work.ok, true, JSON.stringify(ctx.impl.allow_work));
    assert.equal(ctx.rev.allow_scratch.ok, true, JSON.stringify(ctx.rev.allow_scratch));
    assert.equal(ctx.rev.allow_work.ok, false, 'reviewer must not write the candidate');
  });

  test('both native clients start inside the boundary and their sandboxes still function', () => {
    blocked();
    assert.equal(ctx.impl.claude_version.status, 0, JSON.stringify(ctx.impl.claude_version));
    assert.equal(ctx.impl.codex_version.status, 0, JSON.stringify(ctx.impl.codex_version));
    // Claude Code's Linux sandbox is bubblewrap plus socat; both must work nested.
    assert.equal(ctx.impl.nested_bwrap.status, 0, JSON.stringify(ctx.impl.nested_bwrap));
    assert.equal(ctx.impl.socat, true);
    for (const { id, expect, target, baseline } of CODEX_SANDBOX_CASES) {
      const r = ctx.impl.codex_sandbox[id];
      assert.equal(r.error, null, `codex sandbox ${id} did not start: ${JSON.stringify(r)}`);
      assert.equal(r.signal, null, `codex sandbox ${id} was killed: ${JSON.stringify(r)}`);
      assert.equal(r.status === 0 ? 'allow' : 'deny', expect, `codex sandbox ${id}: ${JSON.stringify(r)}`);
      if (target) assert.equal(r.target_exists, expect === 'allow', `codex sandbox ${id} left the wrong filesystem state`);
      if (baseline) assert.equal(r.baseline_status, 0, `codex sandbox ${id} positive control failed, so its denial is unproven`);
    }
  });

  test('Windows browser reaches a WSL loopback-only listener', async () => {
    blocked();
    const server = createServer((_, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      // Async: this process also serves the request. Forwarding can take a moment to appear.
      for (let i = 0; i < 10 && ctx.facts.windows_loopback !== '200'; i += 1) {
        const { stdout } = await execFileAsync(WINDOWS_CURL, ['-s', '--noproxy', '*', '-m', '3', '-o', 'NUL', '-w', '%{http_code}', `http://127.0.0.1:${port}/`]).catch((e) => ({ stdout: e.stdout ?? '' }));
        ctx.facts.windows_loopback = stdout.trim();
        if (ctx.facts.windows_loopback !== '200') await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(ctx.facts.windows_loopback, '200');
      const localAddrs = run('/usr/bin/ss', ['-Hltn', `sport = :${port}`]).stdout.trim().split('\n').map((l) => l.trim().split(/\s+/)[3]);
      assert.deepEqual(localAddrs, [`127.0.0.1:${port}`]);
    } finally {
      server.close();
    }
  });
});
