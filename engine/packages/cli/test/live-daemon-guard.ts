// Hermeticity GUARD — the WRITE-direction sibling of the gate's hermetic checker.
//
// The gate's hermetic checker guards the GATE's dependency root + verdict freshness.
// This guards the TEST PROCESS from live daemon routing: a cli test must not be able
// to reach the LIVE daemon by default STATE_FILE discovery (MULTI_AGENT_HOME/daemon.json),
// because an unscoped WRITE (e.g. `multi-agent broadcast`) would leak into the live topology —
// strictly worse than a READ, which only pollutes the caller's own results.
//
// The setup FORCES a fixture-scoped home before any daemon-resolving code loads; this
// assert is the belt-and-braces that turns a silent-fix into evidence: if mkdtemp ever
// fails, or MULTI_AGENT_HOME is captured before the setup runs (import-order regression),
// it THROWS LOUD rather than falling back to the live home.
import { isFixtureScopedHome } from "./fixture-home.js";

/**
 * Throw LOUD unless `home` is a fixture-scoped Multi-Agent home (carries the
 * `.multi-agent-fixture` marker). Keyed on the established `isFixtureScopedHome`
 * primitive so this guard and the rest of the codebase cannot drift on what
 * "fixture home" means.
 */
export function assertFixtureScopedHome(home: string): void {
  if (!isFixtureScopedHome(home)) {
    throw new Error(
      `HERMETICITY GUARD: this cli test process resolved a LIVE Multi-Agent home (${home}). ` +
        `Default daemon discovery (${home}/daemon.json) could reach the live daemon, and a ` +
        `WRITE such as \`multi-agent broadcast\` would leak into the fleet topology. The test setup must ` +
        `establish a fixture-scoped home (marker '.multi-agent-fixture') BEFORE any daemon-resolving ` +
        `module (data-paths / daemon-lifecycle) loads and captures MULTI_AGENT_HOME.`,
    );
  }
}
