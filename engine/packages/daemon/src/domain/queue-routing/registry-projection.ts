import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadHumanRegistry } from "./human-registry.js";

export function registryProjection(home: string, text: (value: unknown) => string | null) {
  let registry: ReturnType<typeof loadHumanRegistry>;
  try { registry = loadHumanRegistry(home, { readOnly: true }); } catch { registry = { ok: false, error: "registry unavailable" }; }
  const browserKey = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  return {
    registry: { state: registry.ok ? "available" : "unavailable", path: text(join(home, "gateway", "humans")) },
    humans: registry.ok ? registry.entities.map((h) => ({
      browserKey: browserKey(h.entityId),
      entityId: text(h.entityId) ?? "[withheld]", address: text(h.address) ?? "[withheld]", displayName: text(h.displayName), class: h.class, away: h.prefs.away ?? null,
      deliveryClass: h.prefs.deliveryClass, availability: h.prefs.availability ?? (h.prefs.away ? "away" : "available"),
      bindings: h.connectorBindings.map((b) => ({ browserKey: browserKey(JSON.stringify([b.kind, b.connectorRef, b.role, b.handle ?? null])),
        kind: b.kind, ref: text(b.connectorRef), role: b.role, handle: text(b.handle), credentialReference: Boolean(b.secretsRef) })),
    })) : [],
  };
}
