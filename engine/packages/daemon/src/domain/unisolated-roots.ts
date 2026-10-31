import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
 * under the control state directory.
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

/**
 * `home` is the daemon's per-user state directory (`$OPENRIG_HOME`).
 *
 * `frameworkRoot` is a directory this daemon owns rather than an installed tree: no
 * provisioning step runs here, and the projection only requires the path to exist and be
 * canonical once an attempt binds no framework entry.
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
    // An attempt's mailbox socket lives four path segments below this root, and an
    // attempt id alone is 36 bytes of a 108-byte AF_UNIX limit. The hardened path can
    // afford a deeper root because provisioning installs it at `/var/lib/...`; this one
    // sits under the user's home, so it is kept deliberately shallow.
    mailboxRoot: join(home, "sock"),
    policyRevision: UNISOLATED_POLICY_REVISION,
    workerIdentities: [UNISOLATED_WORKER],
    frameworkRoot: join(stateRoot, "framework"),
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
