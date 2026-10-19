// Restricted worker launcher.
//
// Installed root-owned at /usr/local/libexec/multi-agent/worker-launch.mjs and
// reachable only through a fixed sudoers rule for the control identity. It is
// not a general privileged executor: the identity must come from the worker
// allow-list, mounts come only from the installed policy, and the command runs
// after the drop to that identity inside a bubblewrap sandbox. Callers cannot
// add bind mounts, sandbox flags or environment outside the policy.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY_SCHEMA = 'multi-agent-worker-policy/v1';
const NATIVE_POLICY_MOUNTS = Object.freeze({
  'claude-code': { source: 'native/claude/managed-settings.json', target: '/etc/claude-code/managed-settings.json' },
  codex: { source: 'native/codex/requirements.toml', target: '/etc/codex/requirements.toml' },
});
const INSTALLED_POLICY = '/etc/multi-agent/worker-policy.json';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
// Child descriptor numbers for the bubblewrap --bind-fd sources.
export const MOUNT_FD = Object.freeze({ home: 3, scratch: 4, tree: 5, context: 7, framework: 8, mailbox: 9, nativePolicy: 10, bootstrap: 11 });
// Paths that must never appear as policy roots or sandbox sources.
const HOST_DENY_ROOTS = ['/mnt', '/run/WSL', '/init', '/proc', '/sys', '/root'];
// Set only by the launcher, to the in-sandbox egress relay; callers cannot pass them.
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY'];
export const EGRESS_SOCKET_NAME = 'proxy.sock';
// Child descriptor number for the bubblewrap --seccomp program.
export const SECCOMP_FD = 6;
export const SANDBOX_STATUS_FD = 12;

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
  if (policy.policy_revision < 5) fail('policy_revision 5 or later is required');
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
  if (p.mailbox_root !== posix.join(p.control_state_dir, 'mailboxes') || s.mailbox !== '/run/multi-agent/mailbox.sock') {
    fail('the mailbox must use the fixed control-owned source and mailbox-only target');
  }
  if (Object.keys(s.native_policy_mounts ?? {}).sort().join(',') !== 'claude-code,codex') fail('native policy aliases are required');
  for (const [client, mount] of Object.entries(NATIVE_POLICY_MOUNTS)) {
    const configured = s.native_policy_mounts[client];
    if (!configured || Object.keys(configured).sort().join(',') !== 'source,target'
      || configured.source !== mount.source || configured.target !== mount.target) fail('native policy aliases must be fixed');
  }
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
  const request = { worker: null, role: null, tree: null, run: null, attempt: null, mailbox: null, env: [], command: [] };
  const valueFlags = { '--worker': 'worker', '--role': 'role', '--tree': 'tree', '--run': 'run', '--attempt': 'attempt', '--mailbox': 'mailbox' };
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
  if (request.mailbox !== null) {
    const parts = request.mailbox.split(':').map(Number);
    if (parts.length !== 2 || !parts.every(n => Number.isSafeInteger(n) && n >= 0) || parts.join(':') !== request.mailbox) {
      throw new LaunchError('argument-invalid', 'mailbox must be a canonical device:inode identity');
    }
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
function assertLaunchCaller(policy, facts) {
  const callerUids = policy.launch_callers.map((name) => facts.lookupUser(name)?.uid).filter((uid) => uid !== undefined);
  if (!Number.isInteger(facts.callerUid) || !callerUids.includes(facts.callerUid)) {
    throw new LaunchError('caller-not-allowed', 'launcher may only be invoked by the control identity');
  }
}

export function resolveLaunchRequest(policy, request, facts) {
  validatePolicy(policy);
  assertLaunchCaller(policy, facts);

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

  const client = exe === policy.paths.toolchain_dir + '/clients/bin/claude' ? 'claude-code'
    : exe === policy.paths.toolchain_dir + '/clients/bin/codex' ? 'codex' : null;
  if (client && !request.mailbox) throw new LaunchError('mailbox-unavailable', 'native launch requires its registered mailbox endpoint');
  let mailbox, nativePolicy, bootstrap;
  if (request.mailbox) {
    try {
      const socketPath = posix.join(policy.paths.mailbox_root, request.worker, request.run, request.attempt, 'mailbox.sock');
      if (facts.realpath(socketPath) !== socketPath) throw new Error('aliased endpoint');
      for (let p = posix.dirname(socketPath); ; p = posix.dirname(p)) {
        const st = facts.lstat(p);
        if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== control.uid || st.gid !== control.gid
          || (st.mode & 0o7777) !== 0o700) throw new Error('non-private endpoint ancestry');
        if (p === policy.paths.control_state_dir) break;
      }
      const st = facts.lstat(socketPath), [dev, ino] = request.mailbox.split(':').map(Number);
      if (!st.isSocket() || st.uid !== control.uid || st.gid !== control.gid || (st.mode & 0o7777) !== 0o666
        || st.dev !== dev || st.ino !== ino) throw new Error('unregistered endpoint');
      mailbox = { path: socketPath, kind: 'socket', uid: st.uid, gid: st.gid, dev, ino, mode: 0o666 };
    } catch { throw new LaunchError('mailbox-unavailable', 'mailbox identity or private ownership changed'); }
  }
  if (mailbox) {
    try {
      const source = posix.join(posix.dirname(mailbox.path), 'bootstrap.json'), st = facts.lstat(source);
      if (facts.realpath(source) !== source || !st.isFile() || st.isSymbolicLink() || st.uid !== control.uid
        || st.gid !== control.gid || (st.mode & 0o7777) !== 0o600 || st.size > 8_192) throw new Error('invalid private bootstrap');
      const raw = facts.readFile(source);
      if (Buffer.byteLength(raw) > 8_192) throw new Error('oversized bootstrap');
      const data = JSON.parse(raw), fields = ['authorization', 'sessionId', 'runId', 'attemptId', 'generation', 'taskId', 'capability'];
      if (!data || Array.isArray(data) || Object.keys(data).length !== fields.length
        || fields.some(field => typeof data[field] !== 'string' || !data[field] || data[field].length > 1_024)
        || data.runId !== request.run || data.attemptId !== request.attempt
        || !/^mailbox:[A-Za-z0-9_-]{43}$/.test(data.capability)) throw new Error('unbound bootstrap');
      bootstrap = { path: source, kind: 'file', uid: st.uid, gid: st.gid, dev: st.dev, ino: st.ino, mode: 0o600,
        contentHash: createHash('sha256').update(raw).digest('hex') };
    } catch { throw new LaunchError('mailbox-bootstrap-unavailable', 'private mailbox bootstrap is missing or does not match the attempt'); }
  }

  if (client) {
    try {
      const mount = policy.sandbox.native_policy_mounts[client], source = posix.join(context, mount.source);
      verifyReadOnlyDirectory(posix.dirname(source), facts, worker, control, contextParent);
      const st = facts.lstat(source);
      if (facts.realpath(source) !== source || !st.isFile() || st.isSymbolicLink() || st.uid !== control.uid
        || st.gid !== worker.gid || (st.mode & 0o7777) !== 0o440 || st.size > 1_048_576) throw new Error('invalid native policy source');
      nativePolicy = { path: source, target: mount.target, kind: 'file', uid: st.uid, gid: st.gid, dev: st.dev, ino: st.ino, mode: 0o440 };
    } catch { throw new LaunchError('native-policy-unavailable', 'native policy must be private, immutable and control-owned'); }
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
    ...(mailbox ? { mailbox, bootstrap } : {}), ...(nativePolicy ? { nativePolicy, client } : {}),
  };
}

/** Read-only control preflight. Request validation is shared with the actual launch. */
export function inspectLaunchRequest(policy, request, facts) {
  const resolved = resolveLaunchRequest(policy, request, facts);
  try {
    const control = facts.lookupUser(policy.control_identity);
    const installed = {};
    for (const [key, file] of Object.entries({ policy: policy.paths.installed_policy,
      launcher: policy.paths.installed_launcher, executable: request.command[0], egress: policy.paths.installed_egress_config })) {
      const observed = facts.inspectFile(file);
      if (!observed || observed.path !== file || observed.uid !== 0 || observed.gid !== 0
        || !Number.isSafeInteger(observed.mode) || observed.mode < 0 || observed.mode > 0o7777 || (observed.mode & 0o022)
        || key === 'executable' && !(observed.mode & 0o001)
        || !Number.isSafeInteger(observed.size) || observed.size < 0 || !/^sha256:[a-f0-9]{64}$/.test(observed.sha256)
        || typeof observed.realpath !== 'string' || !posix.isAbsolute(observed.realpath) || posix.normalize(observed.realpath) !== observed.realpath
        || (key === 'executable' ? !policy.allowed_exec_prefixes.some(prefix => observed.realpath.startsWith(prefix)) : observed.realpath !== file)) {
        throw new Error('untrusted installed file');
      }
      installed[key] = observed;
    }
    if (installed.policy.sha256 !== facts.policyFingerprint) throw new Error('policy changed during inspection');
    const namespaces = Object.fromEntries(['mnt', 'user', 'net'].map(kind => {
      const value = facts.namespace(kind);
      if (typeof value !== 'string' || !new RegExp('^' + kind + ':\\[\\d+\\]$').test(value)) throw new Error('missing namespace');
      return [kind, value];
    }));
    return {
      schema: 'multi-agent-launch-preflight/v1',
      worker: resolved.worker,
      control: { uid: control.uid, gid: control.gid, mountNamespace: namespaces.mnt, userNamespace: namespaces.user },
      roots: { home: resolved.home, scratch: resolved.scratch, tree: resolved.tree, context: resolved.context, framework: resolved.framework },
      installed,
      network: { hostNamespace: namespaces.net, profileFingerprint: installed.egress.sha256 },
    };
  } catch {
    throw new LaunchError('preflight-unverified', 'Installed launch facts are missing, untrusted or changed');
  }
}

/** Hash an opened root-owned file rather than a caller-supplied receipt or mutable pathname. */
export function inspectInstalledFile(file) {
  let fd;
  try {
    requireAbsolute(file, 'installedFile');
    const real = realpathSync(file);
    for (const source of [posix.dirname(file), posix.dirname(real)]) {
      for (let parent = source; ; parent = posix.dirname(parent)) {
        const st = lstatSync(parent);
        if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o022)) throw new Error('untrusted ancestry');
        if (parent === posix.dirname(parent)) break;
      }
    }
    fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o022) || st.size > 512 * 1024 * 1024) throw new Error('untrusted file');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let position = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      position += count;
      if (position > st.size) throw new Error('growing file');
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (position !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs
      || realpathSync(file) !== real || lstatSync(real).ino !== st.ino || lstatSync(real).dev !== st.dev) throw new Error('changed file');
    return { path: file, realpath: real, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777, size: st.size,
      sha256: 'sha256:' + hash.digest('hex') };
  } catch {
    throw new LaunchError('preflight-unverified', 'Installed launch file is missing, untrusted or changed');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function buildSandboxCommand(policy, resolved, supervised = false) {
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
  if (supervised) args.push('--info-fd', String(SANDBOX_STATUS_FD));

  args.push('--clearenv');
  const proxy = `http://127.0.0.1:${s.egress_port}`;
  const env = {
    HOME: s.home,
    PATH: s.path,
    USER: resolved.worker.name,
    TMPDIR: '/tmp',
    ...resolved.env,
    ...(resolved.client ? { CODEX_HOME: s.home + "/.codex", CLAUDE_CONFIG_DIR: s.home + "/.claude", DISABLE_AUTOUPDATER: "1" } : {}),
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
    ...(resolved.mailbox ? ['--tmpfs', posix.dirname(s.mailbox), '--ro-bind-fd', String(MOUNT_FD.mailbox), s.mailbox, '--remount-ro', posix.dirname(s.mailbox)] : []),
    ...(resolved.nativePolicy ? ['--tmpfs', posix.dirname(resolved.nativePolicy.target), '--ro-bind-fd', String(MOUNT_FD.nativePolicy), resolved.nativePolicy.target,
      '--remount-ro', posix.dirname(resolved.nativePolicy.target)] : []),
    '--dir', '/var/tmp',
    '--bind-fd', String(MOUNT_FD.home), s.home,
    ...(resolved.bootstrap ? ['--perms', '0700', '--tmpfs', s.home + '/.multi-agent/mailbox', '--perms', '0400',
      '--ro-bind-data', String(MOUNT_FD.bootstrap), s.home + '/.multi-agent/mailbox/bootstrap.json'] : []),
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

/** Recheck the exact registered inode after opening, before the descriptor reaches the namespace. */
export function openVerifiedSource(expected) {
  let fd;
  try {
    // Linux O_PATH holds a Unix socket inode without connecting to its service.
    fd = openSync(expected.path, (expected.kind === 'socket' ? 0x200000 : fsConstants.O_RDONLY)
      | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC);
    const st = fstatSync(fd);
    if (readlinkSync('/proc/self/fd/' + fd) !== expected.path || st.dev !== expected.dev || st.ino !== expected.ino
      || st.uid !== expected.uid || st.gid !== expected.gid || (st.mode & 0o7777) !== expected.mode
      || !(expected.kind === 'socket' ? st.isSocket() : st.isFile())) throw new Error('changed mount source');
    if (expected.contentHash) {
      const bytes = Buffer.alloc(8_193), count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count > 8_192 || createHash('sha256').update(bytes.subarray(0, count)).digest('hex') !== expected.contentHash) {
        throw new Error('changed private bootstrap bytes');
      }
    }
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new LaunchError('mount-source-changed', 'registered mailbox or native policy source changed during launch');
  }
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
    readFile: (p) => readFileSync(p, "utf8"),
    inspectFile: inspectInstalledFile,
    namespace: (kind) => readlinkSync('/proc/self/ns/' + kind),
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

function boundLifecycle(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LaunchError('sandbox-quiescence-unconfirmed', 'Sandbox lifecycle evidence is unconfirmed')), 10_000);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function quiesceNamespace(namespaceFd, running) {
  if (running()) {
    await boundLifecycle(new Promise((resolve, reject) => {
      // The init can change user namespaces; derive ownership from the pinned PID namespace instead.
      // nsenter requires --target even with explicit FDs; no namespace is selected from that PID.
      const helper = spawn('/usr/bin/nsenter', ['--preserve-credentials', '--keep-caps',
        `--target=${process.pid}`, '--user-parent', '--user=/proc/self/fd/3', '--pid=/proc/self/fd/3',
        '--', process.execPath, '-e', 'process.kill(-1, "SIGKILL")'],
      { stdio: ['ignore', 'ignore', 'ignore', namespaceFd], env: {} });
      const timer = setTimeout(() => { helper.kill('SIGKILL'); reject(new Error()); }, 9_000);
      helper.once('error', error => { clearTimeout(timer); reject(error); });
      helper.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0 || code === 137 || signal === 'SIGKILL') resolve();
        else reject(new Error());
      });
    })).catch(error => {
      // The namespace init may exit after the liveness check but before nsenter starts.
      if (running()) throw error;
    });
    await boundLifecycle((async () => { while (running()) await new Promise(resolve => setTimeout(resolve, 10)); })());
  }
}

/** Owns one command and its kernel namespace handles, never a caller-selected signal target. */
export function startSandbox(input, stdio, workerUid) {
  const command = Object.freeze({ file: input.file, args: Object.freeze([...input.args]) });
  const commandDigest = 'sha256:' + createHash('sha256').update(JSON.stringify(command)).digest('hex');
  const streams = [...stdio]; streams[SANDBOX_STATUS_FD] = 'pipe';
  const child = spawn(command.file, command.args, { stdio: streams, env: {} });
  const handles = [];
  let closed = false, stopPromise, anchor, observed;
  const fault = code => new LaunchError(code, 'Sandbox lifecycle evidence is unconfirmed');
  const close = () => { closed = true; for (const fd of handles.splice(0)) closeSync(fd); };
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const stat = () => {
    const raw = readFileSync(anchor + '/stat', 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error();
    return { state: fields[0], parent: Number(fields[1]), start: fields[19] };
  };
  const running = () => {
    if (closed || !observed) throw new Error();
    try { const current = stat(); return current.start === observed.processStart && !['Z', 'X'].includes(current.state); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
  };
  const captured = boundLifecycle(new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const pipe = child.stdio[SANDBOX_STATUS_FD];
    pipe.on('data', chunk => {
      if (bytes.length + chunk.length > 4096) { pipe.destroy(); reject(new Error()); }
      else bytes = Buffer.concat([bytes, chunk]);
    });
    pipe.once('error', reject);
    child.once('error', reject);
    pipe.once('end', () => { try { resolve(JSON.parse(bytes.toString('utf8'))); } catch (error) { reject(error); } });
  })).then(info => {
    try {
      const pid = info['child-pid'];
      if (closed || !Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(workerUid) || workerUid < 0) throw new Error();
      handles.push(openSync('/proc/' + pid, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW));
      anchor = '/proc/self/fd/' + handles[0];
      const current = stat(), status = readFileSync(anchor + '/status', 'utf8');
      const field = name => status.match(new RegExp('^' + name + ':\\s*(.*)$', 'm'))?.[1].trim().split(/\s+/).map(Number);
      const uids = field('Uid'), pids = field('NSpid');
      if (current.parent !== child.pid || !uids || uids.length !== 4 || uids.some(uid => uid !== workerUid)
        || !pids || pids[0] !== pid || pids.length < 2 || pids.at(-1) !== 1) throw new Error();
      handles.push(openSync(anchor + '/ns/pid', fsConstants.O_RDONLY));
      const pidNamespace = readlinkSync('/proc/self/fd/' + handles[1]);
      if (pidNamespace === readlinkSync('/proc/self/ns/pid') || !/^pid:\[\d+\]$/.test(pidNamespace)
        || fstatSync(handles[1]).ino !== info['pid-namespace'] || stat().start !== current.start) throw new Error();
      observed = Object.freeze({ commandDigest, sandboxPid: pid, parentProcessId: child.pid,
        processStart: current.start, pidNamespace, uid: uids[0] });
      return observed;
    } catch { close(); throw fault('sandbox-observation-unverified'); }
  }).catch(() => { throw fault('sandbox-observation-unverified'); });
  // A normally completed short command may exit before /proc can be inspected; that is not readiness evidence.
  captured.catch(() => {});
  const observe = async () => {
    try { const result = await captured; if (!running()) throw new Error(); return result; }
    catch { throw fault('sandbox-observation-unverified'); }
  };
  const quiesce = () => stopPromise ??= (async () => {
    try {
      const observation = await captured;
      await quiesceNamespace(handles[1], running);
      // The trusted outer wrapper must also have exited; namespace death alone does not close its lifetime.
      await boundLifecycle(exited);
      if (running()) throw new Error();
      return Object.freeze({ status: 'terminated', observation });
    } catch { throw fault('sandbox-quiescence-unconfirmed'); }
    finally { close(); }
  })();
  return Object.freeze({ child, observe, quiesce, close });
}


/** Pins the trusted supervisor and borrows only the namespace handles it already owns. */
export function openSandboxControl(selector, rawArgv, workerUid) {
  const handles = [];
  let closed = false;
  const fault = () => new LaunchError('sandbox-control-unverified', 'Sandbox control evidence is unconfirmed');
  const close = () => { closed = true; for (const fd of handles.splice(0)) closeSync(fd); };
  const open = (file, flags) => { const fd = openSync(file, flags | fsConstants.O_CLOEXEC); handles.push(fd); return '/proc/self/fd/' + fd; };
  const stat = anchor => {
    const raw = readFileSync(anchor + '/stat', 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error();
    return { state: fields[0], parent: Number(fields[1]), start: fields[19] };
  };
  const status = anchor => {
    const raw = readFileSync(anchor + '/status', 'utf8');
    const field = name => raw.match(new RegExp('^' + name + ':\\s*(.*)$', 'm'))?.[1].trim().split(/\s+/).map(Number);
    return { uids: field('Uid'), pids: field('NSpid') };
  };
  const uidMatches = (anchor, uid) => {
    const uids = status(anchor).uids;
    return uids?.length === 4 && uids.every(value => value === uid);
  };
  try {
    if (!selector || Object.keys(selector).sort().join(',') !== 'processId,processStart'
      || !Number.isSafeInteger(selector.processId) || selector.processId <= 1
      || typeof selector.processStart !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(selector.processStart)
      || !Array.isArray(rawArgv) || rawArgv.length < 2 || rawArgv[0] !== process.execPath
      || rawArgv.some(value => typeof value !== 'string' || value.includes('\0'))
      || !Number.isSafeInteger(workerUid) || workerUid < 0) throw new Error();
    const argv = Object.freeze([...rawArgv]), encoded = Buffer.from(argv.join('\0') + '\0');
    const supervisor = Object.freeze({ ...selector });
    const root = open('/proc/' + supervisor.processId, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const checkSupervisor = () => {
      const current = stat(root);
      if (closed || current.start !== supervisor.processStart || ['Z', 'X'].includes(current.state)
        || !uidMatches(root, process.getuid()) || readlinkSync(root + '/exe') !== process.execPath
        || !readFileSync(root + '/cmdline').equals(encoded)) throw new Error();
    };
    checkSupervisor();
    const names = readdirSync(root + '/fd');
    if (names.length > 256) throw new Error();
    const entries = names.flatMap(name => {
      const source = root + '/fd/' + name;
      try { return [{ source, link: readlinkSync(source) }]; }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    });
    const processes = entries.filter(entry => /^\/proc\/[1-9]\d*$/.test(entry.link));
    const namespaces = entries.filter(entry => /^pid:\[\d+\]$/.test(entry.link));
    if (processes.length !== 1 || namespaces.length !== 1) throw new Error();
    // These are kernel descriptor links, deliberately followed only through the pinned supervisor.
    const sandbox = open(processes[0].source, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    const namespace = open(namespaces[0].source, fsConstants.O_RDONLY);
    const sandboxPid = Number(processes[0].link.slice('/proc/'.length)), initial = stat(sandbox);
    const pidNamespace = readlinkSync(namespace), pids = status(sandbox).pids;
    if (readlinkSync(sandbox) !== processes[0].link || pidNamespace !== namespaces[0].link
      || pidNamespace === readlinkSync('/proc/self/ns/pid') || readlinkSync(sandbox + '/ns/pid') !== pidNamespace
      || !uidMatches(sandbox, workerUid) || !pids || pids[0] !== sandboxPid || pids.length < 2 || pids.at(-1) !== 1
      || !Number.isSafeInteger(initial.parent) || initial.parent <= 1) throw new Error();
    const parent = open('/proc/' + initial.parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const parentInitial = stat(parent);
    if (parentInitial.parent !== supervisor.processId || !uidMatches(parent, workerUid)) throw new Error();
    const observation = Object.freeze({ schema: 'multi-agent-sandbox-control/v1', supervisor,
      commandDigest: 'sha256:' + createHash('sha256').update(JSON.stringify(argv)).digest('hex'),
      sandboxPid, parentProcessId: initial.parent, processStart: initial.start, pidNamespace, uid: workerUid });
    const observe = () => {
      try {
        checkSupervisor();
        const current = stat(sandbox), outer = stat(parent);
        if (current.start !== initial.start || current.parent !== initial.parent || ['Z', 'X'].includes(current.state)
          || outer.start !== parentInitial.start || outer.parent !== supervisor.processId || ['Z', 'X'].includes(outer.state)
          || !uidMatches(sandbox, workerUid) || !uidMatches(parent, workerUid)
          || readlinkSync(sandbox + '/ns/pid') !== pidNamespace) throw new Error();
        return observation;
      } catch { throw fault(); }
    };

    const alive = (anchor, start) => {
      if (closed) throw new Error();
      try { const value = stat(anchor); return value.start === start && !['Z', 'X'].includes(value.state); }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
    };
    let stopping;
    const quiesce = () => stopping ??= (async () => {
      try {
        if (closed) throw new Error();
        await quiesceNamespace(Number(namespace.slice('/proc/self/fd/'.length)), () => alive(sandbox, initial.start));
        await boundLifecycle((async () => {
          while (alive(parent, parentInitial.start) || alive(root, supervisor.processStart)) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        })());
        return Object.freeze({ status: 'terminated', observation });
      } catch { throw new LaunchError('sandbox-quiescence-unconfirmed', 'Sandbox quiescence is unconfirmed'); }
      finally { close(); }
    })();

    const snapshot = query => {
      const transient = [];
      const pin = (file, flags) => {
        const fd = openSync(file, flags | fsConstants.O_CLOEXEC); transient.push(fd); return '/proc/self/fd/' + fd;
      };
      try {
        observe();
        if (!query || Object.keys(query).sort().join(',') !== 'discoveryRoots,files,native'
          || !query.native || Object.keys(query.native).sort().join(',') !== 'processId,processStart'
          || !Number.isSafeInteger(query.native.processId) || query.native.processId <= 1
          || !/^(0|[1-9]\d{0,19})$/.test(query.native.processStart)
          || !Array.isArray(query.files) || query.files.length > 256
          || !Array.isArray(query.discoveryRoots) || query.discoveryRoots.length > 32) throw new Error();
        const policyAliases = Object.values(NATIVE_POLICY_MOUNTS).map(mount => mount.target);
        const allowed = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0')
          && posix.normalize(value) === value && (value === '/context' || value.startsWith('/context/')
            || value === '/framework' || value.startsWith('/framework/'));
        if (new Set(query.files).size !== query.files.length || new Set(query.discoveryRoots).size !== query.discoveryRoots.length
          || query.files.some(file => !allowed(file) && !policyAliases.includes(file))
          || query.discoveryRoots.some(root => !allowed(root))) throw new Error();
        const native = pin('/proc/' + query.native.processId, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        const initialNative = stat(native);
        if (initialNative.start !== query.native.processStart || ['Z', 'X'].includes(initialNative.state)
          || !uidMatches(native, workerUid) || readlinkSync(native + '/ns/pid') !== pidNamespace) throw new Error();
        const bounded = (file, limit) => {
          const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_CLOEXEC);
          try {
            const buffer = Buffer.alloc(limit + 1), length = readSync(fd, buffer, 0, buffer.length, 0);
            if (length > limit) throw new Error();
            return buffer.subarray(0, length);
          } finally { closeSync(fd); }
        };
        // Pin each component so a pathname replacement cannot redirect a privileged read.
        const rootPath = file => {
          let current = pin(native + '/root', fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
          const parts = file.slice(1).split('/');
          for (const [index, part] of parts.entries()) {
            current = pin(current + '/' + part, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
              | (index < parts.length - 1 ? fsConstants.O_DIRECTORY : 0));
          }
          return current;
        };
        const files = query.files.map(file => {
          const source = rootPath(file), before = statSync(source);
          if (!before.isFile() || before.size > 8 * 1024 * 1024) throw new Error();
          const bytes = bounded(source, 8 * 1024 * 1024), after = statSync(source);
          if (before.dev !== after.dev || before.ino !== after.ino || before.size !== bytes.length
            || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error();
          return { path: file, hash: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
        });
        const discoveryRoots = query.discoveryRoots.map(root => {
          if (!statSync(rootPath(root)).isDirectory()) throw new Error();
          return root;
        });
        const rawStatus = bounded(native + '/status', 65_536).toString('utf8');
        const field = name => rawStatus.match(new RegExp('^' + name + ':\\s*(.*)$', 'm'))?.[1].trim();
        const numbers = name => (field(name) ?? '').split(/\s+/).filter(Boolean).map(Number);
        const argvBytes = bounded(native + '/cmdline', 65_536);
        if (!argvBytes.length || argvBytes.at(-1) !== 0) throw new Error();
        const env = Object.fromEntries(bounded(native + '/environ', 65_536).toString('utf8').split('\0')
          .filter(value => /^(HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|DISABLE_AUTOUPDATER)=/.test(value))
          .map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)]; }));
        const stdio = [0, 1, 2].map(fd => {
          const source = native + '/fd/' + fd, st = statSync(source), link = readlinkSync(source);
          const kind = st.isDirectory() ? 'directory' : st.isSocket() ? 'socket' : st.isFIFO() ? 'pipe'
            : /^\/dev\/(?:pts\/|tty)/.test(link) ? 'tty' : 'file';
          return { fd, kind };
        });
        const sessionIds = new Set();
        for (const entry of readdirSync(native + '/fd')) {
          if (!/^\d+$/.test(entry)) throw new Error();
          let source;
          try { source = readlinkSync(native + '/fd/' + entry); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!/^\/home\/worker\/\.codex\/sessions\/.*\.jsonl$/.test(source)) continue;
          const fd = openSync(native + '/fd/' + entry, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_CLOEXEC);
          try {
            const pinned = '/proc/self/fd/' + fd;
            if (readlinkSync(pinned) !== source || !statSync(pinned).isFile()) throw new Error();
            const buffer = Buffer.alloc(65_536), length = readSync(fd, buffer, 0, buffer.length, 0);
            const first = buffer.subarray(0, length).toString('utf8').split('\n')[0];
            const record = JSON.parse(first);
            if (record.type === 'session_meta' && typeof record.payload?.id === 'string'
              && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.payload.id)) sessionIds.add(record.payload.id);
          } finally { closeSync(fd); }
        }
        const rawStat = bounded(native + '/stat', 65_536).toString('utf8');
        const fields = rawStat.slice(rawStat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const result = { process: { processId: query.native.processId, processStart: initialNative.start,
          processGroupId: Number(fields[2]), namespacePids: numbers('NSpid'), uids: numbers('Uid'), groups: numbers('Groups'),
          capabilities: field('CapEff'), noNewPrivileges: field('NoNewPrivs'), argv: argvBytes.toString('utf8').slice(0, -1).split('\0'),
          executable: readlinkSync(native + '/exe'), cwd: readlinkSync(native + '/cwd'), environment: env,
          mountNamespace: readlinkSync(native + '/ns/mnt'), userNamespace: readlinkSync(native + '/ns/user'),
          networkNamespace: readlinkSync(native + '/ns/net'), pidNamespace },
          mountInfo: bounded(native + '/mountinfo', 1_048_576).toString('utf8'), stdio, files, discoveryRoots,
          nativeSessionIds: [...sessionIds] };
        observe();
        if (stat(native).start !== initialNative.start || !uidMatches(native, workerUid)
          || readlinkSync(native + '/ns/pid') !== pidNamespace) throw new Error();
        return Object.freeze(result);
      } catch { throw fault(); }
      finally { for (const fd of transient.reverse()) closeSync(fd); }
    };

    observe();
    return Object.freeze({ observe, snapshot, quiesce, close });
  } catch { close(); throw fault(); }
}

/** Control operations do not require still-mounted sources: cancellation must remain stoppable. */
export async function controlSandbox(policy, argv, facts, snapshotQuery) {
  validatePolicy(policy);
  assertLaunchCaller(policy, facts);
  let control;
  try {
    const selector = /^([1-9]\d{0,9}):(0|[1-9]\d{0,19})$/.exec(argv[1] ?? '');
    if (!['--observe', '--quiesce'].includes(argv[0]) || !selector) throw new Error();
    const request = parseLaunchArgs(argv.slice(2)), worker = facts.lookupUser(request.worker);
    if (!policy.worker_identities.includes(request.worker) || !worker || worker.uid <= 0
      || worker.uid === facts.lookupUser(policy.control_identity)?.uid) throw new Error();
    control = openSandboxControl({ processId: Number(selector[1]), processStart: selector[2] },
      [process.execPath, policy.paths.installed_launcher, '--supervise', ...argv.slice(2)], worker.uid);
    if (argv[0] === '--quiesce') return await control.quiesce();
    const observation = control.observe();
    return snapshotQuery === undefined ? observation : { ...observation, snapshot: control.snapshot(snapshotQuery) };
  } catch {
    throw new LaunchError(argv[0] === '--quiesce' ? 'sandbox-quiescence-unconfirmed' : 'sandbox-control-unverified',
      'Sandbox control evidence is unconfirmed');
  }
  finally { control?.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) throw new LaunchError('launcher-not-root', 'launcher must run as root via sudo');
    if (process.arch !== 'x64') throw new LaunchError('host-arch-unsupported', 'the seccomp program is defined for x86_64 only');
    assertSafeStdio(stdioKinds());
    const policyBytes = readFileSync(INSTALLED_POLICY);
    const policy = validatePolicy(JSON.parse(policyBytes.toString('utf8')));
    const inspect = argv[0] === '--inspect';
    const supervised = argv[0] === '--supervise';
    const facts = hostFacts(policy);
    facts.policyFingerprint = 'sha256:' + createHash('sha256').update(policyBytes).digest('hex');
    if (argv[0] === '--observe' || argv[0] === '--quiesce') {
      assertLaunchCaller(policy, facts);
      let query;
      if (argv[0] === '--observe' && !process.stdin.isTTY) {
        const chunks = []; let length = 0;
        for await (const chunk of process.stdin) {
          length += chunk.length;
          if (length > 65_536) throw new LaunchError('sandbox-control-unverified', 'Snapshot request exceeds its bound');
          chunks.push(chunk);
        }
        if (length) query = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      process.stdout.write(JSON.stringify(await controlSandbox(policy, argv, facts, query)) + '\n');
      return;
    }
    const request = parseLaunchArgs(inspect || supervised ? argv.slice(1) : argv);
    if (inspect) {
      process.stdout.write(JSON.stringify(inspectLaunchRequest(policy, request, facts)) + '\n');
      return;
    }
    const resolved = resolveLaunchRequest(policy, request, facts);
    const { file, args, mountSources } = buildSandboxCommand(policy, resolved, supervised);
    const workerDir = path.posix.join(policy.paths.worker_root, resolved.worker.name);
    const assignmentDir = path.posix.join(realpathSync(policy.paths.assignment_root), resolved.worker.name);
    const fds = [];
    fds[MOUNT_FD.home] = openVerifiedDirectory(mountSources.home, workerDir);
    fds[MOUNT_FD.scratch] = openVerifiedDirectory(mountSources.scratch, workerDir);
    fds[MOUNT_FD.tree] = openVerifiedDirectory(mountSources.tree, assignmentDir);
    fds[MOUNT_FD.context] = openVerifiedDirectory(mountSources.context, posix.join(policy.paths.context_root, resolved.worker.name));
    fds[MOUNT_FD.framework] = openVerifiedDirectory(mountSources.framework, posix.dirname(policy.paths.framework_dir));
    fds[SECCOMP_FD] = openSeccompProgram();
    if (resolved.mailbox) fds[MOUNT_FD.mailbox] = openVerifiedSource(resolved.mailbox);
    if (resolved.nativePolicy) fds[MOUNT_FD.nativePolicy] = openVerifiedSource(resolved.nativePolicy);
    if (resolved.bootstrap) fds[MOUNT_FD.bootstrap] = openVerifiedSource(resolved.bootstrap);
    const stdio = ['inherit', 'inherit', 'inherit', ...Array.from(fds.slice(3), fd => fd ?? 'ignore')];
    const lifecycle = supervised ? startSandbox({ file, args }, stdio, resolved.worker.uid) : null;
    const child = lifecycle?.child ?? spawn(file, args, { stdio, env: {} });
    for (const fd of fds.slice(3)) if (fd !== undefined) closeSync(fd);
    let quiescing = false;
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
      process.on(signal, () => {
        if (!lifecycle) { child.kill(signal); return; }
        if (quiescing) return;
        quiescing = true;
        lifecycle.quiesce().then(() => process.exit(128 + osConstants.signals[signal]), reportError);
      });
    }
    child.on('error', reportError);
    child.on('exit', (code, signal) => {
      if (quiescing) return;
      lifecycle?.close();
      process.exit(code ?? 128 + (osConstants.signals[signal] ?? 0));
    });
  } catch (err) {
    reportError(err);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
