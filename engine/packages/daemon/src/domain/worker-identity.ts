import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * T053 — the worker identity reader.
 *
 * The producer needs the worker's uid, gid, groups, home and scratch before an attempt
 * exists. Its only other source is the privileged `--inspect`, which requires an attempt
 * that already exists — the circularity that stopped T047 at intake. Provisioning installs
 * both the policy and the accounts, so reading them directly is the same fact the launcher
 * reads, not a weaker one: `worker-launch.mjs` `hostFacts.lookupUser` resolves a name from
 * `/etc/passwd` and `/etc/group` by exactly these rules.
 *
 * The launcher's own inspection stays the authoritative check at launch. This reader only
 * lets the producer write a projection and a mailbox with the ownership the launcher will
 * then require.
 */
export interface WorkerIdentityPolicy {
  /** `paths.worker_root`: the anchor of every worker's home and scratch. */
  workerRoot: string;
  /** `paths.assignment_root`: the anchor every assigned tree of that worker sits under. */
  assignmentRoot: string;
  /** `worker_identities`: the allow-list the policy installs. */
  identities: readonly string[];
}

export interface WorkerIdentity {
  name: string;
  uid: number;
  gid: number;
  /** Supplementary and primary group names, resolved the way the launcher resolves them. */
  groups: string[];
  /** The same groups as ids: the context manifest compares numeric modes against them. */
  groupIds: number[];
  home: string;
  scratch: string;
  /** The worker's assignment directory; a tree the launcher accepts must descend from it. */
  tree: string;
}

interface AccountRecord { name: string; uid: number; gid: number; groups: string[]; groupIds: number[] }

/** Parse one `:`-separated account database, exactly as the launcher does. */
function readDatabase(file: string): string[][] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => line.split(":"));
}

function lookupAccount(name: string, passwd: string[][], group: string[][]): AccountRecord | null {
  const row = passwd.find((entry) => entry[0] === name);
  if (!row) return null;
  const gid = Number(row[3]);
  const memberships = group.filter((entry) => Number(entry[2]) === gid || (entry[3] ?? "").split(",").includes(name));
  return { name, uid: Number(row[2]), gid, groups: memberships.map((entry) => entry[0]!),
    groupIds: [...new Set(memberships.map((entry) => Number(entry[2])))].filter((id) => Number.isSafeInteger(id) && id >= 0) };
}

/**
 * Resolve a provisioned worker, or refuse. A name the policy does not list, an account the
 * host does not have, and a privileged account are all refused: the first would let a
 * caller name an identity provisioning never created, and the last would hand the
 * projection to the control identity.
 */
export function resolveWorkerIdentity(policy: WorkerIdentityPolicy, name: string,
  read: (file: string) => string[][] = readDatabase): WorkerIdentity {
  if (!policy.identities.includes(name)) throw new Error("Worker identity is not in the installed policy");
  const account = lookupAccount(name, read("/etc/passwd"), read("/etc/group"));
  if (!account) throw new Error("Worker account is not provisioned");
  if (!Number.isSafeInteger(account.uid) || account.uid <= 0) throw new Error("Worker account is privileged");
  return {
    name, uid: account.uid, gid: account.gid, groups: account.groups, groupIds: account.groupIds,
    home: join(policy.workerRoot, name, "home"),
    scratch: join(policy.workerRoot, name, "scratch"),
    tree: join(policy.assignmentRoot, name),
  };
}

/** The composition handle startup injects; `resolveWorkerIdentity` stays the one owner. */
export class WorkerIdentities {
  /**
   * `currentUser` switches the reader to the daemon's own identity (`workers.isolation: none`).
   * That path never reads `/etc/passwd`: the worker *is* this process's user, so the kernel
   * facts it runs under are the ones to record, and no account has to exist on the host.
   */
  constructor(private readonly policy: () => WorkerIdentityPolicy,
    private readonly read: (file: string) => string[][] = readDatabase,
    private readonly currentUser = false) {}

  resolve(name: string): WorkerIdentity {
    const policy = this.policy();
    return this.currentUser ? currentUserIdentity(policy, name) : resolveWorkerIdentity(policy, name, this.read);
  }
}

/**
 * The daemon's own identity, shaped like a provisioned worker's.
 *
 * `groups` is empty for the same reason the hardened control reports it empty: the launcher
 * starts the client with its supplementary groups cleared, so the projection is checked
 * against the groups the process will actually carry.
 */
function currentUserIdentity(policy: WorkerIdentityPolicy, name: string): WorkerIdentity {
  if (!policy.identities.includes(name)) throw new Error("Worker identity is not in the installed policy");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  if (uid === null || gid === null) {
    // Windows has no POSIX user ids. The unisolated worker is still the daemon's own user,
    // so what matters is that the folder the daemon owns and the candidate is in is the one
    // that controls the assignment root, not what number Node.js returns for the process.
    return { name, uid: -1, gid: -1, groups: [], groupIds: [],
      home: join(policy.workerRoot, name, "home"),
      scratch: join(policy.workerRoot, name, "scratch"),
      tree: join(policy.assignmentRoot, name) };
  }
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("Worker account is privileged");
  return { name, uid, gid, groups: [], groupIds: [gid],
    home: join(policy.workerRoot, name, "home"),
    scratch: join(policy.workerRoot, name, "scratch"),
    tree: join(policy.assignmentRoot, name) };
}
