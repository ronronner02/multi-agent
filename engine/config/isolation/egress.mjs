// Worker egress filter (KTD23).
//
// `serve` runs on the control side as the egress identity under systemd. It
// listens on a unix socket that the launcher binds read-only into every worker
// sandbox and accepts only HTTP CONNECT to an exact host:port allow-list,
// forwarding through the configured upstream proxy, or directly when none is
// set. `relay` runs inside the sandbox, whose network namespace holds only
// loopback: it exposes that socket as a loopback proxy port, then runs the
// command. The relay grants nothing; the allow-list is enforced in `serve`.

import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import { chmodSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import os, { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';

export const EGRESS_SCHEMA = 'multi-agent-egress/v1';
export const EGRESS_SOCKET_NAME = 'proxy.sock';
const MAX_HEAD_BYTES = 8192;
const HEAD_TIMEOUT_MS = 10_000;
// A DNS name with at least one dot, so overlay short names such as MagicDNS hosts never match.
const HOST_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export class EgressError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EgressError';
    this.code = code;
  }
}

/** `host:port` with a lower-case DNS name (never an IP literal) and a port 1-65535, or null. */
export function parseTarget(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^([^:\s/@[\]]+):(\d{1,5})$/);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/\.$/, '');
  const port = Number(m[2]);
  if (!HOST_PATTERN.test(host) || /^\d+$/.test(host.slice(host.lastIndexOf('.') + 1))) return null;
  if (port < 1 || port > 65535) return null;
  return { host, port, key: `${host}:${port}` };
}

export function validateEgressConfig(config) {
  const fail = (message) => {
    throw new EgressError('egress-config-invalid', message);
  };
  if (!config || config.schema !== EGRESS_SCHEMA) fail('unsupported egress schema');
  if (!Array.isArray(config.allow) || config.allow.length === 0) fail('allow must be a non-empty list');
  const allow = new Set();
  for (const entry of config.allow) {
    const target = parseTarget(entry);
    if (!target || target.key !== entry) fail(`invalid allow entry ${JSON.stringify(entry)}`);
    allow.add(target.key);
  }
  let upstream = null;
  if (config.upstream !== null && config.upstream !== undefined) {
    let url = null;
    try {
      url = new URL(config.upstream);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'http:' || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash || !url.port) {
      fail('upstream must be http://host:port with no credentials or path');
    }
    upstream = { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) };
  }
  return { allow, upstream };
}

const DENY_LIST = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) DENY_LIST.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  // IPv4-compatible, NAT64 and 6to4 forms can carry any IPv4 address; site-local, ULA, link-local and multicast.
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) DENY_LIST.addSubnet(prefix, bits, 'ipv6');
DENY_LIST.addAddress('::1', 'ipv6');

/**
 * Addresses a directly resolved name must never reach: loopback, private,
 * link-local, overlay, benchmark, multicast and IPv4-embedding ranges, plus any
 * address bound on this host.
 */
export function isDeniedAddress(address, localAddresses = []) {
  if (localAddresses.includes(address)) return true;
  if (net.isIPv4(address)) return DENY_LIST.check(address, 'ipv4');
  if (net.isIPv6(address)) {
    const v = address.toLowerCase();
    if (v.startsWith('::ffff:')) return isDeniedAddress(v.slice(7), localAddresses) || DENY_LIST.check(v, 'ipv6');
    return DENY_LIST.check(v, 'ipv6');
  }
  return true;
}

function localInterfaceAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address.toLowerCase().replace(/%.*$/, ''));
}

export function parseConnectRequest(head) {
  const line = head.split('\r\n', 1)[0];
  const m = line.match(/^CONNECT (\S+) HTTP\/1\.[01]$/);
  if (!m) return { status: 405 };
  const target = parseTarget(m[1]);
  return target ? { target } : { status: 403 };
}

function readHead(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new EgressError('egress-timeout', 'request head timed out')), timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) finish(null, { head: buf.subarray(0, end).toString('latin1'), rest: buf.subarray(end + 4) });
      else if (buf.length > MAX_HEAD_BYTES) finish(new EgressError('egress-head-too-large', 'request head too large'));
    };
    const onEnd = () => finish(new EgressError('egress-closed', 'closed before the request head ended'));
    function finish(err, value) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      socket.pause();
      if (err) reject(err);
      else resolve(value);
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onEnd);
  });
}

const REASONS = { 403: 'Forbidden', 405: 'Method Not Allowed', 502: 'Bad Gateway' };

export function createEgressServer(config, {
  log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
  lookup = (host) => dns.lookup(host, { all: true }),
  // Read only in direct mode; it needs a netlink socket. A failure there refuses the tunnel.
  localAddresses = null,
  // One shared filter serves every worker; bound its connections and idle tunnels.
  maxConnections = 256,
  idleTimeoutMs = 600_000,
} = {}) {
  const { allow, upstream } = validateEgressConfig(config);

  const open = (host, port) => new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, allowHalfOpen: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new EgressError('egress-connect-timeout', 'connect timed out'));
    }, HEAD_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  async function viaUpstream(target) {
    const socket = await open(upstream.host, upstream.port);
    socket.write(`CONNECT ${target.key} HTTP/1.1\r\nHost: ${target.key}\r\n\r\n`);
    try {
      const { head, rest } = await readHead(socket, HEAD_TIMEOUT_MS);
      if (!/^HTTP\/1\.[01] 200\b/.test(head)) throw new EgressError('egress-upstream-refused', 'upstream refused the tunnel');
      return { socket, rest };
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  async function direct(target) {
    const addresses = await lookup(target.host);
    const local = localAddresses ?? localInterfaceAddresses();
    if (addresses.length === 0 || addresses.some((a) => isDeniedAddress(a.address, local))) {
      throw new EgressError('egress-address-denied', 'name resolves to a denied address');
    }
    return { socket: await open(addresses[0].address, target.port), rest: null };
  }

  const reply = (client, status) => {
    // A rejected half-open peer must not retain a shared connection slot.
    const timer = setTimeout(() => client.destroy(), 100);
    timer.unref();
    client.once('close', () => clearTimeout(timer));
    client.end(`HTTP/1.1 ${status} ${REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  async function handle(client) {
    let request;
    try {
      request = await readHead(client, HEAD_TIMEOUT_MS);
    } catch {
      client.destroy();
      return;
    }
    const parsed = parseConnectRequest(request.head);
    if (parsed.status) {
      // The raw request is untrusted; only the decision is logged.
      log({ decision: 'deny', reason: parsed.status === 405 ? 'not-connect' : 'invalid-target' });
      reply(client, parsed.status);
      return;
    }
    const { target } = parsed;
    if (!allow.has(target.key)) {
      log({ decision: 'deny', reason: 'not-allowed', target: target.key });
      reply(client, 403);
      return;
    }
    let remote;
    try {
      remote = upstream ? await viaUpstream(target) : await direct(target);
    } catch (err) {
      log({ decision: 'error', reason: err.code ?? 'connect-failed', target: target.key });
      reply(client, 502);
      return;
    }
    // The client may have gone while the upstream answered.
    if (client.destroyed) {
      remote.socket.destroy();
      return;
    }
    log({ decision: 'allow', target: target.key });
    // pipe() carries each direction's end; only an error or a fully closed client tears the pair down.
    remote.socket.on('error', () => client.destroy());
    client.on('close', () => remote.socket.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (request.rest.length) remote.socket.write(request.rest);
    if (remote.rest?.length) client.write(remote.rest);
    for (const s of [client, remote.socket]) {
      s.setTimeout(idleTimeoutMs, () => {
        client.destroy();
        remote.socket.destroy();
      });
    }
    client.pipe(remote.socket);
    remote.socket.pipe(client);
  }

  // Half-open: a client that ends its upload still receives the reply.
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    server.clients.add(client);
    client.on('close', () => server.clients.delete(client));
    client.on('error', () => client.destroy());
    handle(client).catch(() => client.destroy());
  });
  server.clients = new Set();
  server.maxConnections = maxConnections;
  return server;
}

async function serve([socketPath, configPath, ...extra]) {
  if (!socketPath || !configPath || extra.length) throw new EgressError('egress-usage', 'usage: egress.mjs serve <socket> <config>');
  const server = createEgressServer(JSON.parse(readFileSync(configPath, 'utf8')));
  rmSync(socketPath, { force: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  // Every sandbox uid connects; the allow-list, not the socket mode, is the control.
  chmodSync(socketPath, 0o666);
  process.stdout.write(`${JSON.stringify({ ready: socketPath })}\n`);
  // Stop promptly: open tunnels are cut, and clients reconnect to the restarted filter.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      for (const c of server.clients) c.destroy();
    });
  }
}

async function relay(argv) {
  const sep = argv.indexOf('--');
  const [portArg, socketPath, ...options] = argv.slice(0, Math.max(sep, 0));
  const command = argv.slice(sep + 1);
  // The gateway bearer reaches the client here and nowhere else: the launcher mounts it as a 0400
  // file and names that file, so no process command line carries the value.
  let envFile;
  for (let i = 0; i < options.length; i += 1) {
    if (options[i] === '--env-file' && envFile === undefined && options[i + 1] !== undefined && options[i + 1] !== '--') {
      envFile = options[i + 1];
      i += 1;
    } else throw new EgressError('egress-usage', 'usage: egress.mjs relay <port> <socket> [--env-file <path>] -- <command...>');
  }
  if (sep !== 2 + (envFile === undefined ? 0 : 2) || !/^\d{1,5}$/.test(portArg ?? '') || !socketPath || command.length === 0) {
    throw new EgressError('egress-usage', 'usage: egress.mjs relay <port> <socket> [--env-file <path>] -- <command...>');
  }
  let env = process.env;
  if (envFile !== undefined) {
    // Fail closed: a client launched on a verified gateway must not start without its credential.
    let raw;
    try { raw = readFileSync(envFile, 'utf8'); } catch { throw new EgressError('egress-env-missing', 'the gateway environment file is unavailable'); }
    env = { ...process.env };
    for (const line of raw.split('\n').filter(Boolean)) {
      const eq = line.indexOf('=');
      if (eq <= 0 || !/^[A-Z][A-Z0-9_]{0,63}$/.test(line.slice(0, eq))) throw new EgressError('egress-env-invalid', 'the gateway environment file is malformed');
      env[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  const server = net.createServer({ allowHalfOpen: true }, (local) => {
    const up = net.connect({ path: socketPath, allowHalfOpen: true });
    local.on('error', () => up.destroy());
    up.on('error', () => local.destroy());
    local.pipe(up);
    up.pipe(local);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(portArg), '127.0.0.1', resolve);
  });
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });
  // The terminal already delivers keyboard signals to the child's process group;
  // forwarding them again would double them (two ^C exits an interactive client).
  for (const signal of ['SIGINT', 'SIGQUIT']) process.on(signal, () => {});
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (err) => {
    process.stderr.write(`${JSON.stringify({ egress_error: 'egress-command-failed', message: err.code ?? err.message })}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? 128 + (osConstants.signals[signal] ?? 0)));
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  try {
    if (mode === 'serve') await serve(rest);
    else if (mode === 'relay') await relay(rest);
    else throw new EgressError('egress-usage', 'usage: egress.mjs serve <socket> <config> | relay <port> <socket> [--env-file <path>] -- <command...>');
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ egress_error: err instanceof EgressError ? err.code : 'egress-internal', message: err.message })}\n`);
    process.exit(126);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
