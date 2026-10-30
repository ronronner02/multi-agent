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
import childProcess, { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs, { chmodSync, closeSync, existsSync, readdirSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import net, { createConnection } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
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
  SECCOMP_FD,
  GATEWAY_FD,
  GATEWAY_ENV_PATH,
  buildSeccompFilter,
} from '../config/isolation/worker-launch.mjs';
import * as workerLaunch from '../config/isolation/worker-launch.mjs';
import { createEgressServer, isDeniedAddress, parseTarget, validateEgressConfig } from '../config/isolation/egress.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyPath = path.join(here, '..', 'config', 'isolation', 'worker-policy.json');
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));

const USERS = {
  'ma-control': { name: 'ma-control', uid: 990, gid: 990, groups: ['ma-control'] },
  'ma-worker1': { name: 'ma-worker1', uid: 991, gid: 991, groups: ['ma-worker1'] },
  'ma-worker2': { name: 'ma-worker2', uid: 992, gid: 992, groups: ['ma-worker2', 'sudo'] },
  leo: { name: 'leo', uid: 1000, gid: 1000, groups: ['leo', 'sudo'] },
  'ma-egress': { name: 'ma-egress', uid: 989, gid: 989, groups: ['ma-egress'] },
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
    lstat: (p) => {
      const privateRoot = policy.paths.context_root + '/ma-worker1';
      const privatePath = p === privateRoot || p.startsWith(privateRoot + '/');
      const depth = p.slice(privateRoot.length).split('/').filter(Boolean).length;
      return { uid: privatePath ? 990 : 0, gid: privatePath ? 991 : 0, mode: privatePath ? (depth >= 2 ? 0o550 : 0o2750) : 0o755,
        isDirectory: () => true, isSymbolicLink: () => false };
    },
    legacyTiocsti: 0,
    egressSocket: { dirUid: 989, dirMode: 0o755, isSocket: true },
    ...overrides,
  };
}

function launch(argv, factsOverrides) {
  const request = parseLaunchArgs(argv);
  request.run ??= 'run-1'; request.attempt ??= 'attempt-1';
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

describe('offline: control-owned launch preflight', () => {
  const argv = ['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE,
    '--run', 'run-1', '--attempt', 'attempt-1', '--env', 'TERM=fixture-secret', '--', NODE, '-e', 'fixture-secret'];
  const fileFact = (file) => ({ path: file, realpath: file, uid: 0, gid: 0, mode: 0o755,
    size: 31, sha256: 'sha256:' + createHash('sha256').update(file).digest('hex') });
  const facts = (overrides = {}) => fakeFacts({
    inspectFile: fileFact,
    policyFingerprint: fileFact(policy.paths.installed_policy).sha256,
    namespace: (kind) => ({ mnt: 'mnt:[101]', user: 'user:[102]', net: 'net:[103]' })[kind],
    ...overrides,
  });
  const inspect = (overrides = {}) => workerLaunch.inspectLaunchRequest(policy, parseLaunchArgs(argv), facts(overrides));

  test('returns observed installed facts without exposing command or environment values', () => {
    const result = inspect();
    assert.equal(result.schema, 'multi-agent-launch-preflight/v1');
    assert.deepEqual(result.worker, { name: 'ma-worker1', uid: 991, gid: 991 });
    assert.deepEqual(result.control, { uid: 990, gid: 990, mountNamespace: 'mnt:[101]', userNamespace: 'user:[102]' });
    assert.deepEqual(result.roots, { home: policy.paths.worker_root + '/ma-worker1/home',
      scratch: policy.paths.worker_root + '/ma-worker1/scratch', tree: TREE,
      context: policy.paths.context_root + '/ma-worker1/run-1/attempt-1', framework: policy.paths.framework_dir });
    assert.deepEqual(result.installed.executable, fileFact(NODE));
    assert.deepEqual(result.installed.policy, fileFact(policy.paths.installed_policy));
    assert.equal(result.network.hostNamespace, 'net:[103]');
    assert.equal(result.network.profileFingerprint, fileFact(policy.paths.installed_egress_config).sha256);
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
    assert.equal(Object.hasOwn(result, 'command'), false);
    assert.equal(Object.hasOwn(result, 'env'), false);
  });

  test('authenticates before reading privileged installed facts', () => {
    let reads = 0;
    expectLaunchError(() => inspect({ callerUid: 991, inspectFile: () => { reads += 1; throw new Error('not reached'); } }), 'caller-not-allowed');
    assert.equal(reads, 0);
  });

  test('retains existing assignment, environment and worker-group denials', () => {
    for (const [replace, expected] of [
      [['--tree', '/var/lib/multi-agent/control'], 'tree-outside-assignment'],
      [['--env', 'NODE_OPTIONS=fixture'], 'env-not-allowed'],
      [['--worker', 'ma-worker2'], 'worker-privileged-group'],
    ]) {
      const invalid = [...argv]; invalid[invalid.indexOf(replace[0]) + 1] = replace[1];
      expectLaunchError(() => workerLaunch.inspectLaunchRequest(policy, parseLaunchArgs(invalid), facts()), expected);
    }
  });

  test('does not reuse a stale executable or network fingerprint', () => {
    const first = inspect(), changed = 'sha256:' + 'f'.repeat(64);
    const next = inspect({ inspectFile: (file) => ({ ...fileFact(file),
      sha256: file === NODE || file === policy.paths.installed_egress_config ? changed : fileFact(file).sha256 }) });
    assert.notEqual(next.installed.executable.sha256, first.installed.executable.sha256);
    assert.equal(next.network.profileFingerprint, changed);
  });

  test('rejects missing or untrusted installed-file evidence', () => {
    for (const change of [
      { uid: 991 }, { gid: 991 }, { mode: 0o777 }, { mode: 0o644 }, { size: -1 }, { sha256: 'unverified' },
      { path: '/unexpected' }, { realpath: '/home/worker/override' },
    ]) {
      expectLaunchError(() => inspect({ inspectFile: (file) => ({ ...fileFact(file), ...change }) }), 'preflight-unverified');
    }
    expectLaunchError(() => inspect({ inspectFile: () => { throw new Error('ENOENT'); } }), 'preflight-unverified');
  });

  test('rejects policy bytes changed after request validation', () => {
    expectLaunchError(() => inspect({ policyFingerprint: 'sha256:' + 'b'.repeat(64) }), 'preflight-unverified');
  });

  test('hashes the actual opened root-owned executable', { skip: process.platform !== 'linux' }, () => {
    const file = '/usr/bin/true', observed = workerLaunch.inspectInstalledFile(file);
    assert.equal(observed.uid, 0); assert.equal(observed.gid, 0);
    assert.equal(observed.size, readFileSync(file).length);
    assert.equal(observed.sha256, 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex'));
  });

  test('rejects files below mutable ancestry without disclosing their contents', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 't010-preflight-read-'));
    try {
      const file = path.join(dir, 'private.txt'); writeFileSync(file, 'private-fixture-content', { mode: 0o400 });
      assert.throws(() => workerLaunch.inspectInstalledFile(file), error =>
        error instanceof LaunchError && error.code === 'preflight-unverified' && !error.message.includes('private-fixture-content'));
    } finally {
      assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the inspect entry retains the non-root execution gate', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, () => {
    const result = spawnSync(process.execPath, [path.join(here, '../config/isolation/worker-launch.mjs'), '--inspect', ...argv],
      { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 126); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).worker_launch_error, 'launcher-not-root');
  });

  test('rejects missing or malformed host namespace observations', () => {
    for (const value of [null, '', 'expected', 'net:[unverified]']) {
      expectLaunchError(() => inspect({ namespace: () => value }), 'preflight-unverified');
    }
  });
});

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

  test('KTD23: the host network namespace is never an accepted posture', () => {
    for (const mutate of [
      (p) => { p.sandbox.network = 'host-shared'; },
      (p) => { p.policy_revision = 2; },
      (p) => { delete p.sandbox.egress_port; },
      (p) => { p.sandbox.egress_port = 80; },
    ]) {
      const bad = structuredClone(policy);
      mutate(bad);
      expectLaunchError(() => validatePolicy(bad), 'policy-invalid');
    }
  });

  test('KTD23: the egress identity is its own unprivileged identity and its paths stay out of reach', () => {
    for (const mutate of [
      (p) => { p.egress_identity = p.control_identity; },
      (p) => { p.egress_identity = p.worker_identities[0]; },
      (p) => { p.forbidden_worker_groups = p.forbidden_worker_groups.filter((g) => g !== p.egress_identity); },
      (p) => { p.paths.egress_socket_dir = '/var/lib/multi-agent/egress'; },
      (p) => { p.paths.installed_egress = '/usr/local/lib/egress.mjs'; },
    ]) {
      const bad = structuredClone(policy);
      mutate(bad);
      expectLaunchError(() => validatePolicy(bad), 'policy-invalid');
    }
  });

  test('KTD23: callers cannot pass proxy settings through the environment allow-list', () => {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY']) {
      const bad = structuredClone(policy);
      bad.env_passthrough.push(key);
      expectLaunchError(() => validatePolicy(bad), 'policy-invalid');
    }
  });
});

describe('offline: egress filter availability at launch', () => {
  const argv = ['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE, '--', NODE];
  test('a missing, foreign-owned or writable egress socket blocks the launch with a distinct code', () => {
    for (const egressSocket of [
      null,
      { dirUid: 989, dirMode: 0o755, isSocket: false },
      { dirUid: 990, dirMode: 0o755, isSocket: true },
      { dirUid: 989, dirMode: 0o777, isSocket: true },
    ]) {
      expectLaunchError(() => launch(argv, { egressSocket }), 'egress-unavailable');
    }
    expectLaunchError(() => launch(argv, { lookupUser: (name) => (name === 'ma-egress' ? null : USERS[name] ?? null) }), 'egress-unavailable');
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

describe('offline: KTD24 mandatory private context mounts', () => {
  const argv = ['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE, '--', NODE];
  const context = policy.paths.context_root + '/ma-worker1/run-1/attempt-1';
  test('run and attempt are required and traversal identifiers are rejected', () => {
    for (const flags of [[], ['--run', 'run-1'], ['--attempt', 'attempt-1']]) {
      const request = parseLaunchArgs([...argv.slice(0, -2), ...flags, '--', NODE]);
      expectLaunchError(() => resolveLaunchRequest(policy, request, fakeFacts()), 'context-missing');
    }
    expectLaunchError(() => parseLaunchArgs(['--run', '../other', '--', NODE]), 'argument-invalid');
  });
  test('a missing context or framework source blocks rather than skipping its mount', () => {
    for (const source of [context, policy.paths.framework_dir]) {
      const facts = fakeFacts();
      expectLaunchError(() => launch(argv, { lstat: (p) => { if (p === source) throw new Error('ENOENT'); return facts.lstat(p); } }), 'context-mount-unavailable');
    }
  });
  test('context sources must be control-owned, worker-private, read-only and free of aliases', () => {
    for (const change of [
      (st) => ({ ...st, uid: 991 }),
      (st) => ({ ...st, uid: 0 }),
      (st) => ({ ...st, gid: 992 }),
      (st) => ({ ...st, mode: 0o555 }),
      (st) => ({ ...st, mode: 0o750 }),
      (st) => ({ ...st, isSymbolicLink: () => true }),
    ]) {
      const facts = fakeFacts();
      expectLaunchError(() => launch(argv, { lstat: (p) => p === context ? change(facts.lstat(p)) : facts.lstat(p) }), 'context-mount-unavailable');
    }
    const facts = fakeFacts();
    expectLaunchError(() => launch(argv, { realpath: (p) => p === context ? context.replace('ma-worker1', 'ma-worker2') : facts.realpath(p) }), 'context-mount-unavailable');
    expectLaunchError(() => launch(argv, { lstat: (p) => p === policy.paths.context_root ? { ...facts.lstat(p), mode: 0o777 } : facts.lstat(p) }), 'context-mount-unavailable');
  });
  test('policy revision and mount roots cannot alias writable or shared context', () => {
    for (const change of [
      (p) => { p.policy_revision = 3; },
      (p) => { delete p.paths.context_root; },
      (p) => { p.paths.context_root = p.paths.assignment_root; },
      (p) => { p.paths.context_root = p.paths.framework_dir; },
      (p) => { delete p.sandbox.context; },
      (p) => { p.sandbox.work = '/context'; },
    ]) {
      const bad = structuredClone(policy); change(bad);
      expectLaunchError(() => validatePolicy(bad), 'policy-invalid');
    }
  });
});


describe('offline: fixed native policy and mailbox mounts', () => {
  const socket = '/var/lib/multi-agent/control/mailboxes/ma-worker1/run-1/attempt-1/mailbox.sock';
  const context = policy.paths.context_root + '/ma-worker1/run-1/attempt-1';
  const nativePath = context + '/native/claude/managed-settings.json';
  const bootstrapPath = path.dirname(socket) + '/bootstrap.json';
  const bootstrap = { authorization: 'Bearer bootstrap-fixture-secret', sessionId: 'session', runId: 'run-1', attemptId: 'attempt-1',
    generation: 'generation', taskId: 'task', capability: 'mailbox:' + 'a'.repeat(43) };
  const executable = policy.paths.toolchain_dir + '/clients/bin/claude';
  const lockRaw = readFileSync(path.join(here, '..', 'config', 'isolation', 'client-lock.json'), 'utf8');
  const lock = JSON.parse(lockRaw);
  const clientLock = { raw: lockRaw, sha256: 'sha256:' + createHash('sha256').update(lockRaw).digest('hex') };
  // Installed clients as the KTD27 lock pins them: each entry point resolves to its first pinned file.
  const lockedFile = (file) => {
    for (const [client, entry] of Object.entries(lock.clients)) {
      const pinned = entry.files.find(f => policy.paths.toolchain_dir + '/' + f.path === file);
      if (pinned) return { path: file, realpath: file, sha256: pinned.sha256 };
      if (file === policy.paths.toolchain_dir + '/clients/bin/' + (client === 'codex' ? 'codex' : 'claude')) {
        return { path: file, realpath: policy.paths.toolchain_dir + '/' + entry.files[0].path, sha256: entry.files[0].sha256 };
      }
    }
    throw new Error('not installed');
  };
  const argv = ['--worker', 'ma-worker1', '--role', 'implementer', '--tree', TREE,
    '--run', 'run-1', '--attempt', 'attempt-1', '--mailbox', '9:22', '--client-lock', clientLock.sha256, '--', executable];
  const gatewayFixture = (change = {}) => ({ client: 'claude-code', baseUrl: 'https://gateway.invalid/claude',
    bearer: 'e'.repeat(32), model: 'pinned-model', digest: 'sha256:' + 'a'.repeat(64), ...change });
  const facts = (change = {}, deepest = {}, readGateway = () => null) => {
    const base = fakeFacts();
    return { ...base, clientLock, readGateway, inspectFile: lockedFile, readFile: p => { assert.equal(p, bootstrapPath); return JSON.stringify(bootstrap); }, lstat: p => {
      if (p === bootstrapPath) return { uid: 990, gid: 990, dev: 10, ino: 24, mode: 0o600, size: 256,
        isFile: () => true, isSymbolicLink: () => false };
      // Control-owned, worker-group, 0660: reachable by the owning worker, by nothing else.
      if (p === socket) return { uid: 990, gid: 991, dev: 9, ino: 22, mode: 0o660,
        isSocket: () => true, isSymbolicLink: () => false, ...change };
      if (p === path.dirname(socket)) return { uid: 990, gid: 990, mode: 0o711,
        isDirectory: () => true, isSymbolicLink: () => false, ...deepest };
      if (p === policy.paths.control_state_dir || p.startsWith(policy.paths.control_state_dir + '/')) {
        // Strictly private at the root; traverse-only below it, which is what a live launch needs
        // because bwrap resolves the mailbox descriptor as the worker.
        const mode = p === policy.paths.control_state_dir ? 0o700 : 0o711;
        return { uid: 990, gid: 990, mode, isDirectory: () => true, isSymbolicLink: () => false };
      }
      if (p === nativePath) return { uid: 990, gid: 991, dev: 10, ino: 23, mode: 0o440, size: 200,
        isFile: () => true, isSymbolicLink: () => false };
      return base.lstat(p);
    } };
  };

  test('requires revision five and fixed mailbox-only paths', () => {
    assert.equal(policy.policy_revision, 5);
    assert.equal(policy.paths.mailbox_root, policy.paths.control_state_dir + '/mailboxes');
    assert.equal(policy.sandbox.mailbox, '/run/multi-agent/mailbox.sock');
    for (const change of [
      p => { p.paths.mailbox_root = p.paths.worker_root; },
      p => { p.sandbox.mailbox = '/run/control.sock'; },
      p => { p.sandbox.native_policy_mounts.codex.target = '/etc/multi-agent/worker-policy.json'; },
    ]) {
      const bad = structuredClone(policy); change(bad);
      expectLaunchError(() => validatePolicy(bad), 'policy-invalid');
    }
  });

  test('binds only the registered socket and immutable native policy through held descriptors', () => {
    const resolved = resolveLaunchRequest(policy, parseLaunchArgs(argv), facts());
    assert.equal(resolved.mailbox.path, socket);
    assert.equal(resolved.nativePolicy.path, nativePath);
    const { args } = buildSandboxCommand(policy, resolved);
    const mailboxIndex = args.indexOf('/run/multi-agent/mailbox.sock');
    assert.deepEqual(args.slice(mailboxIndex - 2, mailboxIndex + 1), ['--ro-bind-fd', String(MOUNT_FD.mailbox), '/run/multi-agent/mailbox.sock']);
    assert.ok(mailboxIndex > args.indexOf('/run'));
    const nativeIndex = args.indexOf('/etc/claude-code/managed-settings.json');
    assert.deepEqual(args.slice(nativeIndex - 2, nativeIndex + 1), ['--ro-bind-fd', String(MOUNT_FD.nativePolicy), '/etc/claude-code/managed-settings.json']);
    assert.ok(!args.some(arg => arg.startsWith(policy.paths.control_state_dir)));
    assert.ok(!args.includes(nativePath));
    assert.ok(args.includes('--remount-ro'));
    assert.ok(args.includes('/etc/claude-code'));
  });

  test('KTD27: the shared launch validator refuses a client build outside the lock, fresh and on resume', () => {
    const good = facts();
    const rebuilt = { ...good, inspectFile: file => ({ ...good.inspectFile(file), sha256: 'sha256:' + 'f'.repeat(64) }) };
    for (const command of [[executable], [executable, '--resume', 'native-session']]) {
      expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs([...argv.slice(0, -1), ...command]), rebuilt), 'unsupported-version');
    }
    assert.equal(resolveLaunchRequest(policy, parseLaunchArgs(argv), good).clientLock.digest, clientLock.sha256);
  });

  test('inspection reports provider sign-in from credential metadata in the worker home, never its bytes', () => {
    const home = policy.paths.worker_root + '/ma-worker1/home', credential = home + '/.claude/.credentials.json';
    const installed = file => { let fact; try { fact = lockedFile(file); } catch { fact = { path: file, realpath: file,
      sha256: 'sha256:' + createHash('sha256').update(file).digest('hex') }; } return { uid: 0, gid: 0, mode: 0o755, size: 1, ...fact }; };
    const inspect = (credentialStat, symlinked = []) => {
      const base = facts();
      return workerLaunch.inspectLaunchRequest(policy, parseLaunchArgs(argv), { ...base, inspectFile: installed,
        policyFingerprint: installed(policy.paths.installed_policy).sha256,
        namespace: kind => ({ mnt: 'mnt:[101]', user: 'user:[102]', net: 'net:[103]' })[kind],
        lstat: p => p === credential ? credentialStat() : p === home || p === home + '/.claude'
          ? { isDirectory: () => !symlinked.includes(p), isSymbolicLink: () => symlinked.includes(p) } : base.lstat(p) });
    };
    const file = (change = {}) => () => ({ uid: 991, mode: 0o100600, size: 412, isFile: () => true, isSymbolicLink: () => false, ...change });
    const failure = code => () => { throw Object.assign(new Error(code), { code }); };
    const result = inspect(file());
    assert.deepEqual(result.provider, { client: 'claude-code', status: 'signed_in' });
    assert.equal(result.clientLock.digest, clientLock.sha256);
    assert.equal(inspect(failure('ENOENT')).provider.status, 'signed_out');
    for (const stat of [file({ uid: 990 }), file({ mode: 0o100640 }), file({ size: 0 }), file({ isFile: () => false }),
      file({ isSymbolicLink: () => true }), failure('EACCES')]) assert.equal(inspect(stat).provider.status, 'unknown');
    assert.equal(inspect(file(), [home + '/.claude']).provider.status, 'unknown');
  });

  test('KTD27: a native launch is bound to the installed lock and reachable only through its entry point', () => {
    const unbound = argv.filter((arg, i) => arg !== '--client-lock' && argv[i - 1] !== '--client-lock');
    expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(unbound), facts()), 'client-lock-unbound');
    expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(argv), { ...facts(), clientLock: null }), 'client-lock-unavailable');
    for (const command of [[policy.paths.toolchain_dir + '/' + lock.clients['claude-code'].files[0].path],
      [NODE, policy.paths.toolchain_dir + '/' + lock.clients.codex.files[0].path]]) {
      expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs([...argv.slice(0, -1), ...command]), facts()), 'client-entrypoint-required');
    }
    const alias = '/usr/bin/claude-alias', aliased = facts();
    expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs([...argv.slice(0, -1), alias]),
      { ...aliased, realpath: p => p === alias ? executable : aliased.realpath(p) }), 'client-entrypoint-required');
  });

  test('KTD27: the observed native process chain comes from the installed lock, not the caller', { skip: !existsSync(NODE) }, () => {
    const node = realpathSync(NODE), file = entry => policy.paths.toolchain_dir + '/' + entry.files.at(-1).path;
    const request = command => parseLaunchArgs([...argv.slice(0, -1), ...command]);
    assert.deepEqual(workerLaunch.nativeProcessChain(policy, request([executable]), clientLock), [node, file(lock.clients['claude-code'])]);
    assert.deepEqual(workerLaunch.nativeProcessChain(policy, request([policy.paths.toolchain_dir + '/clients/bin/codex']), clientLock),
      [node, node, file(lock.clients.codex)]);
    for (const [command, installed] of [[[NODE], clientLock], [[executable], null], [[executable], { ...clientLock, sha256: 'sha256:' + '0'.repeat(64) }]]) {
      assert.throws(() => workerLaunch.nativeProcessChain(policy, request(command), installed));
    }
  });

  test('resolves each client id through the reader to its own gateway section, and refuses what it cannot verify', () => {
    // A mismatch here made every Claude launch run unauthenticated while the whole suite stayed
    // green, because the reader returns null for an unknown section and null is indistinguishable
    // from "no gateway configured". This goes through the reader's own selection, so reverting it
    // to `parsed[client]` fails here instead of silently in a live launch.
    const config = JSON.stringify({ schema: 'multi-agent-provider-gateway/v1',
      claude: { base_url: 'https://gateway.invalid/claude', bearer: 'c'.repeat(32), model: 'ds/claude-opus-5-5' },
      codex: { base_url: 'https://gateway.invalid/codex', bearer: 'd'.repeat(32), model: 'gpt-6.1-sol' } });
    assert.deepEqual(workerLaunch.providerGatewayEntry(config, 'claude-code'),
      { client: 'claude-code', baseUrl: 'https://gateway.invalid/claude', bearer: 'c'.repeat(32), model: 'ds/claude-opus-5-5' });
    assert.deepEqual(workerLaunch.providerGatewayEntry(config, 'codex'),
      { client: 'codex', baseUrl: 'https://gateway.invalid/codex', bearer: 'd'.repeat(32), model: 'gpt-6.1-sol' });
    for (const broken of [
      '{}',
      JSON.stringify({ schema: 'multi-agent-provider-gateway/v1' }),
      JSON.stringify({ schema: 'multi-agent-provider-gateway/v1', claude: { base_url: 'http://plain.invalid', bearer: 'c'.repeat(32), model: 'm' } }),
      JSON.stringify({ schema: 'multi-agent-provider-gateway/v1', codex: { base_url: 'https://g.invalid', bearer: 'short', model: 'gpt-6.1-sol' } }),
      'not json',
    ]) {
      assert.equal(workerLaunch.providerGatewayEntry(broken, 'claude-code'), null, broken);
      assert.equal(workerLaunch.providerGatewayEntry(broken, 'codex'), null, broken);
    }
  });

  test('admits only a root-owned, exactly 0640, control-group gateway file', () => {
    // 0644 passed the old check: it had no write bit, but every host identity could read the bearer.
    const st = (change = {}) => ({ isFile: () => true, uid: 0, gid: 990, mode: 0o100640, size: 512, ...change });
    assert.equal(workerLaunch.gatewayFileAdmits(st(), 990), true);
    for (const change of [{ mode: 0o100644 }, { mode: 0o100604 }, { mode: 0o100660 }, { mode: 0o100600 },
      { gid: 991 }, { gid: 0 }, { uid: 991 }, { isFile: () => false }, { size: 65_537 }]) {
      assert.equal(workerLaunch.gatewayFileAdmits(st(change), 990), false, JSON.stringify(change));
    }
    assert.equal(workerLaunch.gatewayFileAdmits(st(), undefined), false);
  });

  test('binds a gateway launch to the admitted digest and refuses when it cannot verify it', () => {
    const index = argv.indexOf('--');
    const digest = gatewayFixture().digest;
    const bound = command => [...argv.slice(0, index), '--gateway', digest, '--', ...command];
    // The admitted bytes are what execution carries: the same digest resolves, and the launch holds
    // the verified endpoint and model, which are the values buildSandboxCommand delivers.
    const admitted = resolveLaunchRequest(policy, parseLaunchArgs(bound([executable])), facts({}, {}, () => gatewayFixture()));
    assert.deepEqual([admitted.gateway.model, admitted.gateway.baseUrl], ['pinned-model', 'https://gateway.invalid/claude']);
    // A file replaced between admission and execution is refused rather than paired with a stale endpoint.
    const changed = facts({}, {}, () => gatewayFixture({ digest: 'sha256:' + 'b'.repeat(64) }));
    expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(bound([executable])), changed), 'provider-gateway-changed');
    // So is a configuration that vanished, which is the cold-launch half of the same defect.
    expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(bound([executable])), facts({}, {}, () => null)), 'provider-gateway-changed');
    // A gateway digest names a native client; a non-client command cannot be bound to one.
    expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(bound([NODE, '-e', '1'])), facts()), 'provider-gateway-changed');
    const malformed = [...argv.slice(0, index), '--gateway', 'sha256:xyz', ...argv.slice(index)];
    expectLaunchError(() => parseLaunchArgs(malformed), 'argument-invalid');
  });

  test('requires a registered mailbox before either native client starts', () => {
    for (const client of ['claude', 'codex']) {
      const request = parseLaunchArgs([...argv.slice(0, 10), '--', policy.paths.toolchain_dir + '/clients/bin/' + client]);
      expectLaunchError(() => resolveLaunchRequest(policy, request, facts()), 'mailbox-unavailable');
    }
  });

  test('rejects a missing, replaced, aliased, foreign-owned or publicly discoverable endpoint', () => {
    // The control-group 0666 shape was the legacy endpoint a previously provisioned host carried; it
    // let any worker that knew the pathname connect, so it is refused rather than migrated.
    for (const change of [{ uid: 991 }, { gid: 990 }, { gid: 992 }, { ino: 99 }, { dev: 99 },
      { mode: 0o666 }, { gid: 990, mode: 0o666 }, { mode: 0o777 }, { isSocket: () => false }]) {
      expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(argv), facts(change)), 'mailbox-unavailable');
    }
    const good = facts();
    for (const changed of [
      { lstat: p => { if (p === socket) throw new Error('ENOENT'); return good.lstat(p); } },
      { realpath: p => p === socket ? socket + '-other' : p },
      { lstat: p => p === path.dirname(socket) ? { ...good.lstat(p), mode: 0o755 } : good.lstat(p) },
      { lstat: p => p === path.dirname(socket) ? { ...good.lstat(p), mode: 0o774 } : good.lstat(p) },
    ]) expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(argv), { ...good, ...changed }), 'mailbox-unavailable');
  });

  test('requires the deepest mailbox level to be traversable by the owning worker with its own ids', () => {
    // The worker arrives with `--clear-groups`, so a group-execute bit held by a group it is not in
    // is not access: the worker's effective class at a control-group 0710 level is "other", which
    // has no execute bit, and binding its own socket would be refused after a launch was admitted.
    assert.equal(resolveLaunchRequest(policy, parseLaunchArgs(argv), facts({}, { gid: 991, mode: 0o710 })).mailbox.gid, 991);
    expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(argv), facts({}, { gid: 990, mode: 0o710 })), 'mailbox-unavailable');
    assert.equal(resolveLaunchRequest(policy, parseLaunchArgs(argv), facts({}, { gid: 990, mode: 0o711 })).mailbox.gid, 991);
  });

  test('rejects changed native policy ownership, write access, type and path before binding', () => {
    const good = facts();
    for (const change of [{ uid: 991 }, { gid: 992 }, { mode: 0o640 }, { isFile: () => false }, { isSymbolicLink: () => true }]) {
      expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(argv),
        { ...good, lstat: p => p === nativePath ? { ...good.lstat(p), ...change } : good.lstat(p) }), 'native-policy-unavailable');
    }
    expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(argv),
      { ...good, realpath: p => p === nativePath ? nativePath + '-other' : p }), 'native-policy-unavailable');
  });

  test('rejects non-canonical descriptor identities rather than accepting paths or generations', () => {
    for (const value of ['../mailbox.sock', '01:22', '-1:22', '9:NaN', '9:22\n', '9:9007199254740992']) {
      const args = [...argv]; args[args.indexOf('--mailbox') + 1] = value;
      expectLaunchError(() => parseLaunchArgs(args), 'argument-invalid');
    }
  });

  test('passes bootstrap bytes only through a private descriptor into ephemeral worker state', () => {
    const resolved = resolveLaunchRequest(policy, parseLaunchArgs(argv), facts());
    assert.equal(resolved.bootstrap.path, bootstrapPath);
    assert.equal(resolved.bootstrap.mode, 0o600);
    const { args } = buildSandboxCommand(policy, resolved);
    const target = '/home/worker/.multi-agent/mailbox/bootstrap.json';
    const i = args.indexOf(target);
    assert.deepEqual(args.slice(i - 4, i + 1), ['--perms', '0400', '--ro-bind-data', String(MOUNT_FD.bootstrap), target]);
    assert.ok(args.includes('/home/worker/.multi-agent/mailbox'));
    assert.ok(!JSON.stringify(resolved).includes('bootstrap-fixture-secret'));
    assert.ok(!args.join(' ').includes('bootstrap-fixture-secret'));
    assert.ok(!args.includes(bootstrapPath));
  });

  test('rejects missing, exposed, replaced or unbound bootstrap material before launch', () => {
    const good = facts();
    for (const change of [
      { lstat: p => { if (p === bootstrapPath) throw new Error('ENOENT'); return good.lstat(p); } },
      ...[{ uid: 991 }, { gid: 991 }, { mode: 0o644 }, { size: 8193 }, { isFile: () => false }, { isSymbolicLink: () => true }]
        .map(change => ({ lstat: p => p === bootstrapPath ? { ...good.lstat(p), ...change } : good.lstat(p) })),
      { realpath: p => p === bootstrapPath ? bootstrapPath + '-other' : p },
      { readFile: () => '{' },
      ...[{ runId: 'other-run' }, { attemptId: 'other-attempt' }, { generation: '' }, { authorization: '' },
        { capability: 'foreign' }, { readiness: 'ready' }].map(change => ({ readFile: () => JSON.stringify({ ...bootstrap, ...change }) })),
    ]) expectLaunchError(() => resolveLaunchRequest(policy, parseLaunchArgs(argv), { ...good, ...change }), 'mailbox-bootstrap-unavailable');
  });


  test('copies private bootstrap data without leaking its descriptor or making consumer state read-only', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 't010-bootstrap-'));
    const source = path.join(root, 'bootstrap.json');
    let fd;
    try {
      const raw = JSON.stringify(bootstrap);
      writeFileSync(source, raw, { mode: 0o600 });
      const st = lstatSync(source);
      const expected = { path: source, kind: 'file', uid: st.uid, gid: st.gid, dev: st.dev, ino: st.ino, mode: 0o600,
        contentHash: createHash('sha256').update(raw).digest('hex') };
      const target = '/home/worker/.multi-agent/mailbox';
      const script = [
        'const fs = require("node:fs"), root = "/home/worker/.multi-agent/mailbox";',
        'const value = JSON.parse(fs.readFileSync(root + "/bootstrap.json", "utf8"));',
        'const st = fs.statSync(root + "/bootstrap.json"); fs.writeFileSync(root + "/handouts.json", "{}");',
        'const descriptorClosed = fs.readdirSync("/proc/self/fd").every(fd => { try { return !fs.readlinkSync("/proc/self/fd/" + fd).includes("/t010-bootstrap-"); } catch { return true; } });',
        'let writeDenied = false; try { fs.writeFileSync(root + "/bootstrap.json", "{}"); } catch { writeDenied = true; }',
        'process.stdout.write(JSON.stringify({ runId: value.runId, hasAuthorization: !!value.authorization,',
        'mode: st.mode & 511, privateRoot: (fs.statSync(root).mode & 511) === 448, ownerMatches: st.uid === process.getuid(),',
        'stateWritable: fs.readFileSync(root + "/handouts.json", "utf8") === "{}", writeDenied, descriptorClosed }));',
      ].join('\n');
      return import('../config/isolation/worker-launch.mjs').then(({ openVerifiedSource }) => {
        fd = openVerifiedSource(expected);
        const result = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
          '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
          '--ro-bind', policy.paths.toolchain_dir, policy.paths.toolchain_dir, '--proc', '/proc', '--dev', '/dev',
          '--dir', '/home/worker/.multi-agent', '--perms', '0700', '--tmpfs', target,
          '--perms', '0400', '--ro-bind-data', '3', target + '/bootstrap.json', '--', NODE, '-e', script],
        { env: {}, stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 3_000 });
        assert.equal(result.status, 0, result.stderr?.toString());
        assert.deepEqual(JSON.parse(result.stdout.toString()), { runId: 'run-1', hasAuthorization: true,
          mode: 0o400, privateRoot: true, ownerMatches: true, stateWritable: true, writeDenied: true, descriptorClosed: true });
        assert.ok(!result.stdout.toString().includes('bootstrap-fixture-secret'));
        writeFileSync(source, raw.replace('run-1', 'run-2'));
        expectLaunchError(() => openVerifiedSource(expected), 'mount-source-changed');
      }).finally(() => { if (fd !== undefined) closeSync(fd); rmSync(root, { recursive: true, force: true }); });
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      rmSync(root, { recursive: true, force: true }); throw error;
    }
  });

  test('pins real file and socket descriptors and keeps both fixed parent directories read-only', { timeout: 5_000 }, async () => {
    const { openVerifiedSource } = await import('../config/isolation/worker-launch.mjs');
    const root = mkdtempSync(path.join(os.tmpdir(), 't010-descriptor-'));
    const socketPath = path.join(root, 'mailbox.sock'), policyFile = path.join(root, 'managed-settings.json');
    const server = net.createServer(connection => connection.end('mailbox-fixture'));
    const fds = [];
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      chmodSync(socketPath, 0o666); writeFileSync(policyFile, '{"allowManagedHooksOnly":true}'); chmodSync(policyFile, 0o440);
      const expected = (p, kind) => {
        const st = lstatSync(p);
        return { path: p, kind, dev: st.dev, ino: st.ino, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
      };
      const socketIdentity = expected(socketPath, 'socket'), fileIdentity = expected(policyFile, 'file');
      fds.push(openVerifiedSource(socketIdentity), openVerifiedSource(fileIdentity));
      const script = [
        'const fs = require("node:fs"), net = require("node:net");',
        'const denied = p => { try { fs.mkdirSync(p); return false; } catch (e) { return e.code === "EROFS"; } };',
        'const result = { socket: fs.statSync("/run/multi-agent/mailbox.sock").isSocket(),',
        'policy: JSON.parse(fs.readFileSync("/etc/claude-code/managed-settings.json", "utf8")),',
        'socketParentLocked: denied("/run/multi-agent/replacement"), policyParentLocked: denied("/etc/claude-code/managed-settings.d") };',
        'const connection = net.createConnection("/run/multi-agent/mailbox.sock"); let reply = "";',
        'connection.on("data", chunk => { reply += chunk; });',
        'connection.on("end", () => process.stdout.write(JSON.stringify({ ...result, reply })));',
      ].join('\n');
      const args = ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
        '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
        '--ro-bind', policy.paths.toolchain_dir, policy.paths.toolchain_dir, '--proc', '/proc', '--dev', '/dev',
        '--dir', '/run', '--tmpfs', '/run/multi-agent', '--ro-bind-fd', '3', '/run/multi-agent/mailbox.sock', '--remount-ro', '/run/multi-agent',
        '--tmpfs', '/etc/claude-code', '--ro-bind-fd', '4', '/etc/claude-code/managed-settings.json', '--remount-ro', '/etc/claude-code',
        '--', NODE, '-e', script];
      const result = await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/bwrap', args, { env: {}, stdio: ['ignore', 'pipe', 'pipe', ...fds] });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('descriptor probe timed out')); }, 3_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { socket: true, policy: { allowManagedHooksOnly: true },
        socketParentLocked: true, policyParentLocked: true, reply: 'mailbox-fixture' });
      chmodSync(policyFile, 0o640);
      expectLaunchError(() => openVerifiedSource(fileIdentity), 'mount-source-changed');
      chmodSync(policyFile, 0o440);
      renameSync(policyFile, policyFile + '.old'); writeFileSync(policyFile, '{}'); chmodSync(policyFile, 0o440);
      expectLaunchError(() => openVerifiedSource(fileIdentity), 'mount-source-changed');
      symlinkSync(socketPath, socketPath + '.link');
      expectLaunchError(() => openVerifiedSource({ ...socketIdentity, path: socketPath + '.link' }), 'mount-source-changed');
    } finally {
      fds.forEach(fd => closeSync(fd));
      await new Promise(resolve => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });

});


describe('offline: supervisor control', { skip: process.platform !== 'linux' }, () => {
  // The supervisor reports the namespace before its init forks the entry shell, so a
  // test that snapshots immediately can see an empty level 0 and fail closed.
  const childPids = pid => {
    try {
      const pids = new Set();
      for (const task of readdirSync('/proc/' + pid + '/task')) {
        try {
          for (const value of readFileSync('/proc/' + pid + '/task/' + task + '/children', 'utf8').trim().split(' ')) {
            if (/^[1-9]\d*$/.test(value)) pids.add(Number(value));
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return [...pids];
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return []; throw error; }
  };
  // Observed through /proc rather than a control handle, so a half-started namespace is retried, not failed.
  // A zombie throws ENOENT on /proc/<pid>/exe, which the caller treats as "not ready yet".
  const liveExe = pid => readlinkSync('/proc/' + pid + '/exe');
  // walk is the executable snapshot() will expect at each level, the entry shell first.
  const chainReady = (supervisorPid, walk) => {
    // supervisor -> the bwrap wrapper -> the namespace init; the walk starts at the init's child.
    const wrapper = childPids(supervisorPid), init = wrapper.length === 1 ? childPids(wrapper[0]) : [];
    let level = init.length === 1 ? childPids(init[0]) : [];
    for (const executable of walk) {
      if (level.length !== 1 || liveExe(level[0]) !== executable) return false;
      level = childPids(level[0]);
    }
    return true;
  };
  const waitForNative = async (child, walk) => {
    const deadline = Date.now() + 5_000;
    while (child.exitCode === null && child.signalCode === null) {
      try { if (chainReady(child.pid, walk)) return; }
      // Only a vanished process means "not ready yet"; any other error is a real fixture defect.
      catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      if (Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('sandbox native did not start within 5 s' + (child.exitCode === null ? '' : ` (supervisor exited ${child.exitCode})`));
  };
  async function fixture(t, { capture = true, holdSupervisor = false, argvBytes, contextRoot, sessionRoot, sessionOpen = '>>', sessionWrite = '',
    script = 'sleep 30 & setsid sleep 30 & wait', mounts = [], readyChain = [SHELL] } = {}) {
    assert.equal(typeof workerLaunch.openSandboxControl, 'function');
    const command = { file: '/usr/bin/bwrap', args: ['--unshare-user', '--unshare-pid', '--die-with-parent',
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
      '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
      '--info-fd', String(workerLaunch.SANDBOX_STATUS_FD), ...(contextRoot ? ['--ro-bind', contextRoot, '/context'] : []),
      ...(sessionRoot ? ['--bind', sessionRoot, '/home/worker/.codex/sessions'] : []), ...mounts,
      '--', '/bin/sh', '-c', (sessionRoot ? `exec 8${sessionOpen} /home/worker/.codex/sessions/${ROLLOUT}; ${sessionWrite}printf native-ready; ` : '')
        + script] };
    const source = `
      import { startSandbox, SANDBOX_STATUS_FD } from ${JSON.stringify(new URL('../config/isolation/worker-launch.mjs', import.meta.url).href)};
      const stdio = Array(SANDBOX_STATUS_FD + 1).fill('ignore');
      ${sessionRoot ? "stdio[1] = 'pipe';" : ''}
      const lifecycle = startSandbox(${JSON.stringify(command)}, stdio, process.getuid());
      ${sessionRoot ? "const nativeReady = new Promise(resolve => lifecycle.child.stdout.once('data', resolve));" : ''}
      lifecycle.child.once('exit', () => { ${holdSupervisor ? '' : 'process.exit(0);'} });
      ${holdSupervisor ? 'setInterval(() => {}, 1000);' : ''}
      process.once('SIGTERM', () => lifecycle.quiesce().finally(() => process.exit(0)));
      await lifecycle.observe();
      ${sessionRoot ? 'await nativeReady;' : ''}
      ${capture ? '' : 'lifecycle.close();'}
      process.stdout.write('captured\\n');
    `;
    const args = ['--input-type=module', '-e', source];
    if (argvBytes !== undefined) {
      args.push(fileURLToPath(import.meta.url));
      args.push('x'.repeat(argvBytes - Buffer.byteLength([process.execPath, ...args].join('\0') + '\0') - 1));
    }
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = new Promise(resolve => child.once('exit', resolve));
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      child.kill('SIGTERM'); await exit; clearTimeout(timer);
    });
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve); child.once('error', reject);
      child.once('exit', () => reject(new Error('Supervisor fixture exited before capture')));
    });
    const selector = { processId: child.pid, processStart: startOf(child.pid) }, argv = [process.execPath, ...args];
    // A retained-descriptor supervisor is the only one a later snapshot can descend.
    if (capture) await waitForNative(child, readyChain);
    return { child, selector, argv };
  }
  const startOf = pid => { const raw = readFileSync('/proc/' + pid + '/stat', 'utf8'); return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19]; };
  // The test process stands in for the terminal pane that runs each supervisor.
  const pane = () => ({ processId: process.pid, processStart: startOf(process.pid) });
  const SESSION = '01a154fe-b417-7933-b7a4-a8c840f721e9', ROLLOUT = `2026/10/20/rollout-2026-10-20T00-29-00-${SESSION}.jsonl`;
  const SHELL = realpathSync('/bin/sh');
  const query = (change = {}) => ({ pane: pane(), files: [], discoveryRoots: [], ...change });
  const meta = id => JSON.stringify({ type: 'session_meta', payload: { id } });
  const sessionFixture = (t, existing = true) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sandbox-rollout-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, '2026/10/20'), { recursive: true });
    const write = (file, id) => writeFileSync(path.join(root, file), meta(id) + '\n');
    if (existing) write(ROLLOUT, SESSION);
    return { root, write };
  };

  test('observes a separately supervised real namespace through retained descriptors', { timeout: 6_000 }, async t => {
    const { selector, argv } = await fixture(t);
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
    t.after(() => control.close());
    const observation = control.observe();
    assert.equal(observation.schema, 'multi-agent-sandbox-control/v1');
    assert.deepEqual(observation.supervisor, selector);
    assert.equal(observation.commandDigest, 'sha256:' + createHash('sha256').update(JSON.stringify(argv)).digest('hex'));
    assert.equal(observation.uid, process.getuid());
    assert.notEqual(observation.pidNamespace, readlinkSync('/proc/self/ns/pid'));
    assert.equal(Object.isFrozen(observation.supervisor), true);
    assert.deepEqual(control.observe(), observation);
    control.close(); control.close();
    assert.throws(() => control.observe(), { code: 'sandbox-control-unverified' });
  });

  test('snapshot reads kernel facts and bounded context bytes from the pinned namespace', { timeout: 6_000 }, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sandbox-snapshot-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, 'instructions'), 'immutable context bytes', { mode: 0o440 });
    const { selector, argv } = await fixture(t, { contextRoot: root });
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
    t.after(() => control.close());
    const observed = control.observe();
    const result = control.snapshot(query({ files: ['/context/instructions'], discoveryRoots: ['/context'] }), [SHELL]);
    // The native is the sandbox init's namespace-PID-2 child, found from kernel links rather than a caller selector.
    const nativePid = Number(readFileSync('/proc/' + observed.sandboxPid + '/task/' + observed.sandboxPid + '/children', 'utf8').trim().split(' ')[0]);
    assert.deepEqual(result.lineage, [{ processId: nativePid, processStart: startOf(nativePid), executable: SHELL }]);
    assert.deepEqual(result.pane, pane());
    assert.equal(result.process.processId, nativePid);
    assert.equal(result.process.processStart, startOf(nativePid));
    assert.equal(result.process.executable, SHELL);
    assert.deepEqual(result.sandbox, { mountNamespace: result.process.mountNamespace,
      userNamespace: result.process.userNamespace, networkNamespace: result.process.networkNamespace });
    assert.deepEqual(result.process.uids, [process.getuid(), process.getuid(), process.getuid(), process.getuid()]);
    assert.equal(result.process.pidNamespace, observed.pidNamespace);
    assert.notEqual(result.process.mountNamespace, readlinkSync('/proc/self/ns/mnt'));
    assert.notEqual(result.process.userNamespace, readlinkSync('/proc/self/ns/user'));
    assert.ok(Array.isArray(result.process.argv) && result.process.argv.length > 0);
    assert.ok(result.mountInfo.includes(' /context '));
    assert.deepEqual(result.files, [{ path: '/context/instructions',
      hash: 'sha256:' + createHash('sha256').update('immutable context bytes').digest('hex') }]);
    assert.deepEqual(result.discoveryRoots, ['/context']);
    assert.deepEqual(result.stdio.map(row => row.fd), [0, 1, 2]);
    assert.equal(JSON.stringify(result).includes('authorization'), false);
  });

  test('authority opening ignores a descriptor that vanished after enumeration', { timeout: 6_000 }, async t => {
    const { selector, argv } = await fixture(t);
    const original = fs.readdirSync;
    let injected = false;
    fs.readdirSync = (file, ...args) => {
      const result = original(file, ...args);
      if (String(file).startsWith('/proc/self/fd/') && String(file).endsWith('/fd') && !injected) {
        injected = true; return [...result, '2147483647'];
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
      t.after(() => control.close());
      assert.equal(injected, true);
      assert.equal(control.observe().supervisor.processId, selector.processId);
    } finally { fs.readdirSync = original; syncBuiltinESMExports(); }
  });

  test('snapshot releases descriptors after successful and rejected queries', { timeout: 6_000 }, async t => {
    const { selector, argv } = await fixture(t);
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
    t.after(() => control.close());
    const observed = control.observe(), before = readdirSync('/proc/self/fd').length;
    for (let index = 0; index < 20; index++) {
      control.snapshot(query(), [SHELL]);
      assert.throws(() => control.snapshot(query({ pane: { ...pane(), processStart: String(BigInt(pane().processStart) + 1n) } }), [SHELL]),
        { code: 'sandbox-control-unverified' });
    }
    assert.equal(readdirSync('/proc/self/fd').length, before);
    assert.deepEqual(control.observe(), observed);
  });

  test('names a Codex session only from a rollout the native writes under its own UUID', { timeout: 6_000 }, async t => {
    const { root } = sessionFixture(t);
    const { selector, argv } = await fixture(t, { sessionRoot: root });
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
    t.after(() => control.close());
    // The file predates this native process, so it cannot prove a fresh session.
    const file = statSync(path.join(root, ROLLOUT));
    assert.deepEqual(control.snapshot(query(), [SHELL]).nativeSessions, [{ id: SESSION, createdAfterStart: false,
      rollout: { device: file.dev, inode: file.ino } }]);
    const original = fs.openSync;
    let replaced = false;
    fs.openSync = (file, ...args) => {
      if (String(file).endsWith('/fd/8')) { replaced = true; return original(path.join(root, '2026/10/20'), ...args); }
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => control.snapshot(query(), [SHELL]), { code: 'sandbox-control-unverified' });
      assert.equal(replaced, true);
    } finally { fs.openSync = original; syncBuiltinESMExports(); }
  });

  test('descends a multi-level chain through the unique child at each level', { timeout: 6_000 }, async t => {
    // Like the Codex entry script, the shell waits on exactly one child that runs another image.
    const { selector, argv } = await fixture(t, { script: 'sleep 30; true', readyChain: [SHELL, realpathSync('/usr/bin/sleep')] });
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
    t.after(() => control.close());
    const observed = control.observe(), sleep = realpathSync('/usr/bin/sleep');
    const shellPid = Number(readFileSync('/proc/' + observed.sandboxPid + '/task/' + observed.sandboxPid + '/children', 'utf8').trim());
    const sleepPid = Number(readFileSync('/proc/' + shellPid + '/task/' + shellPid + '/children', 'utf8').trim());
    const result = control.snapshot(query(), [SHELL, sleep]);
    assert.deepEqual(result.lineage, [{ processId: shellPid, processStart: startOf(shellPid), executable: SHELL },
      { processId: sleepPid, processStart: startOf(sleepPid), executable: sleep }]);
    assert.equal(result.process.processId, sleepPid);
    assert.throws(() => control.snapshot(query(), [SHELL, SHELL]), { code: 'sandbox-control-unverified' });
  });

  test('observes the mailbox socket and native policy sources inside the pinned namespace', { timeout: 6_000 }, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sandbox-policy-')), sock = path.join(root, 'mailbox.sock');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, 'managed-settings.json'), '{"allowManagedHooksOnly":true}');
    writeFileSync(path.join(root, 'requirements.toml'), 'allow_managed_hooks_only = true\n[hooks]\nmanaged_dir = "/context/native/codex/hooks"\n');
    mkdirSync(path.join(root, 'home/.claude'), { recursive: true });
    const server = net.createServer();
    await new Promise(resolve => server.listen(sock, resolve));
    t.after(() => server.close());
    const { selector, argv } = await fixture(t, { mounts: ['--tmpfs', '/run', '--ro-bind', sock, '/run/multi-agent/mailbox.sock',
      '--tmpfs', '/etc/claude-code', '--ro-bind', path.join(root, 'managed-settings.json'), '/etc/claude-code/managed-settings.json',
      '--tmpfs', '/etc/codex', '--ro-bind', path.join(root, 'requirements.toml'), '/etc/codex/requirements.toml',
      '--bind', path.join(root, 'home'), '/home/worker'] });
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
    t.after(() => control.close());
    const managed = (client, change = {}) => ({ client, mailbox: '/run/multi-agent/mailbox.sock',
      remotePolicy: client === 'claude-code' ? '/home/worker/.claude/remote-settings.json' : null, ...change });
    const socket = lstatSync(sock), claude = control.snapshot(query(), [SHELL], managed('claude-code'));
    assert.deepEqual(claude.mailbox, { uid: socket.uid, gid: socket.gid, dev: socket.dev, ino: socket.ino });
    assert.deepEqual(claude.nativePolicy.inventory, { selectedSource: '/etc/claude-code/managed-settings.json', managedDropIns: 'absent',
      remotePolicy: 'absent', platformPolicy: 'not-applicable', nativeExceptions: 'absent' });
    assert.deepEqual(control.snapshot(query(), [SHELL], managed('codex')).nativePolicy.inventory, { selectedSource: '/etc/codex/requirements.toml',
      managedDropIns: 'absent', remotePolicy: 'unknown', platformPolicy: 'not-applicable', nativeExceptions: 'absent' });
    // A later organization-policy cache is seen by the next observation of the same native.
    writeFileSync(path.join(root, 'home/.claude/remote-settings.json'), '{}');
    assert.equal(control.snapshot(query(), [SHELL], managed('claude-code')).nativePolicy.inventory.remotePolicy, 'present');
    assert.equal(Object.hasOwn(control.snapshot(query(), [SHELL]), 'nativePolicy'), false);
    for (const change of [{ mailbox: '/run/multi-agent/absent.sock' }, { mailbox: '/etc/claude-code/managed-settings.json' }, { client: 'unknown' }]) {
      assert.throws(() => control.snapshot(query(), [SHELL], managed('claude-code', change)), { code: 'sandbox-control-unverified' });
    }
  });

  test('classifies native drop-ins and exception keys from the selected source bytes', () => {
    const inventory = (client, bytes, entries = [path.posix.basename(client === 'codex' ? '/etc/codex/requirements.toml'
      : '/etc/claude-code/managed-settings.json')]) => workerLaunch.nativePolicyInventory(client, bytes, entries, 'absent');
    const settings = '{"allowManagedHooksOnly":true,"disableAllHooks":false}', requirements = 'allow_managed_hooks_only = true\n'
      + '# comment\n[features]\nhooks = true\n[hooks]\nmanaged_dir = "/context/native/codex/hooks"\n';
    assert.equal(inventory('claude-code', settings).nativeExceptions, 'absent');
    assert.equal(inventory('codex', requirements).nativeExceptions, 'absent');
    assert.equal(inventory('claude-code', settings, ['managed-settings.json', 'managed-settings.d']).managedDropIns, 'present');
    assert.equal(inventory('codex', requirements, ['requirements.toml', 'managed_config.toml']).managedDropIns, 'present');
    for (const bytes of ['{"enabledPlugins":{}}', '{"allowedHttpHookUrls":[]}', '{"disableAllHooks":true}']) {
      assert.equal(inventory('claude-code', bytes).nativeExceptions, 'present');
    }
    for (const bytes of [requirements + '[hooks.trust]\nx = 1\n', requirements + 'state = "trusted"\n', 'hooks.state = {}\n' + requirements,
      requirements + '[[hooks.PostToolUse]]\n', 'hooks = { state = "trusted" }\n' + requirements, requirements + '[ "hooks" ]\nstate = 1\n'])
      assert.equal(inventory('codex', bytes).nativeExceptions, 'present');
    assert.equal(inventory('claude-code', '[1]').nativeExceptions, 'unknown');
    assert.equal(inventory('claude-code', '{').nativeExceptions, 'unknown');
  });

  test('marks a rollout the native created after its own start as fresh evidence', { timeout: 6_000 }, async t => {
    const { root } = sessionFixture(t, false);
    const { selector, argv } = await fixture(t, { sessionRoot: root, sessionWrite: `printf '%s\\n' '${meta(SESSION)}' >&8; ` });
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
    t.after(() => control.close());
    const [session] = control.snapshot(query(), [SHELL]).nativeSessions, file = statSync(path.join(root, ROLLOUT));
    assert.deepEqual(session, { id: SESSION, createdAfterStart: true, rollout: { device: file.dev, inode: file.ino } });
  });

  for (const field of ['read-only', 'foreign-id']) {
    test('ignores a ' + field + ' rollout descriptor as session evidence', { timeout: 6_000 }, async t => {
      const { root, write } = sessionFixture(t);
      if (field === 'foreign-id') write(ROLLOUT, 'f'.repeat(8) + SESSION.slice(8));
      const { selector, argv } = await fixture(t, { sessionRoot: root, sessionOpen: field === 'read-only' ? '<' : '>>' });
      const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
      t.after(() => control.close());
      assert.deepEqual(control.snapshot(query(), [SHELL]).nativeSessions, []);
    });
  }

  // Both children stay shells for the life of the fixture, so a second level is never unique. A plain
  // background job would briefly fork before its exec, so each child waits in its own nested shell.
  const depthScript = '/bin/sh -c "sleep 30; true" & /bin/sh -c "sleep 30; true" & wait';
  for (const field of ['foreign-pane', 'stale-pane', 'executable', 'depth', 'empty-chain', 'foreign-file', 'root-escape', 'duplicate-file', 'unknown-key']) {
    test('snapshot rejects ' + field + ' without reading outside its namespace scope', { timeout: 6_000 }, async t => {
      const { selector, argv } = await fixture(t, field === 'depth' ? { script: depthScript } : {});
      const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
      t.after(() => control.close());
      const observed = control.observe(), request = query();
      let chain = [SHELL];
      if (field === 'foreign-pane') request.pane = { processId: process.ppid, processStart: startOf(process.ppid) };
      else if (field === 'stale-pane') request.pane.processStart = String(BigInt(request.pane.processStart) + 1n);
      else if (field === 'executable') chain = [process.execPath];
      // This shell always holds two live shells below it, so no unique next level exists at any instant.
      else if (field === 'depth') chain = [SHELL, SHELL];
      else if (field === 'empty-chain') chain = [];
      else if (field === 'foreign-file') request.files = ['/etc/shadow'];
      else if (field === 'root-escape') request.files = ['/context/../etc/shadow'];
      else if (field === 'duplicate-file') request.files = ['/context/file', '/context/file'];
      else request.native = { processId: observed.sandboxPid, processStart: observed.processStart };
      assert.throws(() => control.snapshot(request, chain), { code: 'sandbox-control-unverified' });
      assert.equal(process.kill(process.pid, 0), true);
      assert.deepEqual(control.observe(), observed);
    });
  }

  for (const argvBytes of [65_536, 65_537]) {
    test(`observes and stops an admitted supervisor with ${argvBytes} argv bytes`, { timeout: 6_000 }, async t => {
      const { child, selector, argv } = await fixture(t, { argvBytes });
      assert.equal(Buffer.byteLength(argv.join('\0') + '\0'), argvBytes);
      const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
      t.after(() => control.close());
      const observed = control.observe(), exited = new Promise(resolve => child.once('exit', resolve));
      assert.equal(observed.commandDigest, 'sha256:' + createHash('sha256').update(JSON.stringify(argv)).digest('hex'));
      assert.deepEqual(await control.quiesce(), { status: 'terminated', observation: observed });
      await exited;
      assert.equal(existsSync('/proc/' + observed.sandboxPid + '/stat'), false);
    });
  }

  for (const field of ['command', 'process-start', 'worker', 'selector']) {
    test('rejects a mismatched ' + field + ' without signaling the supervisor', { timeout: 6_000 }, async t => {
      const { child, selector, argv } = await fixture(t);
      const changed = field === 'process-start' ? { ...selector, processStart: String(BigInt(selector.processStart) + 1n) }
        : field === 'selector' ? { ...selector, processId: -1 } : selector;
      assert.throws(() => workerLaunch.openSandboxControl(changed, field === 'command' ? [...argv, 'other-command'] : argv,
        process.getuid() + (field === 'worker' ? 1 : 0)), { code: 'sandbox-control-unverified' });
      assert.equal(process.kill(child.pid, 0), true);
    });
  }

  test('rejects a supervisor without retained namespace authority', { timeout: 6_000 }, async t => {
    const { child, selector, argv } = await fixture(t, { capture: false });
    assert.throws(() => workerLaunch.openSandboxControl(selector, argv, process.getuid()), { code: 'sandbox-control-unverified' });
    assert.equal(process.kill(child.pid, 0), true);
  });


  test('confirms external stop only after the namespace and supervisor stop, preserving unrelated work', { timeout: 6_000 }, async t => {
    const { child, selector, argv } = await fixture(t);
    const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    t.after(() => unrelated.kill('SIGKILL'));
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid()), observed = control.observe();
    t.after(() => control.close());
    const exited = new Promise(resolve => child.once('exit', resolve));
    const pending = control.quiesce();
    assert.equal(control.quiesce(), pending);
    assert.deepEqual(await pending, { status: 'terminated', observation: observed });
    await exited;
    assert.equal(existsSync('/proc/' + observed.sandboxPid + '/stat'), false);
    assert.equal(process.kill(unrelated.pid, 0), true);
    assert.throws(() => control.observe(), { code: 'sandbox-control-unverified' });
  });

  test('never confirms external stop when the namespace helper fails while work is live', { timeout: 6_000 }, async t => {
    const { child, selector, argv } = await fixture(t);
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid()), observed = control.observe();
    t.after(() => control.close());
    const realSpawn = spawn;
    const mocked = t.mock.method(childProcess, 'spawn', (file, args, options) => file === '/usr/bin/nsenter'
      ? realSpawn(process.execPath, ['-e', 'process.exit(1)'], options) : realSpawn(file, args, options));
    syncBuiltinESMExports();
    try {
      await assert.rejects(control.quiesce(), { code: 'sandbox-quiescence-unconfirmed' });
      assert.equal(process.kill(child.pid, 0), true);
      assert.equal(process.kill(observed.sandboxPid, 0), true);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  });

  // quiesce() itself spends a fixed 10 s before it can reject, and the fixture may add 5 s of startup.
  test('does not report stopped while the outer supervisor remains live', { timeout: 20_000 }, async t => {
    const { child, selector, argv } = await fixture(t, { holdSupervisor: true });
    const control = workerLaunch.openSandboxControl(selector, argv, process.getuid());
    t.after(() => control.close());
    await assert.rejects(control.quiesce(), { code: 'sandbox-quiescence-unconfirmed' });
    assert.equal(process.kill(child.pid, 0), true);
  });

  test('authenticates the control caller before consulting process descriptors', async () => {
    assert.equal(typeof workerLaunch.controlSandbox, 'function');
    await assert.rejects(workerLaunch.controlSandbox(policy, ['--observe', 'invalid'],
      fakeFacts({ callerUid: 1000 })), { code: 'caller-not-allowed' });
  });
});

describe('offline: sandbox lifecycle', { skip: process.platform !== 'linux' }, () => {
  function fixture(t, { fakeInfo, uid = process.getuid() } = {}) {
    assert.equal(typeof workerLaunch.startSandbox, 'function');
    const fd = workerLaunch.SANDBOX_STATUS_FD;
    const command = fakeInfo === undefined ? {
      file: '/usr/bin/bwrap', args: ['--unshare-user', '--unshare-pid', '--die-with-parent',
        '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--info-fd', String(fd), '--',
        '/bin/sh', '-c', 'sleep 10 & setsid sleep 10 & wait'],
    } : { file: process.execPath, args: ['-e',
      `require('node:fs').writeSync(${fd}, ${JSON.stringify(fakeInfo)}); require('node:fs').closeSync(${fd}); setTimeout(() => {}, 10000)`] };
    const stdio = Array(fd + 1).fill('ignore'); stdio[fd] = 'pipe';
    const lifecycle = workerLaunch.startSandbox(command, stdio, uid);
    t.after(() => { lifecycle.child.kill('SIGKILL'); lifecycle.close(); });
    return { lifecycle, command };
  }

  test('observes the owned namespace init from a private descriptor and kernel facts', { timeout: 5_000 }, async t => {
    const { lifecycle, command } = fixture(t);
    const original = JSON.stringify(command); command.args.push('changed-after-start');
    const observed = await lifecycle.observe();
    assert.equal(observed.commandDigest, 'sha256:' + createHash('sha256').update(original).digest('hex'));
    assert.equal(observed.parentProcessId, lifecycle.child.pid);
    assert.equal(observed.uid, process.getuid());
    assert.notEqual(observed.pidNamespace, readlinkSync('/proc/self/ns/pid'));
    assert.equal(Object.isFrozen(observed), true);
    const result = await lifecycle.quiesce();
    assert.equal(result.status, 'terminated'); assert.deepEqual(result.observation, observed);
  });

  test('quiesces detached descendants without targeting an unrelated process', { timeout: 5_000 }, async t => {
    const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    t.after(() => unrelated.kill('SIGKILL'));
    const { lifecycle } = fixture(t), observed = await lifecycle.observe();
    const first = lifecycle.quiesce();
    assert.equal(lifecycle.quiesce(), first);
    await first;
    assert.equal(existsSync(`/proc/${observed.sandboxPid}/stat`), false);
    assert.equal(process.kill(unrelated.pid, 0), true);
    await assert.rejects(lifecycle.observe(), { code: 'sandbox-observation-unverified' });
  });

  test('reconciles namespace exit between the liveness check and helper startup', { timeout: 5_000 }, async t => {
    const { lifecycle } = fixture(t), observed = await lifecycle.observe();
    const realSpawn = spawn;
    let helperExitCode, helperCalls = 0;
    const mockedSpawn = t.mock.method(childProcess, 'spawn', (file, args, options) => {
      if (file !== '/usr/bin/nsenter') return realSpawn(file, args, options);
      helperCalls++;
      process.kill(observed.sandboxPid, 'SIGKILL');
      // Hold helper creation until the real namespace init has been reaped.
      const deadline = Date.now() + 2_000, pause = new Int32Array(new SharedArrayBuffer(4));
      while (existsSync(`/proc/${observed.sandboxPid}/stat`)) {
        assert.ok(Date.now() < deadline, 'sandbox init was not reaped');
        Atomics.wait(pause, 0, 0, 1);
      }
      const helper = realSpawn(file, args, options);
      helper.once('exit', code => { helperExitCode = code; });
      return helper;
    });
    syncBuiltinESMExports();
    try {
      const result = await lifecycle.quiesce();
      assert.equal(result.status, 'terminated');
      assert.deepEqual(result.observation, observed);
      assert.equal(helperCalls, 1);
      assert.equal(helperExitCode, 1);
      assert.equal(existsSync(`/proc/${observed.sandboxPid}/stat`), false);
      assert.equal(existsSync(`/proc/${lifecycle.child.pid}/stat`), false);
    } finally {
      mockedSpawn.mock.restore();
      syncBuiltinESMExports();
    }
  });

  test('rejects helper failure while the owned namespace is still running', { timeout: 5_000 }, async t => {
    const { lifecycle } = fixture(t), observed = await lifecycle.observe();
    const realSpawn = spawn;
    let helperCalls = 0;
    const mockedSpawn = t.mock.method(childProcess, 'spawn', (file, args, options) => {
      if (file !== '/usr/bin/nsenter') return realSpawn(file, args, options);
      helperCalls++;
      return realSpawn(process.execPath, ['-e', 'process.exit(1)'], options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(lifecycle.quiesce(), { code: 'sandbox-quiescence-unconfirmed' });
      assert.equal(helperCalls, 1);
      assert.equal(process.kill(observed.sandboxPid, 0), true);
    } finally {
      mockedSpawn.mock.restore();
      syncBuiltinESMExports();
    }
  });

  for (const [name, fakeInfo] of [['host process', JSON.stringify({ 'child-pid': process.pid })],
    ['malformed status', '{'], ['oversized status', 'x'.repeat(4097)]]) {
    test(`rejects ${name} without treating it as a shutdown target`, { timeout: 5_000 }, async t => {
      const { lifecycle } = fixture(t, { fakeInfo });
      await assert.rejects(lifecycle.observe(), { code: 'sandbox-observation-unverified' });
      await assert.rejects(lifecycle.quiesce(), { code: 'sandbox-quiescence-unconfirmed' });
      assert.equal(process.kill(process.pid, 0), true);
    });
  }

  test('rejects a namespace owned by a different worker', { timeout: 5_000 }, async t => {
    const { lifecycle } = fixture(t, { uid: process.getuid() + 1 });
    await assert.rejects(lifecycle.observe(), { code: 'sandbox-observation-unverified' });
    await assert.rejects(lifecycle.quiesce(), { code: 'sandbox-quiescence-unconfirmed' });
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
    assert.deepEqual(triple(impl.args, '/context'), ['--ro-bind-fd', String(MOUNT_FD.context), '/context']);
    assert.deepEqual(triple(impl.args, '/framework'), ['--ro-bind-fd', String(MOUNT_FD.framework), '/framework']);
    assert.ok(!impl.args.includes(policy.paths.framework_dir), 'the framework source must be pinned by descriptor');
    assert.ok(!impl.args.includes(impl.mountSources.context), 'the context source must be pinned by descriptor');
    assert.ok(!impl.args.includes(TREE), 'the tree path must not reach bwrap');
    assert.deepEqual(impl.mountSources, {
      home: '/var/lib/multi-agent/workers/ma-worker1/home',
      scratch: '/var/lib/multi-agent/workers/ma-worker1/scratch',
      tree: TREE,
      context: policy.paths.context_root + '/ma-worker1/run-1/attempt-1',
      framework: policy.paths.framework_dir,
    });
  });

  test('passes only allow-listed environment and the command after a separator', () => {
    const { args } = buildSandboxCommand(policy, resolvedFor('implementer'));
    const setenv = [];
    for (let i = 0; i < args.length; i += 1) if (args[i] === '--setenv') setenv.push(args[i + 1]);
    const proxyKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy'];
    assert.deepEqual(setenv.sort(), ['HOME', 'PATH', 'TERM', 'TMPDIR', 'USER', 'MA_ATTEMPT_ID', ...proxyKeys].sort());
    const sep = args.lastIndexOf('--');
    assert.deepEqual(args.slice(sep + 1), [NODE, '-e', '1']);
  });

  test('KTD23: the sandbox gets an empty network namespace and reaches out only through the egress socket', () => {
    const { args } = buildSandboxCommand(policy, resolvedFor('implementer'));
    assert.ok(args.includes('--unshare-net'), 'missing --unshare-net');
    assert.ok(!args.includes('--share-net'), 'the host network namespace must not be shared');
    const socketDir = policy.paths.egress_socket_dir;
    const bind = args.findIndex((a, i) => a === '--ro-bind' && args[i + 1] === socketDir && args[i + 2] === socketDir);
    assert.ok(bind > args.indexOf('/run'), 'the socket directory must be bound after the /run tmpfs, read-only');
    const proxy = `http://127.0.0.1:${policy.sandbox.egress_port}`;
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      const i = args.findIndex((a, j) => a === '--setenv' && args[j + 1] === key);
      assert.equal(args[i + 2], proxy, `${key} must point at the in-sandbox relay`);
    }
    // bwrap runs the relay, which runs the requested command.
    const bwrapSep = args.indexOf('--', args.indexOf('--chdir'));
    assert.deepEqual(args.slice(bwrapSep + 1, bwrapSep + 7), [
      `${policy.paths.toolchain_dir}/node/bin/node`, policy.paths.installed_egress, 'relay',
      String(policy.sandbox.egress_port), `${socketDir}/proxy.sock`, '--',
    ]);
  });

  test('KTD23: a caller-supplied variable cannot replace the launcher proxy settings', () => {
    const resolved = resolvedFor('implementer');
    resolved.env.HTTPS_PROXY = 'http://127.0.0.1:18080';
    const { args } = buildSandboxCommand(policy, resolved);
    const values = args.flatMap((a, i) => (a === '--setenv' && args[i + 1] === 'HTTPS_PROXY' ? [args[i + 2]] : []));
    assert.deepEqual(values, [`http://127.0.0.1:${policy.sandbox.egress_port}`]);
  });

  test('carries the gateway bearer in a 0400 sandbox file the relay reads, never on a command line', () => {
    // R2-1: setpriv and bwrap command lines are as readable as the client's, so `--setenv TOKEN` was
    // never a non-argv channel. The value now travels as file content on an inherited descriptor,
    // and only the file's path appears in argv.
    const bearer = 'sk-' + 'b'.repeat(40);
    const gateway = client => ({ client, baseUrl: 'https://gateway.invalid/' + client, bearer, model: 'pinned-model',
      digest: 'sha256:' + 'a'.repeat(64) });
    const claude = buildSandboxCommand(policy, { ...resolvedFor('implementer'), client: 'claude-code', gateway: gateway('claude-code') });
    assert.equal(claude.gatewayData, `ANTHROPIC_AUTH_TOKEN=${bearer}\n`);
    assert.ok(!claude.args.some(arg => arg.includes(bearer)), 'no argv entry may contain the bearer');
    const file = claude.args.indexOf(GATEWAY_ENV_PATH);
    assert.deepEqual(claude.args.slice(file - 6, file + 1),
      ['--dir', path.posix.dirname(GATEWAY_ENV_PATH), '--perms', '0400', '--bind-data', String(GATEWAY_FD), GATEWAY_ENV_PATH]);
    assert.ok(file > claude.args.indexOf('/run'), 'the data file must be bound after the /run tmpfs');
    // A native launch covers /run/multi-agent with its own mailbox tmpfs, so the bearer file must
    // not live under it.
    assert.notEqual(path.posix.dirname(GATEWAY_ENV_PATH), '/run/multi-agent');
    const relay = claude.args.indexOf('relay');
    assert.deepEqual(claude.args.slice(relay - 1, relay + 6), [policy.paths.installed_egress, 'relay',
      String(policy.sandbox.egress_port), `${policy.paths.egress_socket_dir}/proxy.sock`, '--env-file', GATEWAY_ENV_PATH, '--']);
    // The endpoint is configuration, not a credential, so it stays with the other environment.
    const base = claude.args.indexOf('ANTHROPIC_BASE_URL');
    assert.equal(claude.args[base - 1], '--setenv');
    assert.equal(claude.args[base + 1], 'https://gateway.invalid/claude-code');
    // Codex names its key by variable, and the variable is set from the same file.
    const codex = buildSandboxCommand(policy, { ...resolvedFor('implementer'), client: 'codex', gateway: gateway('codex') });
    assert.equal(codex.gatewayData, `MA_GATEWAY_API_KEY=${bearer}\n`);
    assert.ok(!codex.args.some(arg => arg.includes(bearer)));
    for (const arg of codex.args) assert.ok(!arg.includes('ANTHROPIC_'), 'a Codex launch carries no Claude variables');
    // Without a gateway there is no file, no mount and no relay option.
    const plain = buildSandboxCommand(policy, resolvedFor('implementer'));
    assert.equal(plain.gatewayData, null);
    assert.ok(!plain.args.includes(GATEWAY_ENV_PATH) && !plain.args.includes('--env-file'));
    assert.ok(!plain.args.includes('--bind-data'));
  });

  test('KTD23: bwrap loads the seccomp program from the launcher descriptor', () => {
    const { args } = buildSandboxCommand(policy, resolvedFor('implementer'));
    const i = args.indexOf('--seccomp');
    assert.ok(i > args.indexOf('/usr/bin/bwrap') && i < args.indexOf('--chdir'), 'missing --seccomp');
    assert.equal(args[i + 1], String(SECCOMP_FD));
  });

  test('KTD23: the seccomp program refuses AF_VSOCK and io_uring, and allows other sockets and syscalls', () => {
    const prog = buildSeccompFilter();
    // Minimal classic-BPF interpreter over seccomp_data { nr, arch, ip, args[6] }.
    const run = ({ nr, arch = 0xc000003e, family = 0 }) => {
      const data = Buffer.alloc(64);
      data.writeUInt32LE(nr >>> 0, 0);
      data.writeUInt32LE(arch >>> 0, 4);
      data.writeUInt32LE(family >>> 0, 16);
      let acc = 0;
      for (let pc = 0; pc < prog.length / 8;) {
        const code = prog.readUInt16LE(pc * 8); const jt = prog[pc * 8 + 2]; const jf = prog[pc * 8 + 3]; const k = prog.readUInt32LE(pc * 8 + 4);
        if (code === 0x20) { acc = data.readUInt32LE(k); pc += 1; } else if (code === 0x15) pc += 1 + (acc === k ? jt : jf);
        else if (code === 0x35) pc += 1 + (acc >= k ? jt : jf);
        else if (code === 0x06) return k === 0x7fff0000 ? 'allow' : `errno:${k & 0xffff}`;
        else throw new Error(`unexpected opcode ${code}`);
      }
      throw new Error('program fell off the end');
    };
    assert.equal(run({ nr: 41, family: 40 }), 'errno:97', 'socket(AF_VSOCK)');
    assert.equal(run({ nr: 53, family: 40 }), 'errno:97', 'socketpair(AF_VSOCK)');
    for (const nr of [425, 426, 427]) assert.equal(run({ nr }), 'errno:1', `io_uring syscall ${nr}`);
    for (const family of [1, 2, 10, 16]) assert.equal(run({ nr: 41, family }), 'allow', `socket family ${family}`);
    assert.equal(run({ nr: 0 }), 'allow', 'read');
    assert.equal(run({ nr: 41 | 0x40000000, family: 40 }), 'errno:1', 'x32 syscalls are refused');
    assert.equal(run({ nr: 41, arch: 0x40000003, family: 2 }), 'errno:1', 'a foreign architecture is refused');
  });
});

describe('offline: KTD23 egress filter', () => {
  test('targets are lower-case DNS names with a port; IP literals and short overlay names are refused', () => {
    assert.deepEqual(parseTarget('Registry.NPMJS.org.:443'), { host: 'registry.npmjs.org', port: 443, key: 'registry.npmjs.org:443' });
    for (const bad of ['1.1.1.1:443', '[::1]:443', '127.0.0.1:18080', 'hf:22', 'localhost:443', 'a.b:0', 'a.b:70000', 'user@a.b:443', 'a.b', 'a.b:443/x', 'a..b:443', '-a.b:443', 'a.1:443']) {
      assert.equal(parseTarget(bad), null, bad);
    }
  });

  test('the configuration accepts only exact host:port entries and a plain http upstream', () => {
    const base = { schema: 'multi-agent-egress/v1', upstream: 'http://127.0.0.1:18080', allow: ['registry.npmjs.org:443'] };
    assert.deepEqual(validateEgressConfig(base).upstream, { host: '127.0.0.1', port: 18080 });
    assert.equal(validateEgressConfig({ ...base, upstream: null }).upstream, null);
    for (const bad of [
      { ...base, schema: 'x' },
      { ...base, allow: [] },
      { ...base, allow: ['REGISTRY.npmjs.org:443'] },
      { ...base, allow: ['10.0.0.1:443'] },
      { ...base, upstream: 'https://127.0.0.1:18080' },
      { ...base, upstream: 'http://u:p@127.0.0.1:18080' },
      { ...base, upstream: 'http://127.0.0.1:18080/path' },
      { ...base, upstream: 'http://127.0.0.1' },
    ]) {
      assert.throws(() => validateEgressConfig(bad), (err) => err.code === 'egress-config-invalid');
    }
  });

  test('direct resolution refuses loopback, private, link-local, overlay and multicast addresses', () => {
    for (const a of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.10', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.0.8', '198.18.0.1',
      '::1', '::', 'fd7a:115c::1', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::127.0.0.1', '::7f00:1',
      '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1', 'not-an-ip',
    ]) {
      assert.equal(isDeniedAddress(a), true, a);
    }
    for (const a of ['104.16.0.1', '2606:4700::1']) assert.equal(isDeniedAddress(a), false, a);
    // Any address bound on this host is refused, whatever its range.
    assert.equal(isDeniedAddress('203.0.113.7', ['203.0.113.7']), true);
  });

  test('the filter tunnels only CONNECT to an allowed target, through the upstream', { skip: process.platform === 'win32' && 'unix sockets' }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'egress-'));
    const socketPath = path.join(dir, 'proxy.sock');
    const seen = [];
    // Stand-in upstream proxy: accepts CONNECT for one host, then echoes.
    const upstream = net.createServer((s) => {
      s.once('data', (d) => {
        const line = String(d).split('\r\n')[0];
        seen.push(line);
        if (line === 'CONNECT registry.npmjs.org:443 HTTP/1.1') {
          s.write('HTTP/1.1 200 OK\r\n\r\n');
          s.on('data', (x) => s.write(x));
        } else s.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const logs = [];
    const config = { schema: 'multi-agent-egress/v1', upstream: `http://127.0.0.1:${upstream.address().port}`, allow: ['registry.npmjs.org:443', 'refused.example.com:443'] };
    const server = createEgressServer(config, { log: (e) => logs.push(e) });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    const ask = (request, payload) => new Promise((resolve) => {
      const c = net.connect(socketPath);
      let out = '';
      c.on('data', (d) => {
        out += d;
        if (payload && out.startsWith('HTTP/1.1 200') && !out.includes(payload)) c.write(payload);
        if (!payload || out.includes(payload)) c.end();
      });
      c.on('close', () => resolve(out));
      c.write(request);
    });
    try {
      const ok = await ask('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n', 'ping');
      assert.match(ok, /^HTTP\/1\.1 200 Connection Established\r\n\r\nping/);
      assert.match(await ask('CONNECT example.com:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/);
      assert.match(await ask('CONNECT 127.0.0.1:18080 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/);
      assert.match(await ask('GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n'), /^HTTP\/1\.1 405/);
      assert.match(await ask('CONNECT refused.example.com:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 502/);
      // Denied requests never reach the upstream.
      assert.deepEqual(seen, ['CONNECT registry.npmjs.org:443 HTTP/1.1', 'CONNECT refused.example.com:443 HTTP/1.1']);
      assert.deepEqual(logs.map((e) => e.decision), ['allow', 'deny', 'deny', 'deny', 'error']);
      assert.ok(!JSON.stringify(logs).includes('127.0.0.1:18080'), 'a refused raw target is not logged');
    } finally {
      server.close();
      upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejected half-open clients release the shared connection slot for every response path', { skip: process.platform === 'win32' && 'unix sockets', timeout: 10_000 }, async (t) => {
    for (const [request, status] of [
      ['CONNECT denied.example.com:443 HTTP/1.1\r\n\r\n', 403],
      ['CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n', 403],
      ['GET / HTTP/1.1\r\n\r\n', 405],
      ['CONNECT allowed.example.com:443 HTTP/1.1\r\n\r\n', 502],
    ]) {
      await t.test(request.split('\r\n')[0], async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'egress-'));
        const socketPath = path.join(dir, 'proxy.sock');
        const server = createEgressServer(
          { schema: 'multi-agent-egress/v1', upstream: null, allow: ['allowed.example.com:443'] },
          { maxConnections: 1, log: () => {}, lookup: async () => [{ address: '127.0.0.1', family: 4 }], localAddresses: [] },
        );
        await new Promise((resolve) => server.listen(socketPath, resolve));
        const clients = [];
        const ask = (input, allowHalfOpen = false) => new Promise((resolve, reject) => {
          const client = net.connect({ path: socketPath, allowHalfOpen });
          clients.push(client);
          let response = '';
          client.on('data', (chunk) => {
            response += chunk;
            if (response.includes('\r\n\r\n')) resolve(response);
          });
          client.on('error', reject);
          client.on('close', () => resolve(response));
          client.write(input);
        });
        let timer;
        try {
          const released = new Promise((resolve) => server.once('connection', (client) => client.once('close', resolve)));
          assert.match(await ask(request, true), new RegExp('^HTTP/1\\.1 ' + status + ' '));
          await Promise.race([
            released,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('rejected client retained the shared connection slot')), 1_000);
            }),
          ]);
          clearTimeout(timer);
          assert.equal(server.clients.size, 0);
          assert.match(await ask('CONNECT allowed.example.com:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 502 /);
        } finally {
          clearTimeout(timer);
          for (const client of clients) client.destroy();
          for (const client of server.clients) client.destroy();
          await new Promise((resolve) => server.close(resolve));
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });

  test('a client that half-closes after its upload still receives the reply, and bytes after each head pass once', { skip: process.platform === 'win32' && 'unix sockets' }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'egress-'));
    const socketPath = path.join(dir, 'proxy.sock');
    // Upstream sends bytes with its 200, then answers only after the client's EOF.
    const upstream = net.createServer({ allowHalfOpen: true }, (s) => {
      let got = '';
      s.on('data', (d) => {
        got += d;
        if (got.includes('\r\n\r\n') && !s.answered) { s.answered = true; s.write('HTTP/1.1 200 OK\r\n\r\nU1'); }
      });
      s.on('end', () => setTimeout(() => s.end(`[${got.split('\r\n\r\n')[1]}]`), 100));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const server = createEgressServer(
      { schema: 'multi-agent-egress/v1', upstream: `http://127.0.0.1:${upstream.address().port}`, allow: ['registry.npmjs.org:443'] },
      { log: () => {} },
    );
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const out = await new Promise((resolve) => {
        const c = net.connect({ path: socketPath, allowHalfOpen: true });
        let buf = '';
        c.on('data', (d) => {
          buf += d;
          if (buf.includes('U1') && !c.sent) { c.sent = true; c.end('B'); }
        });
        c.on('end', () => resolve(buf));
        c.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\nA');
      });
      assert.equal(out, 'HTTP/1.1 200 Connection Established\r\n\r\nU1[AB]');
    } finally {
      server.close();
      upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without an upstream, a name that resolves to a denied address is refused', { skip: process.platform === 'win32' && 'unix sockets' }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'egress-'));
    const socketPath = path.join(dir, 'proxy.sock');
    const server = createEgressServer(
      { schema: 'multi-agent-egress/v1', upstream: null, allow: ['rebind.example.com:443'] },
      { log: () => {}, lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    );
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const out = await new Promise((resolve) => {
        const c = net.connect(socketPath);
        let buf = '';
        c.on('data', (d) => { buf += d; });
        c.on('close', () => resolve(buf));
        c.write('CONNECT rebind.example.com:443 HTTP/1.1\r\n\r\n');
      });
      assert.match(out, /^HTTP\/1\.1 502/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
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
out.context_read = attempt(() => fs.readFileSync('/context/instructions.txt', 'utf8'));
out.framework_read = attempt(() => fs.readFileSync('/framework/skills/spec-work/SKILL.md').length > 0);
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
if (input.net) {
  // KTD23: enumerate what the worker can reach from inside its own network namespace.
  const tcp = (host, port) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, 2000);
    s.once('connect', () => {
      clearTimeout(t);
      // Scanning the ephemeral range can make a socket connect to itself (TCP
      // simultaneous open); that is not a listener.
      const self = s.localPort === port && s.localAddress === s.remoteAddress;
      s.destroy();
      resolve(self ? 'SELF' : 'CONNECTED');
    });
    s.once('error', (e) => { clearTimeout(t); resolve(e.code ?? 'ERROR'); });
  });
  const open = [];
  for (let base = 1; base <= 65535; base += 512) {
    const ports = Array.from({ length: Math.min(512, 65536 - base) }, (_, i) => base + i);
    (await Promise.all(ports.map((p) => tcp('127.0.0.1', p)))).forEach((r, i) => { if (r === 'CONNECTED') open.push(ports[i]); });
  }
  const targets = {};
  for (const [host, port] of input.net.targets) targets[host + ':' + port] = await tcp(host, port);
  const { promises: dns } = await import('node:dns');
  const curl = (url) => {
    const r = spawnSync('/usr/bin/curl', ['-s', '-m', '20', '-o', '/dev/null', '-w', '%{http_code} %{http_connect}', url], { encoding: 'utf8', timeout: 30000 });
    const [code, connect] = r.stdout.trim().split(' ');
    return { status: r.status, code, connect };
  };
  // Families a network namespace does not cover: AF_VSOCK (Hyper-V host channel) and io_uring.
  const fam = spawnSync('/usr/bin/python3', ['-c', input.net.familyProbe], { encoding: 'utf8', timeout: 10000 });
  // Every path socket visible anywhere in the sandbox; only the egress socket may accept.
  // No -xdev: every sandbox mount is a separate filesystem and must be walked.
  const found = spawnSync('/usr/bin/find', ['/', '(', '-path', '/proc', '-o', '-path', '/sys', ')', '-prune', '-o', '-type', 's', '-print'], { encoding: 'utf8', timeout: 60000 });
  const unixConnect = (p) => new Promise((resolve) => {
    const s = net.connect(p);
    const t = setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, 2000);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve('CONNECTED'); });
    s.once('error', (e) => { clearTimeout(t); resolve(e.code ?? 'ERROR'); });
  });
  const pathSockets = {};
  for (const p of found.stdout.split('\n').filter(Boolean)) pathSockets[p] = await unixConnect(p);
  out.net = {
    families: fam.status === 0 ? JSON.parse(fam.stdout) : { error: (fam.stderr || String(fam.error?.code)).slice(0, 160) },
    path_sockets: pathSockets,
    netns: fs.readlinkSync('/proc/self/ns/net'),
    loopback_open: open,
    targets,
    dns: await dns.lookup(input.net.dnsName).then((a) => a.address, (e) => 'ERR:' + e.code),
    egress_allowed: curl(input.net.allowedUrl),
    egress_denied: curl(input.net.deniedUrl),
    egress_ip_literal: curl(input.net.ipLiteralUrl),
  };
}
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
  const contextPaths = Object.fromEntries(policy.worker_identities.map(worker => [worker, path.posix.join(P.context_root, worker, tag, tag)]));
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
      denyRead: [sentinels.ownerToken, sentinels.database, sentinels.browserSessions, ...Object.values(contextPaths).map(p => p + '/instructions.txt'), '/mnt/c/Windows/win.ini', '/mnt/d', `/home/${process.env.USER}`, '/etc/shadow', '/etc/sudoers'],
      denyWrite: [sentinels.database, sentinels.wal, sentinels.shm, '/context/instructions.txt', '/framework/skills/spec-work/SKILL.md', `${P.installed_policy}`],
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
        ['--worker', worker, '--role', role, '--tree', tree, '--run', tag, '--attempt', tag, '--env', 'TERM=xterm-256color', '--', TOOL_NODE, '--input-type=module', '-e', PROBE, JSON.stringify(input)],
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
    for (const tool of ['/usr/bin/bwrap', '/usr/bin/setpriv', '/usr/bin/tmux', '/usr/bin/sudo', '/usr/bin/setfacl', '/usr/bin/getfacl', TOOL_NODE]) {
      if (!existsSync(tool)) ctx.blockers.push(`tool-missing:${tool}`);
    }
    for (const name of [policy.control_identity, ...policy.worker_identities]) {
      if (run('/usr/bin/id', ['-u', name]).status !== 0) ctx.blockers.push(`identity-missing:${name}`);
    }
    if (!existsSync(LAUNCHER) || !existsSync(P.installed_policy)) ctx.blockers.push('launcher-not-installed');
    const tiocsti = run('/usr/sbin/sysctl', ['-n', 'dev.tty.legacy_tiocsti']).stdout.trim();
    if (tiocsti !== '0') ctx.blockers.push(`kernel-legacy-tiocsti:${tiocsti || 'unknown'}`);
    if (Number(readFileSync('/proc/sys/user/max_user_namespaces', 'utf8')) < 1) ctx.blockers.push('kernel-userns-disabled');
    if (!existsSync(P.framework_dir)) ctx.blockers.push('framework-not-installed');
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
      for (const [worker, projection] of Object.entries(${JSON.stringify(contextPaths)})) {
        fs.mkdirSync(require('node:path').dirname(projection), { mode: 0o2750 });
        fs.mkdirSync(projection, { mode: 0o2750 });
        fs.writeFileSync(projection + '/instructions.txt', worker, { mode: 0o440 });
        fs.chmodSync(projection, 0o550);
      }
      fs.symlinkSync(${JSON.stringify(P.control_state_dir)}, ${JSON.stringify(escapeLink)});
    `]);
    if (stage.status !== 0) {
      ctx.blockers.push(`stage-failed:${stage.stderr.trim().slice(0, 120)}`);
      return;
    }
    ctx.cleanup.push(() => asControl('/usr/bin/rm', ['-rf', stageDir, implTree, revTree, escapeLink]));

    const listener = spawn('/usr/bin/sudo', ['-n', '-u', policy.control_identity, '--', TOOL_NODE, '-e', `
      const net = require('node:net');
      net.createServer((s) => { s.on('error', () => {}); s.end('supervisor'); }).listen(${JSON.stringify(sentinels.supervisorSocket)}, () => console.log(process.pid));
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
    // KTD23 fixtures: a live owner loopback listener the worker must not reach, plus
    // every non-loopback host address, the gateway, the resolver and the overlay resolver.
    const ownerListener = createServer((_, res) => res.end('owner'));
    await new Promise((resolve) => ownerListener.listen(0, '127.0.0.1', resolve));
    ctx.cleanup.push(() => ownerListener.close());
    const ownerPort = ownerListener.address().port;
    const hostAddrs = run('ip', ['-o', '-4', 'addr', 'show']).stdout.split('\n')
      .map((l) => l.trim().split(/\s+/)[3]?.split('/')[0]).filter((a) => a && !a.startsWith('127.'));
    const gateway = run('ip', ['-4', 'route', 'show', 'default']).stdout.match(/via (\S+)/)?.[1];
    const resolver = readFileSync('/etc/resolv.conf', 'utf8').match(/^nameserver\s+(\S+)/m)?.[1];
    const host6 = run('ip', ['-o', '-6', 'addr', 'show', 'scope', 'global']).stdout.split('\n')
      .map((l) => l.trim().split(/\s+/)[3]?.split('/')[0]).filter(Boolean);
    const hosts = [...new Set([...hostAddrs, ...host6, gateway, resolver, '100.100.100.100'].filter(Boolean))];
    const familyProbe = [
      'import socket, ctypes, errno, json',
      'def s(f):',
      '    try:',
      '        socket.socket(f, socket.SOCK_STREAM).close(); return "ok"',
      '    except OSError as e: return errno.errorcode.get(e.errno, str(e.errno))',
      'libc = ctypes.CDLL(None, use_errno=True); p = ctypes.create_string_buffer(120)',
      'r = libc.syscall(425, 1, p); e = ctypes.get_errno()',
      'print(json.dumps({"vsock": s(40), "inet": s(socket.AF_INET), "unix": s(socket.AF_UNIX), "io_uring": "ok" if r >= 0 else errno.errorcode.get(e, str(e))}))',
    ].join('\n');
    // Positive control: outside the sandbox the same families work, so a denial inside is the filter's doing.
    const hostFamilies = run('/usr/bin/python3', ['-c', familyProbe]);
    ctx.hostFamilies = hostFamilies.status === 0 ? JSON.parse(hostFamilies.stdout) : { error: hostFamilies.stderr.slice(0, 160) };
    ctx.netInput = {
      familyProbe,
      hostNetns: readlinkSync('/proc/self/ns/net'),
      hostAbstract: readFileSync('/proc/net/unix', 'utf8').split('\n').filter((l) => / @/.test(l)).length,
      ownerListening: run('ss', ['-Hltn', `sport = :${ownerPort}`]).stdout.includes(`127.0.0.1:${ownerPort}`),
      targets: [['127.0.0.1', ownerPort], ...hosts.flatMap((h) => [[h, 22], [h, 53], [h, 443]])],
      dnsName: 'registry.npmjs.org',
      allowedUrl: 'https://registry.npmjs.org/',
      deniedUrl: 'https://example.com/',
      ipLiteralUrl: 'https://1.1.1.1/',
    };
    ctx.impl = probe('ma-worker1', 'implementer', implTree, { net: ctx.netInput });
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

  test('managed Codex catalog is the pinned bundled catalog with every lite request shape off', () => {
    blocked();
    // The lite shape carries tools in an `additional_tools` input item that relay gateways drop.
    const file = `${P.toolchain_dir}/clients/codex-model-catalog.json`;
    const st = statSync(file);
    assert.equal(st.uid, 0, `${file} must be root-owned`);
    assert.equal(st.mode & 0o022, 0, `${file} must not be group/other writable`);
    const installed = JSON.parse(readFileSync(file, 'utf8')).models;
    const home = mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
    try {
      const r = run(CODEX, ['debug', 'models', '--bundled'], { env: { PATH: SANDBOX_PATH, CODEX_HOME: home } });
      assert.equal(r.status, 0, r.stderr);
      const bundled = JSON.parse(r.stdout).models;
      assert.deepEqual(installed.map((m) => m.slug), bundled.map((m) => m.slug), 'catalog must match the pinned client');
      assert.deepEqual(installed, bundled.map((m) => ({ ...m, use_responses_lite: false })), 'only use_responses_lite may differ');
    } finally { rmSync(home, { recursive: true, force: true }); }
    ctx.facts.codex_model_catalog = { sha256: sha256File(file), models: installed.length };
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

  test('KTD24: each worker reads only its private immutable context and the pinned framework', () => {
    blocked();
    const controlUid = Number(run('/usr/bin/id', ['-u', policy.control_identity]).stdout.trim());
    const acl = run('/usr/bin/getfacl', ['--absolute-names', P.context_root + '/ma-worker1']);
    assert.equal(acl.status, 0, acl.stderr);
    assert.match(acl.stdout, /default:group::r-x/);
    assert.match(acl.stdout, /default:mask::r-x/);
    const projections = {};
    for (const worker of policy.worker_identities) {
      const source = contextPaths[worker], file = source + '/instructions.txt';
      const own = asUser(worker, '/usr/bin/cat', [file]);
      assert.equal(own.status, 0, 'the assigned worker must read its own projection');
      assert.equal(own.stdout, worker);
      for (const other of policy.worker_identities.filter(name => name !== worker)) {
        assert.notEqual(asUser(other, '/usr/bin/cat', [file]).status, 0, 'another worker must not read the projection');
      }
      assert.notEqual(asUser(worker, '/usr/bin/touch', [source + '/planted']).status, 0, 'the worker must not modify its projection');
      const metadata = asControl(TOOL_NODE, ['-e', 'const fs = require("node:fs"); console.log(JSON.stringify(process.argv.slice(1).map(p => { const s = fs.lstatSync(p); return { uid: s.uid, gid: s.gid, mode: s.mode & 4095 }; })));',
        path.dirname(path.dirname(source)), path.dirname(source), source, file]);
      assert.equal(metadata.status, 0, metadata.stderr);
      const facts = JSON.parse(metadata.stdout);
      const gid = Number(run('/usr/bin/id', ['-g', worker]).stdout.trim());
      for (const st of facts) {
        assert.equal(st.uid, controlUid); assert.equal(st.gid, gid); assert.equal(st.mode & 0o027, 0);
      }
      assert.equal(facts[2].mode, 0o550); assert.equal(facts[3].mode, 0o440);
      projections[worker] = { path: source, files: facts };
    }
    for (const [worker, result] of [['ma-worker1', ctx.impl], ['ma-worker2', ctx.rev]]) {
      assert.deepEqual(result.context_read, { ok: true, v: worker });
      assert.deepEqual(result.framework_read, { ok: true, v: true });
      assert.equal(result.write['/context/instructions.txt'].ok, false);
      assert.equal(result.write['/framework/skills/spec-work/SKILL.md'].ok, false);
      assert.ok(!result.fd_targets.some(p => p === contextPaths[worker] || p === P.framework_dir), 'mount descriptors must not reach the worker');
    }
    const receiptPath = path.join(P.framework_dir, '.framework-receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const pin = readFileSync(path.join(here, '../packages/daemon/src/integrations/framework/catalog.ts'), 'utf8').match(/revision: "([a-f0-9]{40})"/)[1];
    assert.equal(receipt.revision, pin);
    const frameworkSource = 'skills/spec-work/SKILL.md';
    assert.equal(sha256File(path.join(P.framework_dir, frameworkSource)), receipt.files[frameworkSource].sha256);
    const writable = run('/usr/bin/find', [P.framework_dir, '-not', '-type', 'l', '(', '-perm', '/222', '-o', '-not', '-user', 'root', ')', '-print', '-quit']);
    assert.equal(writable.status, 0, writable.stderr); assert.equal(writable.stdout.trim(), '');
    ctx.facts.context = { projections, framework_revision: receipt.revision, framework_receipt_sha256: sha256File(receiptPath) };
  });

  test('launcher rejects out-of-policy requests with distinct codes', () => {
    blocked();
    const base = ['--run', tag, '--attempt', tag, '--role', 'implementer', '--', TOOL_NODE, '-v'];
    const cases = [
      [['--worker', policy.control_identity, '--tree', implTree, ...base], 'worker-not-allowed'],
      [['--worker', 'ma-worker1', '--tree', stageDir, ...base], 'tree-outside-assignment'],
      [['--worker', 'ma-worker1', '--tree', escapeLink, ...base], 'tree-outside-assignment'],
      [['--worker', 'ma-worker1', '--tree', implTree, '--env', 'LD_PRELOAD=/x', ...base], 'env-not-allowed'],
      [['--worker', 'ma-worker1', '--tree', implTree, '--run', tag, '--attempt', tag, '--role', 'implementer', '--', WINDOWS_PE], 'command-not-allowed'],
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
    // The supervisor fixture must still be live after the probes, or a refused connect proves nothing.
    const alive = asControl(TOOL_NODE, ['-e', `require('node:net').connect(${JSON.stringify(sentinels.supervisorSocket)}).once('connect', () => process.exit(0)).once('error', () => process.exit(1))`]);
    assert.equal(alive.status, 0, 'the supervisor socket fixture died during the probes');
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

  test('KTD23: the egress filter runs as its own identity from the reviewed source', () => {
    blocked();
    const props = Object.fromEntries(run('/usr/bin/systemctl', ['show', 'multi-agent-egress.service', '-p', 'ActiveState', '-p', 'User', '-p', 'NoNewPrivileges', '-p', 'MainPID'])
      .stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    ctx.facts.egress_service = props;
    assert.equal(props.ActiveState, 'active');
    assert.equal(props.User, policy.egress_identity);
    assert.equal(props.NoNewPrivileges, 'yes');
    const egressUid = run('/usr/bin/id', ['-u', policy.egress_identity]).stdout.trim();
    assert.deepEqual(run('/usr/bin/id', ['-Gn', policy.egress_identity]).stdout.trim().split(/\s+/), [policy.egress_identity]);
    assert.equal(readFileSync(`/proc/${props.MainPID}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)?.[1], egressUid, 'the filter process must run as the egress identity');
    const dir = statSync(P.egress_socket_dir);
    assert.equal(String(dir.uid), egressUid);
    assert.equal(dir.mode & 0o022, 0, 'the socket directory must not be group/other writable');
    assert.equal(sha256File(P.installed_egress), sha256File(path.join(here, '..', 'config', 'isolation', 'egress.mjs')), 'installed egress filter differs from the reviewed source');
    const cfgStat = statSync(P.installed_egress_config);
    assert.equal(cfgStat.uid, 0);
    assert.equal(cfgStat.mode & 0o022, 0);
    const cfg = JSON.parse(readFileSync(P.installed_egress_config, 'utf8'));
    validateEgressConfig(cfg);
    // A receipt is bound to this profile: a changed allow-list or upstream is a new profile.
    ctx.facts.egress_profile = { fingerprint: `sha256:${sha256File(P.installed_egress_config)}`, upstream_configured: cfg.upstream !== null, allow: cfg.allow };
  });

  test('KTD23: the worker reaches nothing on the host and leaves only through the egress filter', () => {
    blocked();
    const n = ctx.impl.net;
    assert.ok(n, `implementer probe reported no network facts: ${JSON.stringify(ctx.impl).slice(0, 300)}`);
    Object.assign(ctx.facts, {
      host_netns: ctx.netInput.hostNetns, sandbox_netns: n.netns, sandbox_loopback_open: n.loopback_open,
      sandbox_targets: n.targets, sandbox_dns: n.dns, host_abstract_sockets: ctx.netInput.hostAbstract,
      egress_allowed: n.egress_allowed, egress_denied: n.egress_denied, egress_ip_literal: n.egress_ip_literal,
    });
    assert.notEqual(n.netns, ctx.netInput.hostNetns, 'the sandbox must not share the host network namespace');
    assert.deepEqual(n.loopback_open, [policy.sandbox.egress_port], 'only the egress relay may listen on sandbox loopback');
    // The fixtures must be live, or their absence from the sandbox proves nothing.
    assert.ok(ctx.netInput.ownerListening, 'the owner loopback fixture must be listening on the host');
    assert.ok(ctx.netInput.hostAbstract > 0, 'the host must show abstract sockets');
    for (const [target, result] of Object.entries(n.targets)) assert.notEqual(result, 'CONNECTED', `sandbox reached ${target}`);
    assert.match(n.dns, /^ERR:/, 'the sandbox must have no name resolution of its own');
    assert.equal(ctx.impl.abstract_sockets, 0, 'host abstract unix sockets must be invisible');
    assert.equal(n.egress_allowed.connect, '200', `allowed egress failed: ${JSON.stringify(n.egress_allowed)}`);
    assert.match(n.egress_allowed.code, /^[23]\d\d$/);
    assert.equal(n.egress_denied.connect, '403', `an unlisted host must be refused by the filter: ${JSON.stringify(n.egress_denied)}`);
    assert.equal(n.egress_ip_literal.connect, '403', `an IP literal must be refused by the filter: ${JSON.stringify(n.egress_ip_literal)}`);
  });

  test('KTD23: no host channel outside the network namespace (AF_VSOCK, io_uring, path sockets)', () => {
    blocked();
    const n = ctx.impl.net;
    // A receipt is void once host networking changes, so record the mode it was taken under.
    ctx.facts.host_networking_mode = run('/usr/bin/wslinfo', ['--networking-mode']).stdout.trim() || 'unknown';
    Object.assign(ctx.facts, { host_families: ctx.hostFamilies, sandbox_families: n.families, sandbox_path_sockets: n.path_sockets });
    // Positive control first: on the host these families work, so their absence inside is the filter's doing.
    assert.equal(ctx.hostFamilies.vsock, 'ok', `host AF_VSOCK control failed: ${JSON.stringify(ctx.hostFamilies)}`);
    assert.equal(n.families.vsock, 'EAFNOSUPPORT', `AF_VSOCK must be refused inside the sandbox: ${JSON.stringify(n.families)}`);
    assert.equal(n.families.inet, 'ok');
    assert.equal(n.families.unix, 'ok');
    if (ctx.hostFamilies.io_uring === 'ok') assert.equal(n.families.io_uring, 'EPERM', 'io_uring must be refused inside the sandbox');
    else assert.notEqual(n.families.io_uring, 'ok');
    const reachable = Object.entries(n.path_sockets).filter(([, r]) => r === 'CONNECTED').map(([p]) => p);
    assert.deepEqual(reachable, [`${P.egress_socket_dir}/proxy.sock`], 'the egress socket must be the only connectable path socket');
    assert.ok(!ctx.impl.fd_targets.some((t) => t?.includes('ma-seccomp')), 'the seccomp program descriptor must not reach the worker');
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
