import { createHash, randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import { hostPlatform, type HostPlatform } from "./platform.js";

/**
 * The one place a managed mailbox's transport endpoint is named.
 *
 * On POSIX an attempt's mailbox is a Unix socket file inside its control-private mailbox
 * directory: the launcher pins it by dev/ino and owner, the bridge chmods it, and a stale file
 * left by a daemon that died is unlinked before rebinding. Windows has no AF_UNIX — `net.Server`
 * there accepts only a named pipe, and any filesystem path fails with `EACCES` — so the same
 * attempt binds a named pipe instead. A pipe has no file to stat, chmod or unlink, and it stops
 * existing when the server that created it closes.
 *
 * Both transports keep the private `bootstrap.json` in the same mailbox directory, so only the
 * endpoint itself differs between them.
 */
export const MAILBOX_SOCKET_NAME = "mailbox.sock";
export const MAILBOX_BOOTSTRAP_NAME = "bootstrap.json";

/**
 * The local pipe namespace. A Windows pipe name is machine-wide: every process on the host can
 * open it by name, and a name that is already served is refused rather than shared.
 */
export const MAILBOX_PIPE_PREFIX = "\\\\.\\pipe\\multi-agent-mailbox-";

/** What a caller derives from one mailbox directory and one bridge generation. */
export interface MailboxEndpointDescriptor {
  transport: "unix" | "pipe";
  /** The connect target, verbatim: a filesystem path, or `\\.\pipe\<name>`. */
  path: string;
  /** The private bootstrap the endpoint's worker reads. */
  bootstrapPath: string;
}

/**
 * The endpoint a bridge answers on: a socket file with the file identity the launcher pins, or
 * a pipe that has only its name.
 */
export type MailboxEndpoint =
  | Readonly<{ transport: "unix"; path: string; dev: number; ino: number; uid: number; gid: number; generation: string }>
  | Readonly<{ transport: "pipe"; path: string; generation: string }>;

/** The POSIX socket identity of a Unix endpoint, or null when this endpoint has none. */
export function socketIdentity(endpoint: MailboxEndpoint | null | undefined):
  { dev: number; ino: number; uid: number; gid: number } | null {
  return endpoint && endpoint.transport === "unix"
    ? { dev: endpoint.dev, ino: endpoint.ino, uid: endpoint.uid, gid: endpoint.gid }
    : null;
}

/**
 * One per daemon process, never written anywhere.
 *
 * The generation already makes each attempt's name unique. The salt additionally makes the name
 * unguessable to anything that can read an attempt's directory and generation but does not share
 * this process's memory, and it keeps two daemons reusing one state tree from ever naming one
 * pipe.
 */
const DAEMON_SALT = randomBytes(32);

/** The endpoint one mailbox directory serves, for the generation the bridge answers to. */
export function mailboxEndpoint(directory: string, generation: string, platform: HostPlatform = hostPlatform()):
  MailboxEndpointDescriptor {
  // Each branch names its own platform's separators, so a Windows-format directory derives a
  // Windows-format path even while a test drives this branch from another host.
  const separator = platform === "posix" ? posix : win32;
  const bootstrapPath = separator.join(directory, MAILBOX_BOOTSTRAP_NAME);
  if (platform === "posix") {
    return { transport: "unix", path: separator.join(directory, MAILBOX_SOCKET_NAME), bootstrapPath };
  }
  // Windows compares paths case-insensitively and accepts either separator, so two spellings of
  // one directory must derive one name. Nothing is read from disk: the endpoint is named before
  // its directory exists in some callers, and the derivation must not depend on the disk.
  const key = win32.resolve(directory).replace(/\\/g, "/").toLowerCase();
  const digest = createHash("sha256").update(DAEMON_SALT).update("\0").update(key)
    .update("\0").update(generation).digest("hex");
  return { transport: "pipe", path: MAILBOX_PIPE_PREFIX + digest.slice(0, 32), bootstrapPath };
}

/**
 * The privileged launcher's mailbox fact: the socket file at the policy's `mailbox_root` for this
 * worker, run and attempt, owned by the control user and pinned by dev/ino.
 *
 * A pipe endpoint can never satisfy it, and must not be compared as though a pipe path were a
 * socket path. That refusal is the Windows answer rather than a gap: the launcher mounts a Unix
 * socket and is composed only where the worker is a separate account under a sandbox, while a
 * Windows host launches through the direct unisolated path.
 */
export function admitsPosixMailboxEndpoint(endpoint: MailboxEndpoint | null | undefined,
  input: { mailboxRoot?: string; worker: string; runId: string; attemptId: string; controlUid: number; controlGid?: number }):
  endpoint is Extract<MailboxEndpoint, { transport: "unix" }> {
  if (!endpoint || endpoint.transport !== "unix" || input.mailboxRoot === undefined) return false;
  return endpoint.path === input.mailboxRoot + "/" + input.worker + "/" + input.runId + "/" + input.attemptId
      + "/" + MAILBOX_SOCKET_NAME
    && Number.isSafeInteger(input.controlUid) && input.controlUid >= 0
    && Number.isSafeInteger(input.controlGid) && (input.controlGid ?? -1) >= 0
    && endpoint.uid === input.controlUid && endpoint.gid === input.controlGid
    && Number.isSafeInteger(endpoint.dev) && endpoint.dev >= 0
    && Number.isSafeInteger(endpoint.ino) && endpoint.ino > 0
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(endpoint.generation);
}