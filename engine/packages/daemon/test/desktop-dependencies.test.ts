import { describe, expect, it } from "vitest";
import { replyToDependencies } from "../src/index.js";

/**
 * U12 — first-run dependency status over the private parent port.
 *
 * The desktop does not resolve `git`, `gh`, `claude` and `codex` itself: it asks the daemon that
 * will launch the workers, and shows what that daemon's own resolver (U1) answered. A failure is
 * a named error, never a fabricated empty success.
 */
describe("U12 dependency status over the private parent port", () => {
  const port = () => {
    const sent: Array<Record<string, unknown>> = [];
    return { sent, postMessage: (message: unknown) => { sent.push(message as Record<string, unknown>); } };
  };

  it("answers with the resolver's own output for all four clients", () => {
    const reply = port();
    replyToDependencies(reply);
    expect(reply.sent).toHaveLength(1);
    const message = reply.sent[0]!;
    expect(message.type).toBe("dependencies");
    const resolutions = message.resolutions as Array<{ client: string; ok: boolean }>;
    expect(Array.isArray(resolutions)).toBe(true);
    expect(resolutions.map(resolution => resolution.client)).toEqual(["claude", "codex", "git", "gh"]);
    // Whatever this host has installed, each entry either carries a path or says why it does not.
    for (const resolution of resolutions as Array<Record<string, unknown>>) {
      if (resolution.ok === true) expect(typeof resolution.path).toBe("string");
      else expect(["not-found", "shim-without-executable", "not-executable"]).toContain(resolution.reason);
    }
  });

  it("never throws when the port is already closed", () => {
    const reply = { postMessage: () => { throw new Error("port closed"); } };
    expect(() => replyToDependencies(reply)).not.toThrow();
  });
});