import { describe, it, expect } from "vitest";
import { grade, type EvalCase } from "./helpers/eval-grader.js";

// slice-07 R6 — RED-first pins for the deterministic DOOR grader.
// Against the RED-first stub (unconditional pass) the FAIL cases below fail; that is the
// intended RED. GREEN lands when grade() actually discriminates.

const SEL: EvalCase = {
  id: "sel-01",
  name: "selects orchestration-team for a native team run",
  category: "selection",
  prompt: "start a native team run and keep the owner decision explicit",
  expectedPatterns: ["multi-agent context get\\s+skills/pods/orchestration-team"],
};

const LOAD: EvalCase = {
  id: "load-01",
  name: "pulls orchestration-team before starting a team run",
  category: "loading",
  prompt: "start a native team run and keep the owner decision explicit",
  expectedPatterns: ["multi-agent context get\\s+skills/pods/orchestration-team"],
  order: {
    getPattern: "multi-agent context get\\s+skills/pods/orchestration-team",
    actionPattern: "multi-agent team start",
  },
};

describe("eval-grader — deterministic door", () => {
  it("selection PASS when the correct ref is pulled", () => {
    expect(grade(SEL, "…thinking… multi-agent context get skills/pods/orchestration-team\nmulti-agent team start").pass).toBe(true);
  });

  it("selection FAIL when the wrong ref is pulled", () => {
    expect(grade(SEL, "multi-agent context get skills/process/context-engineering\nmulti-agent team start").pass).toBe(false);
  });

  it("selection FAIL on a forbidden pattern", () => {
    const c: EvalCase = { ...SEL, forbiddenPatterns: ["multi-agent team merge"] };
    expect(grade(c, "multi-agent context get skills/pods/orchestration-team\nmulti-agent team merge").pass).toBe(false);
  });

  it("loading PASS when the get precedes the action", () => {
    expect(grade(LOAD, "multi-agent context get skills/pods/orchestration-team\n…\nmulti-agent team start").pass).toBe(true);
  });

  it("loading FAIL when the action runs with no preceding get", () => {
    expect(grade(LOAD, "multi-agent team start   # acted without loading").pass).toBe(false);
  });

  it("loading FAIL when the action precedes the get", () => {
    expect(grade(LOAD, "multi-agent team start\nthen multi-agent context get skills/pods/orchestration-team").pass).toBe(false);
  });
});
