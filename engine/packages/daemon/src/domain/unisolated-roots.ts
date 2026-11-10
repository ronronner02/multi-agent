import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { localFrameworkRoot } from "../integrations/framework/source.js";
import { assertPrivateDirectory, isWindows, processOwnerIds } from "./platform.js";

/**
 * MVP — the roots a managed worker uses when `workers.isolation: none`.
 *
 * The hardened path reads `/etc/multi-agent/worker-policy.json` because a privileged
 * launcher validates the same bytes before it mounts them. Nothing validates anything
 * here: the daemon itself creates the candidate tree and starts the client as its own
 * user, so these roots live in the daemon's own state directory and no host provisioning
 * is involved.
 *
 * They are shaped like the policy's so the producer, the runtime and the launcher take
 * one object either way: `assignment_root/<worker>/<runId>-<taskId>` is the candidate,
 * `context_root/<worker>/<runId>/<attemptId>` the projection, and the mailbox root sits
 * under the state home when its full socket path fits.
 */
export interface ManagedWorkerRoots {
  assignmentRoot: string;
  controlStateDir: string;
  worker: string;
  workerRoot: string;
  contextRoot: string;
  mailboxRoot: string;
  policyRevision: number;
  workerIdentities: string[];
  frameworkRoot: string;
  toolchainDir: string;
}

/** One worker name, fixed: an unisolated host has exactly one identity, the daemon's user. */
export const UNISOLATED_WORKER = "local";

/**
 * Policy revision 4: the last revision before the pinned native policy and the per-attempt
 * mailbox socket became mandatory. Both exist to keep a sandboxed worker from reaching the
 * host's own channel, and neither applies when the worker *is* the host user.
 */
const UNISOLATED_POLICY_REVISION = 4;

function localMailboxRoot(home: string): string {
  const preferred = join(home, "sock");
  // Windows has no AF_UNIX path limit to work around, no `/tmp`, and no uid: the mailbox stays in
  // the daemon's own state tree, and the only ownership fact this host can prove is that the
  // directory is a real one rather than a junction.
  if (isWindows()) {
    mkdirSync(preferred, { recursive: true });
    assertPrivateDirectory(preferred, processOwnerIds());
    return preferred;
  }
  const endpoint = join(preferred, UNISOLATED_WORKER, "0".repeat(36), "mailbox.sock");
  if (Buffer.byteLength(endpoint) < 108) return preferred;

  // Linux counts bytes, including the terminating NUL. TMPDIR can itself be the
  // deep profile, so use a short private root keyed to this user and profile.
  const ids = processOwnerIds();
  if (ids === null) throw new Error("Local mailbox root requires a process owner on this host");
  const key = createHash("sha256").update(home).digest("hex").slice(0, 24);
  const root = `/tmp/ma-${ids.uid}-${key}`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || realpathSync(root) !== root || stat.uid !== ids.uid
    || stat.gid !== ids.gid || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("Local mailbox root must be private and canonical");
  }
  return root;
}

/**
 * `home` is the daemon's per-user state directory (`$OPENRIG_HOME`).
 *
 * Setup installs the pinned workflow source per user. An explicit source override can
 * point to an existing verified package without copying it into each attempt.
 */
export function unisolatedWorkerRoots(home: string): ManagedWorkerRoots {
  const stateRoot = join(home, "state", "workers");
  const controlStateDir = join(stateRoot, "control");
  const roots: ManagedWorkerRoots = {
    assignmentRoot: join(stateRoot, "assignments"),
    controlStateDir,
    worker: UNISOLATED_WORKER,
    workerRoot: join(stateRoot, "homes"),
    contextRoot: join(stateRoot, "context"),
    mailboxRoot: localMailboxRoot(home),
    policyRevision: UNISOLATED_POLICY_REVISION,
    workerIdentities: [UNISOLATED_WORKER],
    frameworkRoot: localFrameworkRoot(home),
    toolchainDir: "",
  };
  // The producer creates the per-attempt directories itself, but its ancestry checks read
  // these anchors first, so they have to exist before the first attempt is produced. The
  // worker's home and scratch are anchors too: an attempt's manifest resolves both.
  for (const anchor of [join(roots.assignmentRoot, UNISOLATED_WORKER), join(roots.contextRoot, UNISOLATED_WORKER),
    join(roots.mailboxRoot, UNISOLATED_WORKER), join(roots.workerRoot, UNISOLATED_WORKER, "home"),
    join(roots.workerRoot, UNISOLATED_WORKER, "scratch"), roots.frameworkRoot]) {
    mkdirSync(anchor, { recursive: true, mode: 0o700 });
  }
  return roots;
}
