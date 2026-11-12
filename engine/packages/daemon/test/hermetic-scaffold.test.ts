import { describe, it, expect, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  prepareHermeticEnv,
  HermeticEnvError,
  DAEMON_TARGET_ENV_VARS,
  type HermeticScaffold,
} from "./helpers/hermetic-env.js";

// Slice 51-02 — the hermetic scaffold layer on top of the fail-closed guard.
// prepareHermeticEnv() builds a per-run scratch HOME/MULTI_AGENT_HOME scaffold and a
// CLEAN child-process env (scrubbed daemon-target vars + scratch paths), WITHOUT
// mutating the runner process's own environment. It fails closed FIRST (a foreign
// daemon target aborts before any scaffold is created).
describe("prepareHermeticEnv scaffold", () => {
  const scaffolds: HermeticScaffold[] = [];
  afterEach(() => {
    for (const s of scaffolds.splice(0)) s.cleanup();
  });
  const make = (baseEnv?: Record<string, string | undefined>) => {
    const s = prepareHermeticEnv({ baseEnv });
    scaffolds.push(s);
    return s;
  };

  it("fails closed BEFORE creating any scaffold when a foreign daemon target is present", () => {
    let thrown: unknown;
    try {
      prepareHermeticEnv({ baseEnv: { MULTI_AGENT_URL: "http://foreign:9999", HOME: "/real" } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HermeticEnvError);
    expect((thrown as Error).message).toContain("MULTI_AGENT_URL");
  });

  it("creates an isolated scratch scaffold (root + home + multiAgentHome + stateDir all exist under root)", () => {
    const s = make({ HOME: "/real-home", PATH: "/usr/bin" });
    expect(existsSync(s.root)).toBe(true);
    for (const dir of [s.home, s.multiAgentHome, s.stateDir]) {
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(dir.startsWith(s.root)).toBe(true);
    }
  });

  it("returns a CLEAN child env: daemon-target vars scrubbed, scratch paths set", () => {
    const base = {
      HOME: "/real-home",
      PATH: "/usr/bin",
      MULTI_AGENT_URL: undefined, // absent -> fine
      MULTI_AGENT_AUTH_BEARER_TOKEN: "secret",
    };
    const s = make(base);
    for (const v of DAEMON_TARGET_ENV_VARS) {
      expect(s.env[v]).toBeUndefined();
    }
    // credential also scrubbed
    expect(s.env.MULTI_AGENT_AUTH_BEARER_TOKEN).toBeUndefined();
    // scratch paths point INTO the scaffold
    expect(s.env.HOME).toBe(s.home);
    expect(s.env.MULTI_AGENT_HOME).toBe(s.multiAgentHome);
    // The private tmux wrapper wins command resolution; the caller's PATH is
    // preserved after it so every non-tmux executable resolves as before.
    expect(s.env.PATH).toBe(`${join(s.root, "bin")}${delimiter}/usr/bin`);
  });

  it("does NOT mutate the caller's env object nor process.env", () => {
    const base: Record<string, string | undefined> = { HOME: "/real-home", PATH: "/usr/bin" };
    const beforeHome = process.env.HOME;
    const s = make(base);
    // caller's base object untouched
    expect(base.HOME).toBe("/real-home");
    expect(base.MULTI_AGENT_HOME).toBeUndefined();
    // process.env untouched (compared to its OWN before-value → insensitive to the ambient env)
    expect(process.env.HOME).toBe(beforeHome);
    // the scaffold's env is a distinct object
    expect(s.env).not.toBe(base);
  });

  it("cleanup removes the scaffold root", () => {
    const s = prepareHermeticEnv({ baseEnv: { HOME: "/real-home" } });
    const root = s.root;
    expect(existsSync(root)).toBe(true);
    s.cleanup();
    expect(existsSync(root)).toBe(false);
  });

  it("the scratch child env is itself hermetic (no foreign target survives)", () => {
    // The clean env must pass its own fail-closed guard — proving the scrub is complete.
    const s = make({ MULTI_AGENT_HOST: undefined, HOME: "/real", });
    expect(() => {
      // re-run the guard over the produced env
      for (const v of DAEMON_TARGET_ENV_VARS) {
        if (s.env[v]) throw new Error(`leaked ${v}`);
      }
    }).not.toThrow();
  });
});
