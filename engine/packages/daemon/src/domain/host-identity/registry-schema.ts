import { VIRTUAL_DOMAIN_TOKENS } from "../session-name.js";

export interface SshHostEntry {
  id: string;
  /**
   * The observed, immutable self-id of the host this entry points at — the JOIN KEY.
   *
   * `id` is MY label for that machine; `hostId` is what that machine calls itself and stamps into
   * every envelope it sends. Optional because every entry that exists today predates the field:
   * absent means "never learned", which resolves exactly as it does now. Nothing populates this
   * automatically in this slice.
   */
  hostId?: string;
  transport: "ssh";
  target: string;
  user?: string;
  notes?: string;
}

export interface HttpHostEntry {
  id: string;
  /** The observed self-id of the host this entry points at — the join key. See SshHostEntry.hostId. */
  hostId?: string;
  transport: "http";
  url: string;
  bearer_env?: string;
  bearer_file?: string;
  notes?: string;
}

export type HostEntry = SshHostEntry | HttpHostEntry;

export interface HostRegistry {
  hosts: HostEntry[];
}

export type HostRegistryLoadResult =
  | { ok: true; registry: HostRegistry }
  | { ok: false; error: string };

export type HostResolution =
  | { ok: true; host: HostEntry }
  | { ok: false; error: string };

// OPR.0.4.6.MH1 FR-7 — reserved host ids, MIRRORED verbatim from the
// CLI twin (packages/cli/src/host-registry.ts RESERVED_HOST_IDS; the
// parity test pins both). See the CLI twin for the collision rationale.
// M1 A1: the virtual-domain tokens (VIRTUAL_DOMAIN_TOKENS, the A2 closed set) are
// reserved too — a host named `external` would collide with the @external classifier.
export const RESERVED_HOST_IDS = new Set(["kernel", "host", "local", ...VIRTUAL_DOMAIN_TOKENS]);

const KNOWN_TRANSPORTS = new Set(["ssh", "http"]);

export function validateHostRegistry(parsed: unknown, sourcePath: string): HostRegistryLoadResult {
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: `host registry at ${sourcePath} must be a YAML object with a 'hosts' array` };
  }
  const obj = parsed as Record<string, unknown>;
  const hosts = obj["hosts"];
  if (!Array.isArray(hosts)) {
    return { ok: false, error: `host registry at ${sourcePath}: 'hosts' must be an array` };
  }

  const seenIds = new Set<string>();
  const validated: HostEntry[] = [];
  for (let i = 0; i < hosts.length; i++) {
    const raw = hosts[i];
    const prefix = `host registry at ${sourcePath}: hosts[${i}]`;
    if (raw === null || typeof raw !== "object") {
      return { ok: false, error: `${prefix}: must be an object with id/transport/target` };
    }
    const entry = raw as Record<string, unknown>;
    const id = entry["id"];
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: `${prefix}.id: required non-empty string` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `${prefix}.id: duplicate host id '${id}' (each host id must be unique within the registry)` };
    }
    if (RESERVED_HOST_IDS.has(id)) {
      return {
        ok: false,
        error: `${prefix}.id: '${id}' is a reserved host id (reserved set: ${[...RESERVED_HOST_IDS].sort().join(", ")}). 'kernel' and 'host' collide with human-seat session classification (@kernel/@host), and 'local' is the local host itself — pick a different id.`,
      };
    }
    // OPR.0.4.6.MH1 rev1-r2 B1 — host ids name FILES (the pair verb's
    // bearer_file path embeds the id) and render in tables: path-bearing
    // ids are rejected at the registry door, same home as reserved ids.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      return {
        ok: false,
        error: `${prefix}.id: '${id}' is not a valid host id — allowed: letters, digits, dot, underscore, dash (starting with a letter or digit). Host ids name credential files; path characters are not allowed.`,
      };
    }
    seenIds.add(id);
    const transport = entry["transport"];
    if (typeof transport !== "string" || !KNOWN_TRANSPORTS.has(transport)) {
      return {
        ok: false,
        error: `${prefix}.transport: must be one of ${[...KNOWN_TRANSPORTS].sort().join(", ")} (got ${JSON.stringify(transport)})`,
      };
    }
    const notes = entry["notes"];
    if (notes !== undefined && typeof notes !== "string") {
      return { ok: false, error: `${prefix}.notes: optional, but if present must be a string` };
    }
    // The join key is an id like any other, so it earns the SAME rules `id` already has — it can
    // reach a table and a path just as easily. The generated `host-XXXXXXXX` form passes them.
    const hostId = entry["hostId"];
    if (hostId !== undefined) {
      if (typeof hostId !== "string" || hostId.trim() === "") {
        return { ok: false, error: `${prefix}.hostId: optional, but if present must be a non-empty string` };
      }
      if (RESERVED_HOST_IDS.has(hostId)) {
        return {
          ok: false,
          error: `${prefix}.hostId: '${hostId}' is a reserved host id (reserved set: ${[...RESERVED_HOST_IDS].sort().join(", ")}) — a join key names a real machine's own identity and can never be one of these.`,
        };
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostId)) {
        return {
          ok: false,
          error: `${prefix}.hostId: '${hostId}' is not a valid host id — allowed: letters, digits, dot, underscore, dash (starting with a letter or digit).`,
        };
      }
    }

    if (transport === "ssh") {
      const target = entry["target"];
      if (typeof target !== "string" || target.trim() === "") {
        return { ok: false, error: `${prefix}.target: required non-empty string (an ssh target)` };
      }
      const user = entry["user"];
      if (user !== undefined && (typeof user !== "string" || user.trim() === "")) {
        return { ok: false, error: `${prefix}.user: optional, but if present must be a non-empty string` };
      }
      validated.push({
        id,
        ...(hostId !== undefined ? { hostId: hostId as string } : {}),
        transport: "ssh",
        target,
        ...(user !== undefined ? { user: user as string } : {}),
        ...(notes !== undefined ? { notes: notes as string } : {}),
      });
    } else if (transport === "http") {
      const url = entry["url"];
      if (typeof url !== "string" || url.trim() === "") {
        return { ok: false, error: `${prefix}.url: required non-empty string (the remote daemon's base URL)` };
      }
      const bearerEnv = entry["bearer_env"];
      const bearerFile = entry["bearer_file"];
      const hasEnv = bearerEnv !== undefined;
      const hasFile = bearerFile !== undefined;
      // bearer_env / bearer_file are OPTIONAL: omit both for an
      // anonymous/tokenless daemon (no Authorization sent). At most one may
      // be set — never both. MIRRORS the CLI twin (host-registry.ts).
      if (hasEnv && hasFile) {
        return { ok: false, error: `${prefix}: specify at most one of bearer_env or bearer_file, not both (omit both for an anonymous/tokenless daemon)` };
      }
      if (hasEnv && (typeof bearerEnv !== "string" || bearerEnv.trim() === "")) {
        return { ok: false, error: `${prefix}.bearer_env: must be a non-empty env var name` };
      }
      if (hasFile && (typeof bearerFile !== "string" || bearerFile.trim() === "")) {
        return { ok: false, error: `${prefix}.bearer_file: must be a non-empty file path` };
      }
      validated.push({
        id,
        ...(hostId !== undefined ? { hostId: hostId as string } : {}),
        transport: "http",
        url: url as string,
        ...(hasEnv ? { bearer_env: bearerEnv as string } : {}),
        ...(hasFile ? { bearer_file: bearerFile as string } : {}),
        ...(notes !== undefined ? { notes: notes as string } : {}),
      });
    }
  }
  return { ok: true, registry: { hosts: validated } };
}

