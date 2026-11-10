// OPR.0.4.4.11 — the SHARED daemon-side hosts-registry read module (the P3/P4
// interface cell, pm-lead ruling c): P3 uses it for topology placement
// resolution + validation messages; P4's fan-out aggregation consumes the
// SAME module. Land once, here; P4 must not re-implement it.
//
// READ-ONLY FOREVER (arch ruling 3): the registry is operator-managed YAML at
// ~/.openrig/hosts.yaml; nothing in the daemon ever writes it. This module is
// a deliberate SEPARATE TWIN of the CLI's packages/cli/src/host-registry.ts
// schema + validation (incl. the at-most-one-bearer rule — bearer optional
// for a tokenless daemon, never both): the two copies are NOT unified, and
// any schema/validation change must land in BOTH twins together. They are
// held verdict-for-verdict in sync by
// packages/daemon/test/hosts-registry-parity.test.ts, the same discipline as
// the scope-audit CLI/daemon twins.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";

export * from "../host-identity/registry-schema.js";
import { validateHostRegistry, type HostEntry, type HostRegistry, type HostRegistryLoadResult, type HostResolution } from "../host-identity/registry-schema.js";

export function defaultHostRegistryPath(): string {
  return getDefaultOpenRigPath("hosts.yaml");
}

/** Load + validate the operator's hosts registry (read-only). Mirrors the CLI
 *  loader's error surfaces so operators see one vocabulary everywhere. */
export function loadHostRegistry(path: string = defaultHostRegistryPath()): HostRegistryLoadResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      error: `host registry not found at ${path}. Create it with a 'hosts:' array; transport: ssh (target + user) or http (url; optional bearer_env or bearer_file — omit both for a tokenless daemon).`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { ok: false, error: `failed to read host registry at ${path}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { ok: false, error: `failed to parse host registry YAML at ${path}: ${(err as Error).message}` };
  }
  return validateHostRegistry(parsed, path);
}

/** Resolve a host id for placement. Unknown id names the requested id and
 *  lists up to 10 known ids — the FR-4 per-entry validation message rides
 *  this (what/why/fix, before any launch attempt). */
export function resolveHost(registry: HostRegistry, id: string): HostResolution {
  // alias -> id -> transport. The human alias is the intentional handle, so an `id` match is tried
  // across the WHOLE registry before any join key — that tiebreak is defined rather than accidental,
  // even though a collision with a random self-id is near-impossible.
  //
  // DELIBERATE TWIN DIVERGENCE: the CLI twin's resolveHost additionally accepts sidecar-LEARNED
  // bindings (host-bindings.json) so a pasted reply hint ending in a learned self-id resolves at the
  // CLI edge. This daemon copy does NOT take that parameter, on purpose: it serves PLACEMENT, which
  // resolves operator-authored aliases from topology manifests, and the daemon never sees a 3-part
  // target (BR-1 — the CLI edge strips the host qualifier). Mirroring the learned-binding merge here
  // would be dead surface. If placement ever grows a self-id lookup, take the CLI twin's shape.
  const match = registry.hosts.find((h) => h.id === id)
    ?? registry.hosts.find((h) => h.hostId === id);
  if (match) return { ok: true, host: match };
  const knownIds = registry.hosts.map((h) => h.id).slice(0, 10);
  const idsHint = knownIds.length > 0
    ? ` Known host ids: ${knownIds.join(", ")}${registry.hosts.length > knownIds.length ? ` (+${registry.hosts.length - knownIds.length} more)` : ""}.`
    : " (registry is empty)";
  return {
    ok: false,
    error: `unknown host id '${id}'.${idsHint}`,
  };
}
