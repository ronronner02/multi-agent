// D12 base-health + WRITE-leak containment (broadcast-leak atom).
//
// The Node test suites MUST NOT inherit the seat's live-daemon connection. Two holes:
//
// 1. Connection-redirect env (MULTI_AGENT_URL / MULTI_AGENT_PORT / MULTI_AGENT_HOST)
//    is honored as a real operator override in production, but ambient inside
//    a seat it bypasses each test's injected mock daemon (up.test.ts: 29 fails ambient
//    vs 1 hermetic). Scrubbed below. Production behavior is untouched.
//
// 2. The DEFAULT STATE_FILE discovery — `MULTI_AGENT_HOME/daemon.json` (daemon-lifecycle
//    `MULTI_AGENT_DIR = MULTI_AGENT_HOME`). Scrubbing the env is NOT enough: with URL/PORT
//    unset, the CLI falls back to the live daemon's state file. This is exactly how
//    `broadcast.test.ts` emitted REAL 'System maintenance' broadcasts to 14 seats.
//    The READ direction (results pollution) was known; the WRITE direction (emitting
//    into the live topology) is strictly worse.
//
// FORCE + ASSERT (unwritable-by-omission — the guarantee lives where it cannot be
// skipped, so a new test file inherits safety from the setup that runs first, not
// from a runner or a per-file convention that 145/164 files already omit):
//   FORCE  — establish a fixture-scoped MULTI_AGENT_HOME (a fresh temp dir carrying the
//            `.multi-agent-fixture` marker) BEFORE any daemon-resolving module loads and
//            captures the eager `MULTI_AGENT_HOME` const, so default discovery finds no
//            live daemon.
//   ASSERT — `assertFixtureScopedHome` throws LOUD if the home is NOT fixture-scoped
//            (mkdtemp failure, or MULTI_AGENT_HOME captured before this ran via an
//            import-order regression). Forcing alone silently fixes and proves
//            nothing; the assert makes it evidence. Its known-negative lives in
//            live-daemon-guard.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Scrub inherited instance selectors before product modules capture their defaults.
// Tests can still set explicit overrides after setup; test/provider opt-in flags
// are not instance selectors and remain untouched.
for (const key of [
  "URL", "PORT", "HOST", "BIND_HOST", "HOST_SELECTED", "DB",
  "TRANSCRIPTS_PATH", "WORKSPACE_ROOT", "WORKSPACE_SLICES_ROOT",
  "WORKSPACE_STEERING_PATH", "WORKSPACE_SPECS_ROOT", "WORKSPACE_PROJECTS_ROOT",
  "WORKSPACE_CATALOG_PATH", "TOPOLOGY_ROOT", "CONTEXT_ROOT", "CONTEXT_PACKS_ROOT",
  "SKILLS_ROOT", "SHARED_DOCS_ROOT", "FILES_ALLOWLIST", "PROGRESS_SCAN_ROOTS",
  "SESSION_NAME", "NODE_ID", "RIG_ID", "AUTH_BEARER_TOKEN", "TERMINAL_BEARER_TOKEN",
  // Slice 15: a seat with compact output on must not change what the suite prints.
  "OUTPUT_COMPACT",
  // Slice 01: a seat with usage windows on must not change what the suite reads.
  "PROVIDER_USAGE_WINDOWS",
]) {
  delete process.env[`MULTI_AGENT_${key}`];
}

// (2) FORCE a fixture-scoped home — BEFORE importing data-paths (whose
// MULTI_AGENT_HOME const is eager). Node builtins above do not load it; the dynamic
// imports below run only AFTER this assignment, so the const captures the fixture.
// ONE stable fixture home per worker. setupFiles runs per test FILE, but
// data-paths's MULTI_AGENT_HOME const is captured ONCE per worker — a fresh per-file
// home would diverge from that captured const (env says home N, the const holds home
// 1), which flakes any test reading one vs the other under suite ordering. So reuse a
// fixture home already established in this worker. Named as a realistic `.multi-agent`-style
// home (still fixture-scoped via the marker) so path-shape assertions hold against it.
const existingHome = process.env["MULTI_AGENT_HOME"];
const fixtureHome =
  existingHome && fs.existsSync(path.join(existingHome, ".multi-agent-fixture"))
    ? existingHome
    : (() => {
        const h = fs.mkdtempSync(path.join(os.tmpdir(), ".multi-agent-test-fixture-home-"));
        fs.writeFileSync(path.join(h, ".multi-agent-fixture"), "");
        return h;
      })();
process.env["MULTI_AGENT_HOME"] = fixtureHome;
// Ordinary home-based configuration must also stay local
// to this fixture. Merely changing HOME would not override MULTI_AGENT_HOME or DB.
// Keep ordinary user files outside the state root, as in a real installation.
// Otherwise file-transfer correctly rejects every ~/ path as Multi-Agent state.
if (process.env["MULTI_AGENT_E2E_REAL_CODEX"] !== "1") {
  const userHome = `${fixtureHome}-user-home`;
  fs.mkdirSync(userHome, { recursive: true });
  process.env["HOME"] = userHome;
  delete process.env["CODEX_HOME"];
  for (const [key, suffix] of Object.entries({
    XDG_CONFIG_HOME: ".config", XDG_STATE_HOME: ".local/state",
    XDG_DATA_HOME: ".local/share", XDG_CACHE_HOME: ".cache",
  })) process.env[key] = path.join(userHome, suffix);
}

// (3) ASSERT — capture the resolved home + fail loud if it is not fixture-scoped.
const { MULTI_AGENT_HOME } = await import("@multi-agent/daemon/data-paths");
const { assertFixtureScopedHome } = await import("../packages/cli/test/live-daemon-guard.js");
assertFixtureScopedHome(MULTI_AGENT_HOME);

// (4) P37 REQUEST-LAYER GUARD — the universal outbound-request chokepoint. The two
// guards above close the DISCOVERY paths (connection env, state-file home); this closes
// the REQUEST layer, where a hardcoded :7433 literal, a mocked URL getter with an
// un-mocked client, or a production default constant still issues a real request that
// no env-scrub or fixture-home can catch. Fail-closed on any unregistered target; an
// in-process fixture registers its origin (allowFetchTarget) when it binds.
const { installFetchGuard } = await import("../packages/cli/test/fetch-guard.js");
installFetchGuard();
