import { describe, it, expect } from "vitest";
import { claudePostureFlag, codexPostureArg, piTrust } from "../src/adapters/yolo-mode.js";

describe("Seam B R6 — resolved posture drives the REAL launch helpers on all three harnesses", () => {
  const yoloOn = { MULTI_AGENT_YOLO: "1" } as NodeJS.ProcessEnv;
  const yoloOff = {} as NodeJS.ProcessEnv;

  it("full_bypass posture lifts a seat even with YOLO OFF (custom flag policy — the ruling)", () => {
    expect(claudePostureFlag(yoloOff, "full_bypass")).toBe("--dangerously-skip-permissions");
    expect(codexPostureArg("", yoloOff, "full_bypass")).toBe(" -s danger-full-access -a never");
    expect(piTrust(undefined, yoloOff, "full_bypass")).toBe("approve"); // Pi = resource trust, not a permission policy
  });

  it("floor posture HOLDS a seat at the floor even with global YOLO ON (attached policy is authoritative)", () => {
    expect(claudePostureFlag(yoloOn, "floor")).toBe("--permission-mode acceptEdits");
    expect(codexPostureArg(" -p prof", yoloOn, "floor")).toBe(" -p prof");
    expect(piTrust("no-approve", yoloOn, "floor")).toBe("no-approve");
  });

  it("the STANDALONE Slice-02 primitive keeps its env behavior when invoked BARE (non-lifecycle callers; Seam-B lifecycle surfaces always pass an explicit posture — absence binds the floor, pinned in the lifecycle suite)", () => {
    expect(claudePostureFlag(yoloOn)).toBe("--dangerously-skip-permissions");
    expect(claudePostureFlag(yoloOff)).toBe("--permission-mode acceptEdits");
    expect(codexPostureArg("", yoloOff)).toBe(" -s workspace-write");
    expect(piTrust(undefined, yoloOff)).toBe("no-approve");
  });
});
