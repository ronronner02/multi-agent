// Restricted worker launcher.
//
// Installed root-owned at /usr/local/libexec/multi-agent/worker-launch.mjs and
// reachable only through a fixed sudoers rule for the control identity. It is
// not a general privileged executor: the identity must come from the worker
// allow-list, mounts come only from the installed policy, and the command runs
// after the drop to that identity inside a bubblewrap sandbox. Callers cannot
// add bind mounts, sandbox flags or environment outside the policy.

import { spawn } from 'node:child_process';
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY_SCHEMA = 'multi-agent-worker-policy/v1';
const INSTALLED_POLICY = '/etc/multi-agent/worker-policy.json';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
// Child descriptor numbers for the bubblewrap --bind-fd sources.
export const MOUNT_FD = Object.freeze({ home: 3, scratch: 4, tree: 5, context: 7, framework: 8 });
// Paths that must never appear as policy roots or sandbox sources.
const HOST_DENY_ROOTS = ['/mnt', '/run/WSL', '/init', '/proc', '/sys', '/root'];
// Set only by the launcher, to the in-sandbox egress relay; callers cannot pass them.
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY'];
export const EGRESS_SOCKET_NAME = 'proxy.sock';
// Child descriptor number for the bubblewrap --seccomp program.
export const SECCOMP_FD = 6;

// KTD23: a network namespace does not cover AF_VSOCK, the Hyper-V channel to the
// Windows host, and io_uring can create sockets without the socket() syscall.
// This classic-BPF seccomp program (x86_64 only) refuses both; everything else is allowed.
const SECCOMP = Object.freeze({
  AUDIT_ARCH_X86_64: 0xc000003e, X32_SYSCALL_BIT: 0x40000000,
  RET_ALLOW: 0x7fff0000, RET_ERRNO: 0x00050000, EPERM: 1, EAFNOSUPPORT: 97, AF_VSOCK: 40,
  NR: { socket: 41, socketpair: 53, io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427 },
});

export function buildSeccompFilter() {
  const S = SECCOMP;
  const LD_ABS = 0x20; const JEQ = 0x15; const JGE = 0x35; const RET = 0x06;
  // [code, jt, jf, k]; jumps are relative to the next instruction.
  const program = [
    [LD_ABS, 0, 0, 4], // arch
    [JEQ, 1, 0, S.AUDIT_ARCH_X86_64],
    [RET, 0, 0, S.RET_ERRNO | S.EPERM],
    [LD_ABS, 0, 0, 0], // syscall number
    [JGE, 6, 0, S.X32_SYSCALL_BIT],
    [JEQ, 5, 0, S.NR.io_uring_setup],
    [JEQ, 4, 0, S.NR.io_uring_enter],
    [JEQ, 3, 0, S.NR.io_uring_register],
    [JEQ, 3, 0, S.NR.socket],
    [JEQ, 2, 0, S.NR.socketpair],
    [RET, 0, 0, S.RET_ALLOW],
    [RET, 0, 0, S.RET_ERRNO | S.EPERM],
    [LD_ABS, 0, 0, 16], // low 32 bits of args[0], the address family
    [JEQ, 0, 1, S.AF_VSOCK],
    [RET, 0, 0, S.RET_ERRNO | S.EAFNOSUPPORT],
    [RET, 0, 0, S.RET_ALLOW],
  ];
  const buf = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], i) => {
    buf.writeUInt16LE(code, i * 8);
    buf.writeUInt8(jt, i * 8 + 2);
    buf.writeUInt8(jf, i * 8 + 3);
    buf.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return buf;
}

export class LaunchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LaunchError';
    this.code = code;
  }
}

const posix = path.posix;

function isWithin(parent, child) {
  const rel = posix.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !posix.isAbsolute(rel);
}

function overlaps(a, b) {
  return a === b || isWithin(a, b) || isWithin(b, a);
}

function requireAbsolute(value, field) {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || posix.normalize(value) !== value || (value.length > 1 && value.endsWith('/'))) {
    throw new LaunchError('policy-invalid', `${field} must be a normalized absolute path`);
  }
}

export function validatePolicy(policy) {
  const fail = (message) => {
    throw new LaunchError('policy-invalid', message);
  };
  if (!policy || policy.schema !== POLICY_SCHEMA) fail('unsupported policy schema');
  if (!Number.isInteger(policy.policy_revision) || policy.policy_revision < 1) fail('policy_revision must be a positive integer');
  for (const name of [policy.control_identity, ...(policy.launch_callers ?? []), ...(policy.worker_identities ?? [])]) {
    if (typeof name !== 'string' || !ID_PATTERN.test(name)) fail(`invalid identity name ${name}`);
  }
  if (!Array.isArray(policy.worker_identities) || policy.worker_identities.length === 0) fail('worker_identities must be non-empty');
  if (policy.worker_identities.includes(policy.control_identity)) fail('control identity may not be a worker identity');
  if (policy.launch_callers.some((c) => policy.worker_identities.includes(c))) fail('a worker identity may not be a launch caller');

  const p = policy.paths ?? {};
  for (const key of ['state_root', 'control_state_dir', 'worker_root', 'assignment_root', 'toolchain_dir', 'framework_dir', 'context_root']) {
    requireAbsolute(p[key], `paths.${key}`);
    if (HOST_DENY_ROOTS.some((deny) => overlaps(deny, p[key]))) fail(`paths.${key} overlaps a host-denied root`);
  }
  for (const key of ['worker_root', 'assignment_root', 'toolchain_dir', 'framework_dir', 'context_root']) {
    if (overlaps(p.control_state_dir, p[key])) fail(`paths.${key} overlaps the control state directory`);
  }
  if (overlaps(p.worker_root, p.assignment_root)) fail('worker_root and assignment_root must be disjoint');

  for (const key of ['worker_root', 'assignment_root', 'toolchain_dir', 'framework_dir']) {
    if (overlaps(p.context_root, p[key])) fail('paths.context_root overlaps paths.' + key);
  }
  // KTD24 adds mandatory private context mounts to the KTD23 filtered network.
  if (policy.policy_revision < 4) fail('policy_revision 4 or later is required');
  const egressId = policy.egress_identity;
  if (typeof egressId !== 'string' || !ID_PATTERN.test(egressId)) fail('egress_identity must be an identity name');
  if (egressId === policy.control_identity || policy.worker_identities.includes(egressId) || policy.launch_callers.includes(egressId)) {
    fail('egress_identity must differ from the control, launch-caller and worker identities');
  }
  if (!policy.forbidden_worker_groups?.includes(egressId)) fail('forbidden_worker_groups must include the egress identity');
  // Also the systemd RuntimeDirectory name, so it must be one plain path segment.
  // The lower-case pattern also keeps it off /run/WSL, whose interop sockets are world-writable.
  if (typeof p.egress_socket_dir !== 'string' || !/^\/run\/[a-z0-9][a-z0-9-]{0,63}$/.test(p.egress_socket_dir)) {
    fail('paths.egress_socket_dir must be /run/<name> with a lower-case name');
  }
  requireAbsolute(p.installed_egress, 'paths.installed_egress');
  if (!isWithin(p.toolchain_dir, p.installed_egress)) fail('paths.installed_egress must be inside the toolchain directory');

  const s = policy.sandbox ?? {};
  for (const key of ['home', 'scratch', 'work', 'framework', 'context']) requireAbsolute(s[key], `sandbox.${key}`);
  if (s.context !== '/context' || s.framework !== '/framework') fail('context and framework targets must be /context and /framework');
  for (const key of ['home', 'scratch', 'work']) {
    if (overlaps(s.context, s[key]) || overlaps(s.framework, s[key])) fail('writable mounts must not overlap the context mounts');
  }
  if (s.network !== 'filtered-proxy') fail('sandbox.network must be filtered-proxy; sharing the host network namespace is not allowed');
  if (!Number.isInteger(s.egress_port) || s.egress_port < 1024 || s.egress_port > 65535) fail('sandbox.egress_port must be an integer from 1024 to 65535');
  for (const masked of s.masked_paths ?? []) {
    requireAbsolute(masked, 'sandbox.masked_paths');
    if (!isWithin('/usr', masked)) fail('sandbox.masked_paths entries must be inside /usr');
  }
  for (const src of s.etc_ro_binds ?? []) {
    requireAbsolute(src, 'sandbox.etc_ro_binds');
    if (!isWithin('/etc', src) || ['/etc/shadow', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d', '/etc/multi-agent'].some((d) => overlaps(d, src))) {
      fail(`sandbox.etc_ro_binds may not expose ${src}`);
    }
  }

  for (const [role, spec] of Object.entries(policy.roles ?? {})) {
    if (!ID_PATTERN.test(role) || !['rw', 'ro'].includes(spec?.work_tree)) fail(`invalid role ${role}`);
  }
  if (Object.keys(policy.roles ?? {}).length === 0) fail('roles must be non-empty');

  for (const key of policy.env_passthrough ?? []) {
    if (!ENV_KEY_PATTERN.test(key) || key.startsWith('LD_') || ['HOME', 'PATH', 'USER', 'TMPDIR'].includes(key) || PROXY_ENV_KEYS.includes(key)) {
      fail(`env_passthrough may not include ${key}`);
    }
  }
  for (const prefix of policy.allowed_exec_prefixes ?? []) {
    if (typeof prefix !== 'string' || !prefix.startsWith('/') || !prefix.endsWith('/')) fail('allowed_exec_prefixes entries must be absolute directories ending in /');
    if (HOST_DENY_ROOTS.some((deny) => overlaps(deny, prefix.slice(0, -1)))) fail(`allowed_exec_prefixes may not include ${prefix}`);
  }
  return policy;
}

export function parseLaunchArgs(argv) {
  const request = { worker: null, role: null, tree: null, run: null, attempt: null, env: [], command: [] };
  const valueFlags = { '--worker': 'worker', '--role': 'role', '--tree': 'tree', '--run': 'run', '--attempt': 'attempt' };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      request.command = argv.slice(i + 1);
      break;
    }
    if (Object.hasOwn(valueFlags, arg) || arg === '--env') {
      const value = argv[i + 1];
      if (value === undefined || value === '--') throw new LaunchError('argument-invalid', `${arg} requires a value`);
      if (arg === '--env') request.env.push(value);
      else if (request[valueFlags[arg]] !== null) throw new LaunchError('argument-invalid', `${arg} given twice`);
      else request[valueFlags[arg]] = value;
      i += 1;
      continue;
    }
    throw new LaunchError('argument-unknown', `unknown argument ${arg}`);
  }
  if (request.command.length === 0) throw new LaunchError('command-missing', 'a command is required after --');
  for (const field of ['worker', 'role', 'run', 'attempt']) {
    if (request[field] !== null && !ID_PATTERN.test(request[field])) throw new LaunchError('argument-invalid', `invalid ${field}`);
  }
  return request;
}

function verifyReadOnlyDirectory(source, facts, worker, control, privateRoot = null) {
  try {
    if (facts.realpath(source) !== source) throw new Error('aliased source');
    for (let p = source; ; p = posix.dirname(p)) {
      const st = facts.lstat(p);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid === worker.uid || (st.mode & 0o022)) throw new Error('writable source ancestry');
      const access = (st.mode >> (st.gid === worker.gid ? 3 : 0)) & 7;
      if ((access & (p === source ? 5 : 1)) !== (p === source ? 5 : 1)) throw new Error('unreadable source');
      if (privateRoot && (p === privateRoot || isWithin(privateRoot, p))) {
        if (st.uid !== control.uid || st.gid !== worker.gid || (st.mode & 0o007)
          || (p === source && (st.mode & 0o222))) throw new Error('non-private context source');
      }
      if (p === posix.dirname(p)) break;
    }
  } catch {
    throw new LaunchError('context-mount-unavailable', 'context and framework must exist with verified read-only ownership');
  }
}

// facts: { callerUid, lookupUser(name) -> {name, uid, gid, groups[]} | null,
//          realpath(p) -> string, isDirectory(p) -> boolean, lstat(p) -> Stats, legacyTiocsti,
//          egressSocket -> {dirUid, dirMode, isSocket} | null }
export function resolveLaunchRequest(policy, request, facts) {
  validatePolicy(policy);

  const callerUids = policy.launch_callers.map((name) => facts.lookupUser(name)?.uid).filter((uid) => uid !== undefined);
  if (!Number.isInteger(facts.callerUid) || !callerUids.includes(facts.callerUid)) {
    throw new LaunchError('caller-not-allowed', 'launcher may only be invoked by the control identity');
  }

  if (!request.worker || !policy.worker_identities.includes(request.worker)) {
    throw new LaunchError('worker-not-allowed', 'worker identity is not in the policy allow-list');
  }
  const worker = facts.lookupUser(request.worker);
  if (!worker) throw new LaunchError('worker-account-missing', `worker account ${request.worker} is not provisioned`);
  const control = facts.lookupUser(policy.control_identity);
  if (worker.uid === 0 || worker.gid === 0 || (control && (worker.uid === control.uid || worker.gid === control.gid))) {
    throw new LaunchError('worker-privileged-group', 'worker identity shares a privileged or control id');
  }
  if (worker.groups.some((g) => policy.forbidden_worker_groups.includes(g))) {
    throw new LaunchError('worker-privileged-group', 'worker identity belongs to a privileged group');
  }

  const roleSpec = request.role && Object.hasOwn(policy.roles, request.role) ? policy.roles[request.role] : undefined;
  if (!roleSpec) throw new LaunchError('role-not-allowed', 'role is not defined by the policy');

  if (!request.tree || !posix.isAbsolute(request.tree)) throw new LaunchError('tree-outside-assignment', 'tree must be an absolute path');
  const assignmentDir = posix.join(facts.realpath(policy.paths.assignment_root), request.worker);
  let tree;
  try {
    tree = facts.realpath(request.tree);
  } catch {
    throw new LaunchError('tree-missing', 'assigned tree does not exist');
  }
  if (!isWithin(assignmentDir, tree)) throw new LaunchError('tree-outside-assignment', 'tree must be inside the worker assignment directory');
  if (!facts.isDirectory(tree)) throw new LaunchError('tree-missing', 'assigned tree is not a directory');

  if (!request.run || !request.attempt) throw new LaunchError('context-missing', 'run and attempt are required for the context projection');
  const contextParent = posix.join(policy.paths.context_root, request.worker);
  const context = posix.join(contextParent, request.run, request.attempt);
  verifyReadOnlyDirectory(context, facts, worker, control, contextParent);
  verifyReadOnlyDirectory(policy.paths.framework_dir, facts, worker, control);

  const env = {};
  for (const entry of request.env) {
    const eq = entry.indexOf('=');
    const key = eq > 0 ? entry.slice(0, eq) : entry;
    if (eq <= 0 || !policy.env_passthrough.includes(key)) throw new LaunchError('env-not-allowed', `environment key ${key} is not allowed`);
    env[key] = entry.slice(eq + 1);
  }
  if (request.attempt) env.MA_ATTEMPT_ID = request.attempt;

  const [exe] = request.command;
  if (!posix.isAbsolute(exe) || posix.normalize(exe) !== exe || !policy.allowed_exec_prefixes.some((prefix) => exe.startsWith(prefix))) {
    throw new LaunchError('command-not-allowed', 'command must be an absolute path under an allowed prefix');
  }

  if (policy.sandbox.interactive_tty && policy.sandbox.require_legacy_tiocsti_disabled && facts.legacyTiocsti !== 0) {
    throw new LaunchError('host-tiocsti-enabled', 'dev.tty.legacy_tiocsti must be 0 for interactive worker sessions');
  }

  // Without the filter the sandbox would still have no network; fail now with a distinct code.
  const egressUser = facts.lookupUser(policy.egress_identity);
  const egress = facts.egressSocket;
  if (!egressUser || !egress || !egress.isSocket || egress.dirUid !== egressUser.uid || (egress.dirMode & 0o022) !== 0) {
    throw new LaunchError('egress-unavailable', 'the worker egress filter is not running under the egress identity');
  }

  return {
    worker: { name: worker.name, uid: worker.uid, gid: worker.gid },
    role: request.role,
    tree,
    treeMode: roleSpec.work_tree,
    context,
    framework: policy.paths.framework_dir,
    home: posix.join(policy.paths.worker_root, request.worker, 'home'),
    scratch: posix.join(policy.paths.worker_root, request.worker, 'scratch'),
    env,
    command: request.command,
  };
}

export function buildSandboxCommand(policy, resolved) {
  const s = policy.sandbox;
  const p = policy.paths;
  const args = [
    `--reuid=${resolved.worker.uid}`,
    `--regid=${resolved.worker.gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--inh-caps=-all',
    '--bounding-set=-all',
    '--',
    '/usr/bin/bwrap',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    // KTD23: an empty network namespace (loopback only). Host loopback, LAN,
    // overlay peers, DNS and abstract sockets are unreachable; the only way out
    // is the egress filter's socket bound below.
    '--unshare-net',
    '--seccomp', String(SECCOMP_FD),
    '--die-with-parent',
    '--hostname', s.hostname,
  ];
  // Without an interactive pane the session is detached from the caller tty.
  if (!s.interactive_tty) args.push('--new-session');

  args.push('--clearenv');
  const proxy = `http://127.0.0.1:${s.egress_port}`;
  const env = {
    HOME: s.home,
    PATH: s.path,
    USER: resolved.worker.name,
    TMPDIR: '/tmp',
    ...resolved.env,
    // Clients differ in which spelling they read, so both are set.
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };
  for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);

  args.push('--ro-bind', '/usr', '/usr');
  // WSL mounts Windows-provided trees (driver store, GPU libraries) under /usr.
  for (const masked of s.masked_paths ?? []) args.push('--tmpfs', masked, '--remount-ro', masked);
  args.push(
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
  );
  for (const src of s.etc_ro_binds) args.push('--ro-bind-try', src, src);
  args.push(
    '--ro-bind', p.toolchain_dir, p.toolchain_dir,
    '--ro-bind-fd', String(MOUNT_FD.framework), s.framework,
    '--ro-bind-fd', String(MOUNT_FD.context), s.context,
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    // After the /run tmpfs, which would otherwise cover it.
    '--ro-bind', p.egress_socket_dir, p.egress_socket_dir,
    '--dir', '/var/tmp',
    '--bind-fd', String(MOUNT_FD.home), s.home,
    '--bind-fd', String(MOUNT_FD.scratch), s.scratch,
    resolved.treeMode === 'rw' ? '--bind-fd' : '--ro-bind-fd', String(MOUNT_FD.tree), s.work,
    '--chdir', s.work,
    '--',
    `${p.toolchain_dir}/node/bin/node`, p.installed_egress, 'relay', String(s.egress_port), posix.join(p.egress_socket_dir, EGRESS_SOCKET_NAME),
    '--',
    ...resolved.command,
  );
  // Writable sources are passed as descriptors opened and re-verified by the
  // launcher, so a path swapped after validation cannot change what is mounted.
  return { file: '/usr/bin/setpriv', args, mountSources: { home: resolved.home, scratch: resolved.scratch, tree: resolved.tree, context: resolved.context, framework: resolved.framework } };
}

// A directory descriptor on stdio would let the worker openat() outside its mounts.
export function assertSafeStdio(kinds) {
  kinds.forEach((kind, fd) => {
    if (kind === 'directory') throw new LaunchError('stdio-not-allowed', `fd ${fd} must not be a directory`);
  });
}

function stdioKinds() {
  return [0, 1, 2].map((fd) => {
    try {
      return fstatSync(fd).isDirectory() ? 'directory' : 'other';
    } catch {
      return 'closed';
    }
  });
}

function openVerifiedDirectory(expected, allowedParent) {
  const fd = openSync(expected, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC);
  const actual = readlinkSync(`/proc/self/fd/${fd}`);
  if (actual !== expected || !isWithin(allowedParent, actual)) {
    closeSync(fd);
    throw new LaunchError('mount-source-changed', `${expected} changed during launch`);
  }
  return fd;
}

// The program is written to a root-only directory and unlinked before launch; bwrap
// reads it from the descriptor. A leaked descriptor would show this /run path.
function openSeccompProgram() {
  const dir = mkdtempSync('/run/ma-seccomp-');
  try {
    const file = path.posix.join(dir, 'filter.bpf');
    writeFileSync(file, buildSeccompFilter(), { mode: 0o400 });
    return openSync(file, fsConstants.O_RDONLY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readEtcDatabase(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => line.split(':'));
}

function hostFacts(policy) {
  const policySocketDir = policy.paths.egress_socket_dir;
  const passwd = readEtcDatabase('/etc/passwd');
  const groups = readEtcDatabase('/etc/group');
  const lookupUser = (name) => {
    const row = passwd.find((r) => r[0] === name);
    if (!row) return null;
    const uid = Number(row[2]);
    const gid = Number(row[3]);
    const names = groups.filter((g) => Number(g[2]) === gid || (g[3] ?? '').split(',').includes(name)).map((g) => g[0]);
    return { name, uid, gid, groups: names };
  };
  let legacyTiocsti = null;
  try {
    legacyTiocsti = Number(readFileSync('/proc/sys/dev/tty/legacy_tiocsti', 'utf8').trim());
  } catch {
    legacyTiocsti = null;
  }
  return {
    callerUid: process.env.SUDO_UID === undefined ? Number.NaN : Number(process.env.SUDO_UID),
    lookupUser,
    realpath: (p) => realpathSync(p),
    isDirectory: (p) => statSync(p).isDirectory(),
    lstat: (p) => lstatSync(p),
    legacyTiocsti,
    egressSocket: (() => {
      try {
        const dir = lstatSync(policySocketDir);
        if (!dir.isDirectory()) return null;
        return { dirUid: dir.uid, dirMode: dir.mode & 0o7777, isSocket: lstatSync(path.posix.join(policySocketDir, EGRESS_SOCKET_NAME)).isSocket() };
      } catch {
        return null;
      }
    })(),
  };
}

function reportError(err) {
  const code = err instanceof LaunchError ? err.code : 'launcher-internal';
  process.stderr.write(`${JSON.stringify({ worker_launch_error: code, message: err.message })}\n`);
  process.exit(126);
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) throw new LaunchError('launcher-not-root', 'launcher must run as root via sudo');
    if (process.arch !== 'x64') throw new LaunchError('host-arch-unsupported', 'the seccomp program is defined for x86_64 only');
    assertSafeStdio(stdioKinds());
    const policy = validatePolicy(JSON.parse(readFileSync(INSTALLED_POLICY, 'utf8')));
    const resolved = resolveLaunchRequest(policy, parseLaunchArgs(argv), hostFacts(policy));
    const { file, args, mountSources } = buildSandboxCommand(policy, resolved);
    const workerDir = path.posix.join(policy.paths.worker_root, resolved.worker.name);
    const assignmentDir = path.posix.join(realpathSync(policy.paths.assignment_root), resolved.worker.name);
    const fds = [];
    fds[MOUNT_FD.home] = openVerifiedDirectory(mountSources.home, workerDir);
    fds[MOUNT_FD.scratch] = openVerifiedDirectory(mountSources.scratch, workerDir);
    fds[MOUNT_FD.tree] = openVerifiedDirectory(mountSources.tree, assignmentDir);
    fds[MOUNT_FD.context] = openVerifiedDirectory(mountSources.context, posix.join(policy.paths.context_root, resolved.worker.name));
    fds[MOUNT_FD.framework] = openVerifiedDirectory(mountSources.framework, posix.dirname(policy.paths.framework_dir));
    fds[SECCOMP_FD] = openSeccompProgram();
    const child = spawn(file, args, { stdio: ['inherit', 'inherit', 'inherit', ...fds.slice(3)], env: {} });
    for (const fd of fds.slice(3)) closeSync(fd);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
      process.on(signal, () => child.kill(signal));
    }
    child.on('error', reportError);
    child.on('exit', (code, signal) => process.exit(code ?? 128 + (osConstants.signals[signal] ?? 0)));
  } catch (err) {
    reportError(err);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
